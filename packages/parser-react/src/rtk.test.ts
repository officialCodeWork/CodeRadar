import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DataSourceNode } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures",
);

const graph = scanReact({ root: path.join(fixtures, "field-patterns/app") });

function source(endpoint: string): DataSourceNode | undefined {
  return graph.nodes.find(
    (n): n is DataSourceNode => n.kind === "data-source" && n.endpoint === endpoint,
  );
}

describe("RTK Query extraction (TRACKER 6F.4, B2/C5)", () => {
  it("emits a data source per injectEndpoints endpoint, joining the base's baseUrl", () => {
    const users = source("/api/users");
    expect(users?.sourceKind).toBe("rtk-query");
    expect(users?.method).toBe("GET");
    expect(users?.resolved).toBe("full");
  });

  it("handles object-form query configs and template params in a second slice file", () => {
    expect(source("/api/invoices")?.method).toBe("GET");
    const pay = source("/api/invoices/:id/pay");
    expect(pay?.method).toBe("POST");
    expect(pay?.resolved).toBe("partial");
  });

  it("links generated-hook call sites with fetches-from edges", () => {
    const edges = graph.edges.filter((e) => e.kind === "fetches-from");
    expect(edges).toContainEqual({
      from: "component:pages/UsersPage.tsx#UsersPage",
      to: "data-source:store/api/usersApi.ts#rtk-query:/api/users",
      kind: "fetches-from",
    });
    expect(edges).toContainEqual({
      from: "component:pages/InvoicesPage.tsx#InvoicesPage",
      to: "data-source:store/api/invoicesApi.ts#rtk-query:/api/invoices",
      kind: "fetches-from",
    });
  });

  it("keeps the unused mutation as a source without consumers", () => {
    const pay = source("/api/invoices/:id/pay");
    expect(pay).toBeDefined();
    expect(graph.edges.some((e) => e.to === pay?.id && e.kind === "fetches-from")).toBe(false);
  });
});
