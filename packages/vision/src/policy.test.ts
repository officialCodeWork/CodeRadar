import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * PII policy enforcement (6.5, G7) — see docs/security.md.
 *
 * Screenshots are ephemeral: the vision package must never write image bytes to
 * disk, embed them in the graph, or persist a derived crop. This test greps the
 * vision source for filesystem-write and image-persistence patterns so the
 * regression is locked out of CI. The one legitimate base64 conversion (encoding
 * an image for the model request in claude.ts) is in-memory and allowed.
 */

const srcDir = path.dirname(fileURLToPath(import.meta.url));

/** Vision source files, excluding tests. */
function sourceFiles(): string[] {
  return fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(srcDir, f));
}

// Filesystem-write / persistence APIs. A vision adapter has no reason to touch
// any of these — its output is text + structure, returned to the caller.
const FORBIDDEN_WRITE = [
  "writeFileSync",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "createWriteStream",
  "fs.write",
  "toDataURL",
];

describe("vision PII policy (6.5, G7)", () => {
  const files = sourceFiles();

  it("has vision source to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of sourceFiles()) {
    const rel = path.basename(file);
    it(`${rel} never persists image bytes`, () => {
      const text = fs.readFileSync(file, "utf-8");
      const hits = FORBIDDEN_WRITE.filter((api) => text.includes(api));
      expect(hits, `${rel} uses a persistence API — screenshots must stay ephemeral`).toStrictEqual(
        [],
      );
    });
  }

  it("never imports the node fs module (no disk access at all)", () => {
    for (const file of files) {
      const text = fs.readFileSync(file, "utf-8");
      expect(
        /from\s+["']node:fs["']|require\(\s*["']fs["']\s*\)/.test(text),
        `${path.basename(file)} imports fs — the vision package must not access disk`,
      ).toBe(false);
    }
  });
});
