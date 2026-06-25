# Samsara observability, reconciliation, and operator controls

Story: **Samsara observability and reconciliation controls** (issue #1162).
Depends on: epic #892 (shared sync event/recovery primitives), #442 (telematics contract).

## Purpose

Define the Samsara-specific operational surface so that support teams can:

- Monitor tenant-safe sync health for Samsara telemetry ingestion.
- Quarantine/replay failed sync work and disable noisy failing scopes without direct SQL edits.
- Diagnose drift between Wynne telematics state and Samsara state for supported signals.

## Data model

`supabase/migrations/20260612113000_samsara_observability_reconciliation.sql` adds:

- `samsara_sync_events` — one row per Samsara sync attempt, including tenant/provider/asset/signal context, retry counters, and lag.
- `samsara_dead_letter_queue` — operator queue for quarantined or exhausted failures with replay audit metadata.
- `samsara_sync_controls` — scoped disable controls by tenant + asset + signal.
- `samsara_reconciliation_results` — drift diagnostics comparing Wynne and Samsara values.

### Supported signal scopes

- `gps`
- `hours`
- `eld`
- `dashcam_events`

### Status lifecycle

`attempted → retrying → synced / dead_lettered / quarantined / disabled`

Replay actions create a new `replayed` event linked through `replayed_from_id` for full auditability.

## Operator controls

Available to `admin` and `branch_manager` roles:

- `samsara_quarantine_sync_event(...)` — quarantines failed work and upserts dead-letter state.
- `samsara_mark_replayed(...)` — requeues replay-eligible dead-letter work by creating a replay event and resolving the DLQ row.
- `samsara_disable_sync_scope(...)` — disables an asset+signal scope and marks the referenced event as disabled.
- `samsara_enable_sync_scope(...)` — re-enables a previously disabled scope and resolves outstanding disabled events.

## Views for dashboards and diagnostics

- `v_samsara_sync_dashboard` — sync status counts, retry maxima, and lag metrics per tenant/signal/direction.
- `v_samsara_failed_work` — actionable failed/retrying/quarantined/disabled work including DLQ/control context.
- `v_samsara_reconciliation_drift` — non-`in_sync` drift rows for operator diagnostics.
- `v_samsara_reconciliation_summary` — dashboardable drift counts and lag maxima by signal type.

All views use `security_invoker = true` and rely on tenant-scoped RLS from underlying tables.

## Runbook expectations

### Auth/token failures (`failure_class = 'auth'`)

1. Verify the Samsara credential/secret reference used by the connector runtime.
2. Validate provider-side API access is still active for the tenant.
3. Mark rows replay-eligible and replay only after credentials are fixed.

### Provider rate-limit/outage (`failure_class in ('rate_limit','timeout')`)

1. Confirm outage scope using `v_samsara_sync_dashboard` (`retrying_count`, `dead_lettered_count`, `max_lag_seconds`).
2. Use `samsara_disable_sync_scope(...)` for noisy asset/signal scopes during known provider incidents.
3. Re-enable processing by clearing runtime block conditions and replaying DLQ rows after recovery.

### Mapping/validation failures (`failure_class in ('mapping','schema_validation')`)

1. Compare failing event metadata to expected telematics contract shape.
2. Inspect `v_samsara_reconciliation_drift` for the same asset/signal to scope downstream drift.
3. Replay only after connector mapping fixes are deployed.

### Drift diagnostics

Use drift views to isolate stale/mismatched telemetry:

```sql
select
  tenant_id,
  asset_external_id,
  signal_type,
  drift_status,
  lag_seconds,
  diagnostic_summary,
  compared_at
from public.v_samsara_reconciliation_drift
order by compared_at desc;
```

## Test coverage

- `bash supabase/tests/run_samsara_observability_reconciliation.sh`
