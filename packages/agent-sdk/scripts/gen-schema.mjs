/** Regenerate schemas/context-bundle.schema.json from the TS types. */
import fs from "node:fs";
import path from "node:path";

import { createGenerator } from "ts-json-schema-generator";

import { generatorConfig, schemaOutPath } from "./schema-config.mjs";

const schema = createGenerator(generatorConfig).createSchema(generatorConfig.type);
fs.mkdirSync(path.dirname(schemaOutPath), { recursive: true });
fs.writeFileSync(schemaOutPath, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${schemaOutPath}`);
