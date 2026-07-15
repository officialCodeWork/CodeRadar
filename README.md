# 📡 CodeRadar

> **Screenshot in. Full data lineage out.**
> Static analysis that maps every UI component to the APIs, state, and events behind it — built for AI agents doing real development work.

**Status:** pre-release · v0.1 proof of concept · [build plan](TRACKER.md)

---

## The problem

A Jira ticket lands with a screenshot: *"the numbers on this table are wrong."*

Before any fix can start, someone has to answer:

1. **Which component is that?** — grep for visible text, hope it isn't behind an i18n key
2. **Where does its data come from?** — follow imports, unwrap hooks, find the API call
3. **What happens if I change it?** — who else renders this component? who else calls this API?

An engineer does this walk by hand, every ticket. An AI dev agent can't do it reliably at all — it sees files, not the *lineage* connecting a pixel on screen to the endpoint that produced it.

## What CodeRadar does

CodeRadar scans a React codebase **once, statically** — no running app required — and produces a queryable **lineage graph**:

```
        find                    trace                     impact
Screenshot ──▶ Component instance ──▶ APIs · state · events ──▶ Blast radius
  text                 │
                       └─ per call site: the same <DataTable> on the Users page
                          is fed by /api/users; on the Invoices page by /api/invoices
```

It's designed as a **context-provider node for multi-agent development pipelines**: a ticket goes in, and a budgeted context bundle comes out — matched components with evidence, their data sources, the relevant user journeys, blast radius, tests, and git history. Every answer carries confidence and evidence; when the graph isn't sure, it says `ambiguous` and tells you what would disambiguate — it never hands your pipeline a confident guess.

## Quick start

```bash
git clone https://github.com/officialCodeWork/CodeRadar.git
cd CodeRadar && pnpm install && pnpm build
```

**1 — Scan a React codebase into a lineage graph**

```bash
node packages/cli/dist/index.js scan ./my-app/src -o graph.json
```

**2 — Find the component behind a screenshot** (use any text visible in the image)

```bash
node packages/cli/dist/index.js find "Team Members" -g graph.json
```
```
UserList  (components/UserList.tsx:4)  score=1
  matched: team members
```

**3 — Trace everything that feeds it**

```bash
node packages/cli/dist/index.js trace UserList -g graph.json
```
```
UserList  (components/UserList.tsx:4)
  data sources:
    [fetch] GET /api/users              (hooks/useUsers.ts:14)
    [fetch] DELETE /api/users/${user.id} (components/UserCard.tsx:5)
  state:
    [useState] users    (hooks/useUsers.ts:10)
    [useState] loading  (hooks/useUsers.ts:11)
  events:
    onClick → handleDelete  (components/UserCard.tsx:12)
  via: useUsers, UserCard
```

Note the transitivity: `UserList` itself contains no fetch — the lineage flows through the `useUsers` hook and the `UserCard` child automatically.

Try it immediately on the bundled example: `node packages/cli/dist/index.js scan examples/demo-app/src`

## How it works

```
┌────────────────────────────────────────────────────────────────┐
│                          CodeRadar                             │
│                                                                │
│   Parsers (language-specific)      Graph (language-agnostic)  │
│  ┌───────────────┐                                             │
│  │ parser-react  │──┐   ┌─────────────────────────────────┐   │
│  │  (ts-morph)   │  │   │        LineageGraph (JSON)      │   │
│  └───────────────┘  ├──▶│                                 │   │
│  ┌───────────────┐  │   │  Component ──renders──▶ Component│   │
│  │ parser-python │  │   │      │                          │   │
│  │   (planned)   │──┤   │  fetches-from ──▶ DataSource    │   │
│  └───────────────┘  │   │  reads-state  ──▶ State         │   │
│  ┌───────────────┐  │   │  handles      ──▶ Event         │   │
│  │  parser-go    │──┘   └─────────────────────────────────┘   │
│  │   (planned)   │                      │                     │
│  └───────────────┘                      ▼                     │
│                          Query layer: find · trace · impact   │
│                          (CLI · SDK · MCP server, planned)    │
└────────────────────────────────────────────────────────────────┘
```

**Parsers are language-specific; the graph is not.** Every parser emits the same `LineageGraph` JSON, and any agent — Python, Go, TypeScript — consumes it without touching a parser. The planned backend parsers make endpoints a *join key*: `fetches-from: /api/users` in your React repo links to `serves: /api/users` in your FastAPI repo, closing the loop from pixel to handler.

## Packages

| Package | Purpose |
|---------|---------|
| [`@coderadar/core`](packages/core) | The `LineageGraph` schema + query primitives (`matchComponents`, `traceLineage`, `journeys`, `blastRadius`) |
| [`@coderadar/parser-react`](packages/parser-react) | ts-morph static parser — components (incl. `memo`/`forwardRef`), hooks, `fetch`/`axios`/react-query/SWR endpoints, `useState`/`useSelector`/`useContext`, JSX event handlers, rendered-text extraction, test coverage, response types |
| [`@coderadar/agent-sdk`](packages/agent-sdk) | `resolveContext` / `buildBundle` — classifies a ticket and assembles a budgeted context bundle (deterministic, no LLM) |
| [`@coderadar/mcp`](packages/mcp) | MCP server exposing `resolve_context` · `find_component` · `trace_lineage` · `journeys` · `blast_radius` over stdio |
| [`ui-lineage`](packages/cli) | Published CLI + library bundle: `scan` · `find` · `trace` · `journeys` · `impact` · `resolve` · `bundle`, plus the `ui-lineage-mcp` server bin |

### What the graph captures

- **Components** — file, exports, props, child components, and *rendered text* (JSX text + `placeholder`/`label`/`title`/`alt`/`aria-label`) — the screenshot-matching signal
- **Data sources** — endpoint as written in source (template placeholders preserved), HTTP method, client kind (fetch / axios / react-query / SWR)
- **State** — `useState` / `useReducer` / `useContext` / redux `useSelector` / zustand `useStore`
- **Events** — `on*` handlers and the functions they invoke
- **Edges** — `renders` · `uses-hook` · `fetches-from` · `reads-state` · `handles` · `triggers`

## Where this is going

The v0.1 PoC proves the chain on clean code. Real codebases fight back — endpoints behind wrapper clients, text behind i18n keys, handlers drilled through four layers of props, one shared component fed different APIs per page. We catalogued **53 ways this can fail** before writing the plan, and every phase of the build is gated by evals that measure exactly those failure modes.

| Document | What's in it |
|----------|--------------|
| **[TRACKER.md](TRACKER.md)** | The build plan: 8 phases, 40 steps, acceptance criteria per step — read this first |
| **[docs/failure-modes.md](docs/failure-modes.md)** | The failure catalog (IDs `A1`–`G8`) every step and eval fixture maps to |
| **[docs/testing-strategy.md](docs/testing-strategy.md)** | Eval harness, golden fixtures, metrics (incl. *poison rate* — confidently-wrong answers), phase gates |

Milestones at a glance:

- **M2** — per-instance attribution: shared components correctly attributed per call site
- **M3** — n-level user journeys, lazily expanded (cycles welcome)
- **M4** — screenshot/text → ranked, calibrated, *honest* matches
- **M5** — pluggable pipeline node: ticket in → budgeted context bundle out, over MCP
- **M7** — full-stack lineage: pixel → backend handler (Python/Go parsers)

## Contributing

The project follows a strict step discipline: one TRACKER step = one branch = one PR, and a step is done only when its acceptance criteria and eval gate pass. Found a new way for this to fail? That's a contribution — add it to [failure-modes.md](docs/failure-modes.md) with a fixture.

## License

MIT
