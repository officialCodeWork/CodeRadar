# ui-lineage

**Map UI components to their data, journeys, and behavior** — trace any screenshot or ticket back to the code, APIs, state, events, and navigation behind it. Deterministic static analysis for React/TSX. No LLM in the core, no network calls.

`ui-lineage` scans a React codebase into a **lineage graph** and answers three questions:

1. **match** — text or structure seen on screen → the component(s) that render it (rarity-weighted, fuzzy/OCR-tolerant, structure-aware, with business-vocab aliases and human corrections, and *calibrated* confidence).
2. **trace** — a component → every API, state slice, and event that feeds it, *attributed per instance* (a shared `<DataTable>` reports `/api/users` on the Users page and `/api/invoices` on Invoices).
3. **journeys** — a page → the user-action paths out of it (click → navigate → click…), lazily expanded and cycle-safe, with flag/role conditions.

## Install

```bash
npm install -g ui-lineage      # CLI
npm install ui-lineage         # library
```

Requires Node ≥ 20.

## CLI

```bash
ui-lineage scan ./src -o app.graph.json          # scan a React app into a graph
ui-lineage scan ./src --openapi openapi.json     # …and link data sources to response types
ui-lineage find "All invoices" -g app.graph.json # text → component
ui-lineage find "invoice widget" -a aliases.yaml # resolve business vocabulary
ui-lineage trace InvoicesPage -g app.graph.json  # component → data/state/events
ui-lineage journeys /users -g app.graph.json     # user-journey paths from a page
ui-lineage impact /api/users -g app.graph.json   # blast radius: everything that depends on a node
ui-lineage resolve "cart total is wrong"         # classify a ticket, then match it to components
ui-lineage bundle "cart total is wrong" -b 4000  # a budgeted context bundle (JSON) for an agent
ui-lineage correct BillingCard "amount owed"     # record a correction for next time
```

`impact <node>` takes a component name, an API endpoint, a state name, or a route
path, and lists every node that depends on it (reverse traversal), each indented by
its distance — so a change can be reviewed for what it might break:

```
  [instance-of] instance DataTable  (pages/UsersPage.tsx:17)
    [renders] component UsersPage   (pages/UsersPage.tsx:5)
```

`journeys` reads left-to-right, with `↩ cycle` where a list ⇄ detail loop closes:

```
  ▸ /users  • onClick()  → /users/:id  ▸ /users/:id  • onClick()  → /users  ▸ /users  ↩ cycle
  ▸ /users  • onClick()  ⇢ fetch /api/users
```

## MCP server

`ui-lineage` also ships an MCP (Model Context Protocol) server, so an agent can
query a pre-built graph over stdio. Build a graph, then point an MCP client at
the `ui-lineage-mcp` bin with the graph path in `CODERADAR_GRAPH`:

```jsonc
// e.g. an MCP client config
{
  "mcpServers": {
    "coderadar": {
      "command": "ui-lineage-mcp",
      "env": { "CODERADAR_GRAPH": "/abs/path/to/app.graph.json" }
    }
  }
}
```

Tools: `resolve_context(ticket)` (→ a budgeted context bundle), `find_component(terms)`,
`trace_lineage(id)`, `journeys(start, depth?)`, `blast_radius(node, depth?)`. Every
tool returns a QueryResult envelope — ranked candidates with confidence, or an
honest `ambiguous` / `declined`. There is no LLM in the server; it is a
deterministic context provider.

## Library

```ts
import {
  scanReact, resolveHookEdges,
  matchComponents, traceLineage, journeys,
  recordCorrection, loadCorrections,
} from "ui-lineage";

const graph = resolveHookEdges(scanReact({ root: "./src" }));

const match = matchComponents(graph, { terms: ["All invoices"] });
const lineage = traceLineage(graph, match.candidates[0].value.component.id);
const paths = journeys(graph, "/users", { depth: 3 });
```

Every query returns a `QueryResult` envelope — ranked `candidates` with evidence and confidence, or an honest `ambiguous` (with a disambiguation question built from the candidates' differences) / `declined` (machine-readable reason).

### Screenshots (`ui-lineage/vision`)

```ts
import { StubVisionAdapter, matchFromVision } from "ui-lineage/vision";
```

Turn a screenshot into `{ terms, structure, annotations }` and match it — terms the user circled are weighted 3×; a non-app image declines. The Claude-vision adapter needs `@anthropic-ai/sdk` installed separately; the stub and matching helpers do not. Images are processed in memory, never persisted.

## What it understands

Endpoints (constants, templates, API wrappers, react-query/SWR), i18n text, cross-file instance trees & per-instance prop-flow, Redux/Zustand stores, portals/modals/toasts, React Router & Next.js routes, action effects (navigate/fetch/dispatch/setState), form libraries & non-JSX events (react-hook-form, `addEventListener`, hotkeys), and feature-flag/role conditions.

## New in 0.2.0

User journeys · action effects · form & non-JSX events · flag/role conditions · a real matching engine (rarity + fuzzy/OCR + structural + most-specific-subtree) · screenshot/vision adapter · alias glossary + corrections store · calibrated confidence with honesty metrics.

## Status

Pre-1.0. The context-bundle orchestrator and MCP server are next. Output is deterministic and language-agnostic (a plain JSON graph), designed to feed AI agents as a context provider — not to be one.

## License

MIT
