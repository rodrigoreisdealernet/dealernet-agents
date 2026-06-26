# Spec — Issue #93: Reorganizar o menu "Operações de IA" e aposentar "Trilha de Auditoria" como item de topo

**Épico:** #92 · **Labels:** area:frontend, cap:portal, dia, enhancement
**Status:** 🟡 DRAFT — requires human approval before any code is written

## Overview

The "Operações de IA" (`ai-ops`) menu group currently exposes four top-level
screens, including **"Trilha de Auditoria"**, which is low-value as a menu entry
because, when opened from the menu, it receives no `entityId` and only shows a
"open from a finding" placeholder. This change reorganizes the information
architecture of that menu group: it removes "Trilha de Auditoria" as a top-level
item while keeping the audit-trail screen reachable contextually from a finding,
and groups the remaining screens coherently. This is a navigation + i18n + tests
change only — no screens are redesigned.

## Problem / Context

In `frontend-portal/src/portal/lib/portalApi.ts`, the `ai-ops` group has four
leaves: **Morning Brief** (`morning-brief`), **Painel de Agentes**
(`agents-dashboard`), **Fila Matinal** (`findings-queue`), and **Trilha de
Auditoria** (`audit-trail`). Opening "Trilha de Auditoria" from the menu passes
no `entityId`, so the screen renders only a hint to open it from a finding. The
audit that matters is contextual (handled in S4 / #92). Additionally, *Painel de
Agentes* and *Fila Matinal* form a single flow and should read as a cohesive
group. The menu labels are translated via keys derived from each item `id`
(`menuKeys.ts` → `menu.*` in `pt-BR.json` / `en-US.json`), and the build is
guarded by `frontend-portal/scripts/verify-menu.mjs`, which asserts unique ids,
unique component keys, and that every menu `componentKey` resolves in
`registry.ts`.

## Acceptance Criteria

- [ ] **1. "Trilha de Auditoria" is gone from the menu.** A user browsing the
  "Operações de IA" group no longer sees a top-level "Trilha de Auditoria"
  entry. (Test: the `ai-ops` group / `MOCK_MENU` no longer contains the
  `ai-audit-trail` item nor a leaf with componentKey `audit-trail`.)
- [ ] **2. Audit trail is still reachable from a finding.** The audit-trail
  screen remains registered and openable in context (e.g. from a finding
  detail). (Test: `audit-trail` still maps to a component in `registry.ts` and
  resolves via `resolveComponent('audit-trail')`.)
- [ ] **3. The "Operações de IA" group is coherently organized.** The remaining
  AI screens (Morning Brief highlighted, plus the AI-central screens grouped)
  are present and ordered sensibly in `MOCK_MENU`, with matching `menu.*` labels
  in both `pt-BR.json` and `en-US.json`. (Test: expected ai-ops leaf ids exist;
  the group still has its remaining screens.)
- [ ] **4. No orphan or missing translation keys.** Every menu item that remains
  has a corresponding `menu.*` key in `pt-BR.json` and `en-US.json`, and the
  removed `ai-audit-trail` key is dropped from both files — no orphan keys and
  no menu item without a label. (Test: each remaining menu id has a key in both
  locale files; `menu.ai-audit-trail` no longer exists.)
- [ ] **5. Every menu screen still resolves.** No menu/route points to a
  component key that is absent from `registry.ts`; all `componentKey` values in
  `MOCK_MENU` resolve. (Test: verify-menu's registry-resolution assertion
  passes.)
- [ ] **6. Guards pass for the new structure.** `verify-menu.mjs` is updated/
  extended to cover the new ai-ops structure and passes
  (`node --test frontend-portal/scripts/verify-menu.mjs`), and `npm run build`
  (`tsc -b`) succeeds.

## Non-Goals

- Redesigning or rewriting any AI screen (Painel de Agentes, Fila Matinal,
  Morning Brief, or AuditTrail) — visual/behavioral redesign is S2/S3/S4.
- Implementing the contextual "open audit trail from a finding detail"
  navigation flow itself (it is verified to remain *possible* via the registry,
  but building/changing that flow is out of this story).
- Changing any other top-level menu group (`fast-bi`, `dealership`, `admin`,
  etc.) or its items.

## Out-of-Scope

- Removing or deleting the `AuditTrail.tsx` component/file — it stays for
  contextual use until S4 decides its fate.
- Backend menu APIs (`portalApiReal`) and any server-side menu source — this
  story touches the mock/static menu definition and i18n only.
- Other épico #92 stories (S2/S3/S4) covering the actual screen redesigns and
  contextual auditing.

---

**This spec is a DRAFT and requires human approval before any code is written.**
