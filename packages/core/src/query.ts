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
import { fuzzyTokenMatch, normalizeText, textMatches, tokenize } from "./text.js";
import type {
  ComponentNode,
  DataSourceNode,
  EdgeCondition,
  EventNode,
  Evidence,
  InstanceNode,
  LineageEdge,
  LineageGraph,
  LineageNode,
  RenderedText,
  RouteNode,
  SourceLocation,
  StateNode,
} from "./types.js";

export interface ComponentMatch {
  component: ComponentNode;
  /** Call sites of this component, when known. */
  instances: InstanceNode[];
  matchedText: string[];
}

/**
 * Rank components by how well `terms` (words/phrases read off a screenshot or
 * ticket) match each component's statically rendered text (TRACKER step 4.1).
 *
 * Three ideas beyond raw overlap:
 * - **Rarity weighting** — a term's weight is its inverse document frequency
 *   across the graph, so "Save" (everywhere) counts for almost nothing while
 *   "Reconciliation" (one component) dominates.
 * - **Fuzzy tokens** — long tokens match within a small edit distance, so OCR
 *   slips ("Reconcilliation") still land (failure mode A10).
 * - **Combination bonus** — several distinct terms co-occurring in one
 *   component outrank the same terms scattered across many.
 *
 * Returns `ambiguous` when the leaders tie on rarity-weighted score (a lone
 * generic term is honestly ambiguous), `declined("no-signal")` on no match.
 */
export function matchComponentsByText(
  graph: LineageGraph,
  terms: string[],
): QueryResult<ComponentMatch> {
  const queryTerms = terms.map((t) => normalizeText(t)).filter((t) => t.length > 1);
  if (queryTerms.length === 0) return declined("no-signal");

  const instancesByDefinition = groupInstances(graph);
  const components = graph.nodes.filter((n): n is ComponentNode => n.kind === "component");

  // Document frequency per token, for rarity (IDF) weighting.
  const documentFrequency = new Map<string, number>();
  for (const component of components) {
    const tokens = new Set<string>();
    for (const entry of component.renderedText) for (const t of tokenize(entry.text)) tokens.add(t);
    for (const t of tokens) documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1);
  }
  const total = components.length || 1;
  const idf = (token: string): number => {
    let df = documentFrequency.get(token);
    if (df === undefined) {
      // Not an exact token — charge the rarity of the closest fuzzy match.
      for (const [candidate, count] of documentFrequency) {
        if (fuzzyTokenMatch(candidate, token)) df = Math.max(df ?? 0, count);
      }
    }
    return Math.log((total + 1) / ((df ?? 0.5) + 0.5));
  };

  // The rendered-text entry a phrase term matches: directly (exact/substring/
  // wildcard) or as an ordered, fuzzy, contiguous run of its tokens — order
  // matters, so "Order deleted" does not match "Delete order", but OCR slips
  // in any single token still land. Returns the entry (for provenance) or null.
  const matchingEntry = (term: string, component: ComponentNode): RenderedText | null => {
    const termTokens = tokenize(term);
    if (termTokens.length === 0) return null;
    for (const entry of component.renderedText) {
      if (textMatches(normalizeText(entry.text), term)) return entry;
      if (containsPhrase(tokenize(entry.text), termTokens)) return entry;
    }
    return null;
  };

  const termWeight = (term: string): number =>
    tokenize(term).reduce((sum, t) => sum + idf(t), 0);

  const scored: Array<{
    match: ComponentMatch;
    score: number;
    coverage: number;
    evidence: Evidence[];
  }> = [];

  for (const component of components) {
    const matched: string[] = [];
    const evidence: Evidence[] = [];
    let weight = 0;
    for (const term of queryTerms) {
      const hit = matchingEntry(term, component);
      if (hit === null) continue;
      const w = termWeight(term);
      matched.push(term);
      weight += w;
      const provenance =
        hit.source === "i18n"
          ? ` (i18n key ${hit.key ?? "?"}, locale ${hit.locale ?? "?"})`
          : hit.branch !== undefined
            ? ` (renders only when ${hit.branch})`
            : "";
      evidence.push({
        kind: "text-match",
        detail: `"${term}" matched rendered text "${hit.text}"${provenance} — rarity weight ${w.toFixed(2)}`,
        loc: component.loc,
      });
    }
    if (matched.length === 0) continue;
    const combination = 1 + 0.5 * (matched.length - 1);
    scored.push({
      match: {
        component,
        instances: instancesByDefinition.get(component.id) ?? [],
        matchedText: matched,
      },
      score: weight * combination,
      coverage: matched.length / queryTerms.length,
      evidence,
    });
  }

  if (scored.length === 0) return declined("no-signal");

  scored.sort(
    (a, b) => b.score - a.score || a.match.component.name.localeCompare(b.match.component.name),
  );
  const candidates: Candidate<ComponentMatch>[] = scored.map((s) => ({
    value: s.match,
    confidence: confidenceFromScore(s.coverage),
    evidence: s.evidence,
  }));

  const top = scored[0];
  const tied =
    top === undefined ? [] : scored.filter((s) => Math.abs(s.score - top.score) < 1e-9);
  if (tied.length > 1) {
    const names = tied.map((s) => s.match.component.name).join(", ");
    return ambiguous(
      candidates,
      `Several components match equally well (${names}). ` +
        `Which page is the screenshot from, or what other distinctive text is visible?`,
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
          // Temporal decoupling (C6): the API that POPULATED this state may
          // have been called by a different component on a different page.
          // writes-state edges point data-source → state; follow them back.
          for (const writer of graph.edges) {
            if (writer.kind !== "writes-state" || writer.to !== node.id) continue;
            edgesWalked += 1;
            const source = byId.get(writer.from);
            if (source !== undefined && source.kind === "data-source" && !seen.has(source.id)) {
              seen.add(source.id);
              lineage.dataSources.push(source);
            }
          }
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

export type JourneyStepKind = "page" | "event" | "navigate" | "fetch" | "state-write";

/** One node on a user-journey path, with the condition (if any) that gated it. */
export interface JourneyStep {
  kind: JourneyStepKind;
  nodeId: string;
  /** Route path (page/navigate), event name, endpoint (fetch), or state name. */
  label: string;
  loc?: SourceLocation;
  /** Flag/role/branch guarding the edge into this step (populated by step 3.5). */
  condition?: EdgeCondition;
}

/** How a journey path ended: a leaf effect, a revisited page, or the depth cap. */
export type JourneyEnd = "terminal" | "cycle" | "depth-limit";

export interface JourneyPath {
  steps: JourneyStep[];
  end: JourneyEnd;
}

export interface JourneyOptions {
  /** Maximum number of page (navigation) levels a path may span. Default 3. */
  depth?: number;
  /** Total path cap; when hit, the result is flagged truncated. Default 256. */
  maxPaths?: number;
}

/**
 * Enumerate the user-journey paths reachable from a page or component
 * (TRACKER step 3.3, failure modes B5/B6).
 *
 * A journey alternates page → event → effect: on each screen the user can fire
 * an event (a click, submit…), whose action effects (step 3.2) either navigate
 * to another route — continuing the journey on the next page — or terminate the
 * path at a fetch or a state write. Paths are expanded at query time; a per-path
 * visited-set of pages means a node may recur across paths but never loops
 * within one (the list ↔ detail cycle yields a finite path that ends "cycle").
 *
 * `start` is a route path ("/users/:id"), an instance id, or a component
 * name/id. Returns one candidate whose value is every path found.
 */
export function journeys(
  graph: LineageGraph,
  start: string,
  options: JourneyOptions = {},
): QueryResult<JourneyPath[]> {
  const depth = options.depth ?? 3;
  const maxPaths = options.maxPaths ?? 256;
  const byId = new Map<string, LineageNode>(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, LineageEdge[]>();
  const handlesConditionByEvent = new Map<string, EdgeCondition>();
  for (const e of graph.edges) {
    const list = out.get(e.from);
    if (list) list.push(e);
    else out.set(e.from, [e]);
    if (e.kind === "handles" && e.condition !== undefined) handlesConditionByEvent.set(e.to, e.condition);
  }
  const outEdges = (id: string): LineageEdge[] => out.get(id) ?? [];

  // Resolve the entry point to a page component + the label to show for it.
  let startComponentId: string;
  let startLabel: string;
  const route = graph.nodes.find((n): n is RouteNode => n.kind === "route" && n.path === start);
  if (route !== undefined) {
    const pageEdge = outEdges(route.id).find((e) => e.kind === "routes-to");
    if (pageEdge === undefined) return declined("invalid-target");
    startComponentId = pageEdge.to;
    startLabel = route.path;
  } else {
    const node = byId.get(start) ?? graph.nodes.find((n) => n.kind === "component" && n.name === start);
    if (node === undefined) return declined("not-found");
    if (node.kind === "instance") {
      startComponentId = node.definitionId;
      startLabel = byId.get(node.definitionId)?.name ?? start;
    } else if (node.kind === "component") {
      startComponentId = node.id;
      startLabel = node.name;
    } else {
      return declined("invalid-target");
    }
  }
  if (!byId.has(startComponentId)) return declined("not-found");

  // The page a route lands on, indexed for the navigate → route → page hop.
  const pageOfRoute = (routeId: string): { componentId: string; label: string } | null => {
    const edge = outEdges(routeId).find((e) => e.kind === "routes-to");
    const routeNode = byId.get(routeId);
    if (edge === undefined || routeNode === undefined || routeNode.kind !== "route") return null;
    return { componentId: edge.to, label: routeNode.path };
  };

  // All events on a screen: those the page component handles plus those of any
  // component in its render subtree (a button living in a child component is
  // still on this page). Memoized; the subtree walk is cycle-guarded.
  const eventsMemo = new Map<string, string[]>();
  const screenEvents = (componentId: string): string[] => {
    const cached = eventsMemo.get(componentId);
    if (cached !== undefined) return cached;
    const subtree = new Set<string>([componentId]);
    const stack = [componentId];
    while (stack.length > 0) {
      const cid = stack.pop() as string;
      for (const edge of outEdges(cid)) {
        if (edge.kind !== "renders") continue;
        const inst = byId.get(edge.to);
        if (inst === undefined || inst.kind !== "instance") continue;
        if (!subtree.has(inst.definitionId) && byId.get(inst.definitionId)?.kind === "component") {
          subtree.add(inst.definitionId);
          stack.push(inst.definitionId);
        }
      }
    }
    const events: string[] = [];
    for (const cid of subtree) {
      for (const edge of outEdges(cid)) {
        if (edge.kind === "handles" && byId.get(edge.to)?.kind === "event") events.push(edge.to);
      }
    }
    eventsMemo.set(componentId, events);
    return events;
  };

  const paths: JourneyPath[] = [];
  let truncated = false;
  const pageStep = (componentId: string, label: string): JourneyStep => {
    const node = byId.get(componentId);
    return { kind: "page", nodeId: componentId, label, ...(node ? { loc: node.loc } : {}) };
  };

  // Depth-first expansion. `visitedPages` is copied down each branch so a page
  // may appear in sibling paths but a single path never revisits one.
  const expand = (
    componentId: string,
    label: string,
    prefix: JourneyStep[],
    visitedPages: Set<string>,
  ): void => {
    if (paths.length >= maxPaths) {
      truncated = true;
      return;
    }
    const pagePath = [...prefix, pageStep(componentId, label)];
    if (visitedPages.has(componentId)) {
      paths.push({ steps: pagePath, end: "cycle" });
      return;
    }
    if (visitedPages.size + 1 >= depth) {
      // One more page would exceed the depth budget — stop here.
      paths.push({ steps: pagePath, end: "depth-limit" });
      truncated = true;
      return;
    }
    const nextVisited = new Set(visitedPages).add(componentId);

    let branched = false;
    for (const eventId of screenEvents(componentId)) {
      const event = byId.get(eventId);
      if (event === undefined || event.kind !== "event") continue;
      // A flag/role guard on the handles edge (3.5) gates the whole step; an
      // effect-edge condition (rarer) refines the specific effect.
      const gate = handlesConditionByEvent.get(eventId);
      for (const effect of outEdges(eventId)) {
        const stepCondition = effect.condition ?? gate;
        const eventStep: JourneyStep = {
          kind: "event",
          nodeId: eventId,
          label: event.event,
          loc: event.loc,
          ...(stepCondition ? { condition: stepCondition } : {}),
        };
        if (effect.kind === "navigates-to") {
          const page = pageOfRoute(effect.to);
          if (page === null) continue;
          branched = true;
          const navStep: JourneyStep = {
            kind: "navigate",
            nodeId: effect.to,
            label: byId.get(effect.to)?.name ?? effect.to,
            ...(byId.get(effect.to) ? { loc: byId.get(effect.to)!.loc } : {}),
            ...(stepCondition ? { condition: stepCondition } : {}),
          };
          expand(page.componentId, page.label, [...pagePath, eventStep, navStep], nextVisited);
        } else if (effect.kind === "triggers" || effect.kind === "writes-state") {
          const target = byId.get(effect.to);
          if (target === undefined) continue;
          branched = true;
          const leaf: JourneyStep =
            target.kind === "data-source"
              ? { kind: "fetch", nodeId: target.id, label: target.endpoint, loc: target.loc }
              : { kind: "state-write", nodeId: target.id, label: target.name, loc: target.loc };
          if (paths.length >= maxPaths) {
            truncated = true;
            return;
          }
          paths.push({ steps: [...pagePath, eventStep, leaf], end: "terminal" });
        }
      }
    }
    // A screen with no expandable events is itself a terminal path.
    if (!branched) paths.push({ steps: pagePath, end: "terminal" });
  };

  expand(startComponentId, startLabel, [], new Set());

  const evidence: Evidence[] = [
    {
      kind: "edge-chain",
      detail:
        `Expanded ${paths.length} journey path(s) from ${startLabel} to depth ${depth}` +
        `${truncated ? " (truncated)" : ""}`,
      loc: byId.get(startComponentId)?.loc,
    },
  ];
  return ok([{ value: paths, confidence: confidenceFromScore(0.9), evidence }]);
}

/** True when `phrase` tokens appear as a contiguous, in-order, fuzzy run in `haystack`. */
function containsPhrase(haystack: string[], phrase: string[]): boolean {
  if (phrase.length === 0 || phrase.length > haystack.length) return false;
  for (let start = 0; start + phrase.length <= haystack.length; start += 1) {
    let ok = true;
    for (let k = 0; k < phrase.length; k += 1) {
      const h = haystack[start + k];
      const p = phrase[k];
      if (h === undefined || p === undefined || !fuzzyTokenMatch(h, p)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
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
