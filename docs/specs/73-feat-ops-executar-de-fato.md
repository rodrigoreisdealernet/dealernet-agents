# Spec — Execute the recommended action after approval (vehicle-aging-analyst)

**Issue:** #73 — feat(ops): executar de fato a ação recomendada após aprovação do
agente de veículos (+ Dispensar persistente + nomes amigáveis)
**Status:** APPROVED (shipped via `/ship-issue 73 --approved`).

## Overview

Today the vehicle stock-aging agent analyzes the fleet and surfaces a `finding`
with a recommended action, but approving that finding has no real effect on the
vehicle — the cycle ends at a status flag. This change makes **Approve actually
execute the recommended action** on the vehicle with an auditable, idempotent
record, makes **Dismiss persist** so dismissed items don't reappear, and replaces
raw codes in the UI with **friendly, localized names**. Scope is a vertical slice
over the only active DIA ops agent: `vehicle-aging-analyst`.

## Problem / Context

- The workflow is fire-and-forget (`temporal/src/workflows/ops/vehicle_aging.py`):
  scope → assess → dedupe → record finding as `pending_approval`. It never blocks
  on approval and there is no signal handler for approval.
- Approving a finding (`ops_api/app.py` `_handle_decision`) only writes
  `finding.status='approved'` and attempts a Temporal signal on an
  already-finished workflow; the signal failure is swallowed and logged. **No
  markdown, transfer, task, or any side effect on the vehicle occurs.**
- The recommended action (`monitor`, `markdown`, `transfer`, `prioritize_sale`,
  `wholesale_auction`) is stored on the finding and never executed. The only
  precedent for "execute after approval" lives in the unrelated revenue-recognition
  agent (`invoice_adjustment_draft`); the vehicle agent has no equivalent.
- **Dismiss** in the Morning Brief only hides the item locally and does not call
  the backend, so it reappears on reload.
- The UI shows raw codes (e.g. `vehicle-aging-analyst · stock_aging_90d`) instead
  of readable names, in both the Morning Brief and the Findings Queue.

This matters because the agent currently produces recommendations with **zero
business effect**, the queue is noisy (dismissals don't stick), and the experience
is unreadable to operators.

## Acceptance Criteria

- [ ] **Approving a markdown finding actually reduces the price.** When an
  operator approves a `stock_aging_90d` finding whose recommended action is
  `markdown`, the vehicle's sale price is reduced by the configured percentage,
  the new price becomes the current value visible to the business
  (`v_dia_vehicle_current`), the vehicle's prior price/history is preserved
  (new SCD2 `entity_version`), and a single auditable `finding_action` record
  (`status='executed'`) is written showing before/after values and the approver.

- [ ] **Approving the same finding twice changes nothing extra (idempotent).**
  Re-sending the same approval decision does not apply a second price reduction
  and does not create a second `finding_action` record; the vehicle's price and
  the audit trail are unchanged after the duplicate request.

- [ ] **Approving a non-monetary action records intent without touching price.**
  Approving `transfer`, `prioritize_sale`, or `wholesale_auction` marks the
  vehicle with the chosen disposition and writes a `finding_action` record in a
  `pending_execution` state (final external effect is out of scope), and the
  vehicle's sale price is unchanged.

- [ ] **Approving `monitor` is an audited no-op.** Approving a `monitor` finding
  records the disposition/decision (a `finding_action`) in the audit trail with
  no change to the vehicle.

- [ ] **Dismiss persists across reload.** When an operator dismisses a finding,
  it disappears from the queue and does **not** reappear after refreshing or
  reloading; the dismissal is captured in the audit trail. (Dismiss may capture
  an optional short note; it does not require a reason like Reject does.)

- [ ] **Operators only see and act on their own tenant's records.** An
  authenticated user can read `finding_action` rows only for their own tenant and
  cannot create or modify them directly; cross-tenant reads return nothing. The
  backend `service_role` retains full access to write execution records.

- [ ] **The UI shows friendly, localized names — no raw codes.** In both the
  Morning Brief and the Findings Queue, the agent, finding type, and recommended
  action are shown as readable labels in pt-BR and en-US (e.g. "Analista de
  estoque parado", "Veículo parado há 90+ dias", and a friendly verb per action),
  falling back to the raw code only if a translation is missing. No raw
  `vehicle-aging-analyst`, `stock_aging_90d`, or action codes appear in the UI.

## Non-Goals

- No real external integration for transfer/auction execution — non-monetary
  actions only record a `pending_execution` decision.
- No auto-execution without human approval — the v1 invariant `auto_apply=False`
  remains; every disposition still requires explicit operator approval.
- No change to how the agent analyzes the fleet or generates findings.
- No complex markdown rules engine — a single configurable percentage is used for
  this slice.

## Out-of-Scope

- Re-applying this "execute after approval" capability to other ops agents
  (revrec, fleet, credit) — this slice is limited to `vehicle-aging-analyst`.
- Building or wiring the downstream external systems that would carry out a real
  transfer or wholesale auction.
- Any redesign of the approval/decision API surface beyond what is needed to
  execute the action and persist a dismissal.
