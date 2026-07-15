import type { LineageGraph } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { renderVisualization, toViewModel } from "./visualize.js";

const graph: LineageGraph = {
  version: 2,
  root: "/app",
  generatedAt: "2026-07-15T00:00:00.000Z",
  generator: "test",
  nodes: [
    {
      id: "component:App.tsx#App",
      kind: "component",
      name: "App",
      loc: { file: "App.tsx", line: 1, endLine: 9 },
      exportName: "App",
      // A prop carrying a </script> payload — it flows into the node detail
      // and thus the embedded JSON, so it exercises the breakout guard.
      props: ["title", "</script><b>x"],
      renderedText: [{ text: "Hello world", source: "jsx" }],
      rendersComponents: [],
      structure: {
        table: 0, columns: 0, form: 0, input: 0, button: 0,
        link: 0, image: 0, heading: 1, list: 0, repeated: 0,
      },
    },
    {
      id: "data-source:api.ts#rtk-query:/api/users",
      kind: "data-source",
      name: "/api/users",
      loc: { file: "api.ts", line: 4, endLine: 4 },
      sourceKind: "rtk-query",
      method: "GET",
      endpoint: "/api/users",
      raw: '"/users"',
      resolved: "full",
    },
  ],
  edges: [
    { from: "component:App.tsx#App", to: "data-source:api.ts#rtk-query:/api/users", kind: "fetches-from" },
    // Dangling edge — must be dropped, not rendered.
    { from: "component:App.tsx#App", to: "component:Ghost.tsx#Ghost", kind: "renders" },
  ],
};

describe("visualize view model (TRACKER 6F.8)", () => {
  it("trims nodes and drops edges to unknown endpoints", () => {
    const model = toViewModel(graph);
    expect(model.nodes).toHaveLength(2);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]?.kind).toBe("fetches-from");
  });

  it("summarizes each node kind for the detail panel", () => {
    const model = toViewModel(graph);
    const ds = model.nodes.find((n) => n.kind === "data-source");
    expect(ds?.detail).toBe("GET /api/users (rtk-query)");
    expect(ds?.label).toBe("/api/users");
  });
});

describe("visualize HTML output", () => {
  const html = renderVisualization(graph, "My Galaxy");

  it("is a self-contained document with no external requests", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>My Galaxy</title>");
    // No network dependencies: no external src/href/fetch of remote origins.
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
    expect(html).not.toMatch(/@import/);
  });

  it("embeds the graph JSON safely against </script> breakout", () => {
    // A prop carries "</script>" — the embed must escape it so it can't close
    // the data <script> early. The literal must not appear; the escaped form must.
    expect(html).toContain("\\u003c/script>\\u003cb>x");
    // Exactly the data script + the app script close normally — no injected close.
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });

  it("inlines every node kind's color so the legend renders offline", () => {
    expect(html).toContain("#4f9dff"); // component
    expect(html).toContain("#ff8f6b"); // data-source
  });
});
