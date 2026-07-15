/**
 * resolveContext (TRACKER step 5.1): classify a ticket, then run the matching
 * engine with the signals available. Out-of-domain and unsupported tickets are
 * declined with a structured reason rather than forced into a match.
 */
import { type LineageGraph, matchComponents } from "@coderadar/core";

import { classifyTicket } from "./classify.js";
import type { ContextResult, Ticket } from "./types.js";

export function resolveContext(graph: LineageGraph, ticket: Ticket): ContextResult {
  const classification = classifyTicket(ticket);
  const { entryPoint } = classification;

  if (entryPoint === "out-of-domain") {
    return {
      entryPoint,
      classification,
      decline: {
        reason: "out-of-scope",
        message:
          "This reads as a backend / infrastructure / performance ticket — outside the UI codebase CodeRadar maps. Route it to a human or a backend tool.",
      },
    };
  }
  if (entryPoint === "unsupported") {
    return {
      entryPoint,
      classification,
      decline: {
        reason: "unsupported-input",
        message: "Video/GIF attachments aren't supported — attach a still screenshot of the state.",
      },
    };
  }

  return { entryPoint, classification, match: matchComponents(graph, { terms: extractTerms(ticket.text) }) };
}

/** Pull candidate UI terms from ticket prose: quoted phrases, else capitalized runs. */
export function extractTerms(text: string): string[] {
  const quoted = [...text.matchAll(/["'`]([^"'`]{2,})["'`]/g)].map((m) => m[1] ?? "");
  const cleaned = quoted.filter((t) => t.trim().length > 1);
  if (cleaned.length > 0) return cleaned;
  const caps = [...text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z0-9]+){0,3})\b/g)].map((m) => m[1] ?? "");
  const distinctive = caps.filter((t) => t.length > 2);
  return distinctive.length > 0 ? distinctive : [text];
}
