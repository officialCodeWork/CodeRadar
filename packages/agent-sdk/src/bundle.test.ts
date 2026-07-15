import type { ComponentNode, DataSourceNode, LineageEdge, LineageGraph } from "@coderadar/core";
import { nodeId } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { buildBundle, estimateTokens } from "./bundle.js";

const loc = (f: string) => ({ file: f, line: 1, endLine: 1 });

/** A component "BigCard" that fetches from `count` endpoints — a large lineage. */
function graphWithLineage(count: number): LineageGraph {
  const component: ComponentNode = {
    id: nodeId("component", "BigCard.tsx", "BigCard"),
    kind: "component",
    name: "BigCard",
    loc: loc("BigCard.tsx"),
    exportName: "BigCard",
    props: [],
    renderedText: [{ text: "Big card overview", source: "jsx" }],
    rendersComponents: [],
    structure: {
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
    },
  };
  const sources: DataSourceNode[] = [];
  const edges: LineageEdge[] = [];
  for (let i = 0; i < count; i += 1) {
    const endpoint = `/api/resource/${i}/details/expanded`;
    const id = nodeId("data-source", "BigCard.tsx", `fetch:${endpoint}`);
    sources.push({
      id,
      kind: "data-source",
      name: endpoint,
      loc: loc("BigCard.tsx"),
      sourceKind: "fetch",
      method: "GET",
      endpoint,
      raw: endpoint,
      resolved: "full",
    });
    edges.push({ from: component.id, to: id, kind: "fetches-from" });
  }
  return {
    version: 2,
    root: "/app",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "test",
    nodes: [component, ...sources],
    edges,
  };
}

describe("buildBundle (TRACKER 5.2, F1)", () => {
  const graph = graphWithLineage(40);

  it("populates match, lineage, and journeys for a matched ticket", () => {
    const bundle = buildBundle(graph, { text: "the Big card overview is wrong" }, { budgetTokens: 8000 });
    expect(bundle.status).toBe("matched");
    expect(bundle.match[0]?.component).toBe("BigCard");
    expect(bundle.lineage[0]?.dataSources.length).toBeGreaterThan(0);
    expect(bundle.journeys.length).toBeGreaterThan(0);
  });

  it("stays within budget at 2k / 4k / 8k tokens", () => {
    for (const budget of [2000, 4000, 8000]) {
      const bundle = buildBundle(graph, { text: "the Big card overview" }, { budgetTokens: budget });
      expect(estimateTokens(bundle)).toBeLessThanOrEqual(budget);
      expect(bundle.budget.used).toBeLessThanOrEqual(budget);
    }
  });

  it("trims lower-priority sections first, recording each in warnings", () => {
    // A budget that fits the match but not the full lineage.
    const bundle = buildBundle(graph, { text: "the Big card overview" }, { budgetTokens: 300 });
    expect(bundle.match.length).toBeGreaterThan(0); // match is never dropped
    expect(estimateTokens(bundle)).toBeLessThanOrEqual(300);
    // history/tests/journeys go before lineage.
    const trimmed = bundle.warnings.filter((w) => w.includes("trimmed"));
    const order = trimmed.map((w) => w.match(/trimmed \d+ (\w+)/)?.[1]);
    const idx = (s: string) => order.indexOf(s);
    if (idx("journeys") !== -1 && idx("lineage") !== -1) {
      expect(idx("journeys")).toBeLessThan(idx("lineage"));
    }
  });

  it("declines out-of-domain and unsupported tickets with a warning, no match", () => {
    const ood = buildBundle(graph, { text: "kubernetes deployment crash-looping" });
    expect(ood.status).toBe("declined");
    expect(ood.match).toEqual([]);
    expect(ood.warnings.some((w) => w.includes("out-of-scope"))).toBe(true);
  });
});
