/**
 * ci-retrigger.ts — deterministic trusted-actor CI re-trigger pre-pass.
 *
 * Copilot-authored pushes land their workflow runs in `action_required` (the
 * gate is actor-based on this private repo), so the PR's check rollup stays
 * EMPTY. Nothing downstream can move: a draft can never go green so it is
 * never readied, the Tech Reviewer (correctly) refuses to approve a head with
 * no validation, and the PM has nothing to merge. Relying on per-PR agent
 * sessions to clear the gate caps the clear-rate at ~15 PRs per pass, which
 * can never catch a large queue (observed 2026-06-10: 121 open PRs, 113 with
 * zero checks).
 *
 * This module clears the gate MECHANICALLY, before the agent loop: for every
 * settled PR whose head has no check runs (or only `action_required` ones),
 * push an empty commit to the head branch via the GitHub API using the
 * PAT-backed `gh` credential. The push is authored by the trusted actor, so
 * the triggered run executes ungated. No checkout, no working-tree mutation.
 *
 * The selection logic is pure and unit-tested; only the `gh api` calls are
 * side-effecting.
 */

import { execFileSync } from "node:child_process";
import type { GitHubContext } from "./github-context.js";
import type { PrSnapshot } from "./pr-snapshot.js";
import { minutesSince, SETTLE_MINUTES } from "./pr-ordering.js";

/** Max re-triggers per pass — bounds the burst of CI runs each pass kicks off. */
export const DEFAULT_RETRIGGER_CAP = 25;

export interface RetriggerDecision {
  retrigger: boolean;
  reason: string;
}

/** True when the head has no real validation: zero checks reported, or only
 * `action_required` gate stubs. */
export function isCiGated(pr: PrSnapshot): boolean {
  if (pr.checks.length === 0) return true;
  return pr.checks.every((c) => c.conclusion === "ACTION_REQUIRED");
}

/**
 * Pure per-PR decision: should the pre-pass push a trusted empty commit to
 * wake this PR's CI?
 */
export function needsCiRetrigger(pr: PrSnapshot, nowMs: number): RetriggerDecision {
  if (!isCiGated(pr)) return { retrigger: false, reason: "checks already reported" };
  if (!pr.headRefName) return { retrigger: false, reason: "no head ref in snapshot" };
  if (pr.mergeable === "CONFLICTING") {
    return { retrigger: false, reason: "conflicting — CI is not the blocker" };
  }
  const sinceCommit = minutesSince(pr.lastCommitAt, nowMs);
  if (sinceCommit < SETTLE_MINUTES) {
    return {
      retrigger: false,
      reason: `head still warm (${sinceCommit.toFixed(0)}m < ${SETTLE_MINUTES}m settle window)`,
    };
  }
  // Ball in Copilot's court: a changes-requested review newer than the last
  // commit means the head MUST change — validating it now is wasted CI.
  if (
    pr.changesRequested &&
    pr.latestReview?.submittedAt &&
    pr.lastCommitAt &&
    new Date(pr.latestReview.submittedAt).getTime() > new Date(pr.lastCommitAt).getTime()
  ) {
    return { retrigger: false, reason: "changes-requested newer than head — waiting on Copilot" };
  }
  return { retrigger: true, reason: "gated and settled" };
}

/** Pure: pick the PRs to re-trigger this pass, oldest-first, capped. */
export function selectCiRetriggerTargets(
  snapshots: PrSnapshot[],
  nowMs: number,
  cap: number = DEFAULT_RETRIGGER_CAP
): PrSnapshot[] {
  return [...snapshots]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .filter((pr) => needsCiRetrigger(pr, nowMs).retrigger)
    .slice(0, Math.max(0, cap));
}

function ghJson(args: string[]): Record<string, unknown> {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * Push an empty commit (same tree, new commit object) to the PR's head branch
 * via the GitHub API. Runs as the PAT actor backing `gh`, so the resulting
 * workflow runs are NOT actor-gated. Throws on API failure — caller catches
 * per-PR so one bad branch never stops the sweep.
 */
export function retriggerCiViaEmptyCommit(ctx: GitHubContext, pr: PrSnapshot): void {
  const repo = `repos/${ctx.owner}/${ctx.repo}`;
  const ref = ghJson(["api", `${repo}/git/ref/heads/${pr.headRefName}`]);
  const headSha = (ref["object"] as { sha: string }).sha;
  const commit = ghJson(["api", `${repo}/git/commits/${headSha}`]);
  const treeSha = (commit["tree"] as { sha: string }).sha;
  const newCommit = ghJson([
    "api",
    `${repo}/git/commits`,
    "-f",
    "message=ci: re-trigger validation (trusted actor)",
    "-f",
    `tree=${treeSha}`,
    "-f",
    `parents[]=${headSha}`,
  ]);
  execFileSync(
    "gh",
    [
      "api",
      "-X",
      "PATCH",
      `${repo}/git/refs/heads/${pr.headRefName}`,
      "-f",
      `sha=${newCommit["sha"] as string}`,
    ],
    { encoding: "utf8" }
  );
}

export interface RetriggerSummary {
  candidates: number;
  attempted: number;
  succeeded: number[];
  failed: { number: number; error: string }[];
}

/** Run the full pre-pass over the snapshot set. Never throws. */
export function runCiRetriggerPrepass(
  ctx: GitHubContext,
  snapshots: PrSnapshot[],
  nowMs: number,
  cap: number = DEFAULT_RETRIGGER_CAP
): RetriggerSummary {
  const candidates = snapshots.filter((pr) => needsCiRetrigger(pr, nowMs).retrigger);
  const targets = selectCiRetriggerTargets(snapshots, nowMs, cap);
  const summary: RetriggerSummary = {
    candidates: candidates.length,
    attempted: targets.length,
    succeeded: [],
    failed: [],
  };
  for (const pr of targets) {
    try {
      retriggerCiViaEmptyCommit(ctx, pr);
      summary.succeeded.push(pr.number);
    } catch (err) {
      summary.failed.push({
        number: pr.number,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}
