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

/**
 * Attribution of data for a single render site of a shared component.
 *
 * A component like `DataTable` often owns no data of its own — each parent that
 * renders it passes different data via props. Statically resolving prop dataflow
 * is out of scope for v0.1, so this uses the pragmatic approximation: the data
 * sources reachable from the rendering `parent` that are not intrinsic to the
 * shared component itself.
 */
export interface InstanceAttribution {
  /** The component whose JSX renders this instance of the shared component. */
  parent: ComponentNode;
  /** Data sources reachable from `parent` but not intrinsic to the shared component. */
  dataSources: DataSourceNode[];
}

export interface Lineage {
  component: ComponentNode;
  dataSources: DataSourceNode[];
  state: StateNode[];
  events: EventNode[];
  /** Hooks and child components on the path, in discovery order. */
  via: LineageNode[];
  /**
   * Per-render-site attribution, present only when the component is shared
   * (rendered by two or more parents). Distinguishes, e.g.,
   * `DataTable@UsersPage → /api/users` from `DataTable@InvoicesPage → /api/invoices`.
   */
  perInstance?: InstanceAttribution[];
}

/** The reachable feeders of a component, ignoring per-instance attribution. */
interface Reachable {
  dataSources: DataSourceNode[];
  state: StateNode[];
  events: EventNode[];
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

  const walk = (rootId: string): Reachable => {
    const reachable: Reachable = { dataSources: [], state: [], events: [], via: [] };
    const seen = new Set<string>([rootId]);
    const queue: string[] = [rootId];

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
            reachable.dataSources.push(node);
            break;
          case "state":
            reachable.state.push(node);
            break;
          case "event":
            reachable.events.push(node);
            queue.push(node.id); // events can trigger fetches/state writes
            break;
          case "hook":
          case "component":
            reachable.via.push(node);
            queue.push(node.id);
            break;
        }
      }
    }

    return reachable;
  };

  const reachable = walk(componentId);
  const lineage: Lineage = { component: start, ...reachable };

  // Parents that render this component. When there are two or more, the
  // component is shared and a single definition-level trace hides which data
  // reaches which render site — so attribute data per parent.
  const parents: ComponentNode[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "renders" || edge.to !== componentId) continue;
    const parent = byId.get(edge.from);
    if (parent !== undefined && parent.kind === "component") parents.push(parent);
  }

  if (parents.length >= 2) {
    const ownSourceIds = new Set(reachable.dataSources.map((d) => d.id));
    const perInstance = parents
      .map((parent) => ({
        parent,
        dataSources: walk(parent.id).dataSources.filter((d) => !ownSourceIds.has(d.id)),
      }))
      .sort((a, b) => a.parent.name.localeCompare(b.parent.name));
    lineage.perInstance = perInstance;
  }

  return lineage;
}
