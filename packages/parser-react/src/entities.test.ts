import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchComponentsByText } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { decodeEntities } from "./entities.js";
import { scanReact } from "./scan.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures",
);

describe("decodeEntities", () => {
  it("decodes named entities React resolves", () => {
    expect(decodeEntities("&nbsp;")).toBe(" ");
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeEntities("&quot;q&quot;")).toBe('"q"');
    expect(decodeEntities("&middot;&rsaquo;")).toBe("·›");
    expect(decodeEntities("caf&eacute;")).toBe("café");
  });

  it("decodes decimal and hex numeric entities", () => {
    expect(decodeEntities("&#34;")).toBe('"');
    expect(decodeEntities("&#x22;")).toBe('"');
    expect(decodeEntities("&#X22;")).toBe('"');
    expect(decodeEntities("&#233;")).toBe("é");
  });

  it("leaves unknown names and out-of-range code points untouched", () => {
    expect(decodeEntities("&foobar;")).toBe("&foobar;");
    expect(decodeEntities("&#9999999999;")).toBe("&#9999999999;");
    // Double-encoded text stays literal — only one decoding pass, no `"`.
    expect(decodeEntities("&amp;#34;")).toBe("&#34;");
  });

  it("preserves surrounding text and mixed content", () => {
    expect(decodeEntities("Hello&nbsp;World")).toBe("Hello World");
    expect(decodeEntities("no entities here")).toBe("no entities here");
  });
});

describe("html-entity rendered text (a16 fixture)", () => {
  const graph = scanReact({ root: path.join(fixtures, "a16-html-entities", "app") });

  it("leaves an entity-only component with no discriminating match target", () => {
    const node = graph.nodes.find((n) => n.kind === "component" && n.name === "EntitySpacer");
    if (node?.kind !== "component") throw new Error("EntitySpacer not found");
    // Decoded entities are whitespace/punctuation only — nothing survives
    // normalization as a token, so `&nbsp;` never leaks a "nbsp" target.
    expect(node.renderedText.every((e) => !/[a-z0-9]/i.test(e.text))).toBe(true);
  });

  it("declines junk tokens the raw entities would have produced", () => {
    // Named-entity junk ("nbsp"), numeric-entity junk ("34"), and gibberish
    // that shares those digits all decline instead of matching EntitySpacer.
    for (const term of ["nbsp", "34", "zzqwxnomatch12345"]) {
      expect(matchComponentsByText(graph, [term]).status).toBe("declined");
    }
  });

  it("still matches a real component and isn't poisoned by digit-sharing gibberish", () => {
    const real = matchComponentsByText(graph, ["Storage quota exceeded"]);
    expect(real.status).toBe("ok");
    expect(real.candidates[0]?.value.component.name).toBe("QuotaNotice");

    const mixed = matchComponentsByText(graph, ["zzqwxnomatch12345", "Storage quota exceeded"]);
    expect(mixed.status).toBe("ok");
    expect(mixed.candidates[0]?.value.component.name).toBe("QuotaNotice");
  });
});
