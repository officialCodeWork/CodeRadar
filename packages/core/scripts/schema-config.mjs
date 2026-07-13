/**
 * Shared config for JSON Schema generation — used by gen-schema.mjs (writes
 * the committed file) and the drift-gate test (regenerates and diffs).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** ts-json-schema-generator config for the LineageGraph root type. */
export const generatorConfig = {
  path: path.join(packageDir, "src/types.ts"),
  tsconfig: path.join(packageDir, "tsconfig.json"),
  type: "LineageGraph",
  topRef: true,
  additionalProperties: false,
};

/** Committed schema location (repo root — dist/ is gitignored). */
export const schemaOutPath = path.resolve(packageDir, "../../schemas/lineage-graph.schema.json");
