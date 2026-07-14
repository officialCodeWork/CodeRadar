import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchComponents } from "@coderadar/core";
import { extractionToQuery, matchFromVision, type VisionExtraction } from "@coderadar/vision";
import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures/e3-annotated-screenshot",
);
const graph = resolveHookEdges(scanReact({ root: path.join(fixtureDir, "app") }));
const extraction = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "extraction.json"), "utf-8"),
) as VisionExtraction;

describe("annotation weighting (e3 fixture, TRACKER 4.4, E3)", () => {
  it("without the annotation the screenshot is ambiguous", () => {
    const query = extractionToQuery({ ...extraction, annotations: [] });
    expect(matchComponents(graph, query).status).toBe("ambiguous");
  });

  it("the circled term (3x boost) resolves the match to its panel", () => {
    const result = matchFromVision(graph, extraction);
    expect(result.status).toBe("ok");
    expect(result.candidates[0]?.value.component.name).toBe("RevenuePanel");
  });
});
