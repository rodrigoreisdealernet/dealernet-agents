# ADR-0059: Provider-hosted ID verification and derived-evidence storage

- **Status:** Proposed
- **Date:** 2026-06-14
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** —

## Context

Issue #440 requires app-less driver's-license verification with SMS initiation, license-expiration
checks, selfie face match, secure customer-profile storage, operational blocking, and audit export.

The repo already has adjacent boundaries:

- ADR-0039 keeps public intake bearer tokens out of query strings and server logs.
- ADR-0037 defines the callback -> `ops_api` -> Temporal integration pattern.
- The CRM spec defines `customer_document` and `customer_issue` records for compliance state.

The unresolved architecture decision is whether Dealernet should ever hold raw driver's-license and
selfie media inside its own browser, API, database, storage, or Temporal payloads, or whether those
artifacts must stay on the verification provider while Dealernet stores only derived outcomes and report
references.

## Decision

We keep raw driver's-license and selfie capture on a provider-hosted verification surface and store
only consent state, provider references, and derived verification metadata or outcomes inside Dealernet.

Verification links use a narrow fragment-token boundary, provider callbacks terminate at `ops_api`
for authenticity validation, and operational enforcement uses CRM document and issue state rather
than storing raw media in Supabase Storage, `entity_versions`, or Temporal payloads.

## Consequences

- Dealernet avoids expanding its own data boundary to raw biometric and document media.
- The platform now requires a first-class consent record, provider DPA review, retention controls,
  and a pseudonymization or erasure path for stored derived verification records.
- The CRM document model must explicitly carve driver's-license verification out of the generic
  signed-upload blob pattern used for less sensitive documents.
- Audit export becomes a controlled back-office report path rather than raw-media retrieval from a
  public or generic staff surface.
- Provider webhook validation, derived-result normalization, and expiry reminders become mandatory
  implementation prerequisites.

## Alternatives considered

- **Store raw license and selfie media in Supabase Storage with signed URLs:** rejected because it
  materially expands Dealernet's biometric and sensitive-document handling scope.
- **Proxy raw uploads through Dealernet-managed frontend or API surfaces before forwarding to the
  provider:** rejected because transient handling still expands the raw-data boundary and creates
  unnecessary retention risk.
- **Skip selfie face match and treat license upload as a plain document workflow:** rejected because
  the product scope explicitly includes identity verification rather than storage-only compliance.

## Evidence

- Issue #440
- `docs/specs/drivers-license-id-verification.md`
- `docs/specs/customer-management-rental-crm.md`
- `docs/adrs/0037-integration-connector-framework.md`
- `docs/adrs/0039-portal-intake-bearer-token-boundary.md`
