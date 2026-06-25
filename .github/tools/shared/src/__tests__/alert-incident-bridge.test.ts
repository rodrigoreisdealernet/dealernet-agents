/**
 * alert-incident-bridge.test.ts
 *
 * Contract tests for the Alertmanager → GitHub incident bridge.
 * These tests verify fingerprinting stability, create vs update behaviour,
 * and resolved-alert handling using synthetic Alertmanager payloads.
 * All GitHub API calls are stubbed — no network is required.
 */

import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import {
  buildAlertFingerprint,
  buildIssueTitle,
  buildIssueBody,
  fingerprintComment,
  fingerprintSearchToken,
  processAlert,
  processPayload,
  alertScope,
  INCIDENT_LABELS,
  type AlertmanagerAlert,
  type AlertmanagerPayload,
  type GitHubApiClient,
  type GitHubIssue,
} from "../alert-incident-bridge.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFiringAlert(overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert {
  return {
    status: "firing",
    labels: {
      alertname: "TemporalWorkerDown",
      severity: "critical",
      env: "wynne-test",
      component: "temporal-worker",
      namespace: "wynne-test",
    },
    annotations: {
      summary: "Temporal worker is down in wynne-test",
      description: "No temporal-worker pod has been ready for 2 minutes.",
      runbook: "See OPERATIONS.md § TemporalWorkerDown",
    },
    startsAt: "2024-01-15T10:00:00Z",
    endsAt: "0001-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeResolvedAlert(overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert {
  return makeFiringAlert({
    status: "resolved",
    endsAt: "2024-01-15T10:30:00Z",
    ...overrides,
  });
}

function makePayload(alerts: AlertmanagerAlert[]): AlertmanagerPayload {
  return {
    version: "4",
    groupKey: "{}:{alertname='TemporalWorkerDown'}",
    truncatedAlerts: 0,
    status: "firing",
    receiver: "incident-bridge",
    groupLabels: { alertname: "TemporalWorkerDown" },
    commonLabels: { env: "wynne-test" },
    commonAnnotations: {},
    externalURL: "https://alertmanager.example.com",
    alerts,
  };
}

function makeMockApi(existingIssues: GitHubIssue[] = []): GitHubApiClient & {
  searchIssues: Mock;
  createIssue: Mock;
  updateIssue: Mock;
  addIssueComment: Mock;
} {
  const mockIssue: GitHubIssue = {
    number: 42,
    title: "🔴 [wynne-test] TemporalWorkerDown — temporal-worker",
    body: "existing body",
    state: "open",
    html_url: "https://github.com/example/repo/issues/42",
    labels: [{ name: "auto:alert" }, { name: "queue:ops" }],
  };
  const issueToReturn: GitHubIssue = {
    ...mockIssue,
    ...existingIssues[0],
  };
  return {
    searchIssues: vi.fn().mockResolvedValue(existingIssues),
    createIssue: vi.fn().mockResolvedValue({ ...issueToReturn, number: 99 }),
    updateIssue: vi.fn().mockResolvedValue(issueToReturn),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Fingerprint tests
// ---------------------------------------------------------------------------

describe("buildAlertFingerprint", () => {
  it("returns a stable prefixed id", () => {
    const alert = makeFiringAlert();
    const fp = buildAlertFingerprint(alert);
    expect(fp).toMatch(/^alert-[0-9a-f]{12}$/);
  });

  it("is deterministic for identical inputs", () => {
    const alert = makeFiringAlert();
    expect(buildAlertFingerprint(alert)).toBe(buildAlertFingerprint(alert));
  });

  it("differs for different environments", () => {
    const alertA = makeFiringAlert({ labels: { ...makeFiringAlert().labels, env: "wynne-test" } });
    const alertB = makeFiringAlert({ labels: { ...makeFiringAlert().labels, env: "wynne-prod" } });
    expect(buildAlertFingerprint(alertA)).not.toBe(buildAlertFingerprint(alertB));
  });

  it("differs for different alertnames", () => {
    const alertA = makeFiringAlert({ labels: { ...makeFiringAlert().labels, alertname: "TemporalWorkerDown" } });
    const alertB = makeFiringAlert({ labels: { ...makeFiringAlert().labels, alertname: "OpsApiErrorRateHigh" } });
    expect(buildAlertFingerprint(alertA)).not.toBe(buildAlertFingerprint(alertB));
  });

  it("uses task_queue as scope when present", () => {
    const alertA = makeFiringAlert({
      labels: { ...makeFiringAlert().labels, task_queue: "main" },
    });
    const alertB = makeFiringAlert({
      labels: { ...makeFiringAlert().labels, task_queue: "ops" },
    });
    expect(buildAlertFingerprint(alertA)).not.toBe(buildAlertFingerprint(alertB));
  });

  it("is stable across firing/resolved transitions", () => {
    const firing = makeFiringAlert();
    const resolved = makeResolvedAlert();
    // Same alert identity should produce the same fingerprint regardless of status.
    expect(buildAlertFingerprint(firing)).toBe(buildAlertFingerprint(resolved));
  });
});

// ---------------------------------------------------------------------------
// alertScope tests
// ---------------------------------------------------------------------------

describe("alertScope", () => {
  it("prefers task_queue", () => {
    expect(alertScope({ task_queue: "main", component: "temporal-worker", schedule_id: "sched-1" })).toBe("main");
  });

  it("falls back to schedule_id", () => {
    expect(alertScope({ schedule_id: "sched-1", component: "temporal-worker" })).toBe("sched-1");
  });

  it("falls back to component", () => {
    expect(alertScope({ component: "ops-api" })).toBe("ops-api");
  });

  it("falls back to global", () => {
    expect(alertScope({})).toBe("global");
  });
});

// ---------------------------------------------------------------------------
// Fingerprint comment / search token
// ---------------------------------------------------------------------------

describe("fingerprintComment / fingerprintSearchToken", () => {
  it("encodes fingerprint in HTML comment", () => {
    const id = "alert-abc123def456";
    expect(fingerprintComment(id)).toBe(`<!-- fingerprint:${id} -->`);
  });

  it("builds a searchable token", () => {
    const id = "alert-abc123def456";
    expect(fingerprintSearchToken(id)).toBe(`fingerprint:${id}`);
  });
});

// ---------------------------------------------------------------------------
// Issue body / title builder tests
// ---------------------------------------------------------------------------

describe("buildIssueTitle", () => {
  it("includes severity emoji, env, alertname, and scope", () => {
    const alert = makeFiringAlert();
    const title = buildIssueTitle(alert);
    expect(title).toContain("🔴");
    expect(title).toContain("wynne-test");
    expect(title).toContain("TemporalWorkerDown");
    expect(title).toContain("temporal-worker");
  });

  it("uses 🟡 for warning severity", () => {
    const alert = makeFiringAlert({
      labels: { ...makeFiringAlert().labels, severity: "warning" },
    });
    expect(buildIssueTitle(alert)).toContain("🟡");
  });
});

describe("buildIssueBody", () => {
  it("embeds fingerprint comment for searching", () => {
    const alert = makeFiringAlert();
    const fp = buildAlertFingerprint(alert);
    const body = buildIssueBody(alert, fp);
    expect(body).toContain(fingerprintComment(fp));
  });

  it("includes the summary and description", () => {
    const alert = makeFiringAlert();
    const body = buildIssueBody(alert, buildAlertFingerprint(alert));
    expect(body).toContain("Temporal worker is down in wynne-test");
    expect(body).toContain("No temporal-worker pod has been ready");
  });

  it("includes the runbook reference", () => {
    const alert = makeFiringAlert();
    const body = buildIssueBody(alert, buildAlertFingerprint(alert));
    expect(body).toContain("OPERATIONS.md § TemporalWorkerDown");
  });

  it("includes all alert labels in a code block", () => {
    const alert = makeFiringAlert();
    const body = buildIssueBody(alert, buildAlertFingerprint(alert));
    expect(body).toContain("alertname=TemporalWorkerDown");
    expect(body).toContain("env=wynne-test");
  });
});

// ---------------------------------------------------------------------------
// processAlert — create path
// ---------------------------------------------------------------------------

describe("processAlert — create new incident", () => {
  it("creates a new issue when no open issue exists", async () => {
    const alert = makeFiringAlert();
    const api = makeMockApi([]); // no existing issues
    const result = await processAlert(alert, "owner", "repo", api);

    expect(result.action).toBe("created");
    expect(api.createIssue).toHaveBeenCalledOnce();

    const [o, r, title, body, labels] = (api.createIssue as Mock).mock.calls[0] as [
      string,
      string,
      string,
      string,
      string[],
    ];
    expect(o).toBe("owner");
    expect(r).toBe("repo");
    expect(title).toContain("TemporalWorkerDown");
    expect(body).toContain(fingerprintComment(result.fingerprintId));
    expect(labels).toContain("auto:alert");
    expect(labels).toContain("queue:ops");
  });

  it("labels include all INCIDENT_LABELS", async () => {
    const alert = makeFiringAlert();
    const api = makeMockApi([]);
    await processAlert(alert, "owner", "repo", api);
    const labels = (api.createIssue as Mock).mock.calls[0]?.[4] as string[];
    for (const l of INCIDENT_LABELS) {
      expect(labels).toContain(l);
    }
  });

  it("does not search with wrong token format", async () => {
    const alert = makeFiringAlert();
    const api = makeMockApi([]);
    const result = await processAlert(alert, "owner", "repo", api);
    const searchArg = (api.searchIssues as Mock).mock.calls[0]?.[2] as string;
    expect(searchArg).toBe(fingerprintSearchToken(result.fingerprintId));
  });
});

// ---------------------------------------------------------------------------
// processAlert — update path (dedup)
// ---------------------------------------------------------------------------

describe("processAlert — update existing incident (dedupe)", () => {
  it("updates body and adds comment instead of creating a new issue", async () => {
    const alert = makeFiringAlert();
    const fp = buildAlertFingerprint(alert);
    const existingIssue: GitHubIssue = {
      number: 42,
      title: "existing title",
      body: `old body\n${fingerprintComment(fp)}`,
      state: "open",
      html_url: "https://github.com/example/repo/issues/42",
      labels: [{ name: "auto:alert" }],
    };
    const api = makeMockApi([existingIssue]);

    const result = await processAlert(alert, "owner", "repo", api);

    expect(result.action).toBe("updated");
    expect(result.issueNumber).toBe(42);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.updateIssue).toHaveBeenCalledOnce();
    expect(api.addIssueComment).toHaveBeenCalledOnce();

    const commentBody = (api.addIssueComment as Mock).mock.calls[0]?.[3] as string;
    expect(commentBody).toContain("still firing");
  });

  it("only matches open issues — ignores closed ones", async () => {
    const alert = makeFiringAlert();
    const fp = buildAlertFingerprint(alert);
    const closedIssue: GitHubIssue = {
      number: 10,
      title: "closed issue",
      body: fingerprintComment(fp),
      state: "closed",
      html_url: "https://github.com/example/repo/issues/10",
      labels: [],
    };
    const api = makeMockApi([closedIssue]);

    const result = await processAlert(alert, "owner", "repo", api);
    expect(result.action).toBe("created");
    expect(api.createIssue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// processAlert — resolved path
// ---------------------------------------------------------------------------

describe("processAlert — resolved alert", () => {
  it("adds resolved comment to open issue", async () => {
    const alert = makeResolvedAlert();
    const fp = buildAlertFingerprint(alert);
    const openIssue: GitHubIssue = {
      number: 42,
      title: "existing",
      body: fingerprintComment(fp),
      state: "open",
      html_url: "https://github.com/example/repo/issues/42",
      labels: [],
    };
    const api = makeMockApi([openIssue]);

    const result = await processAlert(alert, "owner", "repo", api);

    expect(result.action).toBe("resolved");
    expect(result.issueNumber).toBe(42);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(api.addIssueComment).toHaveBeenCalledOnce();

    const commentBody = (api.addIssueComment as Mock).mock.calls[0]?.[3] as string;
    expect(commentBody).toContain("resolved");
    expect(commentBody).toContain("2024-01-15T10:30:00Z");
  });

  it("skips when no open issue exists for resolved alert", async () => {
    const alert = makeResolvedAlert();
    const api = makeMockApi([]); // no existing issues

    const result = await processAlert(alert, "owner", "repo", api);

    expect(result.action).toBe("skipped");
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.addIssueComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processPayload — end-to-end with synthetic Alertmanager payload
// ---------------------------------------------------------------------------

describe("processPayload — synthetic end-to-end", () => {
  it("processes each alert independently and returns one result per alert", async () => {
    const alerts = [
      makeFiringAlert({ labels: { ...makeFiringAlert().labels, alertname: "TemporalWorkerDown" } }),
      makeFiringAlert({ labels: { ...makeFiringAlert().labels, alertname: "OpsApiErrorRateHigh", component: "ops-api" } }),
    ];
    const payload = makePayload(alerts);
    const api = makeMockApi([]); // no existing issues

    const results = await processPayload(payload, "owner", "repo", api);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.action === "created")).toBe(true);
    expect(api.createIssue).toHaveBeenCalledTimes(2);
  });

  it("deduplicates — second firing notification updates the same issue", async () => {
    const alert = makeFiringAlert();
    const fp = buildAlertFingerprint(alert);
    const existingIssue: GitHubIssue = {
      number: 55,
      title: "existing",
      body: fingerprintComment(fp),
      state: "open",
      html_url: "https://github.com/example/repo/issues/55",
      labels: [],
    };
    const payload = makePayload([alert]);
    const api = makeMockApi([existingIssue]);

    const results = await processPayload(payload, "owner", "repo", api);

    expect(results[0]?.action).toBe("updated");
    expect(results[0]?.issueNumber).toBe(55);
    expect(api.createIssue).not.toHaveBeenCalled();
  });

  it("firing then resolved updates then notes resolution on the same issue", async () => {
    const firing = makeFiringAlert();
    const fp = buildAlertFingerprint(firing);

    // First call: no existing issue → create
    const apiFirst = makeMockApi([]);
    await processPayload(makePayload([firing]), "owner", "repo", apiFirst);
    expect(apiFirst.createIssue).toHaveBeenCalledOnce();

    // Second call: existing open issue + resolved alert → resolved comment
    const createdIssue: GitHubIssue = {
      number: 99,
      title: "incident",
      body: fingerprintComment(fp),
      state: "open",
      html_url: "https://github.com/example/repo/issues/99",
      labels: [],
    };
    const apiSecond = makeMockApi([createdIssue]);
    const resolved = makeResolvedAlert();
    const results = await processPayload(makePayload([resolved]), "owner", "repo", apiSecond);

    expect(results[0]?.action).toBe("resolved");
    expect(results[0]?.issueNumber).toBe(99);
    expect(apiSecond.addIssueComment).toHaveBeenCalledOnce();
  });
});
