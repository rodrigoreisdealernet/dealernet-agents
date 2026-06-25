# ADR-0069: Equipment-type cost-of-ownership reset-path CI gate

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** Copilot (issue #1512)
- **Supersedes / Superseded by:** none

## Context

PR #1461 merged `20260613100000_asset_cost_ownership_profitability.sql`, which introduces three finance-facing views (`v_equipment_type_cost_ownership`, `v_equipment_type_profitability`, `v_asset_lifecycle_accounting_events`) and a guarded RPC (`finance_get_equipment_cost_ownership`). The standalone SQL behavioural harness (`supabase/tests/run_equipment_type_cost_ownership.sh`) was already in place, but there was no reset-path guard: a regression in an earlier migration could silently prevent the cost-of-ownership views from being created or returning correct data on a fresh `supabase db reset`, and that failure would never surface in CI.

Issue #1512 identified the gap and required a repo-standard clean-reset guardrail consistent with the pattern established for similar feature gates (ADR-0042, ADR-0046, ADR-0048, ADR-0049, ADR-0050, ADR-0053, ADR-0054, ADR-0057, ADR-0058, ADR-0061).

## Decision

We add a dedicated CI job (`supabase-equipment-type-cost-ownership-reset`) that runs `supabase db reset --config supabase/config.toml` and then exercises `supabase/tests/equipment_type_cost_ownership_reset.sql`. The SQL harness:
- confirms the three views and RPC exist after a full schema rebuild;
- confirms the extended check constraints accept asset lifecycle event types;
- inserts minimal fixture data and asserts that `v_equipment_type_cost_ownership` and `v_equipment_type_profitability` each return an equipment-type row with the expected columns (category name, depreciation rollup, profitability status, formula reference); and
- asserts that a non-finance role (field_operator) sees 0 rows from both views, confirming the security-invoker gate is enforced on the rebuilt schema.

## Consequences

- Any migration change that breaks the cost-of-ownership or profitability reporting path will now fail CI on every PR.
- The `validation-summary` job gains one additional prerequisite, keeping the gate list consistent.
- CI wall-clock time increases by roughly the duration of one Supabase reset (~30–90 s on a shared runner), consistent with other reset-path gates.

## Alternatives considered

- **Rely solely on the standalone Docker harness** — does not exercise the Supabase CLI reset path and would not catch migration ordering or config regressions.
- **Extend the existing `run_equipment_type_cost_ownership.sh`** — that harness spins up a raw Postgres container and applies migrations manually; it does not exercise `supabase db reset` or the seed, so schema rebuild regressions would still go undetected.

## Evidence

- Migration: `supabase/migrations/20260613100000_asset_cost_ownership_profitability.sql`
- Reset harness: `supabase/tests/equipment_type_cost_ownership_reset.sql`
- Runner: `supabase/tests/run_equipment_type_cost_ownership_reset.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-equipment-type-cost-ownership-reset`
- Issue: #1512, PR: #1461
