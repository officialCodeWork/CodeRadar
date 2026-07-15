/**
 * The context bundle (TRACKER step 5.2, failure mode F1): the budgeted,
 * priority-trimmed payload an agent consumes. Sections are filled by the
 * matching/lineage/journey engines; blastRadius, tests, and history are wired
 * in steps 5.3/5.4/5.6 and ship as empty arrays until then.
 *
 * Budgeter: when the estimated token size exceeds `budgetTokens`, sections are
 * emptied in reverse priority (history → tests → journeys → blastRadius →
 * lineage; match is never dropped, only reduced to the top candidate), and each
 * trim is recorded in `warnings`.
 */
import {
  blastRadius,
  type ImpactNode,
  type JourneyPath,
  journeys,
  type LineageGraph,
  type LineageNode,
  traceLineage,
} from "@coderadar/core";

import { resolveContext } from "./resolve.js";
import type { EntryPoint, Ticket } from "./types.js";

export interface BundleMatch {
  component: string;
  instances: string[];
  confidence: "high" | "medium" | "low";
  evidence: string[];
}

export interface BundleLineageEntry {
  /** Component name, or `Name@file:line` for a specific instance. */
  target: string;
  dataSources: { method: string | null; endpoint: string }[];
  state: string[];
  events: string[];
}

/** Reverse-traversal impact (step 5.3) — empty until then. */
export interface BundleImpact {
  node: string;
  relation: string;
  distance: number;
}

/** Test coverage (step 5.4) — empty until then. */
export interface BundleTest {
  file: string;
}

/** Recent git history (step 5.6) — empty until then. */
export interface BundleCommit {
  sha: string;
  subject: string;
}

export interface ContextBundle {
  ticket: { text: string; entryPoint: EntryPoint };
  status: "matched" | "ambiguous" | "declined";
  match: BundleMatch[];
  lineage: BundleLineageEntry[];
  journeys: JourneyPath[];
  blastRadius: BundleImpact[];
  tests: BundleTest[];
  history: BundleCommit[];
  warnings: string[];
  budget: { tokens: number; used: number };
}

export interface BundleOptions {
  /** Token budget the finished bundle must fit under. Default 4000. */
  budgetTokens?: number;
  /** Journey expansion depth around the match. Default 2. */
  journeyDepth?: number;
}

/** Trim sections in this reverse-priority order until the bundle fits its budget. */
const TRIM_ORDER = ["history", "tests", "journeys", "blastRadius", "lineage"] as const;

/** A deterministic, tokenizer-free size estimate (≈ 4 chars per token). */
export function estimateTokens(bundle: ContextBundle): number {
  return Math.ceil(JSON.stringify({ ...bundle, budget: undefined }).length / 4);
}

/** Resolve a ticket into a budgeted context bundle. */
export function buildBundle(
  graph: LineageGraph,
  ticket: Ticket,
  options: BundleOptions = {},
): ContextBundle {
  const budgetTokens = options.budgetTokens ?? 4000;
  const depth = options.journeyDepth ?? 2;
  const ctx = resolveContext(graph, ticket);

  const bundle: ContextBundle = {
    ticket: { text: ticket.text, entryPoint: ctx.entryPoint },
    status: "declined",
    match: [],
    lineage: [],
    journeys: [],
    blastRadius: [],
    tests: [],
    history: [],
    warnings: [],
    budget: { tokens: budgetTokens, used: 0 },
  };

  if (ctx.decline !== undefined) {
    bundle.warnings.push(`declined (${ctx.decline.reason}): ${ctx.decline.message}`);
    return trimToBudget(bundle, budgetTokens);
  }
  const match = ctx.match;
  if (match === undefined || match.status === "declined") {
    bundle.warnings.push(`no component matched (${match?.declineReason ?? "no result"})`);
    return trimToBudget(bundle, budgetTokens);
  }

  bundle.status = match.status === "ambiguous" ? "ambiguous" : "matched";
  const limit = match.status === "ambiguous" ? 5 : 3;
  for (const candidate of match.candidates.slice(0, limit)) {
    bundle.match.push({
      component: candidate.value.component.name,
      instances: candidate.value.instances.map((i) => `${i.loc.file}:${i.loc.line}`),
      confidence: candidate.confidence.level,
      evidence: candidate.evidence.map((e) => e.detail),
    });
  }
  if (match.status === "ambiguous" && match.disambiguation !== undefined) {
    bundle.warnings.push(`ambiguous — ${match.disambiguation}`);
  }

  const top = match.candidates[0]?.value;
  if (top !== undefined) {
    const definitionLineage = traceLineage(graph, top.component.id).candidates[0]?.value;
    if (definitionLineage !== undefined) {
      bundle.lineage.push({
        target: top.component.name,
        dataSources: definitionLineage.dataSources.map((d) => ({
          method: d.method,
          endpoint: d.endpoint,
        })),
        state: definitionLineage.state.map((s) => s.name),
        events: definitionLineage.events.map((e) => e.event),
      });
    }
    for (const instance of top.instances) {
      const instLineage = traceLineage(graph, instance.id).candidates[0]?.value;
      if (instLineage === undefined || instLineage.dataSources.length === 0) continue;
      bundle.lineage.push({
        target: `${top.component.name}@${instance.loc.file}:${instance.loc.line}`,
        dataSources: instLineage.dataSources.map((d) => ({ method: d.method, endpoint: d.endpoint })),
        state: [],
        events: [],
      });
    }
    bundle.journeys = journeys(graph, top.component.name, { depth }).candidates[0]?.value ?? [];

    const impacts = blastRadius(graph, top.component.id).candidates[0]?.value ?? [];
    const byId = new Map<string, LineageNode>(graph.nodes.map((n) => [n.id, n]));
    bundle.blastRadius = impacts.map((impact) => ({
      node: impactLabel(impact, byId),
      relation: impact.relation,
      distance: impact.distance,
    }));
  }

  if (graph.meta?.dirty === true) {
    bundle.warnings.push("graph built from a dirty working tree — may not match committed code");
  }
  const incomplete = graph.nodes.filter((n) => n.flags?.includes("incomplete")).length;
  if (incomplete > 0) bundle.warnings.push(`${incomplete} node(s) could not be fully parsed`);

  return trimToBudget(bundle, budgetTokens);
}

/** A compact, agent-readable name for one impacted node, with its source location. */
function impactLabel(impact: ImpactNode, byId: Map<string, LineageNode>): string {
  const node = impact.node;
  const where = `${node.loc.file}:${node.loc.line}`;
  if (node.kind === "instance") {
    const defName = byId.get(node.definitionId)?.name ?? "?";
    return `${defName}@${where}`;
  }
  const name =
    node.kind === "data-source"
      ? node.endpoint
      : node.kind === "route"
        ? node.path
        : node.kind === "event"
          ? (node.handler ?? node.event)
          : node.name;
  return `${node.kind} ${name} (${where})`;
}

function trimToBudget(bundle: ContextBundle, budgetTokens: number): ContextBundle {
  for (const section of TRIM_ORDER) {
    if (estimateTokens(bundle) <= budgetTokens) break;
    const list = bundle[section];
    if (Array.isArray(list) && list.length > 0) {
      const n = list.length;
      list.length = 0;
      bundle.warnings.push(`trimmed ${n} ${section} entr${n === 1 ? "y" : "ies"} to fit the ${budgetTokens}-token budget`);
    }
  }
  if (estimateTokens(bundle) > budgetTokens && bundle.match.length > 1) {
    const dropped = bundle.match.length - 1;
    bundle.match = bundle.match.slice(0, 1);
    bundle.warnings.push(`trimmed ${dropped} lower-ranked match candidate(s) to fit the budget`);
  }
  bundle.budget.used = estimateTokens(bundle);
  return bundle;
}
