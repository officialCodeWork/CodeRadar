/** Run one fixture's golden checks against its scanned graph. */

import {
  blastRadius,
  journeys,
  type LineageGraph,
  type LineageNode,
  matchComponents,
  traceLineage,
} from "@coderadar/core";

import type { CheckResult, FixtureResult, Golden, QueryOutcome } from "./golden.js";

export function runChecks(
  fixture: string,
  golden: Golden,
  graph: LineageGraph,
  aliases?: Record<string, string>,
): FixtureResult {
  const checks: CheckResult[] = [];
  const attribution = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
  const queryOutcomes: QueryOutcome[] = [];

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

  for (const expected of golden.expect.journeys ?? []) {
    for (const want of expected.expect) {
      const id = `journey:${expected.start}=>${want.pages.join(">")}${want.end !== undefined ? `[${want.end}]` : ""}`;
      const result = journeys(graph, expected.start, { depth: expected.depth ?? 3 });
      const found = (result.candidates[0]?.value ?? []).find((path) => {
        const pages = path.steps.filter((s) => s.kind === "page").map((s) => s.label);
        return (
          pages.length === want.pages.length &&
          pages.every((p, i) => p === want.pages[i]) &&
          (want.end === undefined || path.end === want.end)
        );
      });
      finalize(
        "journeys",
        id,
        result.status === "ok" && found !== undefined,
        expected.expectedFail,
        result.status !== "ok"
          ? `journeys(${expected.start}) returned ${result.status}`
          : found === undefined
            ? `no path visiting [${want.pages.join(" → ")}]${want.end !== undefined ? ` ending ${want.end}` : ""}`
            : undefined,
      );
    }
  }

  for (const expected of golden.expect.conditions ?? []) {
    const id = `condition:${expected.component}.${expected.edge}:${expected.kind}~${expected.expression}`;
    const owner = graph.nodes.find((n) => n.kind === "component" && n.name === expected.component);
    const matched = graph.edges.some(
      (e) =>
        e.kind === expected.edge &&
        owner !== undefined &&
        e.from === owner.id &&
        e.condition?.kind === expected.kind &&
        e.condition.expression.includes(expected.expression),
    );
    finalize(
      "conditions",
      id,
      matched,
      expected.expectedFail,
      matched
        ? undefined
        : owner === undefined
          ? "component not found"
          : `no ${expected.edge} edge from ${expected.component} with a ${expected.kind} condition containing "${expected.expression}"`,
    );
  }

  for (const expected of golden.expect.externals ?? []) {
    const id = `external:${expected.kind}:${expected.component ?? expected.route}~${expected.host}`;
    const node = (nid: string) => graph.nodes.find((n) => n.id === nid);
    let matched = false;
    if (expected.kind === "exits") {
      const owner = graph.nodes.find((n) => n.kind === "component" && n.name === expected.component);
      matched = graph.edges.some((e) => {
        if (e.kind !== "exits-app") return false;
        const target = node(e.to);
        if (target?.kind !== "external" || target.host !== expected.host || owner === undefined) {
          return false;
        }
        if (e.from === owner.id) return true; // direct <a href>
        // otherwise an event handled by the owner component
        return (
          node(e.from)?.kind === "event" &&
          graph.edges.some((h) => h.kind === "handles" && h.from === owner.id && h.to === e.from)
        );
      });
    } else {
      matched = graph.edges.some((e) => {
        if (e.kind !== "enters-at") return false;
        const route = node(e.to);
        const from = node(e.from);
        return (
          route?.kind === "route" &&
          route.path === expected.route &&
          from?.kind === "external" &&
          from.host === expected.host
        );
      });
    }
    finalize(
      "externals",
      id,
      matched,
      expected.expectedFail,
      matched ? undefined : `no ${expected.kind}-app edge for ${expected.host}`,
    );
  }

  const impactName = (n: LineageNode): string =>
    n.kind === "instance"
      ? (graph.nodes.find((d) => d.id === n.definitionId)?.name ?? "")
      : n.kind === "data-source"
        ? n.endpoint
        : n.kind === "route"
          ? n.path
          : n.kind === "event"
            ? (n.handler ?? n.event)
            : n.name;

  for (const spec of golden.expect.blast ?? []) {
    const result = blastRadius(graph, spec.node);
    const impacts = result.candidates[0]?.value ?? [];
    for (const want of spec.expect) {
      const id = `blast:${spec.node}=>${want.node}${want.at ? `@${want.at}` : ""}${want.distance !== undefined ? `[${want.distance}]` : ""}`;
      const found = impacts.find(
        (im) =>
          impactName(im.node) === want.node &&
          (want.kind === undefined || im.node.kind === want.kind) &&
          (want.at === undefined || im.node.loc.file.includes(want.at)) &&
          (want.distance === undefined || im.distance === want.distance),
      );
      finalize(
        "blast",
        id,
        result.status === "ok" && found !== undefined,
        spec.expectedFail,
        result.status !== "ok"
          ? `blastRadius(${spec.node}) returned ${result.status}`
          : found === undefined
            ? `no impact ${want.node}${want.at ? ` at ${want.at}` : ""}${want.distance !== undefined ? ` at distance ${want.distance}` : ""}`
            : undefined,
      );
    }
    // Over-reach guard: forbidden nodes never gate as xfail — a leak is always a failure.
    for (const forbidden of spec.forbidden ?? []) {
      const leaked = impacts.some((im) => impactName(im.node) === forbidden);
      finalize(
        "blast",
        `blast:${spec.node}!=>${forbidden}`,
        !leaked,
        undefined,
        leaked ? `over-reach: ${forbidden} appeared in the blast radius of ${spec.node}` : undefined,
      );
    }
  }

  for (const spec of golden.expect.coverage ?? []) {
    const owner = graph.nodes.find((n) => n.kind === "component" && n.name === spec.component);
    const testFiles =
      owner === undefined
        ? []
        : graph.edges
            .filter((e) => e.kind === "covered-by" && e.from === owner.id)
            .map((e) => graph.nodes.find((n) => n.id === e.to)?.loc.file)
            .filter((f): f is string => f !== undefined);
    if (spec.untested === true) {
      finalize(
        "coverage",
        `coverage:${spec.component}!covered`,
        owner !== undefined && testFiles.length === 0,
        spec.expectedFail,
        owner === undefined
          ? "component not found"
          : testFiles.length > 0
            ? `expected untested, but covered by [${testFiles.join(", ")}]`
            : undefined,
      );
    }
    for (const want of spec.tests ?? []) {
      const found = testFiles.some((f) => f.includes(want));
      finalize(
        "coverage",
        `coverage:${spec.component}<=${want}`,
        owner !== undefined && found,
        spec.expectedFail,
        owner === undefined
          ? "component not found"
          : found
            ? undefined
            : `no test file matching "${want}" covers ${spec.component} (have [${testFiles.join(", ")}])`,
      );
    }
  }

  for (const query of golden.expect.queries ?? []) {
    const id = `query:${query.terms.join("+") || JSON.stringify(query.structure)}`;
    const result = matchComponents(graph, {
      terms: query.terms,
      structure: query.structure,
      ...(aliases !== undefined ? { aliases } : {}),
    });
    let passed = result.status === query.status;
    let detail: string | undefined;
    if (!passed) {
      detail = `expected status ${query.status}, got ${result.status}`;
    } else if (query.status === "ok" && query.top !== undefined) {
      const k = query.topK ?? 1;
      const topNames = result.candidates.slice(0, k).map((c) => c.value.component.name);
      passed = topNames.includes(query.top);
      if (!passed) {
        detail =
          k > 1
            ? `expected ${query.top} in top ${k}, got [${topNames.join(", ")}]`
            : `expected top ${query.top}, got ${topNames[0] ?? "none"}`;
      } else if (query.context !== undefined) {
        const ctx = (result.candidates[0]?.value.context ?? []).map((c) => c.name);
        const missing = query.context.filter((c) => !ctx.includes(c));
        passed = missing.length === 0;
        if (!passed) detail = `expected context [${query.context.join(", ")}], got [${ctx.join(", ")}]`;
      }
      if (passed && query.confidence !== undefined) {
        const level = result.candidates[0]?.confidence.level;
        passed = level === query.confidence;
        if (!passed) detail = `expected confidence ${query.confidence}, got ${level ?? "none"}`;
      }
    }
    finalize("queries", id, passed, query.expectedFail, detail);

    if (query.expectedFail === undefined) {
      const top = result.candidates[0];
      queryOutcomes.push({
        terms: query.terms,
        expectedStatus: query.status,
        gotStatus: result.status,
        ...(top !== undefined
          ? {
              top: top.value.component.name,
              confidence: top.confidence.level,
              score: top.confidence.score,
            }
          : {}),
        correct: passed,
      });
    }
  }

  return { fixture, failureMode: golden.failureMode, checks, attribution, queries: queryOutcomes };
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
