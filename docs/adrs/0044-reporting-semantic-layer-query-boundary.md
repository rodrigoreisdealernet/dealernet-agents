# ADR-0044: AI and BI reporting query a tenant-scoped semantic layer, not raw operational tables

- **Status:** Accepted
- **Date:** 2026-06-12
- **Accepted:** 2026-06-17 (PR #1286 — self-service dashboard builder implementation shipped the metric catalog and governed query boundary described here)
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** -

## Context

Issue #438 introduces natural-language analytics over live rental, customer, and financial data.
Issue #450 introduces Reporter-like self-service BI, embedding, and data blending. Both require a
shared reporting contract.

The repo already has:

- ADR-0005's bounded Azure OpenAI tool adapter
- ADR-0020's read-only agentic reasoning pattern
- the generic rental entity/facts/events model

But ADR-0019 deferred broad RLS on core data tables, and there is no existing reporting semantic
layer. Allowing an LLM or ad hoc dashboard builder to query raw operational tables directly would
mix metric drift, tenant-scope risk, and an unsafe NL-to-SQL trust boundary.

## Decision

We expose AI reporting and BI/reporting through a curated tenant-scoped reporting semantic layer with
allow-listed metrics, dimensions, grains, and bounded query tools. Interactive natural-language
reporting runs through `ops_api` over that layer; long-running exports and refresh work use Temporal.

LLMs and dashboard builders do not generate unrestricted SQL against the base operational tables.

## Consequences

- AI reporting (#438) and self-service BI (#450) share one metric contract instead of diverging by
  implementation path.
- The platform must add explicit reporting projections and metric registries before either epic can
  be approved for implementation.
- Security and database review become mandatory because tenant scope is enforced at the reporting
  contract, not assumed from raw-table access.
- Some free-form analytical questions will be intentionally unsupported until the metric catalog and
  subject-area coverage are expanded.

## Alternatives considered

- **Direct LLM-generated SQL against operational tables:** rejected because it is unsafe and
  incompatible with the current tenant-scoping posture.
- **Separate AI and BI data paths:** rejected because it would create metric drift and duplicate
  security/design work.
- **Static CSV extracts only:** rejected because the scope requires live operational visibility and
  interactive filtering.

## Evidence

- Issues #438, #450, and #1286
- `docs/specs/ai-powered-reporting.md`
- `frontend/src/lib/reporting/metric-catalog.ts` — governed metric catalog (allow-list, save/load/delete helpers)
- `frontend/src/routes/analytics/dashboards.tsx` — self-service dashboard builder UI (KPI tiles, canvas, save bar, unsupported-metric guard)
- `frontend/src/test/self-service-dashboard-builder.test.tsx` — 32 unit tests covering catalog contract, persistence, and unsupported-metric enforcement
