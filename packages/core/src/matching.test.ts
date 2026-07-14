import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadCorrections, recordCorrection } from "./corrections.js";
import { matchComponents, matchComponentsByText } from "./query.js";
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

  it("the disambiguation question names each leader's distinctive text (D6)", () => {
    const result = matchComponentsByText(graph(forms), ["Save"]);
    expect(result.status).toBe("ambiguous");
    // Built from the DIFFERENCES: each tied candidate's unique text.
    expect(result.disambiguation).toContain("Card number");
    expect(result.disambiguation).toContain("Notifications");
    expect(result.disambiguation).toContain("Display name");
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

  it("caps a structure-only match at medium confidence, never high (A3/A12)", () => {
    const chart: ComponentNode = {
      ...component("MetricsChart", []),
      structure: {
        table: 0,
        columns: 0,
        form: 0,
        input: 0,
        button: 2,
        link: 0,
        image: 0,
        heading: 0,
        list: 0,
        repeated: 0,
      },
    };
    const result = matchComponents(graph([chart]), { structure: { buttons: 2 } });
    expect(result.status).toBe("ok");
    expect(result.candidates[0]?.value.component.name).toBe("MetricsChart");
    expect(result.candidates[0]?.confidence.level).toBe("medium");
  });
});

describe("alias glossary & corrections (TRACKER 4.6, E2/G4)", () => {
  const g = graph([
    component("BillingSummaryCard", ["Billing summary", "Amount due"]),
    component("InvoiceList", ["Recent invoices"]),
  ]);

  it("resolves a business-vocab phrase that appears nowhere in the code", () => {
    expect(matchComponentsByText(g, ["invoice widget"]).status).toBe("declined");
    const withAlias = matchComponents(g, {
      terms: ["invoice widget"],
      aliases: { "invoice widget": "BillingSummaryCard" },
    });
    expect(withAlias.status).toBe("ok");
    expect(withAlias.candidates[0]?.value.component.name).toBe("BillingSummaryCard");
    expect(withAlias.candidates[0]?.evidence.some((e) => e.kind === "alias")).toBe(true);
  });

  it("a recorded correction overrides an otherwise-correct text match", () => {
    const before = matchComponents(g, { terms: ["Recent invoices"] });
    expect(before.candidates[0]?.value.component.name).toBe("InvoiceList");
    const after = matchComponents(g, {
      terms: ["Recent invoices"],
      corrections: [{ terms: ["Recent invoices"], component: "BillingSummaryCard" }],
    });
    expect(after.candidates[0]?.value.component.name).toBe("BillingSummaryCard");
    expect(after.candidates[0]?.evidence.some((e) => e.kind === "correction")).toBe(true);
  });

  const tmpFiles: string[] = [];
  afterEach(() => {
    for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
  });

  it("round-trips corrections through a JSONL store; the next query flips top-1", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uil-")), "corrections.jsonl");
    tmpFiles.push(file);
    expect(loadCorrections(file)).toEqual([]);
    recordCorrection(file, { terms: ["Recent invoices"], component: "BillingSummaryCard" });
    const corrections = loadCorrections(file);
    const result = matchComponents(g, { terms: ["Recent invoices"], corrections });
    expect(result.candidates[0]?.value.component.name).toBe("BillingSummaryCard");
  });
});
