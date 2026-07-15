/**
 * Vision adapter contract (TRACKER step 4.4, failure modes A10/E3/A13).
 *
 * An adapter turns a screenshot into the same signals the matcher already
 * understands — visible text, a structure descriptor, and annotation regions
 * (circles/arrows a user drew to point at something). Images are **ephemeral**:
 * processed in memory, never written to the graph or disk (G7).
 */
import type { StructureDescriptor } from "@coderadar/core";

/** A screenshot passed to an adapter. `data` is raw bytes or a base64 string. */
export interface VisionImage {
  data: Uint8Array | string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/** A user annotation on the screenshot and the terms it emphasizes (E3). */
export interface Region {
  kind: "circle" | "arrow" | "box" | "highlight";
  /** Bounding box in image pixels. */
  bounds: { x: number; y: number; w: number; h: number };
  /** Text inside/near the annotation — weighted higher by the matcher. */
  terms: string[];
}

/** The structured result of reading a screenshot. */
export interface VisionExtraction {
  /** All visible text fragments. */
  terms: string[];
  /** Structural shape of the UI (a table with N columns, a form, a card grid). */
  structure: StructureDescriptor;
  /** Annotation regions (circles/arrows) and the terms they point at. */
  annotations: Region[];
  /**
   * False for Figma frames, marketing pages, and other non-app images — the
   * matcher declines rather than guessing (A13).
   */
  looksLikeApp: boolean;
}

export interface VisionAdapter {
  /** Extract signals from an image. Implementations must not persist the image. */
  extract(image: VisionImage): Promise<VisionExtraction>;
}
