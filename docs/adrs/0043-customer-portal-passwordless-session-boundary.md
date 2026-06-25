# ADR-0043: Customer portal uses passwordless Supabase sessions with explicit access grants

- **Status:** Proposed
- **Date:** 2026-06-12
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** The "portal does not use anonymous access" statement is partially superseded by ADR-0056 for the read-only portal schedule surface only; all write and session paths remain as stated here

## Context

Issue #439 requires an external customer portal where a customer contact signs in with an email link
to view rentals, invoices, delivery status, and provider-hosted payment links.

The repo already has two adjacent but insufficient auth patterns:

- ADR-0039 secures one-shot intake bearer tokens before any authenticated session exists.
- ADR-0036 covers internal operator access via Keycloak -> Supabase federation.

Neither pattern defines a durable external-customer session with record-level customer/account scope.
At the same time, ADR-0019 deferred broad RLS rollout on the core data model, so the portal cannot
depend on unrestricted frontend reads against generic operational tables.

## Decision

We use Supabase GoTrue magic-link sessions for verified customer contacts, assign those sessions a
dedicated `portal_customer` role, and bind each session to an explicit access-grant record that
defines which tenant/customer/billing-account scope the user may read.

Portal reads and writes go only through portal-scoped projections, RPCs, or `ops_api` endpoints that
resolve the authenticated session to the access grant. The portal does not use anonymous access,
intake tokens, or internal operator roles as its long-lived auth boundary.

## Consequences

- The portal reuses the existing Supabase auth stack without introducing a second external identity
  service.
- The implementation must add an access-grant store plus claim-mapping logic for the
  `portal_customer` role before portal screens ship.
- Portal reads cannot shortcut through generic table access while ADR-0019 remains in effect.
- Revocation, disabled contacts, and customer/account-scope changes now become explicit auth-state
  transitions rather than ad hoc UI checks.

## Alternatives considered

- **Reuse intake bearer tokens as the portal session:** rejected because intake tokens are narrow,
  one-shot, and not a durable authenticated customer session model.
- **Reuse internal Keycloak/group-based operator auth:** rejected because customer contacts are not
  internal operators and should not inherit employee roles or SSO assumptions.
- **Allow public self-signup plus email matching to customer records:** rejected because it expands
  account-linking and takeover risk beyond the requested scope.

## Evidence

- Issue #439
- `docs/specs/customer-self-service-portal.md`
