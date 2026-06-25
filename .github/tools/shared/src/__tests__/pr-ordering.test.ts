import { describe, it, expect } from "vitest";
import {
  orderPrs,
  isActionable,
  planLoop,
  minutesSince,
  isMergeReady,
  isStaleReviewCompletionCandidate,
  hasApprovalVerdict,
  BLOCKING_LANES,
  SETTLE_MINUTES,
  TECH_APPROVED_LABEL,
} from "../pr-ordering.js";
import type { PrSnapshot } from "../pr-snapshot.js";

const NOW = new Date("2026-06-07T12:00:00Z").getTime();

function pr(overrides: Partial<PrSnapshot>): PrSnapshot {
  return {
    number: 1,
    title: "t",
    author: "copilot-swe-agent",
    headRefName: "copilot/branch",
    createdAt: "2026-06-07T10:00:00Z",
    updatedAt: "2026-06-07T11:00:00Z",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    changedFiles: 1,
    labels: [],
    latestReview: null,
    approved: false,
    changesRequested: false,
    reviewSuperseded: false,
    lastCommitAt: "2026-06-07T11:00:00Z",
    ciState: "SUCCESS",
    checks: [],
    linkedIssues: [],
    priorLedger: null,
    stateMarkerCommentId: null,
    ...overrides,
  };
}

describe("orderPrs", () => {
  it("sorts strictly oldest-first by createdAt", () => {
    const out = orderPrs([
      pr({ number: 3, createdAt: "2026-06-07T11:00:00Z" }),
      pr({ number: 1, createdAt: "2026-06-07T09:00:00Z" }),
      pr({ number: 2, createdAt: "2026-06-07T10:00:00Z" }),
    ]);
    expect(out.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("breaks createdAt ties by PR number and does not mutate the input", () => {
    const input = [
      pr({ number: 9, createdAt: "2026-06-07T10:00:00Z" }),
      pr({ number: 4, createdAt: "2026-06-07T10:00:00Z" }),
    ];
    const out = orderPrs(input);
    expect(out.map((p) => p.number)).toEqual([4, 9]);
    expect(input.map((p) => p.number)).toEqual([9, 4]); // original untouched
  });
});

describe("minutesSince", () => {
  it("returns Infinity for null", () => {
    expect(minutesSince(null, NOW)).toBe(Infinity);
  });
  it("computes elapsed minutes", () => {
    expect(minutesSince("2026-06-07T11:30:00Z", NOW)).toBe(30);
  });
});

describe("isActionable", () => {
  it("skips a draft that committed within the settle window", () => {
    const d = isActionable(pr({ isDraft: true, lastCommitAt: "2026-06-07T11:58:00Z" }), NOW);
    expect(d.actionable).toBe(false);
    expect(d.reason).toMatch(/still warm/);
  });

  it("keeps a settled draft (commit older than the settle window) actionable", () => {
    const old = new Date(NOW - (SETTLE_MINUTES + 5) * 60000).toISOString();
    expect(isActionable(pr({ isDraft: true, lastCommitAt: old }), NOW).actionable).toBe(true);
  });

  it("keeps a draft with no commit timestamp actionable (defaults to true when uncertain)", () => {
    expect(isActionable(pr({ isDraft: true, lastCommitAt: null }), NOW).actionable).toBe(true);
  });

  it("always keeps non-draft PRs actionable (conflicts, failing CI, awaiting review)", () => {
    expect(isActionable(pr({ isDraft: false, mergeable: "CONFLICTING" }), NOW).actionable).toBe(true);
    expect(isActionable(pr({ isDraft: false, ciState: "FAILURE" }), NOW).actionable).toBe(true);
    expect(isActionable(pr({ isDraft: false, approved: true }), NOW).actionable).toBe(true);
  });
});

describe("isMergeReady", () => {
  const ready = {
    isDraft: false,
    approved: true,
    mergeable: "MERGEABLE",
    ciState: "SUCCESS",
    labels: [] as string[],
  };

  it("is true only for a non-draft, approved, green, mergeable PR with no open lane", () => {
    expect(isMergeReady(pr(ready))).toBe(true);
  });

  it("is false when any merge precondition is missing", () => {
    expect(isMergeReady(pr({ ...ready, isDraft: true }))).toBe(false);
    expect(isMergeReady(pr({ ...ready, approved: false }))).toBe(false);
    expect(isMergeReady(pr({ ...ready, mergeable: "CONFLICTING" }))).toBe(false);
    expect(isMergeReady(pr({ ...ready, ciState: "FAILURE" }))).toBe(false);
    expect(isMergeReady(pr({ ...ready, ciState: null }))).toBe(false);
  });

  it("is false while any blocking specialist lane is open", () => {
    for (const lane of BLOCKING_LANES) {
      expect(isMergeReady(pr({ ...ready, labels: [lane] }))).toBe(false);
    }
    // Soft labels do not block.
    expect(isMergeReady(pr({ ...ready, labels: ["needs-tests", "risk:high"] }))).toBe(true);
  });

  it("accepts the tech-approved label verdict when a formal approval is impossible (PAT-authored PR, #1192)", () => {
    const labelVerdict = pr({ ...ready, approved: false, labels: [TECH_APPROVED_LABEL] });
    expect(hasApprovalVerdict(labelVerdict)).toBe(true);
    expect(isMergeReady(labelVerdict)).toBe(true);
    // The label is a verdict, not a bypass: every other gate still applies.
    expect(isMergeReady(pr({ ...ready, approved: false, labels: [TECH_APPROVED_LABEL], ciState: "FAILURE" }))).toBe(false);
    expect(isMergeReady(pr({ ...ready, approved: false, labels: [TECH_APPROVED_LABEL, BLOCKING_LANES[0]] }))).toBe(false);
    expect(isMergeReady(pr({ ...ready, approved: false }))).toBe(false);
  });
});

describe("isStaleReviewCompletionCandidate", () => {
  const stale = {
    isDraft: false,
    changesRequested: true,
    reviewSuperseded: true,
    approved: false,
    mergeable: "MERGEABLE",
    ciState: "SUCCESS",
    labels: [] as string[],
  };

  it("is true for the #848 shape: superseded verdict on a clean head", () => {
    expect(isStaleReviewCompletionCandidate(pr(stale))).toBe(true);
  });

  it("is false when the review is standing, the head is not clean, or already approved", () => {
    expect(isStaleReviewCompletionCandidate(pr({ ...stale, reviewSuperseded: false }))).toBe(false);
    expect(isStaleReviewCompletionCandidate(pr({ ...stale, isDraft: true }))).toBe(false);
    expect(isStaleReviewCompletionCandidate(pr({ ...stale, ciState: "FAILURE" }))).toBe(false);
    expect(isStaleReviewCompletionCandidate(pr({ ...stale, mergeable: "CONFLICTING" }))).toBe(false);
    expect(isStaleReviewCompletionCandidate(pr({ ...stale, approved: true }))).toBe(false);
    for (const lane of BLOCKING_LANES) {
      expect(isStaleReviewCompletionCandidate(pr({ ...stale, labels: [lane] }))).toBe(false);
    }
  });
});

describe("planLoop", () => {
  it("returns actionable PRs oldest-first and skipped PRs with reasons", () => {
    const plan = planLoop(
      [
        pr({ number: 30, createdAt: "2026-06-07T11:50:00Z", isDraft: true, lastCommitAt: "2026-06-07T11:59:00Z" }),
        pr({ number: 10, createdAt: "2026-06-07T09:00:00Z" }),
        pr({ number: 20, createdAt: "2026-06-07T10:00:00Z" }),
      ],
      NOW
    );
    expect(plan.actionable.map((p) => p.number)).toEqual([10, 20]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.snapshot.number).toBe(30);
    expect(plan.skipped[0]!.reason).toMatch(/still warm/);
  });

  it("puts merge-ready PRs first (queue exit priority), oldest-first within each group", () => {
    const plan = planLoop(
      [
        pr({ number: 10, createdAt: "2026-06-07T08:00:00Z" }), // oldest, not merge-ready
        pr({ number: 20, createdAt: "2026-06-07T09:00:00Z", approved: true }), // merge-ready
        pr({ number: 30, createdAt: "2026-06-07T10:00:00Z" }), // not merge-ready
        pr({ number: 40, createdAt: "2026-06-07T11:00:00Z", approved: true }), // merge-ready, newer
      ],
      NOW
    );
    expect(plan.actionable.map((p) => p.number)).toEqual([20, 40, 10, 30]);
  });

  it("orders merge-ready, then stale-review completion candidates, then the rest", () => {
    const staleShape = {
      changesRequested: true,
      reviewSuperseded: true,
      mergeable: "MERGEABLE",
      ciState: "SUCCESS",
    };
    const plan = planLoop(
      [
        pr({ number: 10, createdAt: "2026-06-07T08:00:00Z" }), // rest (oldest overall)
        pr({ number: 20, createdAt: "2026-06-07T09:00:00Z", ...staleShape }), // stale completion
        pr({ number: 30, createdAt: "2026-06-07T10:00:00Z", approved: true }), // merge-ready
      ],
      NOW
    );
    expect(plan.actionable.map((p) => p.number)).toEqual([30, 20, 10]);
  });

  it("keeps strict oldest-first when nothing is merge-ready (no starvation reordering)", () => {
    const plan = planLoop(
      [
        pr({ number: 3, createdAt: "2026-06-07T11:00:00Z" }),
        pr({ number: 1, createdAt: "2026-06-07T09:00:00Z" }),
        pr({ number: 2, createdAt: "2026-06-07T10:00:00Z" }),
      ],
      NOW
    );
    expect(plan.actionable.map((p) => p.number)).toEqual([1, 2, 3]);
  });
});
