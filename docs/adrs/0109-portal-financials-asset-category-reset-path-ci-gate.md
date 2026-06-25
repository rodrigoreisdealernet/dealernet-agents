# ADR-0109: Reset-path CI gate for portal financials asset_category migration

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Copilot coding agent
- **Supersedes / Superseded by:** none

## Context
PR #2225 added `supabase/migrations/20260619010000_portal_financials_asset_category.sql`, which extends `portal_get_financial_entities()` to return `asset_category` rows scoped to a customer's authorized contract lines. The migration landed with focused behavioral (RLS) tests but without a clean-reset migration validation path.

PR #2317 introduced that missing reset-path gate, but it was closed during a re-kick because `.github/workflows/pr-validation.yml` drifted from `main` and carried `shared-file-overlap` against other open workflow PRs. Issue #2365 requires recreating the same guardrail from a fresh `main` base so platform review can clear the overlap blocker.

Without a reset-path gate:
- A regression in migration replay order could pass behavioral tests but fail on full `supabase db reset` rebuilds.
- The scoped-access contract (`asset_category` visibility by authorized contract lines for authenticated customers, with `service_role` bypass) would not be validated on canonical reset-path CI.

## Decision
Add a dedicated CI job `supabase-portal-financials-asset-category-reset` in `.github/workflows/pr-validation.yml` that:
1. Runs `supabase db reset --config supabase/config.toml` using the shared `reset_validation_lib.sh` harness.
2. Executes `supabase/tests/portal_financials_asset_category_reset.sql` against the rebuilt database to assert:
   - `portal_get_financial_entities()` exists as `SECURITY DEFINER` with expected grants (`authenticated` and `service_role` allowed; `anon` denied).
   - An authenticated customer JWT sees `asset_category` rows referenced by both `category_id` and legacy `asset_category_id` contract-line fields.
   - Cross-customer categories are filtered out for customer-scoped callers.
   - `service_role` receives cross-customer category rows.

Wire the job into `validation-summary` so replay or scope regressions block PRs.

## Consequences
- Migration replay regressions for `20260619010000_portal_financials_asset_category.sql` are caught on PRs that touch `supabase/` or validation workflow wiring.
- CI runtime increases for affected PRs (Supabase start + reset), consistent with existing reset-path gates.
- The previous overlap blocker is removed by re-adding the gate on current `main` workflow state.

## Alternatives considered
- **Rely only on behavioral RLS tests** (`run_portal_financials_asset_category_rls.sh`): rejected because those tests do not run through canonical `supabase db reset` migration replay.
- **Do not re-kick the gate**: rejected because issue #2365 explicitly requires restoring reset-path coverage on a fresh-main branch.

## Evidence
- `.github/workflows/pr-validation.yml` — `supabase-portal-financials-asset-category-reset` job and summary wiring.
- `supabase/tests/run_portal_financials_asset_category_reset.sh`.
- `supabase/tests/portal_financials_asset_category_reset.sql`.
- `supabase/migrations/20260619010000_portal_financials_asset_category.sql`.
- Issue #2365, PR #2317, PR #2225.
