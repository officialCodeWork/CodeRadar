import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DataSourceNode } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../eval/fixtures");
const graph = resolveHookEdges(scanReact({ root: path.join(fixtures, "c8-push-channels/app") }));

const source = (endpoint: string): DataSourceNode | undefined =>
  graph.nodes.find((n): n is DataSourceNode => n.kind === "data-source" && n.endpoint === endpoint);

describe("push-channel extraction (7.3, C8)", () => {
  it("emits a websocket data source for new WebSocket(url)", () => {
    expect(source("wss://chat.example.com/socket")).toMatchObject({
      sourceKind: "websocket",
      method: "WS",
      resolved: "full",
    });
  });

  it("emits an sse data source for new EventSource(url)", () => {
    expect(source("/api/notifications/stream")).toMatchObject({
      sourceKind: "sse",
      method: "SSE",
      resolved: "full",
    });
  });

  it("wires a fetches-from edge from the component that opens the channel", () => {
    const has = (comp: string, ds: string): boolean =>
      graph.edges.some(
        (e) => e.kind === "fetches-from" && e.from === `component:${comp}.tsx#${comp}` && e.to === ds,
      );
    expect(has("ChatPanel", "data-source:ChatPanel.tsx#websocket:wss://chat.example.com/socket")).toBe(
      true,
    );
    expect(has("NotificationsFeed", "data-source:NotificationsFeed.tsx#sse:/api/notifications/stream")).toBe(
      true,
    );
  });

  it("does not treat an unrelated constructor as a data source", () => {
    // Sanity: only WebSocket/EventSource are push channels — no stray sources.
    const kinds = graph.nodes.flatMap((n) => (n.kind === "data-source" ? [n.sourceKind] : []));
    expect(new Set(kinds)).toStrictEqual(new Set(["websocket", "sse"]));
  });
});
