import path from "node:path";
import { fileURLToPath } from "node:url";

import { traceLineage } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures",
);

function instanceEndpoints(graph: ReturnType<typeof scanReact>, name: string, file: string) {
  const instance = graph.nodes.find(
    (n) => n.kind === "instance" && n.name === name && n.loc.file === file,
  );
  if (instance === undefined) throw new Error(`instance ${name}@${file} not found`);
  const lineage = traceLineage(graph, instance.id).candidates[0]?.value;
  return lineage?.dataSources.map((d) => d.endpoint).sort() ?? [];
}

describe("prop-flow: the C1 headline case", () => {
  const graph = scanReact({ root: path.join(fixtures, "c1-shared-datatable/app") });

  it("attributes the users API to the users-page table only", () => {
    expect(instanceEndpoints(graph, "DataTable", "pages/UsersPage.tsx")).toEqual(["/api/users"]);
  });

  it("attributes the invoices API to the invoices-page table only", () => {
    expect(instanceEndpoints(graph, "DataTable", "pages/InvoicesPage.tsx")).toEqual([
      "/api/invoices",
    ]);
  });

  it("keeps the definition-level trace unmerged (perInstance breakdown)", () => {
    const definition = graph.nodes.find((n) => n.kind === "component" && n.name === "DataTable");
    if (definition === undefined) throw new Error("DataTable not found");
    const lineage = traceLineage(graph, definition.id).candidates[0]?.value;
    // The definition itself fetches nothing — the per-instance breakdown carries it.
    expect(lineage?.dataSources).toEqual([]);
    const breakdown = lineage?.perInstance?.map((p) => ({
      at: p.instance.loc.file,
      endpoints: p.dataSources.map((d) => d.endpoint),
    }));
    expect(breakdown).toContainEqual({ at: "pages/UsersPage.tsx", endpoints: ["/api/users"] });
    expect(breakdown).toContainEqual({
      at: "pages/InvoicesPage.tsx",
      endpoints: ["/api/invoices"],
    });
  });
});

describe("prop-flow: origin variants", () => {
  const graph = scanReact({ root: path.join(fixtures, "c1-prop-variants/app") });

  it("traces a react-query result prop (through ?? derivation)", () => {
    expect(instanceEndpoints(graph, "Table", "QueryPage.tsx")).toEqual(["/api/billing"]);
  });

  it("traces a custom-hook result prop to the hook's fetch", () => {
    expect(instanceEndpoints(graph, "Table", "HookPage.tsx")).toEqual(["/api/members"]);
  });
});
