# ADR-0051: Public storefront uses curated anonymous reads and server-side submission

- **Status:** Proposed
- **Date:** 2026-06-13
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** —

## Context

Issue #427 requires a public online rental storefront with anonymous catalog browsing, live
availability and quote feedback, add-ons, booking submission, and publication in hosted,
embeddable, and custom-domain modes.

The repo already contains an initial storefront baseline in Supabase:

- `v_storefront_asset_catalog` exposes public catalog fields.
- `portal_storefront_get_availability(...)` evaluates date-range availability.
- `storefront_quote_requests` and `portal_storefront_submit_quote(...)` capture quote requests.

Those pieces are insufficient as the final trust boundary. ADR-0019 still defers broad tenant RLS on
the core model, so generic anonymous writes or broad staff reads are not a safe long-term public
submission pattern. At the same time, ADR-0031 already gives the frontend a browser-safe `/api/*`
path to the in-cluster ops API, and ADR-0015 establishes Azure Front Door as the external edge where
public delivery, WAF, and custom-domain onboarding belong.

## Decision

We keep the storefront in the existing frontend and AKS deployment, but treat it as a dedicated
public boundary: anonymous users read only through curated storefront projections or RPCs, and quote
or reservation submission terminates at the existing server-side API boundary rather than direct
browser writes to generic operational tables.

Hosted subdomain and embed are first-class publication modes on the shared runtime. Custom domains
use the same storefront runtime and business logic, but require explicit Azure Front Door onboarding,
verification, and activation state before going live.

## Consequences

- The storefront reuses the existing app, deployment, and order pipeline instead of creating a second
  commerce runtime.
- Public catalog and availability surfaces must stay intentionally curated; anonymous callers do not
  get generic table access just because a view or RPC already exists.
- Final checkout or booking submissions now depend on server-side validation, abuse control, host or
  publication resolution, and durable workflow handoff at the API layer.
- Publication records, branding or visibility state, host resolution, and embed policy become
  first-class data or config surfaces.
- Multi-tenant hardening must explicitly address quote-request scoping before this boundary is relied
  on for public rollout.

## Alternatives considered

- **Let the browser write directly to PostgREST SECURITY DEFINER RPCs for final booking creation:**
  rejected because it makes anonymous submission abuse control, publication scoping, and workflow
  validation too implicit at a boundary that is already security-sensitive.
- **Build a separate storefront app or service:** rejected because the existing frontend, API, quote,
  and order-pipeline stack can support the use case without introducing a second deployment surface.
- **Treat custom domains as equivalent to hosted-subdomain rollout from day one:** rejected because
  domain verification, certificate readiness, and external-edge operations require explicit platform
  onboarding and activation states.
- **Merge authenticated customer portal behavior into the public storefront:** rejected because the
  portal is a separate authenticated boundary with different access-grant and data-scoping rules.

## Evidence

- Issue #427
- `docs/specs/online-rental-storefront.md`
- `supabase/migrations/20260609010000_storefront_availability_quote.sql`
- `supabase/migrations/20260610114000_portal_inventory_projection.sql`
- `docs/adrs/0015-azure-front-door-external-edge.md`
- `docs/adrs/0031-frontend-proxies-browser-api-traffic-to-in-cluster-ops-api.md`
