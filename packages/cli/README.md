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
ui-lineage visualize -g app.graph.json -o app.galaxy.html  # interactive HTML graph explorer
```

`visualize` renders the whole graph as a single self-contained HTML file — the graph
JSON plus all CSS/JS inlined, zero network dependencies — that opens in any browser
(`open app.galaxy.html`, no server needed). Nodes are laid out as a canvas
force-directed "galaxy", color-coded by kind (component, instance, hook, data-source,
state, event, route, external, test); components are the stars, their data/state/events
cluster around them, routes act as gravitational centers. Toggle node and edge kinds,
search a node and fly to it, click a node for its details plus a highlighted
neighborhood (a visual blast radius), drag to pin, scroll to zoom, and pause the
physics. Built to stay responsive at real-codebase scale (thousands of nodes).

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

Endpoints (constants, templates, API wrappers, react-query/SWR/RTK Query), GraphQL operations, WebSocket/SSE push channels, Next.js server-side data (RSC async components, `getServerSideProps`/`getStaticProps`), i18n text, cross-file instance trees & per-instance prop-flow, Redux/Zustand stores, portals/modals/toasts, React Router & Next.js routes, action effects (navigate/fetch/dispatch/setState), form libraries & non-JSX events (react-hook-form, `addEventListener`, hotkeys), and feature-flag/role conditions.

## New in 0.6.0

Wider data-source coverage — the graph now sees the ways modern React apps actually fetch, beyond REST calls in the component body:

- **GraphQL** — Apollo/urql operations become data sources, keyed by operation name and typed by operation (`query` / `mutation` / `subscription`). Works with an inline `gql` tag or an imported/co-located `gql` const (resolved across files), and is disambiguated from react-query, which shares the `useQuery`/`useMutation` hook names.
- **Push channels** — `new WebSocket(url)` and `new EventSource(url)` become `websocket` / `sse` data sources, so a component fed by a live channel shows that channel in its lineage.
- **Next.js server data** — a page's server-side fetching is attributed to the page even when it isn't in the component body: pages-router `getServerSideProps` / `getStaticProps` / `getStaticPaths`, alongside app-router async RSC server components.

## New in 0.5.0

Phase 6 — lifecycle, scale, and hardening (production-grade: incremental, fast, deterministic, versioned):

- **Incremental re-scan** — `scan --update` re-parses only files whose contents changed (byte-identical to a full re-scan by construction) and skips work entirely when nothing changed; `scan --watch` re-emits the graph on each save. Per-file content hashes recorded in `GraphMeta`.
- **Determinism** — nodes, edges, and candidates emit in stable, explicit sort order regardless of filesystem/platform; the eval runner hard-gates two-run byte-identity.
- **Version skew & rename tracking** — a SHA-keyed graph store (`.coderadar/graphs/<sha>.json` + `latest`); `bundle --against <sha|latest>` warns when the matched component was renamed/moved in the current code (“matched `InvoiceCard`; renamed `BillingCard`”).
- **Generated-code classification** — machine-generated files (`@generated`/`DO NOT EDIT` banners, `__generated__/` paths, `.generated.` infixes, minified) are kept in lineage as API metadata but excluded from match candidates.
- **PII policy** — screenshots are ephemeral (never persisted, embedded, or logged); the graph and corrections store hold terms only. Documented in `docs/security.md` and enforced by a test.
- **Scale** — a ~2,000-file synthetic benchmark with a nightly, budget-gated perf CI job (< 5 min scan, < 4 GB RSS).

## New in 0.4.1

Second field-hardening round, validated by self-running against **Grafana's frontend** (6,461 files → 15,334-node graph in 72 s: 55 RTK-query data sources, 32 routes, 1,009 test-coverage edges):

- **Stopword & rare-literal scoring** — a component rendering a bare `BY` (a rare literal with high IDF) no longer outranks the component that renders the whole phrase; stopword-only queries decline `no-signal`.
- **HTML-entity rendered text** — `&nbsp;` / `&#34;` / `&gt;` are decoded during extraction (as React does), so they stop producing junk match tokens and false matches.
- **`coverage-unmapped` note** — when test files exist but almost none map to a component, bundles emit one honest graph-level note instead of a near-universal false `untested`.
- **`visualize`** — self-contained interactive HTML galaxy of the whole graph (`ui-lineage visualize -g app.graph.json -o app.galaxy.html`), responsive at 15k+ nodes.

## New in 0.4.0

Field-hardening from real-codebase validation (React 18 · Redux Toolkit · RTK Query · MUI · React Router):

- **Matcher fix** — rendered text that normalizes to empty (`|`, `/`, `-`) no longer acts as a universal wildcard; gibberish now declines `no-signal` instead of returning false high-confidence matches.
- **Instance resolution** — tsconfig-path aliases (`@ui`), multi-hop rename barrels, and `Loadable(lazy(() => import()))` page wrappers now resolve to their definitions, so `blast_radius` and the render graph are complete.
- **RTK Query** — `createApi` / `injectEndpoints` / `builder.query|mutation` become data sources (baseUrl-joined, `:param`-normalized); generated hooks (`useGetUsersQuery`) wire per-component `fetches-from` edges.
- **Object-config routes** — `createBrowserRouter` with an imported/spread-composed config and lazy-wrapped elements now emits route nodes, so `journeys("/path")` works.
- **Scoring** — terms that also name a component (name/props/file) outrank incidental text; every candidate carries a top-line `score` next to `confidence`.
- **`visualize`** — new command renders the graph as a self-contained interactive HTML galaxy (`ui-lineage visualize -g app.graph.json -o app.galaxy.html`).

## New in 0.3.0

The agent interface: `resolve`/`bundle` produce a budgeted **context bundle** (match → lineage → journeys → blast radius → tests → response types → git history) · `impact` blast-radius traversal · test-coverage mapping · response-schema linking (generic / annotation / OpenAPI, via `scan --openapi`) · and the **`ui-lineage-mcp`** MCP server exposing `resolve_context` · `find_component` · `trace_lineage` · `journeys` · `blast_radius` over stdio.

### Previously (0.2.0)

User journeys · action effects · form & non-JSX events · flag/role conditions · a real matching engine (rarity + fuzzy/OCR + structural + most-specific-subtree) · screenshot/vision adapter · alias glossary + corrections store · calibrated confidence with honesty metrics.

## Status

Pre-1.0. Output is deterministic and language-agnostic (a plain JSON graph), designed to feed AI agents as a context provider — not to be one. Lifecycle/scale hardening (incremental scan, determinism, versioning) landed in 0.5.0; next is backend lineage (pixel → API handler).

## License

MIT
