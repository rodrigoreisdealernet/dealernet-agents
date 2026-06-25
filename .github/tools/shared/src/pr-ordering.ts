/**
 * pr-ordering.ts — loop ordering + cheap "is there anything to do?" filter.
 *
 * This is deliberately NOT a decision engine. The per-PR agent makes every
 * substantive call (review verdict, merge, conflict strategy, nudge). These
 * helpers only:
 *   1. order the loop OLDEST-FIRST, so the most at-risk PRs are handled before
 *      any broad timeout can truncate the tail; and
 *   2. skip PRs that demonstrably have nothing actionable right now, so we
 *      don't spend an agent session to conclude "still being worked on".
 *
 * The skip filter is intentionally conservative: when in doubt it returns
 * true (actionable) and lets the agent decide. It must never cause a PR to be
 * silently dropped — anything it skips is logged with a reason by the caller.
 */

import type { PrSnapshot } from "./pr-snapshot.js";

/** Minutes since an ISO timestamp, relative to `nowMs`. Infinity when null. */
export function minutesSince(iso: string | null, nowMs: number): number {
  if (!iso) return Infinity;
  return (nowMs - new Date(iso).getTime()) / 60000;
}

/** Stable oldest-first ordering by creation time (ties broken by PR number). */
export function orderPrs(snapshots: PrSnapshot[]): PrSnapshot[] {
  return [...snapshots].sort((a, b) => {
    const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return t !== 0 ? t : a.number - b.number;
  });
}

export interface ActionableDecision {
  actionable: boolean;
  /** Human-readable reason a PR was skipped (only set when !actionable). */
  reason?: string;
}

/** Settle window: a draft that committed within this many minutes is "still warm". */
export const SETTLE_MINUTES = 10;

/**
 * Cheap pre-filter. Returns actionable=false ONLY for the one safe case: a
 * fresh draft that is still actively being worked (committed within the settle
 * window). Everything else is actionable — including settled drafts (which may
 * need readying), conflicts, failing CI, and PRs awaiting review/merge.
 */
export function isActionable(snapshot: PrSnapshot, nowMs: number): ActionableDecision {
  if (snapshot.isDraft) {
    const sinceCommit = minutesSince(snapshot.lastCommitAt, nowMs);
    if (sinceCommit < SETTLE_MINUTES) {
      return {
        actionable: false,
        reason: `draft still warm (last commit ${sinceCommit.toFixed(0)}m ago, < ${SETTLE_MINUTES}m settle window)`,
      };
    }
  }
  return { actionable: true };
}

/** Specialist lanes that block a merge while open. */
export const BLOCKING_LANES = [
  "needs-platform-review",
  "needs-security-review",
  "needs-database-review",
] as const;

/**
 * Label the Tech Reviewer applies as its terminal APPROVE verdict when GitHub
 * refuses the formal review — a PR authored by the same identity that backs
 * the reviewer's PAT cannot be formally approved (GitHub forbids
 * self-approval). Without this path such PRs deadlock forever: repeated
 * "approve-ready" verdict comments and zero `APPROVED` reviews (observed on
 * #1192, 2026-06-12 — five comments, 23 h stuck).
 */
export const TECH_APPROVED_LABEL = "tech-approved";

/** Formal APPROVED review, or the Tech Reviewer's label-verdict fallback for
 * PAT-authored PRs where GitHub blocks self-approval. */
export function hasApprovalVerdict(snapshot: PrSnapshot): boolean {
  return snapshot.approved || snapshot.labels.includes(TECH_APPROVED_LABEL);
}

/**
 * True when the only thing left for this PR is the merge itself: non-draft,
 * APPROVED, green CI, MERGEABLE, and no open specialist lane. These are the
 * highest-value sessions in the loop — a merge is the queue's only exit — so
 * they must run FIRST, before any budget truncation can defer them behind
 * PRs that still need mechanics or review.
 */
export function isMergeReady(snapshot: PrSnapshot): boolean {
  return (
    !snapshot.isDraft &&
    hasApprovalVerdict(snapshot) &&
    snapshot.mergeable === "MERGEABLE" &&
    snapshot.ciState === "SUCCESS" &&
    !snapshot.labels.some((l) => (BLOCKING_LANES as readonly string[]).includes(l))
  );
}

/**
 * True when the ONLY thing between this PR and a merge is a stale verdict: a
 * changes-requested review that newer commits superseded, while the current
 * head is green, mergeable, and every specialist lane is cleared. The PM's
 * stale-review completion rule (project-manager.agent.md branch 7a) verifies
 * the reviewer's named blockers are objectively resolved and merges — these
 * are one short session from exit, so they ride directly behind merge-ready.
 */
export function isStaleReviewCompletionCandidate(snapshot: PrSnapshot): boolean {
  return (
    !snapshot.isDraft &&
    snapshot.reviewSuperseded &&
    !snapshot.approved &&
    snapshot.mergeable === "MERGEABLE" &&
    snapshot.ciState === "SUCCESS" &&
    !snapshot.labels.some((l) => (BLOCKING_LANES as readonly string[]).includes(l))
  );
}

export interface OrderedPlan {
  /** PRs to hand to the agent: merge-ready first, then stale-review completion candidates, then the rest, oldest-first within each group. */
  actionable: PrSnapshot[];
  /** PRs skipped this pass, oldest-first, each with a reason. */
  skipped: { snapshot: PrSnapshot; reason: string }[];
}

/**
 * Split into actionable vs skipped (with reasons) and order the actionable
 * set MERGE-READY FIRST (each group oldest-first). Merges are the only way a
 * PR ever leaves the queue; with a large queue and a bounded budget, putting
 * them behind everything else means they can be deferred pass after pass —
 * the queue grows even while every session "did something".
 *
 * Anti-starvation contract (owner requirement: oldest work must never
 * starve): BOTH groups are strictly oldest-first, and the merge-ready group
 * cannot starve the rest — every PR it processes leaves the queue permanently
 * (merge sessions are also the cheapest), so the group self-drains and the
 * remaining budget always reaches the oldest unready work next.
 */
export function planLoop(snapshots: PrSnapshot[], nowMs: number): OrderedPlan {
  const ordered = orderPrs(snapshots);
  const mergeReady: PrSnapshot[] = [];
  const staleCompletion: PrSnapshot[] = [];
  const rest: PrSnapshot[] = [];
  const skipped: { snapshot: PrSnapshot; reason: string }[] = [];
  for (const s of ordered) {
    const d = isActionable(s, nowMs);
    if (!d.actionable) {
      skipped.push({ snapshot: s, reason: d.reason ?? "skipped" });
    } else if (isMergeReady(s)) {
      mergeReady.push(s);
    } else if (isStaleReviewCompletionCandidate(s)) {
      staleCompletion.push(s);
    } else {
      rest.push(s);
    }
  }
  return { actionable: [...mergeReady, ...staleCompletion, ...rest], skipped };
}
