# Customer Management / Rental CRM Specification

**Status:** Draft
**Author:** Factory Architect
**Date:** 2026-06-09
**Related ADRs:** [ADR-0001](../adrs/0001-generic-entity-model-scd2.md), [ADR-0016](../adrs/0016-json-driven-ui-engine.md), [ADR-0019](../adrs/0019-app-layer-tenant-scoping-rls-deferred.md), [ADR-0024](../adrs/0024-authenticated-write-path-security-definer-rls.md)
**Related issues:** #435, #565, #566, #567, #568

---

## 1. Summary

This spec defines the rental CRM slice for customer profiles, secure intake, compliance-document
tracking, communication history, and payment-risk surfacing.

The approved direction is to keep `Customer`, `BillingAccount`, `Contact`, and `JobSite` as the
core system-of-record entities, then layer CRM-specific document, issue, intake, and interaction
surfaces on top of that model instead of creating a parallel CRM schema.

---

## 2. Goals

- Reuse the existing rental-domain customer entities rather than inventing a second customer record.
- Auto-populate customer profiles from quotes, reservations, orders, contracts, and billing events.
- Support secure self-serve intake without exposing public CRUD endpoints or broad anonymous reads.
- Track license/insurance compliance status and surface explicit operational blocking signals.
- Give operations and finance one CRM profile surface for balance, credit, payment issues, and
  communications.

## 3. Non-goals

- Do not add license-verification OCR or document authenticity scoring in this slice.
- Do not store raw payment credentials in CRM.
- Do not create a separate SaaS CRM subsystem or duplicate customer master data outside the generic
  entity model.
- Do not move public portal access to broad anonymous database access; all external access remains
  token-scoped.

---

## 4. Current baseline and required gaps

The repo already has a CRM baseline in `supabase/migrations/20260609150000_crm_customer_profile_model.sql`:

- `crm_upsert_customer_profile(...)` writes `customer` entity snapshots
- `crm_customer_profile_current` projects current customer state plus facts
- `customer_balance`, `customer_credit_limit`, `customer_avg_days_to_pay`, and
  `customer_payment_issue_flag` facts already exist in the read model

The formal implementation must account for these verified gaps before follow-on stories ship:

1. `portal_contract_scope_tokens` is contract-scoped and cannot safely anchor pre-contract intake.
   Secure intake needs a separate intake-scoped token table and RPC surface.
2. `crm_customer_profile_current` currently exposes `ev.data -> 'payment_methods'`; payment-method
   references must move to the guarded payments boundary from ADR-0038 rather than remain free-form
   JSONB.
3. `credit_change_proposal.status` is constrained to `'draft'` only today; the CRM rollout needs an
   additive database follow-up so approved proposals can actually drive `customer_credit_limit`
   facts.

These gaps are design inputs, not reasons to fork the CRM model.

---

## 5. CRM architecture

### 5.1 System-of-record boundary

`Customer`, `BillingAccount`, `Contact`, and `JobSite` remain the canonical identity layer.

CRM adds the following bounded records:

| Record | Storage pattern | Why |
|---|---|---|
| customer profile state | `customer` entity + `entity_versions` | low-frequency identity and profile attributes |
| customer compliance documents | `customer_document` entity + relationships | documents have lifecycle, status, and audit metadata |
| customer issues / payment-risk cases | `customer_issue` entity + relationships | issues are case-like and need current status |
| customer interactions | `time_series_points` | interactions are append-only high-volume events, not SCD2 state |
| intake session scope | dedicated `portal_intake_scope_tokens` table | public token boundary must stay narrow and revocable |

`customer_interaction` is intentionally **not** a new high-volume SCD2 entity type. Calls, emails,
SMS sends, and portal submissions are append-only events and should be stored as time-series
records keyed to the customer entity.

### 5.2 Auto-population and merge rules

Auto-population from quotes, reservations, orders, contracts, and billing data must be additive and
idempotent.

Required merge rules:

1. `source_record_id` remains the first-class stable match key when upstream systems provide one.
2. Transactional enrichment may fill missing profile fields but must not silently overwrite known
   higher-trust values without explicit precedence rules.
3. Duplicate detection must prefer deterministic identifiers first (ERP customer id, billing account
   id, verified contact email/phone) and only use fuzzy matching as a review workflow input.
4. Enrichment from downstream payment events updates facts and issues, not raw customer identity
   snapshots.

### 5.3 Secure intake boundary

Customer self-serve intake is a token-scoped write flow, not a public CRUD API.

Runtime shape:

```text
email/SMS intake link
        |
        v
portal_intake_scope_tokens
        |
        v
scoped intake RPC / ops_api endpoint
        |
        v
customer/contact/job-site upsert + document intake staging
```

Rules:

1. Introduce `portal_intake_scope_tokens` as an additive table separate from
   `portal_contract_scope_tokens`.
2. Tokens are high-entropy, hashed at rest, time-bounded, revocable, and scoped to one intake
   session plus one tenant/customer candidate.
3. Anonymous/external callers may submit only through token-validating RPCs or `ops_api`
   endpoints; they do not receive general CRM read access.
4. Intake-created records are staged through explicit allowed fields. No arbitrary JSON merge path
   from the public surface is allowed.
5. Uploaded document blobs use signed URLs and tenant-scoped metadata; document retrieval remains an
   authenticated back-office path unless a later design explicitly expands that boundary.

### 5.4 Compliance blocking

Compliance status is only valuable if it is enforced at the operational boundary.

The enforcement point for #567 is:

- a dedicated customer-compliance readiness check executed before contract activation / scheduling
  confirmation and before final checkout dispatch

That check must evaluate required document presence and expiry state and return explicit blocking
reasons rather than passive warnings. Expired or missing required compliance documents block the
operational transition and surface on the CRM profile and order workflow.

### 5.5 Communication and issue visibility

Communication history is projected into the CRM detail surface from `time_series_points` and linked
operational records.

Customer issues, especially payment-risk or service-risk cases, are modeled as durable entities so
they can carry:

- severity / status
- owner or workflow reference
- resolution notes
- linkage to billing account, order, or invoice context

---

## 6. Data model direction

### 6.1 Entity and relationship additions

Recommended additive entity types:

- `customer_document`
- `customer_issue`

Recommended relationship types:

- `customer_has_document`
- `customer_has_issue`
- `billing_account_has_issue`
- `customer_intake_created_contact`
- `customer_intake_created_job_site`

Document state should include:

- `document_type` (`drivers_license`, `insurance_certificate`, other approved types)
- `status` (`pending_review`, `active`, `expired`, `rejected`, `revoked`)
- `expires_at`
- storage reference / object key metadata
- verification/review metadata

Issue state should include:

- `issue_type` (`payment_issue`, `service_issue`, `compliance_issue`)
- `status`
- `severity`
- linked operational references

### 6.2 Facts and events

Current customer KPIs stay in `entity_facts` and history stays in `time_series_points`.

Required facts:

- `customer_balance`
- `customer_credit_limit`
- `customer_avg_days_to_pay`
- `customer_payment_issue_flag`
- additive compliance status facts if the UI needs current numeric filtering

Interaction events should be written to `time_series_points` with a fact/event registry such as:

- `customer_email_sent`
- `customer_sms_sent`
- `customer_call_logged`
- `customer_intake_submitted`

### 6.3 Credit-limit workflow dependency

Before #565 is implemented, route an additive database follow-up through `queue:database` to widen
the `credit_change_proposal.status` lifecycle beyond `'draft'`.

Approved credit decisions should then drive `customer_credit_limit` fact updates through a durable
workflow step rather than direct UI edits.

---

## 7. Interfaces

Implementation stories should align to these interfaces:

| Surface | Contract |
|---|---|
| Supabase write path | Continue using SECURITY DEFINER RPCs for authenticated back-office writes per ADR-0024 |
| CRM read model | Extend `crm_customer_profile_current` or adjacent read models rather than pushing bespoke joins into the frontend |
| Intake write path | New scoped intake RPCs / `ops_api` endpoints validated by `portal_intake_scope_tokens` |
| Document storage | Metadata in Postgres, blob access via signed URLs and explicit review/download flows |
| Workflow orchestration | Temporal reminder and compliance-check flows for expiring documents and operational blocking |
| Frontend | JSON-driven CRM list/detail, compliance banner, issue timeline, and intake confirmation surfaces |

---

## 8. Delivery sequencing

Recommended dependency order:

1. Publish this CRM spec and keep the epic in architecture review until security/database review
   confirms the intake/document boundary and credit-lifecycle gap.
2. #565 auto-population from transactional records plus deterministic merge rules.
3. #566 intake session issuance, token validation, staged submission, and customer/contact/job-site
   creation.
4. #567 document storage/status, expiry reminders, and operational compliance blocking.
5. #568 communication history projection and payment-issue surfacing.

Implementation must not start with document uploads or public intake before the scoped token design
is in place.

---

## 9. Test strategy

The implementation derived from this spec should prove:

- idempotent customer enrichment without duplicate profile creation
- scoped intake tokens cannot read or write outside their tenant/session/customer candidate
- expired or missing compliance documents block contract activation / checkout transitions
- communication history renders from event data without bespoke backend joins in the frontend
- credit-limit and payment-issue facts surface correctly in the CRM profile
- signed URL and document metadata access paths deny unauthorized readers

---

## 10. Risks and review asks

- **Security review required:** intake token issuance, signed URL policy, document retention, and
  PII exposure boundaries.
- **Database review required:** additive intake-token table, document entities, and the
  `credit_change_proposal` status-lifecycle correction.
- Duplicate-customer matching remains the biggest data-quality risk if merge precedence is left
  implicit.
- Payment-method presentation in CRM must stay a projection of the guarded payments subsystem, not a
  second raw storage path.
