# Power BI connector observability, replay controls, and stale-refresh alerts

Story: **Power BI connector monitoring and replay controls** (issue #1118).
Depends on: epic #470 (AI-powered reporting and Power BI integration), #502 (shared telemetry and alerting conventions).

## Purpose

Define the Power BI-specific operational surface so that support teams can:

- Monitor tenant-safe export run health for Power BI dataset push and refresh operations.
- Quarantine/replay failed export runs and disable noisy failing scopes without direct SQL edits.
- Identify stale or failed dataset refreshes from admin/ops surfaces without inspecting raw provider logs.
- Distinguish auth/config, rate-limit/quota, transient transport, and invalid-payload failures.

## Data model

`supabase/migrations/20260612120000_powerbi_observability_reconciliation.sql` adds:

- `powerbi_export_runs` — one row per Power BI export execution, including tenant/workspace/dataset/scope context, retry counters, and failure classification.
- `powerbi_dead_letter_queue` — operator queue for quarantined or exhausted failures with bounded replay audit metadata.
- `powerbi_sync_controls` — scoped disable controls by tenant + workspace + dataset + export scope.
- `powerbi_stale_refresh_alerts` — staleness state per dataset, recording last refresh timestamp, age, and alert lifecycle.

### Supported export scopes

- `dataset_push` — Wynne pushes structured rental/financial data rows to a Power BI push dataset.
- `dataset_refresh` — triggers an on-demand Power BI dataset refresh after a data push.
- `report_embed` — embed token generation and report configuration operations.

### Status lifecycle

`attempted → retrying → succeeded / dead_lettered / quarantined / disabled`

Replay actions create a new `replayed` export run linked through `replayed_from_id` for full auditability.

## Retry classification

| Failure class | HTTP status codes | Recovery path |
|---|---|---|
| `auth` | 401, 403 | Non-recoverable — fix credentials/permissions before replay |
| `rate_limit` | 429 | Recoverable — bounded retry with backoff |
| `transport` | 500, 502, 503, 504 and other 5xx | Recoverable — bounded retry with backoff |
| `invalid_payload` | 400, 413, 422 and other 4xx | Non-recoverable — fix payload/schema before replay |
| `config` | 404, 409, 410 | Non-recoverable — fix workspace/dataset config before replay |
| `unknown` | Unexpected codes | Non-recoverable — operator review required |

`rate_limit` and `transport` failures are eligible for bounded retry/replay.
All other classes require operator intervention before the DLQ row can be replayed.

## Operator controls

Available to `admin` and `branch_manager` roles:

- `powerbi_quarantine_export_run(...)` — quarantines a failed export run and upserts dead-letter state.
- `powerbi_mark_replayed(...)` — requeues replay-eligible dead-letter work by creating a replay export run and resolving the DLQ row.
- `powerbi_disable_export_scope(...)` — disables a workspace/dataset/scope combination and marks the referenced run as disabled.
- `powerbi_enable_export_scope(...)` — re-enables a previously disabled scope and resolves outstanding disabled runs.

## Views for dashboards and diagnostics

- `v_powerbi_export_dashboard` — export status counts and failure-class breakdowns per tenant/workspace/dataset/scope.
- `v_powerbi_failed_exports` — actionable failed/retrying/quarantined/disabled export runs including DLQ and control context.
- `v_powerbi_stale_datasets` — open and acknowledged stale-refresh alerts enriched with the latest export run state and any active disable controls.

All views use `security_invoker = true` and rely on tenant-scoped RLS from underlying tables.

## Python connector module

`temporal/src/integrations/powerbi.py` provides:

- `validate_powerbi_config(config)` — validates required fields including `api_base_url`, `tenant_id`, OAuth2 secret refs, enabled scopes, workspace mapping, and optional stale threshold.
- `classify_powerbi_failure(http_status)` — maps HTTP status codes to failure class strings.
- `is_recoverable_failure(failure_class)` — returns `True` for `rate_limit` and `transport` classes.
- `run_powerbi_healthcheck(config, ...)` — non-destructive connectivity check against the Power BI REST API.
- `check_dataset_refresh_staleness(state, threshold_minutes, now)` — determines whether a dataset is stale or in a failed refresh state.
- `build_export_run_outcome(context, ...)` — builds an `ExportRunOutcome` telemetry record from raw export result inputs, routing to `retrying` or `dead_lettered` based on failure class and retry count.

## Test coverage

Run with:

```bash
python -m pytest temporal/tests/test_powerbi_connector.py
```

Tests cover:
- Config validation for all required and optional fields.
- Retry classification for all defined HTTP status codes including edge cases.
- Healthcheck for success, config error, secret resolution failure, and all HTTP error classes.
- Stale refresh detection for current, stale, never-refreshed, and failed datasets.
- Export run outcome building for all status transitions (succeeded, retrying, dead_lettered).

## Runbook expectations

### Auth/token failures (`failure_class = 'auth'`)

1. Verify the Azure AD client credential secret references used by the connector.
2. Confirm the service principal has the required Power BI workspace permissions.
3. Mark rows replay-eligible and replay only after credentials and permissions are fixed.

### Rate-limit failures (`failure_class = 'rate_limit'`)

1. Check `v_powerbi_export_dashboard` for `rate_limit_failure_count` across affected datasets.
2. Power BI enforces per-dataset refresh quotas (typically 8 refreshes per day on shared capacity).
3. Use `powerbi_disable_export_scope(...)` to halt retries during a known quota exhaustion window.
4. Re-enable and replay after the quota window resets.

### Transient transport failures (`failure_class = 'transport'`)

1. Confirm Power BI service status at the Microsoft Service Health Dashboard.
2. Review `v_powerbi_failed_exports` for affected workspace/dataset scope.
3. Replay eligible DLQ rows after confirming the service is recovered.

### Invalid-payload failures (`failure_class = 'invalid_payload'`)

1. Compare the failing export metadata against the expected Power BI push dataset schema.
2. Payload correction and connector mapping changes must be deployed before replay.
3. Do not replay invalid-payload DLQ rows without schema/mapping fix.

### Config failures (`failure_class = 'config'`)

1. Verify the workspace ID and dataset ID in the connector configuration for the affected tenant.
2. Check whether the dataset exists in the Power BI workspace and has push capability enabled.
3. Update connector config and replay only after verifying workspace access is restored.

### Stale dataset diagnostics

Use the stale-alerts view to identify datasets overdue for refresh:

```sql
select
  tenant_id,
  workspace_id,
  dataset_id,
  alert_status,
  last_refreshed_at,
  last_refresh_status,
  age_minutes,
  stale_threshold_minutes,
  failure_class,
  diagnostic_summary
from public.v_powerbi_stale_datasets
order by age_minutes desc nulls first;
```
