# Testing strategy

How we know, phase by phase, whether CodeRadar is getting better or drifting wrong.

## Philosophy

1. **Eval-first.** The eval harness (Phase 0.2) is built *before* the features it measures.
   Every phase ends with an eval gate; a phase is not done until its gate passes.
2. **Fixtures encode failure modes.** Every failure mode in
   [failure-modes.md](failure-modes.md) that a phase claims to address gets a fixture —
   a minimal React app fragment reproducing that pattern, plus a golden expected output.
   The scorecard is therefore a direct readout of "which failure modes do we survive."
3. **Thresholds ratchet, never loosen.** CI stores the current thresholds in
   `eval/thresholds.json`. A PR may raise a threshold; lowering one requires a written
   justification in the PR body.
4. **Wrong-and-confident is the cardinal sin.** Metrics penalize a wrong top-1 more than
   an honest `ambiguous`. An answer with high confidence that is wrong counts double
   against accuracy (tracked as the *poison rate*).

## Test layers

| Layer | Location | Runs | Purpose |
|-------|----------|------|---------|
| Unit tests | `packages/*/src/**/*.test.ts` (vitest) | every PR | Parser/query correctness in isolation |
| Fixture evals | `eval/fixtures/` + `eval/run.ts` | every PR | Failure-mode scorecard against golden outputs |
| End-to-end ticket evals | `eval/tickets/` | every PR from Phase 5 | Real-shaped tickets → context bundle correctness |
| Perf benchmarks | `eval/bench/` | nightly / on-demand | Scan time + memory budget on a large fixture repo |
| Determinism tests | part of eval runner | every PR from Phase 6 | Same input twice → byte-identical output |

## Fixture layout

```
eval/
├── fixtures/
│   ├── c1-shared-datatable/        # one fixture per failure-mode ID
│   │   ├── app/                    # minimal React source reproducing the pattern
│   │   └── golden.json             # expected nodes/edges/attributions
│   ├── a2-i18n-keys/
│   ├── b1-prop-drilled-handler/
│   └── ...
├── tickets/                        # Phase 5+: full ticket → bundle cases
│   ├── 001-invoice-total-wrong/
│   │   ├── ticket.json             # text, screenshot terms (pre-OCR'd), links
│   │   └── golden.bundle.json      # expected components, sources, blast radius
│   └── ...
├── bench/                          # generated large repo for perf runs
├── thresholds.json                 # current CI gate values
└── run.ts                          # runner: scan fixtures, diff vs golden, emit scorecard
```

`golden.json` format (per fixture; full contract in `eval/src/golden.ts`):

```json
{
  "failureMode": "C1",
  "app": "./app",
  "expect": {
    "components": [{ "name": "DataTable", "instances": 2 }],
    "attributions": [
      { "component": "DataTable", "instanceAt": "pages/UsersPage.tsx",
        "endpoints": ["/api/users"],
        "expectedFail": "phase-2: per-instance attribution requires prop-flow (step 2.2)" }
    ],
    "forbidden": [
      { "component": "DataTable", "instanceAt": "pages/UsersPage.tsx",
        "endpoint": "/api/invoices",
        "note": "poison: invoices API attributed to the users-page table" }
    ],
    "queries": [
      { "terms": ["Save"], "status": "ambiguous" },
      { "terms": ["All Users"], "status": "ok", "top": "UsersPage" }
    ]
  }
}
```

- `forbidden` entries catch the *specific wrong answer* each failure mode produces —
  passing isn't just finding the right edges, it's not emitting the poisonous ones.
  Forbidden checks never carry `expectedFail`: poison gates in every phase.
- `expectedFail` (per check) gives xfail semantics: a failing check reports `xfail`
  and doesn't gate; a *passing* check still carrying the marker reports
  `unexpected-pass` and **does** gate — stale markers are removed the moment the
  capability lands, so capability arrival is always an explicit, reviewed event.

## Metrics

| Metric | Definition | Used from |
|--------|-----------|-----------|
| **Lineage precision** | attributed data sources that are correct / all attributed | Phase 1 |
| **Lineage recall** | golden data sources found / all golden | Phase 1 |
| **Instance attribution accuracy** | fixtures where per-instance API attribution is exactly right | Phase 2 |
| **Journey edge recall** | golden journey edges recovered / all golden | Phase 3 |
| **Match accuracy@1 / @3** | correct component is top-1 / in top-3 | Phase 4 |
| **Poison rate** | wrong answers delivered with confidence ≥ high / all answers (lower is better) | Phase 4 |
| **Ambiguity honesty** | genuinely ambiguous fixtures answered `ambiguous` (not a wrong top-1) | Phase 4 |
| **OOD rejection** | out-of-domain tickets correctly declined | Phase 5 |
| **Bundle correctness** | ticket evals where the bundle contains all golden sections and respects the token budget | Phase 5 |
| **Scan perf** | full-scan wall time + peak RSS on the bench repo | Phase 6 |
| **Determinism** | byte-identical scorecard across two runs | Phase 6 |

## Phase gates

A phase is complete when `pnpm eval` passes these thresholds (initial values —
ratchet upward as reality informs them):

| Gate | Requirement |
|------|-------------|
| **Gate 0** | Eval harness runs in CI; scorecard.json emitted; demo-app fixture green; schema round-trips (scan → JSON → load → identical) |
| **Gate 1** | Lineage precision ≥ 0.90, recall ≥ 0.80 across fixtures C2, C3, C5, A2, A7, A8, D4; zero `forbidden` hits |
| **Gate 2** | Instance attribution accuracy = 1.0 on C1 fixtures (the headline case); B1 handler resolution ≥ 0.85 on prop-drilling fixtures ≤ 4 levels; C6 store-writer linking green |
| **Gate 3** | Journey edge recall ≥ 0.80 on B3, B4, B8 fixtures; lazy path expansion returns correct 3-level golden paths with cycles present (B6) and terminates < 1 s |
| **Gate 4** | Match accuracy@1 ≥ 0.75, @3 ≥ 0.90 on the matching eval set (incl. noisy-OCR-term fixtures A10); poison rate ≤ 0.05; ambiguity honesty ≥ 0.90 |
| **Gate 5** | Bundle correctness ≥ 0.80 on ticket evals; OOD rejection ≥ 0.95; every bundle ≤ token budget |
| **Gate 6** | Bench repo (≥ 2,000 files): full scan < 5 min, peak RSS < 4 GB; incremental re-scan of 10 changed files < 15 s; determinism green |

## Monitoring direction over time

- `pnpm eval -- --record` appends the run's summary to `eval/history.jsonl`
  (recorded deliberately — e.g. at each step completion — and committed).
  A shrinking metric between phases is a **regression investigation**, not noise.
- From Phase 4, the corrections store (G4) is periodically folded into `eval/tickets/` —
  real mismatches from the pipeline become permanent eval cases. This is the flywheel:
  production errors can only happen once.
- The scorecard is grouped by failure-mode category (A–G), so "are we going the right
  way" is answered per requirement: matching (A), journeys (B), attribution (C), and
  pipeline behavior (D–G) each have their own trend line.
