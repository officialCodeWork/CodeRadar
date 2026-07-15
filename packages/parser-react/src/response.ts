/**
 * Response-schema linking (TRACKER step 5.5, failure mode F4).
 *
 * Recovers the shape a data source returns from three sources, in order:
 *   1. a generic type argument on the fetching call — `useQuery<User[]>(…)`,
 *      `axios.get<User[]>(url)`, `useSWR<User[]>(…)`;
 *   2. a type annotation on the variable the result lands in —
 *      `const users: User[] = await fetch(…).then((r) => r.json())`;
 *   3. an OpenAPI 3 spec, matched by endpoint + method (a post-pass, since it
 *      needs only the resolved endpoint, not the call).
 *
 * Only one level of fields is recorded — the fields of the response, not their
 * nested shapes.
 */

import fs from "node:fs";
import path from "node:path";

import type { LineageNode, ResponseField, ResponseType } from "@coderadar/core";
import { type CallExpression, Node, type Type, type TypeNode } from "ts-morph";

const MAX_FIELDS = 40;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Recover a response type from a fetching call's generics or a nearby annotation. */
export function responseFromCall(call: CallExpression): ResponseType | null {
  const typeArg = call.getTypeArguments()[0];
  if (typeArg !== undefined) {
    const fromGeneric = fromTypeNode(typeArg, "generic");
    if (fromGeneric !== null) return fromGeneric;
  }
  // Nearest enclosing typed variable whose initializer holds this call —
  // stop at a function boundary so we never grab an unrelated outer binding.
  let node: Node | undefined = call.getParent();
  while (node !== undefined) {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isMethodDeclaration(node)
    ) {
      break;
    }
    if (Node.isVariableDeclaration(node)) {
      const typeNode = node.getTypeNode();
      return typeNode !== undefined ? fromTypeNode(typeNode, "annotation") : null;
    }
    node = node.getParent();
  }
  return null;
}

function fromTypeNode(typeNode: TypeNode, source: ResponseType["source"]): ResponseType | null {
  const type = typeNode.getType();
  const isArray = type.isArray();
  const element = isArray ? (type.getArrayElementType() ?? type) : type;
  const symbolName = element.getSymbol()?.getName();
  const named = symbolName !== undefined && symbolName !== "__type" && symbolName !== "__object";
  const name = named ? (isArray ? `${symbolName}[]` : symbolName) : typeNode.getText();
  return { name, fields: fieldsOf(element, typeNode), source };
}

/** One level of data fields — property signatures/declarations only (skips methods). */
function fieldsOf(type: Type, at: Node): ResponseField[] {
  const fields: ResponseField[] = [];
  for (const property of type.getProperties()) {
    const decl = property.getDeclarations()[0];
    if (decl === undefined) continue;
    if (!Node.isPropertySignature(decl) && !Node.isPropertyDeclaration(decl)) continue;
    const fieldType = simplifyType(property.getTypeAtLocation(at).getText(at));
    fields.push({ name: property.getName(), type: fieldType });
    if (fields.length >= MAX_FIELDS) break;
  }
  return fields;
}

function simplifyType(text: string): string {
  // Drop `import("/abs/path").` prefixes the checker emits for cross-file types.
  const cleaned = text.replace(/import\([^)]*\)\./g, "");
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned;
}

// --- OpenAPI ------------------------------------------------------------------

type OpenApiIndex = Map<string, ResponseType>;

interface OpenApiSchema {
  $ref?: string;
  type?: string;
  title?: string;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
}

/** Load an OpenAPI 3 JSON spec into a `${METHOD} ${endpoint}` → ResponseType index. */
export function loadOpenApi(root: string, relPath: string): OpenApiIndex | null {
  const file = path.resolve(root, relPath);
  if (!fs.existsSync(file)) return null;
  let spec: {
    paths?: Record<string, Record<string, { responses?: Record<string, ResponseObject> }>>;
    components?: { schemas?: Record<string, OpenApiSchema> };
  };
  try {
    spec = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  const schemas = spec.components?.schemas ?? {};
  const index: OpenApiIndex = new Map();
  for (const [rawPath, operations] of Object.entries(spec.paths ?? {})) {
    const endpoint = normalizeOpenApiPath(rawPath);
    for (const [method, operation] of Object.entries(operations)) {
      const httpMethod = method.toUpperCase();
      if (!HTTP_METHODS.has(httpMethod)) continue;
      const schema = successSchema(operation.responses);
      if (schema === undefined) continue;
      const responseType = responseTypeFromSchema(schema, schemas);
      if (responseType !== null) index.set(`${httpMethod} ${endpoint}`, responseType);
    }
  }
  return index;
}

interface ResponseObject {
  content?: Record<string, { schema?: OpenApiSchema }>;
}

function successSchema(
  responses: Record<string, ResponseObject> | undefined,
): OpenApiSchema | undefined {
  for (const code of ["200", "201"]) {
    const schema = responses?.[code]?.content?.["application/json"]?.schema;
    if (schema !== undefined) return schema;
  }
  return undefined;
}

/** Convert an OpenAPI path template ("/users/{id}") to our endpoint form ("/users/:id"). */
function normalizeOpenApiPath(p: string): string {
  return p.replace(/\{([^}]+)\}/g, ":$1");
}

function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

function responseTypeFromSchema(
  schema: OpenApiSchema,
  schemas: Record<string, OpenApiSchema>,
): ResponseType | null {
  if (schema.$ref !== undefined) {
    const name = refName(schema.$ref);
    return { name, fields: schemaFields(schemas[name], schemas), source: "openapi" };
  }
  if (schema.type === "array" && schema.items !== undefined) {
    const item = schema.items;
    if (item.$ref !== undefined) {
      const name = refName(item.$ref);
      return { name: `${name}[]`, fields: schemaFields(schemas[name], schemas), source: "openapi" };
    }
    return { name: `${item.type ?? "object"}[]`, fields: schemaFields(item, schemas), source: "openapi" };
  }
  if (schema.type === "object" || schema.properties !== undefined) {
    return { name: schema.title ?? "object", fields: schemaFields(schema, schemas), source: "openapi" };
  }
  return null;
}

function schemaFields(
  schema: OpenApiSchema | undefined,
  schemas: Record<string, OpenApiSchema>,
): ResponseField[] {
  if (schema === undefined) return [];
  const resolved = schema.$ref !== undefined ? schemas[refName(schema.$ref)] : schema;
  const properties = resolved?.properties ?? {};
  const fields: ResponseField[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    fields.push({ name, type: schemaFieldType(prop) });
    if (fields.length >= MAX_FIELDS) break;
  }
  return fields;
}

function schemaFieldType(schema: OpenApiSchema): string {
  if (schema.$ref !== undefined) return refName(schema.$ref);
  if (schema.type === "array" && schema.items !== undefined) {
    return `${schema.items.$ref !== undefined ? refName(schema.items.$ref) : (schema.items.type ?? "object")}[]`;
  }
  return schema.type ?? "unknown";
}

/** Post-pass: attach OpenAPI response types to data sources that lack one. */
export function linkOpenApiResponses(nodes: Map<string, LineageNode>, index: OpenApiIndex): void {
  for (const node of nodes.values()) {
    if (node.kind !== "data-source" || node.responseType !== undefined) continue;
    const method = (node.method ?? "GET").toUpperCase();
    const match = index.get(`${method} ${node.endpoint}`) ?? index.get(`GET ${node.endpoint}`);
    if (match !== undefined) node.responseType = match;
  }
}
