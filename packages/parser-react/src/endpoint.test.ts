import { type Node, Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { resolveEndpoint } from "./endpoint.js";

/** Parse a snippet and return the first argument of the fetch(...) call in it. */
function fetchArg(code: string): Node | undefined {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const sourceFile = project.createSourceFile("test.ts", code);
  const call = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((c) => c.getExpression().getText() === "fetch");
  return call?.getArguments()[0];
}

describe("resolveEndpoint", () => {
  it("resolves plain literals as full", () => {
    expect(resolveEndpoint(fetchArg(`fetch("/api/a");`), [])).toEqual({
      endpoint: "/api/a",
      raw: `"/api/a"`,
      resolved: "full",
    });
  });

  it("folds a named constant", () => {
    const arg = fetchArg(`const USERS = "/api/users"; fetch(USERS);`);
    expect(resolveEndpoint(arg, [])).toMatchObject({ endpoint: "/api/users", resolved: "full" });
  });

  it("folds an object member (ENDPOINTS.USERS)", () => {
    const arg = fetchArg(`const E = { USERS: "/api/users" }; fetch(E.USERS);`);
    expect(resolveEndpoint(arg, [])).toMatchObject({ endpoint: "/api/users", resolved: "full" });
  });

  it("folds concatenation of constant + literal", () => {
    const arg = fetchArg(`const P = "/api"; fetch(P + "/reports");`);
    expect(resolveEndpoint(arg, [])).toMatchObject({ endpoint: "/api/reports", resolved: "full" });
  });

  it("folds a fully-resolvable template", () => {
    const arg = fetchArg(`const V = "v2"; fetch(\`/api/\${V}/users\`);`);
    expect(resolveEndpoint(arg, [])).toMatchObject({ endpoint: "/api/v2/users", resolved: "full" });
  });

  it("turns unknown template parts into :param placeholders", () => {
    const arg = fetchArg(`declare const user: { id: string }; fetch(\`/api/users/\${user.id}\`);`);
    expect(resolveEndpoint(arg, [])).toMatchObject({
      endpoint: "/api/users/:id",
      resolved: "partial",
    });
  });

  it("keeps the shape when the resource segment itself is dynamic", () => {
    const arg = fetchArg(`declare const entity: string; fetch(\`/api/\${entity}/list\`);`);
    expect(resolveEndpoint(arg, [])).toMatchObject({
      endpoint: "/api/:entity/list",
      resolved: "partial",
    });
  });

  it("reports none for fully-opaque expressions", () => {
    const arg = fetchArg(`declare function buildUrl(): string; fetch(buildUrl());`);
    expect(resolveEndpoint(arg, [])).toMatchObject({ endpoint: "<dynamic>", resolved: "none" });
  });

  it("strips configured base URLs", () => {
    const arg = fetchArg(`fetch("https://api.example.com/users");`);
    expect(resolveEndpoint(arg, ["https://api.example.com"])).toMatchObject({
      endpoint: "/users",
      resolved: "full",
    });
  });
});
