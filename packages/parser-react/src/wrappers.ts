/**
 * API-client wrapper detection (TRACKER step 1.2, failure mode C2).
 *
 * Real codebases route every request through wrapper layers:
 *
 *   useApi("/projects") → apiClient.get(path) → request(path) → fetch(`${API_BASE}${path}`)
 *
 * A wrapper is any named callable whose body reaches fetch/axios (or another
 * wrapper) with one of its own parameters inside the URL. Detection composes
 * templates through the chain, so a call site's argument substitutes all the
 * way down: apiClient.get("/projects") → "/api/projects".
 *
 * Wrappers can also be declared explicitly via ScanOptions.apiWrappers
 * (e.g. ["http.get", "api.post"]) for clients the heuristic can't see
 * (imported from node_modules, class-based, etc.).
 */

import type { DataSourceKind } from "@coderadar/core";
import { Node, type Project, SyntaxKind } from "ts-morph";

import { fetchMethod, resolveUrlTemplate } from "./endpoint.js";

export interface WrapperInfo {
  /** How call sites reference it: "request", "apiClient.get", "useApi". */
  callee: string;
  /** Name and position of the path parameter. */
  paramName: string;
  pathParamIndex: number;
  /**
   * Endpoint pattern with ":<paramName>" marking where the call-site argument
   * lands, e.g. "/api:path". Composed through wrapper chains.
   */
  template: string;
  method: string | null;
  sourceKind: DataSourceKind;
}

export type WrapperRegistry = ReadonlyMap<string, WrapperInfo>;

/** How many wrapper layers detection follows (useApi → apiClient.get → request). */
const MAX_CHAIN_ROUNDS = 3;

const METHOD_SUFFIX = /(get|post|put|patch|delete|head|options)$/i;

interface Callable {
  callee: string;
  body: Node;
  paramNames: string[];
}

export function detectWrappers(project: Project, configured: string[]): WrapperRegistry {
  const registry = new Map<string, WrapperInfo>();

  for (const callee of configured) {
    registry.set(callee, {
      callee,
      paramName: "path",
      pathParamIndex: 0,
      template: ":path",
      method: suffixMethod(callee),
      sourceKind: "unknown",
    });
  }

  const callables = collectCallables(project);
  for (let round = 0; round < MAX_CHAIN_ROUNDS; round += 1) {
    let changed = false;
    for (const callable of callables) {
      if (registry.has(callable.callee)) continue;
      const info = classifyWrapper(callable, registry);
      if (info !== null) {
        registry.set(callable.callee, info);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return registry;
}

/** Every named callable a call site could reference: functions, const fns, object methods. */
function collectCallables(project: Project): Callable[] {
  const callables: Callable[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      const body = fn.getBody();
      if (name === undefined || body === undefined) continue;
      callables.push({ callee: name, body, paramNames: fn.getParameters().map((p) => p.getName()) });
    }
    for (const variable of sourceFile.getVariableDeclarations()) {
      const init = variable.getInitializer();
      if (init === undefined) continue;
      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
        callables.push({
          callee: variable.getName(),
          body: init.getBody() ?? init,
          paramNames: init.getParameters().map((p) => p.getName()),
        });
      } else if (Node.isObjectLiteralExpression(init)) {
        for (const property of init.getProperties()) {
          if (Node.isMethodDeclaration(property)) {
            const body = property.getBody();
            if (body === undefined) continue;
            callables.push({
              callee: `${variable.getName()}.${property.getName()}`,
              body,
              paramNames: property.getParameters().map((p) => p.getName()),
            });
          } else if (Node.isPropertyAssignment(property)) {
            const value = property.getInitializer();
            if (value !== undefined && (Node.isArrowFunction(value) || Node.isFunctionExpression(value))) {
              callables.push({
                callee: `${variable.getName()}.${property.getName()}`,
                body: value.getBody() ?? value,
                paramNames: value.getParameters().map((p) => p.getName()),
              });
            }
          }
        }
      }
    }
  }
  return callables;
}

function classifyWrapper(callable: Callable, registry: WrapperRegistry): WrapperInfo | null {
  if (callable.paramNames.length === 0) return null;
  const paramSet = new Set(callable.paramNames);

  for (const call of callable.body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();

    let urlIndex: number;
    let innerTemplate: string | null = null;
    let innerParam: string | null = null;
    let innerMethod: string | null;
    let sourceKind: DataSourceKind;

    const axiosMatch = /^axios(?:\.(\w+))?$/.exec(callee);
    const inner = registry.get(callee);
    if (callee === "fetch") {
      urlIndex = 0;
      innerMethod = fetchMethod(call);
      sourceKind = "fetch";
    } else if (axiosMatch !== null) {
      urlIndex = 0;
      innerMethod = axiosMatch[1] !== undefined ? axiosMatch[1].toUpperCase() : null;
      sourceKind = "axios";
    } else if (inner !== undefined) {
      urlIndex = inner.pathParamIndex;
      innerTemplate = inner.template;
      innerParam = inner.paramName;
      innerMethod = inner.method;
      sourceKind = inner.sourceKind;
    } else {
      continue;
    }

    const urlArg = call.getArguments()[urlIndex];
    if (urlArg === undefined) continue;
    const pattern = resolveUrlTemplate(urlArg, paramSet);
    if (pattern === null) continue;
    const usedParam = callable.paramNames.find((p) => pattern.includes(`:${p}`));
    if (usedParam === undefined) continue;

    const template =
      innerTemplate !== null && innerParam !== null
        ? innerTemplate.replace(`:${innerParam}`, pattern)
        : pattern;

    return {
      callee: callable.callee,
      paramName: usedParam,
      pathParamIndex: callable.paramNames.indexOf(usedParam),
      template,
      method: suffixMethod(callable.callee) ?? innerMethod,
      sourceKind,
    };
  }
  return null;
}

/** "apiClient.post" → "POST"; "request" → null. */
function suffixMethod(callee: string): string | null {
  const lastSegment = callee.split(".").pop() ?? callee;
  const match = METHOD_SUFFIX.exec(lastSegment);
  return match?.[1] !== undefined ? match[1].toUpperCase() : null;
}
