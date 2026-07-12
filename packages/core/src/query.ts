/**
 * Query helpers over a LineageGraph — the primitives an agent composes to go
 * from "text seen in a screenshot" to "component" to "everything that feeds it".
 */

import type {
  ComponentNode,
  DataSourceNode,
  EventNode,
  LineageEdge,
  LineageGraph,
  LineageNode,
  StateNode,
} from "./types.js";

export interface ComponentMatch {
  component: ComponentNode;
  /** How many of the query terms matched this component's rendered text. */
  score: number;
  matchedText: string[];
}

/**
 * Rank components by overlap between `terms` (words/phrases read off a
 * screenshot) and each component's statically rendered text.
 */
export function matchComponentsByText(graph: LineageGraph, terms: string[]): ComponentMatch[] {
  const needles = terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1);
  const matches: ComponentMatch[] = [];

  for (const node of graph.nodes) {
    if (node.kind !== "component") continue;
    const haystack = node.renderedText.map((t) => t.toLowerCase());
    const matchedText: string[] = [];
    for (const needle of needles) {
      const hit = haystack.find((h) => h.includes(needle) || needle.includes(h));
      if (hit !== undefined) matchedText.push(hit);
    }
    if (matchedText.length > 0) {
      matches.push({ component: node, score: matchedText.length, matchedText });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

export interface Lineage {
  component: ComponentNode;
  dataSources: DataSourceNode[];
  state: StateNode[];
  events: EventNode[];
  /** Hooks and child components on the path, in discovery order. */
  via: LineageNode[];
}

/**
 * Walk outgoing edges from a component (transitively, through hooks and child
 * components) and collect every data source, state node, and event that feeds it.
 */
export function traceLineage(graph: LineageGraph, componentId: string): Lineage | null {
  const byId = new Map<string, LineageNode>(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, LineageEdge[]>();
  for (const e of graph.edges) {
    const list = out.get(e.from);
    if (list) list.push(e);
    else out.set(e.from, [e]);
  }

  const start = byId.get(componentId);
  if (start === undefined || start.kind !== "component") return null;

  const lineage: Lineage = { component: start, dataSources: [], state: [], events: [], via: [] };
  const seen = new Set<string>([componentId]);
  const queue: string[] = [componentId];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    for (const edge of out.get(id) ?? []) {
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
          lineage.via.push(node);
          queue.push(node.id);
          break;
      }
    }
  }

  return lineage;
}
