/**
 * Test-coverage mapping (TRACKER step 5.4, failure mode F3).
 *
 * Test files (`*.test.*`, `*.spec.*`, or under `__tests__/`) are excluded from
 * the component scan, then swept here: every component a test renders
 * (`render(<UserList/>)`, a JSX tag) or imports becomes a `covered-by` edge from
 * the component to a `TestNode`. The context bundle reads these to name the tests
 * guarding a change — and to flag components that have none.
 */

import path from "node:path";

import { type LineageEdge, type LineageNode, nodeId, type TestNode } from "@coderadar/core";
import { type Project, type SourceFile, SyntaxKind } from "ts-morph";

const TEST_FILE = /\.(test|spec)\.[jt]sx?$|(^|\/)__tests__\//;
const COMPONENT_NAME = /^[A-Z]/;

/** Whether a repo-relative path is a test file (excluded from the component scan). */
export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function detectTests(
  project: Project,
  root: string,
  nodes: Map<string, LineageNode>,
  addEdge: (edge: LineageEdge) => void,
): void {
  // Fallback index for JSX tags whose import we can't resolve: name → component ids.
  const byName = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.kind !== "component") continue;
    const list = byName.get(node.name);
    if (list) list.push(node.id);
    else byName.set(node.name, [node.id]);
  }

  for (const sourceFile of project.getSourceFiles()) {
    const file = toPosix(path.relative(root, sourceFile.getFilePath()));
    if (!isTestFile(file)) continue;

    // Where each imported PascalCase name resolves — the precise coverage signal.
    const importedFrom = new Map<string, string>();
    for (const imp of sourceFile.getImportDeclarations()) {
      const src = imp.getModuleSpecifierSourceFile();
      if (src === undefined) continue;
      const rel = toPosix(path.relative(root, src.getFilePath()));
      const record = (name: string): void => {
        if (COMPONENT_NAME.test(name)) importedFrom.set(name, rel);
      };
      for (const named of imp.getNamedImports()) record(named.getNameNode().getText());
      const def = imp.getDefaultImport();
      if (def !== undefined) record(def.getText());
    }

    // Component names this test exercises: JSX tag heads plus imported identifiers.
    const referenced = new Set<string>();
    const addTag = (tag: string): void => {
      const head = tag.split(".")[0] ?? "";
      if (COMPONENT_NAME.test(head)) referenced.add(head);
    };
    for (const el of sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) {
      addTag(el.getTagNameNode().getText());
    }
    for (const el of sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) {
      addTag(el.getTagNameNode().getText());
    }
    for (const name of importedFrom.keys()) referenced.add(name);

    const covered = new Set<string>();
    for (const name of referenced) {
      const rel = importedFrom.get(name);
      const precise = rel !== undefined ? nodeId("component", rel, name) : undefined;
      if (precise !== undefined && nodes.has(precise)) {
        covered.add(precise);
        continue;
      }
      for (const id of byName.get(name) ?? []) covered.add(id);
    }
    if (covered.size === 0) continue;

    const id = nodeId("test", file, path.basename(file));
    if (!nodes.has(id)) {
      const test: TestNode = {
        id,
        kind: "test",
        name: path.basename(file),
        loc: { file, line: 1, endLine: 1 },
        framework: detectFramework(sourceFile),
      };
      nodes.set(id, test);
    }
    for (const componentId of covered) {
      addEdge({ from: componentId, to: id, kind: "covered-by" });
    }
  }
}

function detectFramework(sourceFile: SourceFile): TestNode["framework"] {
  for (const imp of sourceFile.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (spec === "vitest") return "vitest";
    if (spec === "@jest/globals" || spec === "jest") return "jest";
  }
  return "unknown";
}
