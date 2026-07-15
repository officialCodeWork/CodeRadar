import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildBundle, estimateTokens } from "@coderadar/agent-sdk";
import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

// A real scanned graph with routes, effects, and journeys (the b3 fixture).
const graph = resolveHookEdges(
  scanReact({
    root: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../eval/fixtures/b3-programmatic-nav/app",
    ),
  }),
);

describe("context bundle over a real scanned graph (TRACKER 5.2)", () => {
  it("builds a bundle with match, lineage, and journeys for a UI ticket", () => {
    const bundle = buildBundle(graph, { text: "the 'All users' page is broken" }, { budgetTokens: 8000 });
    expect(bundle.status).toBe("matched");
    expect(bundle.match[0]?.component).toBe("UsersPage");
    expect(bundle.journeys.length).toBeGreaterThan(0);
  });

  it("wires recent git history over the matched files (5.6)", () => {
    // The b3 fixture files are tracked in this repo, so history is populated.
    const bundle = buildBundle(graph, { text: "the 'All users' page is broken" }, { budgetTokens: 8000 });
    expect(Array.isArray(bundle.history)).toBe(true);
    for (const commit of bundle.history) {
      expect(commit.sha).toMatch(/^[0-9a-f]{7,}$/);
      expect(typeof commit.subject).toBe("string");
    }
  });

  it("every bundle fits the token budget at 2k / 4k / 8k", () => {
    const tickets = [
      "the 'All users' page is broken",
      "Clicking Refresh does nothing on the users list",
      "the 'Your cart' screen shows the wrong total",
    ];
    for (const text of tickets) {
      for (const budget of [2000, 4000, 8000]) {
        const bundle = buildBundle(graph, { text }, { budgetTokens: budget });
        expect(estimateTokens(bundle)).toBeLessThanOrEqual(budget);
      }
    }
  });
});
