/**
 * Query helpers over a LineageGraph — the primitives an agent composes to go
 * from "text seen in a screenshot" to "component" to "everything that feeds it".
 *
 * Every function returns a QueryResult envelope: ranked candidates with
 * evidence and confidence, or an honest ambiguous/declined.
 */

import {
  ambiguous,
  type Candidate,
  confidenceFromScore,
  declined,
  ok,
  type QueryResult,
} from "./result.js";
import { normalizeText, textMatches } from "./text.js";
import type {
  ComponentNode,
  DataSourceNode,
  EventNode,
  Evidence,
  InstanceNode,
  LineageEdge,
  LineageGraph,
  LineageNode,
  StateNode,
} from "./types.js";

export interface ComponentMatch {
  component: ComponentNode;
  /** Call sites of this component, when known. */
  instances: InstanceNode[];
  matchedText: string[];
}

/**
 * Rank components by overlap between `terms` (words/phrases read off a
 * screenshot or ticket) and each component's statically rendered text.
 *
 * Returns `ambiguous` when several components tie at the top score,
 * `declined("no-signal")` when nothing matches at all.
 */
export function matchComponentsByText(
  graph: LineageGraph,
  terms: string[],
): QueryResult<ComponentMatch> {
  const needles = terms.map((t) => normalizeText(t)).filter((t) => t.length > 1);
  if (needles.length === 0) return declined("no-signal");

  const instancesByDefinition = groupInstances(graph);
  const scored: Array<{ match: ComponentMatch; score: number; evidence: Evidence[] }> = [];

  for (const node of graph.nodes) {
    if (node.kind !== "component") continue;
    const matchedText: string[] = [];
    const evidence: Evidence[] = [];
    for (const needle of needles) {
      const hit = node.renderedText.find((entry) =>
        textMatches(normalizeText(entry.text), needle),
      );
      if (hit !== undefined) {
        matchedText.push(hit.text.toLowerCase());
        const provenance =
          hit.source === "i18n"
            ? ` (i18n key ${hit.key ?? "?"}, locale ${hit.locale ?? "?"})`
            : hit.branch !== undefined
              ? ` (renders only when ${hit.branch})`
              : "";
        evidence.push({
          kind: "text-match",
          detail: `"${needle}" matched rendered text "${hit.text}"${provenance}`,
          loc: node.loc,
        });
      }
    }
    if (matchedText.length > 0) {
      scored.push({
        match: {
          component: node,
          instances: instancesByDefinition.get(node.id) ?? [],
          matchedText,
        },
        score: matchedText.length / needles.length,
        evidence,
      });
    }
  }

  if (scored.length === 0) return declined("no-signal");

  scored.sort(
    (a, b) => b.score - a.score || a.match.component.name.localeCompare(b.match.component.name),
  );
  const candidates: Candidate<ComponentMatch>[] = scored.map((s) => ({
    value: s.match,
    confidence: confidenceFromScore(s.score),
    evidence: s.evidence,
  }));

  const top = scored[0];
  const tied = top === undefined ? [] : scored.filter((s) => s.score === top.score);
  if (tied.length > 1) {
    const names = tied.map((s) => s.match.component.name).join(", ");
    return ambiguous(
      candidates,
      `Multiple components match equally well (${names}). ` +
        `Which file or page is the screenshot from, or what other text is visible?`,
    );
  }
  return ok(candidates);
}

export interface InstanceAttribution {
  instance: InstanceNode;
  /** Data flowing INTO this call site through props (provides-data edges). */
  dataSources: DataSourceNode[];
}

export interface Lineage {
  component: ComponentNode;
  /** The instance the trace started from, when an instance id was given. */
  instance: InstanceNode | null;
  dataSources: DataSourceNode[];
  state: StateNode[];
  events: EventNode[];
  /** Hooks, instances, and child components on the path, in discovery order. */
  via: LineageNode[];
  /**
   * Definition-level traces only: what each call site receives, kept SEPARATE
   * per instance — never merged, because merging is exactly the C1 poison
   * (the users-page table would appear to consume the invoices API).
   */
  perInstance?: InstanceAttribution[];
}

/**
 * Walk outgoing edges from a component or instance (transitively, through
 * hooks, instances, and child components) and collect every data source,
 * state node, and event that feeds it.
 */
export function traceLineage(graph: LineageGraph, id: string): QueryResult<Lineage> {
  const byId = new Map<string, LineageNode>(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, LineageEdge[]>();
  for (const e of graph.edges) {
    const list = out.get(e.from);
    if (list) list.push(e);
    else out.set(e.from, [e]);
  }

  const start = byId.get(id);
  if (start === undefined) return declined("not-found");

  let component: ComponentNode;
  let instance: InstanceNode | null = null;
  if (start.kind === "component") {
    component = start;
  } else if (start.kind === "instance") {
    const definition = byId.get(start.definitionId);
    if (definition === undefined || definition.kind !== "component") return declined("not-found");
    instance = start;
    component = definition;
  } else {
    return declined("invalid-target");
  }

  const lineage: Lineage = {
    component,
    instance,
    dataSources: [],
    state: [],
    events: [],
    via: [],
  };
  const startId = instance !== null ? instance.id : component.id;
  const seen = new Set<string>([startId, component.id]);
  const queue: string[] = [startId, component.id];
  let edgesWalked = 0;

  // Data flowing INTO the traced instance through props (provides-data points
  // data-source → instance, so it is invisible to an outgoing-edge walk).
  if (instance !== null) {
    for (const edge of graph.edges) {
      if (edge.kind !== "provides-data" || edge.to !== instance.id) continue;
      edgesWalked += 1;
      const source = byId.get(edge.from);
      if (source !== undefined && source.kind === "data-source" && !seen.has(source.id)) {
        seen.add(source.id);
        lineage.dataSources.push(source);
      }
    }
  }

  // Definition-level trace: report what each call site receives, per instance.
  if (instance === null) {
    const perInstance: InstanceAttribution[] = [];
    for (const node of graph.nodes) {
      if (node.kind !== "instance" || node.definitionId !== component.id) continue;
      const incoming = graph.edges.flatMap((edge) => {
        if (edge.kind !== "provides-data" || edge.to !== node.id) return [];
        const source = byId.get(edge.from);
        return source !== undefined && source.kind === "data-source" ? [source] : [];
      });
      perInstance.push({ instance: node, dataSources: incoming });
    }
    if (perInstance.length > 0) lineage.perInstance = perInstance;
  }

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (currentId === undefined) break;
    for (const edge of out.get(currentId) ?? []) {
      edgesWalked += 1;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const node = byId.get(edge.to);
      if (node === undefined) continue;
      switch (node.kind) {
        case "data-source":
          lineage.dataSources.push(node);
          break;
        case "state":
          lineage.state.push(node);
          break;
        case "event":
          lineage.events.push(node);
          queue.push(node.id); // events can trigger fetches/state writes
          break;
        case "hook":
        case "component":
        case "instance":
          lineage.via.push(node);
          queue.push(node.id);
          break;
      }
    }
  }

  const evidence: Evidence[] = [
    {
      kind: "edge-chain",
      detail:
        `Walked ${edgesWalked} edges from ${startId}: ` +
        `${lineage.dataSources.length} data sources, ${lineage.state.length} state nodes, ` +
        `${lineage.events.length} events via ${lineage.via.length} intermediate nodes`,
      loc: component.loc,
    },
  ];
  // Static edge traversal is reliable; per-instance attribution sharpens in Phase 2.2.
  return ok([{ value: lineage, confidence: confidenceFromScore(0.9), evidence }]);
}

function groupInstances(graph: LineageGraph): Map<string, InstanceNode[]> {
  const byDefinition = new Map<string, InstanceNode[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "instance") continue;
    const list = byDefinition.get(node.definitionId);
    if (list) list.push(node);
    else byDefinition.set(node.definitionId, [node]);
  }
  return byDefinition;
}
