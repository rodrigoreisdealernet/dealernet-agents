# ADR-0049: Inventory item-type reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-12
- **Deciders:** Tech Review, Platform, Copilot
- **Supersedes / Superseded by:** N/A

## Context
PR #1174 merged `supabase/migrations/20260611100000_inventory_item_type_model.sql` with frontend and SQL regression coverage but without a clean-reset migration validation job.  The migration introduces `create_stock_item` RPC, `inventory_kind_guard`, fact-type seeds, and `rental_current_stock_items` view — none of which had a CI gate proving they survive `supabase db reset` from a blank database.

The risk is reset-path drift: behavior validated only against an already-evolved database can break silently on a fresh schema rebuild, leaving the regression undiscovered until a new environment is provisioned or a later migration conflicts.

## Decision
We add a named, required CI job `supabase-inventory-item-type-reset` to `.github/workflows/pr-validation.yml`.  The job runs `bash supabase/tests/run_inventory_item_type_model_reset.sh`, which performs a full `supabase db reset` and then asserts:

1. `create_stock_item`, `inventory_kind_guard`, and `rental_current_stock_items` exist in the rebuilt schema.
2. `stock_opening_balance` and `stock_quantity_adjustment` fact types are seeded.
3. `inventory_kind_guard` correctly accepts `bulk/sale/part + stock_item` and rejects `serialized + stock_item`.
4. `create_stock_item` succeeds for all three non-serialized kinds with correct entity, version, relationship, and opening-balance TSP writes.
5. `rental_current_stock_items` surfaces the created items.

## Consequences
- Fresh-schema regressions in the inventory item-type migration path fail PR validation before merge.
- The PR workflow gains one more required Supabase reset-path job, adding to CI runtime.
- Future changes to `20260611100000_inventory_item_type_model.sql` or dependent migrations must keep the reset-path assertions green unless a superseding ADR replaces this gate.

## Alternatives considered
- Rely on manual `supabase db reset` checks only — rejected because it is easy to skip and does not protect main.
- Fold assertions into the existing `supabase-inventory-item-type` job — rejected because that job uses a throwaway Docker Postgres container, not the Supabase CLI reset path, and cannot prove clean-reset compatibility.

## Evidence
- `.github/workflows/pr-validation.yml`
- `supabase/tests/inventory_item_type_model_reset.sql`
- `supabase/tests/run_inventory_item_type_model_reset.sh`
- `supabase/migrations/20260611100000_inventory_item_type_model.sql`
- Issue #1218 (`Add tests for Inventory: item-type model (serialized/bulk/sale/part) + guided input forms`)
