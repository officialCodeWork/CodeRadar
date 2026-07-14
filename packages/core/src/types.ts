/**
 * The CodeRadar lineage graph — schema v2.
 *
 * Parsers (React/TS today; Python/Go later) emit this shape. Agents consume it.
 * The graph is plain JSON so any language can produce or query it.
 *
 * v2 changes (TRACKER step 0.1):
 * - InstanceNode: a component *as rendered at one call site*. Data attribution is
 *   per instance, never merged into the definition (failure mode C1).
 * - Evidence + Confidence: every query answer carries both (D2).
 * - EdgeCondition: flag/role/branch conditions on edges (B5, G5).
 */

/** Where a node lives in the codebase. */
export interface SourceLocation {
  /** Path relative to the scan root, POSIX separators. */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
  /** 1-based end line of the declaration. */
  endLine: number;
}

export type NodeKind =
  | "component"
  | "hook"
  | "instance"
  | "data-source"
  | "state"
  | "event";

export interface BaseNode {
  /** Stable id, unique within a graph. See nodeId()/instanceId(). */
  id: string;
  kind: NodeKind;
  name: string;
  loc: SourceLocation;
  /**
   * Degradation markers, e.g. "incomplete", "depth-limited",
   * "unresolved-prop-handler", "external-definition". Absent when clean.
   */
  flags?: string[];
}

/** One piece of text a component can render, with its provenance. */
export interface RenderedText {
  text: string;
  /**
   * Where the text comes from: JSX children, a string attribute
   * (placeholder/label/title/alt/aria-label), an i18n key resolved against
   * locale files, or portal-rendered content (toast("Order deleted") — the
   * text appears far from the caller in the DOM, but the CALLER is the
   * component a screenshot of it should match).
   */
  source: "jsx" | "attribute" | "i18n" | "portal";
  /** i18n entries only: the translation key, e.g. "team.title". */
  key?: string;
  /** i18n entries only: which locale this text belongs to. */
  locale?: string;
  /** Condition source text when the text renders only in a branch. */
  branch?: string;
  /**
   * True when the text came from a template literal with runtime parts —
   * unknown segments appear as `*` ("* items in cart") and match as wildcards.
   */
  template?: boolean;
}

/** A React component definition — the code, not a usage. */
export interface ComponentNode extends BaseNode {
  kind: "component";
  /** Named or default export, if exported. */
  exportName: string | null;
  /** Prop names destructured or accessed from the props object. */
  props: string[];
  /**
   * Static text visible in the rendered output — the primary signal for
   * matching a screenshot to a component. i18n keys are expanded to one
   * entry per locale, so a French screenshot matches the same component.
   */
  renderedText: RenderedText[];
  /** Names of components this component renders in its JSX (deduplicated). */
  rendersComponents: string[];
}

/**
 * A component as rendered at one specific call site.
 *
 * The same <DataTable> definition rendered on the Users page and the Invoices
 * page yields two instances — and per-instance data attribution (Phase 2.2)
 * is what lets each report a different API.
 */
export interface InstanceNode extends BaseNode {
  kind: "instance";
  /** Id of the ComponentNode this instantiates. */
  definitionId: string;
  /**
   * Enclosing instance in the render tree. Null until the cross-file instance
   * tree is built (Phase 2.1); the enclosing *definition* is available via the
   * incoming `renders` edge meanwhile.
   */
  parentInstanceId: string | null;
  /** Props with statically-known string values at this call site. */
  staticProps: Record<string, string>;
}

/** A custom hook — often the bridge between a component and its data. */
export interface HookNode extends BaseNode {
  kind: "hook";
  exportName: string | null;
}

export type DataSourceKind =
  | "fetch"
  | "axios"
  | "react-query"
  | "swr"
  | "graphql"
  | "websocket"
  | "unknown";

/** How much of an endpoint was statically resolvable. */
export type EndpointResolution =
  | "full" // every segment is a known string
  | "partial" // known shape with :param placeholders, e.g. "/api/users/:id"
  | "none"; // nothing statically known ("<dynamic>")

/** An external data origin: an HTTP endpoint, GraphQL operation, or socket. */
export interface DataSourceNode extends BaseNode {
  kind: "data-source";
  sourceKind: DataSourceKind;
  /** HTTP method when statically determinable. */
  method: string | null;
  /**
   * Canonical endpoint pattern: constants folded, template placeholders
   * normalized to :param form — e.g. "/api/users/:id". This is the value
   * attribution and cross-graph joins match on.
   */
  endpoint: string;
  /** The endpoint expression exactly as written in source. */
  raw: string;
  resolved: EndpointResolution;
  /**
   * react-query/SWR cache key as written in source (e.g. `["users"]`) —
   * the identity used for cache-sharing analysis (C7) alongside the endpoint.
   */
  queryKey?: string;
}

export type StateKind =
  | "useState"
  | "useReducer"
  | "context"
  | "redux"
  | "zustand"
  | "class-state"
  | "unknown";

/** Local or global state a component reads. */
export interface StateNode extends BaseNode {
  kind: "state";
  stateKind: StateKind;
}

/** A user or system event a component responds to. */
export interface EventNode extends BaseNode {
  kind: "event";
  /** e.g. "onClick", "onSubmit", "onChange" */
  event: string;
  /** Name of the handler function, if resolvable. */
  handler: string | null;
}

export type LineageNode =
  | ComponentNode
  | InstanceNode
  | HookNode
  | DataSourceNode
  | StateNode
  | EventNode;

export type EdgeKind =
  | "renders" // component|instance -> instance (definition-level until Phase 2.1)
  | "instance-of" // instance -> component definition
  | "uses-hook" // component -> hook, hook -> hook
  | "fetches-from" // component | hook -> data-source
  | "provides-data" // data-source -> instance (via a prop; Phase 2.2)
  | "reads-state" // component | hook -> state
  | "writes-state" // data-source | event -> state (Phase 2.4)
  | "handles" // component -> event
  | "triggers"; // event -> data-source | state (handler causes a fetch / state write)

/** A statically-detected condition guarding an edge (feature flag, role, branch). */
export interface EdgeCondition {
  kind: "flag" | "role" | "branch" | "response";
  /** Source text of the condition, e.g. `isEnabled("new-billing")`. */
  expression: string;
}

export interface LineageEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Prop name for provides-data edges; handler name for triggers. */
  via?: string;
  condition?: EdgeCondition;
}

/** How a query answer was derived. Every candidate carries at least one. */
export interface Evidence {
  kind: "text-match" | "structure" | "edge-chain" | "alias" | "correction";
  /** Human/agent-readable derivation, e.g. `"team members" matched renderedText`. */
  detail: string;
  loc?: SourceLocation;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface Confidence {
  level: ConfidenceLevel;
  /** 0–1. Level thresholds are provisional until Phase 4.5 calibration. */
  score: number;
}

/** Scan provenance — which code this graph describes. */
export interface GraphMeta {
  /** Commit SHA of the scanned tree; null when not a git repo. */
  commitSha: string | null;
  /** True when the working tree had uncommitted changes at scan time. */
  dirty: boolean;
}

export interface LineageGraph {
  /** Schema version for forward compatibility. */
  version: 2;
  /** Absolute path of the scanned root at generation time. */
  root: string;
  generatedAt: string;
  generator: string;
  meta?: GraphMeta;
  nodes: LineageNode[];
  edges: LineageEdge[];
}

/** Build the canonical node id for definition-level nodes. */
export function nodeId(kind: Exclude<NodeKind, "instance">, file: string, name: string): string {
  return `${kind}:${file}#${name}`;
}

/** Build the canonical instance id — one per JSX call site. */
export function instanceId(file: string, line: number, name: string): string {
  return `instance:${file}:${line}#${name}`;
}
