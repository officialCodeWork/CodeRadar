import fs from "node:fs";

import { createGenerator } from "ts-json-schema-generator";
import { describe, expect, it } from "vitest";

import { generatorConfig, schemaOutPath } from "../scripts/schema-config.mjs";

describe("ContextBundle JSON Schema drift gate", () => {
  it("committed schema matches the TS types — run `pnpm --filter @coderadar/agent-sdk schema` after changes", () => {
    const generated = createGenerator(generatorConfig).createSchema(generatorConfig.type);
    const committed: unknown = JSON.parse(fs.readFileSync(schemaOutPath, "utf-8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(generated)));
  });
});
