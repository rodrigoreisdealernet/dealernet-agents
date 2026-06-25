# SPEC: Dashboard Estoque de Veículos & Floor Plan (Fast BI)

**STATUS: DRAFT — Requires human approval before implementation**

_Issue: #19 — feat(frontend): dashboard Estoque de Veículos & Floor Plan (Fast BI)_

## Overview

Build a Fast BI dashboard that displays vehicle inventory age, floor-plan
financing costs, and the critical (oldest) stock items so a dealer can act on
aging vehicles. The dashboard reads from `v_dia_inventory_summary` (in-stock
vehicles aggregated by age band, brand and store) and `v_dia_vehicle_current`
(individual vehicles with a derived `floor_plan_cost` and `days_in_stock`). It
is reached via a new "Estoque de Veículos" menu item under the **Fast BI**
section of the portal menu.

## Problem / Context

**Floor plan** is the financing interest carried on each unsold vehicle from
purchase until sale; in the views it is derived as
`cost * (0.13 / 365) * days_in_stock` (13% annual demo rate). A vehicle sitting
in the lot quietly erodes margin, so the dashboard must surface where that cost
is concentrated:

- **KPIs** — total inventory value, total floor-plan cost, average days in
  stock, and the count of vehicles parked for more than 90 days.
- **Age bands** — vehicles grouped into `0-30`, `31-60`, `61-90`, `90+` days,
  with floor-plan cost and inventory value, plus a breakdown by brand/store.
- **Action list** — the oldest vehicles ranked by `floor_plan_cost` (highest
  first) so the sales team knows what to move first.

The real frontend is `frontend-portal/` (native React screen registry, menu
driven). A new screen is added as a component in
`frontend-portal/src/portal/renderers/screens/`, registered by `componentKey`
in `registry.ts`, and surfaced through the `MOCK_MENU` in `portalApi.ts`
(there is no react-router and no `/dia/...` route). The pattern mirrors the
existing Fast BI screens (`PartsBI.tsx`, `SalesDashboard.tsx`) using the shared
`KpiCard`/`ScreenShell` widgets from `ui.tsx` and the `ChartCard` widget. The
views `v_dia_inventory_summary` and `v_dia_vehicle_current` already exist in the
shipped migrations.

## Acceptance Criteria

- [ ] **A new "Estoque de Veículos" dashboard is reachable from the Fast BI
  section of the menu** — selecting it opens the vehicle-inventory dashboard
  screen (component registered in `registry.ts`, menu entry added under the Fast
  BI group in `portalApi.ts`).
- [ ] **Four KPI cards appear at the top**: total inventory value (BRL), total
  floor-plan cost (BRL), average days in stock (whole number), and the number of
  vehicles in stock for more than 90 days — each populated from the inventory
  views.
- [ ] **An age-band chart** shows the four bands (`0-30`, `31-60`, `61-90`,
  `90+`) on the x-axis with floor-plan cost per band (currency), so older bands
  are visibly costlier; a second view/series shows inventory value (or
  floor-plan cost) broken down by brand/store.
- [ ] **An "oldest vehicles" action list** shows in-stock vehicles
  (`status = 'em_estoque'`) sorted by `floor_plan_cost` descending, displaying at
  least: vehicle identity (brand + model + year), days in stock, floor-plan cost
  (BRL) and store.
- [ ] **With the seed data, the dashboard validates end to end**: the age-band
  chart shows floor-plan cost increasing toward the older bands, and the oldest
  vehicles list is led by the aged vehicles present in the mock dataset.
- [ ] **The screen degrades gracefully** — while data loads it shows a loading
  state, and if a view returns no rows it shows an empty state rather than
  crashing.

## Non-Goals

- Changing or exposing the floor-plan rate (stays at the 0.13/365 demo constant;
  no tenant configuration UI).
- Historical / time-series floor-plan trends — this is a current snapshot only.
- Any write actions (selling, rebalancing, editing a vehicle) — the dashboard is
  read-only; vehicle edits stay in the existing vehicle CRUD screen.

## Out-of-Scope

- Parts / estoque de peças — covered by its own dashboard (#18).
- Tenant-configurable floor-plan rates — hardcoded demo constant for now.
- New database views or migrations — this change consumes the existing
  `v_dia_inventory_summary` and `v_dia_vehicle_current` views as-is.

---

**This is a DRAFT spec. It requires human approval before any implementation
begins.**
