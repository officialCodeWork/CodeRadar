/**
 * The corrections store (TRACKER step 4.6, failure mode G4).
 *
 * When a human confirms that a set of terms means a specific component, that
 * confirmation is appended to a `corrections.jsonl` file (one JSON object per
 * line) and fed back to the matcher as the highest-weight evidence, so the next
 * identical query resolves the same way. Terms only — never screenshots (G7).
 */
import fs from "node:fs";

import type { Correction } from "./query.js";

/** Read all corrections from a JSONL file. Missing file → empty list. */
export function loadCorrections(path: string): Correction[] {
  if (!fs.existsSync(path)) return [];
  return fs
    .readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Correction);
}

/** Append one correction to the JSONL store. */
export function recordCorrection(path: string, correction: Correction): void {
  fs.appendFileSync(path, `${JSON.stringify(correction)}\n`);
}
