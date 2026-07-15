/**
 * Router adapters (TRACKER step 3.1, failure mode B4).
 *
 * Routes are the journey graph's entry points: "navigate to /users/:id" only
 * means something if the graph knows which page component that path renders.
 * Two families are detected:
 *
 * - React Router — createBrowserRouter/createHashRouter/createMemoryRouter
 *   object trees, and <Route> JSX trees (inside <Routes> or
 *   createRoutesFromElements). Nested paths join, index routes take the
 *   parent path, pathless parents contribute layout/guard context, and lazy
 *   routes (`lazy: () => import(...)` or `React.lazy`) resolve through the
 *   dynamic import to the module's Component/default export.
 * - Next.js file-based — app router (app/**\/page.tsx with [param],
 *   [...catchAll], (group) segments and nearest-ancestor layout.tsx) and
 *   pages router (pages/**\/*.tsx). Only active when the scan root looks
 *   like a Next.js project (next.config.* or a "next" dependency), so a
 *   plain React repo with a folder named pages/ doesn't sprout fake routes.
 *
 * Every route becomes a RouteNode with a routes-to edge to the page
 * component's definition; routes whose page can't be resolved are emitted
 * flagged "unresolved-page" — visible, never silent.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type LineageEdge,
  type LineageNode,
  nodeId,
  type RouteNode,
  type RouterKind,
  type SourceLocation,
} from "@coderadar/core";
import {
  type Identifier,
  type JsxAttribute,
  type JsxChild,
  type JsxElement,
  type JsxSelfClosingElement,
  Node,
  type Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

/** Auth/role wrapper components recorded as guards rather than layouts. */
const GUARD_NAME = /^(Require|Protected?|Private)|Guard$/;

/** Route paths that are deep-link / OAuth-callback entry points from outside the app (B9). */
const EXTERNAL_ENTRY = /callback|oauth|\bsso\b|\/auth\/|\/redirect|\/return\b/i;

const ROUTER_FACTORIES = new Set([
  "createBrowserRouter",
  "createHashRouter",
  "createMemoryRouter",
]);

export function detectRoutes(
  project: Project,
  root: string,
  nodes: Map<string, LineageNode>,
  addEdge: (edge: LineageEdge) => void,
): void {
  const adapter = new RouteAdapter(project, root, nodes, addEdge);
  adapter.reactRouter();
  if (looksLikeNextProject(root)) {
    adapter.nextAppRouter();
    adapter.nextPagesRouter();
  }
}

function looksLikeNextProject(root: string): boolean {
  for (const config of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    if (fs.existsSync(path.join(root, config))) return true;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.dependencies?.["next"] !== undefined || pkg.devDependencies?.["next"] !== undefined;
  } catch {
    return false;
  }
}

/** Layout/guard context accumulated from ancestor routes. */
interface RouteContext {
  basePath: string;
  layout: string | null;
  guards: string[];
}

class RouteAdapter {
  constructor(
    private readonly project: Project,
    private readonly root: string,
    private readonly nodes: Map<string, LineageNode>,
    private readonly addEdge: (edge: LineageEdge) => void,
  ) {}

  // ---------------------------------------------------------------- shared

  private toPosix(p: string): string {
    return p.split(path.sep).join("/");
  }

  private fileOf(node: Node): string {
    return this.toPosix(path.relative(this.root, node.getSourceFile().getFilePath()));
  }

  private locOf(node: Node, file: string): SourceLocation {
    return { file, line: node.getStartLineNumber(), endLine: node.getEndLineNumber() };
  }

  /**
   * Emit a RouteNode and its routes-to edge. `page` is the resolved component
   * definition id, or null when resolution failed (flagged, not dropped).
   */
  private emit(
    router: RouterKind,
    routePath: string,
    file: string,
    loc: SourceLocation,
    page: string | null,
    layout: string | null,
    guards: string[],
  ): void {
    const id = nodeId("route", file, routePath);
    if (this.nodes.has(id)) return; // same file + path = duplicate declaration
    const route: RouteNode = {
      id,
      kind: "route",
      name: routePath,
      loc,
      path: routePath,
      router,
      layout,
      guards,
      ...(page === null ? { flags: ["unresolved-page"] } : {}),
    };
    this.nodes.set(id, route);
    if (page !== null) this.addEdge({ from: id, to: page, kind: "routes-to" });

    // Deep-link / OAuth-callback routes are entry points from outside the app (B9).
    if (EXTERNAL_ENTRY.test(routePath)) {
      const inbound = "external:inbound";
      if (!this.nodes.has(inbound)) {
        this.nodes.set(inbound, {
          id: inbound,
          kind: "external",
          name: "inbound",
          loc,
          url: "inbound",
          host: "inbound",
        });
      }
      this.addEdge({ from: inbound, to: id, kind: "enters-at" });
    }
  }

  /** "/users" + "settings/:id" → "/users/settings/:id"; absolute children win. */
  private joinPaths(base: string, segment: string): string {
    if (segment.startsWith("/")) return normalizePath(segment);
    return normalizePath(`${base.replace(/\/+$/, "")}/${segment}`);
  }

  /** Component definition id for a name, resolved from a usage site. */
  private resolveComponentName(name: string, at: Node): string | null {
    // Prefer go-to-definition from the actual identifier so imports, renames,
    // and barrels resolve exactly like instance resolution does.
    for (const identifier of identifiersNamed(at, name)) {
      for (const definition of identifier.getDefinitionNodes()) {
        const lazyTarget = this.resolveLazyVariable(definition);
        if (lazyTarget !== null) return lazyTarget;
        const declName = Node.hasName(definition) ? definition.getName() : undefined;
        if (declName === undefined) continue;
        const declFile = this.fileOf(definition);
        const candidate = nodeId("component", declFile, declName);
        if (this.nodes.has(candidate)) return candidate;
      }
    }
    // Fallback: unique name across the graph.
    let found: string | null = null;
    for (const node of this.nodes.values()) {
      if (node.kind !== "component" || node.name !== name) continue;
      if (found !== null) return null; // ambiguous — refuse to guess
      found = node.id;
    }
    return found;
  }

  /**
   * `const Settings = lazy(() => import("./Settings"))` → the imported page.
   * Wrapper helpers around the lazy call — `Loadable(lazy(() => import()))`,
   * the field app's universal pattern (6F.5) — unwrap to the same import.
   */
  private resolveLazyVariable(definition: Node): string | null {
    if (!Node.isVariableDeclaration(definition)) return null;
    const init = definition.getInitializer();
    if (init === undefined || !Node.isCallExpression(init)) return null;
    const isLazy = (call: Node): boolean =>
      Node.isCallExpression(call) && /^(React\.)?lazy$/.test(call.getExpression().getText());
    const hasLazy = [init, ...init.getDescendantsOfKind(SyntaxKind.CallExpression)].some(isLazy);
    if (!hasLazy) return null;
    return this.resolveDynamicImport(init);
  }

  /**
   * The route objects of a router config: an array literal (spread elements
   * expanded), or an identifier resolved to its (possibly imported) array
   * declaration (6F.5). Hop-bounded — config indirection chains are shallow.
   */
  private routeArrayElements(node: Node | undefined, hop: number): Node[] {
    if (node === undefined || hop > 4) return [];
    if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
      return this.routeArrayElements(node.getExpression(), hop);
    }
    if (Node.isArrayLiteralExpression(node)) {
      return node.getElements().flatMap((element) =>
        Node.isSpreadElement(element)
          ? this.routeArrayElements(element.getExpression(), hop + 1)
          : [element],
      );
    }
    if (Node.isIdentifier(node)) {
      for (const definition of node.getDefinitionNodes()) {
        if (!Node.isVariableDeclaration(definition)) continue;
        const elements = this.routeArrayElements(definition.getInitializer(), hop + 1);
        if (elements.length > 0) return elements;
      }
    }
    return [];
  }

  /**
   * Resolve the first `import("...")` inside `node` to the target module's
   * Component (react-router lazy convention) or default export component.
   */
  private resolveDynamicImport(node: Node): string | null {
    for (const call of [node, ...node.getDescendantsOfKind(SyntaxKind.CallExpression)]) {
      if (!Node.isCallExpression(call)) continue;
      if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
      const arg = call.getArguments()[0];
      if (arg === undefined || !Node.isStringLiteral(arg)) continue;
      const target = this.resolveModule(call.getSourceFile(), arg.getLiteralValue());
      if (target === null) continue;
      for (const exportName of ["Component", "default"]) {
        for (const declaration of target.getExportedDeclarations().get(exportName) ?? []) {
          const declName = Node.hasName(declaration) ? declaration.getName() : undefined;
          if (declName === undefined) continue;
          const candidate = nodeId("component", this.fileOf(declaration), declName);
          if (this.nodes.has(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  private resolveModule(from: SourceFile, specifier: string): SourceFile | null {
    if (!specifier.startsWith(".")) return null;
    const base = path.resolve(path.dirname(from.getFilePath()), specifier);
    for (const candidate of [
      base,
      `${base}.tsx`,
      `${base}.ts`,
      `${base}.jsx`,
      `${base}.js`,
      path.join(base, "index.tsx"),
      path.join(base, "index.ts"),
    ]) {
      const file = this.project.getSourceFile(candidate);
      if (file !== undefined) return file;
    }
    return null;
  }

  // ---------------------------------------------------------- React Router

  reactRouter(): void {
    for (const sourceFile of this.project.getSourceFiles()) {
      // Object form: createBrowserRouter([{ path, element, children }, ...]).
      // The config may also be an imported identifier or spread-composed from
      // separately-declared arrays (6F.5 — the field app's shape).
      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!ROUTER_FACTORIES.has(call.getExpression().getText())) continue;
        for (const route of this.routeArrayElements(call.getArguments()[0], 0)) {
          this.objectRoute(route, { basePath: "/", layout: null, guards: [] });
        }
      }
      // JSX form: <Routes><Route …/></Routes> / createRoutesFromElements(<Route/>)
      for (const element of routeJsxElements(sourceFile)) {
        if (hasRouteAncestor(element)) continue; // children handled by their root
        this.jsxRoute(element, { basePath: "/", layout: null, guards: [] });
      }
    }
  }

  private objectRoute(route: Node, context: RouteContext): void {
    if (!Node.isObjectLiteralExpression(route)) return;
    const file = this.fileOf(route);

    const pathInit = objectProperty(route, "path");
    const segment =
      pathInit !== undefined && Node.isStringLiteral(pathInit) ? pathInit.getLiteralValue() : null;
    const isIndex = objectProperty(route, "index")?.getText() === "true";
    const children = this.routeArrayElements(objectProperty(route, "children"), 0);

    const routePath = segment !== null ? this.joinPaths(context.basePath, segment) : context.basePath;

    // The rendered element: element={JSX}, Component={Identifier}, or lazy.
    const elementInit = objectProperty(route, "element");
    const componentInit = objectProperty(route, "Component");
    const lazyInit = objectProperty(route, "lazy");
    let chain: string[] = [];
    if (elementInit !== undefined) chain = jsxComponentChain(elementInit);
    else if (componentInit !== undefined && Node.isIdentifier(componentInit)) {
      chain = [componentInit.getText()];
    }

    if (children.length > 0) {
      // Parent routes wrap their children: guard-named elements guard,
      // everything else is the nearest layout.
      const childContext = this.wrapContext(context, chain, routePath, segment !== null);
      for (const child of children) this.objectRoute(child, childContext);
      return;
    }

    if (segment === null && !isIndex) return; // pathless leaf with no page
    const loc = this.locOf(route, file);
    if (lazyInit !== undefined) {
      this.emit("react-router", routePath, file, loc, this.resolveDynamicImport(lazyInit), context.layout, context.guards);
      return;
    }
    if (chain.length === 0) return;
    this.emitFromChain("react-router", routePath, file, loc, chain, route, context);
  }

  private jsxRoute(element: JsxElement | JsxSelfClosingElement, context: RouteContext): void {
    const file = this.fileOf(element);
    const opening = Node.isJsxElement(element) ? element.getOpeningElement() : element;

    const pathAttr = jsxAttribute(opening.getAttributes(), "path");
    const segment = pathAttr !== null ? stringAttributeValue(pathAttr) : null;
    const isIndex = jsxAttribute(opening.getAttributes(), "index") !== null;
    const routePath = segment !== null ? this.joinPaths(context.basePath, segment) : context.basePath;

    const elementAttr = jsxAttribute(opening.getAttributes(), "element");
    const componentAttr = jsxAttribute(opening.getAttributes(), "Component");
    let chain: string[] = [];
    const elementExpr = elementAttr?.getInitializer();
    if (elementExpr !== undefined && Node.isJsxExpression(elementExpr)) {
      const inner = elementExpr.getExpression();
      if (inner !== undefined) chain = jsxComponentChain(inner);
    } else if (componentAttr !== null) {
      const init = componentAttr.getInitializer();
      if (init !== undefined && Node.isJsxExpression(init)) {
        const inner = init.getExpression();
        if (inner !== undefined && Node.isIdentifier(inner)) chain = [inner.getText()];
      }
    }

    const childRoutes = Node.isJsxElement(element)
      ? element.getJsxChildren().filter(isRouteJsx)
      : [];
    if (childRoutes.length > 0) {
      const childContext = this.wrapContext(context, chain, routePath, segment !== null);
      for (const child of childRoutes) {
        this.jsxRoute(child as JsxElement | JsxSelfClosingElement, childContext);
      }
      return;
    }

    if (segment === null && !isIndex) return;
    if (chain.length === 0) return;
    this.emitFromChain("react-router", routePath, file, this.locOf(element, file), chain, element, context);
  }

  /** Fold a parent route's element chain into the context its children see. */
  private wrapContext(
    context: RouteContext,
    chain: string[],
    routePath: string,
    hasSegment: boolean,
  ): RouteContext {
    let layout = context.layout;
    const guards = [...context.guards];
    for (const name of chain) {
      if (GUARD_NAME.test(name)) guards.push(name);
      else layout = name; // nearest layout wins
    }
    return { basePath: hasSegment ? routePath : context.basePath, layout, guards };
  }

  /** Innermost chain entry is the page; outer wrappers become guards/layout. */
  private emitFromChain(
    router: RouterKind,
    routePath: string,
    file: string,
    loc: SourceLocation,
    chain: string[],
    at: Node,
    context: RouteContext,
  ): void {
    const pageName = chain[chain.length - 1];
    if (pageName === undefined) return;
    let layout = context.layout;
    const guards = [...context.guards];
    for (const wrapper of chain.slice(0, -1)) {
      if (GUARD_NAME.test(wrapper)) guards.push(wrapper);
      else layout = wrapper;
    }
    this.emit(router, routePath, file, loc, this.resolveComponentName(pageName, at), layout, guards);
  }

  // -------------------------------------------------------------- Next.js

  nextAppRouter(): void {
    for (const sourceFile of this.project.getSourceFiles()) {
      const file = this.fileOf(sourceFile);
      const parsed = appRouterPath(file);
      if (parsed === null) continue;
      const page = this.defaultExportComponent(file);
      this.emit(
        "nextjs-app",
        parsed,
        file,
        { file, line: 1, endLine: 1 },
        page,
        this.nearestAppLayout(file),
        [],
      );
    }
  }

  nextPagesRouter(): void {
    for (const sourceFile of this.project.getSourceFiles()) {
      const file = this.fileOf(sourceFile);
      const parsed = pagesRouterPath(file);
      if (parsed === null) continue;
      this.emit(
        "nextjs-pages",
        parsed,
        file,
        { file, line: 1, endLine: 1 },
        this.defaultExportComponent(file),
        null,
        [],
      );
    }
  }

  private defaultExportComponent(file: string): string | null {
    for (const node of this.nodes.values()) {
      if (node.kind === "component" && node.loc.file === file && node.exportName === "default") {
        return node.id;
      }
    }
    return null;
  }

  /** Walk up from the page's directory to app/ looking for layout files. */
  private nearestAppLayout(pageFile: string): string | null {
    let dir = pageFile.slice(0, pageFile.lastIndexOf("/"));
    while (dir.length > 0) {
      for (const candidate of ["layout.tsx", "layout.jsx", "layout.ts", "layout.js"]) {
        const layoutFile = `${dir}/${candidate}`;
        const layout = this.defaultExportComponent(layoutFile);
        if (layout !== null) {
          const node = this.nodes.get(layout);
          return node !== undefined ? node.name : null;
        }
      }
      const lastSegmentAt = dir.lastIndexOf("/");
      if (dir === "app" || dir.endsWith("/app") || lastSegmentAt === -1) break;
      dir = dir.slice(0, lastSegmentAt);
    }
    return null;
  }
}

// ------------------------------------------------------------------ helpers

function normalizePath(p: string): string {
  const collapsed = `/${p}`.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

function objectProperty(objectLiteral: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(objectLiteral)) return undefined;
  const property = objectLiteral.getProperty(name);
  if (property !== undefined && Node.isPropertyAssignment(property)) {
    return property.getInitializer();
  }
  if (property !== undefined && Node.isShorthandPropertyAssignment(property)) {
    return property.getNameNode();
  }
  if (property !== undefined && Node.isMethodDeclaration(property)) {
    return property; // lazy() {} method shorthand
  }
  return undefined;
}

function jsxAttribute(attributes: Node[], name: string): JsxAttribute | null {
  for (const attr of attributes) {
    if (Node.isJsxAttribute(attr) && attr.getNameNode().getText() === name) return attr;
  }
  return null;
}

function stringAttributeValue(attr: JsxAttribute): string | null {
  const init = attr.getInitializer();
  if (init !== undefined && Node.isStringLiteral(init)) return init.getLiteralValue();
  if (init !== undefined && Node.isJsxExpression(init)) {
    const inner = init.getExpression();
    if (inner !== undefined && Node.isStringLiteral(inner)) return inner.getLiteralValue();
  }
  return null;
}

/**
 * <RequireAuth><Users/></RequireAuth> → ["RequireAuth", "Users"]:
 * outermost-to-innermost capitalized tags, following single-component nesting.
 */
function jsxComponentChain(expr: Node): string[] {
  const chain: string[] = [];
  let current: Node | undefined = expr;
  while (current !== undefined) {
    if (Node.isJsxSelfClosingElement(current)) {
      pushComponentTag(chain, current.getTagNameNode().getText());
      break;
    }
    if (!Node.isJsxElement(current)) break;
    pushComponentTag(chain, current.getOpeningElement().getTagNameNode().getText());
    const jsxChildren: JsxChild[] = current.getJsxChildren();
    const componentChildren: Node[] = jsxChildren.filter(
      (child) => Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child),
    );
    current = componentChildren.length === 1 ? componentChildren[0] : undefined;
  }
  return chain;
}

function pushComponentTag(chain: string[], tagName: string): void {
  const head = tagName.split(".")[0];
  if (head !== undefined && /^[A-Z]/.test(head)) chain.push(tagName);
}

function isRouteJsx(node: Node): boolean {
  if (Node.isJsxSelfClosingElement(node)) {
    return node.getTagNameNode().getText() === "Route";
  }
  return (
    Node.isJsxElement(node) &&
    node.getOpeningElement().getTagNameNode().getText() === "Route"
  );
}

function routeJsxElements(sourceFile: SourceFile): Array<JsxElement | JsxSelfClosingElement> {
  const elements: Array<JsxElement | JsxSelfClosingElement> = [];
  for (const el of sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement)) {
    if (isRouteJsx(el)) elements.push(el);
  }
  for (const el of sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) {
    if (isRouteJsx(el)) elements.push(el);
  }
  return elements;
}

function hasRouteAncestor(element: Node): boolean {
  let current = element.getParent();
  while (current !== undefined) {
    if (isRouteJsx(current)) return true;
    current = current.getParent();
  }
  return false;
}

/** Identifier usages of `name` within (or nearest to) the given node. */
function identifiersNamed(at: Node, name: string): Identifier[] {
  const matches: Identifier[] = [];
  if (Node.isIdentifier(at) && at.getText() === name) matches.push(at);
  for (const identifier of at.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (identifier.getText() === name) matches.push(identifier);
  }
  if (matches.length === 0) {
    // Next.js paths carry no identifier; scan the file's top level instead.
    for (const identifier of at.getSourceFile().getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (identifier.getText() === name) matches.push(identifier);
    }
  }
  return matches;
}

/** "app/users/[userId]/page.tsx" → "/users/:userId"; null for non-page files. */
function appRouterPath(file: string): string | null {
  const match = /^(?:src\/)?app\/(.*)$/.exec(file);
  if (match === null || match[1] === undefined) return null;
  const segments = match[1].split("/");
  const basename = segments.pop();
  if (basename === undefined || !/^page\.(tsx|jsx|ts|js)$/.test(basename)) return null;
  const mapped = segments
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"))
    .map(mapDynamicSegment);
  return normalizePath(mapped.join("/"));
}

/** "pages/users/[id].tsx" → "/users/:id"; null for _app/_document/api/**. */
function pagesRouterPath(file: string): string | null {
  const match = /^(?:src\/)?pages\/(.*)$/.exec(file);
  if (match === null || match[1] === undefined) return null;
  const withoutExtension = match[1].replace(/\.(tsx|jsx|ts|js)$/, "");
  if (withoutExtension === match[1]) return null; // not a scannable extension
  const segments = withoutExtension.split("/");
  if (segments[0] === "api") return null;
  if (segments.some((segment) => segment.startsWith("_"))) return null;
  if (segments[segments.length - 1] === "index") segments.pop();
  return normalizePath(segments.map(mapDynamicSegment).join("/"));
}

/** [id] → :id · [...slug] and [[...slug]] → :slug* */
function mapDynamicSegment(segment: string): string {
  const catchAll = /^\[{1,2}\.\.\.(\w+)\]{1,2}$/.exec(segment);
  if (catchAll !== null) return `:${catchAll[1]}*`;
  const param = /^\[(\w+)\]$/.exec(segment);
  if (param !== null) return `:${param[1]}`;
  return segment;
}
