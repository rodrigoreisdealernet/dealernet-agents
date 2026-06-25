# ADR-0052: Re-rent Shared Visibility Boundary

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** copilot (closes #1262)
- **Supersedes / Superseded by:** none

## Context

When a rental order line cannot be fulfilled from internal stock, operators route it to an external vendor as a re-rent. Multiple audiences need to track that unit in real time:

- **Internal facility operators** (admin / branch_manager) need full visibility including vendor references (purchase-order numbers, vendor confirmation codes) so they can manage the handoff.
- **Job-site users** (field_operator) need to know where the unit is in the lifecycle (requested → on-rent → returned) but must not see internal vendor financials or cross-tenant data.
- **Vendor-side users** (future) interact through the same status log.

Prior to this ADR, rerent status lived as an unstructured `rerent_fulfillment_status` string embedded in the JSONB `data` column of the `entity_versions` row for the order line. This approach:

- Had no timeline/audit trail (each update overwrote the previous state).
- Had no formal state machine (arbitrary string values).
- Gave all authenticated users the same view with no audience differentiation.
- Could not be queried efficiently by status across lines.

## Decision

We introduce a dedicated `rerent_unit_status_log` fact table (write-once, one row per transition) and a `dim_rerent_unit_status` dimension for the six lifecycle states. A security-invoker view `v_rerent_unit_current_status` derives current status per line and masks vendor-sensitive columns (`vendor_ref`) for field_operator and read_only callers. Row-level security on the log table limits reads and writes to the caller's tenant, preventing cross-tenant leakage.

The canonical lifecycle is: **requested → awarded → dispatched → on_rent → return_in_transit → returned**.

The existing `rerent_fulfillment_status` field in order-line JSONB is not removed; it continues to carry the order-routing state (pending_vendor_confirmation, vendor_confirmed, …). The new log tracks the physical unit lifecycle separately.

## Consequences

**Easier:**
- Full audit trail for every unit state change, with actor attribution and timestamp.
- Audience-safe queries: job-site users see lifecycle status without accessing vendor references.
- Cross-tenant isolation enforced at the database level, not the application layer.
- Future vendor-portal integration can write to the log without modifying order-line JSONB.

**Harder / trade-offs accepted:**
- Two status concepts now exist: `rerent_fulfillment_status` (order-routing) and `rerent_unit_status_log` (physical unit lifecycle). Operators need to understand both.
- The V1 UI displays current unit status inline on the line card; a dedicated timeline view is deferred to a follow-up story.
- `vendor_ref` masking is role-based at the view level; a future iteration should add column-level grants for finer control.

**New obligations:**
- Writers must insert a new row to the log rather than updating existing rows; the view derives current status via `row_number() … order by changed_at desc`.
- Any background workflow that transitions unit status must carry a meaningful `changed_by` value (user ID or system label) and the caller's tenant slug.

## Alternatives considered

1. **Extend the existing JSONB `rerent_fulfillment_status` field with a history array** — rejected because JSONB arrays are hard to query efficiently, offer no row-level security, and cannot carry actor attribution natively.
2. **Add a `rerent_unit_status` column to `entity_versions`** — rejected because it couples the lifecycle state to the SCD2 version snapshot, preventing independent status updates without creating a new entity version.
3. **A single view with no audience masking** — rejected because vendor references (PO numbers, confirmation codes) must not be visible to job-site users per the acceptance criteria.

## Evidence

- Migration: `supabase/migrations/20260613140000_rerent_unit_shared_status.sql`
- Dimension table: `dim_rerent_unit_status`
- Fact table: `rerent_unit_status_log` (RLS enabled, tenant-scoped)
- View: `v_rerent_unit_current_status` (security_invoker, masks `vendor_ref` for field_operator/read_only)
- Frontend helper: `formatRerentUnitStatus` in `frontend/src/engine/ExpressionEvaluator.ts`
- UI: `frontend/src/pages/rental-order-detail.json` — unit status badge on line cards
- Tests: `frontend/src/engine/ExpressionEvaluator.test.ts`, `frontend/src/test/rental-order-screens.test.tsx`
