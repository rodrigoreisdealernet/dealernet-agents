import { describe, it, expect } from "vitest";
import {
  computeStateFingerprint,
  formatStateMarker,
  parseStateMarker,
  advanceLedger,
  buildStuckNotice,
  STUCK_THRESHOLD,
} from "../pr-state.js";
import type { PrSnapshot } from "../pr-snapshot.js";

function pr(overrides: Partial<PrSnapshot>): PrSnapshot {
  return {
    number: 1,
    title: "t",
    author: "copilot-swe-agent",
    headRefName: "copilot/branch",
    createdAt: "2026-06-10T10:00:00Z",
    updatedAt: "2026-06-10T11:00:00Z",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    changedFiles: 1,
    labels: ["queue:review"],
    latestReview: null,
    approved: false,
    changesRequested: false,
    reviewSuperseded: false,
    lastCommitAt: "2026-06-10T11:00:00Z",
    ciState: "SUCCESS",
    checks: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    linkedIssues: [],
    priorLedger: null,
    stateMarkerCommentId: null,
    ...overrides,
  };
}

describe("computeStateFingerprint", () => {
  it("is stable for identical meaningful state", () => {
    expect(computeStateFingerprint(pr({}))).toBe(computeStateFingerprint(pr({})));
  });

  it("ignores commit identity — a re-trigger empty commit is NOT progress", () => {
    const a = computeStateFingerprint(pr({ lastCommitAt: "2026-06-10T11:00:00Z" }));
    const b = computeStateFingerprint(pr({ lastCommitAt: "2026-06-10T12:30:00Z", updatedAt: "2026-06-10T12:30:00Z" }));
    expect(a).toBe(b);
  });

  it("changes when anything meaningful moves: draft, mergeable, CI, review, labels", () => {
    const base = computeStateFingerprint(pr({}));
    expect(computeStateFingerprint(pr({ isDraft: true }))).not.toBe(base);
    expect(computeStateFingerprint(pr({ mergeable: "CONFLICTING" }))).not.toBe(base);
    expect(computeStateFingerprint(pr({ ciState: "FAILURE" }))).not.toBe(base);
    expect(computeStateFingerprint(pr({ checks: [] }))).not.toBe(base);
    expect(computeStateFingerprint(pr({ approved: true }))).not.toBe(base);
    expect(computeStateFingerprint(pr({ changesRequested: true }))).not.toBe(base);
    expect(
      computeStateFingerprint(pr({ changesRequested: true, reviewSuperseded: true }))
    ).not.toBe(computeStateFingerprint(pr({ changesRequested: true })));
    expect(computeStateFingerprint(pr({ labels: ["queue:review", "needs-tests"] }))).not.toBe(base);
  });

  it("is label-order independent", () => {
    expect(computeStateFingerprint(pr({ labels: ["a", "b"] }))).toBe(
      computeStateFingerprint(pr({ labels: ["b", "a"] }))
    );
  });
});

describe("marker round-trip", () => {
  it("formats and parses back the ledger", () => {
    const ledger = { fingerprint: "x|y|z", count: 4, at: "2026-06-10T12:00:00Z" };
    expect(parseStateMarker(formatStateMarker(ledger))).toEqual(ledger);
  });

  it("parses a marker embedded in other comment text", () => {
    const body = `some text\n${formatStateMarker({ fingerprint: "f", count: 2, at: "t" })}\nmore`;
    expect(parseStateMarker(body)?.count).toBe(2);
  });

  it("returns null for absent or malformed markers", () => {
    expect(parseStateMarker("just a comment")).toBeNull();
    expect(parseStateMarker("<!-- factory-pr-state:v1: not-json -->")).toBeNull();
    expect(parseStateMarker('<!-- factory-pr-state:v1: {"count":2} -->')).toBeNull(); // missing fingerprint
  });
});

describe("advanceLedger", () => {
  it("starts at 1 with no prior marker", () => {
    expect(advanceLedger(null, "f", "now").count).toBe(1);
  });

  it("increments when the fingerprint is unchanged", () => {
    const prior = { fingerprint: "f", count: 2, at: "earlier" };
    expect(advanceLedger(prior, "f", "now")).toEqual({ fingerprint: "f", count: 3, at: "now" });
  });

  it("resets to 1 when the state moved", () => {
    const prior = { fingerprint: "old", count: 5, at: "earlier" };
    expect(advanceLedger(prior, "new", "now").count).toBe(1);
  });
});

describe("buildStuckNotice", () => {
  it("is silent below the threshold", () => {
    expect(buildStuckNotice({ fingerprint: "f", count: STUCK_THRESHOLD - 1, at: "t" })).toBeNull();
  });

  it("fires at the threshold with the count and ladder instruction", () => {
    const notice = buildStuckNotice({ fingerprint: "f", count: STUCK_THRESHOLD, at: "t" });
    expect(notice).toContain("STUCK LEDGER");
    expect(notice).toContain(`${STUCK_THRESHOLD} consecutive`);
    expect(notice).toContain("escalation ladder");
  });

  it("includes shared-cause vs pr-local classification rule", () => {
    const notice = buildStuckNotice({ fingerprint: "f", count: STUCK_THRESHOLD, at: "t" });
    expect(notice).toContain("shared-cause");
    expect(notice).toContain("pr-local");
  });

  it("instructs that shared-cause CI failures route to queue:platform, not queue:development", () => {
    const notice = buildStuckNotice({ fingerprint: "f", count: STUCK_THRESHOLD, at: "t" });
    expect(notice).toContain("queue:platform");
    expect(notice).toContain("queue:development");
    expect(notice).toContain("Do NOT open a");
  });

  it("references the shared incident-upsert helper module", () => {
    const notice = buildStuckNotice({ fingerprint: "f", count: STUCK_THRESHOLD, at: "t" });
    expect(notice).toContain("incident-upsert");
    expect(notice).toContain("upsertIncident");
  });

  it("instructs use of buildSharedCauseFingerprint for shared-cause incidents", () => {
    const notice = buildStuckNotice({ fingerprint: "f", count: STUCK_THRESHOLD, at: "t" });
    expect(notice).toContain("buildSharedCauseFingerprint");
  });

  it("instructs use of buildPrLocalFingerprint for pr-local incidents", () => {
    const notice = buildStuckNotice({ fingerprint: "f", count: STUCK_THRESHOLD, at: "t" });
    expect(notice).toContain("buildPrLocalFingerprint");
  });
});
