import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildBundle } from "@coderadar/agent-sdk";
import type { DataSourceNode, LineageGraph } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const appDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures/f4-typed-responses/app",
);

const withOpenApi: LineageGraph = scanReact({ root: appDir, openapi: "openapi.json" });
const withoutOpenApi: LineageGraph = scanReact({ root: appDir });

const source = (graph: LineageGraph, endpoint: string): DataSourceNode | undefined =>
  graph.nodes.find(
    (n): n is DataSourceNode => n.kind === "data-source" && n.endpoint === endpoint,
  );

describe("response-schema linking (TRACKER 5.5)", () => {
  it("recovers a response type from a call's generic argument", () => {
    const rt = source(withOpenApi, "/api/users")?.responseType;
    expect(rt?.name).toBe("User[]");
    expect(rt?.source).toBe("generic");
    expect(rt?.fields.map((f) => f.name)).toEqual(["id", "name", "email"]);
  });

  it("recovers a response type from a variable annotation", () => {
    const rt = source(withOpenApi, "/api/invoices")?.responseType;
    expect(rt?.name).toBe("Invoice[]");
    expect(rt?.source).toBe("annotation");
    expect(rt?.fields.map((f) => f.name)).toEqual(["id", "number", "total"]);
  });

  it("recovers a response type from an OpenAPI spec by endpoint", () => {
    const rt = source(withOpenApi, "/api/orders")?.responseType;
    expect(rt?.name).toBe("Order[]");
    expect(rt?.source).toBe("openapi");
    expect(rt?.fields.map((f) => f.name)).toEqual(["id", "status", "total"]);
  });

  it("leaves the OpenAPI-only source untyped when no spec is supplied", () => {
    expect(source(withoutOpenApi, "/api/orders")?.responseType).toBeUndefined();
    // The code-level sources still resolve without a spec.
    expect(source(withoutOpenApi, "/api/users")?.responseType?.name).toBe("User[]");
  });

  it("carries the response type through into the context bundle lineage", () => {
    const bundle = buildBundle(withOpenApi, { text: "Users" }, { budgetTokens: 8000 });
    const users = bundle.lineage
      .flatMap((entry) => entry.dataSources)
      .find((d) => d.endpoint === "/api/users");
    expect(users?.responseType?.name).toBe("User[]");
  });
});
