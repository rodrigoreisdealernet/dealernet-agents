# Coupa observability, reconciliation, and operator recovery controls

Story: **Coupa observability and reconciliation controls** (issue #1145).
Depends on: epic #892 (shared sync event / recovery primitives), #483 (Coupa procurement archetype).

---

## Purpose

Define the Coupa-specific observability, reconciliation, and operator recovery surface so support teams can:

- See tenant-scoped sync status, retry state, and dead-letter outcomes for Coupa requisitions, purchase orders, suppliers, and invoices.
- Replay eligible failures after the underlying Coupa or mapping issue is fixed.
- Disable and later re-enable a failing object scope without direct database edits.
- Inspect reconciliation drift between Dealernet records and Coupa state by supported object type.

---

## Data model

`supabase/migrations/20260611113000_coupa_observability_reconciliation.sql` adds four tenant-scoped tables:

| Table | Purpose |
|---|---|
| `coupa_sync_events` | One row per sync attempt with tenant/provider/object context, retry state, failure class, and replay audit chain |
| `coupa_dead_letter_queue` | Operator-facing quarantine queue for replayable or non-retryable failures |
| `coupa_sync_controls` | Tenant-safe disable / re-enable controls for a Coupa object scope (`object_type` + `object_key` + `source_system`) |
| `coupa_reconciliation_results` | Per-object reconciliation diagnostics with drift status and comparison metadata |

### Supported object scopes

- `requisition`
- `purchase_order`
- `supplier`
- `invoice`

### Sync status lifecycle

`attempted → retrying → synced / dead_lettered / quarantined / disabled`

Replays create a fresh `replayed` row linked by `replayed_from_id` so operator actions remain auditable.

---

## Operator control RPCs

Available to `admin` and `branch_manager` roles only:

### `coupa_quarantine_sync_event(p_sync_event_id, p_quarantine_reason, p_replay_eligible, p_operator_notes)`

- Marks the event `quarantined`
- Inserts or updates the matching dead-letter row
- Keeps the event visible in `v_coupa_failed_sync_work`

### `coupa_mark_replayed(p_dlq_id, p_replay_actor, p_operator_notes)`

- Requires `replay_eligible = true`
- Creates a new `replayed` sync event for the same Coupa object
- Resolves the original dead-lettered/quarantined event without direct table edits

### `coupa_disable_sync_scope(p_sync_event_id, p_disable_reason, p_operator_notes)`

- Derives the tenant/object scope from the referenced event
- Upserts a row into `coupa_sync_controls`
- Marks the current event `disabled` so dashboards and failed-work views surface the pause

### `coupa_enable_sync_scope(p_control_id, p_reenable_actor, p_operator_notes)`

- Re-enables a previously disabled control scope
- Resolves any open `disabled` events for that scope
- Restores normal runtime processing without requiring ad hoc SQL

---

## Dashboards and views

| View | Purpose |
|---|---|
| `v_coupa_sync_dashboard` | Per-tenant, per-object delivery health summary with status/failure counts |
| `v_coupa_failed_sync_work` | Operator queue for retrying, dead-lettered, quarantined, and disabled work |
| `v_coupa_reconciliation_drift` | Detailed drift diagnostics for object scopes that are not `in_sync` |
| `v_coupa_reconciliation_summary` | Count of drift statuses by object type for dashboard summaries |

All views are `security_invoker` and rely on the underlying RLS policies for tenant isolation.

---

## Frontend contract

`frontend/src/lib/coupa-sync-contract.ts` provides:

- `CoupaSyncContractState` for client-side Coupa sync status
- `applyCoupaSyncUpdate(...)` for dedupe, retry/dead-letter transitions, and disabled scope handling
- `toOperatorSyncView(...)` for dashboard severity/action mapping
- `diagnoseCoupaFailure(...)` for Coupa-specific support guidance

Tests: `frontend/src/test/coupa-sync-contract.test.ts`

---

## Common failure modes and runbook expectations

### Auth failures

**Symptoms:** `OAUTH_401`, `UNAUTHORIZED`, `TOKEN_EXPIRED`

**Runbook:**
1. Verify the Coupa credential or token reference used by the connector.
2. Confirm the provider-side API user is still active and allowed for the target object.
3. Replay only after the credential issue is fixed and the dead-letter row is marked replay-eligible.

### Mapping / validation failures

**Symptoms:** required supplier, PO, or invoice fields missing; Coupa rejects the payload schema.

**Runbook:**
1. Compare the failing object payload against the expected Coupa object schema.
2. Inspect `v_coupa_reconciliation_drift` to see whether the object also drifted structurally.
3. If the fix is additive and idempotent, replay the DLQ entry after deploying the mapping correction.

### Provider policy failures

**Symptoms:** approval policy rejection, supplier state not eligible, invoice cannot post due to Coupa workflow rules.

**Runbook:**
1. Confirm the Coupa object is in an approvable/postable state.
2. Use `coupa_disable_sync_scope(...)` if repeated retries would create noisy alerts while business users correct the object.
3. Re-enable and replay only after the provider-side policy blocker is resolved.

### Drift diagnostics

Use `v_coupa_reconciliation_drift` for object-level mismatch inspection and `v_coupa_reconciliation_summary` for dashboards.

```sql
select
  tenant_id,
  object_type,
  object_key,
  drift_status,
  diagnostic_summary,
  checked_at
from public.v_coupa_reconciliation_drift
where object_type = 'supplier'
order by checked_at desc;
```

### Disable / resume expectations

Disable is intended for scoped operational containment, not as a permanent substitute for fixing the connector.

- Disable only the failing object scope, not the entire tenant, whenever possible.
- Record the reason in operator notes so support can audit why the sync was paused.
- Re-enable only after reconciling the drift and validating that the root cause is fixed.

---

## Test coverage

| Script | Purpose |
|---|---|
| `bash supabase/tests/run_coupa_observability_reconciliation.sh` | Full RLS + behavioral regression (CI reset-path gate) |
| `bash supabase/tests/run_coupa_observability_reconciliation_reset.sh` | Structural + functional smoke test after `supabase db reset` |
| `cd frontend && npm test -- --run src/test/coupa-sync-contract.test.ts` | Frontend sync-contract unit tests |
| `cd frontend && npm run lint -- src/lib/coupa-sync-contract.ts src/test/coupa-sync-contract.test.ts` | Lint check for contract and test files |

The dedicated reset-path script (`run_coupa_observability_reconciliation_reset.sh`) verifies:
1. Base tables exist with RLS enabled after `supabase db reset`
2. All four diagnostic views declare `security_invoker = true`
3. All operator RPCs exist and are callable
4. Sync event INSERT + SELECT round-trip works via `service_role`
5. DLQ quarantine flow (`coupa_quarantine_sync_event`) succeeds end-to-end
6. DLQ replay flow (`coupa_mark_replayed`) creates an auditable replay chain
7. `v_coupa_reconciliation_drift` returns rows for a drift fixture
8. `v_coupa_sync_dashboard` returns aggregated rows after reset
