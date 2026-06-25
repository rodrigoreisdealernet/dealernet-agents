# Descartes sync recovery runbook

Use this runbook for tenant-scoped diagnostics and recovery when the Descartes connector reports failures.

## 1) Inspect current status/failures

- Dashboard counts by tenant/provider/scope/status:
  - `select * from public.v_descartes_sync_dashboard where tenant_key = '<tenant-key>' order by scope, sync_status;`
- Failure queue with retry/quarantine eligibility:
  - `select * from public.v_descartes_failed_work where tenant_key = '<tenant-key>' order by occurred_at desc;`

## 2) Replay eligible failures

Only `admin`/`branch_manager` in the same tenant can queue replay:

```sql
select *
from public.descartes_retry_delivery(
  p_delivery_id := '<delivery-uuid>',
  p_requested_reason := 'operator replay after transient outage'
);
```

Expected outcome:
- `sync_status = 'replay_queued'`
- `retry_count` increments
- replay event is emitted into `time_series_points` with fact type `integration_descartes_sync_event`

## 3) Quarantine non-retryable/poison failures

```sql
select *
from public.descartes_quarantine_delivery(
  p_delivery_id := '<delivery-uuid>',
  p_quarantine_reason := 'invalid provider payload - manual investigation required'
);
```

Expected outcome:
- `sync_status = 'quarantined'`
- `is_retryable = false`
- `quarantined_at` and `quarantine_reason` are set

## 4) Reconciliation diagnostics (drift)

Check route/shipment/compliance mismatches between internal state and provider payload snapshots:

```sql
select *
from public.v_descartes_reconciliation_drift
where tenant_key = '<tenant-key>'
  and drift_detected
order by occurred_at desc;
```

## Common failure modes

- **Provider timeout / rate limit** (`error_code` like `timeout`, `rate_limit`):
  - Retry via `descartes_retry_delivery`.
- **Invalid request / schema mismatch** (`invalid_request`, `validation_error`):
  - Quarantine and investigate mapping payload.
- **Auth failure** (`auth_failed`, `token_expired`):
  - Refresh connector credentials, then replay queued failures.
- **Stale cursor / out-of-order provider events**:
  - Use `v_descartes_reconciliation_drift` to scope blast radius by route/shipment/compliance before replaying.
