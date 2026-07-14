# @coderadar/vision

Screenshot → `{ terms, structure, annotations }` for the ui-lineage matcher. Bundled into the published `ui-lineage` package.

## Ephemeral by policy (G7)

Images are processed **in memory only**. This package never writes image bytes to disk, to the lineage graph, or to any cache. Adapters must uphold this — do not add persistence of screenshots. The corrections store (Phase 4.6) keeps *terms*, never images.

## Usage

```ts
import { StubVisionAdapter, matchFromVision } from "ui-lineage/vision";

// Deterministic adapter for tests / recorded extractions:
const adapter = new StubVisionAdapter(recordedExtraction);
const extraction = await adapter.extract(image);
const result = matchFromVision(graph, extraction);
```

Live extraction uses Claude vision and requires you to install the SDK yourself (kept out of the default bundle):

```ts
import { ClaudeVisionAdapter } from "ui-lineage/vision"; // needs `npm i @anthropic-ai/sdk`
const adapter = new ClaudeVisionAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });
```

Terms found inside an annotation (a circle or arrow the user drew) are weighted 3× (`ANNOTATION_BOOST`), so the emphasized element outranks incidental text. A screenshot that isn't this app (`looksLikeApp: false`) declines rather than guessing.
