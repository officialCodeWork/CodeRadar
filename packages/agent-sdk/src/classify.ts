/**
 * Rule-based ticket classification (TRACKER step 5.1). Deterministic, no LLM.
 * Precedence: unsupported → visual → out-of-domain → behavioral → textual.
 */
import type { Classification, Ticket } from "./types.js";

/** Attachment URLs that are video/GIF, not still images (E4). */
const VIDEO_LINK = /\.(mp4|mov|webm|avi|mkv|gif)(\?|#|$)/i;
const VIDEO_MENTION = /\b(screen[-\s]?recording|screencast|video (attached|recording|of))\b/i;

/** Backend / infra / performance vocabulary — outside the UI codebase (E6). */
const OUT_OF_DOMAIN =
  /\b(database|migration|sql|postgres|mysql|mongo|redis|kafka|rabbitmq|kubernetes|k8s|docker|deploy(ment|ments|s|ed|ing)?|infra(structure)?|terraform|cron|job queue|background job|worker|latency|throughput|memory leak|cpu usage|rate[-\s]?limit(ing|ed)?|webhook|ci\/cd|pipeline|nginx|load balancer|env(ironment)? variable|api gateway|microservice|502|503|504|gateway timeout|connection pool|index(ing)? (the )?table)\b/i;

/** Behavior/interaction phrasing — the entry point is an action, not a visual (E5). */
const BEHAVIORAL =
  /\b(nothing happens|does(n'?t| not) (work|respond|do anything|fire|trigger|navigate|submit|save|load|open|close)|no (response|reaction|effect)|not working|unresponsive|isn'?t working|won'?t (submit|save|open|close|load|work)|after (i |you |we )?(click|press|tap|submit|hit)|when (i |you |we )?(click|press|tap|submit|hit)|clicking .* (does|has) )/i;

/** Classify a ticket into an entry point (E1/E5/E6/E4). */
export function classifyTicket(ticket: Ticket): Classification {
  const text = ticket.text ?? "";
  const links = ticket.links ?? [];

  if (links.some((l) => VIDEO_LINK.test(l)) || VIDEO_MENTION.test(text)) {
    return {
      entryPoint: "unsupported",
      reason: "video/GIF attachment — no still frame to match; ask for a screenshot",
    };
  }
  if ((ticket.screenshots ?? 0) > 0) {
    return { entryPoint: "visual", reason: "screenshot attached — match on its text and structure" };
  }
  if (OUT_OF_DOMAIN.test(text)) {
    return {
      entryPoint: "out-of-domain",
      reason: "backend/infra/perf vocabulary — not a UI ticket",
    };
  }
  if (BEHAVIORAL.test(text)) {
    return {
      entryPoint: "behavioral",
      reason: "describes an interaction/failure, not a visual — match on event/journey vocabulary",
    };
  }
  return { entryPoint: "textual", reason: "UI terms in prose — match on rendered text" };
}
