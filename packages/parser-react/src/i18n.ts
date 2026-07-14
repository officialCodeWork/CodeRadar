/**
 * i18n adapter (TRACKER step 1.4, failure mode A2).
 *
 * Source contains `t("team.title")`; the screenshot shows "Team Members" —
 * or "Membres de l'équipe" when the reporter runs the app in French. The
 * literal lives in locale files, not JSX. This module loads those files into
 * a key → text-per-locale table so every t()/<Trans> call site expands to one
 * RenderedText entry per locale.
 */

import fs from "node:fs";
import path from "node:path";

import type { RenderedText } from "@coderadar/core";
import { Node, SyntaxKind } from "ts-morph";
import YAML from "yaml";

export interface I18nOptions {
  /** Globs relative to the scan root, e.g. ["locales/*.json", "i18n/**\/*.yaml"]. */
  localeGlobs: string[];
  /** Locale reported first / used when a file's locale can't be inferred. */
  defaultLocale: string;
}

/** key → (locale → text) */
export type LocaleTable = ReadonlyMap<string, ReadonlyMap<string, string>>;

const LOCALE_CODE = /^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/;

export function loadLocaleTable(root: string, options: I18nOptions): LocaleTable {
  const table = new Map<string, Map<string, string>>();
  for (const pattern of options.localeGlobs) {
    for (const file of globFiles(root, pattern)) {
      const locale = inferLocale(path.relative(root, file), options.defaultLocale);
      const content = fs.readFileSync(file, "utf-8");
      const parsed: unknown = file.endsWith(".json") ? JSON.parse(content) : YAML.parse(content);
      if (typeof parsed !== "object" || parsed === null) continue;
      for (const [key, text] of flatten(parsed as Record<string, unknown>, "")) {
        let perLocale = table.get(key);
        if (perLocale === undefined) {
          perLocale = new Map();
          table.set(key, perLocale);
        }
        perLocale.set(locale, text);
      }
    }
  }
  return table;
}

/** Expand every i18n key used in `body` into per-locale RenderedText entries. */
export function i18nRenderedText(body: Node, table: LocaleTable): RenderedText[] {
  const entries: RenderedText[] = [];
  for (const key of collectI18nKeys(body)) {
    const perLocale = lookup(table, key);
    if (perLocale === undefined) continue;
    for (const [locale, text] of perLocale) {
      entries.push({ text, source: "i18n", key, locale });
    }
  }
  return entries;
}

/** t("key") / i18n.t("key") calls and <Trans i18nKey="key"> attributes. */
function collectI18nKeys(body: Node): Set<string> {
  const keys = new Set<string>();
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    if (callee !== "t" && !callee.endsWith(".t")) continue;
    const arg = call.getArguments()[0];
    if (arg !== undefined && Node.isStringLiteral(arg)) keys.add(arg.getLiteralValue());
  }
  for (const attr of body.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (attr.getNameNode().getText() !== "i18nKey") continue;
    const init = attr.getInitializer();
    if (init !== undefined && Node.isStringLiteral(init)) keys.add(init.getLiteralValue());
  }
  return keys;
}

/** Try the key as written, then without an i18next "namespace:" prefix. */
function lookup(table: LocaleTable, key: string): ReadonlyMap<string, string> | undefined {
  const direct = table.get(key);
  if (direct !== undefined) return direct;
  const colon = key.indexOf(":");
  return colon >= 0 ? table.get(key.slice(colon + 1)) : undefined;
}

function flatten(value: Record<string, unknown>, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, child] of Object.entries(value)) {
    const full = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (typeof child === "string") {
      out.push([full, child]);
    } else if (typeof child === "object" && child !== null) {
      out.push(...flatten(child as Record<string, unknown>, full));
    }
  }
  return out;
}

/** "locales/fr.json" → "fr"; "i18n/de/common.yaml" → "de"; fallback otherwise. */
function inferLocale(relativeFile: string, fallback: string): string {
  const base = path.basename(relativeFile, path.extname(relativeFile));
  if (LOCALE_CODE.test(base)) return base;
  const dir = path.basename(path.dirname(relativeFile));
  if (LOCALE_CODE.test(dir)) return dir;
  return fallback;
}

/** Minimal glob: `**` crosses directories, `*` stays within one segment. */
function globFiles(root: string, pattern: string): string[] {
  const regex = new RegExp(
    "^" +
      pattern
        .split(/(\*\*\/|\*\*|\*)/)
        .map((part) => {
          if (part === "**/" ) return "(?:.*/)?";
          if (part === "**") return ".*";
          if (part === "*") return "[^/]*";
          return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("") +
      "$",
  );
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (regex.test(path.relative(root, full).split(path.sep).join("/"))) {
        results.push(full);
      }
    }
  };
  walk(root);
  return results.sort();
}
