# Agent-Executable PRD: Receivables Collections Prioritizer (Priorização de Cobrança / Inadimplência)

## 0. Execution Header

| Field | Value |
|---|---|
| **Input source** | Research REPORT / task brief for the "Receivables Collections Prioritizer" DIA ops agent (see §1 ledger). |
| **Repo** | `/mnt/c/Dev/AIAccelerator/dealernet-agents` (branch `main`). |
| **Stack** | Python 3.14 + Temporal workers (`temporal/`); Supabase/Postgres migrations (`supabase/`); pytest; Node `node:test` for SQL-contract tests. |
| **Runtime executor** | Claude Code / Codex via `/ship-issue`. |
| **Size tier** | **large** — two phases. Phase A is the **unblocking data foundation** (a NEW finance mirror: two DIA entities + catalog + scope views + RLS + seed); Phase B is the agent triad (clone of `vehicle_aging`). 13 tasks total (A: 5, B: 8). Kept as ONE PRD per the "one issue per agent" rule, organized Phase A / Phase B. |
| **Date** | 2026-06-25 |
| **Status** | Ready for execution. |

---

## 1. Input Extraction Ledger

| # | Extracted intent | Disposition |
|---|---|---|
| I-1 | A proactive DIA ops agent for the financial manager / collector / dealer principal that scopes overdue (and near-due) customer receivables. | Goal → §3; FR-1..FR-4. |
| I-2 | An LLM ranks each customer by recoverable exposure AND reads the free-text collection-contact/promise notes to recommend the next collection action. | Goal → §3; FR-5, FR-6 (this is the "true LLM intelligence" core: synthesize unstructured notes). |
| I-3 | Records ranked **assist-only** "findings" (recommend call/renegotiate/escalate); a human acts. NO automatic dunning, NO money movement. | Non-goals → §3; SEC-4, SEC-5; FR-7. |
| I-4 | NOT a duplicate of the Wynne `credit_analyst` / `account_health` agents, which are being PURGED (`supabase/seed.sql:33-36`, expanded purge block `:42-66`). | Distinct `agent_key` `collections-prioritizer`, distinct `finding_type` `collections_priority`. Verified seed purge targets `credit-analyst`/`account-health-queue` (seed.sql:44-50). |
| I-5 | Finance entities are **NOT mirrored to Supabase yet** — no `titulo` (receivable) or `cobranca`/`cobranca_contato` (collection contact) DIA entity. So a NEW finance mirror must come FIRST (Phase A), then the triad (Phase B). | Confirmed: catalog (`20260626130000_dia_entity_type_catalog_reconcile.sql:20-31`) lists only vehicle/brand/service_order/part/part_sale — no finance types. → Phase A. |
| I-6 | Phase A creates two NEW DIA entities: `receivable` (título: balance, due_date, days_overdue, customer, document, type, collector/agent) and `collection_contact` (cobrança: action, note/observation free-text, next_contact_date, result), following EXACTLY the entity-CRUD + security_invoker-view + RLS pattern in `20260625150200_dia_part_entity_crud.sql`. | §9 Phase A T-001/T-002; Implementation Contract §8. |
| I-7 | Register the new types in the authoritative catalog (`20260626130000_..._reconcile.sql`). NEVER drop existing types when adding (CLAUDE.md gotcha). | T-003. |
| I-8 | Provide row-level scope views `v_dia_receivable_current` and `v_dia_collection_contact_current`. | T-001/T-002 (views are part of each entity migration). |
| I-9 | The real ERP→Supabase ingestion that POPULATES these mirrors is OUT OF SCOPE; PRD delivers schema + views + representative seed so the agent is testable. Flag who owns the real pipeline + timeline. | [ASSUMPTION A-2]; [NEEDS CLARIFICATION NC-1]; non-goal §3. |
| I-10 | Agent is a clone of the `vehicle_aging` triad (workflow + activities + agent module + named-activity wrappers delegating to `ops_revrec`). Keep v1 SIMPLE: pass contact notes INLINE in scope payload, `tools=[]`. Mention a fast-follow that could fetch more history via a `dia_bi`-style tool. | §9 Phase B; §4 A-3; fast-follow note in §3. |
| I-11 | Finding schema `CollectionsFindingV1`: closed (`extra="forbid"`); fields customer_id, finding_type=`collections_priority`, severity, recommended_action ∈ {`call`,`renegotiate`,`send_notice`,`escalate_legal`,`hold_credit`,`monitor`}, total_exposure, days_overdue, next_step_note, evidence[], confidence, rationale; required = customer_id, recommended_action, rationale. | §8; T-B1; output-schema registry T-B2. |
| I-12 | Success metrics: DSO / inadimplência (días/% overdue). | §3 success metrics. |

---

## 2. Source Grounding Ledger

### Files read (path:Lstart-Lend → what each establishes)

| File path:lines | What it establishes (ground truth) |
|---|---|
| `temporal/src/workflows/ops/vehicle_aging.py:34-184` | The workflow shape to clone: `scope → no-op early return on empty (`:85-86`) → assess concurrently via `asyncio.gather` (`:88-98`) → build surfaced rows + sort (`:100-134`) → dedup by fingerprint against `ops_list_open_finding_fingerprints` (`:136-150`) → bound by `max_findings_per_run` (`:152-161`) → record findings (`:163-170`) → `finally:` finalize run (`:176-183`). `auto_apply` forced False (`:75`). RetryPolicy constants (`:16-22`); `_AI_HEARTBEAT_TIMEOUT=45s` (`:22`), AI retry max_attempts=2 (`:20`). `_WORKFLOW_KEY="vehicle-aging-analyst"` (`:24`). |
| `temporal/src/activities/ops_vehicle_aging.py:69-281` | The activities to clone. `ops_scope_*` reads `v_dia_vehicle_current` via `ops_revrec._get_ops_persistence_client()` (`:79,86-93`), filters/derives severity + SHA-256 fingerprint deterministically (`:96-134`). `ops_*_assess` (`:137-200`) renders prompts via `ops_revrec.interpolate_prompt_template`, runs a 15s heartbeat loop (`:166-177`), calls `run_vehicle_aging_analyst`, then PINS deterministic money fields back to scoped values (`:188-199`). NAMED-activity wrappers delegate to `ops_revrec` (`:203-269`): `ops_load_agent_config`, `ops_list_open_finding_fingerprints`, `ops_create_workflow_run`, `ops_finalize_workflow_run`, `ops_record_finding` (via `_*_finding_for_storage` shaping at `:223-257`), `ops_record_finding_disposition`. `__all__` (`:272-281`). |
| `temporal/src/agents/vehicle_aging_analyst.py:21-74` | The agent module to clone. Closed Pydantic `VehicleAgingFindingV1(ConfigDict(extra="forbid"))` (`:21-33`); `*_v1_schema()` returns `model_json_schema()` (`:36-37`); `_no_tool_executor` short-circuit (`:40-44`); `run_*` calls `chat_with_tools(messages=[system,user], tools=[], tool_executor=_no_tool_executor, response_format=<Model>, max_tool_rounds=...)` and returns `result.response.model_dump(mode="json")` (`:47-67`). NO tools → transport never sends `tool_choice`. |
| `temporal/src/agents/tools/dia_bi.py:32-38,48-64` | Read-only Supabase client pattern for a fast-follow tool: `build_service_role_dia_client()` → `PostgrestReadClient`; `_read(...)` → `client.select(view, columns="*", filters=..., order_by=..., limit=...)`. (Reference only; v1 uses `tools=[]`.) |
| `temporal/src/activities/ops_revrec.py:292-304,461-539,611-684` | Persistence layer the wrappers delegate to. `_get_ops_persistence_client()` returns a service-role `PostgrestServiceRoleClient` (`:292-300`). `ops_load_agent_config` FAILS (`AgentConfigNotFoundError`) without a current config row, resolves `output_schema_key` against `ops_output_schema_registry`, and **forces `auto_apply=False`** (`:502-539`). `ops_list_open_finding_fingerprints` reads `finding` where status=`pending_approval` (`:611-619`). `ops_record_finding` UPSERTs on `(tenant_id, fingerprint)` with status `pending_approval` and appends an audit event keyed on `contract_id`/`line_item_id` (`:654-684`, `_build_finding_row` `:373-404`, `_append_audit_event` `:407-438`). `interpolate_prompt_template` (`:315-331`) supports `{var}` and `{{var}}` and RAISES on missing vars. |
| `supabase/migrations/20260625150200_dia_part_entity_crud.sql:28-352` | **Entity-mirror template** to clone for `receivable`/`collection_contact`. (1) Re-create `rental_entity_type_catalog` VALUES view INCLUDING the full existing type list + the new one (`:28-45`) — CLAUDE.md gotcha. (2) `dia_assert_<entity>_writer()` SECURITY DEFINER role guard: service_role OR (authenticated AND `get_my_role() in ('admin','branch_manager')`), else errcode `42501` (`:55-86`). (3) `dia_validate_<entity>_data(jsonb)` required-field + enum validation, errcode `22023` (`:89-116`). (4) `create_/update_/delete_<entity>` SECURITY DEFINER RPCs (`:118-283`): create calls `create_entity_with_version(p_entity_type, p_data, p_source_record_id)`; update/delete append SCD2 versions; `revoke all ... from public; grant execute ... to authenticated, service_role`. (5) `v_dia_<entity>_current` `security_invoker=true` view over `rental_current_entity_state` filtered by `entity_type` and non-`retired` (`:292-330`). |
| `supabase/migrations/20260626130000_dia_entity_type_catalog_reconcile.sql:16-33` | **Authoritative catalog** (must be re-created LAST with the COMPLETE union). Current list: company…purchase_order + `vehicle, brand, service_order, part, part_sale` (`:20-31`). Phase A adds `receivable, collection_contact`. |
| `supabase/migrations/20260626140001_vehicle_aging_agent.sql:7-34` | **Output-schema registry seed** pattern: `insert into public.ops_output_schema_registry (schema_key, schema_json, description) values ('vehicle_aging_finding_v1', '{...closed JSON schema...}'::jsonb, '...') on conflict (schema_key) do update set schema_json=..., description=..., updated_at=now()`. The embedded JSON has `additionalProperties:false`, `required`, `properties`. |
| `supabase/migrations/20260625130000_dia_vehicle_entity_crud.sql:298-343` | Confirms the `v_dia_*_current` view shape (security_invoker; derived columns via `data ->> '...'`; over `rental_current_entity_state`; grant select to authenticated, service_role). Derived-column idiom (e.g. `greatest(now()::date - (data->>'due_date')::date, 0)` for `days_overdue`). |
| `supabase/migrations/20260607170000_ops_factory_persistence.sql:39-67,179-298,300-365` | **Finding store** (no new table needed): `public.finding` with `constraint finding_tenant_fingerprint_uk unique (tenant_id, fingerprint)` (`:63`), status check incl `pending_approval` (`:61`), `confidence` 0..1 check (`:62`). RLS read for roles incl `admin,branch_manager,field_operator,read_only` + tenant match (`:235-248`); write only admin/branch_manager (`:250-263`); service_role full (`:284-295`). Surfacing view `ops_findings_view` joins `finding` → current entities (`:300-365`); `customer_id`/`customer_name` derived from a contract's `customer_id` (`:359-365`). |
| `temporal/src/worker.py:43,82,102-103,357-423,1419-1526` | Worker registration + cron reconcile. Import `ops_vehicle_aging` (`:43`); import `VehicleAgingWorkflow,...Input` (`:82`); `_VEHICLE_AGING_AGENT_KEY` + `_VEHICLE_AGING_DEFAULT_CRON="0 6 * * 1-5"` (`:102-103`); per-agent reconcile fns (`:357-423`) + best-effort call in `main()` (`:1360-1362`); `Worker(workflows=[..., VehicleAgingWorkflow, ...], activities=[..., ops_vehicle_aging.<8 fns>, ...])` (`:1434, :1519-1526`). |
| `temporal/src/ops_api/app.py:76-96,716-725,2306-2350` | Run-now wiring. `_OPS_AGENT_KEYS` tuple (`:76-88`) feeds `_AGENT_SCHEDULE_ID_BUILDERS` mapping each ops key → `ops:{tenant}:{key}` (`:90-92`). `run_agent_now` triggers the schedule with `SKIP` overlap (`:716-725`). `POST /api/ops/agents/{agent_key}/run` validates `agent_key in _AGENT_SCHEDULE_ID_BUILDERS` (404 else), requires operate permission, returns 202 / 409-if-not-provisioned (`:2306-2349`). |
| `temporal/src/workflows/ops/__init__.py:1-86` | Workflow package re-exports. New workflow + input must be added (import block + `__all__`) so `from ..workflows.ops import ...` resolves (pattern at `:29-35` for revrec). |
| `temporal/tests/test_ops_vehicle_aging.py:1-712` | **Test pattern** to clone. Deterministic-helper unit tests (`:63-155`); `_FakeTransport` for the LLM (`:198-218`); agent schema/round tests (`:164-281`); `_FakeSelectClient` monkeypatching `ops_revrec._ops_client` for scope tests (`:289-394`); full workflow tests via `patch.object(tw_mod,"execute_activity", side_effect=fake)` harness (`:439-659`) covering records-all / dedupe-all / dedupe-some / auto_apply-false / bounding / empty-scope / heartbeat+retry; worker-registration + no-`rental_*`-import hygiene tests (`:667-712`). |
| `temporal/tests/test_worker_registration.py:12,43,105-194` | `_extract_worker_activity_references()` / `_extract_worker_workflow_references()` parse `worker.py`; `test_all_registered_activities_exist` / `_workflows_exist` assert every registered symbol exists. New activities/workflow must be both imported and registered. |
| `supabase/tests/part_crud.test.mjs:30-117,122-533` | **RLS/CRUD SQL-contract test** pattern to clone: `docker exec -i supabase_db_dealernet-agents psql ...` (`:44-76`); `asWriter(appRole)` sets `role authenticated` + injects JWT claims `{role:'authenticated', app_metadata:{role:appRole}}` (`:34-39,81-85`); `captureSqlstate` asserts `SQLSTATE=42501` (role guard) / `22023` (validation) (`:91-102`); happy-path create/update(SCD2)/delete(soft) + view-derivation + role-guard cases; everything inside `begin; ... rollback;` with `TEST-` source_record_ids (never touches seed). |
| `supabase/seed.sql:1-66,267-366` | Wynne purge (`:24-66`): deletes findings/config for `revrec-analyst, credit-analyst, fleet-auditor, account-health-queue, territory-account-brief` (`:44-50`) and trims `ops_output_schema_registry` to only `vehicle_aging_finding_v1` (`:63`) — **so the collections registry row + agent_config MUST be seeded AFTER this purge** or kept by the agent-specific block. Agent-config seed block (`:267-366`): per-tenant (demo-ops-a/b) upsert into BOTH the `agent_config` entity store (read by `ops_agent_config_current`) AND the base `ops_agent_config` table; `schedule.enabled=false` keeps recurring runs off. |

### Stack facts (incl test commands)

- Python 3.14, Temporal workers; tests run with `python -m pytest temporal/tests/<file> -v`.
- Shared Supabase DB has **no `supabase` CLI on PATH**. Validate SQL against the live container:
  `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f <migration>`. **NEVER `supabase db reset`** (breaks parallel runs — CLAUDE.md gotcha).
- SQL-contract tests: `node --test supabase/tests/<file>.test.mjs` (requires the container up).
- Migrations are timestamp-ordered `YYYYMMDDHHMMSS_descricao.sql`; the catalog-reconcile migration must remain **last** among catalog re-creations.

### Patterns to follow

1. Entity mirror = clone `20260625150200_dia_part_entity_crud.sql` (catalog re-create + writer guard + validate + CRUD RPCs + `security_invoker` view).
2. Agent triad = clone the three `vehicle_aging` files + the 8 named-activity wrappers; `tools=[]`, evidence inline.
3. Persistence is reused verbatim via delegation to `ops_revrec` (do NOT re-implement finding storage).
4. Output schema lives in TWO places that MUST agree: the Pydantic model and the `ops_output_schema_registry` migration row (asserted by a test — `test_ops_vehicle_aging.py:179-195`).

### Integration points

- `temporal/src/worker.py` — register workflow + 8 named activities; add `_COLLECTIONS_*` reconcile (cron) like vehicle-aging.
- `temporal/src/ops_api/app.py` — add `"collections-prioritizer"` to `_OPS_AGENT_KEYS` so run-now resolves.
- `temporal/src/workflows/ops/__init__.py` — re-export the new workflow + input.
- `supabase/seed.sql` — add a `collections-prioritizer` agent-config block (after the Wynne purge) + representative `receivable`/`collection_contact` demo entities for a testable run.

### Input-vs-code conflicts

| Claim in input | Code reality | Resolution |
|---|---|---|
| "records ranked findings" | `finding` store + `ops_record_finding` already exist; no new finding table | **Drift-avoided**: reuse `public.finding`; only add an output-schema-registry row. |
| "rank by recoverable exposure AND read free-text notes via a tool" | vehicle_aging passes all evidence INLINE (`tools=[]`); a tool path exists in `dia_bi.py` but is heavier | **Intended-simplification**: v1 inlines notes in the scope payload (`tools=[]`), faithful clone. Tool-based history = fast-follow (§3). |
| "finance entities exist as `titulo`/`cobranca`" | catalog has NO finance types | **Drift**: they do not exist → Phase A creates `receivable` + `collection_contact`. |

### Unknowns

- U-1: Who owns the real ERP→Supabase ingestion for receivables/contacts, and when? → [NEEDS CLARIFICATION NC-1]. Does not block this PRD (seed makes the agent testable).
- U-2: Exact ERP field→JSONB key names. → [ASSUMPTION A-1] fixes a representative key set grounded in the ERP KB; the ingestion owner can remap later.

---

## 3. Outcome Contract

### Goal
Ship a proactive, **assist-only** DIA ops agent — `collections-prioritizer` — that, per tenant: scopes a customer's overdue (and near-due) receivables from a NEW Supabase finance mirror, has an LLM rank each customer by recoverable exposure while **reading the free-text collection-contact notes**, and records a ranked `collections_priority` finding (status `pending_approval`) recommending the next human action (`call` / `renegotiate` / `send_notice` / `escalate_legal` / `hold_credit` / `monitor`). Delivered in two phases: **Phase A** stands up the finance data foundation (entities `receivable` + `collection_contact`, catalog, scope views, RLS, representative seed); **Phase B** ships the agent triad as a faithful clone of `vehicle_aging`.

### Non-goals (explicit)
- **No automatic dunning** — the agent never sends a notice/SMS/email/letter to a customer.
- **No money movement** — no payment, no write-off, no credit/limit change, no invoice/adjustment is ever posted or applied. `auto_apply` is forced `False`.
- **Real ERP→Supabase ingestion is OUT OF SCOPE** — this PRD delivers schema + views + a representative seed only. The production ingestion pipeline that POPULATES `receivable`/`collection_contact` is owned elsewhere ([NEEDS CLARIFICATION NC-1]).
- No new finding table, no new finding-surfacing UI, no changes to `FindingsQueue.tsx` (the existing `ops_findings_view` → queue surfaces the new findings automatically).
- No tool-calling in v1 (`tools=[]`); a `dia_bi`-style "fetch more contact history" tool is a **fast-follow**, not in scope.

### Observable truths (must hold when done)
- OT-1: A scheduled or run-now execution of `collections-prioritizer` for a tenant with overdue receivables in the mirror produces ≥1 `finding` row with `agent_key='collections-prioritizer'`, `finding_type='collections_priority'`, `status='pending_approval'`.
- OT-2: Re-running with no new customers records 0 and deduplicates all (`recorded_findings=0`, `deduped_findings=N`).
- OT-3: A tenant with no overdue receivables yields `total_customers_scoped=0` and records nothing, finalizing the run (no error).
- OT-4: `auto_apply` is `False` in the result summary even if the config row sets it `True`.
- OT-5: Direct client INSERT/UPDATE to `receivable`/`collection_contact` is blocked by RLS; writes succeed only via the `create_*`/`update_*` RPCs and only for service_role / admin / branch_manager (read_only → `42501`).
- OT-6: `python -m pytest temporal/tests/test_ops_collections.py temporal/tests/test_worker_registration.py -v` passes; `node --test supabase/tests/collections_rls.test.mjs` passes; all four catalog/agent migrations apply cleanly against the shared container.

### Success metrics (business)
- **DSO** (Days Sales Outstanding) and **inadimplência %** (overdue balance ÷ total receivable balance) trend down as collectors action the ranked findings.
- Operational: collector time-to-first-contact on the highest-exposure overdue customers (the top-ranked findings) decreases.

---

## 4. Clarifications & Assumptions

- **[ASSUMPTION A-1]** Entity `data` JSONB keys (representative; grounded in ERP KB — see provenance below):
  - `receivable`: `customer_id` (uuid, FK-by-convention to a `customer` entity), `customer_name`, `document_number` (título doc), `receivable_type` (e.g. `a_receber`), `balance` (numeric, Saldo), `due_date` (date, DataVencimento), `days_overdue` (int; if absent, derived in the view as `greatest(now()::date - due_date, 0)`), `collector_code`/`collector_name` (AgenteCobradorCod), `status` (`aberto`|`liquidado`), `source_record_id`. Required (validate, `22023`): `customer_id`, `due_date`, `balance`.
  - `collection_contact`: `customer_id`, `receivable_id` (optional link), `action` (AcaoDes — e.g. `ligacao`,`promessa`,`acordo`), `note` (Observacao — **the free-text the LLM reads**), `contact_date` (date), `next_contact_date` (date, DataProximo), `result` (e.g. `promessa_pagamento`), `source_record_id`. Required: `customer_id`, `action`.
- **[ASSUMPTION A-2]** Entity names are `receivable` and `collection_contact` (snake_case, English, matching the existing `vehicle`/`part` convention). The ERP→Supabase ingestion that populates them is out of scope for this PRD.
- **[ASSUMPTION A-3]** Cadence: default cron `0 6 * * 1-5` (weekday 06:00, same as vehicle-aging), seeded with `schedule.enabled=false` so the recurring run stays OFF until explicitly enabled; QA/demo uses run-now.
- **[ASSUMPTION A-4]** Scope thresholds (overridable via `config.thresholds`): a customer is in scope if it has ≥1 receivable with `status='aberto'` and `days_overdue >= near_due_days` where `near_due_days` default `-5` (i.e. include receivables due within 5 days AND all overdue). Severity by max `days_overdue` across the customer's open receivables: `>90 → critical`, `31..90 → high`, `1..30 → medium`, `<=0 (near-due only) → low`. `total_exposure` = sum of open `balance` for the customer.
- **[ASSUMPTION A-5]** Fingerprint is customer-scoped: `sha256(f"{tenant_id}:{customer_id}:collections_priority")` (one open finding per customer per cycle), mirroring `_stock_aging_fingerprint` (`ops_vehicle_aging.py:65-66`).
- **[NEEDS CLARIFICATION NC-1]** Who owns the production ERP→Supabase ingestion pipeline for `receivable` + `collection_contact` (which connector/worker; cadence; field mapping authority), and what is its timeline? This PRD is unblocked by the representative seed, but the agent only delivers business value once real data flows. **Recommended default while unresolved:** ship Phase A schema + seed now; track the ingestion as a separate follow-up issue assigned to the integrations owner.

**ERP provenance** (relative to ERP KB; cited, not read): `WebPanels/WP_ControleCobranca.md` (assembles overdue titles + contacts per customer/collector); `Transactions/CobrancaContato.md` (AcaoDes / Observacao / DataProximo — the free-text); `Procedures/PRC_PessoaInadimplente.md` (inadimplência = `Titulo_PgtoDiasEmAtraso>0` on a/receber); `Transactions/Titulo.md` (Saldo / DataVencimento / AgenteCobradorCod / PessoaCod); `Procedures/PRC_Titulo_DiasAtraso.md`.

---

## 5. Glossary

| Term | Meaning |
|---|---|
| **título / receivable** | An open accounts-receivable item owed by a customer (Saldo/balance, DataVencimento/due_date). DIA entity `receivable`. |
| **inadimplência** | Delinquency: a receivable past due (`days_overdue > 0`) on the a/receber side. |
| **cobrança / collection_contact** | A logged collection interaction with a customer (action + free-text note + next-contact date + result). DIA entity `collection_contact`. |
| **agente cobrador / collector** | The person/agent assigned to collect a título (AgenteCobradorCod). |
| **recoverable exposure / total_exposure** | Sum of a customer's open receivable balances (what could be recovered). |
| **finding** | An assist-only recommendation row in `public.finding` (status `pending_approval`); a human decides. |
| **assist-only** | The agent recommends; it never executes the action. No dunning, no money movement. |
| **DSO** | Days Sales Outstanding — average days to collect receivables. |
| **fingerprint** | Deterministic SHA-256 dedupe key, customer-scoped, for upsert on `(tenant_id, fingerprint)`. |

---

## 6. Requirements

EARS-light. IDs are stable.

### Functional
- **FR-1** The system SHALL register two new DIA entity types — `receivable` and `collection_contact` — in the authoritative `rental_entity_type_catalog`, preserving every pre-existing type.
- **FR-2** The system SHALL expose hardened CRUD RPCs (`create_receivable`/`update_receivable`/`delete_receivable`, `create_collection_contact`/`update_collection_contact`/`delete_collection_contact`) that append SCD2 versions and are restricted to service_role OR authenticated admin/branch_manager.
- **FR-3** The system SHALL expose `security_invoker` views `v_dia_receivable_current` and `v_dia_collection_contact_current` over `rental_current_entity_state`, excluding `retired` rows and deriving `days_overdue` for receivables when not stored.
- **FR-4** WHEN the workflow runs for a tenant, the system SHALL deterministically scope customers having ≥1 open receivable at/over the near-due threshold (default include overdue + due-within-5-days), compute per-customer `total_exposure`, `max_days_overdue`, severity, and a customer-scoped fingerprint, ordered by `total_exposure` desc.
- **FR-5** For each scoped customer, the system SHALL pass that customer's open receivables AND their recent `collection_contact` notes **inline** in the scope payload to the LLM (`tools=[]`).
- **FR-6** The LLM agent SHALL return a `CollectionsFindingV1` recommending one `recommended_action` ∈ {`call`,`renegotiate`,`send_notice`,`escalate_legal`,`hold_credit`,`monitor`} plus a `next_step_note`, `rationale`, `evidence[]`, and `confidence`, validated against the closed schema (`extra="forbid"`).
- **FR-7** The system SHALL record each surfaced recommendation as a `finding` row (`agent_key='collections-prioritizer'`, `finding_type='collections_priority'`, status `pending_approval`) UPSERTed on `(tenant_id, fingerprint)`, after deduplicating against already-open fingerprints and bounding by `max_findings_per_run`.
- **FR-8** The system SHALL force `auto_apply=False` regardless of config, and SHALL finalize the workflow run (status + counts) in all paths including failure and empty-scope.
- **FR-9** The system SHALL register the workflow and all named activities in `worker.py`, add a per-tenant schedule reconcile (cron, seeded disabled), re-export the workflow from `workflows/ops/__init__.py`, and add `collections-prioritizer` to the run-now allowlist so `POST /api/ops/agents/collections-prioritizer/run` resolves.
- **FR-10** The system SHALL seed a `collections-prioritizer` agent-config row (entity store + base table) for demo-ops-a/b AND representative `receivable`/`collection_contact` demo entities, idempotently and after the Wynne purge.

### Non-functional
- **NFR-1** The agent triad files SHALL NOT import any `rental_*` helper module (enforced by an AST hygiene test, mirroring `test_ops_vehicle_aging.py:696-711`).
- **NFR-2** Deterministic, money-relevant fields (`total_exposure`, `days_overdue`, `severity`, `customer_id`, `fingerprint`) SHALL be pinned from the scoped view values, never taken from free-form model output (mirroring `ops_vehicle_aging.py:188-199`).
- **NFR-3** The LLM activity SHALL heartbeat every 15s and run with a 45s heartbeat timeout and retry cap of 2 (ADR-0003 wiring, mirroring `vehicle_aging.py:20-22,88-98`).
- **NFR-4** Migrations SHALL be idempotent where practical (`create or replace`, guarded drops) and validate against the shared container with `ON_ERROR_STOP=1`.
- **NFR-5** Log messages SHALL be single-line (CLAUDE.md logging rule).

### Security
- **SEC-1** RLS SHALL block direct client writes to `receivable`/`collection_contact`; writes occur only through the SECURITY DEFINER RPCs, which raise `42501` for non-admin/branch_manager authenticated roles (mirroring `dia_assert_part_writer` `20260625150200_...:55-86`).
- **SEC-2** The `v_dia_*_current` views SHALL be `security_invoker=true` so authenticated callers see only RLS-permitted rows; the agent reads them with the **service role** (`ops_revrec._get_ops_persistence_client`), consistent with every other ops agent.
- **SEC-3** Customer-financial PII (names, documents, balances, free-text notes) SHALL be minimized in prompts and findings: the prompt SHALL include only the fields needed to rank and recommend; the persisted finding SHALL store `customer_id` + derived numerics + a short `next_step_note`/`rationale`, and SHALL NOT copy full contact-note transcripts verbatim into `finding.expected` beyond a bounded `evidence[]` summary.
- **SEC-4** The agent SHALL be **assist-only**: it MUST NOT send any customer-facing communication (no dunning) and MUST NOT call any money-moving activity.
- **SEC-5** `auto_apply` SHALL be forced `False` at config-load and in the workflow summary (defense in depth; mirrors `ops_revrec.py:536-539` + `vehicle_aging.py:75`).

---

## 7. Acceptance Criteria

Given/When/Then. Each maps to ≥1 requirement (see §10).

- **AC-1 (catalog)** Given the finance migrations are applied, When `select entity_type from rental_entity_type_catalog`, Then the result includes `receivable` AND `collection_contact` AND still includes all of `vehicle, brand, service_order, part, part_sale` (none dropped). *(FR-1)*
- **AC-2 (create happy path)** Given an `admin` JWT, When `create_receivable('{"customer_id":"…uuid…","due_date":"2026-01-01","balance":"1500"}'::jsonb)`, Then a row appears in `v_dia_receivable_current` with version 1 and `status` defaulted. *(FR-2, FR-3)*
- **AC-3 (validation)** Given an `admin` JWT, When `create_receivable` is called without `due_date` (or `create_collection_contact` without `action`), Then it fails with `SQLSTATE=22023`. *(FR-2)*
- **AC-4 (role guard)** Given a `read_only` JWT, When `create_receivable`/`create_collection_contact` is called, Then it fails with `SQLSTATE=42501`; and a `branch_manager` JWT succeeds. *(SEC-1)*
- **AC-5 (SCD2 update / soft delete)** Given an existing receivable, When `update_receivable` then `delete_receivable`, Then version increments, prior versions stay intact, and after delete the row leaves `v_dia_receivable_current` (status `inativo`/`retired`). *(FR-2, FR-3)*
- **AC-6 (days_overdue derivation)** Given a receivable with `due_date` 100 days in the past and no stored `days_overdue`, When read from `v_dia_receivable_current`, Then `days_overdue = 100` (and `0` for a future due date). *(FR-3)*
- **AC-7 (scope ordering + severity)** Given seeded customers with mixed exposure/overdue, When `ops_scope_collections` runs, Then it returns customers ordered by `total_exposure` desc with deterministic `severity`, `max_days_overdue`, and customer-scoped `fingerprint`, and excludes customers with no open at/over-threshold receivable. *(FR-4)*
- **AC-8 (LLM no-tools + closed schema)** Given a fake transport, When `run_collections_prioritizer` is called, Then it sends `tools=[]` (no `tool_choice`) and returns a validated `CollectionsFindingV1`; a response with an unknown field fails closed after the bounded retry. *(FR-5, FR-6)*
- **AC-9 (records all when none open)** Given 3 scoped customers and no open fingerprints, When the workflow runs, Then `recorded_findings=3`, `deduped_findings=0`, ordered by exposure desc, each `finding_type='collections_priority'`, `status='pending_approval'`. *(FR-7)*
- **AC-10 (dedupe on re-run)** Given all 3 fingerprints already open, When the workflow re-runs, Then `recorded_findings=0`, `deduped_findings=3`, nothing newly recorded. *(FR-7)*
- **AC-11 (auto_apply false)** Given a config with `auto_apply=true`, When the workflow runs, Then the summary reports `auto_apply=False`. *(FR-8, SEC-5)*
- **AC-12 (empty scope)** Given a tenant with no qualifying receivables, When the workflow runs, Then `total_customers_scoped=0`, nothing recorded, and the run is finalized (no exception). *(FR-8)*
- **AC-13 (bounding)** Given `max_findings_per_run=1` and 3 scoped customers, When the workflow runs, Then `processed_findings=1`, `remaining_findings_count=2`, and the single recorded finding is the highest-exposure customer. *(FR-7)*
- **AC-14 (heartbeat/retry wiring)** Given the workflow drives the assess activity, Then that activity is scheduled with a 45s heartbeat timeout and retry cap 2. *(NFR-3)*
- **AC-15 (worker + run-now registration)** Then `VehicleAgingWorkflow`-style assertions pass for `CollectionsPrioritizerWorkflow`: the workflow and every `@activity.defn` in `ops_collections` are registered in `worker.py`; `collections-prioritizer` is in `_AGENT_SCHEDULE_ID_BUILDERS`; and the triad files import no `rental_*`. *(FR-9, NFR-1)*
- **AC-16 (registry agreement)** Then `collections_finding_v1_schema()` equals the embedded JSON-schema literal in the agent migration (title, `additionalProperties:false`, `required`, `properties` keys). *(FR-6, FR-10)*
- **AC-17 (PII minimization)** Then the persisted finding's `expected`/`evidence` contain a bounded summary, not a verbatim dump of all contact notes; the prompt template references only the needed fields. *(SEC-3)*

---

## 8. Implementation Contract

### Target files
**Create**
- `supabase/migrations/<ts>_dia_receivable_entity_crud.sql`
- `supabase/migrations/<ts>_dia_collection_contact_entity_crud.sql`
- `supabase/migrations/<ts>_dia_entity_type_catalog_reconcile_finance.sql` (re-create catalog LAST with full union + `receivable`,`collection_contact`)
- `supabase/migrations/<ts>_collections_prioritizer_agent.sql` (output-schema registry row)
- `temporal/src/agents/collections_prioritizer.py`
- `temporal/src/activities/ops_collections.py`
- `temporal/src/workflows/ops/collections_prioritizer.py`
- `temporal/tests/test_ops_collections.py`
- `supabase/tests/collections_rls.test.mjs`

**Modify**
- `temporal/src/worker.py` (import; agent-key + cron const; reconcile fn + call; `Worker(workflows=[…], activities=[…])`)
- `temporal/src/ops_api/app.py` (`_OPS_AGENT_KEYS` += `"collections-prioritizer"`)
- `temporal/src/workflows/ops/__init__.py` (re-export workflow + input)
- `supabase/seed.sql` (agent-config block + representative finance demo entities)

> Use `<ts>` = strictly increasing `YYYYMMDDHHMMSS`, with the **catalog-reconcile-finance** migration timestamped AFTER both entity migrations and after `20260626130000`, so it is the last catalog re-creation.

### Allowed / forbidden deps
- **Allowed:** `temporalio`, `pydantic`, existing in-repo modules `..agents.openai_client` (`chat_with_tools`), `..activities.ops_revrec` (persistence delegation + `interpolate_prompt_template`), stdlib (`hashlib`, `json`, `asyncio`, `logging`).
- **Forbidden:** any `rental_*` helper import in the triad files (NFR-1); re-implementing finding storage; adding tool-calling; importing the LLM agent at workflow scope outside `workflow.unsafe.imports_passed_through()`.

### Data / migration / rollback
- No new tables. Reuses `public.finding` (`finding_tenant_fingerprint_uk`), `ops_agent_config`/`ops_agent_config_current`, `ops_workflow_run`, `ops_output_schema_registry`, `rental_current_entity_state`, `entities`/`entity_versions`.
- Entity migrations are `create or replace` + guarded `drop function if exists` (idempotent). The registry row uses `on conflict (schema_key) do update`.
- **Rollback:** drop the four new RPCs and two views; re-run `20260626130000_dia_entity_type_catalog_reconcile.sql` to restore the prior catalog; `delete from ops_output_schema_registry where schema_key='collections_finding_v1'`; revert the four source edits. (Entities/versions created by seed are namespaced `demo-dia-*` and can be deleted by `source_record_id` prefix.)

### Security-trigger check → **YES**
Triggered because this change: introduces **new finance tables/entities**, handles **customer financial PII** (balances, documents, free-text notes), **runs migrations**, and **touches the finding store**.

**STRIDE-lite:**
- **Spoofing/Auth** — writes gated by SECURITY DEFINER `dia_assert_*_writer` (service_role or admin/branch_manager; `42501` else); RLS enabled on `entities`/`entity_versions` with anon locked down (`20260607131500_lock_down_anon_read_access.sql`).
- **Tampering** — SCD2 append-only versions; finding UPSERT keyed on `(tenant_id, fingerprint)`; deterministic fields pinned from views (NFR-2).
- **Repudiation** — every finding write appends an audit event via `_append_audit_event` (reused).
- **Information disclosure** — `security_invoker` views + service-role read (SEC-2); **PII minimization** in prompts and findings (SEC-3); single-line logs avoid dumping note bodies.
- **DoS** — scope bounded (`max_findings_per_run`, max-customers cap mirroring `_MAX_SCOPED_VEHICLES`); heartbeat/timeouts (NFR-3).
- **Elevation/Action-safety** — **assist-only**: no dunning, no money-moving activity; `auto_apply` forced `False` (SEC-4, SEC-5).

### Stop gates
- STOP if `public.finding` or `ops_output_schema_registry` is missing the expected columns/constraints (schema drift) — do not invent a table.
- STOP if catalog re-creation would drop any existing type — re-list the COMPLETE union.
- STOP and surface NC-1 if asked to wire real ERP ingestion — out of scope.

---

## 9. Executable Task Layer

Conventions: `[P]` = parallelizable (different files, no incomplete dep). Each task is self-contained. SQL Verify uses the shared container; **never `supabase db reset`**.

### Phase A — Finance data foundation (unblocks Phase B)

- [ ] **T-A1 [P]** [reqs: FR-2, FR-3, SEC-1, SEC-2] [depends: —]
      Files: `supabase/migrations/<ts1>_dia_receivable_entity_crud.sql`
      Precondition / skip-if: file exists and `select to_regclass('public.v_dia_receivable_current')` is non-null AND `create_receivable` exists.
      Read first: `supabase/migrations/20260625150200_dia_part_entity_crud.sql:55-352`; `supabase/migrations/20260625130000_dia_vehicle_entity_crud.sql:298-343`.
      Action: Clone the part template for `receivable`. Include: `dia_assert_receivable_writer()` (same role guard, `42501`); `dia_validate_receivable_data(jsonb)` requiring `customer_id`,`due_date`,`balance` (else `22023`) and constraining `status ∈ ('aberto','liquidado','inativo')`; `create_/update_/delete_receivable` SECURITY DEFINER RPCs (create via `create_entity_with_version(p_entity_type=>'receivable', …)`, delete = soft-retire with `status='inativo'`, `retired=true`); `v_dia_receivable_current` `security_invoker=true` over `rental_current_entity_state where entity_type='receivable' and not retired`, surfacing `customer_id, customer_name, document_number, receivable_type, balance::numeric, due_date::date, collector_code, collector_name, status`, and `days_overdue` = `coalesce(nullif(data->>'days_overdue','')::int, greatest(now()::date - nullif(data->>'due_date','')::date, 0))`. Apply the catalog re-create header ONLY in T-A3 (this file may still include the part-style header listing the full set + `receivable` to stay self-applying, but T-A3 is authoritative). `revoke all … from public; grant execute … to authenticated, service_role`; `grant select on v_dia_receivable_current to authenticated, service_role`.
      Re-run safety: `create or replace` views/functions + `drop function if exists` before create; no data writes.
      Verify: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/<ts1>_dia_receivable_entity_crud.sql` → exits 0 (`CREATE FUNCTION`/`CREATE VIEW` lines, no `ERROR`).
      Done: `v_dia_receivable_current` exists and `create_receivable`/`update_receivable`/`delete_receivable` are callable; observable via AC-2/AC-3/AC-6 in T-A5.

- [ ] **T-A2 [P]** [reqs: FR-2, FR-3, SEC-1, SEC-2] [depends: —]
      Files: `supabase/migrations/<ts2>_dia_collection_contact_entity_crud.sql`  (`<ts2>` > `<ts1>`)
      Precondition / skip-if: `select to_regclass('public.v_dia_collection_contact_current')` is non-null AND `create_collection_contact` exists.
      Read first: `supabase/migrations/20260625150200_dia_part_entity_crud.sql:55-330`.
      Action: Clone the part template for `collection_contact`. `dia_assert_collection_contact_writer()` (role guard, `42501`); `dia_validate_collection_contact_data(jsonb)` requiring `customer_id`,`action` (else `22023`); `create_/update_/delete_collection_contact` RPCs; `v_dia_collection_contact_current` `security_invoker=true` over `rental_current_entity_state where entity_type='collection_contact' and not retired`, surfacing `customer_id, receivable_id, action, note, contact_date::date, next_contact_date::date, result`. Grants as in T-A1.
      Re-run safety: `create or replace` + guarded drops; no data writes.
      Verify: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/<ts2>_dia_collection_contact_entity_crud.sql` → exits 0.
      Done: `v_dia_collection_contact_current` + the three RPCs exist.

- [ ] **T-A3** [reqs: FR-1] [depends: T-A1, T-A2]
      Files: `supabase/migrations/<ts3>_dia_entity_type_catalog_reconcile_finance.sql`  (`<ts3>` > `<ts2>` and > `20260626130000`)
      Precondition / skip-if: `select count(*) from rental_entity_type_catalog where entity_type in ('receivable','collection_contact')` returns `2`.
      Read first: `supabase/migrations/20260626130000_dia_entity_type_catalog_reconcile.sql:16-33` (copy its COMPLETE list verbatim).
      Action: `create or replace view public.rental_entity_type_catalog with (security_invoker = true) as select entity_type from (values …<the full existing list from :20-31>…, ('receivable'), ('collection_contact')) as rental_entity_types(entity_type);` then `grant select on table public.rental_entity_type_catalog to authenticated, service_role;`. This must be the LAST catalog re-creation (latest timestamp).
      Re-run safety: pure `create or replace` of a VALUES view.
      Verify: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "create or replace view … ;" ` via the file, then `-c "select string_agg(entity_type,',' order by entity_type) from rental_entity_type_catalog;"` → output contains `collection_contact` and `receivable` AND `brand,part,part_sale,service_order,vehicle`.
      Done: AC-1 holds.

- [ ] **T-A4** [reqs: FR-10] [depends: T-A1, T-A2, T-A3]
      Files: `supabase/seed.sql` (append a representative finance demo block AFTER the Wynne purge, near the DIA domain seed ~`:368+`)
      Precondition / skip-if: `select count(*) from entities where entity_type='receivable' and source_record_id like 'demo-dia-receivable-%'` > 0.
      Read first: `supabase/seed.sql:267-366` (agent-config idempotent pattern) and `:368-379` (DIA domain seed header / SCD2 upsert usage).
      Action: For tenant scoping context and a testable run, insert ≥1 demo `customer` (if not already present) and ≥3 demo `receivable` entities for that customer with varied `due_date`/`balance` (one >90d overdue, one 31-90d, one near-due) plus ≥2 demo `collection_contact` entities with non-empty `note` free-text — all via `entities`+`entity_versions` (or the generic SCD2 upsert used by the existing DIA block), namespaced `demo-dia-receivable-*` / `demo-dia-collection-contact-*`, under `set local request.jwt.claim.role='service_role';`, idempotent (`on conflict … do update`).
      Re-run safety: idempotent upserts keyed on `source_record_id`; wrap in `begin; … commit;` like neighboring blocks.
      Verify: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "select count(*) from v_dia_receivable_current;"` returns ≥3 after seeding the block; `select count(*) from v_dia_collection_contact_current;` ≥2.
      Done: representative finance data is queryable through both scope views.

- [ ] **T-A5** [reqs: FR-2, FR-3, SEC-1] [depends: T-A1, T-A2]
      Files: `supabase/tests/collections_rls.test.mjs`
      Precondition / skip-if: file exists and `node --test supabase/tests/collections_rls.test.mjs` passes.
      Read first: `supabase/tests/part_crud.test.mjs:30-117` (psql harness, `asWriter`, `captureSqlstate`) and `:122-185,468-533` (create / validation / role-guard cases).
      Action: Clone `part_crud.test.mjs` for both new entities. Cover: AC-2 (create happy path → row in `v_dia_receivable_current`, version 1), AC-3 (missing `due_date`→`22023`; missing `action`→`22023`), AC-4 (`read_only` create → `42501`; `branch_manager` create → success), AC-5 (update SCD2 increments + soft-delete removes from view), AC-6 (`days_overdue` derivation: due_date 100d ago → `100`; future → `0`). Use `TEST-` source_record_ids inside `begin; … rollback;` (never touch seed).
      Re-run safety: transactional rollback; deterministic literals.
      Verify: `node --test supabase/tests/collections_rls.test.mjs` → all tests pass (`# pass N`, `# fail 0`).
      Done: AC-2..AC-6 pass against the live container.

### Phase B — Agent triad (clone of `vehicle_aging`)

- [ ] **T-B1 [P]** [reqs: FR-6, NFR-1] [depends: —]
      Files: `temporal/src/agents/collections_prioritizer.py`
      Precondition / skip-if: file exists and `from temporal.src.agents.collections_prioritizer import CollectionsFindingV1, run_collections_prioritizer, collections_finding_v1_schema` imports cleanly.
      Read first: `temporal/src/agents/vehicle_aging_analyst.py:21-74`.
      Action: Clone the module. Define `CollectionsFindingV1(BaseModel, ConfigDict(extra="forbid"))` with fields: `customer_id: str`; `finding_type: str = "collections_priority"`; `severity: str = "medium"`; `recommended_action: str`; `total_exposure: float = 0.0`; `days_overdue: int = 0`; `next_step_note: str = ""`; `evidence: list[str] = Field(default_factory=list)`; `confidence: float = 0.0`; `rationale: str`. Required (no default): `customer_id`, `recommended_action`, `rationale`. Add `collections_finding_v1_schema()` → `model_json_schema()`; `_no_tool_executor`; `run_collections_prioritizer(payload, *, system_prompt, user_prompt_template, max_tool_rounds=0, transport=None)` calling `chat_with_tools(messages=[system,user], tools=[], tool_executor=_no_tool_executor, response_format=CollectionsFindingV1, max_tool_rounds=…, transport=…)` returning `result.response.model_dump(mode="json")`. NO `rental_*` import.
      Re-run safety: pure module definition; no side effects on import.
      Verify: `python -c "from temporal.src.agents.collections_prioritizer import CollectionsFindingV1, run_collections_prioritizer, collections_finding_v1_schema; import json; print(collections_finding_v1_schema()['title'])"` → prints `CollectionsFindingV1`.
      Done: closed schema present; AC-8/AC-16 testable.

- [ ] **T-B2 [P]** [reqs: FR-6, FR-10] [depends: T-B1]
      Files: `supabase/migrations/<ts4>_collections_prioritizer_agent.sql`
      Precondition / skip-if: `select count(*) from ops_output_schema_registry where schema_key='collections_finding_v1'` = 1 with matching JSON.
      Read first: `supabase/migrations/20260626140001_vehicle_aging_agent.sql:7-34`.
      Action: `insert into public.ops_output_schema_registry (schema_key, schema_json, description) values ('collections_finding_v1', '{ "additionalProperties": false, "type":"object", "title":"CollectionsFindingV1", "required":["customer_id","recommended_action","rationale"], "properties": { "customer_id":{"type":"string","title":"Customer Id"}, "finding_type":{"type":"string","title":"Finding Type","default":"collections_priority"}, "severity":{"type":"string","title":"Severity","default":"medium"}, "recommended_action":{"type":"string","title":"Recommended Action"}, "total_exposure":{"type":"number","title":"Total Exposure","default":0.0}, "days_overdue":{"type":"integer","title":"Days Overdue","default":0}, "next_step_note":{"type":"string","title":"Next Step Note","default":""}, "evidence":{"type":"array","title":"Evidence","items":{"type":"string"}}, "confidence":{"type":"number","title":"Confidence","default":0.0}, "rationale":{"type":"string","title":"Rationale"} } }'::jsonb, 'Collections prioritizer finding output schema v1 (collections_priority)') on conflict (schema_key) do update set schema_json = excluded.schema_json, description = excluded.description, updated_at = now();` — keys MUST equal `collections_finding_v1_schema()` from T-B1 (verified by AC-16).
      Re-run safety: `on conflict do update`.
      Verify: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/<ts4>_collections_prioritizer_agent.sql` → exits 0; `-c "select schema_json->>'title' from ops_output_schema_registry where schema_key='collections_finding_v1';"` → `CollectionsFindingV1`.
      Done: registry row present and schema-aligned.

- [ ] **T-B3** [reqs: FR-4, FR-5, FR-7, FR-8, NFR-2, NFR-3, SEC-2, SEC-3, SEC-5] [depends: T-A1, T-A2, T-B1]
      Files: `temporal/src/activities/ops_collections.py`
      Precondition / skip-if: file exists and all `@activity.defn` symbols import cleanly.
      Read first: `temporal/src/activities/ops_vehicle_aging.py:18-281`; `temporal/src/activities/ops_revrec.py:292-304,373-404,502-539,611-684`.
      Action: Clone `ops_vehicle_aging.py`. Set `_AGENT_KEY="collections-prioritizer"`, `_FINDING_TYPE="collections_priority"`. Implement `ops_scope_collections(tenant_id, run_context)`: read `v_dia_receivable_current` (open + at/over `near_due_days` threshold per A-4) AND `v_dia_collection_contact_current` via `ops_revrec._get_ops_persistence_client().select(...)`; group by `customer_id`; compute `total_exposure` (sum open balance), `max_days_overdue`, deterministic `severity` (A-4) + customer-scoped `fingerprint` = `sha256(f"{tenant_id}:{customer_id}:collections_priority")` (helper `_collections_fingerprint`); attach that customer's open receivables + recent `collection_contact` notes inline (cap note count/length for SEC-3); order by `total_exposure` desc; cap to a max-customers bound (mirror `_MAX_SCOPED_VEHICLES`). Implement `ops_collections_assess(customer_payload, config)`: heartbeat loop + `run_collections_prioritizer`; PIN `customer_id, total_exposure, days_overdue, severity` from the scoped values (NFR-2); `setdefault` `recommended_action="monitor"`, `evidence=[]`, `confidence=0.0`, `rationale`, `next_step_note`. Add NAMED-activity wrappers delegating to `ops_revrec` exactly like `ops_vehicle_aging.py:203-269`: `ops_load_agent_config`, `ops_list_open_finding_fingerprints`, `ops_create_workflow_run`, `ops_finalize_workflow_run`, `ops_record_finding`, `ops_record_finding_disposition` — with a `_collections_finding_for_storage(finding)` that maps `contract_id = customer_id`, `line_item_id=None`, `delta = total_exposure`, `proposed_action = recommended_action`, and a BOUNDED `expected`/`evidence` summary (SEC-3). NO `rental_*` import. Single-line logs (NFR-5).
      Re-run safety: pure functions; deterministic fingerprint; reads only.
      Verify: `python -c "import temporal.src.activities.ops_collections as m, inspect; print(sorted(n for n,o in inspect.getmembers(m) if hasattr(o,'__temporal_activity_definition')))"` → lists the 8 activities incl `ops_scope_collections`, `ops_collections_assess`.
      Done: scope + assess + 6 wrappers present; AC-7 testable.

- [ ] **T-B4** [reqs: FR-7, FR-8, NFR-3, SEC-5] [depends: T-B3]
      Files: `temporal/src/workflows/ops/collections_prioritizer.py`
      Precondition / skip-if: file exists and `from temporal.src.workflows.ops.collections_prioritizer import CollectionsPrioritizerWorkflow, CollectionsPrioritizerWorkflowInput` imports.
      Read first: `temporal/src/workflows/ops/vehicle_aging.py:1-184`.
      Action: Clone the workflow. `_WORKFLOW_KEY="collections-prioritizer"`; dataclass `CollectionsPrioritizerWorkflowInput(tenant_id, run_window_start=None, run_window_end=None)`; `@workflow.defn class CollectionsPrioritizerWorkflow` with the same flow: create run → load config (force `auto_apply=False`) → `ops_scope_collections` (early return on empty) → `asyncio.gather(ops_collections_assess …)` with `start_to_close_timeout=2min`, `heartbeat_timeout=45s`, `_AI_RETRY`(max 2) → build surfaced rows (carry `customer_id, tenant_id, agent_key=_WORKFLOW_KEY, finding_type='collections_priority', severity, total_exposure, days_overdue, recommended_action, next_step_note, evidence, confidence, rationale, fingerprint`) → sort by `-total_exposure, fingerprint` → dedupe vs `ops_list_open_finding_fingerprints` → bound by `max_findings_per_run` → record → `finally:` finalize. Summary keys: `status, total_customers_scoped, processed_findings, recorded_findings, deduped_findings, remaining_findings_count, auto_apply`. Import activities under `workflow.unsafe.imports_passed_through()`.
      Re-run safety: deterministic ordering; dedupe makes re-runs idempotent.
      Verify: `python -c "from temporal.src.workflows.ops.collections_prioritizer import CollectionsPrioritizerWorkflow as W; print(hasattr(W,'__temporal_workflow_definition'))"` → `True`.
      Done: workflow class decorated + importable; AC-9..AC-14 testable.

- [ ] **T-B5** [reqs: FR-9] [depends: T-B4]
      Files: `temporal/src/workflows/ops/__init__.py`
      Precondition / skip-if: `from temporal.src.workflows.ops import CollectionsPrioritizerWorkflow, CollectionsPrioritizerWorkflowInput` succeeds.
      Read first: `temporal/src/workflows/ops/__init__.py:29-35,51-85` (revrec re-export pattern).
      Action: Add `from .collections_prioritizer import CollectionsPrioritizerWorkflow, CollectionsPrioritizerWorkflowInput` and append both names to `__all__`.
      Re-run safety: idempotent import add.
      Verify: `python -c "from temporal.src.workflows.ops import CollectionsPrioritizerWorkflow, CollectionsPrioritizerWorkflowInput; print('ok')"` → `ok`.
      Done: package re-export resolves.

- [ ] **T-B6** [reqs: FR-9] [depends: T-B3, T-B4]
      Files: `temporal/src/worker.py`
      Precondition / skip-if: `CollectionsPrioritizerWorkflow` is in `_extract_worker_workflow_references()` AND all `ops_collections` activities are in `_extract_worker_activity_references()`.
      Read first: `temporal/src/worker.py:25-46` (activity imports), `:82,102-103` (workflow import + agent-key/cron consts), `:357-423` (vehicle-aging reconcile block), `:1360-1362` (best-effort call), `:1434,1519-1526` (Worker lists).
      Action: (1) add `ops_collections` to the `from .activities import (…)` block; (2) `from .workflows.ops.collections_prioritizer import CollectionsPrioritizerWorkflow, CollectionsPrioritizerWorkflowInput`; (3) add `_COLLECTIONS_AGENT_KEY="collections-prioritizer"` + `_COLLECTIONS_DEFAULT_CRON="0 6 * * 1-5"`; (4) add a `reconcile_collections_schedules` + helpers cloned from the vehicle-aging block (`_fetch_*`, `_build_*_schedule` using `CollectionsPrioritizerWorkflow.run` / `…Input`, `id=f"ops-collections-prioritizer-{tenant_id}"`, schedule_id `ops:{tenant}:collections-prioritizer`, delete-if-disabled); (5) call it best-effort in `main()` alongside the others; (6) add `CollectionsPrioritizerWorkflow` to `Worker(workflows=[…])` and the 8 `ops_collections.<fn>` to `activities=[…]`.
      Re-run safety: additive edits; registration is set-membership.
      Verify: `python -m pytest temporal/tests/test_worker_registration.py -v` → passes (incl `test_all_registered_activities_exist`, `_workflows_exist`).
      Done: AC-15 (worker half) holds.

- [ ] **T-B7** [reqs: FR-9] [depends: —]
      Files: `temporal/src/ops_api/app.py`
      Precondition / skip-if: `"collections-prioritizer" in _OPS_AGENT_KEYS`.
      Read first: `temporal/src/ops_api/app.py:76-96` (`_OPS_AGENT_KEYS` + builders), `:2306-2314` (run-now allowlist check).
      Action: Add the string `"collections-prioritizer"` to the `_OPS_AGENT_KEYS` tuple. (No other change — the builder map and the run-now endpoint derive from it.)
      Re-run safety: idempotent tuple membership.
      Verify: `python -c "from temporal.src.ops_api.app import _OPS_AGENT_KEYS, _AGENT_SCHEDULE_ID_BUILDERS as B; print('collections-prioritizer' in _OPS_AGENT_KEYS and 'collections-prioritizer' in B)"` → `True`.
      Done: `POST /api/ops/agents/collections-prioritizer/run` resolves (no 404 on unknown key).

- [ ] **T-B8** [reqs: FR-4..FR-8, NFR-1, NFR-2, NFR-3, SEC-3, SEC-5; AC-7..AC-17] [depends: T-A* , T-B1, T-B3, T-B4, T-B6, T-B7]
      Files: `temporal/tests/test_ops_collections.py`; `supabase/seed.sql` (only if T-A4 omitted a field a test needs — otherwise no edit)
      Precondition / skip-if: `python -m pytest temporal/tests/test_ops_collections.py -v` passes.
      Read first: `temporal/tests/test_ops_vehicle_aging.py:1-712` (entire pattern: helpers, `_FakeTransport`, `_FakeSelectClient`, workflow harness, registry-agreement + hygiene tests).
      Action: Clone the test module for collections. Include: (a) deterministic-helper tests for `_collections_fingerprint` + severity buckets (A-4) + `_collections_finding_for_storage` (contract_id=customer_id, line_item_id=None, delta=total_exposure, bounded evidence — AC-17); (b) agent tests — `run_collections_prioritizer` sends `tools=[]` + returns validated finding (AC-8), extra-field rejection fails closed; (c) scope test via `_FakeSelectClient` over `v_dia_receivable_current` + `v_dia_collection_contact_current` (AC-7, ordering by exposure desc, threshold exclusion); (d) workflow tests via the `patch.object(tw_mod,"execute_activity", …)` harness: records-all (AC-9), dedupe-all (AC-10), dedupe-some, auto_apply-false (AC-11), empty-scope finalize (AC-12), bounding (AC-13), heartbeat 45s + retry 2 (AC-14); (e) registry-agreement test: `collections_finding_v1_schema()` vs the embedded JSON in `<ts4>_collections_prioritizer_agent.sql` (AC-16, mirror `test_ops_vehicle_aging.py:179-195`); (f) worker-registration + no-`rental_*`-import hygiene over the 3 new files (AC-15, mirror `:667-711`).
      Re-run safety: hermetic (fakes/patches); no DB/network.
      Verify: `python -m pytest temporal/tests/test_ops_collections.py temporal/tests/test_worker_registration.py -v` → all pass.
      Done: every Phase-B AC has a green test; PRD acceptance closed.

---

## 10. Coverage Matrix

| Requirement | Acceptance | Task(s) | Verify | Source evidence path:line |
|---|---|---|---|---|
| FR-1 catalog adds finance types | AC-1 | T-A3 | psql select catalog | `20260626130000_dia_entity_type_catalog_reconcile.sql:16-31` |
| FR-2 CRUD RPCs + role guard | AC-2, AC-3, AC-5 | T-A1, T-A2, T-A5 | node --test collections_rls | `20260625150200_dia_part_entity_crud.sql:55-283` |
| FR-3 security_invoker scope views | AC-2, AC-6 | T-A1, T-A2, T-A5 | node --test collections_rls | `20260625130000_dia_vehicle_entity_crud.sql:298-343` |
| FR-4 deterministic scope/order/severity | AC-7 | T-B3, T-B8 | pytest test_ops_collections | `ops_vehicle_aging.py:69-134` |
| FR-5 inline notes to LLM, tools=[] | AC-8 | T-B1, T-B3, T-B8 | pytest test_ops_collections | `vehicle_aging_analyst.py:47-67` |
| FR-6 closed CollectionsFindingV1 | AC-8, AC-16 | T-B1, T-B2, T-B8 | pytest (schema agreement) | `vehicle_aging_analyst.py:21-37`; `20260626140001_vehicle_aging_agent.sql:7-34` |
| FR-7 record/dedupe/bound finding | AC-9, AC-10, AC-13 | T-B3, T-B4, T-B8 | pytest test_ops_collections | `vehicle_aging.py:136-170`; `ops_revrec.py:611-684` |
| FR-8 auto_apply false + finalize all paths | AC-11, AC-12 | T-B4, T-B8 | pytest test_ops_collections | `vehicle_aging.py:75,173-183`; `ops_revrec.py:536-539` |
| FR-9 worker+__init__+run-now registration | AC-15 | T-B5, T-B6, T-B7 | pytest test_worker_registration; import check | `worker.py:357-423,1434,1519-1526`; `ops_api/app.py:76-96,2306-2314`; `workflows/ops/__init__.py:29-35` |
| FR-10 seed config + finance demo + registry | AC-1*, AC-16 | T-A4, T-B2 | psql counts; pytest | `seed.sql:267-366`; `20260626140001_vehicle_aging_agent.sql:7-34` |
| NFR-1 no rental_* import | AC-15 | T-B1, T-B3, T-B4, T-B8 | pytest hygiene test | `test_ops_vehicle_aging.py:696-711` |
| NFR-2 pin deterministic fields | AC-9, AC-13 | T-B3, T-B8 | pytest | `ops_vehicle_aging.py:188-199` |
| NFR-3 heartbeat 45s + retry 2 | AC-14 | T-B3, T-B4, T-B8 | pytest | `vehicle_aging.py:20-22,88-98` |
| NFR-4 idempotent migrations | (build-time) | T-A1..T-A3, T-B2 | psql ON_ERROR_STOP re-run | `20260625150200_…:119,163,228` (guarded drops) |
| NFR-5 single-line logs | (review) | T-B3, T-B6 | code review | CLAUDE.md Logging |
| SEC-1 RLS blocks direct writes | AC-4 | T-A1, T-A2, T-A5 | node --test (42501) | `20260625150200_…:55-86`; `part_crud.test.mjs:468-511` |
| SEC-2 security_invoker + service-role read | AC-2, AC-7 | T-A1, T-A2, T-B3 | node --test; pytest | `20260625130000_…:300,338`; `ops_revrec.py:292-300` |
| SEC-3 PII minimization | AC-17 | T-B3, T-B8 | pytest (bounded evidence) | `ops_revrec.py:373-404` (finding shape) |
| SEC-4 assist-only (no dunning/money) | (non-goal/review) | T-B3, T-B4 | code review (no money activity) | `vehicle_aging.py` (no apply activity) |
| SEC-5 auto_apply forced false | AC-11 | T-B3, T-B4, T-B8 | pytest | `ops_revrec.py:536-539`; `vehicle_aging.py:75` |

\* AC-1 is the catalog half of FR-10's data foundation; the seed/registry halves are covered by T-A4/T-B2 verifies and AC-16.

---

## 11. Self-Verification Report

| Check | Result |
|---|---|
| No placeholders / TBD / "similar to" in tasks | PASS — every task has concrete Files/Action/Verify/Done. |
| Every FR/NFR/SEC maps to ≥1 task AND ≥1 acceptance | PASS — see §10 (all rows populated). |
| Every acceptance maps to ≥1 task | PASS — AC-1..AC-17 appear in §9/§10. |
| Every task has Files / Action / Verify / Done | PASS — 13/13. |
| Every task has Precondition/skip-if + Re-run safety (resumable) | PASS. |
| Every code fact carries path:line | PASS — §2 ledger + inline citations. |
| Cite-don't-inline (no large files pasted) | PASS — only the small registry JSON literal (load-bearing for AC-16) is inlined. |
| Code-wins conflicts recorded (drift vs intended) | PASS — §2 conflicts table. |
| Security-trigger check done + STRIDE-lite | PASS — §8 → YES. |
| Size/split gate | Acknowledged: 13 tasks > the 8-task soft cap, but the user explicitly mandates ONE PRD per agent and Phase A is the unblocking data foundation for Phase B (single coherent deliverable). Organized into Phase A (5) / Phase B (8); each task is independently verifiable. |
| Verify commands are real + runnable in this repo | PASS — `python -m pytest …`, `node --test …`, `docker exec … psql … -f`, `python -c` import checks. |
| Coverage matrix closes (no orphan req/task) | PASS. |

**Verdict: EXECUTABLE.**
