/**
 * Static endpoint resolution (TRACKER step 1.1, failure modes C2/C3).
 *
 * Turns the expression passed to fetch/axios/useSWR into a canonical endpoint
 * pattern: constants folded across files, template placeholders normalized to
 * :param form, configured base-URL prefixes stripped.
 *
 *   fetch(ENDPOINTS.USERS)            → "/api/users"        (full)
 *   fetch(`/api/orders/${orderId}`)   → "/api/orders/:orderId" (partial)
 *   fetch(base + "/reports")          → "/api/reports"      (full, if base folds)
 *   fetch(buildUrl())                 → "<dynamic>"         (none)
 */

import type { EndpointResolution } from "@coderadar/core";
import { Node, SyntaxKind } from "ts-morph";

export interface ResolvedEndpoint {
  endpoint: string;
  raw: string;
  resolved: EndpointResolution;
}

const MAX_FOLD_DEPTH = 6;

export function resolveEndpoint(node: Node | undefined, baseUrls: string[]): ResolvedEndpoint {
  if (node === undefined) {
    return { endpoint: "<dynamic>", raw: "", resolved: "none" };
  }
  const raw = node.getText();

  const full = resolveStringValue(node, 0);
  if (full !== null) {
    return { endpoint: stripBaseUrls(full, baseUrls), raw, resolved: "full" };
  }

  const partial = resolvePattern(node);
  if (partial !== null) {
    return { endpoint: stripBaseUrls(partial, baseUrls), raw, resolved: "partial" };
  }

  return { endpoint: "<dynamic>", raw, resolved: "none" };
}

/**
 * Fold an expression to a known string: literals, cross-file constants
 * (via go-to-definition), object members (ENDPOINTS.USERS), `+` concatenation,
 * and fully-resolvable templates. Null when any part is unknown.
 */
export function resolveStringValue(node: Node | undefined, depth: number): string | null {
  if (node === undefined || depth > MAX_FOLD_DEPTH) return null;

  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  if (
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isParenthesizedExpression(node)
  ) {
    return resolveStringValue(node.getExpression(), depth + 1);
  }
  if (Node.isIdentifier(node)) {
    for (const definition of node.getDefinitionNodes()) {
      if (Node.isVariableDeclaration(definition)) {
        const value = resolveStringValue(definition.getInitializer(), depth + 1);
        if (value !== null) return value;
      }
    }
    return null;
  }
  if (Node.isPropertyAccessExpression(node)) {
    const objectLiteral = resolveObjectLiteral(node.getExpression(), depth + 1);
    const property = objectLiteral?.getProperty(node.getName());
    if (property !== undefined && Node.isPropertyAssignment(property)) {
      return resolveStringValue(property.getInitializer(), depth + 1);
    }
    return null;
  }
  if (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getKind() === SyntaxKind.PlusToken
  ) {
    const left = resolveStringValue(node.getLeft(), depth + 1);
    const right = resolveStringValue(node.getRight(), depth + 1);
    return left !== null && right !== null ? left + right : null;
  }
  if (Node.isTemplateExpression(node)) {
    let out = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      const value = resolveStringValue(span.getExpression(), depth + 1);
      if (value === null) return null;
      out += value + span.getLiteral().getLiteralText();
    }
    return out;
  }
  return null;
}

/** Pattern form with :param placeholders for the unresolvable parts. */
function resolvePattern(node: Node): string | null {
  if (Node.isTemplateExpression(node)) {
    let out = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      const value = resolveStringValue(span.getExpression(), 0);
      out += value ?? `:${placeholderName(span.getExpression())}`;
      out += span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getKind() === SyntaxKind.PlusToken
  ) {
    const left = patternPart(node.getLeft());
    const right = patternPart(node.getRight());
    // A concatenation where *nothing* resolved carries no shape — report none.
    if (left.startsWith(":") && right.startsWith(":")) return null;
    return left + right;
  }
  return null;
}

function patternPart(node: Node): string {
  const value = resolveStringValue(node, 0);
  if (value !== null) return value;
  const pattern = resolvePattern(node);
  if (pattern !== null) return pattern;
  return `:${placeholderName(node)}`;
}

/** ":id" for `user.id`, ":orderId" for `orderId`, ":param" for anything opaque. */
function placeholderName(node: Node): string {
  const match = /([A-Za-z_$][\w$]*)\s*$/.exec(node.getText());
  return match?.[1] ?? "param";
}

function resolveObjectLiteral(node: Node | undefined, depth: number): import("ts-morph").ObjectLiteralExpression | null {
  if (node === undefined || depth > MAX_FOLD_DEPTH) return null;
  if (Node.isObjectLiteralExpression(node)) return node;
  if (
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isParenthesizedExpression(node)
  ) {
    return resolveObjectLiteral(node.getExpression(), depth + 1);
  }
  if (Node.isIdentifier(node)) {
    for (const definition of node.getDefinitionNodes()) {
      if (Node.isVariableDeclaration(definition)) {
        const literal = resolveObjectLiteral(definition.getInitializer(), depth + 1);
        if (literal !== null) return literal;
      }
    }
  }
  return null;
}

function stripBaseUrls(endpoint: string, baseUrls: string[]): string {
  for (const base of baseUrls) {
    if (base.length > 0 && endpoint.startsWith(base)) {
      const stripped = endpoint.slice(base.length);
      return stripped.startsWith("/") ? stripped : `/${stripped}`;
    }
  }
  return endpoint;
}
