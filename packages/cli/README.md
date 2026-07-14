# ui-lineage

**Map UI components to their data sources and user journeys** — trace any screenshot or ticket back to the code, APIs, state, and navigation behind it. Deterministic static analysis for React/TSX. No LLM, no network calls.

`ui-lineage` scans a React codebase into a **lineage graph** and lets you query it three ways:

- **match** — text seen on screen → the component(s) that render it
- **trace** — a component → every API, state slice, and event that feeds it (attributed *per instance*, so a shared `<DataTable>` on the Users page reports `/api/users` while the same component on Invoices reports `/api/invoices`)
- **journeys** — a page → the user-action paths leading out of it (click → navigate → click…), lazily expanded and cycle-safe

## Install

```bash
npm install -g ui-lineage      # CLI
npm install ui-lineage         # library
```

Requires Node ≥ 20.

## CLI

```bash
# 1. Scan a React app into a graph
ui-lineage scan ./src -o app.graph.json

# 2. Find a component from on-screen text
ui-lineage find "All invoices" -g app.graph.json

# 3. Trace a component (or an instance id) to its data
ui-lineage trace InvoicesPage -g app.graph.json

# 4. Walk the user journeys from a page or route
ui-lineage journeys /users -g app.graph.json
```

`journeys` output reads left-to-right, with `↩ cycle` where a list ⇄ detail loop closes:

```
  ▸ /users  • onClick()  → /users/:userId  ▸ /users/:userId  • onClick()  → /users  ▸ /users  ↩ cycle
  ▸ /users  • onClick()  ⇢ fetch /api/users
```

## Library

```ts
import { scanReact, resolveHookEdges, journeys, traceLineage, matchComponentsByText } from "ui-lineage";

const graph = resolveHookEdges(scanReact({ root: "./src" }));

const match = matchComponentsByText(graph, ["All invoices"]);
const lineage = traceLineage(graph, match.candidates[0].value.component.id);
const paths = journeys(graph, "/users", { depth: 3 });
```

Every query returns a `QueryResult` envelope — ranked `candidates` with evidence and confidence, or an honest `ambiguous` / `declined`.

## What it understands

Endpoints (constants, templates, API wrappers, react-query/SWR), i18n text, cross-file instance trees and per-instance prop-flow, Redux/Zustand stores, portals/modals/toasts, React Router & Next.js routes, and action effects (navigate / fetch / dispatch / setState) mined from event handlers.

## Status

Early (v0.1). The matching engine, screenshot adapter, and MCP server are on the roadmap. Output is deterministic and language-agnostic (plain JSON graph), designed to feed AI agents as a context provider — not to be one.

## License

MIT
