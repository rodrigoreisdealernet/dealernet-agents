# Integration / Connector Framework Specification

**Status:** Draft
**Author:** Factory Architect
**Date:** 2026-06-09
**Related ADRs:** [ADR-0003](../adrs/0003-temporal-workflow-orchestration.md), [ADR-0020](../adrs/0020-operations-factory-agentic-ops.md), [ADR-0024](../adrs/0024-authenticated-write-path-security-definer-rls.md), [ADR-0037](../adrs/0037-integration-connector-framework.md)
**Related issues:** #892, #502, #457-#487

---

## 1. Summary

This spec defines the shared integration framework that sits underneath the third-party integration
initiative. It exists so finance, CRM, telematics, payments, procurement, logistics, and other
provider-specific epics inherit one connector contract instead of each inventing auth, retries,
webhook handling, mapping, idempotency, and observability independently.

The approved architecture is a thin connector framework inside the existing Temporal worker and
`ops_api` boundary. Provider-specific epics build adapters on top of that framework; they do not
create bespoke runtime patterns.

---

## 2. Goals

- Standardize connector lifecycle: configure, authenticate, pull/push, ingest webhooks, reconcile,
  retry, and observe.
- Reuse the existing Temporal orchestration boundary and `ops_api` ingress surface.
- Keep secrets out of Postgres and out of the browser.
- Make connector state tenant-scoped and auditable.
- Group the 31 integration epics into reusable archetypes with clear build-vs-buy guidance.

## 3. Non-goals

- Do not define provider-specific field mappings exhaustively in this spec.
- Do not select one unified-API vendor for all archetypes.
- Do not introduce a new always-on connector microservice.
- Do not treat MuleSoft as the default internal architecture; it remains a customer-facing target
  integration if needed.

---

## 4. Shared architecture

### 4.1 Runtime shape

```text
external system / vendor webhook
        |
        v
ops_api webhook endpoint
        |
        v
Temporal workflow / activity orchestration
        |
        v
connector adapter under temporal/src/integrations/
        |
        +--> external API
        +--> Supabase config/state tables
        +--> time_series_points audit / sync telemetry
```

### 4.2 Execution rules

1. Outbound sync and polling run as Temporal workflows and scheduled activities.
2. Inbound webhooks terminate at `temporal/src/ops_api/app.py`, validate authenticity there, and
   hand durable work to Temporal.
3. Provider adapters live under `temporal/src/integrations/` and implement archetype-specific base
   contracts rather than ad hoc activities.
4. Mapping stays inside per-domain anti-corruption layers. We do not create one giant universal
   schema for every vendor.
5. Every connector emits normalized sync events for audit, retry analytics, and operator dashboards.

### 4.3 Connector contract

Every adapter must define, either directly or through a base class:

- configuration schema and required secret references
- auth/token refresh behavior
- supported operations (`pull`, `push`, `webhook_ingest`, `healthcheck`)
- cursor/checkpoint behavior
- idempotency key strategy for outbound writes
- retry classification (`transient`, `rate_limit`, `auth`, `invalid_request`, `conflict`)
- dead-letter / operator-escalation behavior
- source-of-truth and conflict-resolution rules

---

## 5. Data model direction

The shared connector layer introduces these additive, tenant-scoped tables:

| Table | Purpose |
|---|---|
| `integration_config` | Non-secret connector config, enablement, schedules, mappings, and secret references |
| `external_id_map` | Stable aliasing between Wynne entities and vendor identifiers |
| `integration_sync_state` | Cursors, checkpoints, reconciliation watermarks, and source-of-truth state |
| `integration_delivery_log` | Webhook dedupe, outbound delivery attempts, idempotency, and replay handling |

Data-shape rules:

- non-secret config lives in Postgres; raw secrets and OAuth client secrets do not
- secret fields store references to the approved runtime secret source
- connector rows are tenant-scoped and must align with the authenticated write / RLS direction from
  ADR-0024
- high-volume sync and webhook events are written to `time_series_points` for audit and dashboards

---

## 6. Archetypes and build-vs-buy guidance

| Archetype | Epics | Default approach |
|---|---|---|
| Finance / ERP | #457 Vista, #458 D365, #459 CMiC, #460 JD Edwards, #461 Oracle, #462 SAP, #463 Sage, #464 NetSuite, #465 ECMS, #466 DBS | Evaluate unified-API vendors first; build direct adapters only where coverage or semantics require it |
| CRM | #467 Zoho, #468 Salesforce | Direct adapters on the shared framework |
| Tax | #469 Vertex | Direct specialist adapter |
| BI / analytics | #470 Power BI | Direct export/feed adapter |
| AR / payments / terminals | #471 Billtrust, #472 CyberSource, #473 Curbstone, #474 Verifone, #475 NMA | Direct adapters with explicit PCI and trust-boundary controls |
| Telematics | #476 Trackunit, #477 Samsara, #478 VisionLink, #479 Tierra, #480 ZTR, #481 Foresight | Evaluate aggregator/unified API first; direct adapters for unsupported gaps |
| Procurement / service | #482 SmartEquip, #483 Coupa | Direct adapters |
| Logistics / transport | #484 Descartes | Direct adapter |
| iPaaS | #485 MuleSoft | Treat as a target integration, not the internal default |
| E-commerce | #486 Shopify | Direct adapter |
| Healthcare / DME | #487 McKesson | Direct adapter under specialist review |

---

## 7. Delivery sequencing

Recommended dependency order:

1. Publish the shared architecture artifacts (ADR-0037 and this spec).
2. Build the connector-framework foundation slice:
   - base connector interfaces and registry
   - shared retry/idempotency primitives
   - `integration_config` / state tables
   - webhook ingress/validation path in `ops_api`
   - sync telemetry and dashboard contract
3. Prove the pattern with one finance/ERP reference connector.
4. Fan out by archetype, not by an arbitrary provider order.

The reference slice should be a finance/ERP connector because it exercises the highest-value shared
mechanics: outbound sync, inbound reconciliation, cursoring, identity mapping, and accounting-grade
auditability.

---

## 8. Test strategy

The foundation implementation must prove:

- contract coverage for auth/token refresh behavior
- retry classification and bounded backoff
- outbound idempotency and inbound webhook dedupe
- cursor/reconciliation checkpoint behavior
- per-tenant config isolation
- additive sync telemetry and operator-facing health signals

Provider-specific epics should add adapter contract tests and one end-to-end sync path per vendor.

---

## 9. Risks and review asks

- Webhook ingress and replay handling require security review before implementation.
- Secret-reference resolution depends on the approved platform secret-delivery path.
- Over-generalizing the canonical model would slow delivery; provider teams should reuse the shared
  framework without forcing unrelated domains into one schema.
- Unified-API vendors may simplify some archetypes but can create cost and capability lock-in;
  evaluate them deliberately rather than by default.
