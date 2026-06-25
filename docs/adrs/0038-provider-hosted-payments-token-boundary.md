# ADR-0038: Provider-hosted payment collection and token-only saved methods

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** -

## Context

The payments and invoicing roadmap needs card and ACH acceptance, pay links, saved payment methods,
refunds, and settlement handling. The repo already has a generic CRM/customer profile path where
free-form JSONB can surface `payment_methods`, but that is not a safe long-term boundary for payment
credentials.

At the same time, the platform already has the pieces needed for a safer runtime:

- `InvoiceWorkflow` and Temporal orchestration for durable billing work (ADR-0003)
- SECURITY DEFINER write boundaries for internal app/database writes (ADR-0024)
- least-privilege runtime expectations for app workloads (ADR-0029)
- a shared webhook/idempotency framework via `ops_api`, Temporal, and `integration_delivery_log`
  (ADR-0037)

The architecture decision needed here is whether Dealernet should ever handle raw payment credentials in
its own browser/backend/database surfaces, or whether payment collection stays on provider-hosted
surfaces with tokenized references only.

## Decision

We keep Dealernet out of the raw card and bank-account data path.

Payment collection must happen on provider-hosted payment pages, pay links, or equivalent provider
UI surfaces. Dealernet stores only provider token references plus non-sensitive display metadata for
saved methods, validates inbound payment webhooks at `ops_api`, and hands durable processing to
Temporal using `integration_delivery_log` for dedupe and replay safety.

## Consequences

- The app can support card/ACH payments and saved methods without expanding PCI scope into raw PAN
  or bank-account storage in Postgres, frontend code, or Temporal payloads.
- A dedicated saved-method reference store and guarded RPC boundary are now required before payment
  stories ship; free-form CRM JSONB is not an approved credential store.
- Payment-provider webhooks inherit the connector framework's idempotency and replay model instead of
  inventing a payments-only mechanism.
- The product accepts provider-hosted payment UX constraints in exchange for tighter security and a
  smaller trust boundary.
- Vendor selection remains open, but any chosen provider must support hosted collection plus durable
  token references.

## Alternatives considered

- **Direct card / ACH entry in Dealernet-managed frontend forms:** rejected because it expands the raw
  credential boundary into the browser and backend and would require much stricter PCI handling.
- **Store encrypted raw payment credentials in Postgres:** rejected because encryption at rest does
  not remove the operational and compliance burden of handling raw credentials inside the app stack.
- **Let each payment provider integration choose its own boundary:** rejected because it would create
  inconsistent security posture and storage rules across payment stories.
- **Avoid saved payment methods entirely:** rejected because saved methods are part of the product
  scope; tokenized references satisfy that need without raw credential storage.

## Evidence

- Issue #436 and story #573
- `docs/specs/payments-invoicing.md`
- `temporal/src/workflows/rental/invoice.py`
- `temporal/src/ops_api/app.py`
- `docs/adrs/0037-integration-connector-framework.md`
