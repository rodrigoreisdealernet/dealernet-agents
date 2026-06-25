# ADR-0054: Sage observability and reconciliation reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Tech Review, Platform, Copilot
- **Supersedes / Superseded by:** N/A

## Context

PR #1424 merged `20260613092645_sage_observability_reconciliation.sql` with SQL contract coverage
but without a clean-reset Supabase validation job in CI.  The existing test runner
(`supabase/tests/run_sage_observability_reconciliation_reset.sh`) was added to the repository but
never wired into `.github/workflows/pr-validation.yml`, meaning CI could stay green without ever
executing the Sage reset check.

That left a gap: the five Sage tables, five diagnostic views, five operator RPCs, DLQ quarantine/
replay flows, and reconciliation drift diagnostics could look correct on an already-evolved database
while still breaking when a fresh environment is provisioned from scratch.

## Decision

We add a named, required CI job `supabase-sage-observability-reconciliation-reset` to
`.github/workflows/pr-validation.yml`.  The job runs
`bash supabase/tests/run_sage_observability_reconciliation_reset.sh`, which performs a full
`supabase db reset` before executing the Sage SQL assertions against the rebuilt database.

The reset-path assertions cover:

1. All five Sage tables (`sage_sync_scopes`, `sage_sync_telemetry`, `sage_sync_checkpoints`,
   `sage_sync_dlq`, `sage_sync_checkpoint_audit`) exist with RLS enabled after a fresh reset.
2. All five diagnostic views declare `security_invoker = true`.
3. All five operator RPCs (`sage_upsert_sync_checkpoint`, `sage_quarantine_sync_event`,
   `sage_mark_replayed`, `sage_disable_sync_scope`, `sage_enable_sync_scope`) exist.
4. Telemetry event INSERT/SELECT round-trip works via `service_role`.
5. DLQ quarantine flow (`sage_quarantine_sync_event`) works end-to-end.
6. DLQ replay + recovery-audit checkpoint lookup (`sage_mark_replayed` +
   `sage_sync_checkpoint_audit`) work after reset.
7. `v_sage_reconciliation_drift` returns rows for a freshly inserted drift result.
8. `v_sage_sync_dashboard` and `v_sage_sync_audit_history` return rows.

The job is added to the `validation-summary` `needs` list and summary matrix so the result is
visible on every PR.

## Consequences

- Fresh-schema regressions in the Sage migration path now fail PR validation before merge.
- PR validation gains one more required Supabase reset-path job, which slightly increases CI time.
- Future changes to the Sage migration surface must keep the reset-path assertions green unless a
  superseding ADR replaces this gate.

## Alternatives considered

- Leave the runner script in the repository but not wired to CI — rejected because it provides no
  regression protection if never executed.
- Rely on manual `supabase db reset` verification during review — rejected because it is easy to
  skip and does not protect main.

## Evidence

- `.github/workflows/pr-validation.yml` (job `supabase-sage-observability-reconciliation-reset`)
- `supabase/tests/run_sage_observability_reconciliation_reset.sh`
- `supabase/tests/sage_observability_reconciliation_reset.sql`
- `supabase/migrations/20260613092645_sage_observability_reconciliation.sql`
- ADR-0053 (`0053-coupa-reset-path-ci-gate.md`) — precedent for this gate pattern
