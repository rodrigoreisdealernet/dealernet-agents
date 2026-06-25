# ADR-0020: Operations Factory — Temporal-scheduled agentic ops workflows (config-in-DB)

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Maintainer, Factory Architect
- **Note:** Architecture is approved and the formal spec is merged (PR #108). Delivery now executes through dependency-ordered child stories (#110–#120): foundation (#110–#114) → Rev-Rec vertical (#115–#117) → fleet/ops (#118/#119) → RLS hardening follow-up (#120), with corrected mapping **#118 = Fleet Utilization** and **#119 = OPERATIONS/Ops Monitor**.

## Context
Rental ERP users (controllers, AR clerks, fleet/asset and service managers) lose hours to manual, rules-based, cross-record back-office work: revenue reconciliation, idle-asset audits, billing drift, overdue maintenance, collections. The software factory (ADR-0006) showed role-based agents can take repetitive judgment work off humans; the same pattern can be turned at the product's users.

## Decision
Build an **Operations Factory**: role-based agentic workflows orchestrated by **Temporal** (ADR-0003) that **investigate → propose → human-approve → write → audit**. Reuse the **Azure OpenAI `chat_with_tools` adapter** (ADR-0005) with a **read-only rental-data tool-belt**; gate every action on a **human signal** (ADR-0004); record all activity in `time_series_points` (ADR-0001). Workflow code is identical per tenant — **prompts, model, tools, thresholds, schedules live in tenant-scoped DB config** (not repo files, contrast ADR-0006), scoped per ADR-0019. Schedules run by default; `auto_apply` is hard-locked false in v1. A demo-grade **Findings & Approvals UI** is the human surface. Scope: Revenue Recognition first, Fleet Utilization second.

## Consequences
- Reuses Temporal + the agent adapter + the entity/audit substrate already built; little net-new infra.
- New obligation: tenant config governance, synthetic seed data, an approvals UI, and an `OPERATIONS.md` runbook + Ops Monitor.
- Config-in-DB enables per-tenant behavior without deploys but requires the config schema and workflow code to stay in sync.

## Alternatives considered
- **Scheduled scripts / manual reports** — rejected: no durable state, history, or human-gate.
- **Agent definitions in repo files (factory style)** — rejected for ops: it is multi-tenant.
- **Auto-apply with audit** — rejected: money/asset actions require a human.

## Evidence
- `docs/specs/operations-factory-agentic-workflows.md` (full design); PR #108
- Epic #109; stories #110–#120
- Builds on ADR-0001, 0003, 0004, 0005, 0019
