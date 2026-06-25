# ADR-0048: Dedicated CI gate for maintenance analytics migration reset-path validation

- **Status:** Accepted
- **Date:** 2026-06-12
- **Deciders:** Tech Reviewer
- **Supersedes / Superseded by:** -

## Context

PR #1044 merged `20260610100000_maintenance_service_history_analytics.sql`, which adds three
`security_invoker = true` views (`v_asset_service_history`, `v_asset_downtime_analytics`,
`v_asset_category_downtime_summary`) and the `v_asset_active_down_state` pool-restoration view.

The migration was merged without a `supabase db reset` guardrail, leaving the reset path unvalidated
in CI. Subsequent reset-path failures in this domain would be silent until a developer ran a local
reset and discovered breakage.

The repository's established pattern (introduced with earlier supabase reset jobs in
`pr-validation.yml`) is to add a dedicated per-domain job that runs `supabase db reset` plus SQL
assertions whenever a migration domain is large enough to carry its own view/function contract.

## Decision

We add a dedicated `supabase-maintenance-analytics-reset` job to `pr-validation.yml` that:

1. Installs the Supabase CLI (using `GITHUB_TOKEN` to avoid unauthenticated rate-limit failures on
   shared runners).
2. Runs `bash supabase/tests/run_maintenance_service_history_analytics_reset.sh`, which executes a
   full `supabase db reset` followed by `psql` assertions wrapped in `BEGIN … ROLLBACK`.
3. Is wired into `validation-summary` so that reset failures block PR merges.

The SQL assertions cover: view `security_invoker` declarations, non-zero downtime aggregates, and
explicit pool-restoration behaviour (setting `completed_at` on a hard-down maintenance record
removes the asset from `v_asset_active_down_state`).

## Consequences

- Every future PR that touches the maintenance analytics migration or its views must keep the reset
  path green before merging.
- The CI matrix grows by one job, adding approximately two minutes to the total PR validation time.
- The pool-restoration assertion is self-contained (inserts its own fixture data and rolls it back),
  so it does not alter the demo seed state.

## Alternatives considered

- **Inline the assertions into the existing `supabase-seed` job:** rejected because that job only
  verifies the seed loads; it does not exercise domain-specific view contracts or pool-restoration
  semantics.
- **No separate CI job; rely on local developer resets:** rejected because unvalidated migrations
  accumulate silently and reset failures are not caught until after merge.

## Evidence

- `.github/workflows/pr-validation.yml` — `supabase-maintenance-analytics-reset` job and
  `validation-summary` dependency
- `supabase/tests/maintenance_service_history_analytics.sql` — SQL assertions
- `supabase/tests/run_maintenance_service_history_analytics_reset.sh` — reset driver
- `supabase/migrations/20260610100000_maintenance_service_history_analytics.sql` — migration under
  test
