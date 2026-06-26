# Spec — Service Estimate Rescue Agent (DIA ops) — Issue #81

> Detailed execution contract lives in the PRD: `docs/prd/2026-06-25-agente-resgate-orcamento-oficina.md` (§6 Requirements, §7 Acceptance Criteria, §8 Implementation Contract). This spec distills the customer-facing intent and is **not** a replacement for that contract.

## Overview

Add a proactive DIA ops agent for the **service manager** that finds workshop service estimates (orçamentos de OS) that are **awaiting authorization** or were **declined**, has an LLM rank each by recoverable revenue and recommend a contact/recovery action, and records the ranked findings into the existing findings queue for a human to act on. The work has two parts: a small data step that surfaces estimate status on the existing service-order mirror, and an agent (Temporal triad) cloned from the `vehicle_aging` pattern.

## Problem / Context

Today the DIA `service_order` mirror view (`v_dia_service_order_current`) is **header-only** — it exposes order, customer, vehicle, status and revenue, but nothing about each estimate line's authorization status or lost-sale value. As a result there is no way to systematically spot pending/declined estimates that represent recoverable workshop revenue, and managers chase them ad hoc. This change surfaces estimate status and lets an assist-only agent rank the recoverable opportunities so the manager knows who to contact first. The agent is **assist-only**: it never sends messages, authorizes, re-prices, discounts, cancels, or generates lost-sale records — it only recommends a next contact.

## Acceptance Criteria

- [ ] **Pending and declined estimates are surfaced, authorized ones are hidden.** Given a service order with a pending line, a declined line, and an authorized line, the new estimate view returns exactly the pending and declined lines (the authorized line is absent), with a numeric line value, and an order/source without estimates yields zero rows and no error. *(verifiable via SQL against the new view)*
- [ ] **Declined and higher-value estimates rank first.** The surfaced estimates are ordered so declined estimates come before pending ones, and higher line values come before lower ones, giving the manager a recoverable-revenue-ranked list. *(verifiable via scope/ordering test)*
- [ ] **A run records ranked, assist-only findings the manager can action.** Running the agent over pending/declined estimates records findings of type `estimate_rescue` in `pending_approval` status, each carrying the estimate's facts, a recommended action, a recoverable value, and a rationale; `auto_apply` is always false. *(verifiable via workflow happy-path test)*
- [ ] **No duplicate findings on re-runs, and runs stay bounded.** Re-running with already-open findings records zero new findings (all deduped); a partially-open set records only the new ones; and the per-run cap limits how many are recorded, keeping the highest-ranked ones. *(verifiable via dedupe/bounding tests)*
- [ ] **Empty input is handled gracefully.** When there are no pending/declined estimates in scope, the run completes cleanly, scopes zero estimates, records nothing, and still finalizes. *(verifiable via empty-scope test)*
- [ ] **The agent is wired for scheduled and on-demand runs without breaking existing agents.** The new workflow and its activities are registered, the agent is exposed for run-now, it is seeded (disabled-by-default schedule) for the demo tenants, and existing service-order views, write paths, and other agents are untouched. *(verifiable via worker-registration/run-now tests + migration applying cleanly)*

## Non-Goals

- Does **not** send SMS, WhatsApp, email, or any notification.
- Does **not** authorize, re-price, discount, cancel, or generate lost-sale (VendaPerdida) records, draft invoices, or move money.
- Does **not** auto-apply any recommendation (`auto_apply` is forced false; a human acts on every finding).
- Does **not** modify the frontend, the header-only `v_dia_service_order_current` view, or the `service_order` write RPCs.

## Out-of-Scope

- Building the ERP→DIA ingestion ETL that writes estimate lines onto the service-order payload (the agent reads the payload as-is).
- The live bay-sequencing / shop-queue and technician-queue flows (distinct rental-leftover features — not touched).
- Introducing a separate `service_estimate` entity type (the change extends/reads the existing `service_order` mirror instead).
- Any change to how findings are displayed in the manager's queue UI.
