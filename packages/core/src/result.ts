/**
 * The query-result envelope. No CodeRadar query API ever returns a bare value:
 * every answer is ranked candidates with evidence and confidence, or an honest
 * `ambiguous` / `declined` (failure modes D2, D6, G1).
 */

import type { Confidence, Evidence } from "./types.js";

export type QueryStatus = "ok" | "ambiguous" | "declined";

export type DeclineReason =
  | "no-signal" // nothing in the graph matched the query at all
  | "not-found" // the referenced node id/name does not exist
  | "invalid-target" // the node exists but the query does not apply to its kind
  | "out-of-scope" // the request is outside CodeRadar's domain (e.g. backend-only ticket)
  | "not-our-app"; // the input does not appear to describe this codebase

export interface Candidate<T> {
  value: T;
  confidence: Confidence;
  evidence: Evidence[];
  /**
   * Raw ranking score, exposed top-level so agents don't misread the nested
   * calibration score as match strength (6F.7). Larger is stronger; only
   * comparable within one result. `confidence` stays the calibrated signal.
   */
  score?: number;
}

export interface QueryResult<T> {
  status: QueryStatus;
  /** Ranked best-first. Empty when declined. */
  candidates: Candidate<T>[];
  /** For ambiguous results: the question that would disambiguate the top candidates. */
  disambiguation?: string;
  /** For declined results. */
  declineReason?: DeclineReason;
}

export function ok<T>(candidates: Candidate<T>[]): QueryResult<T> {
  return { status: "ok", candidates };
}

export function ambiguous<T>(candidates: Candidate<T>[], disambiguation: string): QueryResult<T> {
  return { status: "ambiguous", candidates, disambiguation };
}

export function declined<T>(reason: DeclineReason): QueryResult<T> {
  return { status: "declined", candidates: [], declineReason: reason };
}

/**
 * Score → confidence thresholds, calibrated on the eval set (TRACKER step 4.5):
 * every `high` answer in the eval set is correct at these cutoffs. The eval
 * `--calibrate` subcommand measures precision at these levels and records it in
 * eval/calibration.json.
 */
export const CONFIDENCE_THRESHOLDS = { high: 0.8, medium: 0.5 } as const;

/** Map a 0–1 score to a calibrated confidence level. */
export function confidenceFromScore(score: number): Confidence {
  const clamped = Math.max(0, Math.min(1, score));
  return {
    score: clamped,
    level:
      clamped >= CONFIDENCE_THRESHOLDS.high
        ? "high"
        : clamped >= CONFIDENCE_THRESHOLDS.medium
          ? "medium"
          : "low",
  };
}
