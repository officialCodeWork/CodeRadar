# CodeRadar build tracker

**Read this first every session.** Single source of truth for what is done, in progress, and next.

## Status

- **Current phase:** 6F — Field hardening, feedback round 1 (runs before 6.1–6.5)
- **Next step:** 6F.4 RTK Query extractor
- **Done:** 0.1–0.4, 1.1–1.6, 2.1–2.5, 3.1–3.6, 4.1–4.6, 5.1–5.7, 6F.1–6F.3
- **Gates passed:** Gate 0 (CI + red-path, #5/#6) · Gate 1 (precision 1.000, recall 0.895, zero poison) · Gate 2 (C1 instance attribution 1.000 · B1 4-level handler chains · C6 store writers↔readers · A9 portals — scorecard 137/0/0, precision & recall 1.000) · Gate 3 (B3 action effects · B4 routers · B6 cyclic journeys terminate · B7/B8 form & non-JSX events · G5 flag/role conditions — precision & recall 1.000) · Gate 4 (A4 rarity · A10 fuzzy/OCR · A1 structural · A6 subtree · E3 vision annotations · E2 aliases · G4 corrections — high-conf correct 1.000, ambiguity honesty 1.000, poison rate 0.000) · Gate 5 (F1 context bundle · F2 blast radius · F3 test coverage · F4 response schema · F5 git history · MCP server over stdio — scorecard 265/0/0, all honesty metrics 1.000; **M5 reached** — ticket in → budgeted context bundle out, over MCP)

## What CodeRadar is

A context-provider node in a multi-agent development pipeline. Input: a Jira ticket
(text + screenshots + links). Output: a **context bundle** — matched component instances,
their data lineage (APIs, state, events), the relevant user-journey slice, blast radius,
tests, and git history — sized to a token budget, with evidence and confidence on every claim.

Three core requirements:
1. **Match** — UI snapshot / ticket text → component instance(s)
2. **Journeys** — every user action path, n levels deep, lazily expanded
3. **Attribution** — which APIs feed which UI, *per instance* (a shared `DataTable` on the
   Users page is fed by `/api/users`; the same component on the Invoices page by `/api/invoices`)

Reference docs:
- [docs/failure-modes.md](docs/failure-modes.md) — the catalog (IDs A1–G8) every step maps to
- [docs/testing-strategy.md](docs/testing-strategy.md) — eval harness, metrics, phase gates

## Conventions

- One step = one branch = one PR to `main`. Branch: `build/phase-{N}/step-{N}.{M}-{slug}`.
- Update this file (step status + Status block) in the same PR.
- A step is **done** only when its acceptance criteria all pass and `pnpm eval` is green.
- A phase is **done** only when its gate (see testing-strategy.md) passes in CI.
- Every step that addresses a failure mode adds/extends a fixture under `eval/fixtures/<id>-*`.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Foundations: schema v2, eval harness, CI

Everything else depends on getting the schema and the measurement loop right first.
The v0.1 schema is definition-only, which is *wrong* for C1 — fix before building on it.

### [x] 0.1 Schema v2 — instances, evidence, confidence
**Failure modes:** C1 (schema half), D2 (schema half), A5, B5 (edge conditions)
**Build:** rework `packages/core/src/types.ts`:
- `InstanceNode` — `{ id, kind: "instance", definitionId, parentInstanceId | null, loc, staticProps: Record<string, string> }`. One per JSX call site of a project component. Id: `instance:<file>:<line>#<DefName>`.
- Definition nodes keep `component`/`hook` kinds. `renders` edges connect instances; `instance-of` connects instance → definition.
- `Evidence` — `{ kind: "text-match" | "structure" | "edge-chain" | "alias" | "correction", detail: string, loc?: SourceLocation }`.
- `Confidence` — `"high" | "medium" | "low"` plus numeric `score: number` (0–1). Every query result type carries `evidence: Evidence[]` and `confidence`.
- `EdgeCondition` — `{ kind: "flag" | "role" | "branch" | "response", expression: string }`, optional on every edge.
- Result envelope: `QueryResult<T> = { status: "ok" | "ambiguous" | "declined", candidates: Array<{ value: T, confidence, evidence }>, disambiguation?: string }`. **No query API ever returns a bare value.**
**Accept:**
- Unit tests for id construction, envelope invariants.
- `parser-react` updated: emits an instance node per project-component JSX usage; `renders`/`fetches-from`/`reads-state`/`handles` edges originate from instances where applicable, definitions otherwise.
- Demo-app scan shows `UserCard` with 1 definition + 1 instance (parent `UserList`).
- `matchComponentsByText` / `traceLineage` return `QueryResult` envelopes.

### [x] 0.2 Eval harness + first fixtures
**Failure modes:** infrastructure for all; first fixtures C1, A4
**Build:** `eval/run.ts` (a workspace package `@coderadar/eval`):
- Discovers `eval/fixtures/*/`, scans each `app/` dir, diffs the graph + query results against `golden.json` (format in testing-strategy.md, including `forbidden` entries).
- Emits `eval/scorecard.json`: per-fixture pass/fail, per-metric values, grouped by failure-mode category; appends to `eval/history.jsonl`.
- `pnpm eval` runs it; non-zero exit if any threshold in `eval/thresholds.json` is violated.
- Fixtures: `c1-shared-datatable` (DataTable rendered by Users + Invoices pages, different APIs — must attribute per instance, `forbidden` catches definition-level attribution), `a4-generic-text` (three components sharing "Save"), plus `demo-app` moved under fixtures.
**Accept:** `pnpm eval` runs green locally on the non-C1 assertions; C1 attribution assertions may be *red* (prop-flow lands in 2.2) but the fixture and its golden file exist and the runner reports them as `expected-fail: phase-2`. Expected-fail support is part of the runner.

### [x] 0.3 Graph storage & versioning
**Failure modes:** G2, G3 (foundation), D1 (foundation)
**Build:**
- `GraphMeta` — `{ commitSha, dirty: boolean, generatedAt, generator, scanRoot }` embedded in `LineageGraph`.
- `saveGraph(graph, path)` / `loadGraph(path)` in core with schema-version check (refuse to load a newer major version).
- JSON Schema for the whole graph exported to `schemas/lineage-graph.schema.json` (repo root — `dist/` is gitignored; generated from the TS types; committed; drift-gated by a test that regenerates and diffs).
- CLI: `scan` records commit SHA (via `git rev-parse`, `dirty` from `git status`).
**Accept:** round-trip test (scan → save → load → deep-equal); schema drift test; `coderadar scan` output includes SHA.

### [x] 0.4 CI pipeline
**Failure modes:** D1, process
**Build:** GitHub Actions workflow: install (pnpm cache) → build → typecheck → vitest unit tests → `pnpm eval` → upload scorecard as artifact. Threshold ratchet rule documented in the workflow file header (raising OK; lowering needs PR-body justification).
**Accept:** CI green on a PR; a deliberately broken fixture in a test branch turns it red. **Gate 0 passes.**

---

## Phase 1 — Robust extraction (definition level)

Make the parser survive real code instead of demo code. All work is within-file or
follow-one-reference; the cross-file instance/prop-flow machinery is Phase 2.

### [x] 1.1 Endpoint resolution — constants, templates, patterns
**Failure modes:** C2 (constants half), C3
**Build:** in `parser-react`:
- Resolve identifier arguments to fetch/axios through imports to their declarations (constant folding: string literals, `const` object members like `ENDPOINTS.USERS`, simple concatenation).
- Template literals → route patterns: `` `/api/users/${id}` `` → `endpoint: "/api/users/:id"`, `resolved: "partial"`, unresolved segments listed.
- Strip configured base-URL prefixes (scan option `baseUrls: string[]`).
- `DataSourceNode` gains `{ pattern: string, resolved: "full" | "partial" | "none", raw: string }`.
**Accept:** fixtures `c2-endpoint-constants`, `c3-dynamic-endpoints` green; lineage precision holds ≥ 0.90 on all existing fixtures.

### [x] 1.2 API-client wrapper adapter
**Failure modes:** C2 (wrapper half)
**Build:**
- Detection heuristic: a function/method whose body reaches `fetch`/`axios` and takes a path-like parameter → classified as an API wrapper; its call sites become data sources with the path argument resolved per 1.1.
- Manual override in scan config: `apiWrappers: ["apiClient.get", "http.post", ...]`.
- Wrapper chains up to depth 3 (`useApi → apiClient.get → fetch`).
**Accept:** fixture `c2-api-wrapper` (three-layer wrapper) green; wrapper detection has unit tests for both heuristic and config paths.

### [x] 1.3 react-query / SWR queryFn following
**Failure modes:** C5
**Build:** when `useQuery`/`useMutation`/`useSWR`'s fn argument is a reference, resolve to its declaration (same file or import) and extract the endpoint from its body via 1.1/1.2. Data source records both the query key and the resolved endpoint; mutations get `method` from the inner call.
**Accept:** fixture `c5-queryfn-indirection` green (queryFn in a separate `api/users.ts`).

### [x] 1.4 i18n adapter
**Failure modes:** A2
**Build:**
- Scan option `i18n: { localeGlobs: string[], defaultLocale: string }`; parse JSON/YAML locale files into a key → string-per-locale table (nested keys flattened, `{{var}}` placeholders preserved).
- `t("key")` / `<Trans i18nKey="key">` call sites resolve into `renderedText` entries `{ text, locale, source: "i18n", key }` for **all** locales.
- `renderedText` becomes structured: `{ text: string, source: "jsx" | "attribute" | "i18n", branch?: string, locale?: string }[]` (schema addition — update JSON Schema + goldens).
**Accept:** fixture `a2-i18n-keys` green: searching "Team Members" *and* "Équipe" both find the component.

### [x] 1.5 Rendered-text hardening
**Failure modes:** A7 (extraction half), A8
**Build:**
- Template text: `` `${count} items` `` → `"* items"` with a `template: true` flag.
- Branch tagging: text inside a conditional (ternary / `&&` / early return) gets `branch: <condition source text>`.
- Normalization utility in core (shared with the Phase 4 matcher): lowercase, collapse whitespace, strip punctuation, naive singular/plural folding.
**Accept:** fixtures `a7-transformed-text`, `a8-conditional-text` green (error-state text findable and tagged with its branch).

### [x] 1.6 Legacy patterns & graceful degradation
**Failure modes:** D4
**Build:**
- Class components: `render()` treated as the body; `this.state`/`setState` → state nodes; lifecycle fetches detected.
- HOC unwrapping for `connect(...)`, `withRouter(...)` etc. (unwrap to the inner component; record the HOC name).
- Anything unparseable yields a node with `flags: ["incomplete"]` rather than silence; scan summary counts incomplete nodes.
**Accept:** fixture `d4-class-components` green; incomplete count surfaced in `scan` output. **Gate 1 passes.**

---

## Phase 2 — Instance graph & cross-file data flow

The heart of the project. C1 and B1 live here.

### [x] 2.1 Instance tree construction
**Failure modes:** C1 (graph half), A5
**Build:** cross-file pass in `parser-react`:
- Resolve every JSX tag to its component definition through imports (including `export { X as Y }`, barrel files, default exports).
- Emit `InstanceNode` per call site with `parentInstanceId` forming the render tree; static (literal) props recorded in `staticProps`.
- Design-system components (imported from `node_modules` or a configured `designSystemPackages` list): instances are still created, flagged `external-definition` — the instance is ours even when the definition isn't.
**Accept:** fixture `a5-design-system` green (match resolves to the usage site); instance counts asserted in c1 golden; barrel-file resolution unit-tested.

### [x] 2.2 Prop-flow: data attribution per instance
**Failure modes:** C1 (the headline)
**Build:**
- For each instance, connect prop values to their origins in the parent scope: identifier props trace back through variable declarations to hook results / fetch results / store reads within the parent.
- New edge `provides-data` (parent's data source → instance, `via: <propName>`).
- `traceLineage(instanceId)` follows `provides-data` + own edges; `traceLineage(definitionId)` returns the per-instance breakdown, never a merged blob.
- Depth limit (default 5 hops) with `flags: ["depth-limited"]` when hit.
**Accept:** **c1-shared-datatable attribution assertions flip from expected-fail to green** — DataTable@Users → `/api/users`, DataTable@Invoices → `/api/invoices`, zero `forbidden` hits. Instance attribution accuracy = 1.0 on C1 fixtures.

### [x] 2.3 Handler resolution through props
**Failure modes:** B1
**Build:** same machinery, callback direction:
- `onClick={props.onSave}` → resolve `onSave` at each parent instance → the passed function → its body (which Phase 3 mines for effects). Chain recorded as evidence (`edge-chain`).
- Handles: inline arrows wrapping prop calls, renamed props, default props, destructured-with-rename.
- Unresolvable after 4 levels → `handler: null, flags: ["unresolved-prop-handler"]` — visible, not silent.
**Accept:** fixture `b1-prop-drilled-handler` (4 levels) ≥ 0.85 resolution; unresolved cases flagged in graph.

### [x] 2.4 Store adapter — writers ↔ readers
**Failure modes:** C6, B2 (redux/zustand half)
**Build:**
- Redux/RTK: slice detection (`createSlice`), `useSelector(s => s.users)` → StateNode per slice path; dispatch sites of thunks/actions that carry API results → `writes-state` edges from the data source to the slice.
- Zustand: `create()` stores, actions that fetch → same `writes-state` linkage.
- `traceLineage` through a StateNode now continues to its writers: reader component → slice → populating API.
**Accept:** fixture `c6-store-decoupled` green — component with **no fetch of its own** correctly attributed to the API called on a different page at login.

### [x] 2.5 Portals, modals, toasts
**Failure modes:** A9
**Build:** `createPortal` detection + adapter list for common modal/toast libs (`react-modal`, radix `Dialog`, `react-hot-toast`): the triggering instance gets a `triggers-render` edge to the portal-content instance.
**Accept:** fixture `a9-modal-portal` green: matching the modal's text surfaces both the modal component and its trigger site. **Gate 2 passes.**

---

## Phase 3 — Journey graph

### [x] 3.1 Router adapters
**Failure modes:** B4
**Build:** `RouteNode` (`path`, `layout`, `guards`) in core. Adapters: React Router (`createBrowserRouter` / `<Route>` trees, nested + lazy) and Next.js file-based (app + pages router). `routes-to` edges route → page-component instance tree.
**Accept:** fixtures `b4-react-router`, `b4-nextjs-approuter` green: every golden route maps to its page component.

### [x] 3.2 Action effects
**Failure modes:** B3, B2 (dispatch half)
**Build:** mine resolved handler bodies (from 2.3) for effects, each a typed `triggers` edge from the EventNode:
- `navigate(...)`/`router.push(...)` → `navigates-to` with route pattern (computed strings → `:param` form, B3)
- fetch/axios/wrapper calls → existing data-source edges
- `dispatch(action)` → through the 2.4 adapter to state writes
- `setState`/setters → `writes-state` on local state
**Accept:** fixture `b3-programmatic-nav` green; every effect kind covered by a unit test.

### [x] 3.3 Journey query — lazy expansion
**Failure modes:** B5, B6
**Build:** `journeys(graph, startInstanceId | routePath, { depth })` in core:
- BFS over event → effect → route → page-instance → its events…, expanding paths **at query time**; per-path visited-set for cycle handling (a node may repeat across paths, not within one); cap + `truncated` flag.
- Steps carry `EdgeCondition`s (branch/flag/role) so a journey reads: *Users page → [role=admin] Delete click → DELETE /api/users/:id → confirm toast*.
- Returns `QueryResult<JourneyPath[]>`.
**Accept:** fixture `b6-cyclic-journeys` (list ↔ detail loop): 3-level golden paths exact, terminates < 1 s; depth-n request on a cyclic graph never hangs.

### [x] 3.4 Form libraries & non-JSX events
**Failure modes:** B7, B8
**Build:** react-hook-form / Formik adapters (`handleSubmit(onSubmit)` → real handler); `addEventListener` in `useEffect` → EventNode (`source: "effect"`); adapter list for hotkey libs. Unknown patterns → file-level `flags: ["unscanned-events"]`.
**Accept:** fixtures `b8-react-hook-form`, `b7-effect-listeners` green.

### [x] 3.5 Flag / role conditions
**Failure modes:** G5, B5
**Build:** feature-flag detection (configurable call names: `useFlag`, `useFeature`, `isEnabled`) and role checks in render branches → `EdgeCondition{kind:"flag"|"role"}` on the enclosed `renders`/`handles` edges.
**Accept:** fixture `g5-feature-flag` green: flag-gated UI's journey step carries the flag name. **Gate 3 passes.**

### [x] 3.6 Cross-app hops (added — was a catalog gap)
**Failure modes:** B9
**Build:** `ExternalNode` + `exits-app` / `enters-at` edges. Navigate/`window.open`/`window.location.assign`/`<a href>`/`<Link to>` to an absolute URL or `mailto:`/`tel:` scheme → `exits-app` (event or component → external, deduped by host). Deep-link/OAuth-callback route paths → `enters-at` from an inbound external node. Journeys reaching an external end with an `exit` step.
**Accept:** fixture `b9-cross-app-hops` green (OAuth redirect, Stripe `window.open`, mailto link, `/auth/callback` entry).

---

## Phase 4 — Matching engine

### [x] 4.1 Term matching v2
**Failure modes:** A4, A7 (matching half), A10
**Build:** replace `matchComponentsByText` with a scorer over instances:
- Normalization (from 1.5) both sides; fuzzy token match (edit distance ≤ 1 per token, token-set overlap) for OCR noise.
- Rarity weighting: term weight = inverse frequency across the graph ("Save" ≈ 0, "Reconciliation" ≈ high).
- Combination bonus: co-occurrence of multiple terms in one instance subtree outweighs scattered singles.
**Accept:** `a4-generic-text` green ("Save" alone → `ambiguous`; "Save" + "invoice details" → correct top-1); noisy-term fixture `a10-ocr-noise` (misspelled terms) top-3 correct.

### [x] 4.2 Structural matching
**Failure modes:** A1, A3, A12 — fixtures: `a1-no-static-text`, `a3-api-text`, `a12-non-text` (structure-only matches capped at medium confidence — honest graceful degradation)
**Build:** structural signature per instance subtree (child element kinds/counts: table with N columns, form with M inputs, card grid). Query side accepts a structure descriptor (from vision output: "a table with columns Name, Email, Actions") and scores against signatures. Text and structure scores combine into one ranking.
**Accept:** fixture `a1-no-static-text` (dashboard, zero literals) top-3 correct via structure alone.

### [x] 4.3 Most-specific-subtree resolution
**Failure modes:** A6
**Build:** when matches nest (Page > Section > Card all match), return the deepest instance covering the matched term/structure set; ancestors listed as `context`, not competing candidates.
**Accept:** fixture `a6-composed-page` green: full-page term set → page node; card-specific terms → card instance with page as context.

### [x] 4.4 Screenshot adapter
**Failure modes:** A10, E3, A13
**Build:** `@coderadar/vision` package:
- `VisionAdapter` interface: `extract(image) → { terms: string[], structure: StructureDescriptor, annotations: Region[] }`. Ships with a Claude-vision implementation; OCR-only fallback stub for tests.
- Annotation-region priority (E3): terms inside detected circles/arrows weighted 3×.
- Non-app detection: extraction result includes `looksLikeApp: boolean` (Figma frames, marketing pages → decline path).
- **Ephemeral only** (G7): images processed in memory, never written to the graph or disk; document in the package README.
**Accept:** interface unit-tested against recorded extraction outputs (no live API in CI); annotation weighting verified on `e3-annotated-screenshot` fixture (pre-extracted terms + regions checked in).

### [x] 4.5 Confidence calibration & ambiguity protocol
**Failure modes:** D2, D6, G1
**Build:**
- Score → confidence mapping calibrated on the eval set (thresholds chosen so measured precision at `high` ≥ 0.95 — recorded in `eval/calibration.json`, regenerated by an eval subcommand).
- `ambiguous` results include `disambiguation`: a concrete question generated from the *differences* between top candidates ("Which page is the table on — Users or Invoices?").
- `declined` results carry a machine-readable reason (`out-of-scope`, `not-our-app`, `no-signal`).
**Accept:** poison rate ≤ 0.05 and ambiguity honesty ≥ 0.90 on the full matching eval set; every `high`-confidence answer in the eval set is correct.

### [x] 4.6 Alias glossary & corrections store
**Failure modes:** E2, G4
**Build:** `aliases.yaml` (checked into the *target* repo): `"invoice widget" → BillingSummaryCard`, route titles, feature names. Corrections API: `recordCorrection(terms, confirmedInstanceId)` appends to `corrections.jsonl`; both feed the matcher as first-class evidence (`kind: "alias" | "correction"`, high weight). Eval subcommand folds corrections into new ticket-eval cases.
**Accept:** fixture `e2-business-vocab` green via alias; a recorded correction changes the next identical query's top-1 (integration test). **Gate 4 passes.**

---

## Phase 5 — Context bundle & agent interface

### [x] 5.1 `resolveContext` orchestrator
**Failure modes:** E1, E5, E6, F6(decline), E4(decline)
**Build:** `@coderadar/agent-sdk` package. `resolveContext(ticket: { text, screenshots?, links? })`:
- Entry-point classification: visual (screenshot present) / textual (UI terms in prose) / behavioral ("clicking X does nothing" → match on event/handler/journey vocabulary, E5) / out-of-domain (backend/infra/perf → `declined`, E6) / unsupported-input (video → structured decline, E4). Classification is rule-based + keyword lexicons; no LLM call inside the node (determinism, G8).
- Runs the matching engine with all available signals; merges rankings.
**Accept:** `eval/tickets/` suite (≥ 15 hand-written tickets: 5 visual, 4 textual, 3 behavioral, 3 out-of-domain) — OOD rejection ≥ 0.95, entry-point classification accuracy ≥ 0.90.

### [x] 5.2 Context-bundle contract
**Failure modes:** F1
**Build:** `ContextBundle` type + JSON Schema (committed, drift-gated): sections `match` (instances + evidence), `lineage` (per-instance sources with patterns/methods), `journeys` (slice around the match, depth 2 default), `blastRadius`, `tests`, `history`, `warnings` (staleness, incomplete flags). Budgeter: `budgetTokens` param; sections trimmed in fixed priority order (match > lineage > blastRadius > journeys > tests > history), each trim recorded in `warnings`.
**Accept:** golden bundles for 5 ticket evals; every bundle ≤ budget under a tokenizer test at budgets 2k/4k/8k; trim order unit-tested.

### [x] 5.3 Blast radius — reverse traversal
**Failure modes:** F2
**Build:** reverse adjacency in core: `blastRadius(nodeId)` → all instances rendering this definition, all consumers of this data source/endpoint, all readers of this state slice, journeys passing through — each with distance. CLI `coderadar impact <node>`.
**Accept:** fixture golden: changing the c1 DataTable definition lists both page instances; changing `/api/users` lists every consumer across fixtures.
**Done:** `blastRadius(graph, target)` in core — a dependency-direction-aware reverse BFS (`dependencyOf` maps each edge kind to resource↔dependent, so a change propagates the right way regardless of edge direction; journey edges don't propagate impact). Resolves a target by node id, component name, endpoint, state name, or route path; returns `ImpactNode[]` (node, relation, distance) nearest-first, always high-confidence. Wired into the context bundle's `blastRadius` section (compact `Name@file:line` labels) and a CLI `impact <node>` command (`-d` depth cap). c1 golden `blast` block asserts both instances (d1) + both pages (d2) for the shared DataTable, and every `/api/users` consumer with an over-reach guard forbidding the invoices side. New `GoldenBlast` type + `blast` check kind in the eval harness. 5 core unit tests; eval 258/0/0, gate OK.

### [x] 5.4 Test coverage mapping
**Failure modes:** F3
**Build:** scan `*.test.*` / `*.spec.*` / `__tests__`: imports + rendered components (`render(<UserList/>)`, testing-library queries) → `TestNode` + `covered-by` edges. Bundle's `tests` section lists test files for matched instances and their lineage.
**Accept:** fixture with co-located tests: bundle names the right test files; components without tests get `warnings: ["untested"]`.
**Done:** `TestNode` (kind `test`, framework vitest/jest/unknown) + `covered-by` edge in core (schema regenerated, drift gate green). New `detectTests` parser pass: test files are excluded from the component/instance scan (`isTestFile`) so they never emit spurious nodes, then swept — every component a test renders (JSX tag) or imports resolves to a `covered-by` edge (imports resolved to their source file for precise attribution, name fallback otherwise). Bundle populates `tests` from the matched component's render subtree (`componentSubtree`) and pushes an `untested` warning when the matched component has no coverage; `blastRadius` counts a test as a dependent of the component it covers. New `f3-test-coverage` fixture + `GoldenCoverage`/`coverage` check kind (covers UserList, Sidebar untested). 6 parser unit tests (incl. two bundle-level); eval 262/0/0, gate OK.

### [x] 5.5 Response-schema linking
**Failure modes:** F4
**Build:** data sources link to response types: generic argument (`useQuery<User[]>`), annotated variable types, or an OpenAPI spec (scan option `openapi: path`) matched by endpoint pattern. Bundle lineage entries carry `responseType: { name, fields }` (one level of fields, not deep).
**Accept:** fixture `f4-typed-responses` green for all three sources (generic, annotation, OpenAPI).
**Done:** `ResponseType { name, fields: {name,type}[], source }` on `DataSourceNode` in core (schema regenerated, drift gate green). New `response.ts` parser module: `responseFromCall` recovers the type from a call's generic argument (`axios.get<User[]>`, `useQuery<T>`) or, failing that, the annotation on the nearest enclosing typed variable whose initializer holds the call (`const data: Invoice[] = await fetch(…).then(r => r.json())`), stopping at function boundaries; only property signatures are read (one level, methods skipped). `loadOpenApi`/`linkOpenApiResponses` is a post-pass that fills untyped sources from an OpenAPI 3 JSON spec (`openapi` scan option / CLI `--openapi`), matching `${METHOD} ${endpoint}` with `{id}`→`:id` normalization and `$ref` resolution. Bundle lineage `dataSources` carry `responseType`; `trace` prints it. New `f4-typed-responses` fixture + `GoldenResponse`/`responses` check kind (all three sources). 5 parser unit tests incl. bundle-level; eval 265/0/0, gate OK.

### [x] 5.6 Git history context
**Failure modes:** F5
**Build:** `history` section: last N commits touching matched files (`git log --follow`), PR numbers parsed from merge/squash subjects. Pure `git` subprocess, no network.
**Accept:** integration test on this repo's own history; graceful empty section outside a git repo.
**Done:** `gitHistory(root, files, limit)` in agent-sdk — per-file `git log --follow` (via `execFileSync`, no network), commits deduped across files and sorted newest-first by committer time, `parsePrNumber` pulls `#NN` from merge/squash subjects. Any failure (not a repo, git missing, untracked path) yields `[]` — the bundle degrades gracefully. Bundle `history` section (default 5) is populated from the matched component's files + render subtree; `BundleCommit` gains optional `pr` (context-bundle schema regenerated, drift gate green). Integration tests run against this repo's own history; 5 agent-sdk unit tests + a bundle-wiring test. eval 265/0/0, gate OK.

### [x] 5.7 MCP server
**Failure modes:** G1 (surface), pipeline integration
**Build:** `@coderadar/mcp` exposing tools: `resolve_context(ticket)`, `find_component(terms)`, `trace_lineage(id)`, `journeys(id, depth)`, `blast_radius(id)` — thin wrappers over agent-sdk against a pre-built graph (path from env/config). Tool descriptions written for agent consumption (when to use which, what `ambiguous` means, that `disambiguation` should be relayed to a human).
**Accept:** MCP integration test via stdio client: scan fixture → each tool returns schema-valid envelopes; `ambiguous`/`declined` statuses round-trip. **Gate 5 passes.** *CodeRadar is now pluggable into the multi-agent system.*
**Done:** new `@coderadar/mcp` package (MCP SDK 1.29). `createServer(graph)` registers all five tools over `@modelcontextprotocol/sdk`'s `McpServer` with zod input schemas and agent-facing descriptions (`resolve_context` returns the full budgeted `ContextBundle`; each tool returns its QueryResult envelope as JSON text; descriptions state that `ambiguous`/`disambiguation` goes to a human). `resolve_context` = `buildBundle`; `find_component`/`trace_lineage`/`journeys`/`blast_radius` wrap core. Bin `coderadar-mcp` loads a graph from `CODERADAR_GRAPH` (or argv) and serves stdio; also shipped in the published `ui-lineage` bundle as the `ui-lineage-mcp` bin (MCP SDK + zod kept external). Integration test via a real stdio `Client`: lists all five tools and round-trips `ok`/`ambiguous`/`declined` over `a4-generic-text` (6 tests). **Gate 5 passed. M5 reached — ticket in → budgeted context bundle out, over MCP.**

---

## Phase 6 — Lifecycle, scale, hardening

### [ ] 6.1 Incremental re-scan
**Failure modes:** D1, G2
**Build:** per-file content hashes in `GraphMeta`; `scan --update` re-parses only changed files + dependents (import graph), rebuilds affected cross-file passes (instances/prop-flow are the tricky part — dependents include all parents of changed components). `--watch` mode for dev.
**Accept:** correctness: incremental result deep-equals full re-scan on 20 randomized single-file edits of the bench repo (property test); 10-file change < 15 s.

### [ ] 6.2 Scale & performance
**Failure modes:** D3
**Build:** `eval/bench/` generator (2,000+ file synthetic app with realistic import depth); profile; apply: lazy ts-morph project loading, file-batch parallelism (worker threads), tree-sitter fast path for the text-extraction pass if ts-morph remains the bottleneck. Perf budget asserted in nightly CI.
**Accept:** full scan < 5 min, peak RSS < 4 GB on the bench repo.

### [ ] 6.3 Determinism
**Failure modes:** G8
**Build:** stable ordering everywhere (nodes, edges, candidates — explicit sort keys, no map-iteration order leaks); vision/OCR results cached by image hash; `generatedAt` excluded from equality. Determinism check in the eval runner (two runs, byte-diff).
**Accept:** double-run byte-identical on all fixtures + bench repo.

### [ ] 6.4 Version skew & rename tracking
**Failure modes:** G3, A11
**Build:** graph store keyed by SHA (`.coderadar/graphs/<sha>.json` + `latest` pointer); `resolveContext` accepts `graphVersion`; cross-version diff maps renamed/moved definitions (same structure+text signature, different name/path) → bundle warning: "matched `InvoiceCard` in prod graph; renamed `BillingCard` on main".
**Accept:** fixture pair (pre/post rename): query against old graph + current code yields the rename warning with the new name.

### [ ] 6.5 Generated/vendored classification & PII policy
**Failure modes:** D5, G7
**Build:** classify generated code (headers like `@generated`, codegen paths, sourcemap-less minified files): excluded from matching, retained as API metadata. PII policy doc (`docs/security.md`): screenshots ephemeral, never persisted/embedded/logged; corrections store holds terms only, never images; enforced by a lint test grepping vision-package writes.
**Accept:** generated-code fixture excluded from match candidates but present in lineage; security doc + lint test in CI. **Gate 6 passes.**

---

## Phase 6F — Field hardening (feedback round 1)

Source: external validation of `ui-lineage@0.3.0` (MCP id `coderadar`) against a production
React 18 + Redux Toolkit + RTK Query + MUI + React Router app (664 components, 1,982 instances,
4,843 edges), 2026-07-15. Verdict: `trace_lineage`, determinism, out-of-domain decline, token
budgeting all solid — but instance resolution hit 28%, RTK Query and object-config routes
produced zero nodes, and a matcher bug made `find_component` non-discriminating, **all while
every gate scores 1.000**. The eval suite has a fixture-vs-reality blind spot; this phase fixes
the field defects and closes that blind spot. Prioritized ahead of 6.1–6.5.

### [x] 6F.1 Punctuation-wildcard matcher fix + no-signal decline
**Failure modes:** A14 (new — added to the catalog in this step), A4, D2, D6
**Build:** rendered-text targets that normalize to empty (`|`, `/`, `:`, `-`) currently match
every query — `find_component(["zzqwxnomatch12345"])` "matches rendered text", and every call
returns the same ~20 punctuation-rendering components ranked only by the query's own character
rarity. Fix in the matcher: discard rendered-text targets that normalize to empty; require a
minimum alphanumeric token length before a rendered-text target can score. Add a `no-signal`
decline: when the only surviving matches are empty/punctuation targets, return `declined`
(reason `no-signal`) instead of `ambiguous` with a full candidate list.
**Accept:** new fixture `a14-punctuation-wildcard` (components rendering bare `|` / `/` / `-`):
gibberish query → `declined: no-signal`; a real query ranks the true component top-1 with
punctuation components scoring 0; `resolveContext` no longer reports high confidence against
punctuation-only matches.
**Done:** root cause was `textMatches` (core text.ts): an empty haystack — rendered text like
`|` normalizes to `""` — satisfies `needle.includes(haystack)` for every query, and a pure-`*`
template collapses to a match-everything regex the same way. New `hasMatchSignal(normalized)`
guard (≥ 2 alphanumeric chars, wildcards/spaces excluded) short-circuits `textMatches`, so
punctuation-only and pure-wildcard targets never match anything; with no surviving targets,
gibberish falls through to the existing `declined("no-signal")` path (no separate decline
branch needed), and `resolveContext` inherits the fix through `matchComponents`. A14 added to
docs/failure-modes.md. New fixture `a14-punctuation-wildcard` (Divider `|`, Breadcrumb `/` `-`,
CalendarPanel): gibberish declines, a real term ranks CalendarPanel top-1 with no punctuation
noise, gibberish mixed into a real query doesn't poison it. 8 new core unit tests; eval
271/0/0, gate OK.

### [x] 6F.2 Field-pattern eval fixture
**Failure modes:** D2 (the eval blind spot itself)
**Build:** new fixture `eval/fixtures/field-patterns` mirroring the shapes the field app used
and current fixtures miss: multi-hop aliased barrel chains (`index.ts` re-export → tsconfig
`paths` alias → `export { X as Y }`), `Loadable(lazy(() => import()))` pages, an RTK Query
store (`createApi` + `injectEndpoints` + `builder.query|mutation` split across files under
`store/api/`), object-config `createBrowserRouter([...])` assembled from separate route files,
and tests using a custom render wrapper. Goldens assert target behavior (resolution rate,
data-source/route/coverage counts); checks owned by 6F.3–6F.6 land in an explicit skip list and
are enabled by their steps, so `pnpm eval` stays green throughout.
**Accept:** fixture scans clean; 6F.1 checks green; skip list names the step that must enable
each remaining check.
**Done:** new fixture `eval/fixtures/field-patterns` (11 app files): two-hop barrel + rename
(`components/index.ts` → `ui/index.ts` → definition), `@ui`/`@store/*` tsconfig-path aliases,
`Loadable(lazy(() => import()))` page elements, route arrays declared in `routes.tsx`,
spread-composed, and passed to `createBrowserRouter` as an imported identifier, an RTK Query
store (`createApi` base + two `injectEndpoints` slices with string-form and object-form
`query` plus a `builder.mutation`), and a test rendering through a custom
`renderWithProviders` wrapper. The harness's native xfail is the skip list: 9 target checks
carry `expectedFail` naming the enabling step (6F.3: DataGrid instance count + blast radius ·
6F.4: two endpoint attributions · 6F.5: three routes, one effect, one journey), and
unexpected-pass gating removes stale marks the moment a capability lands. checks.ts change:
xfail-marked attributions stay out of the lineage precision/recall tallies while marked, so a
known-missing capability doesn't depress global metrics. Scanning the fixture confirmed the
field diagnosis — the `@ui` alias import yields NO instance node for UsersPage's `<Grid/>`,
and 0 route/data-source/hook nodes exist. Already working in this shape (kept as passing
checks): relative two-hop barrel rename (InvoicesPage's Grid), covered-by through the custom
wrapper — so 6F.6 must find the actual field-breaking coverage variant and extend the fixture.
eval 280 pass / 0 fail / 9 xfail / 0 unexpected-pass, gate OK, all metrics 1.000.

### [x] 6F.3 Instance→definition resolution hardening
**Failure modes:** A5, C1, F2, D4
**Build:** the field run linked only 563/1,982 instances (28%) — barrel resolution passes unit
tests but real chains break it. Extend import resolution: tsconfig `paths` aliases, multi-hop
re-export chains, `export * from`, default-export renames, and
`Loadable(lazy(() => import()))` / `React.lazy` wrappers. Unresolved instances keep the
`incomplete` flag with the failing import path recorded as evidence.
**Accept:** field-patterns fixture instance→definition resolution ≥ 95%; `blastRadius` on a
shared component returns its true dependents (field regression: was 0); render graph connects
route roots to leaf instances; enable the 6F.2 checks.
**Done:** two scanner changes. (1) `scanReact` now honors the scanned app's own
`tsconfig.json` (passed as `tsConfigFilePath`, file discovery still ours) so `baseUrl`/`paths`
make alias imports resolvable — `@ui` → two-hop rename barrel → definition now links, where
before the usage produced no instance node at all. (2) New `lazyDefinition` resolution in
`materializeInstances`: a tag naming a module-scope
`const X = Loadable(lazy(() => import("./Page")))` (or bare `React.lazy`) unwraps to the
dynamic import and resolves the target module's default export — exercised by a new
`PreviewPane` fixture component whose variable name differs from the definition, so only the
unwrap can link it. Fixture golden: 6F.3 marks removed (DataGrid instances = 2, blast radius
DataGrid → UsersPage + InvoicesPage), InvoicesPage now has 1 instance (PreviewPane's lazy
usage). 100% of the fixture's component usages resolve. 2 new parser unit tests (121 total);
eval 283 pass / 0 fail / 7 xfail (all owned by 6F.4–6F.5) / 0 unexpected-pass, gate OK,
metrics 1.000.

### [ ] 6F.4 RTK Query extractor
**Failure modes:** B2, C5, C6
**Build:** `createApi` / `injectEndpoints` / `builder.query|mutation` are unrecognized today —
0 data-source nodes across ~40 store files in the field run, so the entire server-cache
dimension is invisible. Recognize API-slice endpoint definitions as `DataSourceNode`s (URL from
the `query` builder, method, tags), link generated hooks (`useGetUsersQuery`) at component call
sites → per-instance `fetches-from` edges, and model server-cache selectors
(`useSelector` on the api reducer path) as `StateNode` reads.
**Accept:** field-patterns fixture: every endpoint under `store/api/**` emits a data-source
node; `traceLineage` from a component using a generated hook reaches its endpoint; enable the
6F.2 checks.

### [ ] 6F.5 Object-config React Router recognition
**Failure modes:** B4, B3
**Build:** step 3.1 covers `createBrowserRouter` on fixtures, but the field app produced 0
route nodes — diagnose and close the gap: route-object arrays defined in separate
files/variables (not inline at the call site), spread/composed arrays, `children` nesting,
the `lazy:` route property, and `Loadable(lazy())` page `element`s. `routes-to` edges must
survive the lazy wrapper (depends on 6F.3).
**Accept:** field-patterns fixture: all golden routes emit `RouteNode`s; `journeys("/route")`
returns a real multi-step path (field regression: was `declined: not-found`); enable the 6F.2
checks.

### [ ] 6F.6 Test-coverage detection hardening
**Failure modes:** F3
**Build:** the field run found 1 `covered-by` edge app-wide, making `untested` warnings
near-universal noise. Handle custom render wrappers (`renderWithProviders(<X/>)` — resolve
through to the JSX argument), test files importing through the same alias/barrel chains as
6F.3, and suites living outside `__tests__`. When coverage mapping is still near-empty
(< 5% of components covered), replace per-bundle `untested` warnings with a single graph-level
`coverage-unmapped` note.
**Accept:** field-patterns fixture: wrapped renders produce `covered-by` edges; a near-empty
coverage graph emits `coverage-unmapped` instead of per-component `untested`; enable the 6F.2
checks.

### [ ] 6F.7 Scoring & result-surface polish
**Failure modes:** A4, D2, D6
**Build:** weight matches by term specificity against the candidate's own identifiers (name,
props, file path), not global character rarity alone — gibberish must never outscore a real
term (field: 6.50 for gibberish vs 6.09 for "calendar"). Expose a top-line `score` alongside
`confidence` on every `find_component` / `resolve_context` candidate (currently nested and easy
to misread) — core envelope, CLI output, MCP result schema.
**Accept:** ranking fixture: identifier-specific terms beat rarity-only scores; `score` present
at candidate top level across CLI + MCP (schemas regenerated, drift gate green).

### [ ] 6F.8 Galaxy visualizer (`coderadar visualize`)
**Failure modes:** — (user-requested feature, 2026-07-15)
**Build:** new CLI command `visualize -g <graph.json> -o <out.html>` emitting a single
self-contained HTML file (graph JSON + all JS/CSS inlined, zero network dependencies) that
renders the lineage graph as a canvas force-directed "galaxy": node kinds color-coded
(component / instance / hook / data-source / state / event / route / external), edges typed.
Interactions: kind + edge-type filter toggles, search with fly-to, click → detail panel (name,
file, loc, props) with neighborhood highlight (visual blast radius) and dim-others, zoom/pan,
physics pause. Must stay responsive at field scale (~2.6k nodes / ~4.8k edges).
**Accept:** generated from the demo-app graph: opens from `file://` with no external requests,
all node kinds rendered and filterable; unit tests on generation (embedded JSON round-trips,
output is self-contained); README section with a screenshot.

**Gate 6F:** field-patterns fixture fully green (skip list empty) · instance resolution ≥ 95% ·
RTK data sources > 0 · route nodes > 0 · gibberish queries decline `no-signal` · `pnpm eval`
green end-to-end.

---

## Phase 7 — Backend parsers & federation (v2 horizon)

Sketch level — detail before starting the phase, after v1 feedback.

- **7.1 GraphQL adapter** (C4): operations/fragments as data sources; codegen types feed 5.5.
- **7.2 Next.js server data** (C9): RSC async components, `getServerSideProps`, server actions as first-class data sources.
- **7.3 Push channels** (C8): WebSocket/SSE subscription nodes.
- **7.4 Python backend parser** (C10, G6): FastAPI/Django route decorators → `ServesNode{ method, pattern }`; tree-sitter based, emits the same LineageGraph JSON.
- **7.5 Go backend parser**: mux/gin/echo handler registration → `ServesNode`.
- **7.6 Federation** (G6): endpoint-pattern join across graphs (`fetches-from: /api/users` ↔ `serves: /api/users`); multi-graph loader in agent-sdk; bundle lineage extends to the owning service + handler file.
- **Gate 7:** cross-repo fixture (React app + FastAPI service): `resolveContext` reaches the Python handler.

---

## Deferred beyond v2

- **C11** — field-level attribution (response field → rendered value)
- **F6** — CSS/styling lineage
- **E4** — video/GIF frame extraction

## Milestones

| Milestone | Meaning | Phases |
|-----------|---------|--------|
| M0 | Measurement loop exists — every later claim is testable | 0 |
| M1 | Survives real-world code patterns | 1 |
| M2 | **Headline correct:** per-instance API attribution (C1) + handler resolution (B1) | 2 |
| M3 | n-level journeys, lazily expanded | 3 |
| M4 | Screenshot/text → ranked, calibrated, honest matches | 4 |
| M5 ✅ | **Pluggable node:** ticket in → budgeted context bundle out, over MCP | 5 |
| M6F | Field-hardened: v0.3.0 feedback closed — trustworthy matching + real-world extractors + visualizer | 6F |
| M6 | Production-grade: incremental, fast, deterministic, versioned | 6 |
| M7 | Full-stack lineage: pixel → backend handler | 7 |
