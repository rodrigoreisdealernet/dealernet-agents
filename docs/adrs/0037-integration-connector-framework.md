# ADR-0037: Shared connector framework for third-party integrations

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** —

## Context
The backlog now includes 31 third-party integration epics across ERP/accounting, CRM, tax,
analytics, payments, telematics, procurement, logistics, e-commerce, iPaaS, and healthcare. The
repo already has reusable substrate we can build on:

- Temporal workflows/activities as the orchestration boundary (`temporal/src/worker.py`, ADR-0003)
- an existing FastAPI `ops_api` surface for durable inbound handling (`temporal/src/ops_api/app.py`)
- config-in-DB and append-only audit/event patterns (ADR-0020)
- tenant-aware authenticated write expectations (ADR-0024)
- a hardened external-client example (`temporal/src/agents/openai_client.py`)

If each integration is implemented ad hoc, we get inconsistent auth, retry, idempotency, mapping,
and observability across dozens of vendors. The shared decision has to set one pattern before the
provider-specific epics fan out.

## Decision
We build a thin in-house connector framework inside the existing Temporal worker plus `ops_api`,
rather than introducing a separate connector microservice.

The framework lives under `temporal/src/integrations/` and uses:

- per-archetype base classes and registries for connector capabilities (`pull`, `push`,
  `webhook_ingest`, `healthcheck`, auth/token refresh, mapping)
- per-domain anti-corruption layers instead of one giant cross-vendor canonical schema
- Temporal workflows + schedules for outbound sync/polling and retry orchestration
- `ops_api` as the inbound webhook termination point, with validation there and durable handoff to
  Temporal workflows
- tenant-scoped configuration/state tables, with non-secret config in Postgres and secrets stored
  only as external secret references
- explicit identity/cursor/idempotency support tables for external aliases, sync progress, and
  delivery attempts
- shared observability through append-only sync events, retry classification, dead-letter handling,
  and dashboardable metrics

Shared data model direction:

- `integration_config`: tenant-scoped non-secret connector configuration, schedule, mappings, and
  secret references
- `external_id_map`: tenant/entity/system/external-id aliasing for durable reconciliation
- `integration_sync_state`: cursor/checkpoint/source-of-truth state per connector stream or scope
- `integration_delivery_log`: webhook dedupe, idempotency, and outbound delivery attempt history

Build-vs-buy stance by archetype:

- **Finance / ERP (`#457`-`#466`)**: evaluate unified-API vendors first; build direct adapters only
  where coverage or semantics require it
- **CRM (`#467`, `#468`)**: direct adapters on the shared framework
- **Tax (`#469`)**: direct specialist adapter
- **BI / analytics (`#470`)**: direct export/feed adapters
- **AR / payments / terminals (`#471`-`#475`)**: direct adapters because PCI/trust boundaries are
  product-specific
- **Telematics (`#476`-`#481`)**: evaluate aggregator/unified API first, direct adapters for gaps
- **Procurement (`#482`, `#483`)**: direct adapters
- **Logistics (`#484`)**: direct adapter
- **iPaaS (`#485`)**: treat MuleSoft as a customer-facing integration target, not the internal
  architecture default
- **E-commerce (`#486`)**: direct adapter
- **Healthcare / DME (`#487`)**: direct adapter behind specialist review

The first proof slice is one finance/ERP reference connector on the shared framework before broader
fan-out.

## Consequences
- Provider-specific epics inherit one connector contract for auth, retry, idempotency, cursors,
  observability, and webhook handling.
- We avoid a premature new service boundary and reuse the Temporal + `ops_api` runtime we already
  operate.
- We accept up-front framework work before the long tail of integrations starts shipping.
- Secret handling now depends on the planned External Secrets / Key Vault direction; raw connector
  credentials must not be stored in Postgres or exposed to the browser.
- Inbound webhook security, delivery semantics, and tenant-scoped state need platform/security
  review before implementation begins.

## Alternatives considered
- **Ad hoc connector code per integration epic:** rejected because it creates inconsistent behavior
  and repeated security/reliability work 31 times.
- **A separate connector microservice:** rejected because the existing Temporal worker plus
  `ops_api` already provide the execution and ingress boundaries we need.
- **One giant canonical schema for every vendor/domain:** rejected because domain-level
  anti-corruption layers are cheaper to evolve than a single universal model spanning finance,
  telematics, payments, logistics, and healthcare.
- **Buy all integrations through an iPaaS or unified-API vendor:** rejected because coverage,
  control, and cost differ by archetype; the choice should be deliberate per archetype, not a blind
  global dependency.

## Evidence
- Issue #502 and epic #892
- `temporal/src/worker.py`
- `temporal/src/ops_api/app.py`
- `temporal/src/agents/openai_client.py`
- `supabase/migrations/20260607170000_ops_factory_persistence.sql`
