# Inventory & Asset Management

**Status:** Approved for implementation
**Owner:** Engineering
**Related issues:** #430 (epic), #1119 (story)
**ADR References:** ADR-0024 (authenticated write RPC boundary)

## Overview

This specification defines the inventory-kind model, entity boundaries, and guided
create/edit behavior for the four inventory classifications in the equipment rental ERP.

## Inventory Kind Taxonomy

| Kind | Entity type | Unit of tracking | Lifecycle rules |
|------|-------------|-----------------|-----------------|
| `serialized` | `asset` | One row per physical unit | Full asset lifecycle: available → on_rent → returned → inspection_hold → maintenance |
| `bulk` | `stock_item` | Quantity counter per branch | No per-unit lifecycle; quantity adjusted via time-series |
| `sale` | `stock_item` | Quantity counter per branch | No per-unit lifecycle; sale reduces quantity |
| `part` | `stock_item` | Quantity counter per branch | No per-unit lifecycle; work-order consumption reduces quantity |

**Key constraint:** Serialized items **must** be `asset` entities. Bulk, sale, and part
items **must** be `stock_item` entities. Creating a per-unit asset row for a bulk/sale/part
item is an invalid pattern — do not do this.

## Entity & Relationship Catalog

### stock_item

Stored in `entities` with `entity_type = 'stock_item'`.

Current state in `entity_versions.data` (JSONB):

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Required |
| `inventory_kind` | string | Required; one of: `bulk`, `sale`, `part` |
| `description` | string | Optional |
| `operational_status` | string | `available`, `discontinued` |

### Relationships

| Type | Parent | Child | Notes |
|------|--------|-------|-------|
| `branch_has_stock_item` | `branch` | `stock_item` | One active branch per stock item |
| `asset_category_has_stock_item` | `asset_category` | `stock_item` | One active category per stock item |

Both relationship types use the `rental_enforce_single_asset_assignment` trigger (see
`20260610113500_inventory_attribute_projection.sql`) to enforce single-current-assignment.

### Quantity State

Quantity is **not** stored in `entity_versions.data` as a mutable counter. Instead:

- **Opening balance**: a `time_series_points` row with `fact_type.key = 'stock_opening_balance'`
  is written when the item is created.
- **Adjustments**: subsequent changes use `fact_type.key = 'stock_quantity_adjustment'` with a
  signed delta (`positive = receipt, negative = consumption`).

Current on-hand quantity = opening balance + sum of all adjustments.

## Write Path

All writes go through the `create_stock_item` RPC (security definer) in
`20260611100000_inventory_item_type_model.sql`. The RPC:

1. Validates `inventory_kind` ∈ `{bulk, sale, part}` — rejects `serialized`.
2. Validates name is non-empty.
3. Validates branch and asset_category IDs refer to the correct entity types (if supplied).
4. Creates `entity` + `entity_version` (SCD2 pattern).
5. Creates `branch_has_stock_item` relationship (if branch_id supplied).
6. Creates `asset_category_has_stock_item` relationship (if category_id supplied).
7. Records opening balance `time_series_points` row (if `opening_quantity > 0`).

The `inventory_kind_guard(p_inventory_kind, p_entity_type)` function provides a stable
validation surface for frontend pre-flight checks.

## Read / Projection Surfaces

| View / RPC | Description |
|------------|-------------|
| `rental_current_stock_items` | Current-state stock items with inventory_kind metadata |
| `rental_current_inventory_records` | Unified inventory view covering both `asset` and `stock_item` with branch/category assignments and inventory_kind |
| `v_storefront_asset_catalog` | Storefront-facing catalog (includes stock items with `inventory_entity_type` discriminator) |

## Guided Input Form Rules

The frontend create/edit form **must**:

1. Show an **Inventory Kind** selector (options: Serialized / Bulk / Sale / Part).
2. Route `serialized` to the `asset` create flow (identifier, make, model, asset
   lifecycle fields).
3. Route `bulk`, `sale`, `part` to the `stock_item` create flow (description, opening
   quantity — no identifier, no maintenance/transfer fields).
4. Prevent submission when required fields for the selected kind are missing.
5. Never show maintenance, inspection, or transfer fields for `stock_item` kinds.

## Non-Goals

- Full accounting integration for cost-of-goods-sold or FIFO/LIFO valuation.
- Per-serial-number tracking within a `stock_item` — that belongs on `asset`.
- Barcode scanning or IoT telemetry integration (future story).
