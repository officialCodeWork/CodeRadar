/**
 * Turn a VisionExtraction into a graph match (TRACKER step 4.4).
 *
 * Terms inside an annotation (E3) are weighted 3× so the element the user
 * circled outranks incidental text. A screenshot that doesn't look like this
 * app (`looksLikeApp: false`) declines rather than guessing (A13).
 */
import {
  type ComponentMatch,
  declined,
  type LineageGraph,
  matchComponents,
  type MatchQuery,
  type QueryResult,
} from "@coderadar/core";

import type { VisionExtraction } from "./types.js";

/** Weight multiplier applied to terms found inside an annotation region. */
export const ANNOTATION_BOOST = 3;

/** Build a matcher query from an extraction, boosting annotated terms. */
export function extractionToQuery(extraction: VisionExtraction): MatchQuery {
  const boosts: Record<string, number> = {};
  for (const region of extraction.annotations) {
    for (const term of region.terms) boosts[term] = ANNOTATION_BOOST;
  }
  return {
    terms: extraction.terms,
    structure: extraction.structure,
    ...(Object.keys(boosts).length > 0 ? { boosts } : {}),
  };
}

/** Match a screenshot extraction against a graph, or decline a non-app image. */
export function matchFromVision(
  graph: LineageGraph,
  extraction: VisionExtraction,
): QueryResult<ComponentMatch> {
  if (!extraction.looksLikeApp) return declined("not-our-app");
  return matchComponents(graph, extractionToQuery(extraction));
}
