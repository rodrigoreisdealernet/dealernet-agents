# Spec — feat: Ordem de Serviço (Oficina) — entidade + CRUD (issue #7)

## Overview

Add a new business entity **`service_order`** (workshop service order, "Oficina") on the generic SCD2 model (`entities` + `entity_versions.data` JSONB), with a complete CRUD vertical slice: a new migration (entity_type registration, hardened write RPCs, RLS, read view), idempotent demo seed data, and a UIEngine screen at `/dia/service-orders`. Mirrors the vehicle slice shipped in issue #4.

## Problem / Context

The DIA pilot needs an "Oficina" (workshop) view. Issue #4 established the reusable, hardened CRUD pattern for the first dealership entity (`vehicle`). This issue applies the same vertical slice to service orders so the workshop can register, list, edit, and cancel service orders, with reads served by a `security_invoker` view and all writes funneled through guarded `SECURITY DEFINER` RPCs.

### Grounding — actual files that define the pattern (verified in repo)

- **Vehicle migration (template to mirror):** `supabase/migrations/20260625130000_dia_vehicle_entity_crud.sql` — registers entity_type in the `rental_entity_type_catalog` VALUES view; defines `dia_assert_vehicle_writer()` (role guard: `service_role` OR `authenticated` + `get_my_role() in (admin, branch_manager)`, denies with `42501`), `dia_validate_vehicle_data()`, `create_vehicle`/`update_vehicle`/`delete_vehicle` (delete = soft-delete via new SCD2 version), and the `v_dia_vehicle_current` view (`security_invoker = true`). All RPCs `revoke all from public` then `grant execute to authenticated, service_role`.
- **Vehicle frontend screen (template to mirror):** `frontend-portal/src/portal/renderers/screens/VehiclesInventory.tsx`.
- **UIEngine component registry:** `frontend-portal/src/portal/renderers/registry.ts` (key `'dia-vehicles'`).
- **Nav / menu config:** `frontend-portal/src/portal/lib/portalApi.ts` — `MOCK_MENU` array, `dealership` group.
- **Client data/RPC layer:** `frontend-portal/src/portal/lib/agentsApi.ts` — `getVehicles()`, `createVehicle`/`updateVehicle`/`deleteVehicle`, types `VehicleRow`/`VehicleInput`.
- **Seed:** `supabase/seed.sql` — vehicle demo block, idempotent namespace `source_record_id LIKE 'demo-dia-vehicle-%'`.
- **Contract test pattern:** `supabase/tests/vehicle_crud.test.mjs` — node:test against live Postgres, each scenario in `BEGIN; … ROLLBACK;`.

## Entity `service_order` — fields in `entity_versions.data`

`order_number`, `customer` (text), `vehicle` (text/plate), `description`, `status` (`aberta` | `em_andamento` | `concluida` | `cancelada`), `opened_at`, `closed_at` (nullable), `revenue` (numeric), `technician` (text).

## Acceptance Criteria

- [ ] **AC1 — Entity type registered & writes guarded.** A new timestamped migration registers `service_order` as a valid entity_type and exposes hardened write RPCs `create_service_order(p_data jsonb)`, `update_service_order(p_entity_id uuid, p_data jsonb)`, and `delete_service_order(p_entity_id uuid)`. A caller acting as `admin` or `branch_manager` can create, update, and delete; a `read_only` caller is rejected with SQLSTATE `42501`. `GRANT EXECUTE` present for `authenticated` and `service_role`.
- [ ] **AC2 — Reads allowed, direct writes blocked.** Any `authenticated` user can read service orders via the view, but a direct client `INSERT`/`UPDATE`/`DELETE` against the underlying tables is blocked by RLS. The RPC path succeeds.
- [ ] **AC3 — Status is validated.** Creating or updating a service order with a `status` outside {`aberta`, `em_andamento`, `concluida`, `cancelada`} is rejected; a valid one succeeds.
- [ ] **AC4 — Cancel is a soft-delete.** `delete_service_order` does not physically remove rows; it appends a new SCD2 version with `status = 'cancelada'` (preserving history) and the order no longer appears as active in the current view.
- [ ] **AC5 — Current view with derived turnaround.** The view `v_dia_service_order_current` (`security_invoker = true`, `GRANT SELECT` to `authenticated`, `service_role`) lists current orders with all fields plus a derived `turnaround_hours` computed from `opened_at`→`closed_at` for `concluida` orders (null otherwise). After `db reset`, concluded orders return non-null `turnaround_hours`; non-concluded return null.
- [ ] **AC6 — Workshop screen at `/dia/service-orders`.** A UIEngine screen lists service orders and lets a user create, edit, and cancel them via the RPCs, displaying at least `status`, `revenue`, `opened_at`, and `turnaround_hours`. A menu item appears under the Oficina/Concessionária group, wired through the component registry.
- [ ] **AC7 — Idempotent demo seed.** The seed inserts ~10 demo service orders (`source_record_id LIKE 'demo-dia-service-%'`) with a mix of statuses spread across the current and previous month, idempotent across resets, including at least one `concluida`.

## Non-Goals

- No formal relational link between a service order and a `vehicle`/`customer` — both remain plain text fields in `data`.
- No detailed parts/inventory consumption or itemized labor lines.
- No new user roles; reuse the `admin`/`branch_manager`/`read_only` guard from the vehicle pattern.

## Out-of-Scope

- Aggregated workshop KPIs and any briefing/dashboard section for service orders.
- Reporting/exports/analytics beyond `v_dia_service_order_current`.
- Editing the already-shipped vehicle migration or screen.

## Notes / Discrepancies vs. issue hints

1. The issue references `frontend/src/...`; the live frontend is `frontend-portal/` and screens live at `frontend-portal/src/portal/renderers/screens/`.
2. There is no `nav-config.ts`; the menu is `MOCK_MENU` in `frontend-portal/src/portal/lib/portalApi.ts`, plus a `componentKey` entry in `registry.ts`.
3. `create_stock_item` was pruned; the authoritative pattern to mirror is the vehicle migration's `dia_assert_vehicle_writer()` + `create/update/delete_vehicle`.
4. Entity_type registration re-creates the `rental_entity_type_catalog` `security_invoker` VALUES view with `'service_order'` appended.
