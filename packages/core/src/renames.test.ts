import { describe, expect, it } from "vitest";

import { diffRenames, findRename } from "./renames.js";
import { type ComponentNode, type LineageGraph, nodeId } from "./types.js";

const zeroStructure = {
  table: 0,
  columns: 0,
  form: 0,
  input: 0,
  button: 0,
  link: 0,
  image: 0,
  heading: 0,
  list: 0,
  repeated: 0,
};

function component(name: string, file: string, texts: string[]): ComponentNode {
  return {
    id: nodeId("component", file, name),
    kind: "component",
    name,
    loc: { file, line: 1, endLine: 1 },
    exportName: name,
    props: [],
    renderedText: texts.map((text) => ({ text, source: "jsx" as const })),
    rendersComponents: [],
    structure: { ...zeroStructure, heading: texts.length },
  };
}

function graph(components: ComponentNode[]): LineageGraph {
  return {
    version: 2,
    root: "/app",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "test",
    nodes: components,
    edges: [],
  };
}

describe("diffRenames (6.4, G3/A11)", () => {
  it("pairs a renamed-in-place definition by body signature", () => {
    const from = graph([component("InvoiceCard", "InvoiceCard.tsx", ["Invoice summary"])]);
    const to = graph([component("BillingCard", "InvoiceCard.tsx", ["Invoice summary"])]);
    expect(diffRenames(from, to)).toStrictEqual([
      {
        from: { name: "InvoiceCard", file: "InvoiceCard.tsx" },
        to: { name: "BillingCard", file: "InvoiceCard.tsx" },
      },
    ]);
  });

  it("pairs a moved-file definition (same name, different path)", () => {
    const from = graph([component("Card", "old/Card.tsx", ["Balance due"])]);
    const to = graph([component("Card", "new/Card.tsx", ["Balance due"])]);
    expect(diffRenames(from, to)).toStrictEqual([
      { from: { name: "Card", file: "old/Card.tsx" }, to: { name: "Card", file: "new/Card.tsx" } },
    ]);
  });

  it("reports nothing when the definition is unchanged", () => {
    const g = graph([component("Card", "Card.tsx", ["Balance due"])]);
    expect(diffRenames(g, g)).toStrictEqual([]);
  });

  it("does not pair generic empty-bodied components (no discriminating signature)", () => {
    const from = graph([component("Empty", "Empty.tsx", [])]);
    const to = graph([component("Renamed", "Empty.tsx", [])]);
    expect(diffRenames(from, to)).toStrictEqual([]);
  });

  it("skips ambiguous pairings where two definitions share a body signature", () => {
    const from = graph([
      component("A", "A.tsx", ["Shared body"]),
      component("B", "B.tsx", ["Shared body"]),
    ]);
    const to = graph([
      component("C", "C.tsx", ["Shared body"]),
      component("D", "D.tsx", ["Shared body"]),
    ]);
    // Two gone + two arrived with the same signature — not a confident 1:1.
    expect(diffRenames(from, to)).toStrictEqual([]);
  });

  it("does not treat a body edit as a rename", () => {
    const from = graph([component("Card", "Card.tsx", ["Old text"])]);
    const to = graph([component("Panel", "Panel.tsx", ["Totally different text"])]);
    expect(diffRenames(from, to)).toStrictEqual([]);
  });

  it("findRename locates a rename by old name+file", () => {
    const renames = diffRenames(
      graph([component("InvoiceCard", "InvoiceCard.tsx", ["Invoice summary"])]),
      graph([component("BillingCard", "BillingCard.tsx", ["Invoice summary"])]),
    );
    expect(findRename(renames, "InvoiceCard", "InvoiceCard.tsx")?.to.name).toBe("BillingCard");
    expect(findRename(renames, "Nope", "Nope.tsx")).toBeUndefined();
  });
});
