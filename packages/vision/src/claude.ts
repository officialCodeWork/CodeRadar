/**
 * Claude-vision implementation of VisionAdapter (TRACKER step 4.4).
 *
 * Not exercised in CI (no live API). The `@anthropic-ai/sdk` dependency is
 * imported lazily so neither the rest of ui-lineage nor the test suite requires
 * it — install it yourself to use live extraction:  `npm i @anthropic-ai/sdk`.
 *
 * G7 (ephemeral): the image is sent in-memory and never written to disk or the
 * graph. Do not add caching that persists image bytes.
 */
import type { VisionAdapter, VisionExtraction, VisionImage } from "./types.js";

export interface ClaudeVisionOptions {
  /** Falls back to the ANTHROPIC_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to the latest Opus. */
  model?: string;
}

/** JSON shape the model is asked to return — mirrors VisionExtraction. */
const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    terms: { type: "array", items: { type: "string" } },
    structure: {
      type: "object",
      additionalProperties: false,
      properties: {
        table: { type: "boolean" },
        columns: { type: "integer" },
        form: { type: "boolean" },
        inputs: { type: "integer" },
        buttons: { type: "integer" },
        images: { type: "integer" },
        list: { type: "boolean" },
        cards: { type: "integer" },
      },
      required: [],
    },
    annotations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["circle", "arrow", "box", "highlight"] },
          bounds: {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
            required: ["x", "y", "w", "h"],
          },
          terms: { type: "array", items: { type: "string" } },
        },
        required: ["kind", "bounds", "terms"],
      },
    },
    looksLikeApp: { type: "boolean" },
  },
  required: ["terms", "structure", "annotations", "looksLikeApp"],
} as const;

const EXTRACTION_PROMPT =
  "Read this UI screenshot. Return the visible text fragments, a structural " +
  "descriptor (is there a table and how many columns, a form and how many " +
  "inputs/buttons, images, a list, repeated cards), and any hand-drawn " +
  "annotations (circles/arrows/highlights) with the text they point at. Set " +
  "looksLikeApp=false for Figma frames, marketing pages, or anything that is " +
  "not a running application UI.";

export class ClaudeVisionAdapter implements VisionAdapter {
  constructor(private readonly options: ClaudeVisionOptions = {}) {}

  async extract(image: VisionImage): Promise<VisionExtraction> {
    // Non-literal specifier keeps the SDK out of the type graph and the bundle;
    // it is resolved at runtime only when live extraction is actually used.
    const specifier = "@anthropic-ai/sdk";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(specifier as string);
    const Anthropic = mod.default ?? mod.Anthropic;
    const client = new Anthropic(this.options.apiKey ? { apiKey: this.options.apiKey } : {});
    const data =
      typeof image.data === "string"
        ? image.data
        : Buffer.from(image.data).toString("base64");

    const response = await client.messages.create({
      model: this.options.model ?? "claude-opus-4-8",
      max_tokens: 2000,
      output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data } },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const text = (response.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    return JSON.parse(text) as VisionExtraction;
  }
}
