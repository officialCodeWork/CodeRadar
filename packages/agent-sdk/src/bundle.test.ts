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

  it("reports a plain 'untested' when the repo genuinely has no tests", () => {
    // graphWithLineage has 1 component, 0 test nodes → untested is accurate.
    const bundle = buildBundle(graph, { text: "the Big card overview" }, { budgetTokens: 8000 });
    expect(bundle.warnings.some((w) => w.startsWith("untested —"))).toBe(true);
    expect(bundle.warnings.some((w) => w.startsWith("coverage-unmapped"))).toBe(false);
  });
});

describe("buildBundle version skew (6.4, G3/A11)", () => {
  // A card that renders "Invoice summary" — identical body across versions, so
  // only the name/file distinguish the old graph from the current one.
  function cardGraph(name: string, file: string): LineageGraph {
    const component: ComponentNode = {
      id: nodeId("component", file, name),
      kind: "component",
      name,
      loc: loc(file),
      exportName: name,
      props: [],
      renderedText: [{ text: "Invoice summary", source: "jsx" }],
      rendersComponents: [],
      structure: {
        table: 0,
        columns: 0,
        form: 0,
        input: 0,
        button: 0,
        link: 0,
        image: 0,
        heading: 1,
        list: 0,
        repeated: 0,
      },
    };
    return {
      version: 2,
      root: "/app",
      generatedAt: "2026-01-01T00:00:00.000Z",
      generator: "test",
      nodes: [component],
      edges: [],
    };
  }

  const resolved = cardGraph("InvoiceCard", "InvoiceCard.tsx");
  const current = cardGraph("BillingCard", "BillingCard.tsx");
  const ticket = { text: "the Invoice summary card is wrong" };

  it("warns with the new name+file when the matched definition was renamed/moved", () => {
    const bundle = buildBundle(resolved, ticket, { currentGraph: current, budgetTokens: 8000 });
    expect(bundle.match[0]?.component).toBe("InvoiceCard");
    const skew = bundle.warnings.find((w) => w.startsWith("version skew"));
    expect(skew).toBeDefined();
    expect(skew).toContain("`BillingCard`");
    expect(skew).toContain("BillingCard.tsx");
  });

  it("emits no version-skew warning when the current graph is unchanged", () => {
    const bundle = buildBundle(resolved, ticket, { currentGraph: resolved, budgetTokens: 8000 });
    expect(bundle.warnings.some((w) => w.startsWith("version skew"))).toBe(false);
  });

  it("emits no version-skew warning when no current graph is provided", () => {
    const bundle = buildBundle(resolved, ticket, { budgetTokens: 8000 });
    expect(bundle.warnings.some((w) => w.startsWith("version skew"))).toBe(false);
  });
});

describe("coverage-unmapped downgrade (TRACKER 6F.6, F3)", () => {
  // A graph where test files EXIST but almost none map to a component — the
  // field-found signature (tests present, ~0 covered-by edges). The matched
  // component's missing coverage must read as "unmapped", not a false "untested".
  function sparselyCoveredGraph(componentCount: number, coveredCount: number): LineageGraph {
    const nodes: LineageGraph["nodes"] = [];
    const edges: LineageEdge[] = [];
    for (let i = 0; i < componentCount; i += 1) {
      const name = i === 0 ? "SilencePanel" : `Widget${i}`;
      const text = i === 0 ? "Silence alert notifications" : `Widget ${i} label`;
      nodes.push({
        id: nodeId("component", `${name}.tsx`, name),
        kind: "component",
        name,
        loc: loc(`${name}.tsx`),
        exportName: name,
        props: [],
        renderedText: [{ text, source: "jsx" }],
        rendersComponents: [],
        structure: {
          table: 0, columns: 0, form: 0, input: 0, button: 0,
          link: 0, image: 0, heading: 0, list: 0, repeated: 0,
        },
      });
    }
    // Several test files exist, but they only cover the LAST few components —
    // never the matched SilencePanel (index 0).
    for (let t = 0; t < 5; t += 1) {
      const testId = nodeId("test", `Widget.test.tsx`, `test${t}`);
      nodes.push({
        id: testId,
        kind: "test",
        name: `test${t}`,
        loc: loc(`__tests__/Widget${t}.test.tsx`),
        framework: "vitest",
      });
      if (t < coveredCount) {
        edges.push({ from: nodes[componentCount - 1 - t]!.id, to: testId, kind: "covered-by" });
      }
    }
    return {
      version: 2,
      root: "/app",
      generatedAt: "2026-01-01T00:00:00.000Z",
      generator: "test",
      nodes,
      edges,
    };
  }

  it("emits coverage-unmapped instead of untested when coverage is near-empty", () => {
    // 40 components, tests present, only 1 covered (2.5% < 5% floor).
    const g = sparselyCoveredGraph(40, 1);
    const bundle = buildBundle(g, { text: "Silence alert notifications" }, { budgetTokens: 8000 });
    expect(bundle.match[0]?.component).toBe("SilencePanel");
    expect(bundle.warnings.some((w) => w.startsWith("coverage-unmapped"))).toBe(true);
    expect(bundle.warnings.some((w) => w.startsWith("untested —"))).toBe(false);
  });

  it("keeps per-component untested when coverage is healthy", () => {
    // 10 components, 5 covered (50% ≥ 5%) — the matched SilencePanel is not one
    // of them, so untested is the accurate, useful signal.
    const g = sparselyCoveredGraph(10, 5);
    const bundle = buildBundle(g, { text: "Silence alert notifications" }, { budgetTokens: 8000 });
    expect(bundle.match[0]?.component).toBe("SilencePanel");
    expect(bundle.warnings.some((w) => w.startsWith("untested —"))).toBe(true);
    expect(bundle.warnings.some((w) => w.startsWith("coverage-unmapped"))).toBe(false);
  });
});
