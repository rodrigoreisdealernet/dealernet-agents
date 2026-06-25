# Operations Factory — Agentic Temporal Workflows for Equipment Rental

**Status:** Implementation-ready (v1 Rev-Rec slice — §§14–18 added; build-out underway)
**Author:** Factory (proposed)
**Date:** 2026-06-06 (build-out 2026-06-07)
**Related specs:** [`software-creation-factory.md`](./software-creation-factory.md), [`equipment-rental-domain-model.md`](./equipment-rental-domain-model.md), [`live-cluster-deploy-smoke-rollback.md`](./live-cluster-deploy-smoke-rollback.md)

---

## 1. Summary

We already run a **software factory**: a fleet of role-based AI agents (Product Owner, Factory Architect, Project Manager, Tech Reviewer, QA Manager, Actions Monitor) orchestrated by GitHub Actions on schedules and triggers. Each agent is a versioned prompt with config, runs with bounded actions per cycle, deduplicates its own work, writes an audit summary, and escalates anything risky to a human. That pattern took the tedious, repetitive parts of shipping software off human hands.

This spec proposes the same pattern, turned **outward at the product's users**: an **Operations Factory** — role-based agentic workflows, orchestrated by **Temporal**, that perform the tedious, manual, error-prone back-office jobs equipment-rental ERP users do today by hand. Revenue recognition. Utilization audits. Billing reconciliation. Maintenance triage. Telematics investigations. Collections.

The foundation already exists across two repos we compose:

- **`wynne-lvl-3/temporal/`** — Temporal (Python SDK 1.5.0) orchestrating the rental domain: signal-driven workflows (`RentalOrderWorkflow`), activities over the generic entity model (`entities` / `entity_versions` / `relationships_v2` / `entity_facts` / `time_series_points`), human-in-the-loop via workflow signals.
- **`ma-app/temporal/`** — the **agentic** pattern: a Temporal activity calls an agent function, which runs a `chat_with_tools()` loop against **Azure OpenAI** with a constrained tool-belt and a strict JSON output schema, then returns a validated structured verdict to the workflow. This is exactly the "investigation" shape we want, with internal rental data as the evidence instead of the web.

**Operations Factory = `ma-app`'s Azure-OpenAI agentic activity pattern + `wynne-lvl-3`'s rental domain + the software factory's governance model — with all prompts and configuration stored in tenant-scoped database schemas so the workflow code stays identical across tenants and is configurable without code changes.**

This document is for review before implementation.

---

## 2. The analogy, made precise

| Software Factory (today, GitHub Actions) | Operations Factory (proposed, Temporal) |
|---|---|
| Role agents: Product Owner, Architect, PM, Tech Reviewer, QA, Monitor | Role agents: Rev-Rec Analyst, Fleet Auditor, Billing Reconciler, Maintenance Triage, Telematics Investigator, Collections Analyst, Contract Auditor, Ops Monitor |
| Agent = `.github/agents/<name>.agent.md` (file in repo) | Agent = **row(s) in a tenant-scoped DB config schema** (prompt, model, tools, thresholds) loaded at run time; workflow code is generic |
| Tool-belt = `gh` CLI | Tool-belt = read-only rental-data tools (query entities, time-series, relationships, telematics, invoices) |
| Orchestration = GitHub Actions cron + label/event triggers | Orchestration = Temporal **Schedules** + signal/event triggers, **enabled by default** |
| Bounded per run ("max 5 PRs/run") | Bounded per run (max N findings/recommendations per cycle, from tenant config) |
| Dedup via `auto:alert` issue-fingerprint search | Dedup via open-finding fingerprint |
| Human gate via `requires-maintainer-review` / protected environments | Human gate via Temporal **signal** approval — **mandatory; nothing auto-approved** |
| Audit = `$GITHUB_STEP_SUMMARY` + Actions logs | Audit = `time_series_points` events + Temporal history + Temporal UI |
| Health = Actions Monitor agent + `MONITORING.md` | Health = Ops Monitor agent + `OPERATIONS.md` runbook |

Governing principle, verbatim: **agents propose; humans dispose.** Every money-moving, customer-facing, or status-changing action waits for a human approval signal. No exceptions in v1.

---

## 3. Locked decisions

These are settled per review and drive the design below.

1. **Provider — Azure OpenAI.** Reuse `ma-app`'s `chat_with_tools` Azure OpenAI client wholesale. The agent layer stays provider-agnostic at the `chat_with_tools` seam, but v1 ships on Azure OpenAI for consistency with `ma-app`.
2. **Scope — Revenue Recognition first, Fleet Utilization second.** Rev-Rec exercises the full investigate→propose→**approve**→write→audit loop and has the highest measurable $ value. Fleet proves the fan-out + compose-with-existing-`Transfer`-workflow pattern.
3. **Tool-belt — built for real** against the real entity model (read-only), per recommendation.
4. **Data — synthetic for now.** The real read-only tool-belt reads from the real entity model, **populated with synthetic seed data** (no live customer data, no live telematics). This is also the demo dataset.
5. **Configuration — tenant-scoped DB schemas.** Workflow code is **identical for all tenants**. Every agent's prompt, model/deployment, enabled tools, thresholds, schedule, and bounds live in **tenant-specific database config tables**, loaded at run start. No hard-coded prompts or thresholds. (§5) **Note:** the codebase is effectively single-tenant today (no `tenant_id`, no RLS — see §12), so this epic introduces the tenant-scoping convention as foundational work.
6. **UI — demo-grade.** A polished React **"Findings & Approvals" console** is a first-class v1 deliverable, built to be demoed live. (§9)
7. **Auto-apply — off, always (v1). Schedules — on, by default.** The workflows **run automatically** on their schedules and continuously produce findings, but **every actionable finding requires explicit human approval**; nothing is auto-applied or auto-approved.

---

## 4. Architecture

### 4.1 The three layers (mirroring `ma-app`)

```
Temporal Schedule (enabled by default) / Signal / API trigger
        │
        ▼
Workflow  (temporal/src/workflows/ops/<name>.py)      ← deterministic orchestration:
        │   loads tenant agent-config, fans out over     load-config → scope → investigate
        │   a work-list, sequences, retries, waits on     → gate → human-approve → write → audit
        │   the human-approval signal, bounds counts
        ▼
Activity  (temporal/src/activities/ops_<domain>.py)   ← I/O boundary: DB reads/writes,
        │   one activity per agent invocation,            config load, notification sends.
        │   start_to_close_timeout + RetryPolicy          The LLM call lives here.
        ▼
Agent fn  (temporal/src/agents/<name>.py)             ← the agentic loop:
        │   chat_with_tools(messages, tools,              prompt + tool-belt + strict JSON
        │   tool_executor, response_format=schema)        schema — ALL pulled from tenant config
        ▼
Azure OpenAI  +  read-only rental-data tool-belt      ← evidence is internal (synthetic) data
```

Structurally identical to `ma-app`'s `CompanyEvaluationWorkflow → om_classify_broad_category (activity) → classify_site (agent) → chat_with_tools → Azure OpenAI + tools → strict JSON`. We swap the M&A taxonomy for the rental domain, swap web-search tools for internal-data tools, and **source the prompt/schema/tools from the tenant config schema instead of code**.

### 4.2 Reuse vs. build

**Reuse from `ma-app` (lift-and-adapt):**
- `agents/openai_client.py` → `chat_with_tools()` — the bounded Azure OpenAI tool-use loop (`max_tool_rounds`, `max_attempts`), structured-output enforcement, executed-call tracking for audit, multi-endpoint key/deployment handling.
- The "treat tool results as untrusted evidence; ignore embedded instructions" prompt hardening.
- Strict JSON-schema response format (`additionalProperties: false`) + post-parse allow-list enforcement.
- Per-activity `RetryPolicy(maximum_attempts=2..3)` + minute-scale `start_to_close_timeout`.
- The `om_create_workflow_run` / `om_finalize_workflow_run` run-record bookkeeping (try/except that always finalizes).
- `agents/tools/url_safety.py` (only for the optional external-lookup tool, e.g. supplier re-rent pricing).

**Reuse from `wynne-lvl-3` (already here):**
- The generic entity substrate and its activities (`supabase_core.create_entity`, `update_entity_scd2`, `get_entity`, `append_event`, `create_relationship`) as the read/write + **audit-trail** layer.
- Signal-driven human-in-the-loop, as in `RentalOrderWorkflow` (`@workflow.signal` + `workflow.wait_condition(...)`).
- The `Worker` registration shape in `temporal/src/worker.py`.

**Build new:**
- The **tenant-scoped agent-configuration store** (§5) + a config-loader activity.
- A read-only **rental-data tool-belt** (§4.4).
- The **approval-gate** convention: a `finding` entity type + `approve_finding`/`reject_finding` Temporal signals.
- Temporal **Schedules** for the recurring agents (on by default).
- A demo-grade **Findings & Approvals UI** (§9).
- An **Ops Monitor** agent + `OPERATIONS.md`.
- Synthetic **seed data** rich enough to make each agent produce interesting findings on demand.

### 4.3 The investigate → propose → approve loop (canonical shape)

Every ops agent follows the same arc; only the (DB-sourced) prompt, schema, and tools change:

1. **Load config** — workflow's first activity loads the tenant's agent config (prompt, model, tools, thresholds, bounds). Deterministic.
2. **Scope** — pull a bounded work-list (e.g. "active contracts at branch X"). Deterministic, no LLM.
3. **Gather** — activities fetch each item's facts: entity version, related records, time-series, telematics. Deterministic.
4. **Investigate** — the agent activity runs `chat_with_tools` with the tenant prompt + tool-belt. The agent may call read-only tools for more evidence, then emits a **structured finding**: `{ status, severity, finding_type, evidence[], proposed_action, confidence, rationale }`.
5. **Gate** — workflow records every finding; any finding with an actionable `proposed_action` **waits for a human approval signal** (`workflow.wait_condition(lambda: self._decision is not None)` with timeout). **No auto-apply in v1.**
6. **Write & audit** — on approve, apply via existing entity activities; append a `time_series_points` event for every action (agent rationale + evidence + human approver). Update `entity_facts`. On reject/timeout: record outcome, continue.
7. **Bookkeep** — finalize the run record with counts (`expected/processed/succeeded/failed`), as `om_finalize_workflow_run` does.

### 4.4 The rental-data tool-belt (read-only)

Agents reason over internal data through a small, safe, read-only tool surface (the analogue of `ma-app`'s `search_web`/`crawl_site`):

| Tool | Purpose |
|---|---|
| `query_entity(entity_type, id\|filters)` | Current version of an asset, contract, invoice, customer, etc. |
| `query_time_series(entity_id, kinds, window)` | Event history: status changes, checkouts, returns, inspections, maintenance, invoicing. |
| `query_relationships(entity_id, rel_types)` | Graph edges: asset→line→order→contract→billing account→customer. |
| `query_facts(dimension, metric, window)` | Pre-computed KPIs (utilization, revenue, downtime). |
| `get_telematics(asset_id, window)` | Engine hours / GPS / fuel (synthetic in v1). |
| `get_invoice_detail(invoice_id)` | Line-level billed charges. |
| `get_rate_card(asset_category, branch, customer, job)` | Applicable rate tiers for discrepancy checks. |
| `query_availability(asset_category, branch, window)` | Live available / reserved / inbound counts to ground quote feasibility. |
| `get_customer_profile(customer_id)` | Customer terms, historical exceptions, margin floors, and recent order/quote history. |
| `query_catalog(category\|filters)` | Rentable categories, substitutes, bundles, and add-on SKUs for guided quote assembly. |

**Which tools an agent may call is itself tenant config** (the `tools` list in §5). Every tool is read-only; writes happen only through gated workflow activities, never inside the agent loop. Tool inputs are validated/allow-listed; outputs are framed as untrusted evidence. Tools are tenant/branch-scoped at the data layer.

### 4.5 Why config-in-DB, not files

The software factory keeps agent prompts in repo files because there is exactly one "tenant" (the factory). A multi-tenant product cannot: tenant A's controller wants stricter rate-mismatch thresholds than tenant B; tenant C wants its Rev-Rec prompt to speak its own rate-tier vocabulary. Storing prompts/config in **tenant-scoped DB schemas** means:

- One set of Temporal workflow/activity code, deployed once, behaves per-tenant by **data**, not branches in code.
- Config changes (prompt tweaks, threshold changes, enabling a tool, tuning bounds) ship **without a deploy** — edit the tenant's config row.
- Config is versioned in the same SCD2 entity model, so prompt changes are auditable and reversible like any other entity.
- The demo can show "same workflow, two tenants, different behavior" purely by swapping config.

---

## 5. Tenant-scoped agent-configuration store

The workflow code reads config; it never embeds it. Proposed model (expressed in the existing generic entity model so it inherits SCD2 history and tenant scoping):

`agent_config` (entity_type), one current version per `(tenant_id, agent_key)`:

```jsonc
{
  "tenant_id": "…",
  "agent_key": "revrec-analyst",
  "enabled": true,
  "model": { "provider": "azure_openai", "deployment": "gpt-5.4", "api_version": "2024-12-01-preview" },
  "system_prompt": "You are the Revenue Recognition Analyst for {{ tenant_name }} …",
  "user_prompt_template": "Contract {{ contract_id }} … {{ evidence_json }}",
  "tools": ["query_entity", "query_time_series", "get_invoice_detail", "get_rate_card"],
  "output_schema_key": "revrec_finding_v1",      // strict JSON schema, also stored/registered
  "thresholds": { "rate_mismatch_min_delta": 25.00, "min_confidence_to_surface": 0.5 },
  "bounds": { "max_findings_per_run": 50, "max_tool_rounds": 5 },
  "schedule": { "cron": "0 2 * * *", "enabled": true },
  "auto_apply": false                              // hard-locked false in v1; field reserved
}
```

- **Loader activity** `ops_load_agent_config(tenant_id, agent_key)` returns the current version; the workflow interpolates run variables (`tenant_name`, `contract_id`, `cycle`, …) into the templates — the direct analogue of `.github/tools/shared/agent-loader.ts`, but DB-sourced.
- **Output schemas** are registered/stored by `output_schema_key` so the strict JSON contract is also configurable per tenant without code.
- **Schedules** are created in Temporal from each tenant's `schedule` block (on by default per decision §3.7); a config change to `cron`/`enabled` reconciles the Temporal Schedule.
- `auto_apply` is present but **enforced false** by the workflow in v1 regardless of stored value (defense in depth).
- Seeded with sensible defaults per agent so a fresh tenant works out of the box; the UI (§9) can expose editing later.

---

## 6. Agent catalog

| # | Agent (`agent_key`) | Persona | The tedious job today | Trigger | Proposes | Gate |
|---|---|---|---|---|---|---|
| 1 | **revrec-analyst** | Controller, AR clerk | Hand-checking which on-rent assets should bill this cycle; catching un-billed rentals, missed returns, wrong rate tier | Schedule (cycle + nightly) | Exception list + draft invoice adjustments | Human approval |
| 2 | **fleet-auditor** | Fleet/asset, branch mgr | Spreadsheet pivots for idle iron + transfer opportunities | Schedule (weekly) | Idle/under-util findings + transfer/disposition recs | Human approval |
| 3 | **billing-reconciler** | AR clerk, controller | Reconciling returns not communicated to billing; invoice vs. contract vs. quote drift | Schedule (nightly) | Mismatch list + proposed corrections | Human approval |
| 4 | **maintenance-triage** | Service/maint. mgr | Finding overdue PM, prioritizing work orders vs. rental demand, inspection-tag gaps on returns | Schedule (daily) + on return | Prioritized WO queue + overdue-PM list | Human assigns |
| 5 | **telematics-investigator** | Fleet, service mgr | Eyeballing engine-hours/GPS vs. billed hours/contract location | Schedule (daily) | Anomaly findings | Human review |
| 6 | **collections-analyst** | AR/credit clerk | Working the aging report, drafting dunning, flagging credit-limit breaches | Schedule (daily) | Collections queue + draft outreach + credit flags | Human approval |
| 7 | **contract-auditor** | Controller, branch mgr | Auditing executed contracts for rate accuracy, terms vs. quote, missed escalations | Schedule (weekly) + on execute | Audit findings + corrections | Human approval |
| 8 | **damage-returns-charge-assistant** | Yard/returns clerk, service mgr, AR | Deciding billable damage vs. fair wear, spotting missing accessories, and turning return inspections into defensible charges | On return / check-in event | Itemized damage + missing-accessory charges with supporting evidence and draft customer charge | Human approval |
| 9 | **customer-success-churn-risk** | Account manager, branch sales | Quiet churn goes unseen until volume is already lost; ad-hoc account reviews miss early warning signs | Schedule (weekly) + churn-signal event | Ranked at-risk/opportunity accounts + recommended play + draft talking points | Human approval before outreach task/opportunity write |
| 10 | **ops-monitor** | Ops lead | — | Schedule (15–30 min) | Health report; deduped incidents | Auto (read-only) |
| 11 | **quote-to-order-copilot** | Inside sales, counter rep | Hand-building a quote from an RFQ: check availability, pick assets, apply the right rate tier, find substitutes, and sanity-check margin | New RFQ/opportunity + on demand | Draft quote/order lines, substitutions, bundle/add-on upsells, margin + win-likelihood read | Rep review/edit before draft write |

**Flagships detailed:** #1 and #2 (v1 scope per §3.2); #4 and #8 are the clearest next operator-facing workflows to decompose after the current slice, #9 is sketched as the next retention/expansion win, and #11 is the next clear top-of-funnel quoting win.

### 6.1 Candidate next workflow — Damage & Returns Charge Assistant (triage sketch)

This agent follows the same **investigate → propose → human-approve → write → audit** loop as Rev-Rec, but its evidence trail is the **return inspection** rather than the billing cycle.

**The job today**
- At check-in, yard/service staff compare the asset's return condition against the checkout baseline, photos, checklist notes, accessory manifest, and recent history to decide what is normal wear vs. billable damage.
- That decision is subjective, slow, and a common source of revenue leakage and customer disputes — especially when the evidence trail is scattered across photos, inspection notes, and parts/labor references.

**Trigger & scope**
- **Trigger:** return/check-in event (same human-in-the-loop pattern as ADR-0004 — nothing posts automatically).
- **Scope:** one return at a time: the return inspection record, the checkout-condition baseline, linked asset/contract history, accessory manifest, fair-wear policy, and current parts/labor pricing.
- **Bound:** one structured recommendation set per return, capped by config (`max_damage_lines_per_return`, `max_tool_rounds`) so the workflow stays deterministic and reviewable.

**Per-return investigation**
- The agent may call read-only tools for:
  - inspection photos + checklist,
  - checkout baseline photos/notes,
  - asset service / prior-damage history,
  - fair-wear policy and charge rules,
  - accessory manifest,
  - parts + labor cost references.
- It emits structured recommendations such as:

```jsonc
{
  "return_id": "…",
  "charges": [{
    "charge_type": "damage | missing_accessory",
    "classification": "billable | fair_wear",
    "item": "bucket tooth | cracked panel | charger",
    "amount": 0.00,
    "policy_citation": "fair-wear-policy §3.2",
    "evidence": [
      "checkout photo 2026-05-01 shows panel intact",
      "return photo 2026-05-20 shows crack on right panel",
      "accessory manifest lists charger as checked out but not returned"
    ],
    "confidence": 0.0,
    "rationale": "…"
  }]
}
```

**Gate & write**
- Every proposed charge is recorded as a `finding` (or grouped finding with line-level payload) with the supporting evidence, fair-wear classification, policy citation, and fingerprinted return/item identifiers.
- Any billable charge waits for an explicit human approval signal before the workflow writes a damage charge / rental adjustment row. Rejections and timeouts are audited exactly like approvals.
- The workflow never writes from the agent loop itself; the tool-belt remains read-only.

**UI & test expectations**
- The Findings & Approvals console can render these findings in the existing queue/detail flow, but the detail card should emphasize a **damage-review** presentation: before/after evidence, fair-wear vs. billable classification, missing-accessory manifest evidence, and the draft charge amount.
- Minimum validation for the future slice: evidence linkage tests (every proposed line traces back to baseline/return/policy records) and gate tests (no charge row until approve; reject/timeout yields audit only).

---

## 7. Flagship workflow A — Revenue Recognition & Cycle-Billing Analyst (v1)

### 7.1 The job today
Near a billing cycle, a controller must verify every on-rent asset is billed correctly: right rate tier (branch/customer/job/contract), right period, no asset silently on-rent-but-unbilled, no contract where the return happened but billing kept running (or stopped early). Across hundreds of contracts this is hours of cross-referencing — and revenue leaks through the gaps.

### 7.2 Trigger & scope
- **Trigger:** Temporal Schedule keyed to billing cycle + nightly pass (on by default); manual start for ad-hoc audits.
- **Scope (deterministic):** all `Contract`s in `active`/`pending_execution` with `RentalLineItem`s `on_rent` for the period, plus contracts with a `return` event in the window. Bounded to `max_findings_per_run` from config; remaining count logged and resumed next run (no silent truncation).

### 7.3 Per-contract investigation (agent activity `ops_revrec_analyze`)
Agent receives the contract payload + line items + relevant `time_series_points` + applicable rate card, and may call `query_time_series`, `get_invoice_detail`, `get_rate_card`. Output schema (`revrec_finding_v1`, stored per §5):

```jsonc
{
  "contract_id": "…",
  "findings": [{
    "finding_type": "unbilled_on_rent | billing_past_return | rate_tier_mismatch | missed_escalation | over_billed",
    "line_item_id": "…",
    "severity": "high | medium | low",
    "expected": { "rate_type": "weekly", "amount": 1200.00, "period": "…" },
    "billed":   { "amount": 0.00 },
    "delta": 1200.00,
    "evidence": ["checkout 2026-05-01", "no invoice line for week of 05-08"],
    "proposed_action": "create_invoice_adjustment | stop_billing_at_return | correct_rate",
    "confidence": 0.0,
    "rationale": "…"
  }]
}
```

### 7.4 Gate & write
- Aggregate findings; **dedupe** against open findings for the same line (fingerprint `contract_id:line_id:finding_type`); record each as a `finding` entity + `time_series_points` event.
- Every money-moving `proposed_action` **waits for a human approval signal**, surfaced in the UI. **Nothing auto-applies.**
- On approve: draft the invoice adjustment via entity activities; emit an audit event capturing the agent's rationale **and** the approver. On reject/timeout: record outcome, continue.

### 7.5 Value
Turns a multi-hour pre-cycle reconciliation into a reviewed exception queue; directly attacks revenue leakage and DSO — Wynne's headline metrics. Strong demo: synthetic data seeded with a handful of deliberate leaks the agent reliably catches.

---

## 8. Flagship workflow B — Fleet Utilization & Idle-Asset Auditor (v1, second)

### 8.1 The job today
A fleet manager periodically pivots utilization data to find idle iron, then decides transfer vs. disposition — while another branch may be re-renting the same category from a competitor.

### 8.2 Shape — fan-out (mirrors `ma-app` spreadsheet ingestion)
- **Scope:** assets `available`/`returned` below the config utilization threshold over the window → large work-list → **fan-out**, like `ma-app` evaluating many companies.
- **Per-asset agent (`ops_fleet_assess`):** given utilization facts, home branch, recent history, and category demand at nearby branches, emits:

```jsonc
{
  "asset_id": "…",
  "disposition": "keep | transfer | sell | re_rent_out",
  "target_branch_id": "…|null",
  "utilization_pct": 0.0,
  "evidence": ["idle 41 days", "branch B has 3 open orders for this category"],
  "estimated_monthly_revenue_uplift": 0.00,
  "confidence": 0.0,
  "rationale": "…"
}
```

### 8.3 Gate & write
- `transfer` recommendations above a config value threshold wait for human approval; on approve, the workflow **kicks off the existing `Transfer` workflow** (compose, don't duplicate). Disposition recs are recorded as findings.
- All recommendations recorded as findings + audit events regardless of action.

### 8.4 Next candidate — Customer Success & Churn-Risk Agent (triage sketch)

Persona: account managers + branch sales. This agent targets "silent churn" that CRM workflows tend to register only after the account is already inactive.

- **Investigates (per customer):** rental cadence/volume trend slope, recency gap from expected cadence, share-of-wallet vs category demand in that customer's branch/area, service disputes/quality incidents, contract expiry + non-renewal signals.
- **Proposes:** ranked at-risk and upside-opportunity queue with explicit "why now", recommended play (`outreach`, `win_back_offer`, `qbr`, `upsell`), and draft talking points for the account owner.
- **Trigger:** weekly schedule plus event-driven run on churn-signal detection (e.g., abrupt cadence drop, unresolved dispute aging, non-renewal event).
- **Gate (mandatory):** no customer contact is automated. Agent output can only write an internal outreach task/opportunity after account-manager approval signal; reject/timeout records disposition and audit only.
- **Scope sketch:** read-only customer/order/contract/time-series/dispute tools; per-customer investigate loop; Findings & Approvals queue view filtered to `customer-success-churn-risk`; tests cover signal scoring + approval gate invariants.

### 8.5 Next-candidate workflow — Quote-to-Order Copilot
- **The job today:** an inside-sales rep reads an RFQ/opportunity, hand-checks live availability, applies the right customer/branch/job rate tier, hunts for substitutes when stock is short, and eyeballs whether the quote still clears margin floors. It is slow, inconsistent, and easy to get wrong under time pressure.
- **Per-RFQ investigation:** the agent receives the RFQ/opportunity payload, requested categories/quantities/dates, `query_availability`, `get_rate_card`, `get_customer_profile`, and `query_catalog` evidence. It proposes a structured draft: line items, best-fit asset/category selections, correct tiered pricing, substitution suggestions for shortages, bundle/add-on upsells, and a margin / win-likelihood read.
- **Gate & write:** nothing customer-facing or money-moving auto-commits. The rep reviews/edits the proposed quote in a **quoting copilot panel** on the RFQ/opportunity screen, then explicitly chooses whether to persist the result as a draft quote/order. The audit trail records the evidence, rationale, proposed commercial terms, and approver/editor identity in `time_series_points`.
- **Tests required with the slice:** Temporal/API coverage for rate-tier correctness, substitution ranking, and enforced human gating before any draft quote write; frontend/E2E coverage for the copilot panel's review/edit/send path.

---

## 9. Demo UI — Findings & Approvals console

A first-class v1 deliverable, built in the existing React/Vite/TanStack/Tailwind/Radix stack, designed to be demoed live. It is the human-in-the-loop surface for the whole factory.

### 9.1 Views
- **Factory dashboard** — the fleet of agents at a glance: each agent card shows enabled/disabled, last run, next scheduled run, findings produced, pending approvals, recent run status. Conveys "the factory is alive and working" — the demo opener.
- **Findings queue** — streaming list of findings across agents, filterable by agent, severity, status (`pending_approval` / `approved` / `rejected` / `informational`), branch, customer. Sort by $ delta.
- **Finding detail / approval card** — the core demo moment. For a finding it shows: the proposed action, the **$ impact**, expected-vs-billed, the **evidence list**, the agent's **rationale**, confidence, and the entity links (contract → line → invoice). Two buttons: **Approve** (with optional note) and **Reject** (with reason). Approve/Reject fire the Temporal signal via an API endpoint.
- **Audit trail** — the `time_series_points` history for an entity, showing the full chain: agent proposed → human approved → action applied, with rationale preserved. Demonstrates "auditable, replayable, accountable."
- **(Later) Agent config editor** — edit the tenant's prompt/thresholds/schedule from §5 live; out of v1 detail but the data model supports it.

### 9.2 Data flow
- Findings + approvals are entities → read via the existing TanStack Query + Supabase client patterns; realtime updates so findings appear live during the demo.
- Approve/Reject → backend endpoint → Temporal client `signal` to the waiting workflow (`approve_finding`/`reject_finding`).
- No new state store; reuses the JSON-driven UI + entity-model conventions already in the frontend.

### 9.3 Demo narrative (the thing we're optimizing for)
1. Open the dashboard — agents are scheduled and running on synthetic data.
2. Rev-Rec has surfaced an "unbilled_on_rent — $1,200 leak" finding with evidence and rationale.
3. Reviewer reads the evidence, clicks **Approve**; the draft adjustment is created; the audit trail updates in real time.
4. Show the same workflow under a second tenant with a different prompt/threshold producing different findings — **same code, config-driven.**

---

## 10. Conventions & governance (carried from the software factory)

1. **Agents propose; humans dispose.** Every money-moving/customer-facing/status-changing action requires a human approval signal. **`auto_apply` hard-locked false in v1.**
2. **Schedules on by default.** Workflows run continuously and produce findings without prompting; only the *actions* gate on humans.
3. **Bounded per run.** `max_findings_per_run` from config; remaining work logged and resumed. No silent truncation.
4. **Dedup.** Search open findings for the same fingerprint before raising (mirrors the Actions Monitor's `auto:alert` search).
5. **Everything audited.** Every proposed/applied action writes a `time_series_points` event with agent, rationale, evidence, and (if applied) approver. Temporal history + SCD2 give a complete, replayable trail — also the substrate for accuracy evaluation.
6. **Untrusted evidence.** Tool/data results framed as untrusted; embedded instructions ignored (verbatim from `ma-app`).
7. **Read-only tool-belt.** Agents cannot write; writes are explicit gated activities.
8. **Bounded loops & retries.** `chat_with_tools` keeps `max_tool_rounds`/`max_attempts`; activities keep `start_to_close_timeout` + `RetryPolicy`.
9. **Tenant/branch scoping.** Every run scoped to a tenant + branch set; config and tool-belt enforce it. (See open item §12.)

---

## 11. Observability & health (the `MONITORING.md` analogue)

- **Ops Monitor agent** (#8): every 15–30 min, scans recent ops-workflow runs for failures, approvals stuck past SLA, and runs that produced zero findings when they shouldn't. Dedupes and raises incidents — the operational twin of the Actions Monitor.
- **Temporal UI** is the run-level observability surface (already at `localhost:8080` in dev).
- **`OPERATIONS.md` runbook** documents recurring failure patterns + recovery, as `MONITORING.md` does.
- **Accuracy evaluation:** every finding records evidence, rationale, and the human decision — a labeled stream to measure agent precision and tune prompts/thresholds (which now live in config, editable without deploy). Same loop the QA Manager runs on tests.

---

## 12. Data-layer isolation — findings & approach (resolved)

**Investigation result: the codebase is effectively single-tenant today.**

- **No `tenant_id`/`org_id` column** on any core table (`entities`, `entity_versions`, `relationships_v2`, `entity_facts`, `time_series_points`). Verified in `supabase/migrations/20251202090000_core_entity_model.sql` and `20251203090000_analytics_foundation.sql`.
- **No Row-Level Security.** Zero `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` across all migrations. `DATABASE.md` lists RLS only as a future recommendation.
- **`branch` is an entity, not a scoping column.** It's a row with `entity_type='branch'` (`20260605154500_rental_master_data_foundation.sql`); assets link to it via `relationships_v2` (`branch_has_asset`). Branch is navigated by graph joins, never used as a `WHERE` scope.
- **No tenant scoping at query time.** The frontend Supabase client is an unauthenticated anon client with no tenant claim (`frontend/src/data/supabase.ts`); `queryBuilder.ts` injects no tenant filter; worker activities are stubs.

**Approach for this epic (app-level scoping now, RLS later):**

1. **Introduce a `tenant_id` convention** — a foundational, additive story. Add a `tenants` reference table and a nullable `tenant_id uuid` to the operations-factory's *own* new tables (config store, findings) immediately. Adding `tenant_id` to the shared core entity tables is additive DDL but higher-blast-radius, so it goes through `queue:database` / `needs-database-review` and may be phased.
2. **Enforce scoping in the tool-belt and config loader at the application layer** — every read tool (§4.4) and `ops_load_agent_config` (§5) takes `tenant_id` (+ optional branch scope) from the workflow run input and filters by it. This is sufficient for the synthetic-data demo and does not depend on RLS.
3. **Defer Postgres RLS as a hardening follow-up** — RLS on the core entity tables + a JWT tenant claim is the right production end-state, but is explicitly out of v1 scope and tracked as a separate story so the demo isn't blocked on it.

This keeps v1 honest: tenant isolation is real at the application layer (where the agents and tool-belt operate), with database-enforced RLS sequenced as a documented next step rather than silently assumed.

---

## 13. Proposed first slice (Revenue Recognition end-to-end)

A thin vertical through the whole stack, demo-ready:

1. **Config store & loader** — `agent_config` entity model + `ops_load_agent_config` activity + seed the `revrec-analyst` config for a demo tenant (and a second tenant with different thresholds to show config-driven behavior).
2. **Agent client** — port `ma-app`'s `chat_with_tools` Azure OpenAI client into `temporal/src/agents/openai_client.py`.
3. **Tool-belt** — `temporal/src/agents/tools/rental_data.py`: read-only `query_entity`, `query_time_series`, `get_invoice_detail`, `get_rate_card` against the real entity model (synthetic data).
4. **Agent fn** — `temporal/src/agents/revrec_analyst.py` (prompt/schema/tools all sourced from config).
5. **Activities** — `temporal/src/activities/ops_revrec.py`: `ops_revrec_analyze` (agent call), `ops_record_finding`, `ops_draft_invoice_adjustment`, run-record activities.
6. **Workflow** — `temporal/src/workflows/ops/revrec.py`: load-config → scope → fan-out analyze → dedup/record → **approval-signal gate** → gated write → finalize.
7. **Schedule** — create the Temporal Schedule from config (on by default).
8. **Synthetic seed data** — assets/contracts/lines/invoices/time-series seeded with deliberate, demoable revenue leaks.
9. **UI** — the Findings & Approvals console (§9): dashboard + findings queue + approval card + audit trail, wired to a signal-dispatch endpoint.
10. **Worker registration** in `worker.py`; **`OPERATIONS.md`** stub.
11. **Tests** (`pytest`) for the workflow's gating/dedup/bounding/`auto_apply=false` enforcement with the agent activity mocked — matching the repo's Temporal test convention.

Guarantee preserved end to end: the factory runs on its own and surfaces findings, but **no money moves and no customer is contacted without a human approving it** — the same promise the software factory makes for risky merges.

---

> **Sections 14–18 are the implementation-ready build-out** of the v1 Rev-Rec slice: the concrete UI elements, the approve/reject API + Temporal-signal contract, the unit & e2e test matrices, the demo-data design, and the dependency-ordered ticket breakdown with current status. They turn §9/§13 from intent into something each can be built and verified against.

## 14. UI element specification (Findings & Approvals console)

Built in the existing JSON-driven React stack: page definitions in `frontend/src/pages/*.json` (data sources + component tree, same convention as `dashboard.json` / `rental-contract-detail.json`), rendered through TanStack Query + the Supabase client, with role-gating via `canWrite`/`canOperate` (ADR-0023). All reads go through **Postgres views** (§17.3) — never raw entity joins in the client — so the surface is stable and `security_invoker`-ready.

### 14.1 Routes & pages

| Route | Page def | Purpose |
|---|---|---|
| `/ops` | `ops-factory-dashboard.json` | Factory overview — the demo opener |
| `/ops/findings` | `ops-findings-queue.json` | Filterable/sortable findings queue across agents |
| `/ops/findings/:findingId` | `ops-finding-detail.json` | Finding detail + **Approve/Reject** card (the demo moment) |
| `/ops/audit/:entityId` | `ops-audit-trail.json` | The proposed→approved→applied chain for an entity |

### 14.2 Component-level spec

**Factory dashboard (`/ops`)**
- **Agent fleet grid** — one card per `agent_config` row: agent name + persona, `enabled` pill, last-run time + outcome, next scheduled run, findings-produced count, **pending-approvals badge** (the number that needs a human). Cards for disabled agents render dimmed, not hidden.
- **Headline KPIs** (from the `ops_finding_kpis` view): *Pending approvals*, *Recoverable revenue (Σ open finding $ delta)*, *Approved this cycle*, *Findings last 24h*. Numbers with context (e.g. "$3,480 across 4 findings"), not bare counts.
- **Recent activity** — last 10 audit events (proposed/approved/rejected/applied) with actor and $.
- States: **loading** (skeleton cards), **empty** ("No agents configured for this tenant yet"), **error** (retryable).

**Findings queue (`/ops/findings`)**
- Table over `ops_findings_view`: columns *Severity*, *Agent*, *Finding type*, *Contract / line* (human label, not raw UUID), *$ delta*, *Confidence*, *Status*, *Detected*. Row click → detail.
- Filters: agent, severity, status (`pending_approval | approved | rejected | informational`), branch, customer. Default sort **$ delta desc** (lead with the biggest leak).
- Status chips color-coded; pending rows visually emphasized. Empty/loading/error states required.

**Finding detail + approval card (`/ops/findings/:findingId`)** — *the core demo surface*
- **Header:** finding type + severity + status + **$ impact** prominently.
- **Expected vs. billed** side-by-side (rate type, amount, period) with the delta highlighted.
- **Evidence list** — the agent's `evidence[]` as a checklist, each linking to the underlying event/record where possible (`/ops/audit/:entityId`).
- **Agent rationale** + **confidence** + the (config-sourced) model/agent that produced it.
- **Entity links:** contract → line → invoice (human labels).
- **Action bar (role-gated `canOperate`):** **Approve** (optional note) and **Reject** (required reason). Disabled with a tooltip for read-only users. On submit → POST to the Operations API (§15); optimistic status flip with rollback on error; realtime refetch so the audit trail updates live. For non-actionable (`informational`) findings, show "No action required."

**Audit trail (`/ops/audit/:entityId`)**
- Timeline of `time_series_points` for the entity: *agent proposed* (rationale + evidence) → *human approved/rejected* (approver + note) → *adjustment drafted* (id + amount). Each node shows actor, timestamp, payload. Demonstrates auditable/replayable/accountable.

### 14.3 Realtime
Findings + audit events update live via the existing Supabase realtime subscription pattern so an approval reflects on the dashboard and audit trail during the demo without a manual refresh. (Fallback: TanStack `refetchInterval` if realtime is unavailable in the target env.)

---

## 15. Approve/Reject API & Temporal-signal contract

The UI cannot signal Temporal directly (static SPA behind nginx; no DB→Temporal path). A thin **Operations API** service bridges them.

### 15.1 Service
- **`temporal/src/ops_api/`** — a small FastAPI app, packaged in the existing `temporal` image, run as a second container/Deployment (`ops-api`) in the Helm chart. It reuses the worker's Temporal client config (`settings`) and a service-role Supabase client.
- Endpoints (auth: the deployed app's authenticated user JWT; `canOperate` enforced server-side too, not just in UI):

| Method | Path | Body | Effect |
|---|---|---|---|
| `POST` | `/api/ops/findings/{finding_id}/approve` | `{ note?: string }` | Look up the finding's `workflow_id` + fingerprint parts; send `approve_finding` signal; record `approval_requested` audit event. Returns `202`. |
| `POST` | `/api/ops/findings/{finding_id}/reject` | `{ reason: string }` | Same, `reject_finding` signal. Returns `202`. |
| `GET` | `/api/ops/health` | — | Liveness/readiness. |

### 15.2 Signal mapping (matches the built workflow)
The finding row persists everything the signal needs (§17.2): `workflow_id`, `contract_id`, `line_item_id`, `finding_type`, plus the approver identity comes from the JWT.

```
approve → client.get_workflow_handle(workflow_id).signal(
            RevenueRecognitionWorkflow.approve_finding,
            ApproveFindingSignal(contract_id, line_item_id, finding_type,
                                 approver_id=<jwt.sub>, approver_name=<jwt.name>))
reject  → ... RejectFindingSignal(...)
```
The workflow already keys decisions on `f"{contract_id}:{line_item_id}:{finding_type}"` and waits per-finding (`wait_condition(..., timeout)`), then runs the gated write (`ops_draft_invoice_adjustment`) and audit activities — so the API only has to deliver the correctly-shaped signal.

### 15.3 Resilience & idempotency
- **Source of truth is the DB disposition,** not the in-flight signal. The API writes the human decision to the finding row + an audit event *before/independent of* signal delivery, so a decision is never lost if the workflow has already timed out or completed.
- A **reconciler activity** (`ops_apply_pending_dispositions`, polled in the workflow's wait loop as a fallback) lets a workflow that missed a live signal still pick up a recorded decision on its next pass — belt-and-suspenders for demo reliability.
- Approve/Reject are **idempotent** on `finding_id` (second call is a no-op once a terminal disposition exists). `auto_apply` stays hard-locked false; the API can only *request* the gated workflow action, never write money rows itself.

---

## 16. Test plan (unit + e2e)

Tests ship **with** each slice (repo convention; the QA Manager files `test-gap` tickets otherwise). Trends land on `ci-history` (unit) and `e2e-history` (e2e).

### 16.1 Unit — Temporal (`pytest`, agent/LLM + DB mocked)
| Area | Must assert |
|---|---|
| Workflow gating | A finding with an actionable `proposed_action` is **not** applied until an `approve_finding` signal arrives; reject/timeout → recorded, no write. |
| `auto_apply=false` | Even if config carries `auto_apply:true`, the workflow never auto-applies (defense-in-depth enforcement). |
| Dedup | A finding whose fingerprint is already open is skipped (no duplicate record). |
| Bounding | Work-list capped at `max_findings_per_run`; remainder logged, not silently dropped. |
| Config loader | `ops_load_agent_config` returns the **DB** row for `(tenant_id, agent_key)`; missing tenant → clear error. |
| Tool-belt | Each read tool returns only allow-listed entity types, is tenant/branch-scoped, and treats results as data (no instruction execution). |
| Activities (DB) | `ops_record_finding` / `ops_draft_invoice_adjustment` write the expected rows + `time_series_points` audit events incl. approver. |

### 16.2 Unit — frontend (`vitest`)
Page-definition tests (like `dashboard-pages.test.ts`) for each new `ops-*.json`: data sources resolve, components bind, empty/loading/error branches render, `$ delta` formats as currency, role-gating hides Approve/Reject for read-only.

### 16.3 Unit — API (`pytest`)
Approve/reject map to the correct signal + args; reject requires a reason; `canOperate` enforced; idempotent on `finding_id`; disposition persisted before signal.

### 16.4 E2E (Playwright, against deployed dev — gating where it's a core journey)
| Spec | Flow |
|---|---|
| `ops-findings.spec.ts` (smoke, gating) | `/ops` loads with seeded agent cards + KPIs; `/ops/findings` lists seeded findings sorted by $; detail page renders evidence + rationale + expected-vs-billed. |
| `ops-approval.spec.ts` (gating) | Open a seeded `pending_approval` finding → **Approve** → status flips to approved, a draft adjustment + audit node appear (realtime), and the finding leaves the pending queue. **Reject** path on a second finding. |
| `experience.spec.ts` (non-gating) | The console meets the good-UX bar: dashboard shows decision-useful KPIs (not just nav), findings show human labels not raw UUIDs, approval card surfaces $ impact + evidence. |

---

## 17. Demo-data design (so it demos *well*)

The demo must make the agent's value obvious in 60 seconds and survive a flaky network. Two principles: **plant verifiable leaks** the agent reliably catches, and **pre-seed the findings/config/audit** so the console is rich *without* a live Azure OpenAI call at demo time (the live run refreshes them as the encore). Extends the existing idempotent seed (`supabase/seed.sql`) under a new namespace `demo-ops-` (fixed cardinalities; re-running yields identical KPIs).

### 17.1 The planted contracts (deliberate, self-evident leaks)
Eight demo contracts on the existing branches/customers/assets, each with a clean time-series and invoice trail so a reviewer can verify the agent by eye:

| # | Contract | Planted condition | finding_type | $ delta | Evidence trail seeded |
|---|---|---|---|--:|---|
| 1 | C-DEMO-101 | Excavator on-rent 3 wks, **no invoice line** for wk 2–3 | `unbilled_on_rent` | **$1,200** | checkout event, on_rent status, invoice missing the weeks |
| 2 | C-DEMO-102 | Skid-steer **returned 05-10**, billing ran to 05-24 | `billing_past_return` | **$1,200** | return event 05-10, invoice lines through 05-24 |
| 3 | C-DEMO-103 | Billed **daily** where rate card says **weekly** is owed | `rate_tier_mismatch` | **$480** | rate_card row, invoice line at daily rate |
| 4 | C-DEMO-104 | Annual **escalation clause** not applied at renewal | `missed_escalation` | **$640** | contract term, prior vs current rate, renewal event |
| 5 | C-DEMO-105 | Overlapping line **double-billed** one week | `over_billed` | **$900** | two invoice lines same period |
| 6–8 | C-DEMO-106/107/108 | **Clean** — correctly billed | *(none)* | — | full correct trail (proves precision: agent must *not* flag these) |

Headline dashboard KPI: **~$4,420 recoverable across 5 findings** — a concrete, memorable number. Round $ amounts on purpose.

### 17.2 Seeded ops rows (so the console is populated on first load)
- **`agent_config`** — `revrec-analyst` for **tenant A** (default thresholds) and **tenant B** (`rate_mismatch_min_delta` lowered so it *also* surfaces a borderline mismatch tenant A suppresses → the "same code, config-driven" moment).
- **`agent_config`** — `fleet-auditor` for **tenant A** and **tenant B** with different idle/demand thresholds so the same workflow behavior remains config-driven per tenant.
- **`finding`** rows for the 5 leaks above, carrying full `evidence[]`, `rationale`, `confidence`, `$ delta`, fingerprint parts, and a `workflow_id` of a (seeded) prior run — so Approve/Reject can target a real handle, and so the UI is rich without a live LLM call.
- **Fleet scenario rows** — one seeded `idle_under_utilized` finding (`fingerprint=demo-ops-fleet-idle-transfer-001`) plus demand-side `rental_order`/`rental_order_line` records (`demo-ops-rental-order-demand-001`, `demo-ops-rental-order-line-demand-001`) and linked `time_series_points` (`demo-ops-fleet-idle-001`, `demo-ops-fleet-demand-001`) to demo idle-asset transfer recommendations backed by real relationships.
- **Mixed states for the narrative:** 3 `pending_approval` (the live-approve demo), 1 already `approved` **with its drafted adjustment + full audit chain** (so the Audit Trail view is populated on open), 1 `rejected` (shows the reject path). Plus `informational` findings on the clean contracts? No — clean contracts produce *nothing* (that's the point).
- **`ops_workflow_run`** rows so the dashboard's "last run / next run / findings produced" is real.
- **Rate cards** (`rate_card` entity) consistent with contracts so `rate_tier_mismatch`/`missed_escalation` are detectable and verifiable.

### 17.3 Read views (the UI/KPI surface)
`ops_findings_view` (finding + human contract/line/customer labels + $), `ops_finding_kpis` (pending count, Σ recoverable, approved-this-cycle, 24h count), `ops_agent_status_view` (per-agent last/next run, counts, pending badge), `ops_audit_trail_view` (ordered time_series_points for an entity). Views keep the client free of raw entity joins and are `security_invoker`-ready for the RLS follow-up.

### 17.4 Reliability & honesty
- **Determinism:** same namespace-purge-then-recreate pattern as today's seed; KPIs stable across reseeds for repeatable demos.
- **Live run as encore, not dependency:** the seeded findings stand alone; triggering the schedule/Temporal run re-derives them (and may add tenant B's borderline one) — impressive when the network cooperates, harmless when it doesn't.
- **No real data:** synthetic only, no live telematics/customer PII (decision §3.4).

---

## 18. Implementation status & ticket breakdown

### 18.1 Status (as of this build-out)
- ✅ **Done (PR #144):** workflow orchestration (`workflows/ops/revrec.py` — gating, dedup, bounding, per-finding signal wait, `auto_apply=false`), agent fn (`agents/revrec_analyst.py`), tool *definitions* (`agents/tools/rental_data.py`), Azure OpenAI client (`agents/openai_client.py`), worker registration, workflow unit tests.
- 🟡 **Stubbed — logs only, no DB:** every `ops_revrec.py` I/O activity (`ops_load_agent_config`, `ops_scope_revrec_contracts`, `ops_list_open_finding_fingerprints`, `ops_record_finding`, `ops_record_finding_disposition`, `ops_draft_invoice_adjustment`, run-record activities) + the tool-belt's data access.
- 🔴 **Missing:** ops DB schema (config/findings/runs/adjustments + `tenant_id`), demo seed (§17), Operations API (§15), Findings & Approvals UI (§14), Temporal Schedule, e2e tests, `OPERATIONS.md`.

### 18.2 Tickets (dependency-ordered; each carries its own tests)
```
T1 ── DB schema: ops_agent_config, finding, ops_workflow_run, invoice_adjustment_draft
      (+ tenant_id convention) + read views §17.3            [queue:database]
      │
      ├──► T2 ── Wire stub activities + tool-belt to real DB (config loader, scope,
      │          record finding/disposition, draft adjustment, run records) + unit tests
      │
      ├──► T3 ── Demo seed §17: planted leaks + rate cards + agent_config (2 tenants)
      │          + seeded findings/runs/audit chain (idempotent, namespaced)
      │
      └──► T4 ── Operations API §15 (FastAPI approve/reject → Temporal signal,
                 disposition-first, idempotent) + Helm deploy + API unit tests
                 │
   T3,T4 ──────► T5 ── Findings & Approvals UI §14 (4 pages + realtime + role-gating)
                       + vitest page-def tests
                       │
   T5 ──────────────► T6 ── E2E §16.4 (ops-findings + ops-approval gating specs,
                            experience expectations)
   T1 ──► T7 ── Temporal Schedule from config (on by default) + unit test  [parallel after T1]
   (any) ─ T8 ── OPERATIONS.md runbook stub + Ops Monitor sketch           [parallel, docs]
```
Critical path to a working demo: **T1 → T3 → T5 → T6** (data + UI is demoable even before T2's live agent wiring, because findings are seeded). T2/T4/T7 harden it into the full live loop. This lets the slice be proven end-to-end incrementally rather than big-bang.

### 18.3 Follow-on decomposition candidate — Damage & Returns Charge Assistant
- **D1 — Read model + tool-belt inputs:** return-inspection/baseline/accessory/policy/parts-labor read views and unit tests for evidence scoping.
- **D2 — Per-return workflow:** trigger from return/check-in, investigate each return, classify `fair_wear` vs. `billable`, and gate any draft charge on human approval.
- **D3 — Damage-review UX:** extend the finding detail card with before/after evidence + policy citation + approve/reject flow, with tests for evidence linkage and approval gating.

### 18.4 Decomposition seed — Customer Success & Churn-Risk epic
- **C1 (design/contract):** define `churn_risk_finding_v1` schema (risk score bands, reason codes, recommended play, talking points) and customer-level fingerprint/dedup strategy.
- **C2 (data/tooling):** add read-only customer success tools (cadence trend, demand-share estimate, dispute aging, renewal risk facts) and tenant-scoped config keys.
- **C3 (workflow):** `temporal/src/workflows/ops/customer_success.py` with per-customer fan-out, ranking, `approve_finding`/`reject_finding` gate, and internal-task write path only.
- **C4 (UI/API):** queue/detail adaptations for ranked account-risk views + approved write into internal outreach task/opportunity records.
- **C5 (tests):** unit tests for risk scoring bands/reason-code stability, dedup, no-auto-contact guarantee, and approval-gate enforcement.
