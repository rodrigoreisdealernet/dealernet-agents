# ADR-0052: Sage Intacct as the v1 Sage accounting connector variant

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Factory Architect / Copilot
- **Supersedes / Superseded by:** —

## Context

Issue #1366 (child of #463) requires pinning the Sage product/API variant supported for v1 before
implementing connection setup, credential management, and tenant-scoped configuration.

The Sage portfolio spans several distinct products with incompatible APIs:

| Product | Target market | API surface |
|---------|--------------|------------|
| Sage 50 | Small business desktop | Limited flat-file / ODBC; no practical REST API |
| Sage 100 | SMB on-premise | COM SDK + ODBC; no public REST API |
| Sage 200 | Mid-size on-premise | Proprietary REST (UK/EU), limited |
| **Sage Intacct** | Mid-market cloud ERP/accounting | Full REST + XML/HTTPS API; active OAuth 2.0 support |
| Sage X3 | Enterprise on-premise / cloud | REST API but field-operator–heavy setup; heavyweight |
| Sage 300 | Mid-market (construction, rental) | COM/SOAP legacy; limited REST |

The Dealernet rental platform is a cloud-native SaaS system already consuming cloud APIs (NetSuite,
Billtrust, Samsara, Descartes). The integration framework (ADR-0037) calls for clean OAuth
client_credentials auth at the connector boundary with secret references in `secret_refs`, which
rules out the legacy COM/SOAP connectors.

Among cloud-capable Sage products, Sage Intacct is the dominant choice for rental-adjacent
accounting (AR, AP, GL, cash management) and has:

- A documented REST API (`https://api.intacct.com`) with OAuth 2.0 client_credentials support
- Active developer programme and versioned API contracts
- Established usage in construction and equipment rental verticals

## Decision

We pin Sage Intacct (`connector_key = "sage_intacct"`) as the sole supported Sage variant for v1.

The connector uses **OAuth 2.0 client_credentials** auth with:
- `client_id_secret_ref` — OAuth client ID stored as a `secret://` reference
- `client_secret_secret_ref` — OAuth client secret stored as a `secret://` reference
- `company_id` — non-secret Intacct company identifier stored in `settings`

Supported v1 scopes (accounting data flows consumed by the Dealernet rental ERP):

| Scope | Purpose |
|-------|---------|
| `general_ledger` | Journal entry posting, GL account mapping |
| `accounts_payable` | Vendor/AP invoice sync |
| `accounts_receivable` | Customer/AR invoice sync |
| `cash_management` | Bank transaction and reconciliation feeds |

No other Sage product variants will be supported in v1. A follow-on ADR is required to add any
additional Sage product.

## Consequences

- The `connector_key` is `sage_intacct` (not `sage`) to make the variant explicit in the DB and
  avoid ambiguity if a second Sage product is added later.
- Config stored in `integration_config.settings` includes `api_base_url`, `company_id`, and
  `enabled_scopes`; raw credentials are never written to Postgres.
- The connector follows the same validate/healthcheck/configure/disable pattern as Descartes,
  Samsara, and Billtrust, making it consistent with the shared framework.
- Rotations use the standard `configure` endpoint (upsert-on-conflict), so credential rotation is
  an atomic settings update that re-validates before committing.
- If a tenant requires Sage 300 or another on-premise Sage variant, a separate connector and ADR
  will be needed.

## Alternatives considered

- **Sage 300** — widely used in construction and rental but has a legacy COM/SOAP API that does not
  fit the OAuth client_credentials pattern. Rejected for v1; not blocked for a follow-on ADR.
- **Generic `connector_key = "sage"`** — rejected because future Sage variants have incompatible
  auth and data models; a variant-specific key prevents silent config aliasing.
- **MuleSoft/iPaaS mediation** — possible for tenants already on MuleSoft, but adds a dependency
  on the external platform. The ADR-0037 stance is to build direct adapters where coverage and
  semantics allow, and Sage Intacct's native REST API is sufficient.

## Evidence

- `temporal/src/integrations/sage.py` — connector implementation
- `temporal/src/ops_api/app.py` — `/api/ops/integrations/sage_intacct/configure`, `/validate`,
  `/disable` endpoints
- `supabase/migrations/20260613093000_sage_integration_config.sql` — connector_key registration
- `temporal/tests/test_sage_connector.py` — automated coverage
- Closes #1366 (child of #463)
