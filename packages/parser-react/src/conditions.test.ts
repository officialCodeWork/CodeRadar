import path from "node:path";
import { fileURLToPath } from "node:url";

import { journeys } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

const g5 = resolveHookEdges(
  scanReact({
    root: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../eval/fixtures/g5-feature-flag/app",
    ),
  }),
);

const conditioned = (kind: string) =>
  g5.edges.filter((e) => e.kind === kind && e.condition !== undefined);

describe("flag / role conditions (g5 fixture, TRACKER 3.5)", () => {
  it("gates a handles edge with the feature flag guarding the action", () => {
    const flagged = conditioned("handles").find((e) => e.condition?.kind === "flag");
    expect(flagged?.condition?.expression).toContain("new-billing");
  });

  it("classifies a role guard as a role condition", () => {
    const role = conditioned("handles").find((e) => e.condition?.kind === "role");
    expect(role?.condition?.expression).toContain("admin");
  });

  it("gates a renders edge to a flag-gated child component", () => {
    const rendered = conditioned("renders").find((e) => e.condition?.kind === "flag");
    expect(rendered?.condition?.expression).toContain("beta-banner");
  });

  it("keeps the flag- and role-gated actions on separate events (no id collision)", () => {
    const events = g5.nodes.filter((n) => n.kind === "event" && n.event === "onClick");
    expect(events.length).toBe(2);
  });

  it("surfaces the guard on the journey step it gates", () => {
    const paths = journeys(g5, "/billing", { depth: 3 }).candidates[0]?.value ?? [];
    const conditions = paths.flatMap((p) =>
      p.steps.flatMap((s) => (s.condition !== undefined ? [`${s.condition.kind}:${s.condition.expression}`] : [])),
    );
    expect(conditions.some((c) => c.startsWith("flag:") && c.includes("new-billing"))).toBe(true);
    expect(conditions.some((c) => c.startsWith("role:") && c.includes("admin"))).toBe(true);
  });
});
