/**
 * The CodeRadar lineage graph.
 *
 * Parsers (React/TS today; Python/Go later) emit this shape. Agents consume it.
 * The graph is plain JSON so any language can produce or query it.
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

export type NodeKind = "component" | "hook" | "data-source" | "state" | "event";

export interface BaseNode {
  /** Stable id, unique within a graph: `${kind}:${file}#${name}` */
  id: string;
  kind: NodeKind;
  name: string;
  loc: SourceLocation;
}

/** A React component — the thing a screenshot shows. */
export interface ComponentNode extends BaseNode {
  kind: "component";
  /** Named or default export, if exported. */
  exportName: string | null;
  /** Prop names destructured or accessed from the props object. */
  props: string[];
  /**
   * Static text visible in the rendered output (JSX text, string literals in
   * attributes like placeholder/label/title/alt/aria-label). This is the
   * primary signal for matching a screenshot to a component.
   */
  renderedText: string[];
  /** Names of components this component renders in its JSX. */
  rendersComponents: string[];
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

/** An external data origin: an HTTP endpoint, GraphQL operation, or socket. */
export interface DataSourceNode extends BaseNode {
  kind: "data-source";
  sourceKind: DataSourceKind;
  /** HTTP method when statically determinable. */
  method: string | null;
  /**
   * The endpoint as written in source — may contain template placeholders,
   * e.g. "/api/users/${id}".
   */
  endpoint: string;
}

export type StateKind = "useState" | "useReducer" | "context" | "redux" | "zustand" | "unknown";

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

export type LineageNode = ComponentNode | HookNode | DataSourceNode | StateNode | EventNode;

export type EdgeKind =
  | "renders" // component -> component
  | "uses-hook" // component -> hook, hook -> hook
  | "fetches-from" // component | hook -> data-source
  | "reads-state" // component | hook -> state
  | "handles" // component -> event
  | "triggers"; // event -> data-source | state (handler causes a fetch / state write)

export interface LineageEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface LineageGraph {
  /** Schema version for forward compatibility. */
  version: 1;
  /** Absolute path of the scanned root at generation time. */
  root: string;
  generatedAt: string;
  generator: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
}

/** Build the canonical node id. */
export function nodeId(kind: NodeKind, file: string, name: string): string {
  return `${kind}:${file}#${name}`;
}
