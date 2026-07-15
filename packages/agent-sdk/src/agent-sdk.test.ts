import type { ComponentNode, LineageGraph } from "@coderadar/core";
import { nodeId } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { classifyTicket } from "./classify.js";
import { extractTerms, resolveContext } from "./resolve.js";

const loc = (f: string) => ({ file: f, line: 1, endLine: 1 });
function component(name: string, texts: string[]): ComponentNode {
  return {
    id: nodeId("component", `${name}.tsx`, name),
    kind: "component",
    name,
    loc: loc(`${name}.tsx`),
    exportName: name,
    props: [],
    renderedText: texts.map((text) => ({ text, source: "jsx" as const })),
    rendersComponents: [],
    structure: {
      table: 0,
      columns: 0,
      form: 0,
      input: 0,
      button: 0,
      link: 0,
      image: 0,
      heading: 0,
      list: 0,
      repeated: 0,
    },
  };
}
const graph: LineageGraph = {
  version: 2,
  root: "/app",
  generatedAt: "2026-01-01T00:00:00.000Z",
  generator: "test",
  nodes: [component("InvoiceList", ["All invoices"]), component("UserList", ["Team members"])],
  edges: [],
};

describe("classifyTicket (TRACKER 5.1)", () => {
  it("routes a screenshot to the visual path", () => {
    expect(classifyTicket({ text: "looks wrong", screenshots: 1 }).entryPoint).toBe("visual");
  });

  it("declines backend/infra/perf tickets as out-of-domain (E6)", () => {
    expect(classifyTicket({ text: "the Redis cache latency spiked" }).entryPoint).toBe(
      "out-of-domain",
    );
    expect(classifyTicket({ text: "kubernetes deployment crash-loops" }).entryPoint).toBe(
      "out-of-domain",
    );
  });

  it("routes an interaction failure to the behavioral path (E5)", () => {
    expect(classifyTicket({ text: "clicking Save does nothing" }).entryPoint).toBe("behavioral");
  });

  it("declines a video attachment as unsupported (E4)", () => {
    expect(classifyTicket({ text: "repro", links: ["https://x/clip.mp4"] }).entryPoint).toBe(
      "unsupported",
    );
    expect(classifyTicket({ text: "see the screen recording" }).entryPoint).toBe("unsupported");
  });

  it("treats UI prose as textual", () => {
    expect(classifyTicket({ text: "the 'All invoices' page shows stale totals" }).entryPoint).toBe(
      "textual",
    );
  });
});

describe("resolveContext (TRACKER 5.1)", () => {
  it("declines an out-of-domain ticket with a structured reason", () => {
    const result = resolveContext(graph, { text: "database migration failed on deploy" });
    expect(result.entryPoint).toBe("out-of-domain");
    expect(result.decline?.reason).toBe("out-of-scope");
    expect(result.match).toBeUndefined();
  });

  it("declines a video ticket as unsupported input", () => {
    const result = resolveContext(graph, { text: "x", links: ["https://x/a.mov"] });
    expect(result.decline?.reason).toBe("unsupported-input");
  });

  it("matches a textual ticket against the graph", () => {
    const result = resolveContext(graph, { text: "the 'All invoices' page is broken" });
    expect(result.entryPoint).toBe("textual");
    expect(result.match?.candidates[0]?.value.component.name).toBe("InvoiceList");
  });

  it("extracts quoted phrases as terms, else capitalized runs", () => {
    expect(extractTerms('the "Save draft" button')).toEqual(["Save draft"]);
    expect(extractTerms("the Team Members list")).toContain("Team Members");
  });
});
