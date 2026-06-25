# SmartEquip observability, delivery diagnostics, and operator recovery controls

Story: **SmartEquip observability and recovery controls** (issue #1156).
Depends on: epic #892 (shared sync event / recovery primitives), #482 (SmartEquip procurement/service archetype).

---

## Purpose

Define the shared observability surface and operator recovery model for SmartEquip API exchange
delivery so that operators can:

- Diagnose the failure class of any stuck or failed exchange without log spelunking.
- Replay eligible exchanges after a root cause is resolved.
- Quarantine non-retryable exchanges and track resolution.
- Detect drift or dropped exchanges using reconciliation views.

This document describes the data model, contract, operator controls, and guidance for common
incident patterns.

---

## Data model

Two new tables in `supabase/migrations/20260611203000_smartequip_delivery_observability.sql`:

### `smartequip_delivery_events`

One row per delivery attempt.  A single logical exchange produces one row per attempt; replays
produce a new row with `replayed_from_id` set.

| Column | Purpose |
|---|---|
| `tenant_id` | Tenant scoping for RLS and cross-tenant isolation |
| `exchange_id` | Stable identifier for the logical exchange across retry/replay cycles |
| `flow_name` | SmartEquip flow or API endpoint name |
| `object_scope` | Supported SmartEquip object scope (`work_orders`, `service_requests`, `parts_orders`) |
| `direction` | `inbound` (webhook to Dealernet) or `outbound` (Dealernet to provider) |
| `delivery_status` | `attempted → retrying → delivered / dead_lettered / quarantined / replayed` |
| `failure_class` | Normalized failure class (`auth`, `signature`, `mapping`, `provider_policy`, …) |
| `failure_code` | Provider-specific or HTTP error code |
| `failure_message` | Human-readable failure description |
| `retry_count` / `max_retries` | Current and ceiling retry counts |
| `idempotency_key` | Outbound delivery idempotency token |
| `source_system` / `source_event_id` | Source deduplication key |
| `payload_digest` | SHA-256 of the payload envelope for tamper detection |
| `replayed_from_id` | FK to the original event when this row represents a replay |

### `smartequip_dead_letter_queue`

One row per quarantined or exhausted exchange.  Operators use this as the primary recovery surface.

| Column | Purpose |
|---|---|
| `delivery_event_id` | FK back to `smartequip_delivery_events` |
| `failure_class` / `failure_code` / `failure_message` | Failure details copied from delivery event |
| `quarantine_reason` | Why the exchange was quarantined |
| `quarantined_by` | Role or actor that triggered quarantine |
| `replay_eligible` | Whether the exchange can be replayed after root cause resolution |
| `replayed_at` / `replayed_by` | When and by whom the replay was triggered |
| `replay_delivery_id` | FK to the new delivery event produced by the replay |
| `resolved_at` / `resolved_by` / `resolution_note` | Resolution audit trail |
| `payload_snapshot` | Snapshot of exchange metadata at time of quarantine |

---

## Operator control RPCs

Three security-definer RPCs are available to `admin` and `branch_manager` roles:

### `smartequip_quarantine_exchange(p_delivery_event_id, p_quarantine_reason, p_replay_eligible, p_operator_notes)`

- Marks the delivery event as `quarantined`.
- Inserts a row into `smartequip_dead_letter_queue`.
- Use when retries are not appropriate and the exchange needs investigation.
- Returns the DLQ row ID.

### `smartequip_mark_replayed(p_dlq_id, p_replay_actor, p_operator_notes)`

- Requires `replay_eligible = true` on the DLQ row.
- Inserts a new `smartequip_delivery_events` row with `delivery_status = 'replayed'` and `replayed_from_id` pointing to the original event.
- Updates the DLQ row with `replayed_at`, `replayed_by`, and `replay_delivery_id`.
- Does **not** trigger the actual connector delivery; the caller is responsible for handing the replay event ID to the connector runtime to execute the delivery.
- Returns the new delivery event ID.

### `smartequip_disable_exchange_retry(p_delivery_event_id, p_quarantine_reason, p_operator_notes)`

- Wrapper control for operators who need to halt retries immediately.
- Delegates to `smartequip_quarantine_exchange(...)` with `replay_eligible = false`.
- Returns the DLQ row ID so the disabled exchange can be tracked in operator tooling.

---

## Dashboards and views

| View | Purpose |
|---|---|
| `v_smartequip_delivery_dashboard` | Per-flow, per-object-scope, per-direction delivery health summary with counts by status and failure class |
| `v_smartequip_failed_exchanges` | Operator-facing list of exchanges needing attention (retrying / dead_lettered / quarantined) |
| `v_smartequip_reconciliation_summary` | Per-flow, per-day delivery and failure counts for gap detection |

All views are `security_invoker` and respect the tenant-scoped RLS on underlying tables.

---

## Frontend contract

`frontend/src/lib/smartequip-delivery-contract.ts` provides:

- `SmartEquipDeliveryContractState` — client-side delivery state including status, retry count, failure, and DLQ flags.
- `applySmartEquipDeliveryUpdate(...)` — dedupes by `dedupeKey`, tracks retry/dead-letter transitions.
- `toOperatorDeliveryView(...)` — maps contract state to `severity`, `statusSummary`, `failureSummary`, `actionRequired`, and `suggestedAction` for operator dashboards.
- `diagnoseSmartEquipFailure(failureClass)` — returns human-readable investigation guidance for each failure class.

Tests: `frontend/src/test/smartequip-delivery-contract.test.ts`

---

## Common incident patterns and investigation guidance

### Auth failures (`failure_class = 'auth'`)

**Symptoms:** `OAUTH_401`, `TOKEN_EXPIRED`, `UNAUTHORIZED` codes; usually affects all exchanges
on a flow simultaneously.

**Investigation steps:**

1. Check when the OAuth token was last refreshed in the connector config.
2. Verify the client ID and secret references in `integration_config` still point to valid secrets.
3. Confirm the provider has not rotated or revoked the application credentials.
4. Check for IP-allowlist changes if provider uses IP-restricted tokens.

**Recovery:**

1. Refresh or rotate the OAuth credentials in the secret store.
2. Update the secret reference in `integration_config` if the reference key changed.
3. Mark affected DLQ entries as `replay_eligible = true`.
4. Call `smartequip_mark_replayed(...)` for each affected entry.
5. Verify the replayed delivery events reach `delivered` status.

---

### Signature failures (`failure_class = 'signature'`)

**Symptoms:** `HMAC_MISMATCH`, `INVALID_SIGNATURE`, `WEBHOOK_SIGNATURE_FAIL` codes; typically
affects inbound webhook exchanges.

**Investigation steps:**

1. Compare the `payload_digest` on the delivery event with the digest computed using the current
   HMAC secret to detect key drift.
2. Check if the provider recently rotated the webhook signing secret.
3. Verify clock skew between Dealernet and the SmartEquip runtime is within tolerance (< 5 minutes).
4. Check that the payload encoding (UTF-8, base64, line endings) matches provider expectations.

**Recovery:**

1. Update the HMAC secret in the secret store to match the provider's current signing key.
2. Verify the new secret produces matching digests against a known-good sample payload.
3. If the drift window was short, the affected exchanges may be replayed.
4. If the window was long (> a few hours), reconcile against `v_smartequip_reconciliation_summary`
   to confirm the scope of dropped events before replaying.

---

### Mapping failures (`failure_class = 'mapping'`)

**Symptoms:** `MAP_FIELD_MISSING`, `SCHEMA_VALIDATION_FAIL`, `TRANSFORM_ERROR`; typically affects
a subset of exchanges related to a recent schema change.

**Investigation steps:**

1. Identify the flow and exchange type from `flow_name` and `source_event_id`.
2. Check `failure_message` for the specific field or path that failed.
3. Compare the failing payload structure against the current API contract version.
4. Review recent connector or API version changes that may have added or renamed fields.

**Recovery:**

1. Fix the field mapping in the connector adapter's anti-corruption layer.
2. If the fix is additive (new optional fields), affected exchanges are safe to replay.
3. If the fix requires structural changes, confirm the provider's idempotency semantics before
   replaying to avoid duplicate processing on the provider side.
4. After deploying the fix, call `smartequip_mark_replayed(...)` for eligible DLQ entries.

---

### Provider policy failures (`failure_class = 'provider_policy'`)

**Symptoms:** `RATE_LIMIT_EXCEEDED`, `IP_BLOCKED`, `DEPRECATED_API_VERSION`, `PLAN_LIMIT`; often
bursts or sustained failure affecting a flow.

**Investigation steps:**

1. Check `v_smartequip_delivery_dashboard` for the affected flow's `provider_policy_failure_count`
   trend over the last 24 hours.
2. For rate limits: review connector throttle config against provider tier limits.
3. For IP blocks: confirm cluster egress IPs are on the provider's allowlist.
4. For version deprecation: check provider release notes for the affected API version.

**Recovery:**

1. Adjust throttle config or upgrade the API plan to resolve rate limits.
2. Update IP allowlist with the provider if egress IP changed.
3. For deprecated API versions: update the connector to the current version; validate with a
   smoke test before replaying.
4. Replay affected exchanges after the policy constraint is resolved.

---

## Replay safety

Before replaying any exchange:

1. Confirm the root cause is resolved (credentials rotated, mapping fixed, policy resolved).
2. Check whether the provider supports idempotent delivery using the original `idempotency_key`.
   The replay function intentionally clears `idempotency_key` on the new delivery event row to
   force a fresh key to be generated by the connector; the connector must set this before delivery.
3. For outbound exchanges that modify provider state (orders, payments), manually verify the
   exchange was not partially applied before replaying.
4. Check `v_smartequip_reconciliation_summary` to confirm the volume of affected exchanges is
   consistent with the failure window — unexpected gaps may indicate additional dropped events not
   yet in the DLQ.

---

## Reconciliation gap detection

Use `v_smartequip_reconciliation_summary` to detect drift:

```sql
-- Identify days/flows with delivery success below 95%
select
  tenant_id,
  flow_name,
  object_scope,
  period_day,
  unique_exchanges,
  delivery_success_pct,
  failure_count
from v_smartequip_reconciliation_summary
where delivery_success_pct < 95
  and object_scope in ('work_orders', 'service_requests', 'parts_orders')
  and period_day >= current_date - interval '7 days'
order by delivery_success_pct asc;
```

Expected gaps:

- Duplicate exchanges (`failure_class = 'duplicate'`) are expected and do not indicate data loss.
- Replays (`delivery_status = 'replayed'`) inflate `total_attempts` but are accounted for
  separately in `replay_count`.

Unexpected gaps:

- A sudden drop in `unique_exchanges` for an active flow may indicate missed inbound webhooks or
  a broken outbound polling schedule.
- A rising `failure_count` without a corresponding `replay_count` means DLQ entries are
  accumulating without operator action.

---

## Test coverage

| Layer | Tests |
|---|---|
| Frontend contract | `frontend/src/test/smartequip-delivery-contract.test.ts` |
| Supabase schema / RLS | `supabase/tests/smartequip_delivery_observability.sql` |
| Supabase reset-path validation | `supabase/tests/smartequip_delivery_observability_reset.sql` + `supabase/tests/run_smartequip_delivery_observability_reset.sh` |
| Supabase schema runner | `supabase/tests/run_smartequip_delivery_observability.sh` |

---

## First connector dependency

This observability surface is intentionally connector-neutral.  The first end-to-end proof is the
SmartEquip connector adapter delivered under issue #482, which will emit delivery events into
`smartequip_delivery_events` and call the operator RPCs from its activity layer.
