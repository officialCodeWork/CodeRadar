# Failure-mode catalog

Every known way CodeRadar can produce a wrong, missing, or misleading answer.
Each item has a stable ID (`A1`, `C6`, …) referenced by [TRACKER.md](../TRACKER.md) steps
and by eval fixtures (`eval/fixtures/<id>-*`). When a new failure mode is discovered,
add it here first, then add a fixture, then plan the fix.

**Context:** CodeRadar is a context-provider node in a multi-agent development pipeline.
Input: a Jira ticket (text + screenshots + links). Output: a context bundle (matched
components, data lineage, journey slice, blast radius) for a developer agent.
The worst failure anywhere in this catalog is a **confidently wrong answer** — it poisons
every downstream agent. When in doubt, return ranked candidates with evidence, or decline.

---

## A. Screenshot → component matching

| ID | Failure | Why it breaks | Mitigation | Phase |
|----|---------|---------------|------------|-------|
| A1 | **No static text** — dashboards render only `{data.value}` | `renderedText` is empty; text matching has nothing | Structural matching: match on component composition (child kinds, layout shape) | 4 |
| A2 | **i18n keys** — source has `t("team.title")`, screenshot shows "Team Members" / "Équipe" | Literal lives in locale JSON, not JSX | i18n adapter: parse locale files, join keys → strings per locale | 1 |
| A3 | **Text served by API/CMS** — labels come from the backend | Text not in the repo at all | Structural matching fallback + low-confidence flag | 4 |
| A4 | **Generic text collisions** — "Save"/"Cancel" appear in 40 components | Single term → 40 candidates | Rarity weighting (rare terms count more) + multi-term combination scoring | 4 |
| A5 | **Design-system components** — screenshot shows library `<Button>` | Matching the definition is useless; user needs the usage site | Instance nodes: match resolves to instances, not definitions | 2 |
| A6 | **Composed pages** — a screenshot contains 30 nested components | No single "the" component | Return the most-specific matching subtree, parents included as context | 4 |
| A7 | **Runtime text transforms** — CSS uppercase, truncation, `` `${count} items` `` | Screenshot text ≠ source literal | Normalization pipeline (case/whitespace-insensitive, template-aware fuzzy match) | 1, 4 |
| A8 | **Conditional branches** — error/empty/loading states render different text | Text only exists in one branch | Collect text from all branches, tagged with branch condition | 1 |
| A9 | **Portals/modals/toasts** — rendered far from the trigger | Screenshot shows modal; trigger lives elsewhere; both matter | `triggers-render` edges from trigger site to portal content | 2 |
| A10 | **OCR noise & crops** — compressed, cropped, red-arrow-annotated screenshots | Terms are partial/misread | Fuzzy matching tolerant to edit distance; annotation-region priority | 4 |
| A11 | **Version drift** — screenshot from prod, graph from today's main | Component renamed/removed since | SHA-tagged graphs; report renames across graph versions | 6 |
| A12 | **Non-text UI** — charts, icons, canvases | Nothing to text-match | Graceful degradation: structural candidates + explicit low confidence | 4 |
| A13 | **Third-party embeds** — Intercom, iframes | Content isn't ours | Detect and report "not in this codebase" | 4 |

## B. User-journey extraction

| ID | Failure | Why it breaks | Mitigation | Phase |
|----|---------|---------------|------------|-------|
| B1 | **Callback prop-drilling** — `onClick={props.onSave}`, handler defined 4 levels up | Per-file analysis stops at the prop boundary | Handler resolution through prop-flow across instances | 2 |
| B2 | **Store/effect indirection** — dispatch → saga/thunk → API → action → UI | No direct call edge through middleware | Pattern adapters per library (thunk, RTK Query, saga, zustand actions) | 2, 3 |
| B3 | **Programmatic navigation** — `navigate(\`/users/${id}\`)` | Route string is computed | Record as pattern `navigates-to: /users/:param` | 3 |
| B4 | **Router architecture** — nested routes, guards, redirects, lazy modules | Journey graph needs router config as input | Router adapters (React Router, Next.js file-based) | 3 |
| B5 | **Conditional journeys** — next step depends on response/role/flag | A journey is a branching tree, not a path | Conditions as first-class edge metadata | 3 |
| B6 | **Cycles** — back buttons, list↔detail loops | "All journeys at n levels" is infinite if enumerated | Never precompute paths: store the action graph, expand lazily with cycle detection | 3 |
| B7 | **Non-JSX events** — `addEventListener` in effects, hotkeys, drag-drop, observers, timers | `on*` attribute scan misses them | Effect-body scanning + library adapters; known-gap flag otherwise | 3 |
| B8 | **Form libraries** — `handleSubmit(onSubmit)` hides the real handler | One level of library indirection | react-hook-form/Formik adapters | 3 |
| B9 | **Cross-app hops** — OAuth, payment gateways, email links | Journey exits the codebase | Mark `exits-app` / `enters-at` edges | 3 |

## C. API attribution

| ID | Failure | Why it breaks | Mitigation | Phase |
|----|---------|---------------|------------|-------|
| C1 | **Shared component, different API per context** — `<DataTable data={users}>` vs `<DataTable data={invoices}>` | The API lives in the parent, not the component; per-definition attribution is wrong | **Instance nodes** + prop-flow: data attribution is per call site | 2 |
| C2 | **Endpoint indirection** — `apiClient.get(ENDPOINTS.USERS)`, constants in other files | Endpoint isn't a literal at the call site | Constant folding across files + API-client wrapper adapter | 1 |
| C3 | **Dynamic endpoints** — `` `/api/${entity}/${id}` `` with runtime values | Not statically resolvable | Resolve to pattern `/api/*/:id`, flag unresolved segments | 1 |
| C4 | **GraphQL** — one endpoint, many operations, fragments across files | HTTP-level attribution is meaningless | Operation-level adapter; fragment resolution | 7 |
| C5 | **react-query/SWR queryFn indirection** — endpoint inside `fetchUsers` in another file | Hook call site doesn't contain the URL | Follow the queryFn reference to its definition | 1 |
| C6 | **Temporal decoupling via stores** — component reads a slice populated elsewhere, earlier | Reader's own code has no fetch | Trace slice *writers*: link `useSelector(s => s.users)` to the dispatch site of the populating API call | 2 |
| C7 | **Cache-seeded data** — react-query/Apollo cache sharing across queries | Visible data came from a different query | Query-key/cache-id linking where static; known-gap flag otherwise | 7 |
| C8 | **Push data** — WebSockets, SSE, polling | No request initiated by the component | Socket subscription nodes (`websocket` source kind) | 7 |
| C9 | **SSR / Server Components** — RSC, `getServerSideProps`, server actions | Server-side fetching, different syntax; actions aren't endpoints | Next.js adapter for server data paths | 7 |
| C10 | **BFF/proxy fan-out** — `/api/bff/dashboard` hides 5 microservices | Frontend graph bottoms out at the BFF | Backend parsers + cross-repo endpoint join (see G6) | 7 |
| C11 | **Field-level attribution** — "the email is wrong" needs `user.email ← response.email` | Prop-chain tracing through transforms is deep | **Deferred post-v1.** Component-level attribution first; field-level as v2 | — |

## D. Systemic

| ID | Failure | Why it breaks | Mitigation | Phase |
|----|---------|---------------|------------|-------|
| D1 | **Graph staleness** — code changed since scan | Wrong-but-confident answers | CI rebuild on merge, SHA tagging, incremental re-scan | 6 |
| D2 | **False confidence** — agent runs with a single wrong answer | Poisons the pipeline | Every query returns ranked candidates + evidence + calibrated confidence; never a bare answer | 0 (schema), 4 |
| D3 | **Scale** — ts-morph on 5k files: minutes + GBs | Unusable on real monorepos | Lazy loading, per-file parallelism, perf budget in CI | 6 |
| D4 | **Untyped/legacy code** — plain JS, class components, HOCs, `createElement` | Parser gaps | Class-component support; degrade to partial nodes flagged `incomplete` | 1 |
| D5 | **Generated/vendored code** — codegen output, minified vendor files | Pollutes matching | Classify: exclude from matching, keep as API metadata | 6 |
| D6 | **No ambiguity protocol** — 5 tied candidates, agent picks #1 | Coin-flip development | `ambiguous` result type + the question that would disambiguate | 4 |

## E. Input side — the Jira ticket

| ID | Failure | Why it breaks | Mitigation | Phase |
|----|---------|---------------|------------|-------|
| E1 | **No screenshot** — text-only ticket | Screenshot matching is one entry point, not the only one | `resolveContext` accepts text; term extraction from ticket prose | 5 |
| E2 | **Business vocabulary ≠ code vocabulary** — "invoice widget" vs `BillingSummaryCard` | Perfect graph, failed match | Alias glossary (routes, titles, feature names → components), fed by corrections (G4) | 4 |
| E3 | **Screenshot of the wrong thing** — full page with red circle; or a Figma mock | Matching the whole image misleads | Annotation-region detection: prioritize circled areas; detect non-app images | 4 |
| E4 | **Video/GIF attachments** — screen recordings | No still to match | **Declined in v1**: respond "unsupported, provide a still" |
| E5 | **Behavior-described tickets** — "clicking save does nothing" | Entry point is an action, not a visual | Match on event/handler/journey vocabulary, not rendered text | 5 |
| E6 | **Non-UI tickets** — backend, infra, perf | Forced component match = worst-case poison | Out-of-domain classification; explicit decline | 5 |

## F. Output side — the context contract

| ID | Failure | Why it breaks | Mitigation | Phase |
|----|---------|---------------|------------|-------|
| F1 | **Wrong-sized output** — whole subgraph blows the dev agent's context window | Downstream agent degrades | Context bundle with an explicit token budget; priority-ordered trimming | 5 |
| F2 | **Missing blast radius** — dev agent modifies without knowing who else is affected | Regressions | Reverse traversal as a first-class query (who renders this, who calls this API) | 5 |
| F3 | **Missing test context** — agent doesn't know what to run/update | Unverified changes | TestNode + `covered-by` edges from test-file imports | 5 |
| F4 | **Endpoint without schema** — "`GET /api/users`" isn't enough to write code | Agent guesses shapes | Link data sources to TS response types / OpenAPI where resolvable | 5 |
| F5 | **No git history** — "broke recently" correlates with recent changes | Missing the best bug signal | Recent commits/PRs touching matched files in the bundle | 5 |
| F6 | **Styling tickets** — "button misaligned" is CSS lineage | Graph doesn't model styles | v1: classify-and-decline with the component match only; CSS lineage is v2 | — |

## G. Pipeline integration

| ID | Failure | Why it breaks | Mitigation | Phase |
|----|---------|---------------|------------|-------|
| G1 | **No escalation protocol** — low confidence, pipeline proceeds anyway | Silent coin flips | Structured `ambiguous`/`declined` responses the orchestrator can route to a human | 4, 5 |
| G2 | **Scan-per-ticket latency** — minutes per query | Pipeline stalls | Pre-built graph, stored + versioned; queries in milliseconds | 0, 6 |
| G3 | **Version skew** — graph from main, screenshot from prod release | Context references code that doesn't exist on the working branch | Graphs tagged by commit SHA; rename tracking across versions | 6 |
| G4 | **No feedback loop** — wrong match never corrected | Same mistake forever | Corrections store: `(ticket terms) → confirmed component`; doubles as glossary (E2) and eval data | 4 |
| G5 | **Flags/roles/tenants** — screenshot state only visible under flag X | Dev agent can't reproduce | Flag/role conditions recorded on render edges | 3 |
| G6 | **Multi-repo federation** — FE, BFF, services in separate repos | Lineage stops at the repo boundary | Endpoint path as cross-graph join key; federation loader | 7 |
| G7 | **PII in screenshots** — prod customer data | Compliance exposure | Ephemeral processing only; never persist or embed screenshots | 6 |
| G8 | **Non-determinism** — same ticket, different bundle | Undebuggable pipeline | Stable sort orders; cacheable, isolated OCR/vision steps; determinism tests | 6 |

---

## Explicitly deferred (not planned in v1)

- **C11** field-level attribution (which response *field* feeds which rendered value)
- **F6** CSS/styling lineage
- **E4** video/GIF attachment processing (declined with a structured message)

## The five that shape the architecture

1. **C1** — instance nodes, not just definitions. Attribution is per call site.
2. **B1** — handler resolution through props. The core static-analysis investment.
3. **B6** — journeys are lazily-expanded graphs, never enumerated paths.
4. **D2** — evidence + confidence on every answer. The agent contract.
5. **E1/F1** — the node's input is a *ticket* and its output is a *budgeted bundle*, not a screenshot in and a node id out.
