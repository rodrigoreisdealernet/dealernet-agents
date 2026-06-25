# ADR-0084: Quote-gate conversion ACL + status-gate reset-path validation is a required PR gate (DB-surface scoped)

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Copilot (PR #1843 follow-up)
- **Supersedes / Superseded by:** none

## Context

PR #1843 merged `supabase/migrations/20260615191000_quote_conversion_require_quote_gate.sql`,
which adds:

- `convert_quote_to_reservation(...)` — RPC that converts a quoted order to a
  reservation, enforcing:
  - An ACL hardening step: `REVOKE ALL ON FUNCTION … FROM PUBLIC` (stronger
    than the previous `REVOKE EXECUTE FROM PUBLIC, anon`) before explicit
    grants to `authenticated` and `service_role`.
  - A status gate: the order must be in `quoted` or `approved` status;
    `draft` orders are rejected with
    `order_not_ready_for_conversion / Order must be in quoted or approved status before conversion`.

The migration shipped without a `supabase db reset` guardrail.  A regression
in an earlier migration — or a change to the entity/relationship core tables,
the `rental_current_entity_state` materialisation, or the tenant seed data —
could silently break the ACL hardening or status gate on a fresh rebuild while
leaving already-evolved development databases unaffected.

### Control-plane boundary

`pr-validation.yml` is a hot shared file; every addition to
`validation-summary.needs` serialises that job and extends the wall-clock
required-check time for every subsequent PR.  The decision to add directly to
`pr-validation.yml` rather than a separate workflow file is deliberate:

1. **Visibility and required-check enforcement** — GitHub branch protection
   can only gate on named jobs within a workflow that runs on `pull_request`.
   A separate workflow file produces a separate check run that requires an
   additional branch-protection entry; adding to the existing required workflow
   is operationally simpler and consistent with all previous reset-path gates
   (ADR-0042 through ADR-0075).
2. **DB-surface path scoping** — Unlike earlier reset jobs that ran on every
   PR, this job introduces a `scope` step that computes a `git diff` between
   the PR base and head SHA.  The heavy `supabase db reset` is skipped when the
   PR touches neither `supabase/` nor `.github/workflows/pr-validation.yml`.
   On `push` to `main` (post-merge trunk validation) the full suite always
   runs.  This balances CI cost against coverage: frontend-only, Temporal-only,
   and docs-only PRs do not pay the ≈ 3–5 min Supabase reset penalty.
3. **Fail-closed on indeterminate diff** — If the git diff returns an empty
   file list (e.g. shallow clone or SHA resolution failure), the scope step
   defaults to `skip_reset=0` (run the suite) so coverage is never silently
   dropped.
4. **Drift mitigation** — The repo instructions require an ADR for every
   control-plane change (this document) and recommend keeping the PR small.
   This PR adds exactly one job block and one `needs` / summary-table entry.

### Permissions

The new job inherits the workflow-level read-only permissions (`contents: read`,
`pull-requests: read`) declared at the top of `pr-validation.yml`.  No
job-level `permissions:` override is added.  The `GITHUB_TOKEN` passed to
`supabase/setup-cli@v2` is used only to authenticate the GitHub Releases API
call that resolves the latest CLI version; it is not forwarded to the Supabase
process or the test harness.

## Decision

We add a `supabase-quote-conversion-gate-reset` job to `pr-validation.yml`
that:

1. Runs a `scope` step to compute whether the PR touches `supabase/` or
   `.github/workflows/pr-validation.yml`.
2. Skips the Supabase CLI install and the reset harness on PRs that touch
   neither path (emitting a SKIPPED summary line).
3. Runs `bash supabase/tests/run_quote_conversion_require_quote_gate_reset.sh`
   on DB-surface PRs and unconditionally on `push` to `main`.
4. Wires the job result into the `validation-summary` required gate.

The SQL harness
(`supabase/tests/quote_conversion_require_quote_gate_reset.sql`) confirms
after a clean reset that:

1. `PUBLIC` pseudo-role has no `EXECUTE` privilege after the `REVOKE ALL …
   FROM PUBLIC` hardening step.
2. `anon` is denied at runtime; `authenticated` and `service_role` hold
   `EXECUTE`.
3. A `draft`-status order is blocked: `success = false`,
   `conflicts[0].reason = 'order_not_ready_for_conversion'`, and the exact
   gate message is asserted.
4. `quoted`-status and `approved`-status orders both convert successfully.
5. Idempotent re-conversion returns `success = true`, the same reservation ID,
   and zero conflicts.

The CI job uses `actions/checkout@v6` (with `fetch-depth: 0` for diff
computation) and `supabase/setup-cli@v2` — the current trusted baseline —
with `github-token: ${{ secrets.GITHUB_TOKEN }}` to avoid the 60-req/hr
anonymous GitHub API rate limit on shared runners.

## Consequences

- **Easier:** reset-path regressions in the quote-gate ACL hardening and
  status gate are caught before merge, giving reviewers automated evidence
  that the full migration chain + seed survive a fresh rebuild.
- **Cost control:** frontend-only, Temporal-only, and docs-only PRs skip the
  ≈ 3–5 min reset penalty.  DB-surface PRs pay the cost as expected.
- **`pr-validation.yml` drift (issue #58):** every PR that modifies this file
  carries merge-conflict risk with concurrent PRs.  Keeping the change minimal
  (one job block + one `needs` entry + one summary-table `echo`) reduces the
  conflict surface.
- **Rollback:** if the reset harness proves consistently flaky, the job can be
  temporarily removed from `validation-summary.needs` to make it non-blocking
  while the flakiness is investigated.  Full removal requires a follow-up PR
  and a superseding ADR update to this record.
- **Obligation:** future migrations that alter `convert_quote_to_reservation`,
  the ACL grants/revokes, or the order status enumeration must keep the reset
  assertions passing or update them to match the new landscape.

## Alternatives considered

- **Always-on (no path scoping)** — rejected; adds ≈ 3–5 min to every PR
  regardless of whether DB-surface files changed.  The `temporal` job's
  scoping pattern (ADR-0066) demonstrates that path-gated skipping is the
  established approach for heavy Supabase reset lanes.
- **Skip CI, rely on manual reset check** — rejected; no automatic regression
  signal means reset-path drift is undetected until a developer rebuilds from
  scratch.
- **Separate workflow file** — rejected; requires a separate branch-protection
  entry, increases workflow file sprawl, and is inconsistent with all previous
  reset-path CI gates (ADR-0042 through ADR-0075).
- **Fold into the existing focused-fixture harness** — rejected; the
  Docker-based fixture harness runs against a bare Postgres container that
  applies migrations but does not execute `seed.sql`, so tenant seed data and
  the entity/relationship core materialisation cannot be exercised end-to-end.
- **Unauthenticated Supabase CLI install** — rejected; the shared-runner IP
  pool exhausts the GitHub API anonymous rate limit at moderate PR volume,
  causing non-deterministic red gates.

## Evidence

- Migration: `supabase/migrations/20260615191000_quote_conversion_require_quote_gate.sql`
- Reset SQL: `supabase/tests/quote_conversion_require_quote_gate_reset.sql`
- Runner: `supabase/tests/run_quote_conversion_require_quote_gate_reset.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-quote-conversion-gate-reset`
- Merged PR (migration): #1843
- Related ADR (temporal scoping pattern): ADR-0066
- Related issue (drift guard): #58
