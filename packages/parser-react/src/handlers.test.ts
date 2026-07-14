import path from "node:path";
import { fileURLToPath } from "node:url";

import { traceLineage } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures/b1-prop-drilled-handler/app",
);

const graph = scanReact({ root: fixture });

describe("handler resolution through props (b1 fixture)", () => {
  it("grounds a 4-level drilled handler in its fetch", () => {
    const event = graph.nodes.find(
      (n) => n.kind === "event" && n.handler === "onSave",
    );
    if (event === undefined) throw new Error("SaveButton onClick event not found");
    const triggers = graph.edges.filter((e) => e.kind === "triggers" && e.from === event.id);
    expect(triggers).toHaveLength(1);
    const target = graph.nodes.find((n) => n.id === triggers[0]?.to);
    expect(target?.kind === "data-source" ? `${target.method} ${target.endpoint}` : "missing").toBe(
      "POST /api/drafts",
    );
  });

  it("makes the endpoint reachable from SaveButton's lineage", () => {
    const definition = graph.nodes.find((n) => n.kind === "component" && n.name === "SaveButton");
    if (definition === undefined) throw new Error("SaveButton not found");
    const lineage = traceLineage(graph, definition.id).candidates[0]?.value;
    expect(lineage?.dataSources.map((d) => d.endpoint)).toEqual(["/api/drafts"]);
  });

  it("flags never-passed handlers as unresolved instead of guessing", () => {
    const event = graph.nodes.find((n) => n.kind === "event" && n.handler === "onMystery");
    if (event === undefined) throw new Error("OrphanButton onClick event not found");
    expect(event.flags).toContain("unresolved-prop-handler");
    expect(graph.edges.some((e) => e.kind === "triggers" && e.from === event.id)).toBe(false);
  });
});
