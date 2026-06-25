# ADR-0068: Fleet idle-rebalancing reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** Tech Review, Platform, Copilot (PR #1482)
- **Supersedes / Superseded by:** none

## Context

PR #1414 merged `supabase/migrations/20260613060000_fleet_idle_rebalancing_view.sql`,
which creates `public.v_fleet_idle_rebalancing` — a `WITH (security_invoker = true)`
view that pairs idle-asset surplus branches with open-demand deficit branches
so operations can review and accept suggested transfer moves.

The PR shipped with RLS behavioral coverage (`fleet_idle_rebalancing_rls.sql`)
and frontend page/unit coverage, but without a clean-reset guard.  Issue #1482
identified the gap: there was no automated proof that the view survives a fresh
`supabase db reset --config supabase/config.toml` (migrations + seed rebuild)
and still returns recommendation rows with the branch/category context the UI
expects.

The risk is reset-path drift: the view's CTE logic joins several relationship
types (`branch_has_asset`, `asset_category_has_asset`) and filters on
`operational_status` and order-line `status` values that are seeded.  A
migration ordering problem, a missing seed step, or a future schema change
could silently break the surplus→deficit matching on a fresh rebuild while
leaving the already-evolved development database unaffected.

`supabase/tests/fleet_idle_rebalancing_reset.sql` was written to assert after
reset that:
1. `v_fleet_idle_rebalancing` exists in `pg_class` (migration applied cleanly).
2. At least one recommendation row is returned from the seeded demo data.
3. Every row carries full branch/category context (`surplus_branch_id/name`,
   `asset_category_id/name`, `deficit_branch_id/name`).
4. `suggested_transfer_qty > 0` on every row.
5. `suggested_transfer_qty ≤ idle_count` (supply cap).
6. `suggested_transfer_qty ≤ demand_gap` (demand cap).

`supabase/tests/run_fleet_idle_rebalancing_reset.sh` drives the check via the
shared `reset_validation_lib.sh` harness (transient-retry on Supabase start and
reset, duplicate-version staging, `--config` / `--yes` flag probing).

## Decision

We add a `supabase-fleet-idle-rebalancing-reset` job to `pr-validation.yml`
that runs `bash supabase/tests/run_fleet_idle_rebalancing_reset.sh` on every
PR, and wire the result into the `validation-summary` gate.

## Consequences

- **Easier:** reset-path regressions in the idle-fleet rebalancing view are
  caught before merge, giving reviewers automated evidence that the migration
  chain + seed still produces usable recommendation rows on a fresh schema.
- **Trade-off:** one additional Supabase CLI job (≈ 3–5 min including Docker
  pull + `supabase db reset`) per PR run.  This is consistent with the pattern
  established by ADR-0046 (`supabase-fleet-availability-calendar-reset`) and
  all subsequent `*-reset` jobs.
- **Obligation:** future migrations that alter `v_fleet_idle_rebalancing`, its
  dependent tables, or the seed data it relies on must keep the reset assertions
  passing or update them to match the new landscape.

## Alternatives considered

- **Skip CI, rely on manual reset check** — rejected; no automatic regression
  signal means reset-path drift is undetected until a developer rebuilds from
  scratch.
- **Fold into the existing fleet availability calendar reset job** — rejected;
  a dedicated gate keeps this contract explicit in the summary table and
  prevents a single failing assertion from obscuring unrelated fleet failures.
- **RLS-only coverage (existing `fleet_idle_rebalancing_rls.sql`)** — not
  sufficient on its own; the RLS script runs against a bare Postgres container
  that applies all migrations but does not run `seed.sql`.  The reset-path
  guard is needed to prove the view returns populated rows after the full
  migration + seed sequence that matches production deploys.

## Evidence

- Migration: `supabase/migrations/20260613060000_fleet_idle_rebalancing_view.sql`
- Test SQL: `supabase/tests/fleet_idle_rebalancing_reset.sql`
- Run script: `supabase/tests/run_fleet_idle_rebalancing_reset.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-fleet-idle-rebalancing-reset`
- Issue: #1482
- PR: #1482 (`test(#1482): add fleet idle-rebalancing reset-path guard`)
