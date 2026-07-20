/**
 * Push-channel extraction (TRACKER step 7.3, failure mode C8).
 *
 * Server-push data arrives over a long-lived connection, not a request/response
 * fetch: the browser `WebSocket` and Server-Sent-Events `EventSource`
 * constructors. Each `new WebSocket(url)` / `new EventSource(url)` becomes a data
 * source — `websocket` / `sse` sourceKind, the URL as its endpoint — so a
 * component fed by a live channel shows that channel in its lineage.
 */
import type { DataSourceKind } from "@coderadar/core";
import { Node } from "ts-morph";

import { resolveEndpoint, type ResolvedEndpoint } from "./endpoint.js";

export interface PushChannel extends ResolvedEndpoint {
  sourceKind: DataSourceKind;
  /** Transport label: "WS" for WebSocket, "SSE" for EventSource. */
  method: string;
}

/** The last identifier in a (possibly namespaced) callee, e.g. `window.WebSocket` → `WebSocket`. */
function calleeName(expr: string): string {
  return expr.split(".").pop() ?? expr;
}

/**
 * A push-channel data source for a `new WebSocket(url)` / `new EventSource(url)`
 * expression, or null. Only the standard global constructors are matched (by
 * name, including a `window.`/`self.` qualifier) — a very low false-positive set.
 */
export function detectPushChannel(node: Node, baseUrls: string[]): PushChannel | null {
  if (!Node.isNewExpression(node)) return null;
  const name = calleeName(node.getExpression().getText());
  const urlArg = node.getArguments()?.[0];
  if (name === "WebSocket") {
    return { sourceKind: "websocket", method: "WS", ...resolveEndpoint(urlArg, baseUrls) };
  }
  if (name === "EventSource") {
    return { sourceKind: "sse", method: "SSE", ...resolveEndpoint(urlArg, baseUrls) };
  }
  return null;
}
