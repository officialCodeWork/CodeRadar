/**
 * Shared config for ContextBundle JSON Schema generation — used by
 * gen-schema.mjs (writes the committed file) and the drift-gate test.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const generatorConfig = {
  path: path.join(packageDir, "src/bundle.ts"),
  tsconfig: path.join(packageDir, "tsconfig.json"),
  type: "ContextBundle",
  topRef: true,
  additionalProperties: false,
};

/** Committed schema location (repo root — dist/ is gitignored). */
export const schemaOutPath = path.resolve(packageDir, "../../schemas/context-bundle.schema.json");
