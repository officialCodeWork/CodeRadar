import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DataSourceNode } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { parseGraphqlOperation } from "./graphql.js";
import { resolveHookEdges, scanReact } from "./scan.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../eval/fixtures");

describe("parseGraphqlOperation (7.1, C4)", () => {
  it("parses a named query with its root field", () => {
    expect(parseGraphqlOperation("query GetUsers { users { id name } }")).toStrictEqual({
      type: "query",
      name: "GetUsers",
      rootFields: ["users"],
    });
  });

  it("parses a named mutation with variables", () => {
    expect(
      parseGraphqlOperation("mutation CreateUser($input: UserInput!) { createUser(input: $input) { id } }"),
    ).toStrictEqual({ type: "mutation", name: "CreateUser", rootFields: ["createUser"] });
  });

  it("parses a subscription", () => {
    const op = parseGraphqlOperation("subscription OnTick { tick { at } }");
    expect(op?.type).toBe("subscription");
    expect(op?.name).toBe("OnTick");
  });

  it("parses an anonymous shorthand query via its root fields", () => {
    expect(parseGraphqlOperation("{ me { id } settings { theme } }")).toStrictEqual({
      type: "query",
      name: null,
      rootFields: ["me", "settings"],
    });
  });

  it("ignores # comments and leading whitespace", () => {
    const op = parseGraphqlOperation("\n  # fetch the current user\n  query Me { me { id } }\n");
    expect(op).toStrictEqual({ type: "query", name: "Me", rootFields: ["me"] });
  });

  it("returns null for a fragment-only document (not an operation)", () => {
    expect(parseGraphqlOperation("fragment UserFields on User { id name }")).toBeNull();
  });
});

describe("GraphQL data-source extraction (7.1, C4)", () => {
  const graph = resolveHookEdges(scanReact({ root: path.join(fixtures, "c4-graphql/app") }));
  const source = (endpoint: string): DataSourceNode | undefined =>
    graph.nodes.find((n): n is DataSourceNode => n.kind === "data-source" && n.endpoint === endpoint);

  it("emits a graphql source per operation, keyed by name, typed by operation", () => {
    expect(source("GetUsers")).toMatchObject({ sourceKind: "graphql", method: "query", resolved: "full" });
    expect(source("CreateUser")).toMatchObject({ sourceKind: "graphql", method: "mutation" });
    expect(source("OnTick")).toMatchObject({ sourceKind: "graphql", method: "subscription" });
  });

  it("wires a fetches-from edge from each running component", () => {
    const from = (comp: string, ds: string): boolean =>
      graph.edges.some(
        (e) =>
          e.kind === "fetches-from" &&
          e.from === `component:${comp}.tsx#${comp}` &&
          e.to.endsWith(`#graphql:${ds}`),
      );
    expect(from("UsersPanel", "GetUsers")).toBe(true);
    expect(from("InviteForm", "CreateUser")).toBe(true);
    expect(from("LiveTicker", "OnTick")).toBe(true);
  });

  it("does not misclassify react-query useQuery as graphql (disambiguation)", () => {
    // The c5 fixture uses react-query useQuery/useMutation with URL queryFns, no gql.
    const rq = resolveHookEdges(scanReact({ root: path.join(fixtures, "c5-queryfn-indirection/app") }));
    const graphqlSources = rq.nodes.filter(
      (n) => n.kind === "data-source" && n.sourceKind === "graphql",
    );
    expect(graphqlSources).toStrictEqual([]);
    expect(rq.nodes.some((n) => n.kind === "data-source" && n.sourceKind === "react-query")).toBe(true);
  });
});
