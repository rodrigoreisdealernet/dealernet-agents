/**
 * incident-upsert.ts
 *
 * Shared incident create-or-update (upsert) helper for the factory.
 *
 * ## PR-local vs shared-cause classification
 *
 * Every stuck-incident emission must be classified before filing:
 *
 *   pr-local    — the blocker is specific to one PR branch/head state after
 *                 the escalation ladder is exhausted (e.g. a code-review cycle
 *                 that only affects that branch). Fingerprint shape:
 *                 `factory-stuck-pr-<number>`. Labels: `factory-stuck`.
 *
 *   shared-cause — the blocker is a CI/infrastructure failure that can affect
 *                  multiple PRs simultaneously (e.g. PR Validation hanging on
 *                  Temporal worker tests, a wedged workflow, Actions approval
 *                  gate blocked, deploy or e2e outage). Fingerprint shape:
 *                  `shared-cause-<12-char-sha256>` keyed on failure-class +
 *                  scope — NOT PR number, commit SHA, or run URL. Labels:
 *                  `auto:alert`, `queue:platform`.
 *
 * ## Deduplication primitive
 *
 * Fingerprint HTML comments (`<!-- fingerprint:<id> -->`) embedded in the
 * issue body are the canonical dedup primitive. Issue list searches include
 * the raw marker text so relabeled or renamed issues are still matched even
 * when GitHub search index is stale.
 *
 * ## Usage
 *
 *   import { classifyIncident, buildSharedCauseFingerprint,
 *            buildPrLocalFingerprint, upsertIncident } from "./incident-upsert.js";
 *
 *   const kind = classifyIncident({ failureClass: "pr-validation" });
 *   const fp   = kind === "shared-cause"
 *     ? buildSharedCauseFingerprint("pr-validation", "temporal-worker-tests")
 *     : buildPrLocalFingerprint(prNumber);
 *   await upsertIncident({ kind, fingerprintId: fp, title, body }, owner, repo, api);
 */

import { fingerprintId, fingerprintComment, fingerprintSearchToken } from "./dedupe.js";
import type { GitHubApiClient, GitHubIssue } from "./alert-incident-bridge.js";

// ---------------------------------------------------------------------------
// Incident kind
// ---------------------------------------------------------------------------

/**
 * `pr-local`    — blocker is specific to one PR after escalation exhausted.
 * `shared-cause` — CI/infra failure that can affect multiple PRs.
 */
export type IncidentKind = "pr-local" | "shared-cause";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The set of failure classes that are shared-cause by definition — they
 * affect all PRs being validated, not one branch in isolation.
 */
export const SHARED_CAUSE_FAILURE_CLASSES = new Set<string>([
  "pr-validation",
  "temporal-worker-tests",
  "ci-approval-gate",
  "workflow-sentinel",
  "deploy",
  "e2e",
  "bootstrap-rbac",
]);

/**
 * The set of CI check / workflow names whose failures should always be
 * treated as shared-cause.
 */
export const SHARED_CAUSE_CHECK_NAMES = new Set<string>([
  "PR Validation",
  "Temporal worker tests",
  "shared-tools",
  "Shared tools regression suite",
  "Frontend lint & build",
  "Helm chart validation",
]);

export interface ClassifyOptions {
  /**
   * Structured failure-class from the caller's context.
   * E.g. "pr-validation", "temporal-worker-tests", "deploy", "e2e".
   * When set and in SHARED_CAUSE_FAILURE_CLASSES, the incident is shared-cause.
   */
  failureClass?: string;
  /**
   * Raw CI check / workflow display name.
   * When set and in SHARED_CAUSE_CHECK_NAMES, the incident is shared-cause.
   */
  checkName?: string;
  /**
   * True when the call originates from a workflow sentinel (e2e-dev.yml,
   * deploy-dev.yml, etc.) rather than a per-PR agent session.
   * Workflow sentinels always produce shared-cause incidents.
   */
  fromWorkflowSentinel?: boolean;
}

/**
 * Classify an incident as pr-local or shared-cause based on explicit,
 * testable criteria. Returns "pr-local" by default for unclassified inputs.
 */
export function classifyIncident(opts: ClassifyOptions): IncidentKind {
  if (opts.fromWorkflowSentinel) return "shared-cause";
  if (opts.failureClass && SHARED_CAUSE_FAILURE_CLASSES.has(opts.failureClass)) {
    return "shared-cause";
  }
  if (opts.checkName && SHARED_CAUSE_CHECK_NAMES.has(opts.checkName)) {
    return "shared-cause";
  }
  return "pr-local";
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Build a stable, low-cardinality shared-cause fingerprint.
 *
 * Inputs MUST be stable across PR runs — do NOT include PR number, commit
 * SHA, run ID, or run URL. Use the failure-class and scope (e.g. the
 * workflow job name or failing check name) which remain constant across runs.
 *
 * Returns an id of shape `shared-cause-<12-char-sha256>`.
 */
export function buildSharedCauseFingerprint(
  failureClass: string,
  scope: string
): string {
  return fingerprintId("shared-cause", [failureClass, scope]);
}

/**
 * Build the PR-local terminal incident fingerprint.
 * Shape: `factory-stuck-pr-<number>`.
 * This form is intentionally high-cardinality: each PR gets its own incident.
 */
export function buildPrLocalFingerprint(prNumber: number): string {
  return `factory-stuck-pr-${prNumber}`;
}

// ---------------------------------------------------------------------------
// Label routing
// ---------------------------------------------------------------------------

/** Labels applied to shared-cause incidents (platform-owned CI blockers). */
export const SHARED_CAUSE_LABELS = ["auto:alert", "queue:platform"];

/** Labels applied to PR-local terminal stuck incidents. */
export const PR_LOCAL_LABELS = ["factory-stuck", "auto:alert", "priority:high"];

/**
 * Return the default label set for a given incident kind.
 * Callers may append extra labels; these are never removed.
 */
export function defaultLabelsForKind(kind: IncidentKind): string[] {
  return kind === "shared-cause" ? [...SHARED_CAUSE_LABELS] : [...PR_LOCAL_LABELS];
}

// ---------------------------------------------------------------------------
// Upsert logic
// ---------------------------------------------------------------------------

export interface IncidentUpsertParams {
  /** Classification — controls fingerprint shape and label routing. */
  kind: IncidentKind;
  /**
   * Canonical fingerprint id. Build with buildSharedCauseFingerprint() for
   * shared-cause or buildPrLocalFingerprint() for pr-local incidents.
   */
  fingerprintId: string;
  /** Issue title. */
  title: string;
  /** Issue body. Must NOT already include the fingerprint comment — it is appended automatically. */
  body: string;
  /** Additional labels to append beyond the default routing labels. */
  extraLabels?: string[];
}

export interface UpsertResult {
  fingerprintId: string;
  action: "created" | "updated";
  issueNumber: number;
  issueUrl: string;
}

/**
 * Append the fingerprint comment to an issue body.
 * Idempotent: if the comment is already present it is not duplicated.
 */
export function buildBodyWithFingerprint(body: string, fp: string): string {
  const marker = fingerprintComment(fp);
  if (body.includes(marker)) return body;
  return `${body}\n\n${marker}`;
}

/**
 * Upsert a factory incident issue:
 *   - Search for an existing open issue by fingerprint body marker.
 *   - If found: update body and add a re-notification comment.
 *   - If not found: create a new issue with the correct routing labels.
 *
 * This is the canonical create-or-update path; callers must NOT embed their
 * own `gh issue list`/`gh issue create` shell snippets for factory-stuck or
 * shared-cause incidents.
 */
export async function upsertIncident(
  params: IncidentUpsertParams,
  owner: string,
  repo: string,
  api: GitHubApiClient
): Promise<UpsertResult> {
  const { fingerprintId: fp, kind, title, body, extraLabels = [] } = params;
  const searchToken = fingerprintSearchToken(fp);
  const fullBody = buildBodyWithFingerprint(body, fp);

  const existing = await api.searchIssues(owner, repo, searchToken);
  // Prefer the oldest open issue to avoid forking onto a newly created duplicate.
  const openIssues = existing
    .filter((i: GitHubIssue) => i.state === "open")
    .sort((a: GitHubIssue, b: GitHubIssue) => a.number - b.number);
  const openIssue = openIssues[0];

  if (openIssue) {
    await api.updateIssue(owner, repo, openIssue.number, fullBody);
    const repeatComment = buildRepeatComment(fp, kind);
    await api.addIssueComment(owner, repo, openIssue.number, repeatComment);
    return {
      fingerprintId: fp,
      action: "updated",
      issueNumber: openIssue.number,
      issueUrl: openIssue.html_url,
    };
  }

  const labels = [...defaultLabelsForKind(kind), ...extraLabels];
  const created = await api.createIssue(owner, repo, title, fullBody, labels);
  return {
    fingerprintId: fp,
    action: "created",
    issueNumber: created.number,
    issueUrl: created.html_url,
  };
}

/** Build the repeat-notification comment body. */
function buildRepeatComment(fp: string, kind: IncidentKind): string {
  const kindLabel = kind === "shared-cause" ? "Shared CI blocker still active" : "PR still stuck";
  return [
    `🔁 **${kindLabel}**`,
    "",
    `Incident fingerprint \`${fp}\` recurred — body updated above.`,
    "",
    "_This issue was found by fingerprint body marker so relabeling will not lose track of it._",
  ].join("\n");
}
