/**
 * GraphQL operation extraction (TRACKER step 7.1, failure mode C4).
 *
 * Recognizes GraphQL operations a component runs — Apollo / urql / graphql-request
 * hooks (`useQuery`, `useMutation`, `useSubscription`, `useLazyQuery`) whose
 * argument is a `gql`/`graphql` tagged template (inline, or a const that resolves
 * to one). Each operation becomes a data source: the operation NAME is its
 * identity (the value federation and attribution join on), the operation TYPE
 * (query/mutation/subscription) is its "method". Anonymous operations fall back
 * to their first root selection field.
 */
import { Node } from "ts-morph";

/** The GraphQL hook names that take an operation document as their first argument. */
export const GRAPHQL_HOOKS: ReadonlySet<string> = new Set([
  "useQuery",
  "useMutation",
  "useSubscription",
  "useLazyQuery",
]);

/** Tag names that mark a template literal as a GraphQL document. */
const GQL_TAGS: ReadonlySet<string> = new Set(["gql", "graphql"]);

export interface GraphqlOperation {
  type: "query" | "mutation" | "subscription";
  /** Operation name, or null for an anonymous operation. */
  name: string | null;
  /** Top-level selection field names (best-effort), a fallback identity. */
  rootFields: string[];
}

/** Strip `# ...` line comments and the surrounding backticks from a template's text. */
function documentText(raw: string): string {
  return raw.replace(/^`|`$/g, "").replace(/#[^\n]*/g, " ");
}

/**
 * Parse a GraphQL document's leading operation. Handles named and anonymous
 * `query`/`mutation`/`subscription` operations and the shorthand `{ … }` query.
 * Returns null for a fragment-only document (a reusable selection, not a fetch).
 */
export function parseGraphqlOperation(rawDocument: string): GraphqlOperation | null {
  const text = documentText(rawDocument);
  const opMatch = /\b(query|mutation|subscription)\b\s*([A-Za-z_]\w*)?/.exec(text);
  let type: GraphqlOperation["type"];
  let name: string | null;
  let bodyStart: number;
  if (opMatch !== null) {
    type = opMatch[1] as GraphqlOperation["type"];
    name = opMatch[2] ?? null;
    bodyStart = opMatch.index + opMatch[0].length;
  } else if (/^\s*\{/.test(text)) {
    // Shorthand anonymous query: `{ field { … } }`.
    type = "query";
    name = null;
    bodyStart = text.indexOf("{");
  } else {
    return null;
  }
  return { type, name, rootFields: rootSelectionFields(text, bodyStart) };
}

/**
 * The field names selected directly inside the operation's top-level `{ … }`
 * (depth 1). Skips argument lists `( … )` and nested selections, and drops the
 * variable-definition list that can precede the body.
 */
function rootSelectionFields(text: string, from: number): string[] {
  const open = text.indexOf("{", from);
  if (open === -1) return [];
  const fields: string[] = [];
  let depth = 0;
  let parens = 0;
  let token = "";
  const flush = (): void => {
    // A field is a bareword captured at brace depth 1; an alias `a: b` keeps `a`.
    const name = token.split(":")[0]?.trim();
    if (name !== undefined && /^[A-Za-z_]\w*$/.test(name) && name !== "on") fields.push(name);
    token = "";
  };
  for (let i = open; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "(") parens += 1;
    else if (ch === ")") parens -= 1;
    else if (parens > 0) continue;
    else if (ch === "{") {
      if (depth === 1) flush();
      depth += 1;
      token = "";
    } else if (ch === "}") {
      if (depth === 1) flush();
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1) {
      if (/\s/.test(ch)) flush();
      else token += ch;
    }
  }
  // Dedupe, preserve order.
  return [...new Set(fields)];
}

/** The GraphQL document text of a `gql`/`graphql` tagged template, or null. */
function taggedGqlText(node: Node): string | null {
  if (!Node.isTaggedTemplateExpression(node)) return null;
  const tagName = node.getTag().getText().split(".").pop() ?? "";
  if (!GQL_TAGS.has(tagName)) return null;
  return node.getTemplate().getText();
}

/**
 * Resolve a hook argument to a GraphQL operation: an inline `gql`/`graphql`
 * tagged template, or an identifier bound to one (in this file or an imported
 * module — ts-morph follows the symbol). Returns null when the argument is not
 * a GraphQL document (e.g. a react-query key/options object).
 */
export function graphqlOperationFromArg(arg: Node | undefined): GraphqlOperation | null {
  if (arg === undefined) return null;
  const inline = taggedGqlText(arg);
  if (inline !== null) return parseGraphqlOperation(inline);
  if (Node.isIdentifier(arg)) {
    // getDefinitionNodes follows imports to the real declaration, so a gql const
    // defined in another module (the common codegen/co-located pattern) resolves.
    for (const decl of arg.getDefinitionNodes()) {
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        const text = init !== undefined ? taggedGqlText(init) : null;
        if (text !== null) return parseGraphqlOperation(text);
      }
    }
  }
  return null;
}
