# Spec — feat(frontend): Dashboard "Peças" (Fast BI)

**Issue:** #18
**Pipeline step:** 01 (Spec)
**Status:** DRAFT — requires human approval before any code is written.

## Overview

Add a read-only "Peças" dashboard to the Fast BI / Insights area of the Portal DMS frontend. It surfaces the current parts-inventory situation (stock value + how many parts are critical/out-of-stock) and parts-sales performance, plus a reposition list of the actually-critical parts. The screen is a native dashboard component (like Executive Pack), composing `KpiCard` + `ChartCard` + a critical-parts table, reachable from a new "Peças" nav entry under the Fast BI / Insights section.

## Problem / Context

The dealership owner can already see individual parts and their stock state in the operational "Estoque de Peças" CRUD screen (`PartsInventory.tsx`), but there is no aggregated, glanceable view that answers the owner-level questions: *how much money is sitting in parts inventory, how many parts need reposition right now, and how are parts selling?* The Fast BI analytic views from issue #14 (`v_dia_parts_summary`, `v_dia_owner_kpis`) already exist in the DB but have no data helper yet in `agentsApi.ts`, and there is no screen consuming them.

Grounding reality (must shape the spec):
- The real frontend is `frontend-portal/`; dashboards are **native screens** registered in `componentRegistry` (registry.ts), not JSON UIEngine pages. The issue's "/dia/parts-bi (UIEngine)" phrasing maps to a native component screen here, following the Executive Pack pattern.
- `ChartCard` (ChartCard.tsx) is **presentational** — it receives resolved `data` via props and renders a graceful empty state via `emptyMessage` when `data` is empty.
- `getCriticalParts()` already reads `v_dia_parts_critical`, which **is** populated from real seeded parts. The aggregated views `v_dia_parts_summary` / `v_dia_owner_kpis` read defensively from anticipated `part`/`parts_sale` entity types and may currently return **zero rows / zero totals** (parts sales are not seeded). The dashboard must therefore render gracefully with empty charts and 0/— KPIs.
- The repo's established test pattern is a dependency-free **structural source test** run with `node --test` (see `frontend-portal/scripts/verify-chartcard.mjs`) that reads source files as text and asserts on their content. Every acceptance criterion below is framed to be verifiable that way.

## Acceptance Criteria

- [ ] **The dashboard screen exists and is registered.** A new screen source file (e.g. `frontend-portal/src/portal/renderers/screens/PartsBI.tsx`) exists and exports a default React component, and `registry.ts` maps a new `componentKey` (e.g. `dia-parts-bi`) to it via `lazy(() => import(...))`. *Verifiable: structural test asserts the file exists/exports a default component and that `registry.ts` contains the new key wired to the new screen module.*

- [ ] **The "Peças" nav entry appears under the Fast BI / Insights section.** `MOCK_MENU` in `portalApi.ts` gains a child item titled "Peças" whose `spec` is `{ kind: 'component', componentKey: '<the new key>' }`, placed under the Fast BI / Insights section (the section that today holds Executive Pack). *Verifiable: structural test asserts `portalApi.ts` contains a "Peças" menu item referencing the new componentKey within the Insights/Fast BI section.*

- [ ] **The dashboard shows the required KPIs.** The screen renders KPI cards for: parts inventory value (R$), the count of parts in `critico`/`zerado` state, and parts sold this month (units and R$). *Verifiable: structural test asserts the screen source references `KpiCard` and the corresponding parts KPI fields/labels (inventory value, critical/zero count, month units + revenue).*

- [ ] **The dashboard shows the required charts via ChartCard.** The screen renders a `ChartCard` for parts by `stock_status` (type `bar` or `pie`) and a `ChartCard` for parts sales over time (type `line`). *Verifiable: structural test asserts the screen imports/uses `ChartCard` with a bar-or-pie chart keyed on `stock_status` and a line chart for the sales time series.*

- [ ] **The dashboard lists the critical parts for reposition.** The screen renders a list/table of critical parts sourced from `getCriticalParts()` (`v_dia_parts_critical`), showing at minimum the part identifier/description and its stock state. With the current seeds, this list shows the seeded `critico`/`zerado` parts. *Verifiable: structural test asserts the screen calls `getCriticalParts` and renders a per-row list of critical parts.*

- [ ] **The dashboard renders gracefully when analytic data is empty.** When `v_dia_parts_summary` / `v_dia_owner_kpis` return no rows or zero totals, the KPIs show `0`/`—` and each `ChartCard` shows its `emptyMessage` instead of a blank/broken chart — never an unhandled error. *Verifiable: structural test asserts each `ChartCard` is given an `emptyMessage` prop and that KPI values fall back to `0`/`—` (or `formatBRL` of a nullish value), mirroring the Executive Pack empty-handling pattern.*

## Non-Goals

- No database migration or change to any existing SQL view — this is frontend-only. The required views already exist from issue #14.
- No write/CRUD actions on the dashboard — it is strictly read-only.
- No new charting library or test framework — reuse the existing `ChartCard` (recharts) widget and the dependency-free `node --test` structural-test pattern.
- No automatic reposition suggestion or reorder logic (explicitly out per the issue).

## Out-of-Scope

- Vehicle inventory / floor-plan dashboard (tracked in issue #19).
- Seeding `parts_sale` data so the sales chart populates with real numbers — this spec only requires the screen to render correctly whether or not that data exists.
- Other Fast BI dashboards (sales VN/VU, service/oficina) from the #15–#18 family beyond the Peças screen.

---

**This spec is a DRAFT and requires human approval before any code is written.**
