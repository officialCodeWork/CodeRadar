# Security & PII policy

CodeRadar reads source code and, optionally, screenshots attached to a ticket.
Source code is already in the repository the operator controls; **screenshots are
the sensitive surface** — a bug report may show real user data, PII, or internal
UI. This document states how that data is handled and how the policy is enforced
in CI. It maps to failure mode **G7** (privacy) and is part of the **Phase 6**
gate.

## Principles

1. **Screenshots are ephemeral.** An image is processed in memory and discarded.
   CodeRadar never writes a screenshot to disk, never embeds one in the lineage
   graph, and never logs its bytes. The only place image bytes leave the process
   is the vision adapter's call to the model API the operator has configured
   (`packages/vision/src/claude.ts`), and only for the duration of that request.

2. **The graph holds no image data.** `scan` emits `ui-lineage.graph.json` from
   source code alone. No node or edge carries a screenshot, a crop, a base64
   blob, or a data URI. The graph is safe to commit and share.

3. **The corrections store holds terms only.** When a human confirms that a set
   of terms resolves to a component, `corrections.jsonl`
   (`packages/core/src/corrections.ts`) records the **terms and the component
   id** — never the screenshot the terms were read from. Corrections are safe to
   check in.

4. **No persistence of derived crops or OCR images.** Vision adapters return
   *text and structure* (`VisionExtraction`) — the signals the matcher already
   understands — not pixels. Any future OCR/vision cache keys on an image **hash**,
   never the image itself.

5. **Least logging.** Diagnostic output names components, files, and terms. It
   does not include screenshot bytes or the raw model image payload.

## What may be persisted

| Artifact | Contents | Safe to share |
| --- | --- | --- |
| `ui-lineage.graph.json` | Source-derived nodes/edges | Yes |
| `corrections.jsonl` | Confirmed terms → component id | Yes |
| `ui-lineage.corrections.jsonl` | (same) | Yes |
| Screenshots | — | **Never written** |

## Enforcement

The policy is not just documentation — it is asserted by a test that fails CI if
the vision package gains a filesystem write or a code path that persists image
bytes:

- `packages/vision/src/policy.test.ts` greps the vision source for filesystem
  write APIs (`writeFile`, `writeFileSync`, `appendFile*`, `createWriteStream`,
  `fs.write`, `mkdir*` used for output) and for image persistence patterns
  (writing `.png`/`.jpg`, `toDataURL`, embedding base64 into a written file). Any
  hit fails the test. The single legitimate base64 conversion — encoding an image
  for the model request in `claude.ts` — is in-memory and is asserted to flow only
  into the API `messages.create` call, not into any sink.

Run it with `pnpm --filter @coderadar/vision test`, or as part of `pnpm -r test`
in CI.

## Reporting

If you find a path that writes, embeds, or logs screenshot data, treat it as a
privacy defect (G7): open an issue and add the offending pattern to
`policy.test.ts` so the regression is locked out.
