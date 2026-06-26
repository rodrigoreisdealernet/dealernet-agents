# Spec — feat(ops): prévia de consequências ao aceitar/recusar finding (decision_preview) [U3]

**Issue:** #126
**Unit:** U3
**Status:** DRAFT — requires human approval before any code is written.

## Overview

When an operator opens a finding, the detail screen today shows only a free-text
`proposed_action` and gives no indication of what actually happens on Approve vs.
Reject. This change adds a deterministic, two-branch **decision preview** ("On
approve" / "On reject") to the finding detail, describing the real effect of each
choice — including whether it is a no-op, assist-only, audited, and any monetary
impact — faithful to what the system actually records.

## Problem / Context

- In `FindingDetail.tsx` the operator sees `proposed_action` as free text and the
  Approve/Reject buttons, with no preview of consequences.
- The real effect is only knowable *after* approval, from what
  `execute_finding_action` writes to the `finding_action` table.
- In the actual code, **only the vehicle-aging agent** (finding type
  `stock_aging_90d`) produces a real effect:
  - `markdown` → applies a fixed 10% markdown and records a new sale price (audited).
  - `transfer` / `prioritize_sale` / `wholesale_auction` → records a disposition
    pending execution (audited).
  - `monitor` / unknown action → audited no-op.
- The **other three agents are pure assist-only**: approve/reject persists only the
  disposition and audit trail — nothing is executed in the DMS.
- **Reject** never executes a side effect — it is always a monitored/audited no-op.

The operator needs to see, before clicking, exactly what each branch will do, with
value and an "assist-only / audited" seal that matches reality.

## Acceptance Criteria

- [ ] **AC1 — Two branches shown.** On a finding detail with status
  `pending_approval`, the operator sees two clearly labelled blocks, "On approve"
  and "On reject", rendered before the Approve/Reject buttons. Each block describes
  the effect and shows the applicable seals: **no-op / assist-only**, **audited**,
  and a **value impact** (recoverable / exposure amount) when one applies.

- [ ] **AC2 — Vehicle-aging `markdown` is faithful.** For a `stock_aging_90d`
  finding whose action is `markdown`, "On approve" describes recording a markdown of
  the specific amount (audited, assist-only), and "On reject" describes a
  monitored/audited no-op. The described effect and value match what the system
  records in `finding_action` for that decision (no divergence between preview and
  recorded outcome).

- [ ] **AC3 — Assist-only agents are explicit.** For findings from the three
  assist-only agents, "On approve" makes clear that approving **records the
  recommendation for follow-up and does not execute anything in the DMS**, marked as
  assist-only and audited. "On reject" describes a monitored/audited no-op.

- [ ] **AC4 — All actions covered.** The preview produces a correct, faithful
  description for every action across all four agents — including `monitor` and any
  unrecognised/unknown action — without error and without inventing effects that the
  system would not perform.

- [ ] **AC5 — Localized, no regression.** All preview labels and seals are available
  in both pt-BR and en-US via i18n (no hard-coded user-facing strings). The existing
  Approve/Reject flow continues to work unchanged.

## Non-Goals

- Changing the real execution behaviour of any action. This change only **describes**
  consequences faithfully; it must not alter what `execute_finding_action` does.
- Adding new executable effects (e.g. making reject perform a side effect, or making
  assist-only agents write to the DMS).
- Changing markdown percentage, disposition rules, or audit semantics.

## Out-of-Scope

- Predictive / time-horizon outcomes (separate issue, U4).
- Work owned by **#124** and **#125** (this issue depends on their merge order, as it
  shares `agentsApi.ts`, i18n resources, and `FindingDetail.tsx`).
- Redesign of the finding detail layout beyond inserting the two preview blocks.
- Changes to the findings list/queue views.

---

**This spec is a DRAFT and requires human approval before any code is written.**
