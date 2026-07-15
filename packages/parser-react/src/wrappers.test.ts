import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { detectWrappers } from "./wrappers.js";

function projectWith(code: string): Project {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  project.createSourceFile("client.ts", code);
  return project;
}

describe("detectWrappers", () => {
  it("detects a plain function wrapper over fetch", () => {
    const registry = detectWrappers(
      projectWith(`function apiGet(path: string) { return fetch(path); }`),
      [],
    );
    expect(registry.get("apiGet")).toMatchObject({
      paramName: "path",
      pathParamIndex: 0,
      template: ":path",
      method: "GET",
      sourceKind: "fetch",
    });
  });

  it("captures a URL prefix from the wrapper body", () => {
    const registry = detectWrappers(
      projectWith(
        `const BASE = "/api";
         function request(path: string) { return fetch(\`\${BASE}\${path}\`); }`,
      ),
      [],
    );
    expect(registry.get("request")?.template).toBe("/api:path");
  });

  it("detects object-literal methods and infers method from the name suffix", () => {
    const registry = detectWrappers(
      projectWith(
        `function request(path: string, init?: RequestInit) { return fetch(path, init); }
         const apiClient = {
           get(path: string) { return request(path); },
           post(path: string, body: unknown) { return request(path, { method: "POST" }); },
         };`,
      ),
      [],
    );
    expect(registry.get("apiClient.get")?.method).toBe("GET");
    expect(registry.get("apiClient.post")?.method).toBe("POST");
  });

  it("composes templates through a three-layer chain", () => {
    const registry = detectWrappers(
      projectWith(
        `const BASE = "/api";
         function request(path: string) { return fetch(\`\${BASE}\${path}\`); }
         const apiClient = { get(p: string) { return request(p); } };
         function useApi(route: string) { return apiClient.get(route); }`,
      ),
      [],
    );
    expect(registry.get("request")?.template).toBe("/api:path");
    expect(registry.get("apiClient.get")?.template).toBe("/api:p");
    expect(registry.get("useApi")?.template).toBe("/api:route");
  });

  it("registers configured wrappers without needing their source", () => {
    const registry = detectWrappers(projectWith(`export {};`), ["http.post", "sdk.request"]);
    expect(registry.get("http.post")).toMatchObject({ template: ":path", method: "POST" });
    expect(registry.get("sdk.request")).toMatchObject({ template: ":path", method: null });
  });

  it("ignores functions that never reach a data source", () => {
    const registry = detectWrappers(
      projectWith(`function formatPath(path: string) { return path.trim(); }`),
      [],
    );
    expect(registry.has("formatPath")).toBe(false);
  });
});
