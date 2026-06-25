# AI-Powered Reporting Specification

**Status:** Draft
**Author:** Factory Architect
**Date:** 2026-06-12
**Related ADRs:** [ADR-0005](../adrs/0005-azure-openai-chat-with-tools-adapter.md), [ADR-0019](../adrs/0019-app-layer-tenant-scoping-rls-deferred.md), [ADR-0020](../adrs/0020-operations-factory-agentic-ops.md), [ADR-0024](../adrs/0024-authenticated-write-path-security-definer-rls.md), [ADR-0044](../adrs/0044-reporting-semantic-layer-query-boundary.md)
**Related issues:** #438, #450, #470

---

## 1. Summary

This spec defines the natural-language analytics and standard-metric reporting surface for rental,
customer, fleet, and AR questions.

The approved direction is to put both AI reporting (#438) and enterprise self-service BI/reporting
(#450) on top of one tenant-scoped reporting semantic layer. AI requests use a bounded read-only
tool/query layer over that projection instead of direct model-generated SQL against operational
tables.

---

## 2. Goals

- Let an authorized user ask plain-English operational questions and receive grounded answers with
  chart/table output.
- Provide standard metrics for utilization, downtime, ROI, AR, unpaid balances, and fulfillment.
- Reuse the existing Azure OpenAI tool-loop pattern where it fits, without exposing raw operational
  tables to unrestricted LLM-authored queries.
- Share one metric and dimensional model with dashboard/reporting work in #450 and Power BI work in
  #470.
- Keep interactive question latency low while offloading heavier export jobs to durable workflows.

## 3. Non-goals

- Do not let the model synthesize arbitrary SQL over the generic entity store.
- Do not replace the self-service dashboard builder and embeddable BI scope from #450.
- Do not ship proactive alerting, forecasting, or autonomous operational actions in this slice.
- Do not treat stale CSV extracts as the source of truth for core live metrics.

---

## 4. Current baseline and required gaps

The repo already has useful ingredients:

- the generic entity/facts/events rental data model
- ADR-0005's bounded Azure OpenAI `chat_with_tools()` adapter
- the Operations Factory pattern for read-only tool usage and structured outputs

The reporting implementation must account for these gaps before approval:

1. There is no shared reporting semantic layer today for either AI reporting (#438) or Reporter-like
   BI (#450).
2. ADR-0019 deferred broad database RLS on core tables, so direct NL-to-base-table querying is not an
   acceptable trust boundary.
3. Standard metric definitions (utilization, downtime, ROI, AR aging, fulfillment) are not yet
   normalized into one query contract.
4. Export generation and dashboard embedding need a shared projection boundary so BI and AI results
   do not drift.

---

## 5. Approved architecture direction

### 5.1 Shared reporting semantic layer

AI and BI reporting must read from a curated reporting layer, not from raw operational tables.

The reporting layer should expose subject areas such as:

| Subject area | Examples |
|---|---|
| fleet performance | utilization, downtime, revenue by asset/category/branch |
| financial health | AR aging, unpaid balances, invoice/payment summaries |
| order fulfillment | on-time %, reservation/fulfillment status, delivery performance |
| customer performance | revenue, rental mix, exceptions, payment trend summaries |

The layer may be implemented with views, materialized views, or additive projection tables, but it
must provide:

- stable metric definitions
- allow-listed dimensions and time grains
- tenant-scoped filtering before AI tooling consumes the data
- a contract that #450 and #470 can reuse without redefining metrics

### 5.2 Query boundary

Natural-language reporting follows this shape:

```text
user question
    |
    v
question classifier / planner
    |
    v
allow-listed reporting tools or metric queries
    |
    v
tenant-scoped reporting semantic layer
```

Rules:

1. The LLM may choose among approved reporting tools or query templates, but it does not generate raw
   SQL against the base entity store.
2. Every tool/query validates tenant scope, metric name, dimensions, filters, time window, and row
   limits before execution.
3. Out-of-contract requests must fail explicitly as unsupported or require a follow-on reporting
   story; they must not fall through to arbitrary query execution.

### 5.3 Runtime shape

Interactive requests should run through `ops_api` using the existing Azure OpenAI adapter and a
reporting-specific read-only tool belt.

Recommended runtime:

```text
frontend reporting UI
        |
        v
ops_api reporting endpoint
        |
        +--> reporting planner / bounded AI adapter
        |
        +--> reporting semantic-layer query tools
        |
        +--> rendered answer payload (text + chart/table spec)
```

Long-running exports, cached dataset refreshes, and backfills should run through Temporal so retries
and operator recovery remain durable.

### 5.4 Standard dashboards and exports

The same semantic layer powers:

- predefined KPI dashboards
- AI-generated answer tables/charts
- Excel/CSV/PDF export jobs
- future self-service BI embedding in #450

Exports should be treated as durable jobs with explicit parameter capture and audit history rather
than large synchronous browser requests.

### 5.5 Security and governance rules

- User prompts, tool output, and any free-form text in source records are all untrusted input.
- Interactive AI reporting must be read-only.
- Result sets need bounded row counts, time windows, and metric catalogs.
- Prompt/tool execution should be audited with the same structured-call discipline used by
  ADR-0005.
- Cross-tenant or out-of-scope records must be impossible at the reporting-layer contract, not just
  hidden in the frontend.

### 5.6 Interface contract

| Interface | Direction | Notes |
|---|---|---|
| reporting semantic-layer query API | `ops_api`/worker -> DB | allow-listed metrics/dimensions only |
| AI reporting endpoint | frontend -> `ops_api` | interactive NL analytics |
| export job submission | frontend -> Temporal/`ops_api` | durable Excel/CSV/PDF generation |
| dashboard data API | frontend -> `ops_api` or scoped DB surface | predefined KPI cards/charts |

---

## 6. Data model direction

The semantic layer should be additive and explicitly versioned.

Recommended building blocks:

- reporting metric registry (metric key, definition, allowed dimensions, grain)
- subject-area projections for fleet, finance, fulfillment, and customer reporting
- audit events for report asks, exports, and query denials

The implementation may derive these from:

- `entity_versions`
- `relationships_v2`
- `entity_facts`
- `time_series_points`
- invoice/payment projections introduced by the payments spec

but downstream consumers should not need to understand those raw storage tables directly.

---

## 7. Delivery sequencing

Recommended order:

1. Approve the semantic-layer/query-boundary ADR.
2. Publish the core metric catalog and tenant-scoped reporting projections.
3. Add the interactive AI reporting endpoint with a bounded reporting tool belt.
4. Add export workflows.
5. Reuse the same semantic layer in #450 self-service BI and #470 Power BI integration work.

---

## 8. Test strategy

The implementation should prove:

- a supported plain-English question resolves to the correct metric/query contract
- unsupported questions fail safely without arbitrary SQL execution
- tenant/user scope is preserved through every reporting tool invocation
- dashboard metrics and AI answers agree for the same filters
- export jobs reproduce the same scoped dataset as the interactive answer path

Test layers should include:

- planner/tool contract tests for metric/dimension allow-lists
- database/ops-api contract tests for scope enforcement
- frontend tests for answer rendering and export initiation
- regression tests comparing known questions to deterministic expected metrics

---

## 9. Risks and review asks

- **Security review is required before approval.** A user-facing NL interface over live operational
  data is a trust-boundary change.
- **Database review is also required before approval.** The shared semantic layer must make tenant
  scoping explicit before #438 or #450 can ship.
- #450 should not be approved independently until this shared semantic-layer direction is reviewed,
  because the BI epic is intended to reuse the same metric and projection contract.
