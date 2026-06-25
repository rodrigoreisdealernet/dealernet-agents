# Spec — feat(ops): Vehicle Stock-Aging Analyst (Issue #32)

## Overview

Add the **Vehicle Stock-Aging Analyst** (`vehicle-aging-analyst`), the first
Operations Factory agent in the DIA domain.  It queries the existing
`v_dia_vehicle_current` view for vehicles in stock approaching or past 90 days,
asks the LLM to assess floor-plan exposure, and writes prioritised findings
(`stock_aging_90d`) to the `finding` table for human approval.  The agent
follows the established `scope → assess(LLM) → record_finding → finalize`
fire-and-forget pattern already used by `revrec-analyst`.

---

## Problem / Context

The dealership demo tenant (`demo-ops-a`) already has vehicle entity data and a
derived view (`v_dia_vehicle_current`) that computes `days_in_stock` and
`floor_plan_cost`.  No agent currently monitors aging stock or surfaces the
financial exposure to operations staff.  The Operations Factory's approval
workflow, fingerprint-based deduplication, and KPI views are all in place — this
issue wires them up for the vehicle domain without creating any new tables,
entity types, or catalogue entries.

---

## Acceptance Criteria

- [ ] **Seed & migration apply cleanly.**
  `supabase db reset` completes without error (replay-safe, idempotent).
  `v_dia_vehicle_current` returns exactly **15 demo vehicles** (existing 001–012
  plus new 013 / 014 / 015).  `ops_agent_config_current` shows
  `vehicle-aging-analyst` for `demo-ops-a` with `enabled = true` and
  `schedule.enabled = false`.

- [ ] **Trigger produces correct scope and findings.**
  Running `python -m temporal.scripts.run_vehicle_aging --tenant-key demo-ops-a`
  returns `{ scoped: 9, recorded: 9, deduped: 0 }`.  The 9 findings are exactly
  the `em_estoque` vehicles with `days_in_stock >= 75`
  (001 / 002 / 005 / 007 / 008 / 009 from existing seed, plus 013 / 014 / 015).
  Vehicles 003 / 004 / 006 / 010 / 011 (< 75 days) and 012 (sold) produce no
  findings.

- [ ] **Severity buckets and new-seed vehicles are correct.**
  All 9 findings are `pending_approval`.  At least one finding of each severity
  is present: **medium** (75–84 days), **high** (85–90 days), **critical**
  (> 90 days).  Specifically: 013 → medium (80 d), 014 → high (86 d),
  015 → high (89 d).  Each finding's `delta` ≈ the vehicle's `floor_plan_cost`
  from the view.

- [ ] **KPIs and status views reflect the run.**
  `ops_finding_kpis` shows `pending_count = 9` and
  `recoverable_delta = Σ floor_plan_cost` across the 9 vehicles.
  `ops_agent_status_view` shows `vehicle-aging-analyst` with
  `has_pending_badge = true` and `last_run_status = succeeded`.

- [ ] **Approve / reject changes state and is auditable.**
  Calling the ops findings decision API (`POST /api/ops/findings/{id}/approve`
  and `/reject`, or the equivalent `POST /api/ops/findings/decision`) on one
  finding each flips their `status` in the database.  `ops_audit_trail_view`
  shows both events in the timeline for the corresponding vehicle entity.

- [ ] **Deduplication and worker registration work.**
  Re-running the agent returns `{ scoped: 9, recorded: 0, deduped: 9 }` — no
  new rows inserted.  `pytest temporal/tests/test_ops_vehicle_aging.py` passes.
  No `rental_*` helper is imported in any new file.  The Temporal worker
  registers both `VehicleAgingWorkflow` and its activities
  (`@workflow.defn` / `@activity.defn`).  The agent schedule remains disabled
  (`schedule.enabled = false`).

---

## Non-Goals

- No new database tables, entity types, or catalogue entries are created; the
  existing `vehicle` entity type and `v_dia_vehicle_current` view are reused
  as-is.
- The agent does not auto-apply any action (`auto_apply` stays `false`); all
  dispositions require human approval.
- No blocking of the Temporal workflow on human approval (fire-and-forget only).

---

## Out-of-Scope

- Enriching `ops_findings_view` with vehicle-specific columns.
- A dedicated UI page for vehicle findings (uses the existing ops findings table).
- Enabling the recurring schedule (left `schedule.enabled = false`; manual
  trigger only for now).
- Extending the pattern to any tenant other than `demo-ops-a` / `demo-ops-b`
  beyond the seed parity row for `demo-ops-b`.

---

> **⚠️ DRAFT — requires human approval before any code is written.**
