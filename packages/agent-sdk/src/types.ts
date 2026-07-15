/**
 * The agent-facing entry point (TRACKER step 5.1). A ticket comes in; a
 * classified, matched context result comes out — or an honest decline.
 */
import type { ComponentMatch, QueryResult } from "@coderadar/core";

export interface Ticket {
  /** The ticket prose. */
  text: string;
  /** Number of screenshots attached (presence routes to the visual path). */
  screenshots?: number;
  /** Attachment/reference URLs; a video/GIF here makes the input unsupported (E4). */
  links?: string[];
}

/**
 * How CodeRadar should read the ticket (E1/E5/E6/E4). Classification is
 * rule-based + keyword lexicons — no LLM call, so the node is deterministic (G8).
 */
export type EntryPoint = "visual" | "textual" | "behavioral" | "out-of-domain" | "unsupported";

export interface Classification {
  entryPoint: EntryPoint;
  /** Human/agent-readable reason for the routing decision. */
  reason: string;
}

export interface ContextResult {
  entryPoint: EntryPoint;
  classification: Classification;
  /** The component match — present for visual / textual / behavioral tickets. */
  match?: QueryResult<ComponentMatch>;
  /** A structured decline — present for out-of-domain / unsupported tickets. */
  decline?: { reason: "out-of-scope" | "unsupported-input"; message: string };
}
