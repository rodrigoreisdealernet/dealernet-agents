# Payments & Invoicing Specification

**Status:** Draft
**Author:** Factory Architect
**Date:** 2026-06-09
**Related ADRs:** [ADR-0003](../adrs/0003-temporal-workflow-orchestration.md), [ADR-0019](../adrs/0019-app-layer-tenant-scoping-rls-deferred.md), [ADR-0024](../adrs/0024-authenticated-write-path-security-definer-rls.md), [ADR-0029](../adrs/0029-least-privilege-runtime-defaults-app-workloads.md), [ADR-0037](../adrs/0037-integration-connector-framework.md), [ADR-0038](../adrs/0038-provider-hosted-payments-token-boundary.md)
**Related issues:** #436, #570, #571, #572, #573

---

## 1. Summary

This spec defines the payments and invoicing slice for branded invoices/statements, provider-hosted
card and ACH collection, saved payment-method references, settlement/refund orchestration, AR aging
materialization, and reminder scheduling.

The approved architecture keeps Dealernet out of raw card and bank-account handling: payment collection
surfaces are provider-hosted, saved methods are stored as token references plus non-sensitive
metadata only, and inbound payment events terminate at `ops_api` before durable handoff to Temporal.

---

## 2. Goals

- Generate branded invoices and statement batches from the existing rental billing boundary.
- Support card and ACH pay links without pulling raw PCI data into the browser app, Postgres, or
  Temporal workflow payloads.
- Support saved payment methods through provider token references only.
- Materialize AR aging and payment status for fast operator dashboards.
- Produce a canonical payments-to-accounting event contract that downstream connectors can consume.

## 3. Non-goals

- Do not select a specific processor vendor in this spec.
- Do not support direct raw PAN or bank-account entry/storage in Dealernet-managed UI or database paths.
- Do not add GL posting or full accounting-ledger ownership here; downstream accounting systems
  consume normalized payment events.
- Do not invent a second webhook/idempotency system outside the connector framework.

---

## 4. Current baseline and required gaps

The existing rental domain already has `Invoice` as an entity boundary and `InvoiceWorkflow` as the
billing orchestration baseline.

The formal payments implementation must account for these verified gaps:

1. `crm_customer_profile_current` currently exposes `payment_methods` out of customer JSONB. Saved
   methods need a dedicated guarded storage/projection path before #570 ships.
2. `evaluate_invoice_readiness(...)` currently evaluates contract status, billing holds, and line
   completeness only. Payment and statement stories must layer on top of that billing boundary rather
   than bypass it.
3. Payment-provider webhooks need to reuse `integration_delivery_log` from ADR-0037 for dedupe and
   replay handling instead of defining a bespoke payments-only event log.
4. AR aging must follow the generic facts/events model; do not create ad hoc dashboard-only tables
   unless a later ADR explicitly approves them.

---

## 5. Approved runtime architecture

### 5.1 Collection and settlement boundary

Runtime shape:

```text
invoice / statement in app
        |
        v
provider-hosted payment page or pay link
        |
        v
payment provider webhook
        |
        v
ops_api webhook endpoint
        |
        v
Temporal workflow / activity orchestration
        |
        +--> invoice / payment / allocation projections
        +--> reminder / statement scheduling
        +--> accounting integration event emission
```

Rules:

1. Card and ACH collection happens on provider-hosted surfaces only.
2. Dealernet stores provider token references and non-sensitive display metadata only.
3. Webhook authenticity validation happens at `ops_api`; durable business handling happens in
   Temporal.
4. Payment event dedupe uses `integration_delivery_log` with provider/event idempotency keys.
5. Any implementation that requires raw payment credentials in Postgres, browser code, or Temporal
   payloads is out of bounds.

### 5.2 Saved payment methods

Saved methods must be represented by a guarded reference store, not arbitrary JSONB on the customer
profile.

Recommended additive storage boundary:

| Store | Purpose |
|---|---|
| `payment_method_reference` table | tenant/customer/billing-account scoped token references and non-sensitive metadata |
| guarded upsert RPC | validates token-reference shape and rejects raw credential fields |
| CRM read projection | reads saved-method summaries from `payment_method_reference`, not from free-form customer JSONB |

Minimum stored fields:

- provider
- provider_customer_reference
- provider_payment_method_reference
- method type (`card`, `ach`)
- display metadata (`brand`, `last4`, `expiry_month`, `expiry_year`, optional bank-name display)
- default flag
- revocation / verification status

### 5.3 Billing, reminder, and statement orchestration

`InvoiceWorkflow` remains the billing readiness boundary for invoice creation.

Payments-specific orchestration layers on top of that baseline:

- pay-link issuance and expiration
- settlement and failed-payment handling
- refund / credit-note workflows
- reminder runs
- monthly statement batch generation and delivery

These should be Temporal workflows or child-workflow/activity compositions so retries, idempotency,
and operator recovery remain durable.

### 5.4 AR aging and projections

AR aging is a facts-and-events problem, not a free-form reporting query.

Approved model:

- current bucket values live in `entity_facts` on the `billing_account` entity
- historical snapshots and source payment/invoice events live in `time_series_points`
- UI dashboards and alerts read from those projections instead of recalculating from every invoice
  event on demand

If later work needs a separate materialization table for scale, that requires a follow-on ADR.

### 5.5 Payments to accounting event contract

Payments emit a canonical, processor-neutral contract for downstream accounting/integration work.

The event contract must include:

- tenant and billing-account identity
- invoice / statement / contract references
- payment status transition (`authorized`, `settled`, `failed`, `refunded`, `voided`)
- amount, currency, effective timestamps
- provider references and idempotency keys
- allocation details across invoice lines or invoices
- credit-note / refund linkage where applicable

These events are the source signals that finance/accounting connector adapters consume under
ADR-0037's anti-corruption-layer model.

---

## 6. Data model direction

### 6.1 Core records

Recommended additive records:

| Record | Storage pattern |
|---|---|
| invoice state | existing `invoice` entity boundary |
| statement batch | `statement_batch` entity |
| payment transaction | `payment_transaction` entity |
| payment allocation | additive table or entity tied to invoice + payment ids |
| refund / credit note | `refund` / `credit_note` entity or equivalent additive records |
| saved method reference | dedicated `payment_method_reference` table |
| reminder run | `payment_reminder_run` entity |

High-volume provider events and webhook attempts do **not** belong in SCD2 entity snapshots. They
belong in `integration_delivery_log` and `time_series_points`.

### 6.2 Facts and event streams

Required billing-account facts include:

- `ar_current_amount`
- `ar_31_60_amount`
- `ar_61_90_amount`
- `ar_91_plus_amount`
- `billing_account_last_payment_amount`
- `billing_account_last_payment_at`
- payment-failure flags where the UI needs current-state filtering

Required event streams include:

- invoice issued
- payment link generated / expired
- settlement received
- refund issued
- reminder sent
- statement batch generated / delivered

### 6.3 Hardening requirements

Before #570 implementation begins:

1. publish the dedicated payment token boundary from ADR-0038
2. add the guarded saved-method reference store and RPC surface
3. prevent raw credentials from being written through generic CRM upsert paths

The implementation must treat those as prerequisites, not cleanup.

---

## 7. Interfaces

| Surface | Contract |
|---|---|
| App invoice UI | renders invoice, statement, AR status, and launch points for provider-hosted payment flows |
| Supabase write path | SECURITY DEFINER RPCs for internal billing/admin actions; no raw payment credential writes |
| Saved methods | guarded token-reference upsert/read projection |
| Webhooks | `ops_api` validation plus Temporal durable handling |
| Dedupe / replay | `integration_delivery_log` per ADR-0037 |
| Accounting handoff | canonical payments event contract consumed by finance connectors |
| Notifications | reminder and statement workflows emitting email/SMS sends through existing messaging surfaces |

---

## 8. Delivery sequencing

Recommended dependency order:

1. Publish this spec plus ADR-0038 and keep the epic in architecture review until security/database
   review confirms the PCI-safe token boundary.
2. #573 provider adapter, webhook validation, token-reference store, and PCI-safe collection
   boundary.
3. #571 AR aging facts/events and dashboard materialization against `entity_facts` /
   `time_series_points`.
4. #572 reminder scheduling, statement batches, and delivery tracking.
5. #570 customer-facing payment initiation, saved-method selection, and settlement/refund flows.

Implementation must not ship saved-method UX before the guarded token-reference storage exists.

---

## 9. Test strategy

The implementation derived from this spec should prove:

- payment collection flows never expose raw card/bank data to app-managed storage or workflow state
- webhook validation and idempotent replay handling prevent duplicate settlements
- invoice readiness remains enforced before pay-link issuance
- AR aging facts match invoice/payment event history
- saved-method references can be created, revoked, and displayed without broad CRM write access
- refund and failure paths produce correct balance, allocation, and reminder outcomes

---

## 10. Risks and review asks

- **Security review required:** provider boundary, token storage, webhook validation, and PCI scope
  claims.
- **Database review required:** saved-method reference store, payment allocation shape, and AR facts
  registration.
- Provider selection remains open; the implementation stories must satisfy this interface contract
  regardless of vendor.
- Payment/accounting contract drift is the main integration risk if downstream connector stories do
  not reuse this spec.
