import { describe, expect, it } from "vitest";

import { journeys } from "./query.js";
import type {
  ComponentNode,
  DataSourceNode,
  EdgeKind,
  EventNode,
  LineageEdge,
  LineageGraph,
  LineageNode,
  RouteNode,
} from "./types.js";
import { instanceId, nodeId } from "./types.js";

const loc = (file: string, line = 1) => ({ file, line, endLine: line });

function component(name: string): ComponentNode {
  return {
    id: nodeId("component", `${name}.tsx`, name),
    kind: "component",
    name,
    loc: loc(`${name}.tsx`),
    exportName: name,
    props: [],
    renderedText: [],
    rendersComponents: [],
  };
}

function route(path: string): RouteNode {
  return {
    id: nodeId("route", "routes.tsx", path),
    kind: "route",
    name: path,
    loc: loc("routes.tsx"),
    path,
    router: "react-router",
    layout: null,
    guards: [],
  };
}

function event(owner: string, name: string, handler: string): EventNode {
  return {
    id: nodeId("event", `${owner}.tsx`, `${owner}.${name}:${handler}`),
    kind: "event",
    name,
    loc: loc(`${owner}.tsx`),
    event: name,
    handler,
  };
}

function dataSource(endpoint: string): DataSourceNode {
  return {
    id: nodeId("data-source", "api.ts", `fetch:${endpoint}`),
    kind: "data-source",
    name: endpoint,
    loc: loc("api.ts"),
    sourceKind: "fetch",
    method: "GET",
    endpoint,
    raw: endpoint,
    resolved: "full",
  };
}

const edge = (from: string, to: string, kind: EdgeKind, extra: Partial<LineageEdge> = {}): LineageEdge => ({
  from,
  to,
  kind,
  ...extra,
});

function graphOf(nodes: LineageNode[], edges: LineageEdge[]): LineageGraph {
  return {
    version: 2,
    root: "/app",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "test",
    nodes,
    edges,
  };
}

/** Two pages that navigate to each other — the B6 list ↔ detail loop. */
function cyclicGraph(): LineageGraph {
  const a = component("PageA");
  const b = component("PageB");
  const ra = route("/a");
  const rb = route("/b");
  const goB = event("PageA", "onClick", "goB");
  const fetchA = event("PageA", "onClick", "load");
  const goA = event("PageB", "onClick", "goA");
  const ds = dataSource("/api/a");
  return graphOf(
    [a, b, ra, rb, goB, fetchA, goA, ds],
    [
      edge(ra.id, a.id, "routes-to"),
      edge(rb.id, b.id, "routes-to"),
      edge(a.id, goB.id, "handles"),
      edge(a.id, fetchA.id, "handles"),
      edge(b.id, goA.id, "handles"),
      edge(goB.id, rb.id, "navigates-to"),
      edge(goA.id, ra.id, "navigates-to"),
      edge(fetchA.id, ds.id, "triggers"),
    ],
  );
}

const pagesOf = (steps: { kind: string; label: string }[]): string[] =>
  steps.filter((s) => s.kind === "page").map((s) => s.label);

describe("journeys() — lazy expansion (TRACKER 3.3, B5/B6)", () => {
  it("expands a page's events into navigate and fetch paths", () => {
    const result = journeys(cyclicGraph(), "/a", { depth: 3 });
    expect(result.status).toBe("ok");
    const paths = result.candidates[0]?.value ?? [];
    const signatures = paths.map((p) => `${pagesOf(p.steps).join(">")}|${p.end}`);
    expect(signatures).toContain("/a|terminal"); // /a → onClick → fetch /api/a
    expect(signatures).toContain("/a>/b>/a|cycle"); // list ↔ detail loop, finite
  });

  it("closes a list ↔ detail loop as a finite 'cycle' path instead of looping", () => {
    const paths = journeys(cyclicGraph(), "/a", { depth: 3 }).candidates[0]?.value ?? [];
    const loopPath = paths.find((p) => p.end === "cycle");
    expect(loopPath).toBeDefined();
    expect(pagesOf(loopPath!.steps)).toEqual(["/a", "/b", "/a"]);
  });

  it("terminates on a cyclic graph even at large depth (never hangs)", () => {
    const started = Date.now();
    const paths = journeys(cyclicGraph(), "/a", { depth: 50 }).candidates[0]?.value ?? [];
    expect(Date.now() - started).toBeLessThan(1000);
    // Every path ends explicitly; no path is left dangling mid-expansion.
    expect(paths.every((p) => ["terminal", "cycle", "depth-limit"].includes(p.end))).toBe(true);
  });

  it("caps a non-cyclic chain at the requested depth with a depth-limit end", () => {
    const [a, b, c, d] = ["A", "B", "C", "D"].map(component);
    const [ra, rb, rc, rd] = ["/a", "/b", "/c", "/d"].map(route);
    const eAB = event("A", "onClick", "toB");
    const eBC = event("B", "onClick", "toC");
    const eCD = event("C", "onClick", "toD");
    const g = graphOf(
      [a, b, c, d, ra, rb, rc, rd, eAB, eBC, eCD],
      [
        edge(ra.id, a.id, "routes-to"),
        edge(rb.id, b.id, "routes-to"),
        edge(rc.id, c.id, "routes-to"),
        edge(rd.id, d.id, "routes-to"),
        edge(a.id, eAB.id, "handles"),
        edge(b.id, eBC.id, "handles"),
        edge(c.id, eCD.id, "handles"),
        edge(eAB.id, rb.id, "navigates-to"),
        edge(eBC.id, rc.id, "navigates-to"),
        edge(eCD.id, rd.id, "navigates-to"),
      ],
    );
    const paths = journeys(g, "/a", { depth: 3 }).candidates[0]?.value ?? [];
    const deepest = paths.find((p) => p.end === "depth-limit");
    expect(deepest).toBeDefined();
    expect(pagesOf(deepest!.steps)).toEqual(["/a", "/b", "/c"]); // stops before /d
  });

  it("resolves the start from a route path, a component name, or an instance id", () => {
    const g = cyclicGraph();
    const inst = {
      id: instanceId("Host.tsx", 4, "PageA"),
      kind: "instance" as const,
      name: "PageA",
      loc: loc("Host.tsx", 4),
      definitionId: nodeId("component", "PageA.tsx", "PageA"),
      parentInstanceId: null,
      staticProps: {},
    };
    expect(journeys(g, "/a").status).toBe("ok");
    expect(journeys(g, "PageA").status).toBe("ok");
    expect(journeys(graphOf([...g.nodes, inst], g.edges), inst.id).status).toBe("ok");
    expect(journeys(g, "NoSuchThing").status).toBe("declined");
  });

  it("carries an edge condition onto the journey step it gates", () => {
    const g = cyclicGraph();
    const gated = g.edges.map((e) =>
      e.kind === "navigates-to" && e.from.includes("goB")
        ? { ...e, condition: { kind: "role" as const, expression: "isAdmin" } }
        : e,
    );
    const paths = journeys(graphOf(g.nodes, gated), "/a", { depth: 3 }).candidates[0]?.value ?? [];
    const navStep = paths
      .flatMap((p) => p.steps)
      .find((s) => s.kind === "navigate" && s.condition !== undefined);
    expect(navStep?.condition?.expression).toBe("isAdmin");
  });
});
