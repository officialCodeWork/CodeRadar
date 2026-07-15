#!/usr/bin/env node
/**
 * `ui-lineage-mcp` — the CodeRadar MCP server as a self-contained bin.
 *
 * Serves a pre-built lineage graph over stdio so an MCP-speaking agent can call
 * resolve_context / find_component / trace_lineage / journeys / blast_radius.
 * Build the graph first: `ui-lineage scan <dir> -o app.graph.json`, then point a
 * client at `ui-lineage-mcp` with CODERADAR_GRAPH=app.graph.json (or pass the
 * path as the first argument).
 */

import { loadGraph } from "@coderadar/core";
import { createServer } from "@coderadar/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  const graphPath = process.env["CODERADAR_GRAPH"] ?? process.argv[2];
  if (graphPath === undefined) {
    process.stderr.write(
      "ui-lineage-mcp: set CODERADAR_GRAPH (or pass a path) to a graph built with `ui-lineage scan`.\n",
    );
    process.exit(1);
  }
  let graph;
  try {
    graph = loadGraph(graphPath);
  } catch (error) {
    process.stderr.write(`ui-lineage-mcp: cannot load ${graphPath}: ${String(error)}\n`);
    process.exit(1);
  }
  const server = createServer(graph);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`ui-lineage-mcp ready — ${graph.nodes.length} nodes from ${graphPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`ui-lineage-mcp: fatal ${String(error)}\n`);
  process.exit(1);
});
