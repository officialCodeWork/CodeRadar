import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../eval/fixtures");
const graph = resolveHookEdges(scanReact({ root: path.join(fixtures, "c9-nextjs-server-data/app") }));

/** Endpoints a component fetches, via fetches-from edges. */
function endpointsOf(component: string): string[] {
  const id = `component:${component}.tsx#${component}`;
  return graph.edges
    .filter((e) => e.kind === "fetches-from" && e.from === id)
    .map((e) => graph.nodes.find((n) => n.id === e.to))
    .flatMap((n) => (n?.kind === "data-source" ? [n.endpoint] : []));
}

describe("Next.js server data (7.2, C9)", () => {
  it("attributes an async RSC server component's inline fetch to the page", () => {
    expect(endpointsOf("DashboardPage")).toStrictEqual(["/api/dashboard/summary"]);
  });

  it("attributes getServerSideProps fetches to the default-export page", () => {
    expect(endpointsOf("ReportsPage")).toStrictEqual(["/api/reports/latest"]);
  });

  it("attributes getStaticProps fetches to the default-export page", () => {
    expect(endpointsOf("BlogPage")).toStrictEqual(["/api/posts"]);
  });

  it("does not create a component/hook node for the server-data functions", () => {
    const names = graph.nodes
      .filter((n) => n.kind === "component" || n.kind === "hook")
      .map((n) => n.name);
    expect(names).not.toContain("getServerSideProps");
    expect(names).not.toContain("getStaticProps");
  });
});
