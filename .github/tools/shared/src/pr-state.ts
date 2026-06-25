/**
 * pr-state.ts — the per-PR stuck ledger.
 *
 * Per-PR agent sessions are deliberately fresh (no ballooning context), which
 * means the agent cannot know "this PR has been in the same state for N
 * passes — my predecessors' actions changed nothing". Without that memory,
 * every "if stuck, escalate" rule is unenforceable, and wedged PRs only ever
 * get rescued by a human noticing (#848 burned five identical review rounds
 * before one did).
 *
 * The ledger closes the loop deterministically:
 *   - computeStateFingerprint(snapshot) reduces a PR to the fields that mean
 *     "real progress" when they change. Commit identity is deliberately
 *     EXCLUDED: the CI re-trigger pre-pass pushes empty commits, and counting
 *     those as progress would reset the ledger every sweep. CI state, draft
 *     state, mergeability, review state, and labels move whenever anything
 *     real happens.
 *   - The orchestrator persists {fingerprint, count, at} in a hidden marker
 *     comment on the PR (the agent never writes it), increments `count` when
 *     the fingerprint is unchanged since last pass, and injects the count
 *     into the per-PR session prompt so the agent can apply the escalation
 *     ladder (project-manager.agent.md branch 8) with real data.
 *
 * Everything here is pure; the gh side-effects live in run-pr-pipeline.ts.
 */

import type { PrSnapshot } from "./pr-snapshot.js";

export const STATE_MARKER_PREFIX = "<!-- factory-pr-state:v1:";
export const STATE_MARKER_SUFFIX = "-->";

export interface PrStateLedger {
  /** Fingerprint of the PR state the last time the loop saw it. */
  fingerprint: string;
  /** Consecutive passes (including that one) the PR has shown this fingerprint. */
  count: number;
  /** ISO timestamp of the pass that wrote the marker. */
  at: string;
}

/**
 * Reduce a snapshot to the fields whose change means real progress.
 * Deliberately excludes commit SHAs/timestamps (re-trigger commits are not
 * progress) and updatedAt (any comment touches it).
 */
export function computeStateFingerprint(pr: PrSnapshot): string {
  return [
    pr.isDraft ? "draft" : "ready",
    pr.mergeable,
    pr.ciState ?? "NO_CI",
    pr.checks.length > 0 ? "checks" : "no-checks",
    pr.approved ? "approved" : pr.changesRequested ? (pr.reviewSuperseded ? "cr-superseded" : "cr-standing") : "unreviewed",
    [...pr.labels].sort().join(","),
  ].join("|");
}

/** Render the ledger as the hidden marker comment body. */
export function formatStateMarker(ledger: PrStateLedger): string {
  return `${STATE_MARKER_PREFIX}${JSON.stringify(ledger)}${STATE_MARKER_SUFFIX}`;
}

/** Parse a ledger from a comment body; null when absent or malformed. */
export function parseStateMarker(body: string): PrStateLedger | null {
  const start = body.indexOf(STATE_MARKER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf(STATE_MARKER_SUFFIX, start);
  if (end === -1) return null;
  const json = body.slice(start + STATE_MARKER_PREFIX.length, end).trim();
  try {
    const parsed = JSON.parse(json) as Partial<PrStateLedger>;
    if (typeof parsed.fingerprint !== "string" || typeof parsed.count !== "number") return null;
    return {
      fingerprint: parsed.fingerprint,
      count: Math.max(1, Math.floor(parsed.count)),
      at: typeof parsed.at === "string" ? parsed.at : "",
    };
  } catch {
    return null;
  }
}

/**
 * Advance the ledger for this pass: same fingerprint as last pass → count+1,
 * anything else (including no prior marker) → count 1.
 */
export function advanceLedger(
  prior: PrStateLedger | null,
  currentFingerprint: string,
  nowIso: string
): PrStateLedger {
  const count = prior && prior.fingerprint === currentFingerprint ? prior.count + 1 : 1;
  return { fingerprint: currentFingerprint, count, at: nowIso };
}

/**
 * The stuck threshold: from this many consecutive identical passes onward,
 * the per-PR prompt carries an explicit escalation instruction. 2 = "the
 * previous pass changed nothing"; 3+ passes ≈ 1.5h+ of zero movement at the
 * 30-min loop cadence.
 */
export const STUCK_THRESHOLD = 3;

/** Build the escalation block injected into the per-PR session prompt. */
export function buildStuckNotice(ledger: PrStateLedger): string | null {
  if (ledger.count < STUCK_THRESHOLD) return null;
  return [
    `⚠️ STUCK LEDGER: this PR's state fingerprint has been IDENTICAL for ${ledger.count} consecutive loop passes.`,
    `Previous sessions' actions (nudges, re-triggers, routing) have NOT moved it.`,
    `Do not repeat an action that has already failed — apply the escalation ladder (branch 8 of your decision tree):`,
    `diagnose WHY it is stuck, take the next-rung action, and if you are at the end of the ladder, re-kick or raise the deduped factory-stuck incident.`,
    ``,
    `INCIDENT CLASSIFICATION RULE (mandatory before filing any incident):`,
    `  1. Classify the blocker as pr-local or shared-cause before creating any issue.`,
    `  2. shared-cause: the CI check that is blocking this PR (e.g. "PR Validation",`,
    `     "Temporal worker tests") is failing for ALL open PRs — it is a platform/infra`,
    `     outage. Use buildSharedCauseFingerprint(failureClass, scope) from`,
    `     .github/tools/shared/src/incident-upsert.ts and call upsertIncident with`,
    `     kind "shared-cause". Labels: auto:alert + queue:platform. Do NOT open a`,
    `     queue:development issue — that fragments ownership during a shared outage.`,
    `  3. pr-local: the blocker is specific to this PR branch after the escalation`,
    `     ladder is exhausted. Use buildPrLocalFingerprint(prNumber) and call`,
    `     upsertIncident with kind "pr-local". Labels: factory-stuck + auto:alert + priority:high.`,
    `  4. Both paths use upsertIncident — it deduplicates by fingerprint body marker so`,
    `     a second filing updates the existing open issue rather than creating a duplicate.`,
    `  5. RUNTIME: invoke via the CLI wrapper (no manual gh issue create/list):`,
    `     npx tsx .github/tools/shared/src/incident-upsert-cli.ts \\`,
    `       --kind pr-local --pr-number <N> --title "<title>" --body "<body>"`,
    `     or for shared-cause:`,
    `     npx tsx .github/tools/shared/src/incident-upsert-cli.ts \\`,
    `       --kind shared-cause --failure-class <class> --scope "<scope>" --title "<title>" --body "<body>"`,
  ].join("\n");
}
