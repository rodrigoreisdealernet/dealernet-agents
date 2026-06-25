# ADR-0108: Samsara observability and reconciliation reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Tech Review, Platform, Copilot
- **Supersedes / Superseded by:** N/A
- **Closes:** #1860

## Context

Migration `20260612113000_samsara_observability_reconciliation.sql` merged the Samsara
observability, reconciliation, and operator-controls schema (four tables, four diagnostic views,
four operator RPCs) with SQL behavioral test coverage in
`supabase/tests/samsara_observability_reconciliation.sql` but without a clean-reset Supabase
validation job in CI.

The smoke-test runner (`supabase/tests/run_samsara_observability_reconciliation.sh`) runs all
migrations against a bare Postgres container and then verifies behavioral correctness, but it
does not exercise the `supabase db reset` path.  Without a reset-path job, CI can remain green
while fresh-environment provisioning (as used in dev/test/prod onboarding and disaster recovery)
silently breaks.

PR #1852 attempted to introduce this guardrail but stalled on a branch-local Temporal CI hang
that prevented the `PR Validation` run from completing.  Issue #1860 was opened to re-implement
the guardrail from a clean `main` checkout.

## Decision

We add a named, required CI job `supabase-samsara-observability-reconciliation-reset` to
`.github/workflows/pr-validation.yml`.  The job runs
`bash supabase/tests/run_samsara_observability_reconciliation_reset.sh`, which performs a full
`supabase db reset` before executing the Samsara SQL assertions against the rebuilt database.

The reset-path assertions cover:

1. All four Samsara tables (`samsara_sync_events`, `samsara_dead_letter_queue`,
   `samsara_sync_controls`, `samsara_reconciliation_results`) exist with RLS enabled after a
   fresh reset.
2. All four diagnostic views (`v_samsara_sync_dashboard`, `v_samsara_failed_work`,
   `v_samsara_reconciliation_drift`, `v_samsara_reconciliation_summary`) declare
   `security_invoker = true`.
3. All four operator RPCs (`samsara_quarantine_sync_event`, `samsara_mark_replayed`,
   `samsara_disable_sync_scope`, `samsara_enable_sync_scope`) exist.
4. Sync event INSERT/SELECT round-trip works via `service_role`.
5. DLQ quarantine flow (`samsara_quarantine_sync_event`) works end-to-end.
6. DLQ replay flow (`samsara_mark_replayed`) works after reset.
7. `v_samsara_reconciliation_drift` returns rows for a freshly inserted drift result.
8. `v_samsara_sync_dashboard` returns rows after reset.

The job is added to the `validation-summary` `needs` list and summary matrix so the result is
visible on every PR.

A corresponding pytest test `test_samsara_observability_reconciliation_reset_validation` is added
to `temporal/tests/test_rental_master_data_foundation.py`, following the established pattern for
reset-path validation tests in that suite.

## Consequences

- Fresh-schema regressions in the Samsara migration path now fail PR validation before merge.
- PR validation gains one more required Supabase reset-path job, which slightly increases CI time.
- Future changes to the Samsara migration surface must keep the reset-path assertions green unless
  a superseding ADR replaces this gate.

## Alternatives considered

- Leave the runner script in the repository but not wired to CI — rejected because it provides no
  regression protection if never executed (the pattern that created this gap in the first place).
- Rely on manual `supabase db reset` verification during review — rejected because it is easy to
  skip and does not protect main.

## Evidence

- `.github/workflows/pr-validation.yml` (job `supabase-samsara-observability-reconciliation-reset`)
- `supabase/tests/run_samsara_observability_reconciliation_reset.sh`
- `supabase/tests/samsara_observability_reconciliation_reset.sql`
- `supabase/migrations/20260612113000_samsara_observability_reconciliation.sql`
- `temporal/tests/test_rental_master_data_foundation.py` (test `test_samsara_observability_reconciliation_reset_validation`)
- Issue #1860 — re-kick after branch-local Temporal CI hang on PR #1852
- ADR-0053 (`0053-coupa-reset-path-ci-gate.md`) — precedent for this gate pattern
- ADR-0054 (`0054-sage-observability-reconciliation-reset-path-ci-gate.md`) — closest analogue
