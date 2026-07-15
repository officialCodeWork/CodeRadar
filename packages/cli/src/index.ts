#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  blastRadius,
  type Candidate,
  collectGraphMeta,
  type ComponentMatch,
  type ImpactNode,
  type JourneyPath,
  journeys,
  type LineageGraph,
  loadCorrections,
  loadGraph as loadGraphFile,
  matchComponents,
  recordCorrection,
  saveGraph,
  traceLineage,
} from "@coderadar/core";
import { buildBundle, resolveContext } from "@coderadar/agent-sdk";
import { resolveHookEdges, scanReact } from "@coderadar/parser-react";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";

const program = new Command();

program
  .name("ui-lineage")
  .description(
    "Map UI components to their data sources and user journeys — trace any screenshot back to the code, APIs, state, and navigation behind it.",
  )
  .version("0.3.0");

program
  .command("scan")
  .description("Scan a React codebase and emit a lineage graph JSON")
  .argument("<dir>", "directory to scan")
  .option("-o, --out <file>", "output file", "ui-lineage.graph.json")
  .option("--openapi <file>", "OpenAPI 3 JSON spec (relative to <dir>) for response-schema linking")
  .action((dir: string, opts: { out: string; openapi?: string }) => {
    const meta = collectGraphMeta(path.resolve(dir));
    const graph = {
      ...resolveHookEdges(scanReact({ root: dir, ...(opts.openapi ? { openapi: opts.openapi } : {}) })),
      meta,
    };
    saveGraph(graph, opts.out);
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    }
    console.log(`Scanned ${path.resolve(dir)}`);
    console.log(
      `  commit: ${meta.commitSha ?? "not a git repo"}${meta.dirty ? " (dirty working tree)" : ""}`,
    );
    for (const [kind, count] of [...counts].sort()) console.log(`  ${kind}: ${count}`);
    console.log(`  edges: ${graph.edges.length}`);
    const incomplete = graph.nodes.filter((n) => n.flags?.includes("incomplete")).length;
    if (incomplete > 0) {
      console.log(`  incomplete: ${incomplete} node(s) could not be fully parsed`);
    }
    console.log(`Graph written to ${opts.out}`);
  });

program
  .command("find")
  .description("Find components by text visible on screen (e.g. read off a screenshot)")
  .argument("<terms...>", "text fragments seen in the UI")
  .option("-g, --graph <file>", "graph file", "ui-lineage.graph.json")
  .option("-a, --aliases <file>", "business-vocab glossary (aliases.yaml)")
  .option("-c, --corrections <file>", "corrections store (jsonl)", "ui-lineage.corrections.jsonl")
  .action((terms: string[], opts: { graph: string; aliases?: string; corrections: string }) => {
    const graph = loadGraph(opts.graph);
    const aliases =
      opts.aliases !== undefined && fs.existsSync(opts.aliases)
        ? (parseYaml(fs.readFileSync(opts.aliases, "utf-8")) as Record<string, string>)
        : undefined;
    const corrections = fs.existsSync(opts.corrections)
      ? loadCorrections(opts.corrections)
      : undefined;
    const result = matchComponents(graph, {
      terms,
      ...(aliases !== undefined ? { aliases } : {}),
      ...(corrections !== undefined ? { corrections } : {}),
    });
    if (result.status === "declined") {
      console.log(`No components matched (${result.declineReason}).`);
      return;
    }
    if (result.status === "ambiguous") {
      console.log(`Ambiguous — ${result.disambiguation}\n`);
    }
    for (const candidate of result.candidates.slice(0, 10)) {
      printMatchCandidate(candidate);
    }
  });

program
  .command("trace")
  .description("Trace a component to every data source, state, and event that feeds it")
  .argument("<component>", "component name, definition id, or instance id")
  .option("-g, --graph <file>", "graph file", "ui-lineage.graph.json")
  .action((component: string, opts: { graph: string }) => {
    const graph = loadGraph(opts.graph);
    const node =
      graph.nodes.find((n) => n.id === component) ??
      graph.nodes.find((n) => n.kind === "component" && n.name === component);
    if (node === undefined) {
      console.error(`Component not found: ${component}`);
      process.exitCode = 1;
      return;
    }
    const result = traceLineage(graph, node.id);
    if (result.status === "declined" || result.candidates[0] === undefined) {
      console.error(`Cannot trace ${node.id} (${result.declineReason ?? "no result"})`);
      process.exitCode = 1;
      return;
    }
    const lineage = result.candidates[0].value;
    const where = lineage.instance ?? lineage.component;
    console.log(`${lineage.component.name}  (${where.loc.file}:${where.loc.line})`);
    if (lineage.dataSources.length > 0) {
      console.log("  data sources:");
      for (const ds of lineage.dataSources) {
        console.log(`    [${ds.sourceKind}] ${ds.method ?? "?"} ${ds.endpoint}  (${ds.loc.file}:${ds.loc.line})`);
        if (ds.responseType !== undefined) {
          const fields = ds.responseType.fields.map((f) => `${f.name}: ${f.type}`).join(", ");
          console.log(`      → ${ds.responseType.name} { ${fields} }  (${ds.responseType.source})`);
        }
      }
    }
    if (lineage.state.length > 0) {
      console.log("  state:");
      for (const st of lineage.state) {
        console.log(`    [${st.stateKind}] ${st.name}  (${st.loc.file}:${st.loc.line})`);
      }
    }
    if (lineage.events.length > 0) {
      console.log("  events:");
      for (const ev of lineage.events) {
        console.log(`    ${ev.event}${ev.handler !== null ? ` → ${ev.handler}` : ""}  (${ev.loc.file}:${ev.loc.line})`);
      }
    }
    if (lineage.via.length > 0) {
      const labels = lineage.via.map((v) =>
        v.kind === "instance" ? `${v.name}@${v.loc.file}:${v.loc.line}` : v.name,
      );
      console.log(`  via: ${labels.join(", ")}`);
    }
    if (lineage.perInstance !== undefined && lineage.perInstance.length > 0) {
      console.log("  per instance:");
      for (const inst of lineage.perInstance) {
        console.log(
          `    ${inst.instance.name}@${inst.instance.loc.file}:${inst.instance.loc.line}`,
        );
        if (inst.dataSources.length === 0) {
          console.log("      (no distinct data sources)");
          continue;
        }
        for (const ds of inst.dataSources) {
          console.log(`      → ${ds.method ?? "?"} ${ds.endpoint}  (${ds.loc.file}:${ds.loc.line})`);
        }
      }
    }
    console.log(`  confidence: ${result.candidates[0].confidence.level}`);
  });

program
  .command("journeys")
  .description("Trace user-journey paths from a page or component (click → navigate → click…)")
  .argument("<start>", "route path (/users/:id), component name, or instance id")
  .option("-g, --graph <file>", "graph file", "ui-lineage.graph.json")
  .option("-d, --depth <n>", "max navigation levels per path", "3")
  .action((start: string, opts: { graph: string; depth: string }) => {
    const graph = loadGraph(opts.graph);
    const depth = Number.parseInt(opts.depth, 10);
    const result = journeys(graph, start, { depth: Number.isNaN(depth) ? 3 : depth });
    if (result.status === "declined" || result.candidates[0] === undefined) {
      console.error(`No journeys from ${start} (${result.declineReason ?? "no result"}).`);
      process.exitCode = 1;
      return;
    }
    const paths = result.candidates[0].value;
    if (paths.length === 0) {
      console.log(`No user actions found on ${start}.`);
      return;
    }
    console.log(`${paths.length} journey path(s) from ${start}:\n`);
    for (const path of paths) printJourneyPath(path);
  });

program
  .command("resolve")
  .description("Resolve a ticket: classify its entry point, then match it to component(s)")
  .argument("<text>", "the ticket text")
  .option("-g, --graph <file>", "graph file", "ui-lineage.graph.json")
  .option("-s, --screenshot", "the ticket has a screenshot attached")
  .action((text: string, opts: { graph: string; screenshot?: boolean }) => {
    const graph = loadGraph(opts.graph);
    const result = resolveContext(graph, {
      text,
      ...(opts.screenshot ? { screenshots: 1 } : {}),
    });
    console.log(`entry point: ${result.entryPoint} — ${result.classification.reason}`);
    if (result.decline !== undefined) {
      console.log(`declined (${result.decline.reason}): ${result.decline.message}`);
      return;
    }
    const match = result.match;
    if (match === undefined || match.status === "declined") {
      console.log(`no component matched (${match?.declineReason ?? "no result"}).`);
      return;
    }
    if (match.status === "ambiguous") console.log(`ambiguous — ${match.disambiguation}\n`);
    for (const candidate of match.candidates.slice(0, 5)) printMatchCandidate(candidate);
  });

program
  .command("bundle")
  .description("Resolve a ticket into a budgeted context bundle (JSON) for an agent")
  .argument("<text>", "the ticket text")
  .option("-g, --graph <file>", "graph file", "ui-lineage.graph.json")
  .option("-s, --screenshot", "the ticket has a screenshot attached")
  .option("-b, --budget <n>", "token budget", "4000")
  .action((text: string, opts: { graph: string; screenshot?: boolean; budget: string }) => {
    const graph = loadGraph(opts.graph);
    const budgetTokens = Number.parseInt(opts.budget, 10);
    const bundle = buildBundle(
      graph,
      { text, ...(opts.screenshot ? { screenshots: 1 } : {}) },
      { budgetTokens: Number.isNaN(budgetTokens) ? 4000 : budgetTokens },
    );
    console.log(JSON.stringify(bundle, null, 2));
  });

program
  .command("impact")
  .description("Blast radius: everything that depends on a node (reverse traversal)")
  .argument("<node>", "node id, component name, API endpoint, state name, or route path")
  .option("-g, --graph <file>", "graph file", "ui-lineage.graph.json")
  .option("-d, --depth <n>", "max dependency hops", "0")
  .action((node: string, opts: { graph: string; depth: string }) => {
    const graph = loadGraph(opts.graph);
    const depth = Number.parseInt(opts.depth, 10);
    const result = blastRadius(
      graph,
      node,
      depth > 0 ? { depth } : {},
    );
    if (result.status === "declined" || result.candidates[0] === undefined) {
      console.error(`Node not found: ${node} (${result.declineReason ?? "no result"}).`);
      process.exitCode = 1;
      return;
    }
    const impacts = result.candidates[0].value;
    if (impacts.length === 0) {
      console.log(`Nothing depends on ${node}.`);
      return;
    }
    console.log(`${impacts.length} node(s) affected by changing ${node}:\n`);
    for (const impact of impacts) printImpact(impact);
  });

program
  .command("correct")
  .description("Record that some on-screen text means a component — feeds future `find` results")
  .argument("<component>", "component name it should resolve to")
  .argument("<terms...>", "the text fragments that mean it")
  .option("-c, --corrections <file>", "corrections store (jsonl)", "ui-lineage.corrections.jsonl")
  .action((component: string, terms: string[], opts: { corrections: string }) => {
    recordCorrection(opts.corrections, { terms, component });
    console.log(`Recorded: [${terms.join(", ")}] → ${component}  (${opts.corrections})`);
  });

const STEP_ARROW: Record<string, string> = {
  page: "▸",
  event: "•",
  navigate: "→",
  fetch: "⇢",
  "state-write": "✎",
  exit: "⏏",
};

function printJourneyPath(path: JourneyPath): void {
  const parts = path.steps.map((step) => {
    const glyph = STEP_ARROW[step.kind] ?? "·";
    const cond = step.condition !== undefined ? ` [${step.condition.expression}]` : "";
    const label =
      step.kind === "event" ? `${step.label}()` : step.kind === "fetch" ? `fetch ${step.label}` : step.label;
    return `${glyph} ${label}${cond}`;
  });
  const tag = path.end === "cycle" ? "  ↩ cycle" : path.end === "depth-limit" ? "  … (depth limit)" : "";
  console.log(`  ${parts.join("  ")}${tag}`);
}

function printImpact(impact: ImpactNode): void {
  const node = impact.node;
  const name =
    node.kind === "data-source"
      ? node.endpoint
      : node.kind === "route"
        ? node.path
        : node.kind === "event"
          ? (node.handler ?? node.event)
          : node.name;
  const indent = "  ".repeat(impact.distance);
  console.log(
    `${indent}[${impact.relation}] ${node.kind} ${name}  (${node.loc.file}:${node.loc.line})`,
  );
}

function printMatchCandidate(candidate: Candidate<ComponentMatch>): void {
  const match = candidate.value;
  console.log(
    `${match.component.name}  (${match.component.loc.file}:${match.component.loc.line})  ` +
      `score=${candidate.score?.toFixed(2) ?? "—"}  ` +
      `confidence=${candidate.confidence.level} (${candidate.confidence.score.toFixed(2)})`,
  );
  console.log(`  matched: ${match.matchedText.join(" | ")}`);
  for (const instance of match.instances) {
    console.log(`  instance: ${instance.loc.file}:${instance.loc.line}`);
  }
}

function loadGraph(file: string): LineageGraph {
  if (!fs.existsSync(file)) {
    console.error(`Graph file not found: ${file} — run \`ui-lineage scan <dir>\` first.`);
    process.exit(1);
  }
  try {
    return loadGraphFile(file);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

program.parse();
