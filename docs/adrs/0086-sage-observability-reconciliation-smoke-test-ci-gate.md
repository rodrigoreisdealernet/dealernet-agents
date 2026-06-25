# ADR-0086: Sage observability + reconciliation smoke-test validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Copilot (issue #1368, child of #463)
- **Supersedes / Superseded by:** none

## Context

`supabase/migrations/20260613092645_sage_observability_reconciliation.sql` adds:

- `sage_sync_events` — append-only telemetry per sync execution, tracking
  retryable failures (`auth`, `transport`, `rate_limit`), terminal failures
  (`validation`, `reconciliation`, `duplicate`), and successful syncs.
- `sage_dead_letter_queue` — DLQ for quarantined sync events awaiting operator
  review or replay.
- `sage_sync_controls` — per-scope operator controls (disable/enable) for Sage
  sync scopes.
- `sage_reconciliation_results` — per-object reconciliation state tracking
  (`in_sync`, `drifted`, `missing_sage`, `missing_internal`, `error`).
- `sage_sync_checkpoint_audit` — append-only audit trail of checkpoint state
  transitions (healthy → interrupted → recovered → replayed).
- Five `security_invoker = true` diagnostic views: `v_sage_sync_dashboard`,
  `v_sage_failed_sync_work` (with `failure_disposition` = `retryable` |
  `terminal`), `v_sage_reconciliation_drift`, `v_sage_reconciliation_summary`,
  and `v_sage_sync_audit_history` (unified audit history across sync events,
  DLQ, and checkpoints).
- Five operator RPCs: `sage_upsert_sync_checkpoint`, `sage_quarantine_sync_event`,
  `sage_mark_replayed`, `sage_disable_sync_scope`, `sage_enable_sync_scope`.

Issue #1368 (child of epic #463) requires automated coverage that verifies:
- Retry classification: retryable vs terminal failures are correctly surfaced in
  `v_sage_failed_sync_work`.
- Reconciliation visibility: drift rows appear in `v_sage_reconciliation_drift`
  and `v_sage_reconciliation_summary`.
- Audit trails: `v_sage_sync_audit_history` returns unified history after sync,
  quarantine, replay, and checkpoint recovery.
- Failure-path recovery: the quarantine → replay → recovered-checkpoint flow
  preserves correct object state and checkpoint behavior after connector
  interruption.

A behavioral SQL harness (`supabase/tests/sage_observability_reconciliation.sql`)
and its runner (`run_sage_observability_reconciliation.sh`) were shipped with
the migration but not wired into the PR gate, leaving acceptance criterion 4
("automated coverage verifies retry classification, reconciliation visibility,
audit trails, and failure-path recovery") unmet.  A reset-path job for the same
migration (`supabase-sage-observability-reconciliation-reset`) already runs in
CI and checks schema survival through `supabase db reset`, but it exercises a
shorter functional path and does not cover the full RLS gating, cross-tenant
isolation, or failure-disposition checks that the smoke harness provides.

## Decision

We add a `supabase-sage-observability-reconciliation` job to `pr-validation.yml`
that runs `bash supabase/tests/run_sage_observability_reconciliation.sh` on
every PR, and wire the result into the `validation-summary` required gate.

The smoke harness covers 14 named assertions:

1. All Sage views declare `security_invoker = true`.
2. Anon denied `SELECT` on base tables.
3. Anon denied `SELECT` on diagnostic views.
4. Anon denied `EXECUTE` on operator RPCs.
5. Authenticated without `app_role` sees 0 rows.
6. `read_only` sees 0 rows and cannot invoke operator controls.
7. `admin` tenant-A sees only tenant-A rows (and 4 audit-history rows before
   recovery).
8. `branch_manager` tenant-A sees tenant-scoped dashboard, failed-work rows,
   and correctly classified `retryable` vs `terminal` failure dispositions.
9. `admin` quarantines a sync event; failed-work view surfaces it with
   `replay_eligible = true`.
10. Replay and restart recovery: `sage_mark_replayed` + `sage_upsert_sync_checkpoint`
    advance the object to `replayed` status, set `replayed_at` on the DLQ row,
    and produce a `recovered` checkpoint; `v_sage_sync_audit_history` returns 4
    history rows for the recovered invoice.
11. `admin` disables a sync scope; `v_sage_failed_sync_work` reflects the
    disabled status with the control ID attached.
12. `admin` re-enables the scope; the previously disabled event gains a
    `resolved_at` timestamp.
13. Cross-tenant isolation: tenant-A admin cannot disable a tenant-B scope.
14. `service_role` sees all rows across all base tables.

The job uses a plain Docker + Postgres container (not the Supabase CLI), so it
runs without the `supabase/setup-cli` step and is faster than the reset-path job.

## Consequences

- **Easier:** regression in any of the 14 behavioral guarantees — RLS gating,
  failure-disposition classification, reconciliation drift visibility, audit
  history completeness, or replay/recovery state — is caught before merge.
- **Trade-off:** one additional Docker-based CI job per PR (≈ 2–3 min including
  Docker pull, migration apply, and test execution).  This matches the pattern
  of every other `*-observability*` smoke job in the PR gate.
- **Obligation:** future migrations that alter `sage_sync_events`, `sage_dead_letter_queue`,
  `sage_sync_controls`, `sage_reconciliation_results`,
  `sage_sync_checkpoint_audit`, their RLS policies, any of the five diagnostic
  views, or any operator RPC must keep the smoke assertions passing or update
  them to match the new landscape.

## Alternatives considered

- **Rely on the existing reset-path job only** — rejected; the reset harness
  validates structural survival through a fresh `supabase db reset` but does
  not exercise the RLS gating, cross-tenant isolation, failure-disposition
  classification, or the complete quarantine → replay → recovery flow that the
  smoke harness covers.
- **Fold assertions into the reset harness** — rejected; the reset harness runs
  inside the Supabase container where role-switching reflects the Supabase GoTrue
  role model; the smoke harness uses a plain Postgres container where the full
  14-assertion role sequence is simpler and faster to execute.

## Evidence

- Migration: `supabase/migrations/20260613092645_sage_observability_reconciliation.sql`
- Smoke SQL: `supabase/tests/sage_observability_reconciliation.sql`
- Runner: `supabase/tests/run_sage_observability_reconciliation.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-sage-observability-reconciliation`
- Related reset-path job: `supabase-sage-observability-reconciliation-reset`
- Issue: #1368 (child of #463)
- Re-kick issue: #1941 (successor to stalled PR #1934)
