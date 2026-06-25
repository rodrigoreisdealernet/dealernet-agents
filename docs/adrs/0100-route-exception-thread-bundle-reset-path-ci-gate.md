# ADR-0100: Route exception thread bundle reset-path CI gate

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Copilot coding agent (PR #2110)
- **Supersedes / Superseded by:** none

## Context

PR #1943 merged `20260617001500_route_exception_thread_bundle.sql`, which adds:

- A partial index `idx_route_stop_exceptions_open_thread` for open-thread lookups.
- A `submit_stop_exception` RPC that collapses repeated same-stop/same-type
  submissions into a single unresolved thread (advisory lock serialisation,
  photo-path deduplication, ETA-delay validation).
- A `v_route_exception_review_bundle` view that packages operational context
  (stop, route, exception, evidence bundle jsonb) into a single projection for
  dispatch and branch handoff.

No reset-path test was added alongside the migration, leaving four behavioural
guarantees unguarded against clean-rebuild regressions:

1. Thread-collapse semantics: repeated submissions must fold into one unresolved
   row, not fork siblings.
2. Evidence merging: `photo_paths` must be deduplicated and merged in original
   order across update calls.
3. ETA-delay validation: `estimated_delay_minutes ≤ 0` must be rejected for
   `eta_delay` exceptions; positive values must persist correctly.
4. View projection: `v_route_exception_review_bundle` must expose all scalar
   fields and a well-structured `evidence_bundle` jsonb after every reset.

## Decision

We add a `supabase-route-exception-thread-bundle-reset` job to `pr-validation.yml`.
The job:

1. Checks out the repository and installs the Supabase CLI via
   `supabase/setup-cli@v2` (with `github-token` to avoid the 60-req/hr
   unauthenticated rate limit under high PR volume).
2. Runs `bash supabase/tests/run_route_exception_thread_bundle_reset.sh`, which
   calls `run_supabase_start_with_transient_retry` + `run_supabase_reset_with_transient_retry`
   (both with 6-attempt budgets) then executes
   `supabase/tests/route_exception_thread_bundle_reset.sql` via `psql`.
3. The SQL file is wrapped in `begin`/`rollback` so no fixture data persists
   after the assertions run.

The job is added to `validation-summary.needs` and the step summary table so a
failure surfaces as a required-gate signal on every PR.

The timeout is 20 minutes, consistent with all other Supabase CLI reset-path
jobs (see ADR-0075).

## Consequences

- **Easier:** reviewers have automated evidence that the thread-bundle migration
  survives a full `supabase db reset` replay after every subsequent migration is
  added, preventing silent regressions in thread-collapse, evidence-merge, or
  view-projection logic.
- **Trade-off:** one additional Supabase CLI reset job (≈ 10–18 min) per PR run.
  The 20-minute timeout caps cost at the same ceiling as existing reset-path
  gates.
- **Obligation:** future migrations that alter `route_stop_exceptions`,
  `submit_stop_exception`, or `v_route_exception_review_bundle` must keep the
  assertions in `route_exception_thread_bundle_reset.sql` passing or update
  them accordingly.
- **Rollback:** if the job proves consistently flaky it can be removed from
  `validation-summary.needs` to become non-blocking while the flakiness is
  investigated; the job definition itself should remain in the workflow so the
  assertions continue to run and report.

## Alternatives considered

- **Skip the reset-path gate entirely** — rejected because the advisory-lock
  serialisation and array-deduplication logic in `submit_stop_exception` are
  non-trivial; silent breakage under reset would not be caught by the
  unit-level RLS tests.
- **Use a throwaway Docker container (no Supabase CLI)** — the test SQL
  requires `auth.uid()`, `public.ops_claim_app_role()`, and `set_config()`
  semantics that are only available in the full Supabase-local stack.
  A raw Postgres container cannot satisfy these dependencies without
  substantial harness rewriting, which is out of scope.
- **Make the SQL non-transactional** — rejected to avoid polluting the
  reset database with fixture rows that could interfere with other tests
  or seed-idempotency checks.

## Evidence

- Migration: `supabase/migrations/20260617001500_route_exception_thread_bundle.sql`
- Test SQL: `supabase/tests/route_exception_thread_bundle_reset.sql`
- Runner: `supabase/tests/run_route_exception_thread_bundle_reset.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-route-exception-thread-bundle-reset`
- Related ADRs: ADR-0075 (reset-path timeout guard), ADR-0083 (field-operator
  asset-write reset-path pattern), ADR-0091 (shop morning queue reset-path gate)
- PR: #2110
- Source migration PR: #1943
