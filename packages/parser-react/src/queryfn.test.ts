import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures/c5-queryfn-indirection/app",
);

const graph = scanReact({ root: fixture });
const sources = graph.nodes.flatMap((n) => (n.kind === "data-source" ? [n] : []));

describe("queryFn following (c5 fixture)", () => {
  it("resolves v4/v5 object-form queryFn references to their endpoint", () => {
    const users = sources.find((s) => s.endpoint === "/api/users" && s.method === "GET");
    expect(users?.sourceKind).toBe("react-query");
    expect(users?.queryKey).toBe(`["users"]`);
  });

  it("resolves mutationFn and picks up the inner POST method", () => {
    const post = sources.find((s) => s.endpoint === "/api/users" && s.method === "POST");
    expect(post?.sourceKind).toBe("react-query");
  });

  it("resolves the v3 positional form with an arrow-const fn", () => {
    const team = sources.find((s) => s.endpoint === "/api/team");
    expect(team?.sourceKind).toBe("react-query");
    expect(team?.queryKey).toBe(`["team"]`);
  });

  it("resolves inline arrow queryFns", () => {
    // The inline arrow queryFn (`() => fetch("/api/stats")`) yields both a
    // react-query source at the hook call site and the raw fetch it wraps, so
    // assert the react-query resolution exists rather than depending on which
    // node the canonical ordering (6.3) surfaces first.
    const stats = sources.filter((s) => s.endpoint === "/api/stats");
    expect(stats.some((s) => s.sourceKind === "react-query")).toBe(true);
  });

  it("never reports a query key as the endpoint", () => {
    expect(sources.some((s) => s.endpoint.startsWith("["))).toBe(false);
    expect(sources.some((s) => s.endpoint === "<dynamic>")).toBe(false);
  });
});
