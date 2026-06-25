# ADR-0050: Procurement receiving, PO matching, and warranty data model

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Copilot, Tech Review
- **Supersedes / Superseded by:** N/A

## Context

Issue #1234 (child of epic #453) extends the procurement domain with three capabilities that are absent from the existing PO lifecycle migration (#1233):

1. **Granular goods-receipt tracking** — the existing `procurement_transition_purchase_order` `receive` action updates a single cumulative `received_quantity` field on the PO entity, but does not record individual delivery lines. Multiple partial shipments need separate, queryable records with delivery-note references and condition notes.

2. **Two-way and three-way PO matching** — comparing ordered quantity vs received quantity (two-way) and additionally comparing invoiced quantity, unit price, and total against PO and receipt data (three-way) is a standard AP control. Discrepancies must be surfaced explicitly and must block downstream completion (payment approval, asset commissioning) until a reviewer resolves or escalates them.

3. **Warranty metadata capture** — purchased assets and parts often ship with supplier warranties that need to be queryable from the operational asset record to support maintenance and claim decisions.

The generic entity model (SCD2 in `entity_versions`) is not well-suited for these: receipts and invoices are independent documents with their own lifecycle, not properties of the PO entity; match outcomes are derived artefacts; warranties are facts about the asset, not the order. Dedicated relational tables are appropriate here.

## Decision

We add a new migration `20260613020000_procurement_receiving_po_match_warranty.sql` that introduces four purpose-built tables:

- **`procurement_receipts`** — one row per goods-receipt event, linked to the PO. `receipt_number` is auto-generated (`GRN-YYYYMMDD-NNNNN`). The RPC `procurement_record_receipt` inserts a row and calls the existing `procurement_transition_purchase_order('receive', …)` with the updated cumulative total so PO status projection remains consistent.

- **`procurement_supplier_invoices`** — one row per supplier invoice per PO, capturing quantity, unit price (optional), and total.

- **`procurement_po_match_outcomes`** — one row per match run. `hold_downstream = true` when discrepancies are found. `procurement_resolve_match_discrepancy` records review decisions and clears the hold for `accepted`/`rejected` resolutions; `escalated` keeps the hold. The `discrepancy_details` column is a `jsonb` array of structured discrepancy objects with `type`, `dimension`, and `variance` fields.

- **`procurement_warranty_records`** — warranty metadata (provider, serial number, start/end dates, type, terms, document reference) linked to any entity (typically `asset` or `stock_item`) and optionally back-linked to the originating PO and receipt. The view `v_procurement_warranty_records` computes `is_in_warranty` and `days_remaining` at query time.

All tables carry RLS policies (admin/branch_manager write; all authenticated roles read; service_role full access). All RPCs use `security definer` with explicit JWT-role checks consistent with existing procurement RPCs.

Three new fact types (`po_receipt_event`, `po_match_event`, `warranty_event`) are seeded into `fact_types` so audit events land in `time_series_points` on the PO or asset entity, preserving the durable-event pattern used across the platform.

## Consequences

- **Downstream completion holds** — any workflow or UI that moves a PO past receipt (e.g., releasing payment, commissioning an asset) must check for open `hold_downstream = true` match outcomes before proceeding. The `v_procurement_po_match_outcomes` view surfaces held outcomes per PO.
- **Receipt–PO coupling** — `procurement_receipt` rows reference `entities(id)` with `on delete restrict`; a PO entity cannot be deleted while receipts exist. This is intentional and consistent with other domain FK constraints.
- **Warranty queryability** — warranties on any entity (asset, stock item) are now reachable via `v_procurement_warranty_records` filtered by `entity_id` or `purchase_order_id`.
- **No schema change to existing PO entity** — PO status projection logic and audit events in `time_series_points` are unchanged. The new tables are additive.
- **CI gate** — `run_procurement_receiving_po_match_warranty.sh` covers 15 behavioral assertions including partial/full receipt, two-way and three-way match, discrepancy hold/resolution, warranty attachment and view query, and negative-path rejections.

## Alternatives considered

- **Storing receipts in `entity_versions` as a new `receipt` entity type** — rejected because the receipt lifecycle is tightly coupled to the PO and adding a new entity type adds indirection without benefit for a document that does not independently participate in the SCD2 history model.
- **Encoding match outcomes in PO entity data (jsonb)** — rejected because a PO can have multiple match runs (re-run after partial receipt then full receipt), each with a separate discrepancy array. A dedicated table avoids unbounded jsonb growth and enables efficient queries on `hold_downstream`.
- **Storing warranty in entity `data` jsonb** — rejected because warranties outlive the order event, are queryable across many assets, and need structured expiry/type filtering that benefits from relational columns and indexes.

## Evidence

- `supabase/migrations/20260613020000_procurement_receiving_po_match_warranty.sql`
- `supabase/tests/procurement_receiving_po_match_warranty.sql`
- `supabase/tests/run_procurement_receiving_po_match_warranty.sh`
- Parent migration: `supabase/migrations/20260612195000_procurement_purchase_order_lifecycle.sql`
- Issue #1234
- Epic #453
