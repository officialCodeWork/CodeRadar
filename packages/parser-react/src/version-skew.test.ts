import path from "node:path";
import { fileURLToPath } from "node:url";

import { diffRenames } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures/g3-version-skew",
);

const oldGraph = resolveHookEdges(scanReact({ root: path.join(fixtureRoot, "old") }));
const newGraph = resolveHookEdges(scanReact({ root: path.join(fixtureRoot, "new") }));

describe("version skew on real scans (6.4, G3/A11)", () => {
  it("pairs a renamed + moved definition across two scanned graphs", () => {
    const renames = diffRenames(oldGraph, newGraph);
    expect(renames).toStrictEqual([
      {
        from: { name: "InvoiceCard", file: "InvoiceCard.tsx" },
        to: { name: "BillingCard", file: "BillingCard.tsx" },
      },
    ]);
  });

  it("reports nothing when diffing a graph against itself", () => {
    expect(diffRenames(oldGraph, oldGraph)).toStrictEqual([]);
    expect(diffRenames(newGraph, newGraph)).toStrictEqual([]);
  });
});
