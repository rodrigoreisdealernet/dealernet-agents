# Integrated Marketing Suite Specification

**Status:** Draft
**Author:** Factory Architect
**Date:** 2026-06-14
**Related ADRs:** [ADR-0005](../adrs/0005-azure-openai-chat-with-tools-adapter.md), [ADR-0019](../adrs/0019-app-layer-tenant-scoping-rls-deferred.md), [ADR-0024](../adrs/0024-authenticated-write-path-security-definer-rls.md), [ADR-0037](../adrs/0037-integration-connector-framework.md), [ADR-0051](../adrs/0051-public-storefront-anonymous-read-server-side-submit-boundary.md), [ADR-0060](../adrs/0060-marketing-attribution-server-side-boundary.md)
**Related issues:** #428, #429, #427

---

## 1. Summary

This spec defines the integrated marketing suite for authenticated operators to build local ad
campaigns from first-party inventory and branch data, publish campaigns to Google Ads and Meta, and
measure campaign performance through spend-to-rental attribution.

The approved direction keeps campaign configuration and attribution logic inside Dealernet's existing
frontend, API, Temporal, and Supabase stack, but treats campaign publishing and attribution as
server-side boundaries. Operators work through authenticated back-office flows; ad-platform
connectors run through the shared integration framework; and conversion attribution is built from
server-side captured click identifiers plus rental outcomes, not browser-only pixels or vanity
metrics.

---

## 2. Goals

- Let operators generate, edit, review, budget, geo-target, and launch campaigns without leaving the
  platform.
- Reuse existing inventory, branch, customer, storefront, and order signals rather than creating a
  separate marketing data silo.
- Attribute conversions to quotes, reservations, or orders with explicit spend, revenue, and ROAS
  reporting.
- Keep ad-account credentials, publish actions, and conversion sync out of the browser.
- Preserve an extension point for #429 targeted email campaigns to reuse the shared audience and
  attribution layer later.

## 3. Non-goals

- Do not merge email delivery, ESP templating, or CAN-SPAM automation into this epic; that remains
  #429.
- Do not let browser code call Google Ads or Meta APIs directly.
- Do not trust client-only click tracking or client-only conversion beacons as the source of truth
  for attributed rentals.
- Do not send customer PII to AI copy-generation prompts.

---

## 4. Existing baseline and required gaps

The repo already has key foundations this design must build on:

- `docs/specs/online-rental-storefront.md` defines the public storefront and server-side submission
  boundary.
- ADR-0051 already keeps anonymous storefront submission on the server side.
- ADR-0037 already defines the connector framework for Google or Meta publish/sync work.
- The backlog already separates #428 integrated marketing from #429 targeted email but notes they
  should share audience and attribution primitives.

The marketing-suite rollout must resolve these verified gaps before implementation stories start:

1. The repo has no tenant-scoped campaign or audience model yet.
2. The repo has no consent record yet for advertising-attribution data sharing.
3. The storefront boundary does not yet define click-id capture and persistence for `gclid`,
   `fbclid`, or equivalent provider identifiers.
4. ADR-0019 still defers broad tenant RLS on the core model, so attribution-relevant records cannot
   rely on implicit generic-table scoping.
5. The repo has no spend, click, or conversion read model yet for ROAS dashboards.

These are design inputs, not reasons to add a separate marketing service.

---

## 5. Approved architecture direction

### 5.1 Runtime shape

```text
authenticated operator
        |
        v
marketing workspace in frontend
        |
        v
server-side API / ops_api
        |
        v
Temporal campaign workflow
        |
        +--> AI draft generation
        +--> Google Ads / Meta connector publish
        +--> spend/status sync
        +--> attribution projection refresh

public storefront landing
        |
        v
click-id capture
        |
        v
server-side quote / booking submit
        |
        v
touchpoint + conversion attribution records
        |
        v
campaign dashboard and ROAS read models
```

### 5.2 Back-office AI generation

AI generation is an authenticated operator-assist feature, not an autonomous ad-launch path.

Rules:

1. Reuse ADR-0005's approved AI adapter path for draft generation.
2. Prompt material may include inventory category, branch, seasonality, geo radius, pricing-band, and
   campaign objective context.
3. Prompt material must exclude customer PII, raw order histories, or ad-platform credentials.
4. Generated copy and keywords land as editable drafts; an operator approves before publish.
5. Budget ceilings and geo targeting are validated server-side before any publish call.

### 5.3 Campaign, audience, and connector model

The suite needs first-class campaign and audience records even before #429 ships.

Recommended durable records:

| Record | Purpose |
|---|---|
| `marketing_campaign` entity | campaign definition, objective, budget, targeting, creative draft, lifecycle |
| `marketing_audience` entity | reusable first-party audience definition and filter criteria |
| `integration_config` rows | ad-account connection metadata and secret references per ADR-0037 |
| tenant-scoped attribution tables | touchpoints, conversions, spend snapshots, and dashboard inputs |

Campaign and audience rules:

1. `marketing_audience` is a first-class reusable definition, not a campaign-only JSON blob, so #429
   can later reuse it.
2. Audience membership is computed from first-party data at execution time; if persistence is needed,
   store tenant-scoped snapshots rather than mutable customer lists in campaign JSON.
3. Campaign publish, pause, and sync actions run through Temporal workflows and ad-platform adapters
   under the shared connector framework.

### 5.4 Budget and publish enforcement

Budget caps are enforced inside Dealernet before provider publish, with provider-side budgets as a second
guardrail.

Rules:

1. Operators cannot publish a campaign whose requested spend exceeds the approved cap for the
   campaign, branch, or tenant.
2. Temporal validates the current cap and launch state before calling provider APIs.
3. Provider-reported spend is synchronized back into the dashboard to detect drift or overspend.
4. Browser code may initiate intent, but final publish or pause actions happen only through the
   server-side API and connector flow.

### 5.5 Attribution and consent boundary

Attribution requires both first-party capture and purpose-specific consent handling.

Rules:

1. Add a shared `customer_consent` capability that can represent at least:
   - `identity_verification`
   - `advertising_attribution`
   - future `email_marketing`
2. Conversion or enhanced-conversion payloads must not be sent to Google Ads or Meta unless the
   relevant `advertising_attribution` consent state permits it.
3. When consent is absent, Dealernet may still compute internal first-party attribution for operator
   analytics, but provider-side conversion sync stays suppressed and dashboard reporting must mark the
   result as partial.
4. Attribution-relevant records must carry explicit `tenant_id` and publication or storefront scope
   until broader RLS or tenant-hardening work closes the ADR-0019 gap.

### 5.6 Click-id capture and conversion matching

The source-of-truth attribution join happens on the server side.

Rules:

1. Capture `gclid`, `fbclid`, or equivalent click identifiers when a user lands on the storefront.
2. Forward the click identifier through the server-side quote or booking submission path from
   ADR-0051; do not leave it only in browser-local state.
3. Store touchpoints in a tenant-scoped table keyed to publication or storefront context and the
   campaign or ad-group reference where known.
4. Match downstream quote, reservation, or rental-order conversions back to the stored touchpoint on
   the server side.
5. ROAS and revenue calculations are derived from actual rental outcomes, not ad-platform conversion
   counters alone.

### 5.7 Dashboard and measurement model

Operators need spend, click, conversion, and revenue views on one read model.

Required dashboard outputs:

- spend by campaign, date, and branch
- clicks and landing touchpoints
- quotes, reservations, or orders attributed
- attributed revenue
- ROAS
- source and campaign filters
- consent-limited or partial-attribution flags where provider sync is suppressed

---

## 6. Data model direction

Recommended additive records:

| Record | Storage pattern | Why |
|---|---|---|
| `marketing_campaign` | entity + `entity_versions` | low-frequency campaign config and lifecycle |
| `marketing_audience` | entity + `entity_versions` | reusable audience definition shared with #429 |
| `customer_consent` | explicit tenant-scoped table | purpose-specific consent lookups need direct tenant scoping |
| `marketing_touchpoint` | explicit tenant-scoped table | public click identifiers and landing context need direct tenant scoping |
| `marketing_conversion_attribution` | explicit tenant-scoped table | conversion-to-touchpoint joins and revenue attribution need queryable scope |
| spend sync events | `time_series_points` or equivalent append-only sync log | provider spend/status history |

`marketing_campaign` state should include:

- objective
- status (`draft`, `ready_for_review`, `scheduled`, `active`, `paused`, `archived`, `failed`)
- budget amount and cadence
- geo target metadata
- channel (`google_ads`, `meta`)
- creative draft references
- linked audience definition

`marketing_audience` state should include:

- audience type (`inventory_interest`, `geographic`, `lookback_behavioral`, `customer_segment`)
- filter criteria
- publication or branch scope
- freshness or recompute policy

Recommended fact or event outputs:

- `marketing_spend`
- `marketing_click`
- `marketing_conversion`
- `marketing_attributed_revenue`
- `marketing_roas`

---

## 7. Interfaces

| Surface | Contract |
|---|---|
| Frontend | authenticated campaign builder and dashboard inside existing app |
| AI generation | ADR-0005 adapter, inventory/location inputs only, operator review required |
| Publish path | `/api/*` or equivalent server-side API -> Temporal -> provider adapter |
| Provider connectors | Google Ads and Meta adapters under ADR-0037 |
| Storefront ingestion | server-side quote or booking submit carries click-id context per ADR-0051 |
| Attribution store | tenant-scoped touchpoint and conversion tables with explicit publication/storefront scope |
| Dashboard | read model joining spend sync, touchpoints, conversions, and order revenue |

---

## 8. Delivery sequencing

Recommended dependency order:

1. Publish this spec plus ADR-0060 and keep security, database, and platform review labels on the
   epic.
2. Add the shared `customer_consent` capability with `advertising_attribution` purpose support.
3. Add campaign and audience definitions plus the server-side publish orchestration boundary.
4. Add click-id capture and server-side persistence on storefront submission paths.
5. Add tenant-scoped touchpoint and conversion attribution records plus dashboard read models.
6. Add Google Ads and Meta connector implementations plus spend-status synchronization.
7. Reuse the audience and consent substrate later for #429 targeted email campaigns.

Implementation must **not** treat client-only pixels, client-only click storage, or browser-direct
provider API calls as acceptable substitutes for the server-side attribution path.

---

## 9. Test strategy

Implementation derived from this spec should prove:

- campaign publish and pause actions cannot bypass server-side budget validation
- AI draft generation excludes customer PII inputs and requires operator review before publish
- click identifiers survive the public landing -> server-side submit -> order conversion flow
- attribution tables remain tenant-scoped and do not leak cross-tenant campaign data
- provider-side conversion sync is suppressed when advertising-attribution consent is absent
- ROAS is computed from actual rental outcomes and marks partial-attribution cases correctly
- #429 can later reuse the same audience definition without redefining campaign storage contracts

---

## 10. Risks and review asks

- Security review must confirm consent handling, ad-platform credential delivery, and any outbound
  conversion payload shape.
- Database review must confirm the tenant-scoped attribution tables and consent-table shape.
- Platform review must confirm provider OAuth/secret delivery and background connector operations.
- The storefront implementation must not claim production-safe attribution until the ADR-0019 tenant
  scoping gap is explicitly handled on every attribution-relevant read path.
