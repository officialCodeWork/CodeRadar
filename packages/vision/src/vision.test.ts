import type { LineageGraph } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { ANNOTATION_BOOST, extractionToQuery, matchFromVision } from "./query.js";
import { StubVisionAdapter } from "./stub.js";
import type { VisionExtraction } from "./types.js";

const emptyGraph: LineageGraph = {
  version: 2,
  root: "/app",
  generatedAt: "2026-01-01T00:00:00.000Z",
  generator: "test",
  nodes: [],
  edges: [],
};

const extraction: VisionExtraction = {
  terms: ["Revenue breakdown", "Cost breakdown", "Total"],
  structure: {},
  annotations: [{ kind: "circle", bounds: { x: 0, y: 0, w: 10, h: 10 }, terms: ["Revenue breakdown"] }],
  looksLikeApp: true,
};

describe("vision adapter plumbing (TRACKER 4.4)", () => {
  it("the stub returns its recorded extraction", async () => {
    const adapter = new StubVisionAdapter(extraction);
    expect(await adapter.extract()).toEqual(extraction);
  });

  it("boosts annotated terms and passes structure + terms through", () => {
    const query = extractionToQuery(extraction);
    expect(query.terms).toEqual(extraction.terms);
    expect(query.boosts?.["Revenue breakdown"]).toBe(ANNOTATION_BOOST);
    expect(query.boosts?.["Total"]).toBeUndefined();
  });

  it("declines a screenshot that isn't this app (A13)", () => {
    const result = matchFromVision(emptyGraph, { ...extraction, looksLikeApp: false });
    expect(result.status).toBe("declined");
    expect(result.declineReason).toBe("not-our-app");
  });
});
