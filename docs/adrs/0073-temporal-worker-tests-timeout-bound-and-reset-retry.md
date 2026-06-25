# ADR-0073: Bound Temporal worker test runtime and absorb transient reset port conflicts

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** Tech Reviewer via PR #1696
- **Supersedes / Superseded by:** None

## Context

The required `Temporal worker tests` job in `.github/workflows/pr-validation.yml` had a hard
timeout, but recent stuck-run incidents showed that the lane could still block PRs for too long
when a worker-test run wedged or when the Supabase reset path hit transient local startup errors.

PR #1696 makes three coupled control-plane changes to `.github/workflows/pr-validation.yml`:

1. it raises the `Temporal worker tests` job timeout from 75 to 90 minutes so the reset-heavy
   suite still has a real upper bound while allowing enough headroom for the slow end of the
   normal run distribution;
2. it treats `address already in use` as a transient Supabase startup failure in
   `supabase/tests/reset_validation_lib.sh`, so the reset path retries instead of failing
   immediately on a recoverable port-bind collision; and
3. it updates all GitHub Actions in the workflow from Node.js 20-based versions
   (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-python@v5`,
   `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `supabase/setup-cli@v1`) to
   Node.js 24-compatible versions (`@v6`, `@v6`, `@v6`, `@v6`, `@v7`, `@v2` respectively).
   GitHub deprecated the Node.js 20 action runtime on 2025-09-19 and began hard-enforcing Node.js
   24 as the runner default on 2026-06-16.

These changes sit on top of existing mitigations already present in the workflow, including stale
run cancellation and contract tests that assert the timeout remains bounded.

## Decision

We keep `Temporal worker tests` as a required PR-validation lane, bound it to 90 minutes, and
teach the reset helper to retry transient `address already in use` startup failures.  We also
upgrade all workflow actions to Node.js 24-compatible major versions in the same PR because
(a) this PR already edits the workflow, (b) the Architecture Audit flagged the deprecation, and
(c) the enforcement deadline (2026-06-16) falls during this PR's review cycle.

The 90-minute ceiling is intentionally high enough to cover the full Temporal suite plus reset and
container-recovery overhead, but still low enough to force a terminal failure instead of leaving a
required check hung for hours.

## Consequences

- PR validation keeps a real terminal bound for the Temporal lane even when a test or local
  service wedges.
- Transient port-binding collisions in the reset path become self-healing retries instead of
  noisy false failures.
- All workflow actions now run on Node.js 24, satisfying the GitHub deprecation policy without
  requiring a separate clean-up PR.
- The workflow timeout remains an operational contract: future increases above 90 minutes require
  a fresh ADR or justification because they weaken the "required checks converge" guarantee.
- The reset helper's transient-error regex now carries another reliability-sensitive branch, so the
  associated regression test must stay in place.

## Alternatives considered

- **Keep the 75-minute timeout:** rejected because it left too little margin for the slowest valid
  reset-heavy runs and encouraged repeated manual reruns instead of converging the lane.
- **Remove or greatly increase the timeout:** rejected because an effectively unbounded required
  check recreates the stuck-run failure mode this PR is fixing.
- **Fix only the port-conflict retry and leave the timeout unchanged:** rejected because retrying
  startup errors alone does not protect against genuinely hung test runs.
- **Defer the Node.js 24 action upgrades to a separate PR:** rejected because the enforcement
  deadline (2026-06-16) is immediate, this PR already edits the workflow (so the control-plane
  boundary is already crossed), and keeping the upgrade co-located with the ADR keeps the audit
  trail intact.

## Evidence

- Workflow: `.github/workflows/pr-validation.yml`
- Reset helper: `supabase/tests/reset_validation_lib.sh`
- Timeout contract test: `temporal/tests/test_pr_validation_workflow_contract.py`
- Reset retry regression test: `temporal/tests/test_reset_retry.py`
- GitHub Node.js 20 deprecation announcement: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
- PR: #1696
