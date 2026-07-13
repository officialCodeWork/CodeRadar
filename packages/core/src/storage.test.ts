import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGenerator } from "ts-json-schema-generator";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line import/no-relative-packages
import { generatorConfig, schemaOutPath } from "../scripts/schema-config.mjs";
import { collectGraphMeta, loadGraph, saveGraph, SCHEMA_VERSION } from "./storage.js";
import type { LineageGraph } from "./types.js";

const tmp = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coderadar-")), name);

const graph: LineageGraph = {
  version: 2,
  root: "/scanned/app",
  generatedAt: "2026-01-01T00:00:00Z",
  generator: "test",
  meta: { commitSha: "abc123", dirty: false },
  nodes: [],
  edges: [],
};

describe("saveGraph / loadGraph", () => {
  it("round-trips deep-equal", () => {
    const file = tmp("graph.json");
    saveGraph(graph, file);
    expect(loadGraph(file)).toEqual(graph);
  });

  it("refuses a graph newer than this library", () => {
    const file = tmp("future.json");
    fs.writeFileSync(file, JSON.stringify({ ...graph, version: SCHEMA_VERSION + 1 }));
    expect(() => loadGraph(file)).toThrow(/upgrade @coderadar\/core/);
  });

  it("refuses files that are not lineage graphs", () => {
    const file = tmp("junk.json");
    fs.writeFileSync(file, JSON.stringify({ hello: "world" }));
    expect(() => loadGraph(file)).toThrow(/no version field/);

    const badVersion = tmp("badversion.json");
    fs.writeFileSync(badVersion, JSON.stringify({ version: "two" }));
    expect(() => loadGraph(badVersion)).toThrow(/version must be a number/);
  });
});

describe("collectGraphMeta", () => {
  it("returns a SHA inside a git repo", () => {
    const meta = collectGraphMeta(path.dirname(schemaOutPath));
    expect(meta.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null SHA outside a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coderadar-nogit-"));
    expect(collectGraphMeta(dir).commitSha).toBeNull();
  });
});

describe("JSON Schema drift gate", () => {
  it("committed schema matches the current TS types — run `pnpm --filter @coderadar/core schema` after schema changes", () => {
    const generated = createGenerator(generatorConfig).createSchema(generatorConfig.type);
    const committed: unknown = JSON.parse(fs.readFileSync(schemaOutPath, "utf-8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(generated)));
  });
});
