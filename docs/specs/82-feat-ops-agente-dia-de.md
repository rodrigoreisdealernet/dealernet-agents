# Spec — Receivables Collections Prioritizer (`collections-prioritizer`) · Issue #82

> **Execution contract:** the authoritative, agent-executable PRD lives at
> `docs/prd/2026-06-25-agente-priorizacao-cobranca.md` (13 tasks, Phase A + Phase B,
> Coverage Matrix). This spec is the short, testable summary; the PRD wins on any detail.

## Overview

Ship a proactive, **assist-only** DIA ops agent — `collections-prioritizer` — that, per
tenant, scopes a customer's overdue (and near-due) accounts receivable from a **new**
Supabase finance mirror, has an LLM rank each customer by recoverable exposure **while
reading the free-text collection-contact/promise notes**, and records a ranked
`collections_priority` finding (status `pending_approval`) recommending the next human
action. A human acts; the agent never sends a notice and never moves money.

Delivered in two phases:

- **Phase A — finance data foundation:** two new DIA entities `receivable` and
  `collection_contact` (entity-CRUD RPCs + `security_invoker` scope views + RLS),
  registered in the authoritative `rental_entity_type_catalog`, plus representative seed
  and an RLS contract test. (Real ERP→Supabase ingestion is out of scope — NC-1.)
- **Phase B — agent triad:** a faithful clone of the `vehicle_aging` triad (agent module +
  activities + workflow), reusing the existing `finding` store via `ops_revrec` delegation,
  wired into `worker.py` (schedule reconcile, cron seeded disabled), `workflows/ops/__init__.py`,
  and the run-now allowlist in `ops_api/app.py`.

## Problem / Context

DIA needs to move **DSO / inadimplência %** by surfacing the highest recoverable-exposure
overdue customers first and recommending a concrete next collection action grounded in the
last contact/promise note. The finance entities are **not yet mirrored** to Supabase, so the
data foundation (Phase A) must land before the agent (Phase B). This does **not** duplicate
the purged Wynne `credit_analyst` / `account_health` agents — it uses a distinct
`agent_key` and `finding_type`.

## Acceptance Criteria (customer language; full set in PRD §7)

- **AC-1 (catalog):** After the finance migrations apply, `rental_entity_type_catalog`
  includes `receivable` **and** `collection_contact` **and still** includes every prior type
  (`vehicle, brand, service_order, part, part_sale`, …) — none dropped.
- **AC-2/AC-3/AC-5/AC-6 (entity CRUD):** Hardened `create_/update_/delete_` RPCs append SCD2
  versions; missing required fields fail `22023`; `update`→`delete` increments versions and
  soft-retires (leaves the current view); `v_dia_receivable_current` derives `days_overdue`
  (100d-past due → `100`, future → `0`).
- **AC-4 (RLS):** Direct client writes are blocked; a `read_only` JWT calling a create RPC
  fails `42501`, a `branch_manager`/`admin`/`service_role` succeeds.
- **AC-7 (scope):** `ops_scope_collections` returns customers ordered by `total_exposure`
  desc, with deterministic `severity`, `max_days_overdue`, and a customer-scoped fingerprint,
  excluding customers with no open at/over-threshold receivable.
- **AC-8/AC-16 (LLM + closed schema):** `run_collections_prioritizer` sends `tools=[]` and
  returns a validated `CollectionsFindingV1` (closed, `extra="forbid"`); an unknown field
  fails closed after the bounded retry; `collections_finding_v1_schema()` matches the
  `ops_output_schema_registry` row exactly.
- **AC-9/AC-10/AC-13 (record/dedupe/bound):** With no open fingerprints, all scoped customers
  are recorded as `finding` rows (`agent_key='collections-prioritizer'`,
  `finding_type='collections_priority'`, `status='pending_approval'`), exposure desc;
  re-running dedupes all (records 0); `max_findings_per_run` bounds output to the top-exposure
  customer(s).
- **AC-11/AC-12 (safety + finalize):** `auto_apply` is forced `False` in the summary even if
  config sets it `True`; an empty scope finalizes the run with 0 recorded and no exception.
- **AC-14 (resilience):** the assess activity is scheduled with a 45s heartbeat timeout and a
  retry cap of 2.
- **AC-15 (registration):** the workflow and every `ops_collections` `@activity.defn` are
  registered in `worker.py`; `collections-prioritizer` is in the run-now allowlist; the triad
  files import no `rental_*` module.
- **AC-17 (PII minimization):** the persisted finding's `expected`/`evidence` carry a bounded
  summary, not a verbatim dump of all contact notes.

## Non-Goals

- **No automatic dunning** — the agent never sends a notice / SMS / email / letter.
- **No money movement** — no payment, write-off, credit/limit change, or adjustment is ever
  posted; `auto_apply` forced `False`.
- No new finding table, no new finding-surfacing UI (existing `ops_findings_view` → queue
  surfaces the new findings automatically).
- No tool-calling in v1 (`tools=[]`); a `dia_bi`-style "fetch more contact history" tool is a
  fast-follow.

## Out of scope

- **Real ERP→Supabase ingestion** that populates `receivable` / `collection_contact` (owned
  elsewhere — NC-1). This change delivers schema + views + representative seed so the agent is
  testable.
