/**
 * CodeRadar scale benchmark (TRACKER step 6.2, failure mode D3).
 *
 * Generates a large, deterministic synthetic React app with realistic import
 * depth (pages -> sections -> atoms, plus shared hooks and api modules), scans
 * it, and asserts a performance budget: full scan under a wall-clock limit and
 * under a peak-RSS limit. Run in nightly CI so a scaling regression fails loudly.
 *
 * Usage: node eval/dist/bench.js [--files N] [--budget-seconds S]
 *   [--budget-rss-mb M] [--keep] [--regenerate]
 *
 * The generated tree lives at eval/bench/app (gitignored, regenerable). It is
 * reused across runs unless --regenerate is passed or the file count differs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHookEdges, scanReact } from "@coderadar/parser-react";

const benchDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bench");
const appDir = path.join(benchDir, "app");

/** Small deterministic PRNG (mulberry32) so a given seed always yields the same app. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "revenue", "invoice", "billing", "user", "team", "project", "report", "dashboard",
  "settings", "notification", "profile", "account", "payment", "subscription", "usage",
  "metric", "alert", "audit", "session", "workspace", "member", "role", "permission",
  "export", "import", "schedule", "webhook", "integration", "token", "log",
];

interface BenchShape {
  /** Feature modules; each contributes a page + components + atoms + a hook. */
  features: number;
  componentsPerFeature: number;
  atomsPerFeature: number;
}

/** Total files a shape produces: per feature = page + components + atoms + hook. */
function fileCount(shape: BenchShape): number {
  return shape.features * (1 + shape.componentsPerFeature + shape.atomsPerFeature + 1);
}

/** Choose a shape whose file count is at least `minFiles` (>= 2000 for the D3 budget). */
function shapeForFiles(minFiles: number): BenchShape {
  const componentsPerFeature = 8;
  const atomsPerFeature = 8;
  const perFeature = 1 + componentsPerFeature + atomsPerFeature + 1; // 18
  const features = Math.max(1, Math.ceil(minFiles / perFeature));
  return { features, componentsPerFeature, atomsPerFeature };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Generate the synthetic app on disk. Deterministic for a given shape. */
function generateBenchApp(shape: BenchShape): number {
  fs.rmSync(appDir, { recursive: true, force: true });
  const rand = mulberry32(0x5eed);
  const word = () => WORDS[Math.floor(rand() * WORDS.length)] ?? "widget";

  let written = 0;
  const write = (rel: string, contents: string): void => {
    const full = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
    written += 1;
  };

  for (let f = 0; f < shape.features; f += 1) {
    const feat = `${word()}${f}`;
    const Feat = cap(feat);

    // A hook the components read.
    write(
      `features/${feat}/use${Feat}.ts`,
      `import { useState } from "react";\n\n` +
        `export function use${Feat}() {\n` +
        `  const [ready, setReady] = useState(false);\n` +
        `  return { ready, setReady };\n` +
        `}\n`,
    );

    // Atoms: leaf components with distinctive rendered text.
    for (let a = 0; a < shape.atomsPerFeature; a += 1) {
      const Atom = `${Feat}Atom${a}`;
      write(
        `features/${feat}/atoms/${Atom}.tsx`,
        `export function ${Atom}({ label }: { label: string }) {\n` +
          `  return <span className="${feat}-atom">{label} ${word()} ${a}</span>;\n` +
          `}\n`,
      );
    }

    // Components: import a couple of atoms, the hook, and the api; fetch on mount.
    for (let c = 0; c < shape.componentsPerFeature; c += 1) {
      const Comp = `${Feat}Section${c}`;
      const atomA = c % shape.atomsPerFeature;
      const atomB = (c + 1) % shape.atomsPerFeature;
      write(
        `features/${feat}/components/${Comp}.tsx`,
        `import { useEffect, useState } from "react";\n\n` +
          `import { ${Feat}Atom${atomA} } from "../atoms/${Feat}Atom${atomA}";\n` +
          `import { ${Feat}Atom${atomB} } from "../atoms/${Feat}Atom${atomB}";\n` +
          `import { use${Feat} } from "../use${Feat}";\n\n` +
          `export function ${Comp}() {\n` +
          `  const { ready } = use${Feat}();\n` +
          `  const [rows, setRows] = useState<unknown[]>([]);\n` +
          `  useEffect(() => {\n` +
          `    fetch("/api/${feat}/${c}")\n` +
          `      .then((r) => r.json())\n` +
          `      .then(setRows);\n` +
          `  }, []);\n` +
          `  return (\n` +
          `    <section>\n` +
          `      <h3>${Feat} ${word()} ${c}</h3>\n` +
          `      <${Feat}Atom${atomA} label="${word()}" />\n` +
          `      <${Feat}Atom${atomB} label="${word()}" />\n` +
          `      <p>{ready ? rows.length : 0} ${word()}</p>\n` +
          `    </section>\n` +
          `  );\n` +
          `}\n`,
      );
    }

    // Page: imports every section — the top of the import depth for the feature.
    const imports = [];
    const renders = [];
    for (let c = 0; c < shape.componentsPerFeature; c += 1) {
      const Comp = `${Feat}Section${c}`;
      imports.push(`import { ${Comp} } from "./components/${Comp}";`);
      renders.push(`      <${Comp} />`);
    }
    write(
      `features/${feat}/${Feat}Page.tsx`,
      imports.join("\n") +
        `\n\nexport function ${Feat}Page() {\n` +
        `  return (\n` +
        `    <main>\n` +
        `      <h1>${Feat} ${word()} overview</h1>\n` +
        renders.join("\n") +
        `\n    </main>\n` +
        `  );\n` +
        `}\n`,
    );
  }
  return written;
}

interface Args {
  minFiles: number;
  budgetSeconds: number;
  budgetRssMb: number;
  keep: boolean;
  regenerate: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1 || argv[i + 1] === undefined) return fallback;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    minFiles: get("--files", 2000),
    budgetSeconds: get("--budget-seconds", 300),
    budgetRssMb: get("--budget-rss-mb", 4096),
    keep: argv.includes("--keep"),
    regenerate: argv.includes("--regenerate"),
  };
}

/** Peak resident set size of this process, in MB. Node reports maxRSS in KB. */
function peakRssMb(): number {
  return process.resourceUsage().maxRSS / 1024;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) n += 1;
  }
  return n;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const shape = shapeForFiles(args.minFiles);
  const expected = fileCount(shape);

  const needsGen =
    args.regenerate ||
    !fs.existsSync(appDir) ||
    countFiles(appDir) !== expected;
  if (needsGen) {
    process.stdout.write(`Generating bench app (~${expected} files)... `);
    const written = generateBenchApp(shape);
    process.stdout.write(`${written} files.\n`);
  } else {
    console.log(`Reusing bench app at ${appDir} (${expected} files).`);
  }

  const files = countFiles(appDir);
  const start = performance.now();
  const graph = resolveHookEdges(scanReact({ root: appDir }));
  const seconds = (performance.now() - start) / 1000;
  const rssMb = peakRssMb();

  console.log(`\nScanned ${files} files in ${seconds.toFixed(1)}s, peak RSS ${rssMb.toFixed(0)} MB.`);
  console.log(`  nodes: ${graph.nodes.length}  edges: ${graph.edges.length}`);
  console.log(
    `  budget: <= ${args.budgetSeconds}s wall, <= ${args.budgetRssMb} MB RSS (files >= ${args.minFiles})`,
  );

  if (!args.keep && !args.regenerate) {
    // Leave the tree in place for reuse only when explicitly kept; default is to
    // remove it so a workspace/CI checkout is not left dirty (it is gitignored
    // regardless).
    fs.rmSync(benchDir, { recursive: true, force: true });
  }

  const violations: string[] = [];
  if (files < args.minFiles) violations.push(`only ${files} files (< ${args.minFiles})`);
  if (seconds > args.budgetSeconds) {
    violations.push(`scan ${seconds.toFixed(1)}s > ${args.budgetSeconds}s`);
  }
  if (rssMb > args.budgetRssMb) violations.push(`peak RSS ${rssMb.toFixed(0)}MB > ${args.budgetRssMb}MB`);

  if (violations.length > 0) {
    console.error(`\nPERF BUDGET FAILED:\n  ${violations.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nperf budget: OK");
  }
}

main();
