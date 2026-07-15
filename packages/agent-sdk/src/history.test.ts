import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { gitHistory, parsePrNumber } from "./history.js";

// This repo's own root — packages/agent-sdk/src → ../../..
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("gitHistory (TRACKER 5.6)", () => {
  it("returns recent commits touching a tracked file", () => {
    const commits = gitHistory(repoRoot, ["TRACKER.md"], 5);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.length).toBeLessThanOrEqual(5);
    for (const commit of commits) {
      expect(commit.sha).toMatch(/^[0-9a-f]{7,}$/);
      expect(typeof commit.subject).toBe("string");
    }
  });

  it("parses PR numbers out of merge and squash subjects", () => {
    expect(parsePrNumber("Merge pull request #38 from officialCodeWork/x")).toBe(38);
    expect(parsePrNumber("feat(response): typed responses (#12)")).toBe(12);
    expect(parsePrNumber("plain commit with no pr")).toBeUndefined();
  });

  it("attaches a PR number when a commit subject carries one", () => {
    // Merge commits carry "#NN"; whether they surface for a given file depends on
    // the merge strategy, so assert the shape holds for any that do.
    const commits = gitHistory(repoRoot, ["TRACKER.md"], 20);
    for (const commit of commits) {
      if (/#\d+/.test(commit.subject)) expect(typeof commit.pr).toBe("number");
      else expect(commit.pr).toBeUndefined();
    }
  });

  it("degrades to an empty list outside a git repo", () => {
    expect(gitHistory("/nonexistent-path-xyz", ["whatever.ts"], 5)).toEqual([]);
  });

  it("returns empty for no files or a non-positive limit", () => {
    expect(gitHistory(repoRoot, [], 5)).toEqual([]);
    expect(gitHistory(repoRoot, ["TRACKER.md"], 0)).toEqual([]);
  });
});
