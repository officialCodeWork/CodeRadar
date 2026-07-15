import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { saveGraph } from "@coderadar/core";
import { resolveHookEdges, scanReact } from "@coderadar/parser-react";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const fixtureApp = path.join(repoRoot, "eval/fixtures/a4-generic-text/app");
const serverEntry = path.join(here, "../dist/index.js");

let client: Client;
let transport: StdioClientTransport;
let graphPath: string;

// Parse the single text-content envelope a tool returns.
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
  };
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  // Build a real graph from a fixture and persist it for the server to load.
  const graph = resolveHookEdges(scanReact({ root: fixtureApp }));
  graphPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coderadar-mcp-")), "graph.json");
  saveGraph(graph, graphPath);

  client = new Client({ name: "coderadar-mcp-test", version: "0.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, CODERADAR_GRAPH: graphPath },
  });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
});

describe("CodeRadar MCP server (TRACKER 5.7, Gate 5)", () => {
  it("advertises all five tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "blast_radius",
      "find_component",
      "journeys",
      "resolve_context",
      "trace_lineage",
    ]);
    // Descriptions are written for the calling agent.
    expect(tools.find((t) => t.name === "resolve_context")?.description).toMatch(/bundle/i);
  });

  it("resolve_context returns a matched context bundle for a UI ticket", async () => {
    const bundle = await call("resolve_context", {
      ticket: "the Card number field on the billing form is broken",
    });
    expect(bundle["status"]).toBe("matched");
    expect(Array.isArray(bundle["match"])).toBe(true);
    expect(bundle["budget"]).toBeDefined();
  });

  it("resolve_context declines an out-of-domain (backend) ticket", async () => {
    const bundle = await call("resolve_context", {
      ticket: "the SQL migration on the orders table failed in production",
    });
    expect(bundle["status"]).toBe("declined");
  });

  it("find_component round-trips ok / ambiguous / declined envelopes", async () => {
    const ok = await call("find_component", { terms: ["Card number"] });
    expect(ok["status"]).toBe("ok");
    expect(Array.isArray(ok["candidates"])).toBe(true);

    const ambiguous = await call("find_component", { terms: ["Save"] });
    expect(ambiguous["status"]).toBe("ambiguous");
    expect(typeof ambiguous["disambiguation"]).toBe("string");

    const declined = await call("find_component", { terms: ["zzqqnope"] });
    expect(declined["status"]).toBe("declined");
    expect(declined["declineReason"]).toBe("no-signal");
  });

  it("trace_lineage resolves a component name and declines unknown ids", async () => {
    const ok = await call("trace_lineage", { id: "BillingForm" });
    expect(ok["status"]).toBe("ok");
    const missing = await call("trace_lineage", { id: "NoSuchComponent" });
    expect(missing["status"]).toBe("declined");
    expect(missing["declineReason"]).toBe("not-found");
  });

  it("journeys and blast_radius return ok envelopes, declining unknown targets", async () => {
    expect((await call("journeys", { start: "BillingForm" }))["status"]).toBe("ok");
    expect((await call("blast_radius", { node: "BillingForm" }))["status"]).toBe("ok");
    expect((await call("blast_radius", { node: "NoSuchNode" }))["status"]).toBe("declined");
  });
});
