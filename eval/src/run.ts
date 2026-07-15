/**
 * CodeRadar eval runner.
 *
 * Scans every fixture under eval/fixtures/, diffs against golden.json, prints
 * a per-failure-mode scorecard, writes eval/scorecard.json, and exits non-zero
 * when eval/thresholds.json is violated.
 *
 * Usage: node eval/dist/run.js [--record]
 *   --record  append this run's summary to eval/history.jsonl (for trend tracking)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyTicket, type EntryPoint } from "@coderadar/agent-sdk";
import { CONFIDENCE_THRESHOLDS } from "@coderadar/core";
import { resolveHookEdges, scanReact } from "@coderadar/parser-react";
import { parse as parseYaml } from "yaml";

interface TicketCase {
  id: string;
  text: string;
  screenshots?: number;
  links?: string[];
  expect: EntryPoint;
}

/** Classify the hand-written ticket suite → entry-point accuracy + OOD rejection (step 5.1). */
function runTickets(): { entryPointAccuracy: number | null; oodRejection: number | null } {
  const ticketsPath = path.join(evalDir, "tickets", "tickets.json");
  if (!fs.existsSync(ticketsPath)) return { entryPointAccuracy: null, oodRejection: null };
  const tickets = JSON.parse(fs.readFileSync(ticketsPath, "utf-8")) as TicketCase[];
  let correct = 0;
  let ood = 0;
  let oodRejected = 0;
  const misses: string[] = [];
  for (const ticket of tickets) {
    const got = classifyTicket(ticket).entryPoint;
    if (got === ticket.expect) correct += 1;
    else misses.push(`${ticket.id}: expected ${ticket.expect}, got ${got}`);
    if (ticket.expect === "out-of-domain") {
      ood += 1;
      if (got === "out-of-domain") oodRejected += 1;
    }
  }
  if (misses.length > 0) console.log(`\n[tickets] misclassified: ${misses.join(" · ")}`);
  return {
    entryPointAccuracy: tickets.length > 0 ? round(correct / tickets.length) : null,
    oodRejection: ood > 0 ? round(oodRejected / ood) : null,
  };
}

import { runChecks } from "./checks.js";
import type { FixtureResult, Golden, Scorecard, Thresholds } from "./golden.js";

/** A fixture's business-vocabulary glossary (aliases.yaml), phrase → component. */
function loadAliases(fixtureDir: string): Record<string, string> | undefined {
  const aliasPath = path.join(fixtureDir, "aliases.yaml");
  if (!fs.existsSync(aliasPath)) return undefined;
  return parseYaml(fs.readFileSync(aliasPath, "utf-8")) as Record<string, string>;
}

const evalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(evalDir, "fixtures");

function main(): void {
  const record = process.argv.includes("--record");
  const fixtureNames = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const results: FixtureResult[] = [];
  for (const name of fixtureNames) {
    const fixtureDir = path.join(fixturesDir, name);
    const goldenPath = path.join(fixtureDir, "golden.json");
    if (!fs.existsSync(goldenPath)) {
      console.warn(`skipping ${name}: no golden.json`);
      continue;
    }
    const golden = JSON.parse(fs.readFileSync(goldenPath, "utf-8")) as Golden;
    const appDir = path.resolve(fixtureDir, golden.app ?? "./app");
    const graph = resolveHookEdges(scanReact({ root: appDir, ...(golden.scan ?? {}) }));
    results.push(runChecks(name, golden, graph, loadAliases(fixtureDir)));
  }

  const scorecard = buildScorecard(results);
  fs.writeFileSync(path.join(evalDir, "scorecard.json"), JSON.stringify(scorecard, null, 2));
  if (record) {
    fs.appendFileSync(
      path.join(evalDir, "history.jsonl"),
      JSON.stringify({ generatedAt: scorecard.generatedAt, commitSha: scorecard.commitSha, ...scorecard.summary }) + "\n",
    );
  }

  if (process.argv.includes("--calibrate")) calibrate(results);

  print(scorecard);
  gate(scorecard);
}

/**
 * Measure the score → confidence calibration on the eval set and record it in
 * eval/calibration.json: the precision at the matcher's `high` cutoff, plus the
 * lowest score threshold at which precision still holds ≥ 0.95 (step 4.5).
 */
function calibrate(results: FixtureResult[]): void {
  const ok = results
    .flatMap((r) => r.queries)
    .filter((o) => o.gotStatus === "ok" && o.score !== undefined);
  const precisionAbove = (t: number): number => {
    const bucket = ok.filter((o) => (o.score ?? 0) >= t);
    return bucket.length > 0 ? bucket.filter((o) => o.correct).length / bucket.length : 1;
  };
  const scores = [...new Set(ok.map((o) => o.score ?? 0))].sort((a, b) => b - a);
  let empiricalHighFloor = 1;
  for (const t of scores) {
    if (precisionAbove(t) >= 0.95) empiricalHighFloor = t;
    else break;
  }
  const calibration = {
    generatedAt: new Date().toISOString(),
    thresholds: CONFIDENCE_THRESHOLDS,
    measuredPrecisionAtHigh: round(precisionAbove(CONFIDENCE_THRESHOLDS.high)),
    empiricalHighFloor: round(empiricalHighFloor),
    sampleSize: ok.length,
    note: "The matcher's confidenceFromScore uses these thresholds. measuredPrecisionAtHigh is the fraction of high-confidence eval answers that are correct; empiricalHighFloor is the lowest score at which precision still holds >= 0.95.",
  };
  fs.writeFileSync(
    path.join(evalDir, "calibration.json"),
    `${JSON.stringify(calibration, null, 2)}\n`,
  );
  console.log(
    `\nWrote calibration.json — high=${CONFIDENCE_THRESHOLDS.high}, precision@high=${round(
      precisionAbove(CONFIDENCE_THRESHOLDS.high),
    )}, floor=${round(empiricalHighFloor)} (n=${ok.length})`,
  );
}

function buildScorecard(results: FixtureResult[]): Scorecard {
  let pass = 0;
  let fail = 0;
  let xfail = 0;
  let unexpectedPass = 0;
  let queryPass = 0;
  let queryTotal = 0;
  const attr = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };

  for (const result of results) {
    for (const check of result.checks) {
      if (check.status === "pass") pass += 1;
      else if (check.status === "fail") fail += 1;
      else if (check.status === "xfail") xfail += 1;
      else unexpectedPass += 1;
      if (check.kind === "queries" && check.status !== "xfail") {
        queryTotal += 1;
        if (check.status === "pass") queryPass += 1;
      }
    }
    attr.truePositives += result.attribution.truePositives;
    attr.falsePositives += result.attribution.falsePositives;
    attr.falseNegatives += result.attribution.falseNegatives;
  }

  const attributed = attr.truePositives + attr.falsePositives;
  const golden = attr.truePositives + attr.falseNegatives;

  // Confidence & honesty metrics (step 4.5) over every non-xfail query outcome.
  const outcomes = results.flatMap((r) => r.queries);
  const okAnswers = outcomes.filter((o) => o.gotStatus === "ok");
  const highOk = okAnswers.filter((o) => o.confidence === "high");
  const ambiguous = outcomes.filter((o) => o.expectedStatus === "ambiguous");

  return {
    generatedAt: new Date().toISOString(),
    commitSha: gitSha(),
    fixtures: results,
    summary: {
      pass,
      fail,
      xfail,
      unexpectedPass,
      lineagePrecision: attributed > 0 ? round(attr.truePositives / attributed) : null,
      lineageRecall: golden > 0 ? round(attr.truePositives / golden) : null,
      matchAccuracy: queryTotal > 0 ? round(queryPass / queryTotal) : null,
      highConfidenceCorrect:
        highOk.length > 0 ? round(highOk.filter((o) => o.correct).length / highOk.length) : null,
      ambiguityHonesty:
        ambiguous.length > 0
          ? round(ambiguous.filter((o) => o.gotStatus === "ambiguous").length / ambiguous.length)
          : null,
      poisonRate:
        okAnswers.length > 0
          ? round(okAnswers.filter((o) => !o.correct).length / okAnswers.length)
          : null,
      ...runTickets(),
    },
  };
}

function print(scorecard: Scorecard): void {
  const icons = { pass: "✓", fail: "✗", xfail: "…", "unexpected-pass": "!" } as const;
  for (const fixture of scorecard.fixtures) {
    console.log(`\n[${fixture.failureMode}] ${fixture.fixture}`);
    for (const check of fixture.checks) {
      const suffix = check.detail !== undefined ? `  — ${check.detail}` : "";
      console.log(`  ${icons[check.status]} ${check.id}${suffix}`);
    }
  }
  const s = scorecard.summary;
  console.log(
    `\n${s.pass} pass · ${s.fail} fail · ${s.xfail} xfail · ${s.unexpectedPass} unexpected-pass`,
  );
  console.log(
    `lineage precision=${fmt(s.lineagePrecision)} recall=${fmt(s.lineageRecall)} · match accuracy=${fmt(s.matchAccuracy)}`,
  );
  console.log(
    `high-conf correct=${fmt(s.highConfidenceCorrect)} · ambiguity honesty=${fmt(s.ambiguityHonesty)} · poison rate=${fmt(s.poisonRate)}`,
  );
  console.log(
    `ticket entry-point accuracy=${fmt(s.entryPointAccuracy)} · OOD rejection=${fmt(s.oodRejection)}`,
  );
}

function gate(scorecard: Scorecard): void {
  const thresholds = JSON.parse(
    fs.readFileSync(path.join(evalDir, "thresholds.json"), "utf-8"),
  ) as Thresholds;
  const s = scorecard.summary;
  const violations: string[] = [];
  if (s.fail > thresholds.maxFail) violations.push(`fail ${s.fail} > max ${thresholds.maxFail}`);
  if (s.unexpectedPass > thresholds.maxUnexpectedPass) {
    violations.push(`unexpected-pass ${s.unexpectedPass} > max ${thresholds.maxUnexpectedPass}`);
  }
  checkFloor(violations, "lineagePrecision", s.lineagePrecision, thresholds.minLineagePrecision);
  checkFloor(violations, "lineageRecall", s.lineageRecall, thresholds.minLineageRecall);
  checkFloor(violations, "matchAccuracy", s.matchAccuracy, thresholds.minMatchAccuracy);
  checkFloor(
    violations,
    "highConfidenceCorrect",
    s.highConfidenceCorrect,
    thresholds.minHighConfidenceCorrect,
  );
  checkFloor(violations, "ambiguityHonesty", s.ambiguityHonesty, thresholds.minAmbiguityHonesty);
  checkFloor(violations, "entryPointAccuracy", s.entryPointAccuracy, thresholds.minEntryPointAccuracy);
  checkFloor(violations, "oodRejection", s.oodRejection, thresholds.minOodRejection);
  if (
    thresholds.maxPoisonRate !== undefined &&
    s.poisonRate !== null &&
    s.poisonRate > thresholds.maxPoisonRate
  ) {
    violations.push(`poisonRate ${s.poisonRate} > max ${thresholds.maxPoisonRate}`);
  }

  if (violations.length > 0) {
    console.error(`\nEVAL GATE FAILED:\n  ${violations.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("\neval gate: OK");
  }
}

function checkFloor(
  violations: string[],
  name: string,
  value: number | null,
  floor: number | undefined,
): void {
  if (floor !== undefined && value !== null && value < floor) {
    violations.push(`${name} ${value} < min ${floor}`);
  }
}

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: evalDir, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
const fmt = (n: number | null): string => (n === null ? "n/a" : n.toFixed(3));

main();
