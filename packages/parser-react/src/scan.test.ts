import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchComponentsByText, traceLineage } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

const demoApp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../examples/demo-app/src",
);

const graph = resolveHookEdges(scanReact({ root: demoApp }));

describe("scanReact on the demo app", () => {
  it("emits schema v2", () => {
    expect(graph.version).toBe(2);
  });

  it("finds both component definitions and the hook", () => {
    const components = graph.nodes.filter((n) => n.kind === "component").map((n) => n.name);
    expect(components.sort()).toEqual(["UserCard", "UserList"]);
    expect(graph.nodes.some((n) => n.kind === "hook" && n.name === "useUsers")).toBe(true);
  });

  it("emits one UserCard instance rendered by UserList", () => {
    const instances = graph.nodes.filter((n) => n.kind === "instance");
    expect(instances).toHaveLength(1);
    const [inst] = instances;
    if (inst === undefined || inst.kind !== "instance") throw new Error("unreachable");
    expect(inst.name).toBe("UserCard");
    expect(inst.definitionId).toBe("component:components/UserCard.tsx#UserCard");
    expect(inst.loc.file).toBe("components/UserList.tsx");

    const rendersEdge = graph.edges.find((e) => e.kind === "renders" && e.to === inst.id);
    expect(rendersEdge?.from).toBe("component:components/UserList.tsx#UserList");
    const instanceOf = graph.edges.find((e) => e.kind === "instance-of" && e.from === inst.id);
    expect(instanceOf?.to).toBe(inst.definitionId);
  });

  it("extracts endpoints with methods, resolution, and raw source", () => {
    const sources = graph.nodes.flatMap((n) => (n.kind === "data-source" ? [n] : []));
    const endpoints = sources.map((s) => `${s.method} ${s.endpoint} (${s.resolved})`);
    expect(endpoints.sort()).toEqual([
      "DELETE /api/users/:id (partial)",
      "GET /api/users (full)",
    ]);
    const del = sources.find((s) => s.method === "DELETE");
    expect(del?.raw).toBe("`/api/users/${user.id}`");
  });

  it("matches screenshot text to UserList via the envelope", () => {
    const result = matchComponentsByText(graph, ["Team Members"]);
    expect(result.status).toBe("ok");
    expect(result.candidates[0]?.value.component.name).toBe("UserList");
  });

  it("traces UserList transitively through the hook and the child instance", () => {
    const result = traceLineage(graph, "component:components/UserList.tsx#UserList");
    expect(result.status).toBe("ok");
    const lineage = result.candidates[0]?.value;
    expect(lineage?.dataSources.map((d) => d.endpoint).sort()).toEqual([
      "/api/users",
      "/api/users/:id",
    ]);
    expect(lineage?.state.map((s) => s.name).sort()).toEqual(["loading", "users"]);
    expect(lineage?.events.map((e) => e.event)).toEqual(["onClick"]);
    expect(lineage?.via.map((v) => v.name)).toContain("useUsers");
  });
});
