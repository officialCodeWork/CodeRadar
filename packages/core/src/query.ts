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
  EdgeKind,
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
  StructuralSignature,
  StructureDescriptor,
} from "./types.js";

export interface ComponentMatch {
  component: ComponentNode;
  /** Call sites of this component, when known. */
  instances: InstanceNode[];
  matchedText: string[];
  /**
   * Ancestor components that also cover the matched terms but are less specific
   * than `component` (TRACKER step 4.3). Present when the match resolved to the
   * deepest node in a Page > Section > Card nesting — the ancestors are context,
   * not competing candidates.
   */
  context?: ComponentNode[];
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
/**
 * A recorded correction (Phase 4.6, failure mode G4): a human confirmed that a
 * set of terms means a specific component. Fed back as first-class evidence so
 * the next identical query resolves the same way.
 */
export interface Correction {
  terms: string[];
  /** Component definition name the terms were confirmed to mean. */
  component: string;
}

/** A screenshot/ticket query: visible text, a structure descriptor, or both. */
export interface MatchQuery {
  terms?: string[];
  structure?: StructureDescriptor;
  /**
   * Per-term weight multipliers (Phase 4.4): terms a vision adapter found
   * inside an annotation (a circle/arrow the user drew) are boosted, e.g. 3×,
   * so the emphasized element outranks incidental text.
   */
  boosts?: Record<string, number>;
  /**
   * Business-vocabulary glossary (Phase 4.6, failure mode E2), phrase →
   * component name/id — "invoice widget" → BillingSummaryCard. An alias hit is
   * high-weight evidence, so a term that appears nowhere in the code still
   * resolves.
   */
  aliases?: Record<string, string>;
  /** Recorded corrections (Phase 4.6) — the highest-weight signal of all. */
  corrections?: Correction[];
}

/** Weight of a full structural match relative to a rare matched term. */
const STRUCTURE_WEIGHT = 3;
/**
 * Multiplier when a matched term also names the component itself — its name,
 * props, or file (6F.7). "calendar" matching CalendarPanel outranks the same
 * text rendered incidentally elsewhere; global character rarity alone can't
 * tell them apart.
 */
const IDENTIFIER_AFFINITY = 1.5;
/** A glossary alias hit outweighs any text/structure evidence (Phase 4.6). */
const ALIAS_WEIGHT = 10;
/** A recorded human correction is the strongest signal of all. */
const CORRECTION_WEIGHT = 25;

/** Back-compat text-only entry point. */
export function matchComponentsByText(
  graph: LineageGraph,
  terms: string[],
): QueryResult<ComponentMatch> {
  return matchComponents(graph, { terms });
}

/**
 * Match components by rendered text (rarity-weighted, fuzzy — step 4.1) and/or
 * structural shape (step 4.2). Text and structure scores combine into one
 * ranking, so a dashboard with no static text still matches on "a table with
 * four columns and a card grid".
 */
export function matchComponents(
  graph: LineageGraph,
  query: MatchQuery,
): QueryResult<ComponentMatch> {
  const queryTerms = (query.terms ?? []).map((t) => normalizeText(t)).filter((t) => t.length > 1);
  const descriptor = query.structure;
  if (queryTerms.length === 0 && descriptor === undefined) return declined("no-signal");

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

  // Boost keys are normalized so they match the normalized query terms below.
  const boosts = new Map(
    Object.entries(query.boosts ?? {}).map(([term, weight]) => [normalizeText(term), weight]),
  );
  const termWeight = (term: string): number => {
    const base = tokenize(term).reduce((sum, t) => sum + idf(t), 0);
    return base * (boosts.get(term) ?? 1);
  };

  // A component's own identifiers — name, props, file basename — split on
  // camelCase and separators. Terms that also NAME the component score higher
  // than the same text rendered incidentally elsewhere (6F.7).
  const identifierMemo = new Map<string, Set<string>>();
  const identifierTokens = (component: ComponentNode): Set<string> => {
    const cached = identifierMemo.get(component.id);
    if (cached) return cached;
    const camelSplit = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    const basename = component.loc.file.split("/").pop()?.replace(/\.[a-z]+$/i, "") ?? "";
    const out = new Set(
      tokenize(
        [component.name, ...component.props, basename].map(camelSplit).join(" "),
      ),
    );
    identifierMemo.set(component.id, out);
    return out;
  };
  const namesComponent = (term: string, component: ComponentNode): boolean => {
    const ids = identifierTokens(component);
    return tokenize(term).some((t) => ids.has(t) || [...ids].some((id) => fuzzyTokenMatch(id, t)));
  };

  // Glossary aliases + recorded corrections (Phase 4.6). Both are authority
  // signals — a phrase resolves even when it appears nowhere in the code.
  const aliasEntries = Object.entries(query.aliases ?? {});
  const corrections = query.corrections ?? [];
  const containsTerm = (needle: string): boolean =>
    needle.length > 0 && queryTerms.some((t) => t === needle || t.includes(needle) || needle.includes(t));

  // Render tree (definition level): A renders B when A has a `renders` edge to
  // an instance whose `instance-of` points at B. Used to collapse nested
  // matches to the most specific one (step 4.3).
  const byId = new Map(components.map((c) => [c.id, c]));
  const instanceDef = new Map<string, string>();
  for (const e of graph.edges) if (e.kind === "instance-of") instanceDef.set(e.from, e.to);
  const childDefs = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind !== "renders") continue;
    const childDef = instanceDef.get(e.to);
    if (childDef === undefined || !byId.has(e.from) || !byId.has(childDef)) continue;
    (childDefs.get(e.from) ?? childDefs.set(e.from, new Set()).get(e.from)!).add(childDef);
  }
  const descendantsMemo = new Map<string, Set<string>>();
  const descendants = (id: string): Set<string> => {
    const cached = descendantsMemo.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    descendantsMemo.set(id, out); // set first to break cycles
    for (const child of childDefs.get(id) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      for (const d of descendants(child)) out.add(d);
    }
    return out;
  };

  interface Scored {
    match: ComponentMatch;
    score: number;
    coverage: number;
    covered: Set<string>;
    evidence: Evidence[];
  }
  const scored: Scored[] = [];

  for (const component of components) {
    const subtree = [component.id, ...descendants(component.id)];
    const matched: string[] = [];
    const covered = new Set<string>();
    const evidence: Evidence[] = [];
    let weight = 0;
    for (const term of queryTerms) {
      let hit: RenderedText | null = null;
      let where = component;
      for (const id of subtree) {
        const node = byId.get(id);
        if (node === undefined) continue;
        const found = matchingEntry(term, node);
        if (found !== null) {
          hit = found;
          where = node;
          break;
        }
      }
      if (hit === null) continue;
      const affine = namesComponent(term, component);
      const w = termWeight(term) * (affine ? IDENTIFIER_AFFINITY : 1);
      covered.add(term);
      if (where.id === component.id) matched.push(term);
      weight += w;
      const provenance =
        hit.source === "i18n"
          ? ` (i18n key ${hit.key ?? "?"}, locale ${hit.locale ?? "?"})`
          : hit.branch !== undefined
            ? ` (renders only when ${hit.branch})`
            : where.id !== component.id
              ? ` (in descendant ${where.name})`
              : "";
      evidence.push({
        kind: "text-match",
        detail:
          `"${term}" matched rendered text "${hit.text}"${provenance} — rarity weight ${w.toFixed(2)}` +
          (affine ? " (also names the component)" : ""),
        loc: where.loc,
      });
    }
    const textScore = covered.size > 0 ? weight * (1 + 0.5 * (covered.size - 1)) : 0;

    const structureFit = descriptor !== undefined ? structureScore(component.structure, descriptor) : 0;
    if (structureFit > 0) {
      evidence.push({
        kind: "structure",
        detail: `structural shape matched the descriptor (fit ${structureFit.toFixed(2)})`,
        loc: component.loc,
      });
    }

    // Authority: glossary aliases and recorded corrections that name this
    // component, when the query actually contains their phrase/terms.
    let authority = 0;
    const normName = normalizeText(component.name);
    for (const [phrase, target] of aliasEntries) {
      if (normalizeText(target) !== normName && target !== component.id) continue;
      const normPhrase = normalizeText(phrase);
      if (!containsTerm(normPhrase)) continue;
      authority += ALIAS_WEIGHT;
      covered.add(normPhrase);
      if (!matched.includes(normPhrase)) matched.push(normPhrase);
      evidence.push({
        kind: "alias",
        detail: `glossary alias "${phrase}" → ${component.name}`,
        loc: component.loc,
      });
    }
    for (const correction of corrections) {
      if (normalizeText(correction.component) !== normName) continue;
      const cterms = correction.terms.map(normalizeText).filter((t) => t.length > 0);
      if (cterms.length === 0 || !cterms.every(containsTerm)) continue;
      authority += CORRECTION_WEIGHT;
      for (const ct of cterms) covered.add(ct);
      evidence.push({
        kind: "correction",
        detail: `recorded correction [${correction.terms.join(", ")}] → ${component.name}`,
        loc: component.loc,
      });
    }

    if (covered.size === 0 && structureFit === 0 && authority === 0) continue;
    const coverage =
      authority > 0 ? 1 : queryTerms.length > 0 ? covered.size / queryTerms.length : structureFit;
    scored.push({
      match: {
        component,
        instances: instancesByDefinition.get(component.id) ?? [],
        matchedText: matched.length > 0 ? matched : [...covered],
      },
      score: textScore + structureFit * STRUCTURE_WEIGHT + authority,
      coverage: Math.max(coverage, structureFit),
      covered,
      evidence,
    });
  }

  if (scored.length === 0) return declined("no-signal");

  const sameCovered = (a: Set<string>, b: Set<string>): boolean =>
    a.size === b.size && [...a].every((t) => b.has(t));

  // Most-specific-subtree collapse: when an ancestor and a descendant cover the
  // same term set (equal score), keep the deepest and fold ancestors into its
  // `context`, so a Card that a Page renders wins with the Page as context.
  const subtreeSize = (s: Scored): number => descendants(s.match.component.id).size;
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      subtreeSize(a) - subtreeSize(b) ||
      a.match.component.name.localeCompare(b.match.component.name),
  );
  const collapsed = new Set<string>();
  for (const s of scored) {
    if (collapsed.has(s.match.component.id)) continue;
    const context: ComponentNode[] = [];
    for (const other of scored) {
      if (other === s || collapsed.has(other.match.component.id)) continue;
      const otherOwnsS = descendants(other.match.component.id).has(s.match.component.id);
      if (otherOwnsS && sameCovered(other.covered, s.covered)) {
        context.push(other.match.component);
        collapsed.add(other.match.component.id);
      }
    }
    if (context.length > 0) s.match.context = context;
  }
  const winners = scored.filter((s) => !collapsed.has(s.match.component.id));

  const candidates: Candidate<ComponentMatch>[] = winners.map((s) => {
    const conf = confidenceFromScore(s.coverage);
    // Structure-only matches (no text, alias, or correction evidence — A3/A12)
    // are an honest fallback, never "high": shape alone can't be certain.
    const confidence =
      s.covered.size === 0 && conf.level === "high"
        ? { score: conf.score, level: "medium" as const }
        : conf;
    return { value: s.match, confidence, evidence: s.evidence, score: s.score };
  });

  const top = winners[0];
  const tied =
    top === undefined ? [] : winners.filter((s) => Math.abs(s.score - top.score) < 1e-9);
  if (tied.length > 1) {
    // A concrete question built from the DIFFERENCES between the leaders: each
    // gets the first text unique to it, so the caller can answer with a term
    // that resolves the tie (D6/G1).
    const options = tied.slice(0, 3).map((s) => {
      const elsewhere = new Set(
        tied
          .filter((o) => o !== s)
          .flatMap((o) => o.match.component.renderedText.map((r) => normalizeText(r.text))),
      );
      const distinctive = s.match.component.renderedText.find(
        (r) => normalizeText(r.text).length > 0 && !elsewhere.has(normalizeText(r.text)),
      );
      return distinctive !== undefined
        ? `${s.match.component.name} (shows "${distinctive.text}")`
        : s.match.component.name;
    });
    return ambiguous(
      candidates,
      `Which one — ${options.join(", or ")}? Add a term unique to the one you mean.`,
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

export type JourneyStepKind = "page" | "event" | "navigate" | "fetch" | "state-write" | "exit";

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
        } else if (
          effect.kind === "triggers" ||
          effect.kind === "writes-state" ||
          effect.kind === "exits-app"
        ) {
          const target = byId.get(effect.to);
          if (target === undefined) continue;
          branched = true;
          const leaf: JourneyStep =
            target.kind === "data-source"
              ? { kind: "fetch", nodeId: target.id, label: target.endpoint, loc: target.loc }
              : target.kind === "external"
                ? { kind: "exit", nodeId: target.id, label: target.host, loc: target.loc }
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

/**
 * Fraction (0–1) of a structure descriptor's specified expectations that a
 * component's signature satisfies. Counts and columns match with tolerance so
 * OCR/vision miscounts still land.
 */
function structureScore(sig: StructuralSignature, desc: StructureDescriptor): number {
  const checks: boolean[] = [];
  if (desc.table !== undefined) checks.push(desc.table === sig.table > 0);
  if (desc.form !== undefined) checks.push(desc.form === sig.form > 0);
  if (desc.list !== undefined) checks.push(desc.list === (sig.list > 0 || sig.repeated > 0));
  if (desc.columns !== undefined) checks.push(Math.abs(sig.columns - desc.columns) <= 1);
  if (desc.inputs !== undefined) checks.push(sig.input >= desc.inputs - 1);
  if (desc.buttons !== undefined) checks.push(sig.button >= desc.buttons - 1);
  if (desc.images !== undefined) checks.push(sig.image >= desc.images - 1);
  if (desc.cards !== undefined) checks.push(sig.repeated >= Math.max(1, desc.cards - 1));
  if (checks.length === 0) return 0;
  return checks.filter(Boolean).length / checks.length;
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

/** One node affected by changing the blast-radius target, with the hop that reaches it. */
export interface ImpactNode {
  node: LineageNode;
  /** The edge kind connecting this node to its (closer) dependency on the path. */
  relation: EdgeKind;
  /** Reverse-dependency hops from the target (1 = a direct dependent). */
  distance: number;
}

export interface BlastRadiusOptions {
  /** Maximum dependency hops to follow. Default Infinity (whole component). */
  depth?: number;
}

/**
 * For each edge, decide which endpoint is the *resource* and which *depends on*
 * it, so we can walk "who is affected if I change X" regardless of edge
 * direction. Journey edges (handles/triggers/navigates-to/exits-app/enters-at)
 * are behaviour, not data/render dependencies, so they don't propagate impact.
 */
function dependencyOf(edge: LineageEdge): { resource: string; dependent: string } | null {
  switch (edge.kind) {
    // consumer --edge--> resource: the `from` depends on the `to`.
    case "instance-of": // instance depends on its definition
    case "renders": // a parent's render depends on the child instance
    case "fetches-from": // a component/hook depends on the data source it calls
    case "reads-state": // a reader depends on the state slice
    case "uses-hook": // a component depends on the hook
    case "routes-to": // a route depends on the page it renders
      return { resource: edge.to, dependent: edge.from };
    // resource --edge--> consumer: the `to` depends on the `from`.
    case "provides-data": // a fed instance depends on the data source
    case "writes-state": // the written state depends on its writer
    case "covered-by": // a test depends on the component it renders
      return { resource: edge.from, dependent: edge.to };
    default:
      return null;
  }
}

/**
 * Blast radius (TRACKER step 5.3, failure mode F2): everything that *depends on*
 * a node, so a change to it can be reviewed for impact. A reverse-dependency BFS
 * — changing a component definition surfaces its instances and the pages that
 * render them; changing a data source surfaces every consumer, the instances it
 * feeds, and the state it writes (and their readers).
 *
 * `target` is a node id, a component name, a data-source endpoint, a state name,
 * or a route path. Returns one candidate whose value is the affected nodes,
 * ordered nearest-first.
 */
export function blastRadius(
  graph: LineageGraph,
  target: string,
  options: BlastRadiusOptions = {},
): QueryResult<ImpactNode[]> {
  const depth = options.depth ?? Number.POSITIVE_INFINITY;
  const byId = new Map<string, LineageNode>(graph.nodes.map((n) => [n.id, n]));
  const start =
    byId.get(target) ??
    graph.nodes.find((n) => n.kind === "component" && n.name === target) ??
    graph.nodes.find((n) => n.kind === "data-source" && n.endpoint === target) ??
    graph.nodes.find((n) => n.kind === "state" && n.name === target) ??
    graph.nodes.find((n) => n.kind === "route" && n.path === target);
  if (start === undefined) return declined("not-found");

  // resource id -> its direct dependents (and the edge that makes them depend).
  const dependents = new Map<string, { id: string; relation: EdgeKind }[]>();
  for (const edge of graph.edges) {
    const dep = dependencyOf(edge);
    if (dep === null) continue;
    const list = dependents.get(dep.resource);
    if (list) list.push({ id: dep.dependent, relation: edge.kind });
    else dependents.set(dep.resource, [{ id: dep.dependent, relation: edge.kind }]);
  }

  const seen = new Set<string>([start.id]);
  const queue: { id: string; distance: number }[] = [{ id: start.id, distance: 0 }];
  const impacts: ImpactNode[] = [];
  while (queue.length > 0) {
    const { id, distance } = queue.shift() as { id: string; distance: number };
    if (distance >= depth) continue;
    for (const { id: dependentId, relation } of dependents.get(id) ?? []) {
      if (seen.has(dependentId)) continue;
      seen.add(dependentId);
      const node = byId.get(dependentId);
      if (node === undefined) continue;
      impacts.push({ node, relation, distance: distance + 1 });
      queue.push({ id: dependentId, distance: distance + 1 });
    }
  }
  impacts.sort((a, b) => a.distance - b.distance);

  const evidence: Evidence[] = [
    {
      kind: "edge-chain",
      detail: `${impacts.length} node(s) depend on ${start.kind} ${labelOf(start)}`,
      loc: start.loc,
    },
  ];
  return ok([{ value: impacts, confidence: confidenceFromScore(1), evidence }]);
}

function labelOf(node: LineageNode): string {
  switch (node.kind) {
    case "component":
    case "hook":
    case "state":
      return node.name;
    case "event":
      return node.handler ?? node.event;
    case "data-source":
      return node.endpoint;
    case "route":
      return node.path;
    default:
      return node.id;
  }
}
