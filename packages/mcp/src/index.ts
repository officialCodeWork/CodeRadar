#!/usr/bin/env node
/**
 * CodeRadar MCP stdio entry point.
 *
 * Loads a pre-built lineage graph (path from the CODERADAR_GRAPH env var, or the
 * first CLI argument) and serves it over stdio. Build the graph first with
 * `ui-lineage scan <dir> -o app.graph.json`, then point this server at it.
 */

import { loadGraph } from "@coderadar/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";

async function main(): Promise<void> {
  const graphPath = process.env["CODERADAR_GRAPH"] ?? process.argv[2];
  if (graphPath === undefined) {
    process.stderr.write(
      "CodeRadar MCP: set CODERADAR_GRAPH (or pass a path) to a graph built with `ui-lineage scan`.\n",
    );
    process.exit(1);
  }

  let graph;
  try {
    graph = loadGraph(graphPath);
  } catch (error) {
    process.stderr.write(`CodeRadar MCP: cannot load ${graphPath}: ${String(error)}\n`);
    process.exit(1);
  }

  const server = createServer(graph);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`CodeRadar MCP ready — ${graph.nodes.length} nodes from ${graphPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`CodeRadar MCP: fatal ${String(error)}\n`);
  process.exit(1);
});
