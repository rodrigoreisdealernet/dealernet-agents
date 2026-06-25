/**
 * incident-upsert.test.ts
 *
 * Unit and regression tests for the shared factory incident-upsert helper.
 *
 * Coverage:
 *   - Fingerprint generation and stability
 *   - PR-local vs shared-cause classification (explicit, exhaustive)
 *   - Upsert: create when no open issue exists
 *   - Upsert: update oldest open canonical issue when fingerprint matches
 *   - Label routing: shared-cause → auto:alert + queue:platform;
 *                    pr-local   → factory-stuck
 *   - Label drift regression: canonical issue is still found and updated by
 *     fingerprint body marker after labels have been changed by triage
 *   - Two PRs hitting the same PR-validation / CI blocker converge on the
 *     same shared-cause incident rather than spawning separate duplicates
 */

import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import {
  classifyIncident,
  buildSharedCauseFingerprint,
  buildPrLocalFingerprint,
  buildBodyWithFingerprint,
  defaultLabelsForKind,
  upsertIncident,
  SHARED_CAUSE_LABELS,
  PR_LOCAL_LABELS,
  SHARED_CAUSE_FAILURE_CLASSES,
  SHARED_CAUSE_CHECK_NAMES,
  type IncidentKind,
  type IncidentUpsertParams,
} from "../incident-upsert.js";
import type { GitHubApiClient, GitHubIssue } from "../alert-incident-bridge.js";
import { fingerprintComment, fingerprintSearchToken } from "../dedupe.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOpenIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 100,
    title: "existing incident",
    body: "existing body",
    state: "open",
    html_url: "https://github.com/example/repo/issues/100",
    labels: [{ name: "auto:alert" }, { name: "queue:platform" }],
    ...overrides,
  };
}

function makeMockApi(existingIssues: GitHubIssue[] = []): GitHubApiClient & {
  searchIssues: Mock;
  createIssue: Mock;
  updateIssue: Mock;
  addIssueComment: Mock;
} {
  return {
    searchIssues: vi.fn().mockResolvedValue(existingIssues),
    createIssue: vi.fn().mockImplementation(
      async (_owner, _repo, title, body, labels) =>
        ({
          number: 200,
          title,
          body,
          state: "open",
          html_url: "https://github.com/example/repo/issues/200",
          labels: (labels as string[]).map((name) => ({ name })),
        } satisfies GitHubIssue)
    ),
    updateIssue: vi.fn().mockImplementation(
      async (_owner, _repo, number, body) =>
        ({ ...makeOpenIssue(), number, body } satisfies GitHubIssue)
    ),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSharedCauseParams(overrides: Partial<IncidentUpsertParams> = {}): IncidentUpsertParams {
  const fp = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
  return {
    kind: "shared-cause",
    fingerprintId: fp,
    title: "🔴 PR Validation blocked — Temporal worker tests hanging",
    body: "Temporal worker test suite is hanging on all open PRs. This is a shared CI blocker.",
    ...overrides,
  };
}

function makePrLocalParams(prNumber: number, overrides: Partial<IncidentUpsertParams> = {}): IncidentUpsertParams {
  return {
    kind: "pr-local",
    fingerprintId: buildPrLocalFingerprint(prNumber),
    title: `factory-stuck: PR #${prNumber} is terminally blocked`,
    body: `PR #${prNumber} has been stuck for 3+ consecutive passes and re-kick failed.`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classifyIncident", () => {
  describe("shared-cause — fromWorkflowSentinel", () => {
    it("classifies as shared-cause when fromWorkflowSentinel is true", () => {
      expect(classifyIncident({ fromWorkflowSentinel: true })).toBe("shared-cause");
    });

    it("shared-cause even when no other context provided", () => {
      expect(classifyIncident({ fromWorkflowSentinel: true, failureClass: undefined })).toBe(
        "shared-cause"
      );
    });
  });

  describe("shared-cause — failureClass", () => {
    it.each([...SHARED_CAUSE_FAILURE_CLASSES])(
      "classifies '%s' as shared-cause",
      (fc) => {
        expect(classifyIncident({ failureClass: fc })).toBe("shared-cause");
      }
    );

    it("pr-validation is shared-cause", () => {
      expect(classifyIncident({ failureClass: "pr-validation" })).toBe("shared-cause");
    });

    it("temporal-worker-tests is shared-cause", () => {
      expect(classifyIncident({ failureClass: "temporal-worker-tests" })).toBe("shared-cause");
    });

    it("deploy is shared-cause", () => {
      expect(classifyIncident({ failureClass: "deploy" })).toBe("shared-cause");
    });
  });

  describe("shared-cause — checkName", () => {
    it.each([...SHARED_CAUSE_CHECK_NAMES])(
      "classifies check '%s' as shared-cause",
      (name) => {
        expect(classifyIncident({ checkName: name })).toBe("shared-cause");
      }
    );
  });

  describe("pr-local (default)", () => {
    it("is pr-local when no criteria match", () => {
      expect(classifyIncident({})).toBe("pr-local");
    });

    it("is pr-local for an unknown failureClass", () => {
      expect(classifyIncident({ failureClass: "some-unknown-failure" })).toBe("pr-local");
    });

    it("is pr-local when fromWorkflowSentinel is false", () => {
      expect(classifyIncident({ fromWorkflowSentinel: false })).toBe("pr-local");
    });

    it("is pr-local for an unknown checkName", () => {
      expect(classifyIncident({ checkName: "Some Custom Check" })).toBe("pr-local");
    });
  });
});

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

describe("buildSharedCauseFingerprint", () => {
  it("returns a stable shared-cause-prefixed id", () => {
    const fp = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    expect(fp).toMatch(/^shared-cause-[0-9a-f]{12}$/);
  });

  it("is deterministic — same inputs produce same fingerprint", () => {
    expect(buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests")).toBe(
      buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests")
    );
  });

  it("differs for different failure-class or scope", () => {
    const a = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const b = buildSharedCauseFingerprint("deploy", "helm-upgrade");
    expect(a).not.toBe(b);
  });

  it("two PRs hitting the same failure class+scope produce the SAME fingerprint", () => {
    // Simulate PR #1501 and PR #1502 both hitting the same Temporal worker hang.
    // Neither PR number appears in the shared-cause fingerprint.
    const fp1 = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const fp2 = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    expect(fp1).toBe(fp2);
    // Fingerprint must not contain PR numbers
    expect(fp1).not.toContain("1501");
    expect(fp1).not.toContain("1502");
  });
});

describe("buildPrLocalFingerprint", () => {
  it("returns factory-stuck-pr-<number>", () => {
    expect(buildPrLocalFingerprint(1501)).toBe("factory-stuck-pr-1501");
    expect(buildPrLocalFingerprint(42)).toBe("factory-stuck-pr-42");
  });

  it("is unique per PR number", () => {
    expect(buildPrLocalFingerprint(1)).not.toBe(buildPrLocalFingerprint(2));
  });
});

// ---------------------------------------------------------------------------
// Label routing
// ---------------------------------------------------------------------------

describe("defaultLabelsForKind", () => {
  it("shared-cause routes to auto:alert + queue:platform", () => {
    const labels = defaultLabelsForKind("shared-cause");
    expect(labels).toContain("auto:alert");
    expect(labels).toContain("queue:platform");
    expect(labels).not.toContain("queue:development");
    expect(labels).not.toContain("factory-stuck");
  });

  it("pr-local routes to factory-stuck, auto:alert, and priority:high", () => {
    const labels = defaultLabelsForKind("pr-local");
    expect(labels).toContain("factory-stuck");
    expect(labels).toContain("auto:alert");
    expect(labels).toContain("priority:high");
    expect(labels).not.toContain("queue:platform");
    expect(labels).not.toContain("queue:development");
  });

  it("returns a fresh copy — mutation does not affect constants", () => {
    const a = defaultLabelsForKind("shared-cause");
    a.push("extra");
    expect(defaultLabelsForKind("shared-cause")).not.toContain("extra");
  });
});

describe("SHARED_CAUSE_LABELS / PR_LOCAL_LABELS constants", () => {
  it("shared-cause labels include auto:alert and queue:platform", () => {
    expect(SHARED_CAUSE_LABELS).toContain("auto:alert");
    expect(SHARED_CAUSE_LABELS).toContain("queue:platform");
  });

  it("pr-local labels include factory-stuck", () => {
    expect(PR_LOCAL_LABELS).toContain("factory-stuck");
  });

  it("pr-local labels include auto:alert and priority:high (matches Rung-3 contract)", () => {
    expect(PR_LOCAL_LABELS).toContain("auto:alert");
    expect(PR_LOCAL_LABELS).toContain("priority:high");
  });

  it("pr-local labels do not include queue:development (shared CI blockers must not land there)", () => {
    expect(PR_LOCAL_LABELS).not.toContain("queue:development");
    expect(SHARED_CAUSE_LABELS).not.toContain("queue:development");
  });
});

// ---------------------------------------------------------------------------
// buildBodyWithFingerprint
// ---------------------------------------------------------------------------

describe("buildBodyWithFingerprint", () => {
  it("appends the fingerprint comment", () => {
    const fp = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const body = buildBodyWithFingerprint("some body", fp);
    expect(body).toContain(fingerprintComment(fp));
  });

  it("is idempotent — does not duplicate the marker", () => {
    const fp = buildPrLocalFingerprint(99);
    const once = buildBodyWithFingerprint("body", fp);
    const twice = buildBodyWithFingerprint(once, fp);
    const count = (twice.match(/<!-- fingerprint:/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// upsertIncident — create path
// ---------------------------------------------------------------------------

describe("upsertIncident — create (no existing open issue)", () => {
  it("creates a new issue when no open issue exists", async () => {
    const api = makeMockApi([]);
    const params = makeSharedCauseParams();
    const result = await upsertIncident(params, "owner", "repo", api);

    expect(result.action).toBe("created");
    expect(api.createIssue).toHaveBeenCalledOnce();
    expect(api.updateIssue).not.toHaveBeenCalled();
  });

  it("includes the fingerprint marker in the created body", async () => {
    const api = makeMockApi([]);
    const params = makeSharedCauseParams();
    const result = await upsertIncident(params, "owner", "repo", api);

    const [, , , body] = (api.createIssue as Mock).mock.calls[0] as [
      string, string, string, string, string[]
    ];
    expect(body).toContain(fingerprintComment(params.fingerprintId));
    expect(result.issueNumber).toBe(200);
  });

  it("applies shared-cause labels for a shared-cause incident", async () => {
    const api = makeMockApi([]);
    const params = makeSharedCauseParams();
    await upsertIncident(params, "owner", "repo", api);

    const [, , , , labels] = (api.createIssue as Mock).mock.calls[0] as [
      string, string, string, string, string[]
    ];
    expect(labels).toContain("auto:alert");
    expect(labels).toContain("queue:platform");
    expect(labels).not.toContain("queue:development");
  });

  it("applies pr-local labels for a pr-local incident", async () => {
    const api = makeMockApi([]);
    const params = makePrLocalParams(1501);
    await upsertIncident(params, "owner", "repo", api);

    const [, , , , labels] = (api.createIssue as Mock).mock.calls[0] as [
      string, string, string, string, string[]
    ];
    expect(labels).toContain("factory-stuck");
    expect(labels).toContain("auto:alert");
    expect(labels).toContain("priority:high");
    expect(labels).not.toContain("queue:platform");
    expect(labels).not.toContain("queue:development");
  });

  it("merges extraLabels into the created issue labels", async () => {
    const api = makeMockApi([]);
    const params = makeSharedCauseParams({ extraLabels: ["priority:high"] });
    await upsertIncident(params, "owner", "repo", api);

    const [, , , , labels] = (api.createIssue as Mock).mock.calls[0] as [
      string, string, string, string, string[]
    ];
    expect(labels).toContain("priority:high");
    expect(labels).toContain("auto:alert");
  });
});

// ---------------------------------------------------------------------------
// upsertIncident — update path
// ---------------------------------------------------------------------------

describe("upsertIncident — update (existing open issue found by fingerprint)", () => {
  it("updates the existing issue rather than creating a new one", async () => {
    const fp = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const existing = makeOpenIssue({
      body: `old body\n\n${fingerprintComment(fp)}`,
    });
    const api = makeMockApi([existing]);
    const params = makeSharedCauseParams({ fingerprintId: fp });
    const result = await upsertIncident(params, "owner", "repo", api);

    expect(result.action).toBe("updated");
    expect(result.issueNumber).toBe(100);
    expect(api.updateIssue).toHaveBeenCalledOnce();
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("adds a re-notification comment on update", async () => {
    const fp = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const existing = makeOpenIssue({ body: `body\n\n${fingerprintComment(fp)}` });
    const api = makeMockApi([existing]);
    const params = makeSharedCauseParams({ fingerprintId: fp });
    await upsertIncident(params, "owner", "repo", api);

    expect(api.addIssueComment).toHaveBeenCalledOnce();
    const comment = (api.addIssueComment as Mock).mock.calls[0]?.[3] as string;
    expect(comment).toContain(fp);
  });

  it("targets the OLDEST open issue when multiple duplicates exist (reduces forking)", async () => {
    const fp = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const older = makeOpenIssue({ number: 50, body: `body\n\n${fingerprintComment(fp)}` });
    const newer = makeOpenIssue({ number: 99, body: `body\n\n${fingerprintComment(fp)}` });
    const api = makeMockApi([newer, older]); // newer returned first by search
    const params = makeSharedCauseParams({ fingerprintId: fp });
    const result = await upsertIncident(params, "owner", "repo", api);

    expect(result.issueNumber).toBe(50); // oldest open wins
  });

  it("ignores closed issues — searches only open ones", async () => {
    const fp = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const closed = makeOpenIssue({ state: "closed", body: `body\n\n${fingerprintComment(fp)}` });
    const api = makeMockApi([closed]);
    const params = makeSharedCauseParams({ fingerprintId: fp });
    const result = await upsertIncident(params, "owner", "repo", api);

    expect(result.action).toBe("created");
    expect(api.createIssue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Label drift regression
// ---------------------------------------------------------------------------

describe("label drift regression — fingerprint body marker survives relabeling", () => {
  it("finds and updates a canonical issue even after its labels changed", async () => {
    // Scenario: triage moved the issue from auto:alert + queue:platform to
    // priority:critical + queue:ops. The fingerprint comment in the body
    // is the only search primitive — labels are not used as a filter.
    const fp = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const relabeledIssue = makeOpenIssue({
      labels: [{ name: "priority:critical" }, { name: "queue:ops" }], // labels drifted
      body: `original body\n\n${fingerprintComment(fp)}`, // but fingerprint marker still present
    });
    const api = makeMockApi([relabeledIssue]);
    const params = makeSharedCauseParams({ fingerprintId: fp });
    const result = await upsertIncident(params, "owner", "repo", api);

    // Must update, NOT create a second issue
    expect(result.action).toBe("updated");
    expect(result.issueNumber).toBe(100);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("uses body-based search token (not label filter) for the lookup", async () => {
    const fp = buildPrLocalFingerprint(1501);
    const api = makeMockApi([]);
    const params = makePrLocalParams(1501, { fingerprintId: fp });
    await upsertIncident(params, "owner", "repo", api);

    const [, , searchToken] = (api.searchIssues as Mock).mock.calls[0] as [
      string, string, string
    ];
    // The search token must be the fingerprint body marker, not a label query
    expect(searchToken).toBe(fingerprintSearchToken(fp));
    expect(searchToken).not.toContain("label:");
  });
});

// ---------------------------------------------------------------------------
// Shared PR-validation family convergence
// ---------------------------------------------------------------------------

describe("shared PR-validation family convergence", () => {
  it("two PRs blocked by the same CI failure produce the same shared-cause fingerprint", () => {
    // PR #1501 and PR #1502 both fail because 'Temporal worker tests' hangs.
    const fp1501 = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const fp1502 = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    expect(fp1501).toBe(fp1502);
  });

  it("second PR upsert updates the existing canonical incident rather than creating a duplicate", async () => {
    const fp = buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests");
    const canonicalIssue = makeOpenIssue({
      number: 1537,
      title: "PR Validation blocked — Temporal worker tests hanging",
      body: `Filed by PR #1501\n\n${fingerprintComment(fp)}`,
      labels: [{ name: "auto:alert" }, { name: "queue:platform" }],
    });

    // PR #1502 hits the same failure and tries to file an incident.
    const api = makeMockApi([canonicalIssue]);
    const paramsPr1502 = makeSharedCauseParams({ fingerprintId: fp });
    const result = await upsertIncident(paramsPr1502, "owner", "repo", api);

    // Must update the existing #1537, NOT create a new duplicate.
    expect(result.action).toBe("updated");
    expect(result.issueNumber).toBe(1537);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.updateIssue).toHaveBeenCalledOnce();
  });

  it("shared-cause incident is NOT routed to queue:development", async () => {
    const api = makeMockApi([]);
    const params = makeSharedCauseParams();
    await upsertIncident(params, "owner", "repo", api);

    const [, , , , labels] = (api.createIssue as Mock).mock.calls[0] as [
      string, string, string, string, string[]
    ];
    expect(labels).not.toContain("queue:development");
  });

  it("classifyIncident returns shared-cause for the PR Validation check name", () => {
    expect(classifyIncident({ checkName: "PR Validation" })).toBe("shared-cause");
  });

  it("classifyIncident returns shared-cause for the Temporal worker tests check name", () => {
    expect(classifyIncident({ checkName: "Temporal worker tests" })).toBe("shared-cause");
  });

  it("classifyIncident returns shared-cause for the pr-validation failureClass", () => {
    expect(classifyIncident({ failureClass: "pr-validation" })).toBe("shared-cause");
  });
});
