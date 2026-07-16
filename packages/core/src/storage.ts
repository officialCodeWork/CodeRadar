/**
 * Graph persistence with schema-version checking and scan provenance.
 *
 * A stored graph is the contract between the scan side (CI job, CLI) and the
 * query side (agent SDK, MCP server) — possibly running months apart on
 * different machines. Version checks refuse graphs newer than this library;
 * GraphMeta records exactly which code was scanned (G2/G3 foundations).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { GraphMeta, LineageGraph } from "./types.js";

/** The schema version this library reads and writes. */
export const SCHEMA_VERSION = 2;

/** Directory the SHA-keyed graph store lives in, under a scanned root (6.4). */
export function graphStoreDir(root: string): string {
  return path.join(root, ".coderadar", "graphs");
}

/** Store key for a graph: its scanned commit SHA, or "working" when not in git. */
function storeKey(graph: LineageGraph): string {
  return graph.meta?.commitSha ?? "working";
}

/**
 * Persist a graph in the SHA-keyed store (6.4, G3): `.coderadar/graphs/<sha>.json`
 * plus a `latest` pointer file naming the most recently stored key. Keeping graphs
 * by commit lets the query side resolve a ticket against the exact code version
 * that was in production while newer scans accumulate. Returns the written path.
 */
export function saveGraphToStore(graph: LineageGraph, root: string): string {
  const dir = graphStoreDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const key = storeKey(graph);
  const file = path.join(dir, `${key}.json`);
  saveGraph(graph, file);
  fs.writeFileSync(path.join(dir, "latest"), key);
  return file;
}

/**
 * Load a graph from the SHA-keyed store. `version` is a stored key (a commit SHA
 * or "working"); the default "latest" follows the pointer written by
 * `saveGraphToStore`. Throws with an actionable message when the key is absent.
 */
export function loadGraphFromStore(root: string, version = "latest"): LineageGraph {
  const dir = graphStoreDir(root);
  let key = version;
  if (version === "latest") {
    const pointer = path.join(dir, "latest");
    if (!fs.existsSync(pointer)) {
      throw new Error(`no graphs in the store at ${dir} — run \`ui-lineage scan --store\` first`);
    }
    key = fs.readFileSync(pointer, "utf-8").trim();
  }
  const file = path.join(dir, `${key}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`no stored graph for version "${key}" at ${file}`);
  }
  return loadGraph(file);
}

export function saveGraph(graph: LineageGraph, filePath: string): void {
  fs.writeFileSync(filePath, JSON.stringify(graph, null, 2));
}

/**
 * Load and validate a stored graph.
 *
 * Throws on: unreadable/invalid JSON, missing version, or a version newer
 * than this library (an older reader must not misinterpret a newer graph —
 * upgrade the library instead). Older versions are accepted; migrations are
 * added here when version 3 exists.
 */
export function loadGraph(filePath: string): LineageGraph {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error(`${filePath} is not a CodeRadar lineage graph (no version field)`);
  }
  const version = (parsed as { version: unknown }).version;
  if (typeof version !== "number") {
    throw new Error(`${filePath}: version must be a number, got ${typeof version}`);
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `${filePath} uses schema v${version}, but this library reads up to v${SCHEMA_VERSION} — upgrade @coderadar/core`,
    );
  }
  return parsed as LineageGraph;
}

/** Collect scan provenance for a directory: commit SHA + dirty flag. */
export function collectGraphMeta(scanRoot: string): GraphMeta {
  try {
    const commitSha = execFileSync("git", ["-C", scanRoot, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["-C", scanRoot, "status", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { commitSha, dirty: status.trim().length > 0 };
  } catch {
    return { commitSha: null, dirty: false };
  }
}
