# Online Rental Storefront Specification

**Status:** Draft
**Author:** Factory Architect
**Date:** 2026-06-13
**Related ADRs:** [ADR-0015](../adrs/0015-azure-front-door-external-edge.md), [ADR-0016](../adrs/0016-json-driven-ui-engine.md), [ADR-0019](../adrs/0019-app-layer-tenant-scoping-rls-deferred.md), [ADR-0024](../adrs/0024-authenticated-write-path-security-definer-rls.md), [ADR-0031](../adrs/0031-frontend-proxies-browser-api-traffic-to-in-cluster-ops-api.md), [ADR-0038](../adrs/0038-provider-hosted-payments-token-boundary.md), [ADR-0051](../adrs/0051-public-storefront-anonymous-read-server-side-submit-boundary.md)
**Related issues:** #427, #542, #543, #544, #545, #546, #547

---

## 1. Summary

This spec defines the public online rental storefront for anonymous catalog browsing, date-scoped
availability, live quote building, add-on and cross-sell selection, quote or reservation handoff
into the rental-order pipeline, and storefront publication in hosted-subdomain, embed, and
custom-domain modes.

The approved direction keeps the storefront inside the existing frontend, Supabase, and AKS/Front
Door stack, but treats it as a dedicated public boundary: anonymous users read only through
curated storefront projections and RPCs, while quote or reservation submission terminates at the
existing server-side API boundary instead of generic browser-direct writes to operational tables.

---

## 2. Goals

- Provide a mobile-friendly, SEO-aware public catalog over the existing rental inventory and quote
  engine.
- Let anonymous customers select dates, see live availability and pricing, add approved add-ons,
  and submit a booking or quote request without staff mediation.
- Reuse the existing rental-order pipeline, customer model, pricing surfaces, and deployment stack
  instead of inventing a separate commerce backend.
- Support three publication modes without forking business logic: hosted subdomain, embeddable
  storefront, and custom-domain onboarding.
- Keep authenticated customer portal flows and online payment capture explicitly out of this slice.

## 3. Non-goals

- Do not allow generic anonymous PostgREST writes into order, contract, invoice, or customer
  tables.
- Do not merge authenticated customer portal or reorder flows into this storefront scope.
- Do not introduce a second frontend deployment or per-storefront infrastructure fork.
- Do not capture raw payment credentials in the storefront; payment launch stays provider-hosted per
  ADR-0038 when that follow-on scope is ready.
- Do not treat local Docker Compose as a production storefront runtime or edge model.

---

## 4. Existing implementation baseline and required gaps

The repo already contains a storefront baseline that this design must build on rather than replace:

- `v_storefront_asset_catalog` exposes a curated anonymous catalog projection.
- `portal_storefront_get_availability(...)` provides date-range availability checks over current
  rental state.
- `storefront_quote_requests` stores submitted quote requests.
- `portal_storefront_submit_quote(...)` inserts quote requests through a SECURITY DEFINER RPC.
- `v_storefront_asset_catalog` was later widened to project from
  `rental_current_inventory_records`, so both serialized assets and eligible stock items can appear
  in the storefront catalog.

The formal storefront rollout must account for these verified gaps:

1. There is no storefront publication model yet for branding, visibility toggles, featured content,
   host resolution, embed settings, or custom-domain verification state.
2. `storefront_quote_requests` does not carry publication or tenant scope, and its current
   staff-read policy is role-scoped rather than tenant-scoped. Under ADR-0019 this is not a safe
   long-term multi-tenant boundary.
3. `v_storefront_asset_catalog` currently exposes anon-visible pricing and operational status
   without a publication-level rule for hidden pricing or an explicit filter that excludes
   discontinued or otherwise unpublished inventory.
4. The current quote-request RPC is acceptable as a baseline capture surface, but the final public
   booking submission for quote or reservation creation must terminate at the existing server-side
   API boundary so abuse controls, validation, and workflow orchestration do not depend on generic
   anonymous database entry points.
5. Anonymous submission abuse controls, host-header isolation, embed CSP or frame policy, and Front
   Door custom-domain onboarding are not yet documented as required runtime controls.

These are design inputs, not reasons to fork the stack.

---

## 5. Approved architecture direction

### 5.1 Public route tree and publication resolution

The storefront is a dedicated public route tree in the existing frontend application, not a second
application deployment.

Recommended runtime shape:

```text
public host or embed URL
        |
        v
frontend storefront route tree
        |
        +--> publication resolution (host/path/embed context)
        +--> public catalog / availability reads
        +--> cart / quote state
        +--> server-side quote or reservation submission
```

Hosted-subdomain delivery may use a dedicated `/storefront/*` route tree on the shared app host or
resolve by storefront hostname. Embed and custom-domain modes must reuse the same runtime and
publication model; delivery mode must not fork core quote or reservation logic.

### 5.2 Publication and branding boundary

The storefront needs a first-class publication record before #546 and #547 are complete.

Recommended additive record:

| Record | Purpose |
|---|---|
| `storefront_publication` table or entity | binds tenant/storefront identity to mode, branding, visibility, host/embed config, and verification state |

Minimum publication fields:

- tenant id
- storefront identity or slug
- publication mode (`hosted_subdomain`, `embed`, `custom_domain`)
- status (`draft`, `published`, `verification_pending`, `verification_failed`, `revoked`)
- resolved hostname or embed path
- requested custom domain and verification metadata
- branding metadata
- featured categories/items ordering
- pricing visibility flags

All public catalog, availability, and submission surfaces must resolve through publication identity
so cache keys, host headers, and storefront branding stay isolated.

### 5.3 Anonymous read boundary

Anonymous callers may read only through curated storefront projections and RPCs.

Minimum read surfaces:

| Surface | Contents |
|---|---|
| `v_storefront_asset_catalog` or successor storefront projection | public catalog cards, imagery, branch/category metadata, storefront-safe specs |
| availability RPC | date-scoped availability and conflict reasons |
| storefront configuration read model | branding, featured items, category ordering, pricing-display rules |

Rules:

1. Public catalog reads must filter out unpublished or operationally unavailable inventory unless a
   later design explicitly approves a separate "visible but unavailable" merchandising state.
2. Pricing exposure must honor publication-level visibility configuration; anonymous users must not
   see hidden commercial fields because the raw catalog view happens to expose them.
3. Host and publication resolution must key caches and responses by publication identity to avoid one
   storefront leaking into another.
4. Anonymous reads must not require direct access to generic operational tables.

### 5.4 Submission boundary

Anonymous quote or reservation submissions terminate at the existing server-side API boundary, not
at generic browser-direct PostgREST writes.

Approved write path:

```text
storefront browser
        |
        v
/api storefront endpoint
        |
        v
ops_api / dia-api validation + publication resolution
        |
        v
Temporal / DB write surfaces / quote engine
        |
        v
quote, reservation, or staff-review handoff
```

Rules:

1. Final booking creation for #545 must use the server-side API boundary.
2. The server-side boundary validates publication identity, rate freshness, availability inputs, and
   allowed add-ons before creating downstream records.
3. Anonymous callers never receive generic write access to rental orders, contracts, invoices, or
   customer master data.
4. Lead-capture or low-risk transitional flows may reuse the existing quote-request storage only if
   they remain publication-scoped and are not treated as the long-term booking contract.
5. Abuse controls such as edge rate limiting or equivalent protection are mandatory before public
   rollout.

### 5.5 Quote, cart, and add-on model

The storefront quote experience composes existing pricing and rental logic rather than inventing a
new commerce engine.

Required behaviors:

- date-range quote calculation uses the established pricing boundary
- add-ons such as damage waiver or delivery remain explicit quote-line inputs, not ad hoc cart-only
  fields
- cross-sell recommendations are merchandising inputs layered on top of the catalog and quote
  results
- submitted outcomes still land in the existing quote or reservation workflow so operator review,
  conversion, and downstream billing remain consistent

### 5.6 Delivery modes

Three publication modes are in scope, with one runtime model:

1. **Hosted subdomain** — platform-managed hostname on the existing external-edge pattern.
2. **Embed** — same storefront rendered in an embeddable shell with explicit frame and CSP policy.
3. **Custom domain** — customer-owned hostname that stays in a verification or pending state until
   platform onboarding completes through Azure Front Door.

Hosted subdomain and embed are application-deliverable slices. Custom-domain activation requires
explicit platform review, DNS verification, certificate readiness, and clear cutover state before
the storefront is marked live.

### 5.7 Portal and payments boundaries

The customer self-service portal remains a separate authenticated boundary from this public
storefront.

- authenticated reorder and account-linked portal ordering are follow-on design, not part of #427
- payment initiation at checkout is a follow-on integration with ADR-0038's provider-hosted payment
  boundary
- the storefront must not expand into raw payment credential capture or generic authenticated portal
  reads as a shortcut

---

## 6. Interfaces

| Surface | Contract |
|---|---|
| Frontend | dedicated public storefront route tree and publication-aware rendering |
| Catalog read path | storefront-safe projections and availability RPCs only |
| Submission path | `/api/*` -> `ops_api` / `dia-api` -> workflow or DB write surfaces |
| Quote engine | existing pricing and fee calculation boundary, not bespoke browser math |
| Order pipeline | submitted storefront outcomes enter the canonical quote or reservation flow |
| Publication model | branding, visibility, hostname, embed, and verification metadata |
| External edge | Azure Front Door-hosted delivery and custom-domain onboarding |

---

## 7. Delivery sequencing

Recommended dependency order:

1. Publish this storefront spec plus ADR-0051 and keep specialist-review labels on the epic.
2. Land publication configuration, branding, and visibility controls (#546).
3. Keep catalog and availability flows aligned to publication-aware anonymous read models (#542,
   #543).
4. Keep cart/add-on logic on top of the shared pricing and order surfaces (#544).
5. Complete the server-side quote or reservation handoff boundary for checkout (#545).
6. Add hosted-subdomain, embed, and custom-domain publication handling with platform onboarding for
   the custom-domain slice (#547).
7. Revisit authenticated portal overlap only as a separate follow-on design.

Implementation must not treat the existing anonymous quote-request table as the final architecture
for public booking creation.

---

## 8. Test strategy

The implementation derived from this spec should prove:

- anonymous catalog reads expose only storefront-safe fields for the resolved publication
- availability and quote results stay correct for the selected dates and add-ons
- submission flows create the correct downstream quote or reservation outcome without generic public
  table writes
- publication identity, host resolution, and caching cannot leak one storefront into another
- hidden-pricing and unpublished-inventory rules are enforced
- embed and hosted-subdomain delivery share the same business behavior
- custom-domain activation stays pending until platform verification succeeds

Test layers should include:

- frontend route and component tests for browse, filter, quote, cart, and publication-mode behavior
- Supabase or API contract tests for public read surfaces, denial cases, and publication scoping
- workflow or API tests for quote or reservation submission, add-on carry-through, and idempotency
- platform validation or onboarding runbook coverage for hosted and custom-domain edge setup

---

## 9. Risks and review asks

- **Security review is required.** Parent-epic design approval does not imply `ready-for-dev` while
  specialist-review labels remain. The reviewer must validate the anonymous submission abuse
  boundary, publication and tenant scoping, pricing exposure rules, and the deprecation path away
  from generic public write entry points.
- **Platform review is required.** Hosted-subdomain, embed, and custom-domain delivery depend on the
  Azure Front Door edge model, host-resolution behavior, and domain-verification operations.
- The current `storefront_quote_requests` tenant gap must be closed or explicitly constrained before
  multi-tenant rollout.
- Embed delivery needs explicit CSP or frame policy handling so third-party hosts cannot misuse the
  storefront shell.
- The portal/storefront boundary must stay explicit so authenticated customer flows are not smuggled
  into the anonymous storefront scope.
