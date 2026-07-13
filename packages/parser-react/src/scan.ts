import path from "node:path";

import {
  type DataSourceKind,
  instanceId,
  type InstanceNode,
  type LineageEdge,
  type LineageGraph,
  type LineageNode,
  nodeId,
  type RenderedText,
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

import { fetchMethod, resolveEndpoint, type ResolvedEndpoint, resolveStringValue } from "./endpoint.js";
import { i18nRenderedText, type I18nOptions, loadLocaleTable, type LocaleTable } from "./i18n.js";
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
  /**
   * Locale-file configuration. When set, t("key") / <Trans i18nKey> call
   * sites expand into renderedText entries for every locale, so screenshots
   * in any language match.
   */
  i18n?: I18nOptions;
  /**
   * Package names whose components should still produce instances even
   * though their definitions live outside the repo (e.g. ["@acme/ui"]).
   * Such instances are flagged "external-definition" — the usage site is
   * ours even when the definition isn't (failure mode A5).
   */
  designSystemPackages?: string[];
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
  /** The JSX element itself — used for import resolution and nesting. */
  element: JsxOpeningElement | JsxSelfClosingElement;
  /**
   * Index (into the global pending list) of the nearest enclosing component
   * call site in the same body: <Card><Button/></Card> → Button's parent is
   * the Card site. Null at the body root (the renders edge covers the owner).
   */
  parentIndex: number | null;
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
  const localeTable = options.i18n !== undefined ? loadLocaleTable(root, options.i18n) : null;
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const pendingInstances: PendingInstance[] = [];
  /** HOC-wrapped alias → inner component name, e.g. Panel → PanelInner (connect). */
  const hocAliases = new Map<string, string>();
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
          renderedText: [
            ...extractRenderedText(decl.fn),
            ...(localeTable !== null ? i18nRenderedText(decl.fn, localeTable) : []),
          ],
          rendersComponents: extractRenderedComponents(decl.fn),
        });
        collectInstanceSites(decl.fn, id, file, pendingInstances);
      } else {
        nodes.set(id, { id, kind: "hook", name: decl.name, loc: decl.loc, exportName: decl.exportName });
      }

      extractBodyFacts(decl.name, decl.fn, id, file, nodes, addEdge, baseUrls, wrappers);
    }

    scanClassComponents(sourceFile, file, nodes, addEdge, baseUrls, wrappers, localeTable, pendingInstances);
    collectHocAliases(sourceFile, hocAliases);
  }

  const instanceIds = materializeInstances(
    pendingInstances,
    nodes,
    addEdge,
    hocAliases,
    options.designSystemPackages ?? [],
    root,
  );
  resolvePropFlow(pendingInstances, instanceIds, nodes, edges, addEdge, baseUrls, wrappers);

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

function extractRenderedText(fn: Node): RenderedText[] {
  const entries = new Map<string, RenderedText>();
  const add = (entry: RenderedText): void => {
    entries.set(`${entry.source}:${entry.text}:${entry.branch ?? ""}`, entry);
  };

  for (const jsxText of fn.getDescendantsOfKind(SyntaxKind.JsxText)) {
    const text = jsxText.getText().replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    add({ text, source: "jsx", ...branchTag(jsxText, fn) });
  }

  for (const attr of fn.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (!TEXT_ATTRIBUTES.has(attr.getNameNode().getText())) continue;
    const init = attr.getInitializer();
    if (init !== undefined && Node.isStringLiteral(init)) {
      const text = init.getLiteralValue().trim();
      if (text.length > 0) add({ text, source: "attribute", ...branchTag(attr, fn) });
    }
  }

  // Template literals rendered as JSX children: {`${count} items in cart`} →
  // "* items in cart" (unknown segments become * wildcards).
  for (const expr of fn.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
    const inner = expr.getExpression();
    if (inner === undefined) continue;
    if (Node.isStringLiteral(inner)) {
      const text = inner.getLiteralValue().replace(/\s+/g, " ").trim();
      if (text.length > 0) add({ text, source: "jsx", ...branchTag(expr, fn) });
    } else if (Node.isConditionalExpression(inner)) {
      // {cond ? "Large order book" : "Small order book"}
      for (const branchNode of [inner.getWhenTrue(), inner.getWhenFalse()]) {
        if (Node.isStringLiteral(branchNode)) {
          const text = branchNode.getLiteralValue().replace(/\s+/g, " ").trim();
          if (text.length > 0) add({ text, source: "jsx", ...branchTag(branchNode, fn) });
        }
      }
    } else if (Node.isNoSubstitutionTemplateLiteral(inner)) {
      const text = inner.getLiteralValue().replace(/\s+/g, " ").trim();
      if (text.length > 0) add({ text, source: "jsx", ...branchTag(expr, fn) });
    } else if (Node.isTemplateExpression(inner)) {
      let text = inner.getHead().getLiteralText();
      for (const span of inner.getTemplateSpans()) {
        text += `${resolveStringValue(span.getExpression(), 0) ?? "*"}${span.getLiteral().getLiteralText()}`;
      }
      text = text.replace(/\s+/g, " ").trim();
      if (text.replace(/[*\s]/g, "").length > 0) {
        add({ text, source: "jsx", template: true, ...branchTag(expr, fn) });
      }
    }
  }

  return [...entries.values()];
}

/**
 * The nearest condition guarding a rendered-text node: a ternary branch, a
 * `cond && <jsx>` gate, or an enclosing if-statement (early-return pattern).
 * Ternary else-branches are negated. Empty object when unconditional.
 */
function branchTag(node: Node, boundary: Node): { branch?: string } {
  let current: Node | undefined = node;
  while (current !== undefined && current !== boundary) {
    const parent: Node | undefined = current.getParent();
    if (parent === undefined) break;
    if (Node.isConditionalExpression(parent)) {
      const condition = parent.getCondition().getText();
      if (parent.getWhenTrue() === current) return { branch: condition };
      if (parent.getWhenFalse() === current) return { branch: `!(${condition})` };
    }
    if (
      Node.isBinaryExpression(parent) &&
      parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken &&
      parent.getRight() === current
    ) {
      return { branch: parent.getLeft().getText() };
    }
    if (Node.isIfStatement(parent) && parent.getThenStatement() === current) {
      return { branch: parent.getExpression().getText() };
    }
    current = parent;
  }
  return {};
}

function extractRenderedComponents(fn: Node): string[] {
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
  declName: string,
  body: Node,
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
  const declIsWrapper = wrappers.has(declName);

  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
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
          ...(dataSource.queryKey !== undefined ? { queryKey: dataSource.queryKey } : {}),
        });
      }
      addEdge({ from: ownerId, to: dsId, kind: "fetches-from" });
      continue;
    }

    const stateKind = detectState(callee);
    if (stateKind !== null) {
      const stateName = stateVariableName(call) ?? callee;
      const stId = nodeId("state", file, `${declName}.${stateName}`);
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

  for (const attr of body.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    const attrName = attr.getNameNode().getText();
    if (!/^on[A-Z]/.test(attrName)) continue;
    const init = attr.getInitializer();
    let handler: string | null = null;
    if (init !== undefined && Node.isJsxExpression(init)) {
      const expr = init.getExpression();
      // Plain references (handleDelete) and method references (this.refresh).
      if (
        expr !== undefined &&
        (Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr))
      ) {
        handler = expr.getText();
      }
    }
    const evId = nodeId("event", file, `${declName}.${attrName}${handler !== null ? `:${handler}` : ""}`);
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

type DetectedSource = {
  sourceKind: DataSourceKind;
  method: string | null;
  queryKey?: string;
} & ResolvedEndpoint;

function detectDataSource(
  call: CallExpression,
  callee: string,
  baseUrls: string[],
  wrappers: WrapperRegistry,
): DetectedSource | null {
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
    let keyText: string | undefined;
    let fnExpr: Node | undefined;
    if (firstArg !== undefined && Node.isObjectLiteralExpression(firstArg)) {
      // v4/v5 object form: useQuery({ queryKey, queryFn }) / useMutation({ mutationFn })
      keyText = propertyInitializer(firstArg, "queryKey")?.getText() ??
        propertyInitializer(firstArg, "mutationKey")?.getText();
      fnExpr = propertyInitializer(firstArg, "queryFn") ?? propertyInitializer(firstArg, "mutationFn");
    } else if (callee === "useMutation") {
      // v3 positional form: useMutation(mutationFn, options?)
      fnExpr = firstArg;
    } else {
      // v3 positional form: useQuery(key, queryFn, options?)
      keyText = firstArg?.getText();
      fnExpr = call.getArguments()[1];
    }
    const queryKey = keyText?.slice(0, 80);
    const inner = fnExpr !== undefined ? endpointFromFunction(fnExpr, baseUrls, wrappers) : null;
    if (inner !== null) {
      return { ...inner, sourceKind: "react-query", queryKey };
    }
    const resolved = resolveEndpoint(firstArg, baseUrls);
    return {
      sourceKind: "react-query",
      method: null,
      ...resolved,
      endpoint:
        resolved.resolved === "none"
          ? (firstArg?.getText().slice(0, 80) ?? "<dynamic>")
          : resolved.endpoint,
      queryKey,
    };
  }

  if (callee === "useSWR") {
    // SWR convention: the key IS the URL (passed to the fetcher). When the key
    // carries no shape, fall back to the fetcher body.
    const key = resolveEndpoint(firstArg, baseUrls);
    if (key.resolved !== "none") {
      return { sourceKind: "swr", method: "GET", ...key, queryKey: firstArg?.getText().slice(0, 80) };
    }
    const fetcher = call.getArguments()[1];
    const inner = fetcher !== undefined ? endpointFromFunction(fetcher, baseUrls, wrappers) : null;
    if (inner !== null) return { ...inner, sourceKind: "swr" };
    return { sourceKind: "swr", method: "GET", ...key };
  }

  return null;
}

function propertyInitializer(objectLiteral: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(objectLiteral)) return undefined;
  const property = objectLiteral.getProperty(name);
  if (property !== undefined && Node.isPropertyAssignment(property)) {
    return property.getInitializer();
  }
  if (property !== undefined && Node.isShorthandPropertyAssignment(property)) {
    return property.getNameNode();
  }
  return undefined;
}

/**
 * Follow a queryFn/mutationFn/fetcher expression to a function body (inline
 * arrow, or a reference resolved via go-to-definition, possibly in another
 * file) and extract the first data source inside it. react-query/swr results
 * are skipped to avoid self-recursion.
 */
function endpointFromFunction(
  expr: Node,
  baseUrls: string[],
  wrappers: WrapperRegistry,
): DetectedSource | null {
  const body = functionBodyOf(expr);
  if (body === null) return null;
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const source = detectDataSource(call, call.getExpression().getText(), baseUrls, wrappers);
    if (source !== null && source.sourceKind !== "react-query" && source.sourceKind !== "swr") {
      return source;
    }
  }
  return null;
}

function functionBodyOf(expr: Node): Node | null {
  if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
    return expr.getBody() ?? null;
  }
  if (Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr)) {
    const identifier = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
    if (!Node.isIdentifier(identifier)) return null;
    for (const definition of identifier.getDefinitionNodes()) {
      if (Node.isFunctionDeclaration(definition)) {
        return definition.getBody() ?? null;
      }
      if (Node.isVariableDeclaration(definition)) {
        const init = definition.getInitializer();
        if (init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          return init.getBody() ?? null;
        }
      }
    }
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

const CLASS_COMPONENT_BASE = /(React\.)?(Pure)?Component/;

/** Legacy class components: render() is the body, this.state is state, lifecycle fetches count. */
function scanClassComponents(
  sourceFile: SourceFile,
  file: string,
  nodes: Map<string, LineageNode>,
  addEdge: (edge: LineageEdge) => void,
  baseUrls: string[],
  wrappers: WrapperRegistry,
  localeTable: LocaleTable | null,
  pendingInstances: PendingInstance[],
): void {
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (name === undefined || !COMPONENT_NAME.test(name)) continue;
    const heritage = cls.getExtends()?.getText() ?? "";
    if (!CLASS_COMPONENT_BASE.test(heritage)) continue;

    const id = nodeId("component", file, name);
    const exportName = cls.isDefaultExport() ? "default" : cls.isExported() ? name : null;
    const render = cls.getMethod("render");

    if (render === undefined) {
      nodes.set(id, {
        id,
        kind: "component",
        name,
        loc: locOf(cls, file),
        exportName,
        props: [],
        renderedText: [],
        rendersComponents: [],
        flags: ["incomplete"],
      });
      continue;
    }

    nodes.set(id, {
      id,
      kind: "component",
      name,
      loc: locOf(cls, file),
      exportName,
      props: classProps(cls),
      renderedText: [
        ...extractRenderedText(render),
        ...(localeTable !== null ? i18nRenderedText(render, localeTable) : []),
      ],
      rendersComponents: extractRenderedComponents(render),
    });
    collectInstanceSites(render, id, file, pendingInstances);
    // Whole class body: lifecycle fetches (componentDidMount etc.) + render events.
    extractBodyFacts(name, cls, id, file, nodes, addEdge, baseUrls, wrappers);
    extractClassState(cls, name, id, file, nodes, addEdge);
  }
}

/** `this.props.<name>` accesses stand in for destructured props. */
function classProps(cls: Node): string[] {
  const props = new Set<string>();
  for (const access of cls.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (access.getExpression().getText() === "this.props") props.add(access.getName());
  }
  return [...props];
}

/** State keys from `state = {...}` property or `this.state = {...}` in the constructor. */
function extractClassState(
  cls: Node,
  componentName: string,
  ownerId: string,
  file: string,
  nodes: Map<string, LineageNode>,
  addEdge: (edge: LineageEdge) => void,
): void {
  const stateKeys = new Map<string, Node>();
  const collectKeys = (objectLiteral: Node): void => {
    if (!Node.isObjectLiteralExpression(objectLiteral)) return;
    for (const member of objectLiteral.getProperties()) {
      if (Node.isPropertyAssignment(member) || Node.isShorthandPropertyAssignment(member)) {
        stateKeys.set(member.getName(), member);
      }
    }
  };
  for (const property of cls.getDescendantsOfKind(SyntaxKind.PropertyDeclaration)) {
    if (property.getName() !== "state") continue;
    const init = property.getInitializer();
    if (init !== undefined) collectKeys(init);
  }
  for (const assignment of cls.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (assignment.getLeft().getText() === "this.state") collectKeys(assignment.getRight());
  }
  for (const [key, node] of stateKeys) {
    const stId = nodeId("state", file, `${componentName}.${key}`);
    if (!nodes.has(stId)) {
      nodes.set(stId, {
        id: stId,
        kind: "state",
        name: key,
        loc: locOf(node, file),
        stateKind: "class-state",
      });
    }
    addEdge({ from: ownerId, to: stId, kind: "reads-state" });
  }
}

const HOC_NAMES = /^(connect|withRouter|memo|forwardRef|observer|inject|withTranslation|styled)\b/;

/**
 * `const Panel = connect(mapState)(PanelInner)` — record Panel → PanelInner so
 * <Panel/> call sites resolve to the inner component's definition.
 */
function collectHocAliases(sourceFile: SourceFile, hocAliases: Map<string, string>): void {
  for (const variable of sourceFile.getVariableDeclarations()) {
    const name = variable.getName();
    if (!COMPONENT_NAME.test(name)) continue;
    const init = variable.getInitializer();
    if (init === undefined || !Node.isCallExpression(init)) continue;
    if (unwrapFunction(init) !== undefined) continue; // inline-fn HOCs are handled as declarations
    const outermostCallee = init.getExpression().getText();
    if (!HOC_NAMES.test(outermostCallee)) continue;
    const inner = findComponentArgument(init);
    if (inner !== null && inner !== name) hocAliases.set(name, inner);
  }
}

/** First capitalized identifier argument anywhere in a (possibly curried) call chain. */
function findComponentArgument(call: Node): string | null {
  if (!Node.isCallExpression(call)) return null;
  for (const arg of call.getArguments()) {
    if (Node.isIdentifier(arg) && COMPONENT_NAME.test(arg.getText())) return arg.getText();
  }
  return findComponentArgument(call.getExpression());
}

/** Record every JSX call site of a capitalized component within a declaration body. */
function collectInstanceSites(
  body: Node,
  ownerId: string,
  file: string,
  pendingInstances: PendingInstance[],
): void {
  const bodyStart = pendingInstances.length;
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
    pendingInstances.push({
      tagName: head,
      loc: locOf(el, file),
      staticProps,
      ownerId,
      file,
      element: el,
      parentIndex: null,
    });
  };
  for (const el of body.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) record(el);
  for (const el of body.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) record(el);

  // Same-body nesting: <Card><Button/></Card> → Button's parent site is Card.
  const bodySites = pendingInstances.slice(bodyStart);
  for (const site of bodySites) {
    let ancestor: Node | undefined = site.element.getParent();
    while (ancestor !== undefined && ancestor !== body && site.parentIndex === null) {
      for (let i = 0; i < bodySites.length; i += 1) {
        const candidate = bodySites[i];
        if (candidate === undefined || candidate === site) continue;
        const candidateElement: Node | undefined = Node.isJsxOpeningElement(candidate.element)
          ? candidate.element.getParent() // the enclosing JsxElement
          : candidate.element;
        if (candidateElement !== undefined && candidateElement === ancestor) {
          site.parentIndex = bodyStart + i;
          break;
        }
      }
      ancestor = ancestor.getParent();
    }
  }
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
  hocAliases: ReadonlyMap<string, string>,
  designSystemPackages: string[],
  root: string,
): Array<string | null> {
  const definitionsByName = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind === "component") definitionsByName.set(node.name, node.id);
  }

  // <Panel/> where Panel = connect(...)(PanelInner): resolve through the alias
  // chain (bounded — alias graphs are tiny and could in principle cycle).
  const resolveAlias = (name: string): string => {
    let current = name;
    for (let hop = 0; hop < 3; hop += 1) {
      const target = hocAliases.get(current);
      if (target === undefined) break;
      current = target;
    }
    return current;
  };

  /**
   * Resolve a tag to its definition. Priority: the file's imports (barrels,
   * renames, and default exports resolve via getExportedDeclarations), then
   * same-file/global name lookup, then configured design-system packages.
   */
  const resolveTag = (
    pending: PendingInstance,
  ): { definitionId: string; external: boolean } | null => {
    const sourceFile = pending.element.getSourceFile();
    const importDecl = sourceFile.getImportDeclarations().find((decl) => {
      if (decl.getDefaultImport()?.getText() === pending.tagName) return true;
      return decl.getNamedImports().some((named) => (named.getAliasNode()?.getText() ?? named.getName()) === pending.tagName);
    });

    if (importDecl !== undefined) {
      const target = importDecl.getModuleSpecifierSourceFile();
      const specifier = importDecl.getModuleSpecifierValue();
      const inNodeModules = target?.getFilePath().includes("node_modules") ?? false;
      if (target !== undefined && !inNodeModules) {
        const named = importDecl
          .getNamedImports()
          .find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === pending.tagName);
        const importedName = named !== undefined ? named.getName() : "default";
        for (const declaration of target.getExportedDeclarations().get(importedName) ?? []) {
          const declName = Node.hasName(declaration) ? declaration.getName() : undefined;
          if (declName === undefined) continue;
          const declFile = toPosix(path.relative(root, declaration.getSourceFile().getFilePath()));
          const resolvedName = resolveAlias(declName);
          const candidate = nodeId("component", declFile, resolvedName);
          if (nodes.has(candidate)) return { definitionId: candidate, external: false };
        }
      }
      const isDesignSystem = designSystemPackages.some(
        (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
      );
      if (isDesignSystem || inNodeModules) {
        return { definitionId: `external:${specifier}#${pending.tagName}`, external: true };
      }
      return null; // imported from an unknown, unconfigured module — not ours
    }

    // Same file first, then unique-name fallback across the project.
    const resolvedName = resolveAlias(pending.tagName);
    const sameFile = nodeId("component", pending.file, resolvedName);
    if (nodes.has(sameFile)) return { definitionId: sameFile, external: false };
    const global = definitionsByName.get(resolvedName);
    return global !== undefined ? { definitionId: global, external: false } : null;
  };

  const idByIndex: Array<string | null> = [];
  const created: InstanceNode[] = [];
  for (const [index, pending] of pendingInstances.entries()) {
    const resolved = resolveTag(pending);
    if (resolved === null || resolved.definitionId === pending.ownerId) {
      idByIndex[index] = null;
      continue;
    }

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
      definitionId: resolved.definitionId,
      parentInstanceId: null,
      staticProps: pending.staticProps,
      ...(resolved.external ? { flags: ["external-definition"] } : {}),
    };
    nodes.set(id, instance);
    idByIndex[index] = id;
    created.push(instance);
    addEdge({ from: pending.ownerId, to: id, kind: "renders" });
    if (!resolved.external) {
      addEdge({ from: id, to: resolved.definitionId, kind: "instance-of" });
    }
  }

  // Second pass: same-body nesting resolved now that every id exists.
  for (const [index, pending] of pendingInstances.entries()) {
    const id = idByIndex[index];
    if (id === null || id === undefined || pending.parentIndex === null) continue;
    const parentId = idByIndex[pending.parentIndex];
    const instance = created.find((n) => n.id === id);
    if (instance !== undefined && parentId !== null && parentId !== undefined) {
      instance.parentInstanceId = parentId;
    }
  }

  return idByIndex;
}

/**
 * Prop-flow (TRACKER step 2.2 — failure mode C1, the headline case).
 *
 * For each instance, trace expression props back to the data that populates
 * them in the parent scope and emit data-source --provides-data--> instance
 * edges. This is what makes <DataTable rows={rows}/> on the Users page carry
 * /api/users while the identical component on the Invoices page carries
 * /api/invoices.
 *
 * Origins handled (depth-capped):
 * - useState pairs: `const [rows, setRows] = useState()` → every setRows call
 *   site → a data-source call in the same statement (`fetch(...).then(setRows)`)
 * - direct results: `const { data } = useQuery(...)` / `const r = useApi("/x")`
 * - project hooks: `const { users } = useUsers()` → the hook's fetches-from edges
 * - simple derivations: `const rows = raw.items` → recurse on `raw`
 */
function resolvePropFlow(
  pendingInstances: PendingInstance[],
  instanceIds: Array<string | null>,
  nodes: Map<string, LineageNode>,
  edges: LineageEdge[],
  addEdge: (edge: LineageEdge) => void,
  baseUrls: string[],
  wrappers: WrapperRegistry,
): void {
  const hooksByName = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind === "hook") hooksByName.set(node.name, node.id);
  }

  const hookSources = (hookId: string): string[] =>
    edges.flatMap((e) => (e.from === hookId && e.kind === "fetches-from" ? [e.to] : []));

  /** Data-source node ids that populate `expr` in its scope. */
  const originsOf = (expr: Node, file: string, depth: number): Set<string> => {
    const origins = new Set<string>();
    if (depth > 3) return origins;

    const fromCall = (call: Node): void => {
      if (!Node.isCallExpression(call)) return;
      const callee = call.getExpression().getText();
      const hookId = hooksByName.get(callee);
      if (hookId !== undefined) {
        for (const dsId of hookSources(hookId)) origins.add(dsId);
        return;
      }
      const source = detectDataSource(call, callee, baseUrls, wrappers);
      if (source !== null) {
        origins.add(nodeId("data-source", file, `${source.sourceKind}:${source.endpoint}`));
      }
    };

    if (!Node.isIdentifier(expr)) {
      // Derived expressions: recurse on each identifier inside (raw.items → raw).
      for (const identifier of expr.getDescendantsOfKind(SyntaxKind.Identifier)) {
        for (const origin of originsOf(identifier, file, depth + 1)) origins.add(origin);
      }
      return origins;
    }

    for (const definition of expr.getDefinitionNodes()) {
      let varDecl: Node | undefined = definition;
      if (Node.isBindingElement(varDecl)) {
        varDecl = varDecl.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      }
      if (varDecl === undefined || !Node.isVariableDeclaration(varDecl)) continue;

      const init = varDecl.getInitializer();
      if (init !== undefined) {
        // Direct result: const { data } = useQuery(...) / const r = useApi("/x")
        // — including calls wrapped in await / as-casts.
        fromCall(init);
        if (origins.size === 0) {
          for (const inner of init.getDescendantsOfKind(SyntaxKind.CallExpression)) fromCall(inner);
        }
      }

      // useState pair: find the setter and every statement that calls it.
      const binding = varDecl.getNameNode();
      if (
        Node.isArrayBindingPattern(binding) &&
        init !== undefined &&
        Node.isCallExpression(init) &&
        init.getExpression().getText() === "useState"
      ) {
        const setterElement = binding.getElements()[1];
        if (setterElement !== undefined && Node.isBindingElement(setterElement)) {
          const setterName = setterElement.getName();
          const scope = varDecl.getFirstAncestor(
            (a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a) || Node.isFunctionDeclaration(a) || Node.isClassDeclaration(a),
          );
          for (const ref of (scope ?? varDecl.getSourceFile()).getDescendantsOfKind(
            SyntaxKind.Identifier,
          )) {
            if (ref.getText() !== setterName || ref === setterElement.getNameNode()) continue;
            const statement = ref.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
            if (statement === undefined) continue;
            for (const call of statement.getDescendantsOfKind(SyntaxKind.CallExpression)) {
              fromCall(call);
            }
          }
        }
      }

      // Derivation: const rows = raw.items ?? [] → recurse on raw.
      if (origins.size === 0 && init !== undefined && !Node.isCallExpression(init)) {
        for (const identifier of init.getDescendantsOfKind(SyntaxKind.Identifier)) {
          if (identifier.getText() === expr.getText()) continue;
          for (const origin of originsOf(identifier, file, depth + 1)) origins.add(origin);
        }
      }
    }
    return origins;
  };

  for (const [index, pending] of pendingInstances.entries()) {
    const instanceId = instanceIds[index];
    if (instanceId === null || instanceId === undefined) continue;
    for (const attr of pending.element.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) continue;
      const init = attr.getInitializer();
      if (init === undefined || !Node.isJsxExpression(init)) continue;
      const expr = init.getExpression();
      if (expr === undefined) continue;
      for (const dsId of originsOf(expr, pending.file, 0)) {
        if (!nodes.has(dsId)) continue;
        addEdge({
          from: dsId,
          to: instanceId,
          kind: "provides-data",
          via: attr.getNameNode().getText(),
        });
      }
    }
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
