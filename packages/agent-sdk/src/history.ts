/**
 * Git-history context (TRACKER step 5.6, failure mode F5).
 *
 * The last commits that touched the matched files, so an agent knows what
 * recently changed around a ticket. Pure `git` subprocess, no network; any
 * failure (not a repo, git missing, untracked files) yields an empty list
 * rather than throwing — the bundle degrades gracefully.
 */

import { execFileSync } from "node:child_process";

export interface CommitInfo {
  /** Abbreviated commit hash. */
  sha: string;
  subject: string;
  /** PR number parsed from a merge/squash subject, when present. */
  pr?: number;
}

const UNIT = "\x1f"; // field separator unlikely to appear in a subject

/** Extract a PR number from a merge ("… pull request #12 …") or squash ("… (#12)") subject. */
export function parsePrNumber(subject: string): number | undefined {
  const match = /#(\d+)/.exec(subject);
  return match !== null ? Number(match[1]) : undefined;
}

/** The most recent `limit` commits touching any of `files` (relative to `root`). */
export function gitHistory(root: string, files: string[], limit: number): CommitInfo[] {
  if (files.length === 0 || limit <= 0) return [];
  const seen = new Map<string, { subject: string; time: number }>();
  for (const file of files) {
    let out: string;
    try {
      out = execFileSync(
        "git",
        ["-C", root, "log", "--follow", "-n", String(limit), `--format=%h${UNIT}%ct${UNIT}%s`, "--", file],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      continue; // not a repo, untracked path, or git unavailable
    }
    for (const line of out.split("\n")) {
      if (line.trim() === "") continue;
      const [sha, ct, subject] = line.split(UNIT);
      if (sha === undefined || ct === undefined || subject === undefined) continue;
      if (!seen.has(sha)) seen.set(sha, { subject, time: Number(ct) });
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].time - a[1].time)
    .slice(0, limit)
    .map(([sha, { subject }]) => {
      const pr = parsePrNumber(subject);
      return pr !== undefined ? { sha, subject, pr } : { sha, subject };
    });
}
