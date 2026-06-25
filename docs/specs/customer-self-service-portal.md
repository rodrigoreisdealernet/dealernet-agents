# Customer Self-Service Portal Specification

**Status:** Draft
**Author:** Factory Architect
**Date:** 2026-06-12
**Related ADRs:** [ADR-0016](../adrs/0016-json-driven-ui-engine.md), [ADR-0019](../adrs/0019-app-layer-tenant-scoping-rls-deferred.md), [ADR-0024](../adrs/0024-authenticated-write-path-security-definer-rls.md), [ADR-0038](../adrs/0038-provider-hosted-payments-token-boundary.md), [ADR-0039](../adrs/0039-portal-intake-bearer-token-boundary.md), [ADR-0043](../adrs/0043-customer-portal-passwordless-session-boundary.md)
**Related issues:** #427, #439

---

## 1. Summary

This spec defines the external customer portal for passwordless access to rentals, invoices,
delivery status, payment history, and operator-routed service requests such as call-offs and
extensions.

The approved direction is to keep the portal inside the existing frontend and Supabase stack, but
to give it a distinct external-customer auth boundary. Portal users sign in with magic-link email
sessions scoped to explicit customer/billing-account access grants, and every read/write surface is
served through narrow portal projections or RPCs rather than generic table access.

---

## 2. Goals

- Let an existing verified customer contact sign in with an email link and see only their allowed
  customer, billing-account, rental, invoice, and schedule data.
- Reuse the canonical `customer`, `billing_account`, `contact`, `job_site`, `rental_order`,
  `contract`, and `invoice` boundaries instead of inventing a second customer-facing schema.
- Support self-service call-off and extension requests without letting the browser directly mutate
  contract or dispatch state.
- Support invoice payment from the portal while staying inside ADR-0038's provider-hosted payment
  boundary.
- Keep the portal mobile-friendly and embeddable without creating a separate deployment/runtime.

## 3. Non-goals

- Do not add new-customer self-signup or anonymous customer search.
- Do not expose raw payment credential entry in the app.
- Do not merge the portal into the authenticated storefront flow from #427; authenticated ordering
  and reorder flows are a follow-on design once the storefront/portal boundary is reviewed.
- Do not give portal users broad SQL/table access to operational records.

---

## 4. Current baseline and required gaps

The repo already has the main building blocks the portal must sit on top of:

- the rental ERP domain model for customer, billing, orders, contracts, invoices, and delivery data
- the CRM spec for contact and customer-profile authority
- ADR-0038's provider-hosted payment boundary
- ADR-0039's token hardening for pre-auth intake links

The formal implementation must account for these gaps before approval:

1. ADR-0039 covers one-shot intake bearer tokens, not durable authenticated customer sessions.
2. ADR-0036 covers internal Keycloak-backed operator access, not consumer/customer sessions.
3. ADR-0019 keeps tenant scoping at the app layer today; the portal therefore cannot depend on raw
   frontend access to generic entity tables.
4. There is no existing customer-scoped projection for "my rentals / my invoices / my delivery
   schedule"; those must be introduced explicitly.

These are design inputs, not reasons to fork the stack.

---

## 5. Approved architecture direction

### 5.1 Surface model

The portal is a dedicated route tree in the existing frontend application, not a separate product
deployment.

Recommended entry shape:

```text
/portal
/portal/login
/portal/rentals
/portal/invoices
/portal/requests
```

This keeps branding, embeddable shell behavior, and shared UI primitives inside the existing
React/TanStack/JSON-driven stack while still allowing a separate navigation shell and customer-safe
screen registry.

### 5.2 Identity and session boundary

Portal access is granted only to verified customer contacts already linked to a `customer` and at
least one `billing_account` or other approved operational scope.

Approved session pattern:

1. An internal operator enables portal access for a contact.
2. The system creates or updates an explicit access-grant record for that contact.
3. The contact signs in through a Supabase GoTrue magic-link email flow.
4. Post-auth claim mapping assigns a dedicated `portal_customer` app role plus the tenant/customer
   access-grant reference.
5. Portal RPCs and projections resolve the session to the access grant before returning data.

Rules:

- No public self-signup.
- Do not reuse internal operator roles (`admin`, `branch_manager`, `field_operator`, `read_only`)
  for portal sessions.
- Do not rely on caller-supplied customer ids from the browser.
- Portal sessions may read only through portal-scoped projections/RPCs and may write only through
  explicit request/payment-entry surfaces.

### 5.3 Read surfaces

Portal reads must be served from allow-listed projections or RPCs that enforce access-grant scope.

Minimum surfaces:

| Surface | Contents |
|---|---|
| `portal_rental_overview` | current/past/upcoming rentals, status, order/contract identifiers, equipment summary, date windows |
| `portal_invoice_overview` | outstanding invoices, balances, due dates, payment status/history summary |
| `portal_delivery_status` | scheduled delivery/pickup date, current operational status, latest dispatch milestone |
| `portal_contact_profile` | signed-in contact display info and allowed customer/account context |

These may be views, RPCs, or `ops_api` endpoints, but they must remain portal-specific and
session-scoped.

### 5.4 Write actions

Portal writes are request-oriented, not direct operational edits.

Approved write surfaces:

- **Call-off request** — create a durable service-request record tied to the contract or rental line,
  then route fulfillment through the existing back-office workflow.
- **Extension request** — create a request for staff review/approval; do not directly change the
  contract end date from the browser.
- **Invoice payment** — generate or resolve a provider-hosted payment link and redirect the customer
  to that surface. Settlement returns through the webhook -> `ops_api` -> Temporal path from
  ADR-0038.

No portal write path may directly set rental status, dispatch status, invoice settlement state, or
customer master data without an internal workflow boundary.

### 5.5 Data model direction

Recommended additive records:

| Record | Purpose |
|---|---|
| `portal_customer_access_grant` table | maps auth user/contact to tenant/customer/billing-account scope and enablement state |
| `portal_service_request` entity | durable request record for call-off/extension and future portal-generated service asks |
| portal audit events in `time_series_points` | sign-in, request submitted, payment-link generated, access revoked |

Minimum access-grant fields:

- tenant id
- contact entity id
- auth user id
- customer id
- allowed billing-account ids or equivalent scoped references
- status (`pending`, `active`, `revoked`)
- issued/revoked timestamps

### 5.6 Interface contract

| Interface | Direction | Notes |
|---|---|---|
| GoTrue magic-link auth | portal -> Supabase auth | external customer session bootstrap |
| portal session claim mapping | auth/db trigger path | assigns `portal_customer` role and access-grant reference |
| portal rental/invoice/delivery RPCs | frontend -> DB or `ops_api` | read-only, scoped to access grant |
| portal service-request endpoint | frontend -> DB/Temporal | creates durable request; staff workflow handles fulfillment |
| provider-hosted pay link | portal -> payment provider | no raw payment credentials in app |

---

## 6. Delivery sequencing

Recommended order:

1. Land the session/access-grant boundary from ADR-0043.
2. Add portal projections/RPCs for rentals, invoices, and delivery status.
3. Add the portal request workflow for call-offs/extensions.
4. Add provider-hosted payment launch + payment-history visibility.
5. Revisit the authenticated reorder/storefront overlap with #427 as a follow-on design.

---

## 7. Test strategy

The implementation should prove:

- a contact without an active access grant cannot sign in to a usable portal session
- a portal user sees only the customer/account scope from their access grant
- call-off/extension submissions create durable requests without directly mutating contract state
- invoice payment launches only provider-hosted payment flows
- delivery and invoice views remain mobile-usable and customer-safe

Test layers should include:

- frontend route/component tests for login, list/detail rendering, and request submission
- Supabase/ops-api contract tests for access-grant scoping and denial cases
- workflow/API tests for request creation and payment-link handling

---

## 8. Risks and review asks

- **Security review is required before approval.** External-customer session claims, access-grant
  revocation, and portal projection scope are trust-boundary work.
- The portal/storefront boundary with #427 must stay explicit so authenticated ordering is not
  smuggled into this scope.
- Because ADR-0019 deferred broad RLS rollout, the implementation must not use generic table reads
  from the customer browser session as a shortcut.
