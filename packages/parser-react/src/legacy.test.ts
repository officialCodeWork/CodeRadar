import path from "node:path";
import { fileURLToPath } from "node:url";

import { traceLineage } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures/d4-class-components/app",
);

const graph = scanReact({ root: fixture });

function componentNode(name: string) {
  const node = graph.nodes.find((n) => n.kind === "component" && n.name === name);
  if (node?.kind !== "component") throw new Error(`${name} not found`);
  return node;
}

describe("class components (d4 fixture)", () => {
  it("detects React.Component and bare Component subclasses", () => {
    expect(componentNode("OrdersBoard").exportName).toBe("OrdersBoard");
    expect(componentNode("UserBadge").renderedText.some((e) => e.text.includes("Signed in as"))).toBe(
      true,
    );
  });

  it("attributes lifecycle fetches to the class component", () => {
    const result = traceLineage(graph, componentNode("OrdersBoard").id);
    const lineage = result.candidates[0]?.value;
    expect(lineage?.dataSources.map((d) => d.endpoint)).toEqual(["/api/orders"]);
  });

  it("extracts this.state keys as class-state nodes", () => {
    const result = traceLineage(graph, componentNode("OrdersBoard").id);
    const state = result.candidates[0]?.value.state;
    expect(state?.map((s) => `${s.stateKind}:${s.name}`).sort()).toEqual([
      "class-state:failed",
      "class-state:orders",
    ]);
  });

  it("captures method-reference event handlers (this.refresh)", () => {
    const result = traceLineage(graph, componentNode("OrdersBoard").id);
    const events = result.candidates[0]?.value.events;
    expect(events?.map((e) => `${e.event}:${e.handler}`)).toEqual(["onClick:this.refresh"]);
  });

  it("collects this.props accesses as props", () => {
    expect(componentNode("UserBadge").props).toEqual(["name"]);
  });
});

describe("HOC unwrapping (d4 fixture)", () => {
  it("resolves <Panel/> through connect() to the inner component's definition", () => {
    const instance = graph.nodes.find((n) => n.kind === "instance" && n.name === "Panel");
    if (instance?.kind !== "instance") throw new Error("Panel instance not found");
    expect(instance.definitionId).toBe(componentNode("PanelInner").id);
  });
});

describe("graceful degradation (d4 fixture)", () => {
  it("emits an incomplete-flagged node for a class with no render()", () => {
    const broken = componentNode("BrokenPanel");
    expect(broken.flags).toContain("incomplete");
    expect(broken.renderedText).toEqual([]);
  });
});
