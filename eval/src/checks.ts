/** Run one fixture's golden checks against its scanned graph. */

import {
  type LineageGraph,
  matchComponentsByText,
  traceLineage,
} from "@coderadar/core";

import type { CheckResult, FixtureResult, Golden } from "./golden.js";

export function runChecks(fixture: string, golden: Golden, graph: LineageGraph): FixtureResult {
  const checks: CheckResult[] = [];
  const attribution = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };

  const finalize = (
    kind: CheckResult["kind"],
    id: string,
    passed: boolean,
    marker: string | undefined,
    detail?: string,
  ): void => {
    let status: CheckResult["status"];
    if (marker !== undefined) {
      status = passed ? "unexpected-pass" : "xfail";
      detail = passed
        ? `passed but marked expectedFail (${marker}) — remove the stale marker`
        : marker;
    } else {
      status = passed ? "pass" : "fail";
    }
    checks.push({ id, kind, status, detail });
  };

  for (const expected of golden.expect.components ?? []) {
    const definition = graph.nodes.find(
      (n) => n.kind === "component" && n.name === expected.name,
    );
    // Count by definition, not by tag name: <Panel/> (an HOC alias) is an
    // instance OF PanelInner even though the JSX never says "PanelInner".
    const instances = graph.nodes.filter(
      (n) => n.kind === "instance" && definition !== undefined && n.definitionId === definition.id,
    );
    const passed = definition !== undefined && instances.length === expected.instances;
    finalize(
      "components",
      `components:${expected.name}`,
      passed,
      expected.expectedFail,
      definition === undefined
        ? "definition not found"
        : instances.length !== expected.instances
          ? `expected ${expected.instances} instances, found ${instances.length}`
          : undefined,
    );
  }

  for (const expected of golden.expect.attributions ?? []) {
    const id = `attribution:${expected.component}${expected.instanceAt !== undefined ? `@${expected.instanceAt}` : ""}`;
    const found = traceEndpoints(graph, expected.component, expected.instanceAt);
    if (found === null) {
      attribution.falseNegatives += expected.endpoints.length;
      finalize("attributions", id, false, expected.expectedFail, "trace target not found in graph");
      continue;
    }
    const want = new Set(expected.endpoints);
    const got = new Set(found);
    const missing = [...want].filter((e) => !got.has(e));
    const extra = [...got].filter((e) => !want.has(e));
    attribution.truePositives += want.size - missing.length;
    attribution.falseNegatives += missing.length;
    attribution.falsePositives += extra.length;
    finalize(
      "attributions",
      id,
      missing.length === 0 && extra.length === 0,
      expected.expectedFail,
      missing.length + extra.length > 0
        ? `missing: [${missing.join(", ")}] extra: [${extra.join(", ")}]`
        : undefined,
    );
  }

  for (const forbidden of golden.expect.forbidden ?? []) {
    const id = `forbidden:${forbidden.component}${forbidden.instanceAt !== undefined ? `@${forbidden.instanceAt}` : ""}!${forbidden.endpoint}`;
    const found = traceEndpoints(graph, forbidden.component, forbidden.instanceAt) ?? [];
    const poisoned = found.includes(forbidden.endpoint);
    // Forbidden checks never xfail: poison must gate in every phase.
    checks.push({
      id,
      kind: "forbidden",
      status: poisoned ? "fail" : "pass",
      detail: poisoned ? `POISON: ${forbidden.note ?? "forbidden attribution present"}` : undefined,
    });
    if (poisoned) attribution.falsePositives += 1;
  }

  for (const expected of golden.expect.routes ?? []) {
    const id = `route:${expected.path}`;
    const route = graph.nodes.find((n) => n.kind === "route" && n.path === expected.path);
    if (route === undefined || route.kind !== "route") {
      finalize("routes", id, false, expected.expectedFail, "route not found in graph");
      continue;
    }
    const pageEdge = graph.edges.find((e) => e.kind === "routes-to" && e.from === route.id);
    const page = pageEdge !== undefined ? graph.nodes.find((n) => n.id === pageEdge.to) : undefined;
    let detail: string | undefined;
    if (page?.name !== expected.component) {
      detail = `expected page ${expected.component}, got ${page?.name ?? "none"}`;
    } else if (expected.layout !== undefined && route.layout !== expected.layout) {
      detail = `expected layout ${expected.layout ?? "null"}, got ${route.layout ?? "null"}`;
    } else if (
      expected.guards !== undefined &&
      JSON.stringify(route.guards) !== JSON.stringify(expected.guards)
    ) {
      detail = `expected guards [${expected.guards.join(", ")}], got [${route.guards.join(", ")}]`;
    }
    finalize("routes", id, detail === undefined, expected.expectedFail, detail);
  }

  for (const forbiddenPath of golden.expect.forbiddenRoutes ?? []) {
    const present = graph.nodes.some((n) => n.kind === "route" && n.path === forbiddenPath);
    // Like forbidden attributions, forbidden routes never xfail.
    checks.push({
      id: `route!${forbiddenPath}`,
      kind: "routes",
      status: present ? "fail" : "pass",
      detail: present ? "POISON: forbidden route present in graph" : undefined,
    });
  }

  for (const expected of golden.expect.effects ?? []) {
    const id = `effect:${expected.component}.${expected.event}:${expected.effect}->${expected.to}`;
    const owner = graph.nodes.find(
      (n) => n.kind === "component" && n.name === expected.component,
    );
    // Events the component handles, filtered to the named event (onClick, …).
    const eventIds = new Set(
      graph.edges
        .filter((e) => e.kind === "handles" && owner !== undefined && e.from === owner.id)
        .map((e) => e.to)
        .filter((eventId) => {
          const event = graph.nodes.find((n) => n.id === eventId);
          return event?.kind === "event" && event.event === expected.event;
        }),
    );
    const matched = graph.edges.some((edge) => {
      if (edge.kind !== expected.effect || !eventIds.has(edge.from)) return false;
      const target = graph.nodes.find((n) => n.id === edge.to);
      if (target === undefined) return false;
      if (target.kind === "route") return target.path === expected.to;
      if (target.kind === "data-source") return target.endpoint === expected.to;
      if (target.kind === "state") return target.name === expected.to;
      return false;
    });
    finalize(
      "effects",
      id,
      matched,
      expected.expectedFail,
      matched
        ? undefined
        : owner === undefined
          ? "component not found"
          : `no ${expected.effect} edge from a ${expected.component}.${expected.event} event to ${expected.to}`,
    );
  }

  for (const query of golden.expect.queries ?? []) {
    const id = `query:${query.terms.join("+")}`;
    const result = matchComponentsByText(graph, query.terms);
    let passed = result.status === query.status;
    let detail: string | undefined;
    if (!passed) {
      detail = `expected status ${query.status}, got ${result.status}`;
    } else if (query.status === "ok" && query.top !== undefined) {
      const top = result.candidates[0]?.value.component.name;
      passed = top === query.top;
      if (!passed) detail = `expected top ${query.top}, got ${top ?? "none"}`;
    }
    finalize("queries", id, passed, query.expectedFail, detail);
  }

  return { fixture, failureMode: golden.failureMode, checks, attribution };
}

/** Endpoints reached from a definition or a specific instance. Null if the target is missing. */
function traceEndpoints(
  graph: LineageGraph,
  component: string,
  instanceAt: string | undefined,
): string[] | null {
  const target =
    instanceAt !== undefined
      ? graph.nodes.find(
          (n) => n.kind === "instance" && n.name === component && n.loc.file === instanceAt,
        )
      : graph.nodes.find((n) => n.kind === "component" && n.name === component);
  if (target === undefined) return null;
  const result = traceLineage(graph, target.id);
  const lineage = result.candidates[0]?.value;
  if (result.status !== "ok" || lineage === undefined) return null;
  return lineage.dataSources.map((d) => d.endpoint);
}
