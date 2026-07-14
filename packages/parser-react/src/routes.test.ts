import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LineageGraph, RouteNode } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures",
);

const reactRouterGraph = scanReact({ root: path.join(fixturesDir, "b4-react-router/app") });
const nextGraph = scanReact({ root: path.join(fixturesDir, "b4-nextjs-approuter/app") });

function routes(graph: LineageGraph): RouteNode[] {
  return graph.nodes.filter((n): n is RouteNode => n.kind === "route");
}

function routeByPath(graph: LineageGraph, routePath: string): RouteNode {
  const route = routes(graph).find((r) => r.path === routePath);
  if (route === undefined) throw new Error(`route ${routePath} not found`);
  return route;
}

function pageOf(graph: LineageGraph, route: RouteNode): string | null {
  const edge = graph.edges.find((e) => e.kind === "routes-to" && e.from === route.id);
  if (edge === undefined) return null;
  return graph.nodes.find((n) => n.id === edge.to)?.name ?? null;
}

describe("React Router adapter (b4 fixture)", () => {
  it("emits exactly the declared routes", () => {
    expect(routes(reactRouterGraph).map((r) => r.path).sort()).toEqual([
      "/",
      "/admin",
      "/audit",
      "/reports",
      "/reports/:reportId",
      "/settings",
      "/users",
      "/users/:userId",
    ]);
  });

  it("maps index and nested object routes to their pages with the layout", () => {
    const home = routeByPath(reactRouterGraph, "/");
    expect(pageOf(reactRouterGraph, home)).toBe("HomePage");
    expect(home.layout).toBe("RootLayout");
    expect(home.router).toBe("react-router");

    const detail = routeByPath(reactRouterGraph, "/users/:userId");
    expect(pageOf(reactRouterGraph, detail)).toBe("UserDetail");
    expect(detail.layout).toBe("RootLayout");
  });

  it("records pathless guard routes on their descendants", () => {
    const admin = routeByPath(reactRouterGraph, "/admin");
    expect(pageOf(reactRouterGraph, admin)).toBe("AdminPanel");
    expect(admin.guards).toEqual(["RequireAuth"]);
    expect(admin.layout).toBe("RootLayout");
  });

  it("records inline element wrappers as guards, innermost tag as the page", () => {
    const audit = routeByPath(reactRouterGraph, "/audit");
    expect(pageOf(reactRouterGraph, audit)).toBe("AuditLog");
    expect(audit.guards).toEqual(["RequireAuth"]);
  });

  it("resolves lazy route modules through the dynamic import's Component export", () => {
    const settings = routeByPath(reactRouterGraph, "/settings");
    expect(pageOf(reactRouterGraph, settings)).toBe("SettingsPage");
    expect(settings.flags).toBeUndefined();
  });

  it("walks JSX <Route> trees with nested layout and index routes", () => {
    const reportsHome = routeByPath(reactRouterGraph, "/reports");
    expect(pageOf(reactRouterGraph, reportsHome)).toBe("ReportsHome");
    expect(reportsHome.layout).toBe("ReportsLayout");

    const reportDetail = routeByPath(reactRouterGraph, "/reports/:reportId");
    expect(pageOf(reactRouterGraph, reportDetail)).toBe("ReportDetail");
    expect(reportDetail.layout).toBe("ReportsLayout");
  });
});

describe("Next.js adapter (b4 fixture)", () => {
  it("emits exactly the file-derived routes — no _app, no api handlers", () => {
    expect(routes(nextGraph).map((r) => r.path).sort()).toEqual([
      "/",
      "/dashboard",
      "/docs/:slug*",
      "/legacy/:id",
      "/pricing",
      "/users/:userId",
    ]);
  });

  it("maps app-router segments: [param], [...catchAll], (group) dropped", () => {
    expect(pageOf(nextGraph, routeByPath(nextGraph, "/users/:userId"))).toBe("UserProfilePage");
    expect(pageOf(nextGraph, routeByPath(nextGraph, "/docs/:slug*"))).toBe("DocsPage");
    expect(pageOf(nextGraph, routeByPath(nextGraph, "/pricing"))).toBe("PricingPage");
  });

  it("assigns the nearest layout.tsx, falling back to the root layout", () => {
    expect(routeByPath(nextGraph, "/dashboard").layout).toBe("DashboardLayout");
    expect(routeByPath(nextGraph, "/pricing").layout).toBe("RootLayout");
    expect(routeByPath(nextGraph, "/").layout).toBe("RootLayout");
  });

  it("tags router kinds for app vs pages files", () => {
    expect(routeByPath(nextGraph, "/dashboard").router).toBe("nextjs-app");
    const legacy = routeByPath(nextGraph, "/legacy/:id");
    expect(legacy.router).toBe("nextjs-pages");
    expect(pageOf(nextGraph, legacy)).toBe("LegacyDetailPage");
  });

  it("does not run Next.js detection on non-Next projects", () => {
    // The React Router fixture has a pages/ directory but no next.config —
    // none of its files may produce nextjs routes.
    expect(routes(reactRouterGraph).every((r) => r.router === "react-router")).toBe(true);
  });
});
