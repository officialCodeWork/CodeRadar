# CodeRadar

Static analysis toolkit that maps UI components to their data sources (APIs, state, events) — enabling AI agents to trace any screenshot back to the code and data behind it.

**The problem:** a Jira ticket has a screenshot of a broken screen. Which component is that? Where does its data come from? Today an engineer greps for the visible text, follows imports by hand, and reads hook bodies to find the API call. CodeRadar does that walk statically, once, and hands the result to an agent as a queryable graph.

```
Screenshot text ──find──▶ Component ──trace──▶ APIs · state · events
```

## Quick start

```bash
pnpm install && pnpm build

# 1. Scan a React codebase into a lineage graph
node packages/cli/dist/index.js scan ./my-app/src -o graph.json

# 2. Find the component behind a screenshot (use text visible in the image)
node packages/cli/dist/index.js find "Team Members" -g graph.json
#   UserList  (components/UserList.tsx:4)  score=1

# 3. Trace everything that feeds it
node packages/cli/dist/index.js trace UserList -g graph.json
#   UserList  (components/UserList.tsx:4)
#     data sources:
#       [fetch] GET /api/users  (hooks/useUsers.ts:14)
#       [fetch] DELETE /api/users/${user.id}  (components/UserCard.tsx:5)
#     state:
#       [useState] users  (hooks/useUsers.ts:10)
#     events:
#       onClick → handleDelete  (components/UserCard.tsx:12)
#     via: useUsers, UserCard
```

Try it on the bundled example: `node packages/cli/dist/index.js scan examples/demo-app/src`.

## Packages

| Package | Purpose |
|---------|---------|
| [`@coderadar/core`](packages/core) | The `LineageGraph` schema (plain JSON, language-agnostic) + query helpers (`matchComponentsByText`, `traceLineage`) |
| [`@coderadar/parser-react`](packages/parser-react) | ts-morph–based parser: components, hooks, fetch/axios/react-query/swr calls, useState/useSelector/useContext, JSX event handlers, rendered text |
| [`@coderadar/cli`](packages/cli) | `coderadar scan` / `find` / `trace` |

## What the graph captures

- **ComponentNode** — file, export, props, *rendered text* (JSX text + placeholder/label/title/alt/aria-label — the screenshot-matching signal), child components
- **DataSourceNode** — endpoint as written in source (template placeholders preserved), HTTP method, client kind (fetch / axios / react-query / swr)
- **StateNode** — useState / useReducer / useContext / redux useSelector / zustand useStore
- **EventNode** — `on*` JSX handlers and the functions they call
- **Edges** — `renders`, `uses-hook`, `fetches-from`, `reads-state`, `handles`, `triggers`

Lineage is transitive: `trace UserList` follows `UserList → useUsers → fetch("/api/users")` and `UserList → UserCard → DELETE` in one query.

## Architecture

Parsers are language-specific; the graph is not. Any parser emits the same `LineageGraph` JSON, and any agent (Python, Go, TS) consumes it without touching the parsers.

Planned parsers: Python (FastAPI/Django routes) and Go (handlers) so backend endpoints join the same graph as the frontend components that call them — closing the loop from pixel to database.

## Roadmap & planning

CodeRadar is built as a context-provider node for a multi-agent development pipeline:
Jira ticket in → context bundle (matched components, data lineage, journeys, blast radius) out.

- **[TRACKER.md](TRACKER.md)** — the phased build plan (8 phases, one step = one PR). Read this first.
- **[docs/failure-modes.md](docs/failure-modes.md)** — the catalog of everything that can go wrong (IDs A1–G8); every plan step maps to the failure modes it addresses.
- **[docs/testing-strategy.md](docs/testing-strategy.md)** — eval harness, per-failure-mode fixtures, metrics, and the per-phase gates that tell us whether we're on track.

Current state: v0.1 proof of concept (this repo). Next: Phase 0 — schema v2 (instance nodes), eval harness, CI.

## License

MIT
