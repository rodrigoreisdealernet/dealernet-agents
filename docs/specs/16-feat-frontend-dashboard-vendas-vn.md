# Spec — Dashboard "Vendas (VN/VU)" (Fast BI) — Issue #16

## Overview
Add a read-only "Vendas (VN/VU)" dashboard to the DIA portal's Fast BI area. It shows how vehicle sales are performing — new (VN) and used (VU) — with monthly KPIs and charts, and lets the user narrow the view by brand and by store. It is a native React screen that reuses the existing dashboard and chart building blocks; it does not change the database.

## Problem / Context
Owners and store managers can already see an "Executive Pack" panel and browse the vehicle inventory CRUD, but there is no consolidated view of sales performance split by new vs. used, by brand, and by store. The analytic views needed for this already exist (`v_dia_sales_summary`, `v_dia_sales_trend`, shipped in issue #14), so the gap is purely on the front end: a screen that reads those views, presents the numbers, and offers brand/store drill-down. Grounding confirmed in:
- `frontend-portal/src/portal/renderers/screens/ExecutivePack.tsx` (screen pattern: `ScreenShell` + `KpiCard` grid, data loaded in `useEffect` via `agentsApi` helpers).
- `frontend-portal/src/portal/renderers/screens/ChartCard.tsx` (presentational chart widget; line/bar/pie; `data` passed via props).
- `frontend-portal/src/portal/lib/agentsApi.ts` (typed read helpers per Supabase view; `condition` is `'novo'` | `'usado'`).
- `frontend-portal/src/portal/renderers/registry.ts` and `frontend-portal/src/portal/lib/portalApi.ts` (componentKey registry and `MOCK_MENU` "Insights" group, where "Executive Pack" currently lives).
- `supabase/migrations/20260625170000_dia_fast_bi_analytics.sql` (`v_dia_sales_summary`: one row per month×condition×brand×store; `v_dia_sales_trend`: daily units/revenue, trailing 90 days, with NO condition column).

Important data constraint: the VN-vs-VU trend over time must be derived by aggregating `v_dia_sales_summary` per `period_month` × `condition`, because `v_dia_sales_trend` has no condition column.

## Acceptance Criteria
Each criterion below is verifiable by a structural `node --test` text-source test (the repo's offline test pattern), asserting against the screen source, the `agentsApi` data layer, the component registry, and the menu mock.

- [ ] **The Vendas dashboard is reachable from the menu under Fast BI / Insights.** `portalApi.ts`'s `MOCK_MENU` gains a "Vendas" item inside the existing Insights group (the one that holds the Executive Pack), whose `spec.componentKey` matches a key registered in `registry.ts` that lazy-loads the new Vendas screen.
- [ ] **The dashboard reads only the existing sales views.** A read helper in `agentsApi.ts` selects from `v_dia_sales_summary` (exposing `period_month`, `condition`, `brand`, `store`, `units_sold`, `revenue`, `margin`, `avg_days_to_sell`) and a helper selects from `v_dia_sales_trend`; no `insert`/`update`/`delete`/`rpc` write call is introduced for sales, and no migration or view file is added or modified.
- [ ] **Monthly KPI cards are shown for units, revenue, margin, and time-to-sell.** The screen renders `KpiCard`s for the current month covering: units sold for VN, VU and total; revenue for VN, VU and total; average margin; and average days-to-sell — with revenue/margin formatted as BRL currency and days-to-sell as a number.
- [ ] **A sales-trend-over-time chart compares VN vs. VU.** The screen renders a line `ChartCard` of sales over time with one series for `novo` (VN) and one for `usado` (VU), built by aggregating `v_dia_sales_summary` by `period_month` × `condition` (not from `v_dia_sales_trend`, which lacks a condition column).
- [ ] **Sales-by-brand and new×used-mix charts are shown.** The screen renders a bar `ChartCard` of sales by brand and a pie `ChartCard` of the new-vs-used mix, both sourced from the sales summary data.
- [ ] **The user can drill down by brand and by store via page state.** The screen exposes brand and store selectors held in React state; changing a selection filters the KPIs and all charts to the chosen brand and/or store, with an option to view all.

## Non-Goals
- No database migration and no changes to any view; the dashboard only reads the views shipped in issue #14.
- No new charting library or chart primitive — the existing `ChartCard` is reused as-is.
- No write/edit capability — the dashboard is strictly read-only (no create/update/delete of sales or vehicles).
- No changes to the Vehicle CRUD (`VehiclesInventory`) or to the Executive Pack screen.

## Out-of-Scope
- Lead/proposal funnel and any "vendas funnel" analytics (there is no lead entity in this branch) — explicitly excluded per the issue.
- Service (oficina) and parts dashboards (#17/#18) and their views.
- Cross-tenant or multi-currency handling beyond what the existing views and BRL formatting already provide.
- Export, scheduling, or alerting on the sales data.

---

**STATUS: DRAFT — requires human approval before any code is written.**
