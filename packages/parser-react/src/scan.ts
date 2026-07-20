import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type DataSourceKind,
  type EdgeCondition,
  instanceId,
  type InstanceNode,
  type LineageEdge,
  type LineageGraph,
  type LineageNode,
  nodeId,
  type RenderedText,
  type ResponseType,
  type SourceLocation,
  type StructuralSignature,
} from "@coderadar/core";
import {
  type ArrowFunction,
  type CallExpression,
  FileSystemRefreshResult,
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
import { decodeEntities } from "./entities.js";
import { GRAPHQL_HOOKS, graphqlOperationFromArg } from "./graphql.js";
import { detectPushChannel } from "./pushchannels.js";
import { i18nRenderedText, type I18nOptions, loadLocaleTable, type LocaleTable } from "./i18n.js";
import { linkOpenApiResponses, loadOpenApi, responseFromCall } from "./response.js";
import { detectRoutes } from "./routes.js";
import { detectTests, isTestFile } from "./tests.js";
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
  /**
   * Extra feature-flag call names beyond the defaults (useFlag, useFeature,
   * isEnabled, …). A `renders`/`handles` edge gated behind one of these — or a
   * role check — carries an EdgeCondition so journeys read "… [flag] step"
   * (TRACKER step 3.5, failure modes G5/B5).
   */
  featureFlags?: string[];
  /**
   * Path (relative to `root`) to an OpenAPI 3 JSON spec. When set, data sources
   * whose response type can't be recovered from the code are matched to the
   * spec by endpoint + method, so lineage entries still carry a response shape
   * (TRACKER step 5.5, failure mode F4).
   */
  openapi?: string;
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
const TOAST_CALLEES = /^(toast(\.\w+)?|enqueueSnackbar|message\.(success|error|info|warning))$/;
/** Hotkey-library hooks whose (keys, handler) registration becomes an event (3.4). */
const HOTKEY_HOOKS = new Set([
  "useHotkeys",
  "useHotkey",
  "useKeyboardShortcut",
  "useKey",
  "useKeyPress",
]);
/** Form components whose `onSubmit` prop is a real submit handler (Formik, 3.4). */
const FORM_TAGS = new Set(["Formik", "Form"]);
/** Default feature-flag call names classified as `flag` conditions (3.5). */
const DEFAULT_FLAG_CALLEES = [
  "useFlag",
  "useFeature",
  "useFeatureFlag",
  "useFlags",
  "isEnabled",
  "isFeatureEnabled",
  "hasFeature",
  "featureEnabled",
];
/** Heuristic for role/permission guards classified as `role` conditions (3.5). */
const ROLE_PATTERN = /\brole\b|\bisAdmin\b|\bisSuperuser\b|hasRole|hasPermission|\bcan\(|\bpermission|useRole|usePermission/i;

/**
 * Next.js pages-router server-data functions (7.2, C9). These run on the server
 * and fetch the data the page renders; their fetches feed the file's default-
 * export page component, so they are attributed to it (they are not components
 * or hooks, so the normal body walk skips them).
 */
const NEXT_DATA_FNS: ReadonlySet<string> = new Set([
  "getServerSideProps",
  "getStaticProps",
  "getStaticPaths",
]);

/** The include globs a scan discovers source files with. */
function scanInclude(options: ScanOptions): string[] {
  return options.include ?? ["**/*.tsx", "**/*.jsx", "**/*.ts"];
}

/** Add the source files matching the include globs (excluding node_modules and .d.ts). */
function addProjectFiles(project: Project, root: string, include: string[]): void {
  for (const pattern of include) {
    project.addSourceFilesAtPaths([
      path.join(root, pattern),
      `!${path.join(root, "**/node_modules/**")}`,
      `!${path.join(root, "**/*.d.ts")}`,
    ]);
  }
}

/**
 * Build the ts-morph project for a scan and load its files. Honors the scanned
 * app's own tsconfig (6F.3, failure mode A5/C1): its baseUrl/paths make alias
 * imports ("@ui") resolvable, the difference between linking an instance to its
 * definition and dropping the usage. File discovery stays ours
 * (skipAddingFilesFromTsConfig). Separated from analysis so an incremental
 * re-scan (6.1) can keep one project alive and refresh only changed files.
 */
export function createScanProject(options: ScanOptions): { project: Project; root: string } {
  const root = path.resolve(options.root);
  const tsConfigFilePath = path.join(root, "tsconfig.json");
  const project = new Project({
    ...(fs.existsSync(tsConfigFilePath) ? { tsConfigFilePath } : {}),
    compilerOptions: { allowJs: true, jsx: 4 /* ReactJSX */ },
    skipAddingFilesFromTsConfig: true,
  });
  addProjectFiles(project, root, scanInclude(options));
  return { project, root };
}

/**
 * Per-file content hashes (relative posix path → sha256) for every source file
 * in a project (6.1). Populates `GraphMeta.fileHashes` so a later `--update`
 * knows exactly which files changed. Sorted keys for deterministic output.
 */
export function projectFileHashes(project: Project, root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sourceFile of sortedSourceFiles(project)) {
    const rel = toPosix(path.relative(root, sourceFile.getFilePath()));
    out[rel] = createHash("sha256").update(sourceFile.getFullText()).digest("hex");
  }
  return out;
}

/** Scan a directory of React source and produce a lineage graph. */
export function scanReact(options: ScanOptions): LineageGraph {
  const { project, root } = createScanProject(options);
  return scanProject(project, root, options);
}

/**
 * Run the full analysis over an already-built project (6.1). `scanReact` is
 * `scanProject(createScanProject(...))`; the incremental scanner reuses the
 * project across edits, so the result of an incremental update is byte-identical
 * to a fresh full scan (every cross-file pass re-derives from current ASTs).
 */
export function scanProject(project: Project, root: string, options: ScanOptions): LineageGraph {
  const baseUrls = options.baseUrls ?? [];
  const flagCallees = new Set<string>([...DEFAULT_FLAG_CALLEES, ...(options.featureFlags ?? [])]);

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
  const stores = detectStores(project, root, nodes, addEdge, baseUrls, wrappers);
  /** Event node id → the handler expressions it wires, mined for effects (3.2). */
  const handlerExprs = new Map<string, Node[]>();
  /** Files classified machine-generated (6.5, D5) — kept in lineage, excluded from matching. */
  const generatedFiles = new Set<string>();

  for (const sourceFile of sortedSourceFiles(project)) {
    const file = toPosix(path.relative(root, sourceFile.getFilePath()));
    if (isGeneratedFile(file, sourceFile.getFullText())) generatedFiles.add(file);
    // Test files are swept separately (5.4) — they exercise components, they
    // don't define the app's UI, so they must not produce component/hook nodes.
    if (isTestFile(file)) continue;
    // The file's default-export page and any Next.js server-data functions,
    // resolved together so the latter's fetches attribute to the former (7.2).
    let pageComponentId: string | undefined;
    const nextDataFns: { name: string; fn: Node }[] = [];
    for (const decl of collectDeclarations(sourceFile, file)) {
      if (NEXT_DATA_FNS.has(decl.name)) {
        nextDataFns.push({ name: decl.name, fn: decl.fn });
        continue;
      }
      const isComponent = COMPONENT_NAME.test(decl.name) && returnsJsx(decl.fn);
      const isHook = HOOK_NAME.test(decl.name);
      if (!isComponent && !isHook) continue;

      const kind = isComponent ? "component" : "hook";
      const id = nodeId(kind, file, decl.name);
      if (isComponent && decl.exportName === "default") pageComponentId = id;

      if (isComponent) {
        // Portal components (A9): rendered into document.body etc., far from
        // where they're triggered — flagged so agents know the screenshot's
        // DOM position won't match the render-tree position.
        const usesPortal = decl.fn
          .getDescendantsOfKind(SyntaxKind.CallExpression)
          .some((c) => /^(ReactDOM\.)?createPortal$/.test(c.getExpression().getText()));
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
          structure: extractStructure(decl.fn),
          ...(usesPortal ? { flags: ["portal"] } : {}),
        });
        collectInstanceSites(decl.fn, id, file, pendingInstances);
      } else {
        nodes.set(id, { id, kind: "hook", name: decl.name, loc: decl.loc, exportName: decl.exportName });
      }

      extractBodyFacts(decl.name, decl.fn, id, file, nodes, addEdge, baseUrls, wrappers, stores, handlerExprs, flagCallees);
    }

    // Next.js server data (7.2, C9): a page's getServerSideProps/getStaticProps
    // fetches on the server; those data sources feed the default-export page,
    // so attribute them to it. (RSC async server components fetch in their own
    // body and are already covered by the walk above.)
    if (pageComponentId !== undefined) {
      for (const { name, fn } of nextDataFns) {
        extractBodyFacts(name, fn, pageComponentId, file, nodes, addEdge, baseUrls, wrappers, stores, handlerExprs, flagCallees);
      }
    }

    scanClassComponents(sourceFile, file, nodes, addEdge, baseUrls, wrappers, localeTable, pendingInstances, stores, handlerExprs, flagCallees);
    collectHocAliases(sourceFile, hocAliases);
  }

  const instanceIds = materializeInstances(
    pendingInstances,
    nodes,
    addEdge,
    hocAliases,
    options.designSystemPackages ?? [],
    root,
    flagCallees,
  );
  resolvePropFlow(pendingInstances, instanceIds, nodes, edges, addEdge, baseUrls, wrappers);
  // Routes first: navigate() effects (3.2) join to RouteNodes by path shape.
  detectRoutes(project, root, nodes, addEdge);
  resolveHandlerChains(
    pendingInstances,
    instanceIds,
    nodes,
    edges,
    addEdge,
    baseUrls,
    wrappers,
    stores,
    handlerExprs,
    root,
  );
  // Tests last: components must exist before we can attach coverage to them.
  detectTests(project, root, nodes, addEdge);
  // OpenAPI fills response types the code didn't spell out (5.5, F4).
  if (options.openapi !== undefined) {
    const openApi = loadOpenApi(root, options.openapi);
    if (openApi !== null) linkOpenApiResponses(nodes, openApi);
  }

  // Mark nodes defined in machine-generated files (6.5, D5). Done as a post-pass
  // so it covers function components, class components, and hooks uniformly
  // regardless of which extractor emitted them. The `generated` flag is what the
  // matcher reads to keep these out of candidate ranking while leaving their
  // data-source lineage intact.
  if (generatedFiles.size > 0) {
    for (const node of nodes.values()) {
      if ((node.kind === "component" || node.kind === "hook") && generatedFiles.has(node.loc.file)) {
        node.flags = [...(node.flags ?? []), "generated"];
      }
    }
  }

  return {
    version: 2,
    root,
    generatedAt: new Date().toISOString(),
    generator: "ui-lineage@0.6.0",
    // Canonical output order (6.3, G8): sort nodes and edges by stable keys so
    // the serialized graph is byte-identical across runs and machines. Node ids
    // are unique; edges are keyed by every identifying field. The query side
    // addresses nodes by id, so array order carries no semantics — only
    // reproducibility.
    nodes: [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: edges.sort((a, b) => {
      const ka = edgeSortKey(a);
      const kb = edgeSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }),
  };
}

/** Total-order key over an edge's identifying fields (6.3, G8). */
function edgeSortKey(e: LineageEdge): string {
  return [e.kind, e.from, e.to, e.via ?? "", e.condition?.kind ?? "", e.condition?.expression ?? ""].join(
    " ",
  );
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Source files in a stable path order (6.3, G8). ts-morph returns files in glob
 * enumeration order, which varies across platforms and filesystems; every pass
 * that builds nodes/edges must iterate deterministically so two scans of the
 * same tree agree byte-for-byte.
 */
function sortedSourceFiles(project: Project): SourceFile[] {
  return [...project.getSourceFiles()].sort((a, b) => {
    const pa = a.getFilePath();
    const pb = b.getFilePath();
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
}

/**
 * Codegen path shapes (6.5, D5): a `__generated__/` or `generated/` directory
 * segment, or a `.generated.` / `.gen.` filename infix. Case-insensitive.
 */
const GENERATED_PATH = /(^|\/)(__generated__|generated)(\/|$)|\.(generated|gen)\.[jt]sx?$/i;

/**
 * Banner comments codegen tools emit at the top of a file: the `@generated`
 * docblock tag, the Go-style "Code generated … DO NOT EDIT" line, or a bare
 * "DO NOT EDIT" / "AUTO-GENERATED" marker.
 */
const GENERATED_BANNER = /@generated\b|DO NOT EDIT|AUTO-?GENERATED/i;

/** A single line this long is a sourcemap-less minified bundle, not authored source. */
const MINIFIED_LINE = 3000;

/**
 * True when a file is machine-generated (6.5, D5) — by path shape, a top-of-file
 * banner, or minification. Generated code is retained in the graph as lineage /
 * API metadata but excluded from match candidates: it is not authored UI, so a
 * screenshot or ticket should never resolve to it.
 */
function isGeneratedFile(relPath: string, text: string): boolean {
  if (GENERATED_PATH.test(relPath)) return true;
  // Banners live in the first lines; only scan the head so a stray "DO NOT EDIT"
  // deep in a hand-written file doesn't misclassify it.
  if (GENERATED_BANNER.test(text.slice(0, 2000))) return true;
  // Minified: any single line past the threshold. Real source wraps long before.
  let lineStart = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text.charCodeAt(i) === 10 /* \n */) {
      if (i - lineStart >= MINIFIED_LINE) return true;
      lineStart = i + 1;
    }
  }
  return false;
}

/** Spread helper: emit a `responseType` field only when one was recovered (5.5). */
function responseTypeProp(rt: ResponseType | null): { responseType?: ResponseType } {
  return rt !== null ? { responseType: rt } : {};
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

  // JSX text and quoted attribute values are HTML-decoded by React at render
  // time, so decode entities here too (failure mode A16) — otherwise `&nbsp;`,
  // `&gt;`, `&#34;` survive as junk tokens ("nbsp", "gt", "34"). JS string and
  // template literals below are NOT JSX-decoded, so they stay untouched.
  for (const jsxText of fn.getDescendantsOfKind(SyntaxKind.JsxText)) {
    const text = decodeEntities(jsxText.getText()).replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    add({ text, source: "jsx", ...branchTag(jsxText, fn) });
  }

  for (const attr of fn.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (!TEXT_ATTRIBUTES.has(attr.getNameNode().getText())) continue;
    const init = attr.getInitializer();
    if (init !== undefined && Node.isStringLiteral(init)) {
      const text = decodeEntities(init.getLiteralValue()).trim();
      if (text.length > 0) add({ text, source: "attribute", ...branchTag(attr, fn) });
    }
  }

  // Toast/notification calls (A9): toast("Order deleted") renders via a portal
  // mounted elsewhere — the text belongs to the CALLING component for matching.
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!TOAST_CALLEES.test(call.getExpression().getText())) continue;
    const arg = call.getArguments()[0];
    if (arg !== undefined && Node.isStringLiteral(arg)) {
      const text = arg.getLiteralValue().trim();
      if (text.length > 0) add({ text, source: "portal", ...branchTag(call, fn) });
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

/**
 * The flag/role condition guarding a rendered instance or a wired event
 * (TRACKER step 3.5). Walks the enclosing branches up to the component
 * boundary; returns the nearest one that is a feature-flag call or a role
 * check, so its `renders`/`handles` edge (and any journey step through it)
 * carries the flag/role. Undefined when the guard is a plain condition.
 */
function edgeCondition(node: Node, flagCallees: ReadonlySet<string>): EdgeCondition | undefined {
  const boundary = node.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isArrowFunction(a) ||
      Node.isFunctionExpression(a) ||
      Node.isMethodDeclaration(a),
  );
  let current: Node | undefined = node;
  while (current !== undefined && current !== boundary) {
    const parent: Node | undefined = current.getParent();
    if (parent === undefined) break;
    let test: Node | undefined;
    let negate = false;
    if (Node.isConditionalExpression(parent)) {
      if (parent.getWhenTrue() === current) test = parent.getCondition();
      else if (parent.getWhenFalse() === current) {
        test = parent.getCondition();
        negate = true;
      }
    } else if (
      Node.isBinaryExpression(parent) &&
      parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken &&
      parent.getRight() === current
    ) {
      test = parent.getLeft();
    } else if (Node.isIfStatement(parent) && parent.getThenStatement() === current) {
      test = parent.getExpression();
    }
    if (test !== undefined) {
      const condition = classifyTest(test, flagCallees);
      if (condition !== undefined) {
        return negate ? { ...condition, expression: `!(${condition.expression})` } : condition;
      }
    }
    current = parent;
  }
  return undefined;
}

/** Classify a guard's test expression as a feature-flag or role condition. */
function classifyTest(test: Node, flagCallees: ReadonlySet<string>): EdgeCondition | undefined {
  const text = test.getText();
  for (const callee of flagCallees) {
    if (new RegExp(`\\b${callee}\\s*\\(`).test(text)) return { kind: "flag", expression: text };
  }
  // A flag hook result used as a bare boolean: `const beta = useFlag("beta")`.
  if (Node.isIdentifier(test)) {
    for (const definition of test.getDefinitionNodes()) {
      if (!Node.isVariableDeclaration(definition)) continue;
      const init = definition.getInitializer();
      if (init === undefined || !Node.isCallExpression(init)) continue;
      const callee = init.getExpression().getText();
      const name = callee.includes(".") ? (callee.split(".").pop() ?? callee) : callee;
      if (flagCallees.has(name)) return { kind: "flag", expression: `${text} (${init.getText()})` };
    }
  }
  if (ROLE_PATTERN.test(text)) return { kind: "role", expression: text };
  return undefined;
}

/**
 * Structural fingerprint of a component's rendered JSX (TRACKER step 4.2):
 * counts of tables, columns, forms, inputs, etc., folding raw DOM tags and
 * common design-system component names into the same buckets so a screenshot
 * with little text still matches on shape (failure modes A1/A3/A12).
 */
function emptyStructure(): StructuralSignature {
  return {
    table: 0,
    columns: 0,
    form: 0,
    input: 0,
    button: 0,
    link: 0,
    image: 0,
    heading: 0,
    list: 0,
    repeated: 0,
  };
}

function extractStructure(fn: Node): StructuralSignature {
  const sig = emptyStructure();
  let thCount = 0;
  const tags = [
    ...fn.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...fn.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];
  for (const el of tags) {
    const raw = el.getTagNameNode().getText();
    const tag = raw.split(".").pop() ?? raw;
    const lower = tag.toLowerCase();
    if (lower === "table" || /^(data)?(table|grid|datagrid)$/.test(lower)) sig.table += 1;
    else if (lower === "form" || tag === "Formik") sig.form += 1;
    else if (
      lower === "input" ||
      lower === "select" ||
      lower === "textarea" ||
      /^(textfield|input|select|checkbox|radio|switch|datepicker)$/.test(lower)
    )
      sig.input += 1;
    else if (lower === "button" || /^(iconbutton|button)$/.test(lower)) sig.button += 1;
    else if (lower === "a" || tag === "Link" || tag === "NavLink") sig.link += 1;
    else if (lower === "img" || tag === "Image" || tag === "Avatar") sig.image += 1;
    else if (/^h[1-6]$/.test(lower) || tag === "Heading" || tag === "Title") sig.heading += 1;
    else if (lower === "ul" || lower === "ol" || tag === "List") sig.list += 1;
    if (lower === "th") thCount += 1;
  }
  sig.columns = thCount;
  // Repeated items: `.map(cb)` where the callback returns JSX (rows, cards, grid).
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "map") continue;
    const cb = call.getArguments()[0];
    if (cb !== undefined && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb)) && returnsJsx(cb)) {
      sig.repeated += 1;
    }
  }
  return sig;
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
  stores: StoreRegistry,
  handlerExprs: Map<string, Node[]>,
  flagCallees: ReadonlySet<string>,
): void {
  // A wrapper's own body is plumbing: its URL is a parameter placeholder, so a
  // data source emitted here would attribute ":path" to every consumer. Call
  // sites get the real, substituted endpoint instead.
  const declIsWrapper = wrappers.has(declName);

  // Create an EventNode + handles edge and queue its handler for effect mining.
  // Shared by JSX on* props and the non-JSX bindings (forms, listeners, hotkeys).
  const registerEvent = (
    eventName: string,
    handlerNode: Node | undefined,
    source: "jsx" | "form" | "effect" | "hotkey",
    at: Node,
    flags?: string[],
  ): void => {
    let handler: string | null = null;
    if (
      handlerNode !== undefined &&
      (Node.isIdentifier(handlerNode) || Node.isPropertyAccessExpression(handlerNode))
    ) {
      handler = handlerNode.getText();
    }
    // Inline handlers (no name) at different call sites are distinct events —
    // disambiguate by line so their conditions and effects don't collapse.
    const atLoc = locOf(at, file);
    const suffix = `${handler !== null ? `:${handler}` : `@${atLoc.line}`}${source !== "jsx" ? `@${source}` : ""}`;
    const evId = nodeId("event", file, `${declName}.${eventName}${suffix}`);
    if (!nodes.has(evId)) {
      nodes.set(evId, {
        id: evId,
        kind: "event",
        name: eventName,
        loc: atLoc,
        event: eventName,
        handler,
        ...(source !== "jsx" ? { source } : {}),
        ...(flags !== undefined && flags.length > 0 ? { flags } : {}),
      });
    }
    if (handlerNode !== undefined) {
      const list = handlerExprs.get(evId);
      if (list) list.push(handlerNode);
      else handlerExprs.set(evId, [handlerNode]);
    }
    const condition = edgeCondition(at, flagCallees);
    addEdge({ from: ownerId, to: evId, kind: "handles", ...(condition ? { condition } : {}) });
  };

  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();

    // Non-JSX event bindings (TRACKER 3.4): addEventListener (usually in an
    // effect) and hotkey-library registrations become events; an unresolvable
    // event type is flagged "unscanned-events" rather than dropped.
    if (callee === "addEventListener" || callee.endsWith(".addEventListener")) {
      const args = call.getArguments();
      const type = resolveStringValue(args[0], 0);
      registerEvent(type ?? "unknown", args[1], "effect", call, type === null ? ["unscanned-events"] : undefined);
      continue;
    }
    if (HOTKEY_HOOKS.has(callee)) {
      const args = call.getArguments();
      const keys = resolveStringValue(args[0], 0);
      registerEvent(keys ?? "unknown", args[1], "hotkey", call, keys === null ? ["unscanned-events"] : undefined);
      continue;
    }

    // Store readers/dispatchers first — useSelector would otherwise fall
    // through to the generic per-component state handling.
    if (callee === "useSelector") {
      const sliceId = selectorSliceId(call, stores);
      if (sliceId !== undefined) {
        addEdge({ from: ownerId, to: sliceId, kind: "reads-state" });
        continue;
      }
    }
    const zustandId = stores.zustandHooks.get(callee);
    if (zustandId !== undefined) {
      addEdge({ from: ownerId, to: zustandId, kind: "reads-state" });
      continue;
    }
    const rtkSource = stores.rtkHooks.get(callee);
    if (rtkSource !== undefined) {
      // const { data } = useGetUsersQuery() — this component consumes the endpoint.
      addEdge({ from: ownerId, to: rtkSource, kind: "fetches-from" });
      continue;
    }
    const thunkSources = stores.thunkSources.get(callee);
    if (thunkSources !== undefined) {
      // dispatch(fetchUsers()) — this component initiates the fetch.
      for (const dsId of thunkSources) {
        addEdge({ from: ownerId, to: dsId, kind: "fetches-from" });
      }
      continue;
    }

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
          ...responseTypeProp(responseFromCall(call)),
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

  // Push channels (7.3, C8): new WebSocket(url) / new EventSource(url) are
  // long-lived server-push data sources, not request/response fetches. A
  // wrapper's own body carries a placeholder URL, so skip it like fetch sources.
  if (!declIsWrapper) {
    for (const expr of body.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const channel = detectPushChannel(expr, baseUrls);
      if (channel === null) continue;
      const dsId = nodeId("data-source", file, `${channel.sourceKind}:${channel.endpoint}`);
      if (!nodes.has(dsId)) {
        nodes.set(dsId, {
          id: dsId,
          kind: "data-source",
          name: channel.endpoint,
          loc: locOf(expr, file),
          sourceKind: channel.sourceKind,
          method: channel.method,
          endpoint: channel.endpoint,
          raw: channel.raw,
          resolved: channel.resolved,
        });
      }
      addEdge({ from: ownerId, to: dsId, kind: "fetches-from" });
    }
  }

  for (const attr of body.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    const attrName = attr.getNameNode().getText();
    // <a href="https://…"> / <Link to="mailto:…"> — a link that leaves the app (B9).
    if (attrName === "href" || attrName === "to") {
      const url = jsxAttrString(attr);
      if (url !== null && isExternalUrl(url)) {
        const ext = ensureExternalNode(nodes, url, locOf(attr, file));
        addEdge({ from: ownerId, to: ext, kind: "exits-app", via: url });
      }
      continue;
    }
    if (!/^on[A-Z]/.test(attrName)) continue;
    const init = attr.getInitializer();
    if (init === undefined || !Node.isJsxExpression(init)) {
      registerEvent(attrName, undefined, "jsx", attr);
      continue;
    }
    let expr: Node | undefined = init.getExpression();
    let source: "jsx" | "form" = "jsx";
    // react-hook-form: onSubmit={handleSubmit(onValid)} — the real handler is
    // the wrapped argument, not the handleSubmit() call itself.
    if (expr !== undefined && Node.isCallExpression(expr)) {
      const callee = expr.getExpression();
      const calleeName = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
      if (calleeName === "handleSubmit") {
        expr = expr.getArguments()[0] ?? expr;
        source = "form";
      }
    }
    // Formik: <Formik onSubmit={onSubmit}> — the onSubmit prop is a submit handler.
    if (source === "jsx" && attrName === "onSubmit" && FORM_TAGS.has(jsxTagName(attr))) {
      source = "form";
    }
    registerEvent(attrName, expr, source, attr);
  }
}

/** The tag name of the JSX element an attribute belongs to (e.g. "Formik"). */
function jsxTagName(attr: Node): string {
  const element = attr.getFirstAncestor(
    (a) => Node.isJsxOpeningElement(a) || Node.isJsxSelfClosingElement(a),
  );
  if (element !== undefined && (Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element))) {
    return element.getTagNameNode().getText();
  }
  return "";
}

/** A JSX attribute's statically-known string value (href="…" / to={CONST}), or null. */
function jsxAttrString(attr: Node): string | null {
  if (!Node.isJsxAttribute(attr)) return null;
  const init = attr.getInitializer();
  if (init === undefined) return null;
  if (Node.isStringLiteral(init)) return init.getLiteralValue();
  if (Node.isJsxExpression(init)) {
    const expr = init.getExpression();
    if (expr !== undefined) return resolveStringValue(expr, 0);
  }
  return null;
}

/** `useSelector((s) => s.users.list)` → the "users" slice's StateNode id. */
function selectorSliceId(call: CallExpression, stores: StoreRegistry): string | undefined {
  const selector = call.getArguments()[0];
  if (selector === undefined || !Node.isArrowFunction(selector)) return undefined;
  const param = selector.getParameters()[0]?.getName();
  if (param === undefined) return undefined;
  const match = new RegExp(`\\b${param}\\.([A-Za-z_$][\\w$]*)`).exec(selector.getBody().getText());
  return match?.[1] !== undefined ? stores.reduxSlices.get(match[1]) : undefined;
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

  // GraphQL (7.1, C4): Apollo/urql hooks reuse `useQuery`/`useMutation`, so this
  // must run before the react-query branch — it only claims the call when the
  // argument is an actual gql document (else it falls through to react-query).
  if (GRAPHQL_HOOKS.has(callee)) {
    const op = graphqlOperationFromArg(call.getArguments()[0]);
    if (op !== null) {
      const identity = op.name ?? op.rootFields[0] ?? "<anonymous>";
      return {
        sourceKind: "graphql",
        method: op.type,
        endpoint: identity,
        raw: (call.getArguments()[0]?.getText() ?? callee).slice(0, 120),
        resolved: op.name !== null ? "full" : op.rootFields.length > 0 ? "partial" : "none",
      };
    }
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

/** Store registry (TRACKER step 2.4, failure mode C6; dispatch effects 3.2). */
interface StoreRegistry {
  /** Redux slice name → its global StateNode id. */
  reduxSlices: Map<string, string>;
  /** Zustand hook name (useCartStore) → its global StateNode id. */
  zustandHooks: Map<string, string>;
  /** createAsyncThunk name → the data-source node ids its payload creator hits. */
  thunkSources: Map<string, string[]>;
  /**
   * Reducer action-creator name (a `reducers` key of a createSlice) → the
   * slice StateNode it mutates. Lets `dispatch(clearCart())` resolve to the
   * cart slice (TRACKER step 3.2, B2 dispatch half).
   */
  actionSlices: Map<string, string>;
  /** createAsyncThunk name → the slice StateNode its extraReducers populate. */
  thunkSlices: Map<string, string>;
  /**
   * RTK Query generated hook name (useGetUsersQuery, usePayInvoiceMutation,
   * useLazy…Query) → the data-source node id its endpoint resolves to (6F.4).
   */
  rtkHooks: Map<string, string>;
}

/**
 * Global stores decouple the reader from the fetch: a component renders
 * `useSelector(s => s.users.list)` while the API call that POPULATED the
 * slice happened at login, in another component. This pass finds the store
 * shapes and wires data-source --writes-state--> slice, so lineage flows
 * reader → slice → populating API.
 */
function detectStores(
  project: Project,
  root: string,
  nodes: Map<string, LineageNode>,
  addEdge: (edge: LineageEdge) => void,
  baseUrls: string[],
  wrappers: WrapperRegistry,
): StoreRegistry {
  const registry: StoreRegistry = {
    reduxSlices: new Map(),
    zustandHooks: new Map(),
    thunkSources: new Map(),
    actionSlices: new Map(),
    thunkSlices: new Map(),
    rtkHooks: new Map(),
  };

  const ensureDataSource = (call: Node, file: string): string | null => {
    if (!Node.isCallExpression(call)) return null;
    const detected = detectDataSource(call, call.getExpression().getText(), baseUrls, wrappers);
    if (detected === null || detected.sourceKind === "react-query" || detected.sourceKind === "swr") {
      return null;
    }
    const dsId = nodeId("data-source", file, `${detected.sourceKind}:${detected.endpoint}`);
    if (!nodes.has(dsId)) {
      nodes.set(dsId, {
        id: dsId,
        kind: "data-source",
        name: detected.endpoint,
        loc: locOf(call, file),
        sourceKind: detected.sourceKind,
        method: detected.method,
        endpoint: detected.endpoint,
        raw: detected.raw,
        resolved: detected.resolved,
        ...responseTypeProp(responseFromCall(call)),
      });
    }
    return dsId;
  };

  // Pass 1: slices, zustand stores, thunks.
  for (const sourceFile of sortedSourceFiles(project)) {
    const file = toPosix(path.relative(root, sourceFile.getFilePath()));
    for (const variable of sourceFile.getVariableDeclarations()) {
      const init = variable.getInitializer();
      if (init === undefined || !Node.isCallExpression(init)) continue;
      const callee = init.getExpression().getText();

      if (callee === "createSlice") {
        const config = init.getArguments()[0];
        const nameInit = config !== undefined ? propertyInitializer(config, "name") : undefined;
        const sliceName =
          nameInit !== undefined && Node.isStringLiteral(nameInit)
            ? nameInit.getLiteralValue()
            : variable.getName();
        const stateId = nodeId("state", file, `slice:${sliceName}`);
        if (!nodes.has(stateId)) {
          nodes.set(stateId, {
            id: stateId,
            kind: "state",
            name: sliceName,
            loc: locOf(variable, file),
            stateKind: "redux",
          });
        }
        registry.reduxSlices.set(sliceName, stateId);
        // Reducer keys are action-creator names: dispatch(clearCart()) writes here.
        const reducers = config !== undefined ? propertyInitializer(config, "reducers") : undefined;
        if (reducers !== undefined && Node.isObjectLiteralExpression(reducers)) {
          for (const property of reducers.getProperties()) {
            const nameNode =
              Node.isPropertyAssignment(property) || Node.isMethodDeclaration(property)
                ? property.getNameNode()
                : Node.isShorthandPropertyAssignment(property)
                  ? property.getNameNode()
                  : undefined;
            if (nameNode !== undefined) registry.actionSlices.set(nameNode.getText(), stateId);
          }
        }
      } else if (callee === "createAsyncThunk") {
        const payloadCreator = init.getArguments()[1];
        const sources: string[] = [];
        if (payloadCreator !== undefined) {
          for (const call of payloadCreator.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const dsId = ensureDataSource(call, file);
            if (dsId !== null) sources.push(dsId);
          }
        }
        registry.thunkSources.set(variable.getName(), sources);
      } else if (callee === "create" && HOOK_NAME.test(variable.getName())) {
        // Zustand: const useCartStore = create((set) => ({ ..., load: async () => { fetch...; set(...) } }))
        const stateId = nodeId("state", file, `store:${variable.getName()}`);
        if (!nodes.has(stateId)) {
          nodes.set(stateId, {
            id: stateId,
            kind: "state",
            name: variable.getName(),
            loc: locOf(variable, file),
            stateKind: "zustand",
          });
        }
        registry.zustandHooks.set(variable.getName(), stateId);
        for (const call of init.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const dsId = ensureDataSource(call, file);
          if (dsId !== null) addEdge({ from: dsId, to: stateId, kind: "writes-state" });
        }
      } else if (callee === "createApi" || callee.endsWith(".injectEndpoints")) {
        // RTK Query API slices (TRACKER 6F.4, failure modes B2/C5): the field
        // run had ~40 injectEndpoints files and 0 data-source nodes.
        rtkEndpoints(init, file, registry, nodes);
      }
    }
  }

  // Pass 2: thunk → slice associations via extraReducers addCase(thunk.fulfilled).
  for (const sourceFile of sortedSourceFiles(project)) {
    for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (!["fulfilled", "rejected", "pending"].includes(access.getName())) continue;
      const thunkName = access.getExpression().getText();
      const sources = registry.thunkSources.get(thunkName);
      if (sources === undefined || sources.length === 0) continue;
      const sliceCall = access.getFirstAncestor(
        (a) => Node.isCallExpression(a) && a.getExpression().getText() === "createSlice",
      );
      if (sliceCall === undefined || !Node.isCallExpression(sliceCall)) continue;
      const config = sliceCall.getArguments()[0];
      const nameInit = config !== undefined ? propertyInitializer(config, "name") : undefined;
      if (nameInit === undefined || !Node.isStringLiteral(nameInit)) continue;
      const stateId = registry.reduxSlices.get(nameInit.getLiteralValue());
      if (stateId === undefined) continue;
      // dispatch(fetchUsers()) writes this slice (via the thunk's fulfilled case).
      registry.thunkSlices.set(thunkName, stateId);
      for (const dsId of sources) {
        addEdge({ from: dsId, to: stateId, kind: "writes-state" });
      }
    }
  }

  return registry;
}

/**
 * RTK Query extraction (TRACKER 6F.4, failure modes B2/C5). `createApi`
 * declares the base (a `fetchBaseQuery` baseUrl) and optionally endpoints;
 * `api.injectEndpoints` adds endpoints to an imported base from any file.
 * Every `builder.query`/`builder.mutation` becomes a data source whose
 * endpoint joins the base's baseUrl, and its generated hooks
 * (`useGetUsersQuery`, `usePayInvoiceMutation`, `useLazy…Query`) register so
 * component call sites wire `fetches-from` edges.
 */
function rtkEndpoints(
  init: CallExpression,
  file: string,
  registry: StoreRegistry,
  nodes: Map<string, LineageNode>,
): void {
  const base = rtkBaseCall(init, 0);
  if (base === null) return;
  const baseUrl = rtkBaseUrl(base);

  const config = init.getArguments()[0];
  const endpointsFn = config !== undefined ? propertyInitializer(config, "endpoints") : undefined;
  const endpointsObject = returnedExpression(endpointsFn);
  if (endpointsObject === undefined || !Node.isObjectLiteralExpression(endpointsObject)) return;

  for (const property of endpointsObject.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue;
    const endpointCall = property.getInitializer();
    if (endpointCall === undefined || !Node.isCallExpression(endpointCall)) continue;
    const builderExpr = endpointCall.getExpression();
    if (!Node.isPropertyAccessExpression(builderExpr)) continue;
    const opKind = builderExpr.getName();
    if (opKind !== "query" && opKind !== "mutation") continue;

    const endpointConfig = endpointCall.getArguments()[0];
    const queryFn =
      endpointConfig !== undefined ? propertyInitializer(endpointConfig, "query") : undefined;
    const returned = returnedExpression(queryFn);
    let urlNode: Node | undefined = returned;
    let method = opKind === "mutation" ? "POST" : "GET";
    if (returned !== undefined && Node.isObjectLiteralExpression(returned)) {
      urlNode = propertyInitializer(returned, "url");
      const methodValue = resolveStringValue(propertyInitializer(returned, "method"), 0);
      if (methodValue !== null) method = methodValue.toUpperCase();
    }
    const resolved = resolveEndpoint(urlNode, []);
    const endpoint =
      resolved.resolved === "none" ? resolved.endpoint : joinBaseUrl(baseUrl, resolved.endpoint);

    const dsId = nodeId("data-source", file, `rtk-query:${endpoint}`);
    if (!nodes.has(dsId)) {
      nodes.set(dsId, {
        id: dsId,
        kind: "data-source",
        name: endpoint,
        loc: locOf(property, file),
        sourceKind: "rtk-query",
        method,
        endpoint,
        raw: resolved.raw,
        resolved: resolved.resolved,
      });
    }
    const pascal = property.getName().charAt(0).toUpperCase() + property.getName().slice(1);
    registry.rtkHooks.set(`use${pascal}${opKind === "query" ? "Query" : "Mutation"}`, dsId);
    if (opKind === "query") registry.rtkHooks.set(`useLazy${pascal}Query`, dsId);
  }
}

/**
 * Resolve `createApi(...)` for an api expression: the call itself, or —
 * for `api.injectEndpoints(...)` — the (possibly imported) receiver's
 * declaration, following chained injectEndpoints up to a small hop budget.
 */
function rtkBaseCall(init: CallExpression, hop: number): CallExpression | null {
  if (hop > 3) return null;
  const expr = init.getExpression();
  if (expr.getText() === "createApi") return init;
  if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "injectEndpoints") return null;
  const receiver = expr.getExpression();
  if (!Node.isIdentifier(receiver)) return null;
  for (const declaration of receiver.getDefinitionNodes()) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const declInit = declaration.getInitializer();
    if (declInit === undefined || !Node.isCallExpression(declInit)) continue;
    const found = rtkBaseCall(declInit, hop + 1);
    if (found !== null) return found;
  }
  return null;
}

/** The baseUrl configured on a createApi's fetchBaseQuery, or "". */
function rtkBaseUrl(createApiCall: CallExpression): string {
  const config = createApiCall.getArguments()[0];
  const baseQuery = config !== undefined ? propertyInitializer(config, "baseQuery") : undefined;
  if (baseQuery === undefined || !Node.isCallExpression(baseQuery)) return "";
  const baseConfig = baseQuery.getArguments()[0];
  const url = baseConfig !== undefined ? propertyInitializer(baseConfig, "baseUrl") : undefined;
  return resolveStringValue(url, 0) ?? "";
}

/** The expression an arrow/function initializer returns (block and paren aware). */
function returnedExpression(fn: Node | undefined): Node | undefined {
  if (fn === undefined || (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn))) {
    return undefined;
  }
  const body = fn.getBody();
  const expression = Node.isBlock(body)
    ? body.getStatements().find(Node.isReturnStatement)?.getExpression()
    : body;
  let unwrapped = expression;
  while (unwrapped !== undefined && Node.isParenthesizedExpression(unwrapped)) {
    unwrapped = unwrapped.getExpression();
  }
  return unwrapped;
}

function joinBaseUrl(base: string, endpoint: string): string {
  if (base === "") return endpoint;
  return `${base.replace(/\/+$/, "")}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
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
  stores: StoreRegistry,
  handlerExprs: Map<string, Node[]>,
  flagCallees: ReadonlySet<string>,
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
        structure: emptyStructure(),
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
      structure: extractStructure(render),
    });
    collectInstanceSites(render, id, file, pendingInstances);
    // Whole class body: lifecycle fetches (componentDidMount etc.) + render events.
    extractBodyFacts(name, cls, id, file, nodes, addEdge, baseUrls, wrappers, stores, handlerExprs, flagCallees);
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
  flagCallees: ReadonlySet<string>,
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

    // Same file first, then a lazy-wrapper variable, then unique-name fallback.
    const resolvedName = resolveAlias(pending.tagName);
    const sameFile = nodeId("component", pending.file, resolvedName);
    if (nodes.has(sameFile)) return { definitionId: sameFile, external: false };
    const lazy = lazyDefinition(sourceFile, pending.tagName);
    if (lazy !== null) return lazy;
    const global = definitionsByName.get(resolvedName);
    return global !== undefined ? { definitionId: global, external: false } : null;
  };

  /**
   * <Users/> where Users = Loadable(lazy(() => import("./pages/UsersPage")))
   * or React.lazy(() => import(...)): unwrap the wrapper chain to the dynamic
   * import and resolve the target module's default export (6F.3 — the field
   * app wrapped every page this way).
   */
  function lazyDefinition(
    sourceFile: SourceFile,
    tagName: string,
  ): { definitionId: string; external: boolean } | null {
    const variable = sourceFile.getVariableDeclaration(tagName);
    const initializer = variable?.getInitializer();
    if (initializer === undefined || !Node.isCallExpression(initializer)) return null;
    const importCall = [initializer, ...initializer.getDescendantsOfKind(SyntaxKind.CallExpression)]
      .find((call) => call.getExpression().getKind() === SyntaxKind.ImportKeyword);
    const specifier = importCall?.getArguments()[0];
    if (specifier === undefined || !Node.isStringLiteral(specifier)) return null;
    // The compiler binds a resolvable specifier to its module symbol; fall
    // back to relative resolution against the importing file for odd setups.
    const target =
      specifier.getSymbol()?.getDeclarations().find(Node.isSourceFile) ??
      resolveRelativeModule(sourceFile, specifier.getLiteralText());
    if (target === undefined) return null;
    for (const declaration of target.getExportedDeclarations().get("default") ?? []) {
      const declName = Node.hasName(declaration) ? declaration.getName() : undefined;
      if (declName === undefined) continue;
      const declFile = toPosix(path.relative(root, declaration.getSourceFile().getFilePath()));
      const candidate = nodeId("component", declFile, resolveAlias(declName));
      if (nodes.has(candidate)) return { definitionId: candidate, external: false };
    }
    return null;
  }

  function resolveRelativeModule(from: SourceFile, spec: string): SourceFile | undefined {
    if (!spec.startsWith(".")) return undefined;
    const base = path.join(path.dirname(from.getFilePath()), spec);
    for (const suffix of [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"]) {
      const found = from.getProject().getSourceFile(`${base}${suffix}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }

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
    const condition = edgeCondition(pending.element, flagCallees);
    addEdge({ from: pending.ownerId, to: id, kind: "renders", ...(condition ? { condition } : {}) });
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
        // Function values are callbacks, not data: the fetch inside
        // onConfirm={handleConfirm} is an EFFECT the child can trigger
        // (handler chains, step 2.3), never data flowing into it.
        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) continue;
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
      // Event-handler props (onConfirm, onClick…) carry effects, not data.
      if (/^on[A-Z]/.test(attr.getNameNode().getText())) continue;
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

/**
 * Handler resolution + action effects (TRACKER steps 2.3 & 3.2; B1, B3, B2).
 *
 * Two problems, one machine. First, a handler may be a PROP whose real body
 * lives at a call site, possibly four components up (B1):
 *
 *   SaveButton onClick={onSave} ← Toolbar onSave={onSaveDraft}
 *     ← EditorPanel onSaveDraft={() => onPersist()} ← DraftEditor onPersist={persistDraft}
 *       → persistDraft body → fetch POST /api/drafts
 *
 * Local handlers (onClick={refresh}) and inline arrows (onClick={() => …})
 * resolve the same way, just without leaving the component. Second, once a
 * handler body is in hand it is mined for every ACTION EFFECT (step 3.2),
 * each a typed edge from the EventNode:
 *
 *   - navigate("/x") / router.push(`/users/${id}`) → navigates-to a RouteNode
 *     (target folded to :param form, joined to a route by path shape; B3)
 *   - fetch / axios / wrapper call                 → triggers a data-source
 *   - dispatch(thunk()) / dispatch(action())       → writes-state on the slice
 *   - setOpen(true)                                → writes-state on the local slot
 *
 * Chains dead after MAX_HANDLER_DEPTH flag the event "unresolved-prop-handler";
 * a navigation whose target resolves to a shape with no matching route flags
 * "unresolved-nav". Visible, never silent.
 */
const MAX_HANDLER_DEPTH = 4;

const NAV_RECEIVERS = new Set(["router", "history", "nav", "navigation"]);

/** An effect mined from a resolved handler body, emitted as an edge from the event. */
type Effect =
  | { kind: "triggers"; to: string }
  | { kind: "writes-state"; to: string }
  | { kind: "navigates-to"; to: string; via: string }
  | { kind: "exits-app"; to: string; via: string }
  /** Internal: navigation to a resolved path with no matching route → flag only. */
  | { kind: "nav-unresolved"; to: string };

/** A URL that leaves this app: absolute/protocol-relative, or a mailto/tel/sms scheme. */
function isExternalUrl(value: string): boolean {
  return /^(?:https?:)?\/\//.test(value) || /^(mailto|tel|sms):/i.test(value);
}

/** Host (accounts.google.com) or scheme (mailto) used to group external destinations. */
function externalHost(url: string): string {
  const scheme = /^(mailto|tel|sms):/i.exec(url);
  if (scheme?.[1] !== undefined) return scheme[1].toLowerCase();
  const host = /^(?:https?:)?\/\/([^/?#]+)/.exec(url);
  return host?.[1] ?? url;
}

/** Reuse or create the ExternalNode for a destination (deduped by host). */
function ensureExternalNode(
  nodes: Map<string, LineageNode>,
  url: string,
  loc: SourceLocation,
): string {
  const host = externalHost(url);
  const id = `external:${host}`;
  if (!nodes.has(id)) nodes.set(id, { id, kind: "external", name: host, loc, url, host });
  return id;
}

function resolveHandlerChains(
  pendingInstances: PendingInstance[],
  instanceIds: Array<string | null>,
  nodes: Map<string, LineageNode>,
  edges: LineageEdge[],
  addEdge: (edge: LineageEdge) => void,
  baseUrls: string[],
  wrappers: WrapperRegistry,
  stores: StoreRegistry,
  handlerExprs: Map<string, Node[]>,
  root: string,
): void {
  const instancesByDefinition = new Map<string, Array<{ pending: PendingInstance; id: string }>>();
  for (const [index, pending] of pendingInstances.entries()) {
    const id = instanceIds[index];
    if (id === null || id === undefined) continue;
    const instance = nodes.get(id);
    if (instance === undefined || instance.kind !== "instance") continue;
    const list = instancesByDefinition.get(instance.definitionId);
    if (list) list.push({ pending, id });
    else instancesByDefinition.set(instance.definitionId, [{ pending, id }]);
  }

  // Route lookup for navigate() targets: exact path first, then param-agnostic
  // shape (navigate(`/users/${id}`) → "/users/:id" joins route "/users/:userId").
  const shapeOf = (p: string): string => p.replace(/:[^/]+/g, ":param");
  const routeByPath = new Map<string, string>();
  const routeByShape = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind !== "route") continue;
    if (!routeByPath.has(node.path)) routeByPath.set(node.path, node.id);
    const shape = shapeOf(node.path);
    if (!routeByShape.has(shape)) routeByShape.set(shape, node.id);
  }
  const matchRoute = (pattern: string): string | undefined =>
    routeByPath.get(pattern) ?? routeByShape.get(shapeOf(pattern));

  const fileOf = (node: Node): string =>
    toPosix(path.relative(root, node.getSourceFile().getFilePath()));

  const pushEffect = (effects: Effect[], effect: Effect): void => {
    if (!effects.some((e) => e.kind === effect.kind && e.to === effect.to)) effects.push(effect);
  };

  // Expression-bodied arrows (`() => onPersist()`) ARE the call — descendants
  // alone would miss them.
  const callsWithin = (body: Node): Node[] => [
    ...(Node.isCallExpression(body) ? [body] : []),
    ...body.getDescendantsOfKind(SyntaxKind.CallExpression),
  ];

  /** navigate("/x") / router.push({pathname}) → resolved route pattern, or null. */
  const navigationTarget = (call: CallExpression, calleeExpr: Node): ResolvedEndpoint | null => {
    let isNav = false;
    if (Node.isIdentifier(calleeExpr)) {
      const name = calleeExpr.getText();
      isNav = name === "navigate" || name === "redirect";
    } else if (Node.isPropertyAccessExpression(calleeExpr)) {
      const method = calleeExpr.getName();
      isNav =
        (method === "push" || method === "replace") &&
        NAV_RECEIVERS.has(calleeExpr.getExpression().getText().toLowerCase());
    }
    if (!isNav) return null;
    let arg = call.getArguments()[0];
    if (arg === undefined) return null;
    if (Node.isObjectLiteralExpression(arg)) {
      // router.push({ pathname: "/users/[id]" }) — navigate on the pathname.
      const pathname = arg.getProperty("pathname");
      arg =
        pathname !== undefined && Node.isPropertyAssignment(pathname)
          ? pathname.getInitializer()
          : undefined;
      if (arg === undefined) return null;
    }
    const resolved = resolveEndpoint(arg, []);
    // navigate(-1) and fully-dynamic targets carry no route shape — skip.
    return resolved.resolved === "none" ? null : resolved;
  };

  /** window.open(url) / location.assign(url) / location.replace(url) → external URL, or null. */
  const externalNavTarget = (call: CallExpression, calleeExpr: Node): ResolvedEndpoint | null => {
    if (!Node.isPropertyAccessExpression(calleeExpr)) return null;
    const method = calleeExpr.getName();
    const receiver = calleeExpr.getExpression().getText();
    const isOpen = method === "open" && /(^|\.)(window|globalThis)$/.test(receiver);
    const isLocation = (method === "assign" || method === "replace") && /(^|\.)location$/.test(receiver);
    if (!isOpen && !isLocation) return null;
    const resolved = resolveEndpoint(call.getArguments()[0], []);
    return resolved.resolved !== "none" && isExternalUrl(resolved.endpoint) ? resolved : null;
  };

  /** dispatch(thunk()) / dispatch(action()) → the slice StateNode ids it writes. */
  const dispatchTargets = (call: CallExpression, calleeExpr: Node): string[] => {
    const callee = calleeExpr.getText();
    if (callee !== "dispatch" && !callee.endsWith(".dispatch")) return [];
    const arg = call.getArguments()[0];
    if (arg === undefined || !Node.isCallExpression(arg)) return [];
    const inner = arg.getExpression();
    const name = Node.isPropertyAccessExpression(inner) ? inner.getName() : inner.getText();
    const ids: string[] = [];
    const action = stores.actionSlices.get(name);
    if (action !== undefined) ids.push(action);
    const thunk = stores.thunkSlices.get(name);
    if (thunk !== undefined && !ids.includes(thunk)) ids.push(thunk);
    return ids;
  };

  /** setOpen(true) → the local useState slot's StateNode id, or null. */
  const localStateWrite = (calleeExpr: Node): string | null => {
    if (!Node.isIdentifier(calleeExpr) || !/^set[A-Z]/.test(calleeExpr.getText())) return null;
    for (const def of calleeExpr.getDefinitionNodes()) {
      if (!Node.isBindingElement(def)) continue;
      const arrayBinding = def.getParent();
      if (arrayBinding === undefined || !Node.isArrayBindingPattern(arrayBinding)) continue;
      const first = arrayBinding.getElements()[0];
      if (first === undefined || !Node.isBindingElement(first)) continue;
      const enclosing = enclosingDeclName(def);
      if (enclosing === null) continue;
      const stId = nodeId("state", enclosing.file, `${enclosing.name}.${first.getName()}`);
      if (nodes.has(stId)) return stId;
    }
    return null;
  };

  /** The nearest enclosing component/hook declaration — matches state node ids. */
  const enclosingDeclName = (node: Node): { name: string; file: string } | null => {
    for (let cur: Node | undefined = node.getParent(); cur !== undefined; cur = cur.getParent()) {
      if (Node.isFunctionDeclaration(cur)) {
        const name = cur.getName();
        if (name !== undefined) return { name, file: fileOf(cur) };
      }
      if (Node.isVariableDeclaration(cur)) {
        const init = cur.getInitializer();
        if (init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          return { name: cur.getName(), file: fileOf(cur) };
        }
      }
    }
    return null;
  };

  /** Mine a handler body for every action effect, creating nodes as needed. */
  const mineHandlerBody = (body: Node, effects: Effect[]): void => {
    for (const call of callsWithin(body)) {
      if (!Node.isCallExpression(call)) continue;
      const calleeExpr = call.getExpression();

      const navTarget = navigationTarget(call, calleeExpr) ?? externalNavTarget(call, calleeExpr);
      if (navTarget !== null) {
        if (isExternalUrl(navTarget.endpoint)) {
          // OAuth redirect, payment gateway, mailto: — the journey leaves the app (B9).
          const ext = ensureExternalNode(nodes, navTarget.endpoint, locOf(call, fileOf(call)));
          pushEffect(effects, { kind: "exits-app", to: ext, via: navTarget.endpoint });
          continue;
        }
        const routeId = matchRoute(navTarget.endpoint);
        pushEffect(
          effects,
          routeId !== undefined
            ? { kind: "navigates-to", to: routeId, via: navTarget.endpoint }
            : { kind: "nav-unresolved", to: navTarget.endpoint },
        );
        continue;
      }

      const sliceIds = dispatchTargets(call, calleeExpr);
      if (sliceIds.length > 0) {
        for (const stId of sliceIds) pushEffect(effects, { kind: "writes-state", to: stId });
        continue;
      }

      const localState = localStateWrite(calleeExpr);
      if (localState !== null) {
        pushEffect(effects, { kind: "writes-state", to: localState });
        continue;
      }

      const detected = detectDataSource(call, calleeExpr.getText(), baseUrls, wrappers);
      if (detected === null) continue;
      const file = fileOf(call);
      const dsId = nodeId("data-source", file, `${detected.sourceKind}:${detected.endpoint}`);
      if (!nodes.has(dsId)) {
        nodes.set(dsId, {
          id: dsId,
          kind: "data-source",
          name: detected.endpoint,
          loc: locOf(call, file),
          sourceKind: detected.sourceKind,
          method: detected.method,
          endpoint: detected.endpoint,
          raw: detected.raw,
          resolved: detected.resolved,
          ...responseTypeProp(responseFromCall(call)),
        });
      }
      pushEffect(effects, { kind: "triggers", to: dsId });
    }
  };

  /** The prop's property name + default initializer on a definition's params. */
  const propBinding = (
    definitionId: string,
    localName: string,
  ): { propertyName: string; defaultInit: Node | undefined } | null => {
    const definition = nodes.get(definitionId);
    if (definition === undefined || definition.kind !== "component") return null;
    if (!definition.props.includes(localName)) return null;
    // Re-locate the AST: find the binding element for the local name.
    const anyInstance = instancesByDefinition.get(definitionId)?.[0];
    const sourceFile =
      anyInstance?.pending.element.getSourceFile().getProject().getSourceFiles()
        .find((f) => toPosix(path.relative(root, f.getFilePath())) === definition.loc.file) ??
      undefined;
    if (sourceFile === undefined) return { propertyName: localName, defaultInit: undefined };
    for (const binding of sourceFile.getDescendantsOfKind(SyntaxKind.BindingElement)) {
      if (binding.getName() !== localName) continue;
      return {
        propertyName: binding.getPropertyNameNode()?.getText() ?? localName,
        defaultInit: binding.getInitializer(),
      };
    }
    return { propertyName: localName, defaultInit: undefined };
  };

  /** Resolve a handler expression at a call site; returns whether anything grounded. */
  const resolveExpr = (
    expr: Node,
    ownerDefinitionId: string,
    depth: number,
    effects: Effect[],
  ): boolean => {
    if (depth > MAX_HANDLER_DEPTH) return false;

    if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
      const body = expr.getBody();
      if (body === undefined) return false;
      const before = effects.length;
      mineHandlerBody(body, effects);
      let grounded = effects.length > before;
      // Arrow wrapping a prop call: () => onPersist()
      for (const call of callsWithin(body)) {
        if (!Node.isCallExpression(call)) continue;
        const callee = call.getExpression();
        const calleeName = Node.isPropertyAccessExpression(callee)
          ? callee.getExpression().getText().endsWith("props")
            ? callee.getName()
            : null
          : Node.isIdentifier(callee)
            ? callee.getText()
            : null;
        if (calleeName !== null && resolveChain(ownerDefinitionId, calleeName, depth + 1, effects)) {
          grounded = true;
        }
      }
      return grounded;
    }

    if (Node.isPropertyAccessExpression(expr) && expr.getExpression().getText().endsWith("props")) {
      return resolveChain(ownerDefinitionId, expr.getName(), depth + 1, effects);
    }

    if (Node.isIdentifier(expr)) {
      for (const definition of expr.getDefinitionNodes()) {
        if (Node.isFunctionDeclaration(definition)) {
          const body = definition.getBody();
          if (body !== undefined) {
            mineHandlerBody(body, effects);
            return true;
          }
        }
        if (Node.isVariableDeclaration(definition)) {
          const init = definition.getInitializer();
          if (init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
            return resolveExpr(init, ownerDefinitionId, depth, effects);
          }
        }
        if (Node.isBindingElement(definition) || Node.isParameterDeclaration(definition)) {
          // The handler is itself a prop of the owner — continue up the tree.
          return resolveChain(ownerDefinitionId, expr.getText(), depth + 1, effects);
        }
      }
    }
    return false;
  };

  /** Follow a prop named `localName` on `definitionId` up through its call sites. */
  const resolveChain = (
    definitionId: string,
    localName: string,
    depth: number,
    effects: Effect[],
  ): boolean => {
    if (depth > MAX_HANDLER_DEPTH) return false;
    const binding = propBinding(definitionId, localName);
    if (binding === null) return false;
    let grounded = false;
    for (const { pending } of instancesByDefinition.get(definitionId) ?? []) {
      let expr: Node | undefined = binding.defaultInit;
      for (const attr of pending.element.getAttributes()) {
        if (!Node.isJsxAttribute(attr) || attr.getNameNode().getText() !== binding.propertyName) {
          continue;
        }
        const init = attr.getInitializer();
        expr = init !== undefined && Node.isJsxExpression(init) ? init.getExpression() : undefined;
        break;
      }
      if (expr === undefined) continue;
      if (resolveExpr(expr, pending.ownerId, depth, effects)) grounded = true;
    }
    return grounded;
  };

  /** A bare prop reference (onClick={onSave} / onClick={props.onSave}). */
  const isPropReference = (expr: Node, owner: { props: string[] }): boolean => {
    if (Node.isIdentifier(expr)) return owner.props.includes(expr.getText());
    return Node.isPropertyAccessExpression(expr) && expr.getExpression().getText().endsWith("props");
  };

  const ownerByEvent = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind === "handles") ownerByEvent.set(edge.to, edge.from);
  }

  // Every wired handler: resolve its body (prop chain, local ref, or inline
  // arrow) and emit the effects it produces as edges from the event.
  for (const [eventId, exprs] of handlerExprs) {
    const event = nodes.get(eventId);
    const ownerId = ownerByEvent.get(eventId);
    const owner = ownerId !== undefined ? nodes.get(ownerId) : undefined;
    if (event === undefined || event.kind !== "event") continue;
    if (owner === undefined || owner.kind !== "component") continue;

    const effects: Effect[] = [];
    let grounded = false;
    let isPropHandler = false;
    for (const expr of exprs) {
      if (isPropReference(expr, owner)) {
        isPropHandler = true;
        // Preserve the B1 depth budget: enter the prop chain at depth 1.
        const propName = Node.isPropertyAccessExpression(expr) ? expr.getName() : expr.getText();
        if (resolveChain(owner.id, propName, 1, effects)) grounded = true;
      } else if (resolveExpr(expr, owner.id, 1, effects)) {
        grounded = true;
      }
    }

    let navUnresolved = false;
    for (const effect of effects) {
      if (effect.kind === "nav-unresolved") {
        navUnresolved = true;
        continue;
      }
      addEdge({
        from: eventId,
        to: effect.to,
        kind: effect.kind,
        ...(effect.kind === "navigates-to" || effect.kind === "exits-app"
          ? { via: effect.via }
          : {}),
      });
    }
    const flags: string[] = [];
    if (isPropHandler && !grounded) flags.push("unresolved-prop-handler");
    if (navUnresolved) flags.push("unresolved-nav");
    if (flags.length > 0) event.flags = [...(event.flags ?? []), ...flags];
  }
}

/** Rewrite `unresolved-hook:<name>` placeholders to real hook node ids; drop misses. */
export function resolveHookEdges(graph: LineageGraph): LineageGraph {
  const hooksByName = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === "hook") hooksByName.set(node.name, node.id);
  }
  const edges: LineageEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: LineageEdge): void => {
    // Rewriting placeholders can collide two edges onto the same hook id;
    // dedup by full key so the result stays canonical (6.3, G8).
    const key = edgeSortKey(edge);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  for (const edge of graph.edges) {
    if (edge.to.startsWith("unresolved-hook:")) {
      const target = hooksByName.get(edge.to.slice("unresolved-hook:".length));
      if (target !== undefined) push({ ...edge, to: target });
      // Unknown hooks (from libraries we don't model) are dropped.
    } else {
      push(edge);
    }
  }
  // Rewritten `to` values may no longer be in the canonical order scanReact
  // produced, so re-sort here — this is the graph the CLI and eval serialize.
  edges.sort((a, b) => {
    const ka = edgeSortKey(a);
    const kb = edgeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return { ...graph, edges };
}

/** Result of an incremental re-scan (6.1): the fresh graph and which files changed. */
export interface IncrementalUpdate {
  graph: LineageGraph;
  /** Files whose on-disk content changed, were added, or were removed (relative posix). */
  changed: string[];
}

/**
 * A reusable scanner for incremental re-scans (TRACKER step 6.1, failure modes
 * D1/G2). Keeps one ts-morph project alive; `update()` refreshes only the files
 * that changed on disk (and picks up added/removed files), then re-runs the full
 * analysis over the current ASTs.
 *
 * Correctness by construction: because every node and cross-file edge is
 * re-derived from the current project state on each `update()`, the resulting
 * graph is byte-identical to a fresh `scanReact` of the same tree — the
 * "dependents" of a changed file (its parents' instance/prop-flow attribution,
 * store writer↔reader links, route/journey wiring) are recomputed for free. The
 * incremental win is parsing: unchanged files keep their cached ASTs, so only
 * changed files are re-read and re-parsed. Intended for `scan --watch` and other
 * long-lived processes.
 */
export class IncrementalScanner {
  private readonly project: Project;
  private readonly root: string;

  constructor(private readonly options: ScanOptions) {
    const { project, root } = createScanProject(options);
    this.project = project;
    this.root = root;
  }

  private rel(sourceFile: SourceFile): string {
    return toPosix(path.relative(this.root, sourceFile.getFilePath()));
  }

  /** The current graph — the initial full scan, or the latest state after `update()`. */
  scan(): LineageGraph {
    return scanProject(this.project, this.root, this.options);
  }

  /** Per-file content hashes of the current project state (for GraphMeta, 6.1). */
  fileHashes(): Record<string, string> {
    return projectFileHashes(this.project, this.root);
  }

  /**
   * Refresh changed/added/removed files from disk and return the new graph plus
   * the list of files that changed. Re-reads only files whose content differs.
   */
  update(): IncrementalUpdate {
    const changed: string[] = [];
    // Refresh existing files; ts-morph re-parses only those whose bytes differ.
    for (const sourceFile of this.project.getSourceFiles()) {
      const rel = this.rel(sourceFile);
      const result = sourceFile.refreshFromFileSystemSync();
      if (result === FileSystemRefreshResult.Updated) {
        changed.push(rel);
      } else if (result === FileSystemRefreshResult.Deleted) {
        changed.push(rel);
        this.project.removeSourceFile(sourceFile);
      }
    }
    // Pick up files created since the last scan (already-loaded paths are skipped).
    const before = new Set(this.project.getSourceFiles().map((s) => s.getFilePath()));
    addProjectFiles(this.project, this.root, scanInclude(this.options));
    for (const sourceFile of this.project.getSourceFiles()) {
      if (!before.has(sourceFile.getFilePath())) changed.push(this.rel(sourceFile));
    }
    changed.sort();
    return { graph: this.scan(), changed };
  }
}
