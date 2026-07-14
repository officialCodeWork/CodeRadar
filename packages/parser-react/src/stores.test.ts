import path from "node:path";
import { fileURLToPath } from "node:url";

import { traceLineage } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures/c6-store-decoupled/app",
);

const graph = scanReact({ root: fixture });

function endpointsOf(componentName: string): string[] {
  const definition = graph.nodes.find(
    (n) => n.kind === "component" && n.name === componentName,
  );
  if (definition === undefined) throw new Error(`${componentName} not found`);
  const lineage = traceLineage(graph, definition.id).candidates[0]?.value;
  return lineage?.dataSources.map((d) => d.endpoint).sort() ?? [];
}

describe("store adapter (c6 fixture)", () => {
  it("creates one global StateNode per redux slice and zustand store", () => {
    const stateNodes = graph.nodes.filter((n) => n.kind === "state");
    const kinds = stateNodes.map((n) => (n.kind === "state" ? `${n.stateKind}:${n.name}` : ""));
    expect(kinds.sort()).toEqual(["redux:users", "zustand:useCartStore"]);
  });

  it("wires thunk data sources to the slice via addCase(thunk.fulfilled)", () => {
    const slice = graph.nodes.find((n) => n.kind === "state" && n.name === "users");
    const writers = graph.edges.filter((e) => e.kind === "writes-state" && e.to === slice?.id);
    const endpoints = writers.map(
      (e) => graph.nodes.find((n) => n.id === e.from && n.kind === "data-source")?.name,
    );
    expect(endpoints).toEqual(["/api/users"]);
  });

  it("attributes the reader with NO fetch of its own to the populating API", () => {
    expect(endpointsOf("UserDirectory")).toEqual(["/api/users"]);
  });

  it("attributes the dispatching component too", () => {
    expect(endpointsOf("LoginPage")).toEqual(["/api/users"]);
  });

  it("keeps zustand and redux stores separate", () => {
    expect(endpointsOf("CartWidget")).toEqual(["/api/cart"]);
  });
});
