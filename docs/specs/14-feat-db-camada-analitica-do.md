# Spec — feat(db): camada analítica do Fast BI (views agregadas + fact_types)

**Issue:** #14
**Status:** Auto-approved (batch).

## Overview

Create the Fast BI analytics layer: a set of aggregated SQL views (and any
required `fact_types`) that dashboards #15–#18 will bind to. The views cover the
owner KPI snapshot, VN/VU sales, service (oficina), inventory/floor plan and
parts. They are read-only, `security_invoker = true`, with clean and stable
column names.

## Problem / Context

The dashboards (#15–#18) need a stable, named contract to bind against. Today
this analytical layer does not exist. This issue runs **in parallel** with its
data-source siblings: in this branch **only the `vehicle` entity exists**
(`v_dia_vehicle_current`, `entity_type = 'vehicle'` in
`rental_current_entity_state`). The service/oficina (#7), parts (#8) and
parts-sales (#10) entity types are **not yet** in the catalog or seed.

Therefore the analytics layer must light up the vehicle-derived numbers from
real seeded data **now**, while authoring service- and parts-derived
views/columns **defensively** so they return zero rows / zero totals today
(no errors) and populate automatically when the sibling issues merge. The owner
KPI view must always return exactly one complete (non-null) row.

The work follows the analytics conventions already in the repo:
`v_home_dashboard_kpis` (single-row KPI snapshot pattern,
`supabase/migrations/20260606152000_home_dashboard_kpis.sql`) and the
`fact_types` table from `analytics_foundation`
(`supabase/migrations/20251203090000_analytics_foundation.sql`, columns:
`key`, `label`, `description`, `unit`).

Grounding facts confirmed in this branch:
- `v_dia_vehicle_current` exposes: `condition` (`novo`/`usado`), `brand`,
  `model`, `model_year`, `cost`, `sale_price`, `purchase_date`, `status`
  (`em_estoque`/`vendido`), `store`, `days_in_stock`, `floor_plan_cost`,
  plus `valid_from`, `updated_at`
  (`supabase/migrations/20260625130000_dia_vehicle_entity_crud.sql`).
- Seed has 12 vehicles (6 novo + 6 usado). Sale-date derivation must fall
  back to `valid_from`/`updated_at` when `data->>'sold_at'` is absent.

## Acceptance Criteria

- [ ] A dealership owner opening the dashboard sees a **single-row** KPI summary
  (`v_dia_owner_kpis`) with **no null values**: month sales (units and R$ for
  VN+VU), month margin, open service orders, service revenue and average
  turnaround, vehicle inventory value, total floor plan, average days in stock,
  parts inventory value, and critical-parts count. When service and parts data
  are absent, every such metric reads `0` (never null, never missing the row).
- [ ] A sales view (`v_dia_sales_summary`) breaks sales down by month,
  condition (novo/usado = VN/VU), brand and store, returning units, revenue,
  margin and average days-to-sell, computed from vehicles with `status =
  'vendido'`.
- [ ] A sales trend view (`v_dia_sales_trend`) returns a daily time series over
  the trailing ~90 days of sold-vehicle units and revenue suitable for a line
  chart, with no error when a day has no sales.
- [ ] A service view (`v_dia_service_summary`) groups service orders by status
  and period with count, revenue and average turnaround; it returns **zero rows**
  gracefully today (no service_order data) and populates once #7 merges.
- [ ] An inventory view (`v_dia_inventory_summary`) buckets in-stock vehicles by
  age band (0–30, 31–60, 61–90, 90+ days) with count, value and floor-plan cost,
  drillable by brand and store, and matches the seeded in-stock vehicles.
- [ ] A parts view (`v_dia_parts_summary`) reports parts inventory value by
  stock status and parts-sales by period (units, revenue); it returns **zero
  rows / zero totals** gracefully today and populates once #8/#10 merge.
- [ ] All new views are created with `security_invoker = true`, have stable
  documented column names, and do not break or rename any existing migration.
- [ ] Required `fact_types` are inserted idempotently (insert where not exists /
  on conflict do nothing) without disturbing existing `fact_types` rows.

## Testable contract

The migration must produce exactly these views and columns (names are
load-bearing — dashboards bind to them).

### `v_dia_owner_kpis` — exactly 1 row, all columns non-null (coalesce to 0)
- `as_of` — timestamp the snapshot was computed.
- `sales_units_month` — count of vehicles sold in the current month (VN+VU).
- `sales_revenue_month` — sum of `sale_price` of vehicles sold this month.
- `margin_month` — sum of (`sale_price` - `cost`) of vehicles sold this month.
- `service_orders_open` — count of open service orders (0 today).
- `service_revenue_month` — service revenue this month (0 today).
- `service_avg_turnaround` — average service turnaround (0 today).
- `inventory_vehicle_value` — sum of `cost` of in-stock vehicles.
- `floor_plan_total` — sum of `floor_plan_cost` of in-stock vehicles.
- `avg_days_in_stock` — average `days_in_stock` of in-stock vehicles (0 if none).
- `parts_inventory_value` — value of parts inventory (0 today).
- `parts_critical_count` — count of critical parts (0 today).

### `v_dia_sales_summary` — one row per (period, condition, brand, store)
- `period_month` — month bucket (first day of month) of the sale.
- `condition` — `novo` (VN) or `usado` (VU).
- `brand` — vehicle brand.
- `store` — selling store.
- `units_sold` — count of sold vehicles in the group.
- `revenue` — sum of `sale_price`.
- `margin` — sum of (`sale_price` - `cost`).
- `avg_days_to_sell` — average days from `purchase_date` to sale date, where sale
  date = `data->>'sold_at'` if present else `valid_from`/`updated_at`.

### `v_dia_sales_trend` — one row per day over trailing ~90 days
- `sale_date` — calendar day.
- `units_sold` — vehicles sold that day.
- `revenue` — sum of `sale_price` that day.

### `v_dia_service_summary` — one row per (status, period); 0 rows today
- `period_month` — month bucket.
- `status` — service order status.
- `orders_count` — count of service orders.
- `revenue` — service revenue in the group.
- `avg_turnaround` — average turnaround for the group.

### `v_dia_inventory_summary` — one row per (age_band, brand, store)
- `age_band` — one of `0-30`, `31-60`, `61-90`, `90+`.
- `brand` — vehicle brand.
- `store` — store.
- `vehicles_count` — count of in-stock vehicles in the bucket.
- `inventory_value` — sum of `cost`.
- `floor_plan_cost` — sum of `floor_plan_cost`.

### `v_dia_parts_summary` — parts inventory by stock_status + sales by period; 0 rows today
- `stock_status` — parts stock status (e.g. ok/low/critical); null for sales rows.
- `inventory_value` — value of parts inventory for that stock status.
- `period_month` — month bucket for parts-sales rows; null for inventory rows.
- `units_sold` — parts units sold in the period.
- `revenue` — parts-sales revenue in the period.

### `fact_types` keys to insert (idempotent)
- `vn_units_sold` — label "VN Units Sold", unit `count`.
- `vn_revenue` — label "VN Revenue", unit `BRL`.
- `vu_units_sold` — label "VU Units Sold", unit `count`.
- `vu_revenue` — label "VU Revenue", unit `BRL`.
- `service_revenue` — label "Service Revenue", unit `BRL`.
- `parts_sales_revenue` — label "Parts Sales Revenue", unit `BRL`.

### Defensive-derivation rule (applies to service & parts)
Service/parts-derived views and KPI columns must read from
`rental_current_entity_state` filtered by the anticipated `entity_type` names
(`'service_order'`, `'part'`, `'parts_sale'`) and their JSON fields, returning
zero rows / zero totals today without error, and populating automatically when
the sibling issues seed those entity types.

## Non-Goals

- Building the dashboard UI or any front-end binding (that is #15–#18).
- Seeding or modeling the service_order / part / parts_sale entity types (#7/#8/#10).
- Adding write paths, RPCs, or RLS changes — these are read-only analytic views.
- Performance tuning beyond what the existing entity model already provides.

## Out-of-Scope

- Modifying `v_dia_vehicle_current` or the vehicle CRUD migration.
- Changing the `fact_types` / `entity_facts` / `time_series_points` schema.
- Cross-tenant / org-hierarchy roll-ups beyond brand/store/period drilldowns.
- Currency conversion or multi-currency normalization of revenue.
