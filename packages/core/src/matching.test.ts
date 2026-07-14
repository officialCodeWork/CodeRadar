import { describe, expect, it } from "vitest";

import { matchComponentsByText } from "./query.js";
import { editDistance, fuzzyTokenMatch } from "./text.js";
import { type ComponentNode, type LineageGraph, nodeId } from "./types.js";

const loc = (file: string) => ({ file, line: 1, endLine: 1 });

function component(name: string, texts: string[]): ComponentNode {
  return {
    id: nodeId("component", `${name}.tsx`, name),
    kind: "component",
    name,
    loc: loc(`${name}.tsx`),
    exportName: name,
    props: [],
    renderedText: texts.map((text) => ({ text, source: "jsx" as const })),
    rendersComponents: [],
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

describe("editDistance / fuzzyTokenMatch (TRACKER 4.1)", () => {
  it("bounds the edit distance and abandons past the budget", () => {
    expect(editDistance("kitten", "sitting", 3)).toBe(3);
    expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3); // max + 1 sentinel
  });

  it("tolerates OCR slips on long tokens but keeps short tokens strict", () => {
    expect(fuzzyTokenMatch("reconciliation", "reconcilliation")).toBe(true);
    expect(fuzzyTokenMatch("dashboard", "dashbord")).toBe(true);
    expect(fuzzyTokenMatch("save", "safe")).toBe(false); // short → exact only
  });
});

describe("matchComponentsByText scorer (TRACKER 4.1, A4/A10)", () => {
  const forms = [
    component("SettingsForm", ["Save", "Notifications"]),
    component("ProfileForm", ["Save", "Display name"]),
    component("BillingForm", ["Save", "Card number"]),
  ];

  it("a lone generic term is honestly ambiguous, not a coin flip", () => {
    const result = matchComponentsByText(graph(forms), ["Save"]);
    expect(result.status).toBe("ambiguous");
    expect(result.disambiguation).toBeDefined();
  });

  it("a distinctive term breaks the tie via rarity weighting", () => {
    const result = matchComponentsByText(graph(forms), ["Save", "Card number"]);
    expect(result.status).toBe("ok");
    expect(result.candidates[0]?.value.component.name).toBe("BillingForm");
  });

  it("respects word order — 'Order deleted' ≠ 'Delete order'", () => {
    const g = graph([
      component("Toast", ["Order deleted"]),
      component("DeleteButton", ["Delete order"]),
    ]);
    expect(matchComponentsByText(g, ["Order deleted"]).candidates[0]?.value.component.name).toBe(
      "Toast",
    );
    expect(matchComponentsByText(g, ["Delete order"]).candidates[0]?.value.component.name).toBe(
      "DeleteButton",
    );
  });

  it("matches OCR-noisy distinctive text", () => {
    const g = graph([
      component("ReconciliationReport", ["Account Reconciliation"]),
      component("InvoiceDashboard", ["Invoice Dashboard"]),
    ]);
    const result = matchComponentsByText(g, ["Acount Reconcilliation"]);
    expect(result.status).toBe("ok");
    expect(result.candidates[0]?.value.component.name).toBe("ReconciliationReport");
  });

  it("declines when nothing matches", () => {
    expect(matchComponentsByText(graph(forms), ["Purchase history"]).status).toBe("declined");
  });
});
