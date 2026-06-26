# Spec — Finding Detail: evidência estruturada + histórico de decisão (issue #97)

> Epic: #92 · Area: frontend / portal (dia)

## Overview

The Finding Detail screen is where a human approves or rejects an agent finding,
so it must read like a production audit record — not a debug dump. This change
renders evidence in a structured, readable way, surfaces the **real decision
history** (who decided, when, and why) from data already persisted on the
finding, and replaces the old generic "Audit Trail" path with this contextual
decision history.

## Problem / Context

Today `FindingDetail.tsx` renders each evidence item with
`String(ev.label ?? ev.summary ?? …)`, which loses structure and can show
`[object Object]` when the payload has no `label`. There is **no decision
history** on the screen: the "Trilha de Auditoria" button instead opens a
separate `audit-trail` view that reads generic entity time-series facts, not the
actual approve/reject decision. Meanwhile the true decision is already persisted
on the `finding` row (`status`, `decided_at`, `approver` jsonb) by
`persist_disposition` in the ops-api, and `ops_findings_view` already exposes
`decided_at` and `approver` — the frontend simply doesn't read them. This story
delivers the real, contextual audit and retires the old trail.

## Acceptance Criteria

- [ ] **AC1 — Structured, safe evidence.** When a finding has evidence, each item
  is shown with a readable label and its detail/value, never as raw
  `[object Object]`; payloads without a `label` field still render meaningfully.
  When there is no evidence, a clear empty state is shown.
- [ ] **AC2 — Real decision history.** When a finding has already been decided,
  the screen shows a decision history block stating the decision
  (approved/rejected), **who** decided (`approver`), **when** (`decided_at`), and
  the **reason/note** when one exists — sourced from the data already persisted on
  the finding, without breaking the existing read contract.
- [ ] **AC3 — Production-grade expected × billed comparison.** The expected vs.
  billed amounts and the impact Δ have a clear visual hierarchy that makes the
  direction of the discrepancy (over-billed vs. under-billed) obvious, using an
  accessible color treatment.
- [ ] **AC4 — Old audit trail replaced.** The previous "Abrir trilha de
  auditoria" (`audit-trail`) entry point is removed from Finding Detail and
  replaced by this contextual decision history. If `AuditTrail.tsx` is left with
  no remaining users, it is removed together with its registry entry and i18n
  keys.
- [ ] **AC5 — Approval/rejection still works and is covered.** Approving or
  rejecting still goes through `decideFinding` (with a reason required on
  rejection) and refreshes the screen to reflect the new status and decision
  history; a `frontend-portal/scripts/verify-*.mjs` script covers structured
  evidence and decision history, and `npm run build` passes.

## Non-Goals

- Actually executing the `recommended_action` — the current no-op behavior stays.
- Changing how decisions are written (the ops-api `persist_disposition` path is
  unchanged).
- Redesigning the approve/reject dialog flow beyond the comparison/evidence/
  history presentation.

## Out-of-Scope

- The findings list/inbox experience (tracked as S3).
- Rendering Finding Detail as a side panel of the inbox — desirable but not
  required here.
- Any new write path or change to RLS beyond, if strictly needed, a read-only
  view/column for `authenticated` to surface existing decision data.

---

**Status: DRAFT — requires human approval before any code is written.**
