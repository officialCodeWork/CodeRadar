import { describe, expect, it } from "vitest";

import { blastRadius, matchComponentsByText, traceLineage } from "./query.js";
import { confidenceFromScore } from "./result.js";
import {
  type ComponentNode,
  type DataSourceNode,
  instanceId,
  type InstanceNode,
  type LineageGraph,
  nodeId,
} from "./types.js";

const loc = (file: string, line = 1) => ({ file, line, endLine: line });

function component(file: string, name: string, renderedText: string[]): ComponentNode {
  return {
    id: nodeId("component", file, name),
    kind: "component",
    name,
    loc: loc(file),
    exportName: name,
    props: [],
    renderedText: renderedText.map((text) => ({ text, source: "jsx" as const })),
    rendersComponents: [],
  };
}

function instance(file: string, line: number, definition: ComponentNode): InstanceNode {
  return {
    id: instanceId(file, line, definition.name),
    kind: "instance",
    name: definition.name,
    loc: loc(file, line),
    definitionId: definition.id,
    parentInstanceId: null,
    staticProps: {},
  };
}

function dataSource(file: string, endpoint: string): DataSourceNode {
  return {
    id: nodeId("data-source", file, `fetch:${endpoint}`),
    kind: "data-source",
    name: endpoint,
    loc: loc(file),
    sourceKind: "fetch",
    method: "GET",
    endpoint,
  };
}

function graph(nodes: LineageGraph["nodes"], edges: LineageGraph["edges"]): LineageGraph {
  return {
    version: 2,
    root: "/test",
    generatedAt: "2026-01-01T00:00:00Z",
    generator: "test",
    nodes,
    edges,
  };
}

describe("confidenceFromScore", () => {
  it("maps thresholds and clamps", () => {
    expect(confidenceFromScore(0.9).level).toBe("high");
    expect(confidenceFromScore(0.6).level).toBe("medium");
    expect(confidenceFromScore(0.2).level).toBe("low");
    expect(confidenceFromScore(1.7).score).toBe(1);
    expect(confidenceFromScore(-1).score).toBe(0);
  });
});

describe("id builders", () => {
  it("build canonical ids", () => {
    expect(nodeId("component", "a/B.tsx", "B")).toBe("component:a/B.tsx#B");
    expect(instanceId("a/A.tsx", 12, "B")).toBe("instance:a/A.tsx:12#B");
  });
});

describe("matchComponentsByText", () => {
  const billing = component("Billing.tsx", "BillingCard", ["Invoice total", "Save"]);
  const settings = component("Settings.tsx", "SettingsForm", ["Save", "Notifications"]);

  it("declines with no-signal when nothing matches", () => {
    const result = matchComponentsByText(graph([billing, settings], []), ["nonexistent"]);
    expect(result.status).toBe("declined");
    expect(result.declineReason).toBe("no-signal");
    expect(result.candidates).toHaveLength(0);
  });

  it("declines when terms are empty or too short", () => {
    expect(matchComponentsByText(graph([billing], []), []).status).toBe("declined");
    expect(matchComponentsByText(graph([billing], []), ["a"]).status).toBe("declined");
  });

  it("returns ok with a clear winner and evidence", () => {
    const result = matchComponentsByText(graph([billing, settings], []), [
      "Invoice total",
      "Save",
    ]);
    expect(result.status).toBe("ok");
    const top = result.candidates[0];
    expect(top?.value.component.name).toBe("BillingCard");
    expect(top?.evidence.length).toBe(2);
    expect(top?.evidence[0]?.kind).toBe("text-match");
  });

  it("returns ambiguous with a disambiguation question on ties", () => {
    const result = matchComponentsByText(graph([billing, settings], []), ["Save"]);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.disambiguation).toContain("BillingCard");
    expect(result.disambiguation).toContain("SettingsForm");
  });

  it("includes known instances of matched components", () => {
    const inst = instance("Page.tsx", 5, billing);
    const result = matchComponentsByText(graph([billing, inst], []), ["Invoice total"]);
    expect(result.status).toBe("ok");
    expect(result.candidates[0]?.value.instances.map((i) => i.id)).toEqual([inst.id]);
  });
});

describe("traceLineage", () => {
  const parent = component("Parent.tsx", "Parent", ["Team"]);
  const child = component("Child.tsx", "Child", []);
  const childInstance = instance("Parent.tsx", 8, child);
  const api = dataSource("Child.tsx", "/api/users");

  const g = graph(
    [parent, child, childInstance, api],
    [
      { from: parent.id, to: childInstance.id, kind: "renders" },
      { from: childInstance.id, to: child.id, kind: "instance-of" },
      { from: child.id, to: api.id, kind: "fetches-from" },
    ],
  );

  it("declines not-found for unknown ids", () => {
    expect(traceLineage(g, "component:Nope.tsx#Nope").declineReason).toBe("not-found");
  });

  it("declines invalid-target for non-component nodes", () => {
    expect(traceLineage(g, api.id).declineReason).toBe("invalid-target");
  });

  it("walks through instances to child data sources", () => {
    const result = traceLineage(g, parent.id);
    expect(result.status).toBe("ok");
    const lineage = result.candidates[0]?.value;
    expect(lineage?.dataSources.map((d) => d.endpoint)).toEqual(["/api/users"]);
    expect(lineage?.via.map((v) => v.id)).toContain(childInstance.id);
  });

  it("accepts an instance id as the start and records it", () => {
    const result = traceLineage(g, childInstance.id);
    expect(result.status).toBe("ok");
    const lineage = result.candidates[0]?.value;
    expect(lineage?.instance?.id).toBe(childInstance.id);
    expect(lineage?.component.name).toBe("Child");
    expect(lineage?.dataSources.map((d) => d.endpoint)).toEqual(["/api/users"]);
  });

  it("terminates on cyclic graphs", () => {
    const cyclic = graph(
      [parent, child, childInstance],
      [
        { from: parent.id, to: childInstance.id, kind: "renders" },
        { from: childInstance.id, to: child.id, kind: "instance-of" },
        { from: child.id, to: parent.id, kind: "renders" },
      ],
    );
    const result = traceLineage(cyclic, parent.id);
    expect(result.status).toBe("ok");
  });
});

describe("blastRadius", () => {
  // The c1 shape: one shared DataTable, two pages, two APIs (mirrors the fixture).
  const table = component("DataTable.tsx", "DataTable", ["No records found"]);
  const usersPage = component("UsersPage.tsx", "UsersPage", ["All Users"]);
  const invoicesPage = component("InvoicesPage.tsx", "InvoicesPage", ["All Invoices"]);
  const usersTable = instance("UsersPage.tsx", 17, table);
  const invoicesTable = instance("InvoicesPage.tsx", 17, table);
  const usersApi = dataSource("UsersPage.tsx", "/api/users");
  const invoicesApi = dataSource("InvoicesPage.tsx", "/api/invoices");

  const g = graph(
    [table, usersPage, invoicesPage, usersTable, invoicesTable, usersApi, invoicesApi],
    [
      { from: usersPage.id, to: usersTable.id, kind: "renders" },
      { from: usersTable.id, to: table.id, kind: "instance-of" },
      { from: invoicesPage.id, to: invoicesTable.id, kind: "renders" },
      { from: invoicesTable.id, to: table.id, kind: "instance-of" },
      { from: usersPage.id, to: usersApi.id, kind: "fetches-from" },
      { from: invoicesPage.id, to: invoicesApi.id, kind: "fetches-from" },
      { from: usersApi.id, to: usersTable.id, kind: "provides-data" },
      { from: invoicesApi.id, to: invoicesTable.id, kind: "provides-data" },
    ],
  );

  it("declines not-found for unknown targets", () => {
    expect(blastRadius(g, "Nope").declineReason).toBe("not-found");
  });

  it("finds both instances (d1) and both pages (d2) for a shared definition", () => {
    const impacts = blastRadius(g, "DataTable").candidates[0]?.value ?? [];
    const ids = impacts.map((i) => ({ id: i.node.id, distance: i.distance }));
    expect(ids).toContainEqual({ id: usersTable.id, distance: 1 });
    expect(ids).toContainEqual({ id: invoicesTable.id, distance: 1 });
    expect(ids).toContainEqual({ id: usersPage.id, distance: 2 });
    expect(ids).toContainEqual({ id: invoicesPage.id, distance: 2 });
  });

  it("resolves a data source by endpoint and lists only its consumers", () => {
    const impacts = blastRadius(g, "/api/users").candidates[0]?.value ?? [];
    const ids = impacts.map((i) => i.node.id);
    expect(ids).toContain(usersPage.id); // fetcher
    expect(ids).toContain(usersTable.id); // fed instance
    // Over-reach guard: nothing from the invoices side leaks in.
    expect(ids).not.toContain(invoicesPage.id);
    expect(ids).not.toContain(invoicesApi.id);
    expect(ids).not.toContain(invoicesTable.id);
  });

  it("honors the depth cap", () => {
    const shallow = blastRadius(g, "DataTable", { depth: 1 }).candidates[0]?.value ?? [];
    expect(shallow.every((i) => i.distance <= 1)).toBe(true);
    expect(shallow.some((i) => i.node.id === usersPage.id)).toBe(false);
  });

  it("returns a deterministic, high-confidence result", () => {
    const result = blastRadius(g, "DataTable");
    expect(result.status).toBe("ok");
    expect(result.candidates[0]?.confidence.level).toBe("high");
  });
});
