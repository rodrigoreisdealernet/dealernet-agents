# Driver's License ID Verification Specification

**Status:** Draft
**Author:** Factory Architect
**Date:** 2026-06-14
**Related ADRs:** [ADR-0001](../adrs/0001-generic-entity-model-scd2.md), [ADR-0019](../adrs/0019-app-layer-tenant-scoping-rls-deferred.md), [ADR-0024](../adrs/0024-authenticated-write-path-security-definer-rls.md), [ADR-0037](../adrs/0037-integration-connector-framework.md), [ADR-0039](../adrs/0039-portal-intake-bearer-token-boundary.md), [ADR-0059](../adrs/0059-provider-hosted-id-verification-derived-evidence.md)
**Related issues:** #440, #435, #567

---

## 1. Summary

This spec defines the driver's-license scanning and identity-verification slice for rental checkout,
fraud reduction, and insurance/audit readiness.

The approved direction keeps raw license and selfie capture on a provider-hosted verification
surface reached from a scoped SMS link. Dealernet stores only consent state, provider references, and
derived verification metadata or outcomes in its own stack, then enforces readiness through explicit
pre-rental checks and scheduled expiry monitoring.

---

## 2. Goals

- Support app-less SMS initiation for driver's-license verification without requiring a customer app
  login.
- Validate license presence, expiration, and provider verification outcome before contract
  activation, dispatch, or checkout.
- Reuse the CRM customer-profile and compliance-document architecture instead of inventing a parallel
  identity subsystem.
- Keep raw biometric and document media out of Dealernet-managed browser, database, storage, and Temporal
  payloads.
- Produce auditable verification status, operator-visible blocking reasons, and a controlled
  back-office export path.

## 3. Non-goals

- Do not add COI or general insurance-document verification in this slice.
- Do not expose document or selfie retrieval through anonymous or token-scoped public read paths.
- Do not make face matching optional per implementation story; provider support for selfie match is a
  prerequisite to the selected vendor path.
- Do not rely on generic signed-upload CRM document storage for raw driver's-license or selfie media.

---

## 4. Existing baseline and required gaps

The repo already has the right adjacent architecture to build on:

- `docs/specs/customer-management-rental-crm.md` defines `customer_document`,
  `customer_issue`, intake-token boundaries, and compliance blocking.
- ADR-0039 already establishes the fragment-token pattern for narrow public bearer secrets.
- ADR-0037 already establishes the provider callback -> `ops_api` -> Temporal ingress model.

The ID-verification rollout must resolve these verified gaps before implementation stories start:

1. The CRM spec assumes document blobs can live behind signed URLs in Dealernet-managed storage. That is
   **not** the approved storage boundary for driver's-license or selfie verification media.
2. The repo has no first-class consent record yet for biometric or advertising uses. Identity
   verification needs explicit pre-capture consent and later withdrawal or erasure handling.
3. The repo has no provider callback contract yet for asynchronous license-verification outcomes.
4. The repo has no defined pseudonymization or erasure behavior for sensitive verification records
   stored through the SCD2 model.
5. The operational compliance check from the CRM spec needs a verification-specific status contract
   for `missing`, `pending`, `verified`, `expired`, and `failed` cases.

These are design inputs, not reasons to fork the CRM model.

---

## 5. Approved architecture direction

### 5.1 Runtime shape

```text
operator sends SMS verification request
        |
        v
portal_verification_scope_tokens
        |
        v
frontend verification route with fragment token
        |
        v
provider-hosted document + selfie capture
        |
        v
provider webhook / callback -> ops_api validation
        |
        v
Temporal workflow / activity orchestration
        |
        +--> customer_document state
        +--> customer_issue blocking signal
        +--> time_series_points audit trail
        +--> readiness / expiry reminders
```

### 5.2 Public-link and capture boundary

The SMS link is a dedicated verification surface, not a general intake link.

Rules:

1. Use a dedicated `portal_verification_scope_tokens` table for this public boundary rather than
   reusing the broader intake-session token as-is.
2. The raw bearer token is delivered only in the URL fragment, following ADR-0039's no-query-string
   rule.
3. The token grants only one narrow capability: start or resume a verification session for one
   tenant, one customer candidate, and one verification case.
4. The token cannot read CRM data, edit arbitrary customer fields, or download previously submitted
   artifacts.
5. Verification sessions are short-lived, revocable, hashed at rest, and single-purpose.

### 5.3 Consent and privacy boundary

Identity verification requires explicit consent before provider capture begins.

Minimum consent requirements:

1. Record a purpose-specific consent entry for `identity_verification` before launching the provider
   session.
2. Capture timestamp, collection channel, policy/version reference, actor or recipient identity, and
   whether selfie face match is included.
3. If consent is declined or later withdrawn, the verification flow ends and a compliance issue is
   raised instead of silently bypassing verification.
4. Consent storage must be reusable by future marketing-consent work; do not build a
   verification-only consent silo.

### 5.4 Provider-hosted capture and callback handling

Raw driver's-license and selfie media stay on the verification provider's hosted surface.

Rules:

1. Dealernet issues a provider session reference but does not proxy raw image bytes through its own
   frontend, `ops_api`, Supabase Storage, or Temporal payloads.
2. Provider callbacks terminate at `temporal/src/ops_api/app.py`, validate provider authenticity, and
   hand durable work to Temporal per ADR-0037.
3. Temporal activities normalize the provider result into:
   - verification state
   - expiration and validity outcomes
   - face-match score or score band
   - provider reference ids
   - evidence pointers or report references
4. Full license number, raw selfie image, and raw OCR payload must not be stored in `entity_versions`
   or generic JSONB blobs.

### 5.5 CRM storage and enforcement model

Driver's-license verification extends the CRM compliance model instead of replacing it.

Recommended durable records:

| Record | Purpose |
|---|---|
| `customer_document` entity with `document_type = 'drivers_license'` | current compliance-document state and derived verification metadata |
| `customer_issue` entity with `issue_type = 'compliance_issue'` | operational blocking and follow-up review cases |
| `customer_consent` table | purpose-scoped consent state reusable across identity and marketing flows |
| `portal_verification_scope_tokens` table | narrow public SMS-upload session boundary |

`customer_document` state for this slice should include:

- `document_type`
- `verification_status` (`missing`, `pending`, `verified`, `expired`, `failed`, `revoked`,
  `erased`)
- `capture_mode = 'provider_hosted'`
- `provider_name`
- `provider_verification_ref`
- masked or partial document identifier only where operationally necessary
- `expires_at`
- `verified_at`
- `face_match_score` or `face_match_band`
- evidence/report reference metadata
- `erasure_status`

`customer_issue` should carry explicit blocking reasons such as:

- missing required verification
- expired license
- failed authenticity or face match
- consent declined or withdrawn
- provider-review-required

### 5.6 Operational enforcement and expiry monitoring

Verification state is only valuable if it actively blocks unsafe operational transitions.

Required enforcement points:

1. before contract activation or scheduling confirmation
2. before final yard checkout or dispatch release

Required background behavior:

1. A scheduled Temporal reminder reevaluates approaching or passed expiration dates and updates the
   current `customer_document` state.
2. Expired or revoked verification creates or reopens a `customer_issue`.
3. Readiness checks return explicit blocking reasons, not passive warnings.

### 5.7 Export and audit

Audit export is a controlled back-office capability only.

Rules:

1. Export paths must be authenticated and tenant-scoped.
2. Exports should prefer derived verification reports or provider report references rather than raw
   source media.
3. Every export action must produce audit evidence describing who exported what and why.
4. Public tokens and customer-facing routes cannot retrieve historical verification reports.

---

## 6. Interfaces

| Surface | Contract |
|---|---|
| SMS/public link | fragment token only, scoped to one verification case |
| Frontend | dedicated verification route that exchanges the scoped token for a provider session and never receives generic CRM read access |
| Provider ingress | provider callback/webhook terminates at `ops_api` and hands durable work to Temporal |
| CRM write path | authenticated back-office writes remain behind approved RPC/API boundaries per ADR-0024 |
| Compliance check | explicit readiness RPC or API used before contract activation and checkout release |
| Storage | provider-hosted media only; Dealernet stores metadata, references, and derived results |
| Audit/export | authenticated back-office export or report generation only |

---

## 7. Delivery sequencing

Recommended dependency order:

1. Publish this spec plus ADR-0059 and keep security, database, and platform review labels on the
   epic.
2. Select an ID-verification provider and complete legal/security review, including DPA and retention
   terms, before any implementation story that calls the provider API.
3. Add the shared `customer_consent` capability with `identity_verification` purpose support.
4. Add `portal_verification_scope_tokens` and the narrow verification-session issuance flow.
5. Add provider callback validation, normalization, and CRM document-state persistence.
6. Add expiry monitoring plus explicit readiness-check enforcement.
7. Add authenticated audit/export surfaces.

Implementation must **not** start with operational blocking before consent capture, token scope, and
expiry-state handling are in place.

---

## 8. Test strategy

Implementation derived from this spec should prove:

- fragment tokens never reach server logs or query strings
- public verification links cannot read or write outside their verification case
- provider callback authenticity is enforced and duplicate callbacks are idempotent
- raw driver's-license or selfie media is not persisted in Dealernet-managed storage or JSONB state
- expired, missing, or failed verification blocks contract activation and checkout transitions
- consent withdrawal or erasure requests transition the verification record into the correct blocked
  state
- audit exports are authenticated, tenant-scoped, and fully logged

---

## 9. Risks and review asks

- Security review must confirm provider-hosted capture, biometric consent language, export controls,
  and webhook authenticity handling.
- Database review must confirm the consent-table shape plus document-state and erasure semantics.
- Platform review must confirm provider secret delivery and callback runtime handling.
- Legal/privacy review is required before implementation because biometric verification introduces
  consent, retention, and erasure obligations that are stricter than ordinary document storage.
