/**
 * CodeRadar MCP server (TRACKER step 5.7 → Gate 5).
 *
 * Exposes the deterministic query layer over a PRE-BUILT lineage graph as MCP
 * tools an agent can call. Every tool returns a QueryResult / ContextBundle
 * envelope as JSON text: ranked candidates with evidence and confidence, or an
 * honest `ambiguous` / `declined`. The tool descriptions tell the calling agent
 * when to reach for each one and how to treat those statuses.
 *
 * There is NO LLM in this node — it is a context provider, not an agent.
 */

import {
  blastRadius,
  journeys,
  type LineageGraph,
  matchComponents,
  traceLineage,
} from "@coderadar/core";
import { buildBundle } from "@coderadar/agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Serialize any query envelope as pretty JSON text content. */
function envelope(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Build a configured MCP server bound to one pre-built graph. */
export function createServer(graph: LineageGraph): McpServer {
  const server = new McpServer({ name: "coderadar", version: "0.6.1" });

  server.registerTool(
    "resolve_context",
    {
      title: "Resolve a ticket to a budgeted context bundle",
      description:
        "PRIMARY TOOL. Given a bug/feature ticket, return a deterministic, token-budgeted context bundle: the matched component(s), their data/state/event lineage, user journeys, blast radius, tests, and recent git history. Use this first for any UI ticket. `status` is 'matched', 'ambiguous', or 'declined'; on 'declined' the ticket is out of scope (e.g. backend-only) — read `warnings`. On 'ambiguous' relay the `warnings` disambiguation question to a human rather than guessing.",
      inputSchema: {
        ticket: z.string().describe("The ticket text (title + body)."),
        screenshots: z
          .number()
          .int()
          .optional()
          .describe("How many screenshots are attached, if any (routes the ticket as visual)."),
        budgetTokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Token budget the bundle must fit under. Default 4000."),
      },
    },
    ({ ticket, screenshots, budgetTokens }) =>
      envelope(
        buildBundle(
          graph,
          { text: ticket, ...(screenshots !== undefined ? { screenshots } : {}) },
          budgetTokens !== undefined ? { budgetTokens } : {},
        ),
      ),
  );

  server.registerTool(
    "find_component",
    {
      title: "Find components by on-screen text",
      description:
        "Rank components by text read off a screenshot or ticket (labels, headings, button text). Returns ranked candidates with evidence and confidence. `status: 'ambiguous'` means several components fit equally — relay the `disambiguation` question to a human. `status: 'declined'` with reason 'no-signal' means nothing matched.",
      inputSchema: {
        terms: z
          .array(z.string())
          .min(1)
          .describe("Text fragments visible in the UI, e.g. ['All invoices', 'Download']."),
      },
    },
    ({ terms }) => envelope(matchComponents(graph, { terms })),
  );

  server.registerTool(
    "trace_lineage",
    {
      title: "Trace a component's data, state, and events",
      description:
        "Given a component name, definition id, or instance id, return every data source (with response type when known), state slice, and event that feeds it — kept per-instance so a shared component doesn't leak one page's API onto another. `declined` reason 'not-found' means the id/name isn't in the graph.",
      inputSchema: {
        id: z.string().describe("Component name, definition id, or instance id."),
      },
    },
    ({ id }) => {
      const node =
        graph.nodes.find((n) => n.id === id) ??
        graph.nodes.find((n) => n.kind === "component" && n.name === id);
      return envelope(traceLineage(graph, node?.id ?? id));
    },
  );

  server.registerTool(
    "journeys",
    {
      title: "Enumerate user-journey paths from a screen",
      description:
        "From a route path ('/users/:id'), component name, or instance id, enumerate user-journey paths (click → navigate → click…). Each path ends 'terminal', 'cycle' (a finite list ⇄ detail loop), or 'depth-limit'. Use to understand what a screen leads to.",
      inputSchema: {
        start: z.string().describe("Route path, component name, or instance id to start from."),
        depth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max navigation levels per path. Default 3."),
      },
    },
    ({ start, depth }) =>
      envelope(journeys(graph, start, depth !== undefined ? { depth } : {})),
  );

  server.registerTool(
    "blast_radius",
    {
      title: "Find everything that depends on a node",
      description:
        "Reverse-dependency traversal: everything affected by changing a node — instances of a component, consumers of an API endpoint, readers of a state slice, and the tests over them — each with its distance. Pass a component name, API endpoint, state name, or route path. Use to scope the impact of a change before making it.",
      inputSchema: {
        node: z.string().describe("Component name, API endpoint, state name, or route path."),
        depth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max dependency hops to follow. Default: unlimited."),
      },
    },
    ({ node, depth }) =>
      envelope(blastRadius(graph, node, depth !== undefined ? { depth } : {})),
  );

  return server;
}
