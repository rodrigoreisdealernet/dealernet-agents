# ADR-0060: Marketing attribution uses server-side capture, tenant-scoped records, and consent-gated ad sync

- **Status:** Proposed
- **Date:** 2026-06-14
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** —

## Context

Issue #428 requires an integrated marketing suite with AI-assisted campaign creation, budget caps,
Google Ads and Meta publishing, and spend-to-rental attribution. The adjacent #429 targeted-email
epic is intended to reuse the same audience and attribution substrate later.

The repo already has the right adjacent architecture:

- ADR-0037 defines the shared connector framework for provider publish and sync work.
- ADR-0051 defines the public storefront's server-side submission boundary.
- ADR-0019 still defers broad tenant RLS on the core model, so attribution joins cannot rely on
  implicit generic-table scoping.

The unresolved architecture decision is whether campaign publishing and attribution should rely on
browser-direct provider APIs and client-only tracking, or whether Dealernet should centralize publish,
click-id capture, conversion matching, and provider-side conversion sync on the server side with
explicit consent and tenant scoping.

## Decision

We keep campaign publish, spend synchronization, click-id persistence, conversion matching, and
provider-side conversion synchronization on Dealernet's server-side API plus Temporal connector path.

Campaign and audience definitions live in first-party records, storefront click identifiers are
forwarded through server-side submission paths, attribution records carry explicit tenant scope, and
provider-side conversion sync is allowed only when purpose-specific advertising-attribution consent
exists.

## Consequences

- Browser code can assist campaign drafting and landing capture, but it is not the trusted execution
  or attribution boundary.
- The platform now requires tenant-scoped touchpoint and conversion tables plus a reusable
  purpose-specific consent record.
- ROAS calculations become grounded in actual quote, reservation, or order outcomes instead of
  provider-reported vanity metrics alone.
- Dashboards must surface partial-attribution states when provider-side conversion sync is suppressed
  for lack of consent.
- #429 can reuse the audience and consent substrate without redefining attribution contracts.

## Alternatives considered

- **Use client-only pixels or browser-local click storage as the attribution source of truth:**
  rejected because it breaks durable conversion joins and creates avoidable loss or tampering risk.
- **Let the browser call Google Ads or Meta APIs directly:** rejected because ad credentials, budget
  enforcement, and auditability must stay server-side.
- **Create a separate marketing service before proving the workflow in the existing stack:** rejected
  because the current frontend, API, Temporal, and connector framework are sufficient for this scope.

## Evidence

- Issue #428
- `docs/specs/integrated-marketing-suite.md`
- `docs/specs/online-rental-storefront.md`
- `docs/adrs/0037-integration-connector-framework.md`
- `docs/adrs/0051-public-storefront-anonymous-read-server-side-submit-boundary.md`
