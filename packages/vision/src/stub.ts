import type { VisionAdapter, VisionExtraction } from "./types.js";

/**
 * A deterministic adapter that returns a pre-recorded extraction. Used to test
 * the matching path against checked-in extraction outputs without a live model
 * (the tracker's "OCR-only fallback stub" — no network in CI).
 */
export class StubVisionAdapter implements VisionAdapter {
  constructor(private readonly extraction: VisionExtraction) {}

  extract(): Promise<VisionExtraction> {
    return Promise.resolve(this.extraction);
  }
}
