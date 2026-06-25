# ADR-0061: ops_audit_trail_view RLS behavioral test CI gate

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** copilot / security review (PR #1556)
- **Supersedes / Superseded by:** none

## Context

PR #1556 adds `row_id` (`tsp.id`) to `public.ops_audit_trail_view` via a new
`CREATE OR REPLACE VIEW` migration so callers have a unique per-row identifier
for audit drill-down context preservation.  The view is an exposed read surface
declared with `WITH (security_invoker = true)`.  The security reviewer (ADR-0027
baseline) required behavioral proof that the replacement view still enforces the
underlying table RLS policies before clearing the data-access-boundary
checklist item.

A test script (`supabase/tests/run_ops_audit_trail_view_rls.sh`) was written
that spins up a throwaway Postgres container, applies all migrations in order,
and runs `supabase/tests/ops_audit_trail_view_rls.sql`.  That SQL asserts:

1. `security_invoker = true` is set on the view.
2. The `row_id` column is present and non-null for every row.
3. Under `SET LOCAL ROLE authenticated` + `set_config('request.jwt.claims',
   …)`, the view returns rows consistent with the `authenticated_read` policy
   on `time_series_points` (view count ≤ direct table count; fixture row
   visible; no null `row_id`s).

Without a CI gate the script ran only on demand, giving reviewers no automatic
regression signal.

## Decision

We add a `supabase-ops-audit-trail-view-rls` job to `pr-validation.yml` that
runs `bash supabase/tests/run_ops_audit_trail_view_rls.sh` on every PR, and
wire the result into the `validation-summary` gate.

## Consequences

- **Easier:** security reviewers have automated evidence that `WITH
  (security_invoker = true)` is in place and that the view's data-access
  boundary survives every migration replay.
- **Trade-off:** one additional Docker-based job (≈ 60–90 s) per PR run; this
  is consistent with the existing `supabase-rpc-guards` job which follows the
  same pattern.
- **Obligation:** future migrations that touch `ops_audit_trail_view` must keep
  the test passing or update it to match the new column set/policy landscape.

## Alternatives considered

- **Skip CI and rely on manual run** — rejected; no automatic regression
  signal and security review cannot clear without automated evidence.
- **Use Supabase CLI reset harness** — the CLI harness applies migrations via
  `supabase db reset` and is suitable for schema-level checks.  The RLS
  behavioral test requires `SET LOCAL ROLE` and `set_config(…)` which work in
  plain Postgres but may not in the local Supabase emulator.  The bare Postgres
  container approach is already used by `supabase-rpc-guards` for the same
  reason.

## Evidence

- Migration: `supabase/migrations/20260614000000_ops_audit_trail_view_row_id.sql`
- Test SQL: `supabase/tests/ops_audit_trail_view_rls.sql`
- Run script: `supabase/tests/run_ops_audit_trail_view_rls.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-ops-audit-trail-view-rls`
- PR: #1556
