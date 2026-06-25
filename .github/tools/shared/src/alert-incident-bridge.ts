/**
 * alert-incident-bridge.ts
 *
 * Translates an Alertmanager webhook payload into deduplicated GitHub incidents
 * (issues) following the repo's `auto:alert` pattern.
 *
 * Fingerprint convention:
 *   alert-<sha256(env|alertname|scope)>
 * where `scope` is the most discriminating label from the alert
 * (task_queue, component, schedule_id, or "global").
 *
 * A matching open issue is updated (comment + labels refreshed); a new issue is
 * created only when no open issue with that fingerprint already exists.
 *
 * Usage (CLI):
 *   npx tsx src/alert-incident-bridge.ts --payload '<alertmanager-json>'
 *
 * Environment variables required for GitHub API calls:
 *   GH_TOKEN            — GitHub token with issues:write permission
 *   GITHUB_REPOSITORY   — owner/repo (e.g. Volaris-AI/dia)
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Alertmanager payload types
// ---------------------------------------------------------------------------

export interface AlertmanagerAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
  fingerprint?: string;
}

export interface AlertmanagerPayload {
  version: string;
  groupKey: string;
  truncatedAlerts: number;
  status: "firing" | "resolved";
  receiver: string;
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
  externalURL: string;
  alerts: AlertmanagerAlert[];
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Derive a stable scope key from the alert's labels.
 * Preference order: task_queue → schedule_id → component → "global".
 */
export function alertScope(labels: Record<string, string>): string {
  return (
    labels["task_queue"] ??
    labels["schedule_id"] ??
    labels["component"] ??
    "global"
  );
}

/**
 * Build a deduplicated fingerprint id for a single alert.
 * Format: `alert-<12-char-sha256>` where the hash input is
 * `<env>|<alertname>|<scope>`.
 */
export function buildAlertFingerprint(alert: AlertmanagerAlert): string {
  const env = alert.labels["env"] ?? alert.labels["namespace"] ?? "unknown";
  const alertname = alert.labels["alertname"] ?? "unknown";
  const scope = alertScope(alert.labels);
  const hash = createHash("sha256")
    .update([env, alertname, scope].join("|"))
    .digest("hex")
    .slice(0, 12);
  return `alert-${hash}`;
}

/** HTML comment marker embedded in every managed issue body for searching. */
export function fingerprintComment(id: string): string {
  return `<!-- fingerprint:${id} -->`;
}

/** Search token used when querying the GitHub issue list for an existing issue. */
export function fingerprintSearchToken(id: string): string {
  return `fingerprint:${id}`;
}

// ---------------------------------------------------------------------------
// Issue body builder
// ---------------------------------------------------------------------------

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  warning: "🟡",
  info: "🔵",
};

/**
 * Build the full GitHub issue body for a firing alert.
 * Includes the fingerprint comment so future searches can locate it.
 */
export function buildIssueBody(
  alert: AlertmanagerAlert,
  fingerprintId: string
): string {
  const severity = alert.labels["severity"] ?? "warning";
  const emoji = SEVERITY_EMOJI[severity] ?? "⚠️";
  const summary =
    alert.annotations["summary"] ??
    alert.labels["alertname"] ??
    "Prometheus alert fired";
  const description = alert.annotations["description"] ?? "";
  const runbook = alert.annotations["runbook"] ?? "";
  const env = alert.labels["env"] ?? alert.labels["namespace"] ?? "unknown";
  const component = alert.labels["component"] ?? "";
  const scope = alertScope(alert.labels);

  const lines: string[] = [
    `${emoji} **${summary}**`,
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| **Alert** | \`${alert.labels["alertname"] ?? "unknown"}\` |`,
    `| **Severity** | \`${severity}\` |`,
    `| **Environment** | \`${env}\` |`,
    ...(component ? [`| **Component** | \`${component}\` |`] : []),
    `| **Scope** | \`${scope}\` |`,
    `| **Status** | \`${alert.status}\` |`,
    `| **Started** | ${alert.startsAt} |`,
    "",
  ];

  if (description) {
    lines.push("### Description", "", description, "");
  }

  if (runbook) {
    lines.push("### First recovery step", "", runbook, "");
  }

  lines.push(
    "### Labels",
    "",
    "```",
    Object.entries(alert.labels)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    "```",
    "",
    "---",
    "",
    `_Managed by the Prometheus → incident bridge. Fingerprint: \`${fingerprintId}\`_`,
    "",
    fingerprintComment(fingerprintId)
  );

  return lines.join("\n");
}

/**
 * Build the title for a GitHub incident issue.
 */
export function buildIssueTitle(alert: AlertmanagerAlert): string {
  const env = alert.labels["env"] ?? alert.labels["namespace"] ?? "unknown";
  const alertname = alert.labels["alertname"] ?? "alert";
  const scope = alertScope(alert.labels);
  const severity = alert.labels["severity"] ?? "warning";
  const prefix = severity === "critical" ? "🔴" : "🟡";
  return `${prefix} [${env}] ${alertname} — ${scope}`;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
}

export interface GitHubApiClient {
  searchIssues(
    owner: string,
    repo: string,
    searchToken: string
  ): Promise<GitHubIssue[]>;
  createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels: string[]
  ): Promise<GitHubIssue>;
  updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
    state?: "open" | "closed"
  ): Promise<GitHubIssue>;
  addIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    comment: string
  ): Promise<void>;
}

/** Labels applied to every managed incident. */
export const INCIDENT_LABELS = ["auto:alert", "queue:ops"];

// ---------------------------------------------------------------------------
// Core bridge logic
// ---------------------------------------------------------------------------

export interface BridgeResult {
  fingerprintId: string;
  action: "created" | "updated" | "resolved" | "skipped";
  issueNumber?: number;
  issueUrl?: string;
}

/**
 * Process a single Alertmanager alert and create or update the corresponding
 * deduplicated GitHub incident.
 */
export async function processAlert(
  alert: AlertmanagerAlert,
  owner: string,
  repo: string,
  api: GitHubApiClient
): Promise<BridgeResult> {
  const fingerprintId = buildAlertFingerprint(alert);
  const searchToken = fingerprintSearchToken(fingerprintId);

  const existing = await api.searchIssues(owner, repo, searchToken);
  const openIssue = existing.find((i) => i.state === "open");

  if (alert.status === "resolved") {
    if (!openIssue) {
      return { fingerprintId, action: "skipped" };
    }
    const resolvedComment = [
      "✅ **Alert resolved**",
      "",
      `Alert \`${alert.labels["alertname"]}\` returned to normal at ${alert.endsAt}.`,
      "",
      "_This incident can be closed once recovery is confirmed._",
    ].join("\n");
    await api.addIssueComment(owner, repo, openIssue.number, resolvedComment);
    return {
      fingerprintId,
      action: "resolved",
      issueNumber: openIssue.number,
      issueUrl: openIssue.html_url,
    };
  }

  // Firing alert
  const title = buildIssueTitle(alert);
  const body = buildIssueBody(alert, fingerprintId);

  if (openIssue) {
    // Update existing issue: refresh body and add a comment noting the repeat.
    await api.updateIssue(owner, repo, openIssue.number, body);
    const repeatComment = [
      "🔁 **Alert still firing**",
      "",
      `Re-notification at ${alert.startsAt} — alert \`${alert.labels["alertname"]}\` is still active.`,
      "",
      "_Body updated above with latest labels and annotations._",
    ].join("\n");
    await api.addIssueComment(owner, repo, openIssue.number, repeatComment);
    return {
      fingerprintId,
      action: "updated",
      issueNumber: openIssue.number,
      issueUrl: openIssue.html_url,
    };
  }

  // No open issue found — create a new incident.
  const created = await api.createIssue(
    owner,
    repo,
    title,
    body,
    INCIDENT_LABELS
  );
  return {
    fingerprintId,
    action: "created",
    issueNumber: created.number,
    issueUrl: created.html_url,
  };
}

/**
 * Process a full Alertmanager webhook payload, handling each alert independently.
 * Returns one BridgeResult per alert in the payload.
 */
export async function processPayload(
  payload: AlertmanagerPayload,
  owner: string,
  repo: string,
  api: GitHubApiClient
): Promise<BridgeResult[]> {
  const results: BridgeResult[] = [];
  for (const alert of payload.alerts) {
    const result = await processAlert(alert, owner, repo, api);
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const token = process.env["GH_TOKEN"];
  if (!token) {
    console.error("GH_TOKEN environment variable is required");
    process.exit(1);
  }

  const repository = process.env["GITHUB_REPOSITORY"] ?? "";
  const [owner = "", repo = ""] = repository.split("/");
  if (!owner || !repo) {
    console.error("GITHUB_REPOSITORY must be set to owner/repo");
    process.exit(1);
  }

  const payloadArg = process.argv.indexOf("--payload");
  if (payloadArg === -1 || !process.argv[payloadArg + 1]) {
    console.error("Usage: alert-incident-bridge.ts --payload '<alertmanager-json>'");
    process.exit(1);
  }

  let payload: AlertmanagerPayload;
  try {
    payload = JSON.parse(process.argv[payloadArg + 1]!) as AlertmanagerPayload;
  } catch {
    console.error("Failed to parse --payload as JSON");
    process.exit(1);
  }

  // Build a real GitHub API client using the gh CLI for simplicity.
  const { createGitHubApiClient } = await import("./alert-github-client.js");
  const api = createGitHubApiClient(token);

  const results = await processPayload(payload, owner, repo, api);
  for (const r of results) {
    console.log(
      `${r.action.toUpperCase()} fp=${r.fingerprintId}${r.issueNumber ? ` issue=#${r.issueNumber}` : ""}`
    );
  }
}

if (
  process.argv[1] &&
  new URL(import.meta.url).pathname === process.argv[1]
) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
