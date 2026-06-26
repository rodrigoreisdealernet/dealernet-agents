# Spec — Morning Queue no longer shows orphaned findings after a DB reseed (#72)

## Overview
After a database reseed, the **Morning Queue (Findings)** and the Morning Brief's **"DIA preparou estas ações"** card display phantom items that point at vehicles which no longer exist. This change makes a reseed leave behind a clean queue, and makes the vehicle-aging routine stop surfacing findings for vehicles that are no longer in scope, so operators only ever see real, actionable items.

## Problem / Context
Vehicle-aging findings are anchored to a vehicle by `finding.contract_id`, which holds the vehicle's `entities.id` (a UUID). On each reseed, `seed.sql` deletes and re-inserts vehicle entities, so they receive **new** UUIDs. Findings created in earlier runs keep pointing at the old (now-deleted) UUIDs, becoming orphans.

Because `ops_findings_view` joins to the current vehicle entity with a `left join` (no valid-join requirement), these orphaned rows still appear in the queue — only with a blank vehicle/contract label. The portal (`getFindings` → `ops_findings_view`, filtered to `status='pending_approval'`) and the Morning Brief therefore show an inflated count of unactionable, label-less items. The approved fix has two parts: (A) make `seed.sql` idempotently remove orphaned findings; (B) make the `ops_vehicle_aging` worker ignore/expire findings for vehicles no longer in scope.

## Acceptance Criteria
- [ ] After a database reseed, the Morning Queue (Findings) contains **no** items whose referenced vehicle no longer exists (zero orphaned rows surfaced via `ops_findings_view`).
- [ ] After a reseed, the Morning Brief **"DIA preparou estas ações"** card count matches the number of real, current findings — phantom/label-less items are not counted.
- [ ] Running the seed routine repeatedly is safe and stable: a second consecutive reseed produces the same clean result and never errors on already-clean data (idempotent).
- [ ] When the vehicle-aging routine runs and a vehicle that previously produced a finding is no longer in scope (e.g. removed/replaced), that vehicle's existing finding is no longer presented as a pending action.
- [ ] A finding that **does** reference a current, in-scope vehicle remains visible and unchanged in the Morning Queue after a reseed and after the vehicle-aging routine runs (no false removals).

## Non-Goals
- Changing how findings are scored, prioritized, or sorted in the queue.
- Adding a foreign-key constraint between `finding.contract_id` and `entities`/vehicles.
- Altering the visual design or copy of the Morning Queue or the "DIA preparou estas ações" card.
- Preserving findings across reseeds by re-mapping old vehicle UUIDs to new ones.

## Out-of-Scope
- Orphan cleanup for non-vehicle finding types (e.g. rental-contract revenue-recognition findings) beyond what the shared cleanup naturally covers.
- Reworking the `ops_findings_view` join semantics for other consumers (KPIs, audit trail).
- Production data-migration tooling; this change targets the reseed/dev path and the worker's scope reconciliation.
- Broader seed.sql redesign or eliminating delete-and-reinsert churn of entity UUIDs.

---

> **STATUS: DRAFT — requires human approval before any code is written.**
