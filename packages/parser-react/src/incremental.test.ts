import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { IncrementalScanner, resolveHookEdges, scanReact } from "./scan.js";

/**
 * Incremental re-scan correctness (6.1, D1/G2): an IncrementalScanner.update()
 * after an edit must produce a graph byte-identical to a fresh full scan of the
 * same tree. We build a small interconnected app (pages -> components -> atoms +
 * a hook, cross-file imports and fetches), then apply randomized single-file
 * edits and assert deep-equality against a full re-scan every time.
 */

/** Serialize a graph for byte-comparison, dropping only the volatile timestamp. */
function canonical(graph: { generatedAt?: string }): string {
  const { generatedAt: _drop, ...rest } = graph;
  return JSON.stringify(rest);
}

const WORDS = ["revenue", "invoice", "team", "report", "alert", "usage", "member", "audit"];

/** Deterministic PRNG so a failing seed is reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS = 5;
const COMPS = 10;

interface CompState {
  word: string;
  endpoint: number;
  atom: number;
}

function atomFile(i: number): string {
  return (
    `export function Atom${i}({ label }: { label: string }) {\n` +
    `  return <span className="atom-${i}">{label} tile ${i}</span>;\n` +
    `}\n`
  );
}

function compFile(i: number, s: CompState): string {
  return (
    `import { useEffect, useState } from "react";\n\n` +
    `import { Atom${s.atom} } from "./Atom${s.atom}";\n` +
    `import { useShared } from "./useShared";\n\n` +
    `export function Comp${i}() {\n` +
    `  const { ready } = useShared();\n` +
    `  const [rows, setRows] = useState<unknown[]>([]);\n` +
    `  useEffect(() => {\n` +
    `    fetch("/api/${s.word}/${s.endpoint}").then((r) => r.json()).then(setRows);\n` +
    `  }, []);\n` +
    `  return (\n` +
    `    <section>\n` +
    `      <h3>${s.word} overview ${i}</h3>\n` +
    `      <Atom${s.atom} label="${s.word}" />\n` +
    `      <p>{ready ? rows.length : 0} items</p>\n` +
    `    </section>\n` +
    `  );\n` +
    `}\n`
  );
}

function pageFile(): string {
  const imports: string[] = [];
  const renders: string[] = [];
  for (let i = 0; i < COMPS; i += 1) {
    imports.push(`import { Comp${i} } from "./Comp${i}";`);
    renders.push(`      <Comp${i} />`);
  }
  return (
    imports.join("\n") +
    `\n\nexport function Page() {\n  return (\n    <main>\n      <h1>App overview</h1>\n` +
    renders.join("\n") +
    `\n    </main>\n  );\n}\n`
  );
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coderadar-incremental-"));

function writeInitial(): CompState[] {
  const rand = rng(0xc0de);
  for (let i = 0; i < ATOMS; i += 1) fs.writeFileSync(path.join(dir, `Atom${i}.tsx`), atomFile(i));
  fs.writeFileSync(
    path.join(dir, "useShared.ts"),
    `import { useState } from "react";\n\nexport function useShared() {\n  const [ready, setReady] = useState(false);\n  return { ready, setReady };\n}\n`,
  );
  const states: CompState[] = [];
  for (let i = 0; i < COMPS; i += 1) {
    const s: CompState = {
      word: WORDS[Math.floor(rand() * WORDS.length)] ?? "widget",
      endpoint: Math.floor(rand() * 100),
      atom: Math.floor(rand() * ATOMS),
    };
    states.push(s);
    fs.writeFileSync(path.join(dir, `Comp${i}.tsx`), compFile(i, s));
  }
  fs.writeFileSync(path.join(dir, "Page.tsx"), pageFile());
  return states;
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const fullScan = () => resolveHookEdges(scanReact({ root: dir }));

describe("IncrementalScanner (6.1, D1/G2)", () => {
  const states = writeInitial();
  const scanner = new IncrementalScanner({ root: dir });

  it("initial incremental scan equals a full scan", () => {
    expect(canonical(resolveHookEdges(scanner.scan()))).toBe(canonical(fullScan()));
  });

  it("stays byte-identical to a full re-scan across 20 randomized single-file edits", () => {
    const rand = rng(0x1234);
    for (let step = 0; step < 20; step += 1) {
      const i = Math.floor(rand() * COMPS);
      const s = states[i]!;
      // Mutate one facet of a component: its rendered text, its endpoint, or the
      // atom it renders (which re-points a cross-file import + render edge).
      const facet = Math.floor(rand() * 3);
      if (facet === 0) s.word = WORDS[Math.floor(rand() * WORDS.length)] ?? "widget";
      else if (facet === 1) s.endpoint = Math.floor(rand() * 100);
      else s.atom = Math.floor(rand() * ATOMS);
      fs.writeFileSync(path.join(dir, `Comp${i}.tsx`), compFile(i, s));

      const inc = resolveHookEdges(scanner.update().graph);
      expect(canonical(inc), `mismatch after edit ${step} (Comp${i}, facet ${facet})`).toBe(
        canonical(fullScan()),
      );
    }
  }, 60_000);

  it("reports exactly the changed file and stays correct on add + delete", () => {
    // Edit one existing file.
    const s = states[0]!;
    s.endpoint = 999;
    fs.writeFileSync(path.join(dir, "Comp0.tsx"), compFile(0, s));
    const edit = scanner.update();
    expect(edit.changed).toStrictEqual(["Comp0.tsx"]);
    expect(canonical(resolveHookEdges(edit.graph))).toBe(canonical(fullScan()));

    // Add a new leaf component file.
    fs.writeFileSync(path.join(dir, "Extra.tsx"), atomFile(99).replace("Atom99", "Extra"));
    const added = scanner.update();
    expect(added.changed).toStrictEqual(["Extra.tsx"]);
    expect(canonical(resolveHookEdges(added.graph))).toBe(canonical(fullScan()));

    // Delete it again.
    fs.rmSync(path.join(dir, "Extra.tsx"));
    const removed = scanner.update();
    expect(removed.changed).toStrictEqual(["Extra.tsx"]);
    expect(canonical(resolveHookEdges(removed.graph))).toBe(canonical(fullScan()));
  });
});
