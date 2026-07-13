import path from "node:path";

import {
  type DataSourceKind,
  instanceId,
  type InstanceNode,
  type LineageEdge,
  type LineageGraph,
  type LineageNode,
  nodeId,
  type SourceLocation,
} from "@coderadar/core";
import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";

import { fetchMethod, resolveEndpoint, type ResolvedEndpoint } from "./endpoint.js";
import { detectWrappers, type WrapperRegistry } from "./wrappers.js";

export interface ScanOptions {
  /** Directory to scan. */
  root: string;
  /** Glob patterns relative to root. Default: all .tsx/.jsx plus hook-looking .ts files. */
  include?: string[];
  /**
   * Base-URL prefixes stripped from resolved endpoints, e.g.
   * ["https://api.example.com", "/v2"]. Keeps the graph's endpoint patterns
   * environment-independent.
   */
  baseUrls?: string[];
  /**
   * Explicitly-declared API wrapper callees (e.g. ["http.get", "api.post"])
   * for clients the heuristic can't see. Heuristic detection runs regardless.
   */
  apiWrappers?: string[];
}

type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;

interface Declaration {
  name: string;
  fn: FunctionLike;
  exportName: string | null;
  file: string;
  loc: SourceLocation;
}

/** A JSX call site of a (possibly project-local) component, recorded per file. */
interface PendingInstance {
  /** Tag head, e.g. "UserCard" for <UserCard .../> or <Ns.UserCard/>. */
  tagName: string;
  loc: SourceLocation;
  staticProps: Record<string, string>;
  /** Node id of the enclosing component/hook declaration. */
  ownerId: string;
  file: string;
}

const COMPONENT_NAME = /^[A-Z]/;
const HOOK_NAME = /^use[A-Z]/;
const TEXT_ATTRIBUTES = new Set([
  "placeholder",
  "label",
  "title",
  "alt",
  "aria-label",
  "value",
]);
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Scan a directory of React source and produce a lineage graph. */
export function scanReact(options: ScanOptions): LineageGraph {
  const root = path.resolve(options.root);
  const include = options.include ?? ["**/*.tsx", "**/*.jsx", "**/*.ts"];
  const baseUrls = options.baseUrls ?? [];

  const project = new Project({
    compilerOptions: { allowJs: true, jsx: 4 /* ReactJSX */ },
    skipAddingFilesFromTsConfig: true,
  });
  for (const pattern of include) {
    project.addSourceFilesAtPaths([
      path.join(root, pattern),
      `!${path.join(root, "**/node_modules/**")}`,
      `!${path.join(root, "**/*.d.ts")}`,
    ]);
  }

  const wrappers = detectWrappers(project, options.apiWrappers ?? []);
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const pendingInstances: PendingInstance[] = [];
  const addEdge = (edge: LineageEdge): void => {
    if (!edges.some((e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) {
      edges.push(edge);
    }
  };

  for (const sourceFile of project.getSourceFiles()) {
    const file = toPosix(path.relative(root, sourceFile.getFilePath()));
    for (const decl of collectDeclarations(sourceFile, file)) {
      const isComponent = COMPONENT_NAME.test(decl.name) && returnsJsx(decl.fn);
      const isHook = HOOK_NAME.test(decl.name);
      if (!isComponent && !isHook) continue;

      const kind = isComponent ? "component" : "hook";
      const id = nodeId(kind, file, decl.name);

      if (isComponent) {
        nodes.set(id, {
          id,
          kind: "component",
          name: decl.name,
          loc: decl.loc,
          exportName: decl.exportName,
          props: extractProps(decl.fn),
          renderedText: extractRenderedText(decl.fn),
          rendersComponents: extractRenderedComponents(decl.fn),
        });
        collectInstanceSites(decl, id, file, pendingInstances);
      } else {
        nodes.set(id, { id, kind: "hook", name: decl.name, loc: decl.loc, exportName: decl.exportName });
      }

      extractBodyFacts(decl, id, file, nodes, addEdge, baseUrls, wrappers);
    }
  }

  materializeInstances(pendingInstances, nodes, addEdge);

  return {
    version: 2,
    root,
    generatedAt: new Date().toISOString(),
    generator: "@coderadar/parser-react@0.1.0",
    nodes: [...nodes.values()],
    edges,
  };
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function locOf(node: Node, file: string): SourceLocation {
  return { file, line: node.getStartLineNumber(), endLine: node.getEndLineNumber() };
}

/** Top-level function declarations and `const X = () => ...` variable declarations. */
function collectDeclarations(sourceFile: SourceFile, file: string): Declaration[] {
  const decls: Declaration[] = [];

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name === undefined) continue;
    decls.push({
      name,
      fn,
      exportName: fn.isDefaultExport() ? "default" : fn.isExported() ? name : null,
      file,
      loc: locOf(fn, file),
    });
  }

  for (const variable of sourceFile.getVariableDeclarations()) {
    const init = variable.getInitializer();
    const fn = unwrapFunction(init);
    if (fn === undefined) continue;
    decls.push({
      name: variable.getName(),
      fn,
      exportName: isExportedVariable(variable) ? variable.getName() : null,
      file,
      loc: locOf(variable, file),
    });
  }

  return decls;
}

/** Unwrap arrow/function expressions, including wrappers like memo(...) / forwardRef(...). */
function unwrapFunction(node: Node | undefined): FunctionLike | undefined {
  if (node === undefined) return undefined;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (Node.isCallExpression(node)) {
    for (const arg of node.getArguments()) {
      const inner = unwrapFunction(arg);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

function isExportedVariable(variable: VariableDeclaration): boolean {
  const statement = variable.getVariableStatement();
  return statement !== undefined && statement.isExported();
}

function returnsJsx(fn: FunctionLike): boolean {
  const body = fn.getBody();
  if (body === undefined) return false;
  if (Node.isJsxElement(body) || Node.isJsxSelfClosingElement(body) || Node.isJsxFragment(body)) {
    return true;
  }
  return (
    body.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0 ||
    body.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0 ||
    body.getDescendantsOfKind(SyntaxKind.JsxFragment).length > 0
  );
}

function extractProps(fn: FunctionLike): string[] {
  const first = fn.getParameters()[0];
  if (first === undefined) return [];
  const binding = first.getNameNode();
  if (Node.isObjectBindingPattern(binding)) {
    return binding.getElements().map((e) => e.getName());
  }
  return [first.getName()];
}

function extractRenderedText(fn: FunctionLike): string[] {
  const texts = new Set<string>();
  for (const jsxText of fn.getDescendantsOfKind(SyntaxKind.JsxText)) {
    const text = jsxText.getText().replace(/\s+/g, " ").trim();
    if (text.length > 0) texts.add(text);
  }
  for (const attr of fn.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (!TEXT_ATTRIBUTES.has(attr.getNameNode().getText())) continue;
    const init = attr.getInitializer();
    if (init !== undefined && Node.isStringLiteral(init)) {
      const text = init.getLiteralValue().trim();
      if (text.length > 0) texts.add(text);
    }
  }
  return [...texts];
}

function extractRenderedComponents(fn: FunctionLike): string[] {
  const names = new Set<string>();
  const record = (tagName: string): void => {
    const head = tagName.split(".")[0];
    if (head !== undefined && COMPONENT_NAME.test(head)) names.add(head);
  };
  for (const el of fn.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) {
    record(el.getTagNameNode().getText());
  }
  for (const el of fn.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) {
    record(el.getTagNameNode().getText());
  }
  return [...names];
}

/**
 * Walk a component/hook body for data sources (fetch/axios/react-query/swr),
 * state (useState/useReducer/useContext/selectors), events (onX handlers),
 * and same-file hook calls.
 */
function extractBodyFacts(
  decl: Declaration,
  ownerId: string,
  file: string,
  nodes: Map<string, LineageNode>,
  addEdge: (edge: LineageEdge) => void,
  baseUrls: string[],
  wrappers: WrapperRegistry,
): void {
  // A wrapper's own body is plumbing: its URL is a parameter placeholder, so a
  // data source emitted here would attribute ":path" to every consumer. Call
  // sites get the real, substituted endpoint instead.
  const declIsWrapper = wrappers.has(decl.name);

  for (const call of decl.fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();

    const dataSource = declIsWrapper ? null : detectDataSource(call, callee, baseUrls, wrappers);
    if (dataSource !== null) {
      const dsId = nodeId("data-source", file, `${dataSource.sourceKind}:${dataSource.endpoint}`);
      if (!nodes.has(dsId)) {
        nodes.set(dsId, {
          id: dsId,
          kind: "data-source",
          name: dataSource.endpoint,
          loc: locOf(call, file),
          sourceKind: dataSource.sourceKind,
          method: dataSource.method,
          endpoint: dataSource.endpoint,
          raw: dataSource.raw,
          resolved: dataSource.resolved,
        });
      }
      addEdge({ from: ownerId, to: dsId, kind: "fetches-from" });
      continue;
    }

    const stateKind = detectState(callee);
    if (stateKind !== null) {
      const stateName = stateVariableName(call) ?? callee;
      const stId = nodeId("state", file, `${decl.name}.${stateName}`);
      if (!nodes.has(stId)) {
        nodes.set(stId, {
          id: stId,
          kind: "state",
          name: stateName,
          loc: locOf(call, file),
          stateKind,
        });
      }
      addEdge({ from: ownerId, to: stId, kind: "reads-state" });
      continue;
    }

    if (HOOK_NAME.test(callee) && !callee.includes(".")) {
      // Cross-file resolution happens later; record the call by name.
      addEdge({ from: ownerId, to: `unresolved-hook:${callee}`, kind: "uses-hook" });
    }
  }

  for (const attr of decl.fn.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    const attrName = attr.getNameNode().getText();
    if (!/^on[A-Z]/.test(attrName)) continue;
    const init = attr.getInitializer();
    let handler: string | null = null;
    if (init !== undefined && Node.isJsxExpression(init)) {
      const expr = init.getExpression();
      if (expr !== undefined && Node.isIdentifier(expr)) handler = expr.getText();
    }
    const evId = nodeId("event", file, `${decl.name}.${attrName}${handler !== null ? `:${handler}` : ""}`);
    if (!nodes.has(evId)) {
      nodes.set(evId, {
        id: evId,
        kind: "event",
        name: attrName,
        loc: locOf(attr, file),
        event: attrName,
        handler,
      });
    }
    addEdge({ from: ownerId, to: evId, kind: "handles" });
  }
}

function detectDataSource(
  call: CallExpression,
  callee: string,
  baseUrls: string[],
  wrappers: WrapperRegistry,
): ({ sourceKind: DataSourceKind; method: string | null } & ResolvedEndpoint) | null {
  const firstArg = call.getArguments()[0];

  const wrapper = wrappers.get(callee);
  if (wrapper !== undefined) {
    const pathArg = call.getArguments()[wrapper.pathParamIndex];
    const resolved = resolveEndpoint(pathArg, baseUrls);
    const substitution =
      resolved.resolved === "none" ? `:${wrapper.paramName}` : resolved.endpoint;
    const endpoint = wrapper.template.replace(`:${wrapper.paramName}`, substitution);
    return {
      sourceKind: wrapper.sourceKind,
      method: wrapper.method,
      endpoint,
      raw: call.getText().slice(0, 120),
      resolved: endpoint.includes(":") ? "partial" : "full",
    };
  }

  if (callee === "fetch") {
    return {
      sourceKind: "fetch",
      method: fetchMethod(call),
      ...resolveEndpoint(firstArg, baseUrls),
    };
  }

  const axiosMatch = /^axios(?:\.(\w+))?$/.exec(callee);
  if (axiosMatch !== null) {
    const method = axiosMatch[1];
    return {
      sourceKind: "axios",
      method: method !== undefined && HTTP_METHODS.has(method) ? method.toUpperCase() : null,
      ...resolveEndpoint(firstArg, baseUrls),
    };
  }

  if (callee === "useQuery" || callee === "useMutation" || callee === "useInfiniteQuery") {
    // Endpoint lives inside the queryFn (followed in step 1.3); the query key
    // is the identity meanwhile.
    const resolved = resolveEndpoint(firstArg, baseUrls);
    return {
      sourceKind: "react-query",
      method: null,
      ...resolved,
      endpoint:
        resolved.resolved === "none"
          ? (firstArg?.getText().slice(0, 80) ?? "<dynamic>")
          : resolved.endpoint,
    };
  }

  if (callee === "useSWR") {
    return { sourceKind: "swr", method: "GET", ...resolveEndpoint(firstArg, baseUrls) };
  }

  return null;
}

function detectState(callee: string): "useState" | "useReducer" | "context" | "redux" | "zustand" | null {
  switch (callee) {
    case "useState":
      return "useState";
    case "useReducer":
      return "useReducer";
    case "useContext":
      return "context";
    case "useSelector":
      return "redux";
    case "useStore":
      return "zustand";
    default:
      return null;
  }
}

/** `const [items, setItems] = useState(...)` → "items" */
function stateVariableName(call: CallExpression): string | null {
  const parent = call.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    const binding = parent.getNameNode();
    if (Node.isArrayBindingPattern(binding)) {
      const first = binding.getElements()[0];
      if (first !== undefined && Node.isBindingElement(first)) return first.getName();
    }
    return parent.getName();
  }
  return null;
}

/** Record every JSX call site of a capitalized component within a declaration body. */
function collectInstanceSites(
  decl: Declaration,
  ownerId: string,
  file: string,
  pendingInstances: PendingInstance[],
): void {
  const record = (el: JsxOpeningElement | JsxSelfClosingElement): void => {
    const head = el.getTagNameNode().getText().split(".")[0];
    if (head === undefined || !COMPONENT_NAME.test(head)) return;
    const staticProps: Record<string, string> = {};
    for (const attr of el.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) continue;
      const init = attr.getInitializer();
      if (init !== undefined && Node.isStringLiteral(init)) {
        staticProps[attr.getNameNode().getText()] = init.getLiteralValue();
      }
    }
    pendingInstances.push({ tagName: head, loc: locOf(el, file), staticProps, ownerId, file });
  };
  for (const el of decl.fn.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) record(el);
  for (const el of decl.fn.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) record(el);
}

/**
 * Second pass: turn call sites whose tag resolves to a project component
 * definition (matched by name, across files) into InstanceNodes, wired
 * owner --renders--> instance --instance-of--> definition.
 *
 * parentInstanceId stays null until the cross-file instance tree lands in
 * Phase 2.1; the enclosing definition is reachable via the renders edge.
 */
function materializeInstances(
  pendingInstances: PendingInstance[],
  nodes: Map<string, LineageNode>,
  addEdge: (edge: LineageEdge) => void,
): void {
  const definitionsByName = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind === "component") definitionsByName.set(node.name, node.id);
  }

  for (const pending of pendingInstances) {
    const definitionId = definitionsByName.get(pending.tagName);
    if (definitionId === undefined || definitionId === pending.ownerId) continue;

    let id = instanceId(pending.file, pending.loc.line, pending.tagName);
    let suffix = 1;
    while (nodes.has(id)) {
      suffix += 1;
      id = `${instanceId(pending.file, pending.loc.line, pending.tagName)}~${suffix}`;
    }
    const instance: InstanceNode = {
      id,
      kind: "instance",
      name: pending.tagName,
      loc: pending.loc,
      definitionId,
      parentInstanceId: null,
      staticProps: pending.staticProps,
    };
    nodes.set(id, instance);
    addEdge({ from: pending.ownerId, to: id, kind: "renders" });
    addEdge({ from: id, to: definitionId, kind: "instance-of" });
  }
}

/** Rewrite `unresolved-hook:<name>` placeholders to real hook node ids; drop misses. */
export function resolveHookEdges(graph: LineageGraph): LineageGraph {
  const hooksByName = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === "hook") hooksByName.set(node.name, node.id);
  }
  const edges: LineageEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.to.startsWith("unresolved-hook:")) {
      const target = hooksByName.get(edge.to.slice("unresolved-hook:".length));
      if (target !== undefined) edges.push({ ...edge, to: target });
      // Unknown hooks (from libraries we don't model) are dropped.
    } else {
      edges.push(edge);
    }
  }
  return { ...graph, edges };
}
