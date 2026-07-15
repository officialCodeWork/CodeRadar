import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildBundle } from "@coderadar/agent-sdk";
import type { LineageGraph, TestNode } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures",
);

const graph: LineageGraph = scanReact({ root: path.join(fixturesDir, "f3-test-coverage/app") });

const component = (name: string) =>
  graph.nodes.find((n) => n.kind === "component" && n.name === name);
const tests = graph.nodes.filter((n): n is TestNode => n.kind === "test");
const coveredBy = (name: string) =>
  graph.edges
    .filter((e) => e.kind === "covered-by" && e.from === component(name)?.id)
    .map((e) => graph.nodes.find((n) => n.id === e.to))
    .filter((n): n is TestNode => n?.kind === "test");

describe("test-coverage mapping (TRACKER 5.4)", () => {
  it("emits a TestNode for a test file that renders a component", () => {
    expect(tests.map((t) => t.name)).toContain("UserList.test.tsx");
    expect(tests.find((t) => t.name === "UserList.test.tsx")?.framework).toBe("vitest");
  });

  it("links the rendered component to its test via covered-by", () => {
    const covering = coveredBy("UserList");
    expect(covering.map((t) => t.name)).toEqual(["UserList.test.tsx"]);
  });

  it("leaves a component with no test uncovered", () => {
    expect(coveredBy("Sidebar")).toHaveLength(0);
  });

  it("does not turn test files into component or instance nodes", () => {
    // The test renders <UserList/>, but that must not materialize an instance.
    const instances = graph.nodes.filter((n) => n.kind === "instance");
    expect(instances).toHaveLength(0);
    // No component named after the test's describe/it callbacks.
    expect(component("UserList.test")).toBeUndefined();
  });

  it("surfaces the covering test in the context bundle", () => {
    const bundle = buildBundle(graph, { text: "Ada Lovelace" }, { budgetTokens: 8000 });
    expect(bundle.match[0]?.component).toBe("UserList");
    expect(bundle.tests.map((t) => t.file)).toContain("components/UserList.test.tsx");
    expect(bundle.warnings.some((w) => w.startsWith("untested"))).toBe(false);
  });

  it("warns when the matched component has no test", () => {
    const bundle = buildBundle(graph, { text: "Dashboard Settings" }, { budgetTokens: 8000 });
    expect(bundle.match[0]?.component).toBe("Sidebar");
    expect(bundle.tests).toHaveLength(0);
    expect(bundle.warnings.some((w) => w.startsWith("untested"))).toBe(true);
  });
});
