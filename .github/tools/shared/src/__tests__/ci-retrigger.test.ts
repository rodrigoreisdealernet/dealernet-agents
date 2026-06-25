import { describe, it, expect } from "vitest";
import {
  isCiGated,
  needsCiRetrigger,
  selectCiRetriggerTargets,
  DEFAULT_RETRIGGER_CAP,
} from "../ci-retrigger.js";
import type { PrSnapshot } from "../pr-snapshot.js";

const NOW = new Date("2026-06-10T12:00:00Z").getTime();
const SETTLED = "2026-06-10T11:00:00Z"; // 60 min ago — well past the settle window

function pr(overrides: Partial<PrSnapshot>): PrSnapshot {
  return {
    number: 1,
    title: "t",
    author: "copilot-swe-agent",
    headRefName: "copilot/branch-1",
    createdAt: "2026-06-10T08:00:00Z",
    updatedAt: SETTLED,
    isDraft: true,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    changedFiles: 1,
    labels: [],
    latestReview: null,
    approved: false,
    changesRequested: false,
    reviewSuperseded: false,
    lastCommitAt: SETTLED,
    ciState: null,
    checks: [],
    linkedIssues: [],
    priorLedger: null,
    stateMarkerCommentId: null,
    ...overrides,
  };
}

describe("isCiGated", () => {
  it("is gated with zero checks reported (the normal face of the actor gate)", () => {
    expect(isCiGated(pr({ checks: [] }))).toBe(true);
  });

  it("is gated when every check is action_required", () => {
    expect(
      isCiGated(
        pr({ checks: [{ name: "v", status: "COMPLETED", conclusion: "ACTION_REQUIRED" }] })
      )
    ).toBe(true);
  });

  it("is NOT gated once real checks report", () => {
    expect(
      isCiGated(pr({ checks: [{ name: "v", status: "COMPLETED", conclusion: "SUCCESS" }] }))
    ).toBe(false);
    expect(
      isCiGated(pr({ checks: [{ name: "v", status: "IN_PROGRESS", conclusion: null }] }))
    ).toBe(false);
  });
});

describe("needsCiRetrigger", () => {
  it("re-triggers a settled, gated PR (draft or not)", () => {
    expect(needsCiRetrigger(pr({}), NOW).retrigger).toBe(true);
    expect(needsCiRetrigger(pr({ isDraft: false }), NOW).retrigger).toBe(true);
  });

  it("skips when checks already reported", () => {
    const d = needsCiRetrigger(
      pr({ checks: [{ name: "v", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      NOW
    );
    expect(d.retrigger).toBe(false);
    expect(d.reason).toMatch(/already reported/);
  });

  it("skips a conflicting PR — CI is not its blocker", () => {
    expect(needsCiRetrigger(pr({ mergeable: "CONFLICTING" }), NOW).retrigger).toBe(false);
  });

  it("skips a still-warm head (Copilot mid-push would just re-gate it)", () => {
    const d = needsCiRetrigger(pr({ lastCommitAt: "2026-06-10T11:58:00Z" }), NOW);
    expect(d.retrigger).toBe(false);
    expect(d.reason).toMatch(/warm/);
  });

  it("skips when changes-requested is newer than the head — ball is in Copilot's court", () => {
    const d = needsCiRetrigger(
      pr({
        changesRequested: true,
        latestReview: {
          state: "CHANGES_REQUESTED",
          author: "reviewer",
          submittedAt: "2026-06-10T11:30:00Z", // newer than lastCommitAt (11:00)
        },
      }),
      NOW
    );
    expect(d.retrigger).toBe(false);
    expect(d.reason).toMatch(/waiting on Copilot/);
  });

  it("re-triggers when new commits landed after changes-requested (head superseded the review)", () => {
    const d = needsCiRetrigger(
      pr({
        changesRequested: true,
        latestReview: {
          state: "CHANGES_REQUESTED",
          author: "reviewer",
          submittedAt: "2026-06-10T10:00:00Z", // older than lastCommitAt (11:00)
        },
      }),
      NOW
    );
    expect(d.retrigger).toBe(true);
  });

  it("skips when the snapshot has no head ref", () => {
    expect(needsCiRetrigger(pr({ headRefName: "" }), NOW).retrigger).toBe(false);
  });
});

describe("selectCiRetriggerTargets", () => {
  it("selects oldest-first and respects the cap", () => {
    const out = selectCiRetriggerTargets(
      [
        pr({ number: 3, createdAt: "2026-06-10T10:00:00Z" }),
        pr({ number: 1, createdAt: "2026-06-10T08:00:00Z" }),
        pr({ number: 2, createdAt: "2026-06-10T09:00:00Z" }),
      ],
      NOW,
      2
    );
    expect(out.map((p) => p.number)).toEqual([1, 2]);
  });

  it("filters out non-candidates before applying the cap", () => {
    const out = selectCiRetriggerTargets(
      [
        pr({ number: 1, mergeable: "CONFLICTING" }),
        pr({ number: 2 }),
        pr({ number: 3, checks: [{ name: "v", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      ],
      NOW,
      DEFAULT_RETRIGGER_CAP
    );
    expect(out.map((p) => p.number)).toEqual([2]);
  });
});
