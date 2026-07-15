import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LineageEdge } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

const demoApp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../examples/demo-app/src",
);

/** Serialize a graph for byte-comparison, dropping only the volatile timestamp. */
function canonical(graph: { generatedAt?: string }): string {
  const { generatedAt: _drop, ...rest } = graph;
  return JSON.stringify(rest);
}

const edgeKey = (e: LineageEdge): string =>
  [e.kind, e.from, e.to, e.via ?? "", e.condition?.expression ?? ""].join(" ");

describe("scan determinism (6.3, G8)", () => {
  it("two independent scans of the same tree are byte-identical", () => {
    const a = resolveHookEdges(scanReact({ root: demoApp }));
    const b = resolveHookEdges(scanReact({ root: demoApp }));
    expect(canonical(a)).toBe(canonical(b));
  });

  it("emits nodes in canonical id order", () => {
    const graph = resolveHookEdges(scanReact({ root: demoApp }));
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toStrictEqual([...ids].sort());
  });

  it("emits edges in canonical key order", () => {
    const graph = resolveHookEdges(scanReact({ root: demoApp }));
    const keys = graph.edges.map(edgeKey);
    expect(keys).toStrictEqual([...keys].sort());
  });

  it("has no duplicate edges after hook resolution", () => {
    const graph = resolveHookEdges(scanReact({ root: demoApp }));
    const keys = graph.edges.map(edgeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
