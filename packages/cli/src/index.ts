#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  type LineageGraph,
  matchComponentsByText,
  traceLineage,
} from "@coderadar/core";
import { resolveHookEdges, scanReact } from "@coderadar/parser-react";
import { Command } from "commander";

const program = new Command();

program
  .name("coderadar")
  .description(
    "Map UI components to their data sources — trace any screenshot back to the code and data behind it.",
  )
  .version("0.1.0");

program
  .command("scan")
  .description("Scan a React codebase and emit a lineage graph JSON")
  .argument("<dir>", "directory to scan")
  .option("-o, --out <file>", "output file", "coderadar.graph.json")
  .action((dir: string, opts: { out: string }) => {
    const graph = resolveHookEdges(scanReact({ root: dir }));
    fs.writeFileSync(opts.out, JSON.stringify(graph, null, 2));
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    }
    console.log(`Scanned ${path.resolve(dir)}`);
    for (const [kind, count] of counts) console.log(`  ${kind}: ${count}`);
    console.log(`  edges: ${graph.edges.length}`);
    console.log(`Graph written to ${opts.out}`);
  });

program
  .command("find")
  .description("Find components by text visible on screen (e.g. read off a screenshot)")
  .argument("<terms...>", "text fragments seen in the UI")
  .option("-g, --graph <file>", "graph file", "coderadar.graph.json")
  .action((terms: string[], opts: { graph: string }) => {
    const graph = loadGraph(opts.graph);
    const matches = matchComponentsByText(graph, terms);
    if (matches.length === 0) {
      console.log("No components matched.");
      return;
    }
    for (const match of matches.slice(0, 10)) {
      console.log(
        `${match.component.name}  (${match.component.loc.file}:${match.component.loc.line})  score=${match.score}`,
      );
      console.log(`  matched: ${match.matchedText.join(" | ")}`);
    }
  });

program
  .command("trace")
  .description("Trace a component to every data source, state, and event that feeds it")
  .argument("<component>", "component name or node id")
  .option("-g, --graph <file>", "graph file", "coderadar.graph.json")
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
    const lineage = traceLineage(graph, node.id);
    if (lineage === null) {
      console.error(`Not a component: ${node.id}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${lineage.component.name}  (${lineage.component.loc.file}:${lineage.component.loc.line})`);
    if (lineage.dataSources.length > 0) {
      console.log("  data sources:");
      for (const ds of lineage.dataSources) {
        console.log(`    [${ds.sourceKind}] ${ds.method ?? "?"} ${ds.endpoint}  (${ds.loc.file}:${ds.loc.line})`);
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
      console.log(`  via: ${lineage.via.map((v) => v.name).join(", ")}`);
    }
  });

function loadGraph(file: string): LineageGraph {
  if (!fs.existsSync(file)) {
    console.error(`Graph file not found: ${file} — run \`coderadar scan <dir>\` first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as LineageGraph;
}

program.parse();
