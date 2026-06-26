# Agent-Executable PRD: Service Estimate Authorization Rescue Agent (DIA ops)

## 0. Execution Header
- **Input source:** Research REPORT embedded in the issue brief "Service Estimate Authorization Rescue Agent" (clone of the `vehicle_aging` ops triad; verified against live code in §2). No standalone REPORT.md file in-repo.
- **Repo root:** `/mnt/c/Dev/AIAccelerator/dealernet-agents` · **Primary stack:** Python 3.14 + Temporal (`temporal/`); Supabase/Postgres SQL migrations (`supabase/`); pytest + `node --test` contract tests. Lint/build/test: `cd frontend-portal && npm run lint && npm run build && npm test` (frontend — untouched here), `python -m pytest temporal/tests/ -v`, `node --test --test-concurrency=1 supabase/tests/*.test.mjs`.
- **Runtime targets:** Claude Code / Codex (executed via `/ship-issue`).
- **Size tier:** large (Phase A data-ETL + Phase B agent triad → 11 tasks; kept ONE PRD per the "one issue per agent" rule, split into Phase A / Phase B). · **Date:** 2026-06-25 · **Status:** executable.

---

## 1. Input Extraction Ledger
- **Goals / decisions extracted:** Build a proactive DIA ops agent for the **service manager** that scopes workshop service estimates (orçamentos de OS) which are **PENDING authorization** or were **DECLINED**, has an LLM rank each by recoverable revenue and recommend a contact/recovery strategy, and records ranked **assist-only** findings (recommend a next contact; a human acts). Clone of the `vehicle_aging` triad (workflow + activities + agent module + output-schema registry + seed + run-now wiring + tests).
- **Key precondition (the differentiator vs the Parts agent):** the DIA `service_order` mirror view `v_dia_service_order_current` is **HEADER-ONLY** and does NOT expose estimate/orçamento-line authorization status. So Phase A is a small data-ETL extension that surfaces estimate status (pending/authorized/declined + line value + lost-sale reason) on the `service_order` entity mirror via a new `v_dia_service_estimate_current` view, following the SAME entity-CRUD + `security_invoker`-view + RLS pattern as the existing slices. Phase B is the agent triad.
- **Implied users / domain nouns:** service manager (consumer of findings via `FindingsQueue.tsx` → `ops_findings_view`); estimate / orçamento de OS; OS (ordem de serviço / service order); StatusDesconto=AguardandoAutorizacao; orçamento status Pendente/Autorizada/Cancelada; VendaPerdida (lost sale) value/qty/motive; SMS link recovery (informs vocabulary only).
- **Risks / open questions carried from input:** assist-only (NEVER sends SMS, never moves money, never authorizes); extend existing `service_order` payload vs introduce a separate `service_estimate` entity (see NC-001); `rental_entity_type_catalog` is a hard-coded VALUES view — must re-create with the FULL existing list (CLAUDE.md gotcha); shared DB — never `supabase db reset`.
- **Citations/sources in the input (grounding seeds):** `temporal/src/workflows/ops/vehicle_aging.py`, `temporal/src/activities/ops_vehicle_aging.py`, `temporal/src/agents/vehicle_aging_analyst.py`, `temporal/src/agents/tools/dia_bi.py`, `supabase/migrations/20260625160000_dia_service_order_entity_crud.sql`, `supabase/migrations/20260625150200_dia_part_entity_crud.sql`, `supabase/migrations/20260626140001_vehicle_aging_agent.sql`, `temporal/src/worker.py`, `temporal/src/ops_api/app.py`, `temporal/tests/test_ops_vehicle_aging.py`, `temporal/src/activities/ops_revrec.py`, `supabase/migrations/20260607170000_ops_factory_persistence.sql`. ERP provenance (external ERP KB, not in this repo): `Procedures/PRC_OficinaAguardandoAutorizacao.md`, `Procedures/PRC_OficinaOrcamentoStatus.md`, `Procedures/PRC_Oficina_GeraVendaPerdida.md`, `Procedures/PRC_EnviarSMSLinkOrcamento.md`.

---

## 2. Source Grounding Ledger

### Files read (with why)
- `temporal/src/workflows/ops/vehicle_aging.py:34-184` — the workflow shape to clone: `@dataclass …WorkflowInput(tenant_id, run_window_start?, run_window_end?)`; `@workflow.defn` class; `run()` = `ops_create_workflow_run` → `ops_load_agent_config` (forces `summary["auto_apply"]=False`, L75) → scope view (early `return {"run_id", **summary}` on empty, L85-86) → `asyncio.gather` of per-item assess activities → build surfaced dict → sort → `ops_list_open_finding_fingerprints` dedupe → bound by `config.bounds.max_findings_per_run` (default 50) → loop `ops_record_finding` → `return {"run_id", **summary}`; `finally:` calls `ops_finalize_workflow_run` if `run_id`. RetryPolicy constants L17-22; `_AI_HEARTBEAT_TIMEOUT=45s` L22; `_WORKFLOW_KEY` L24.
- `temporal/src/activities/ops_vehicle_aging.py:1-282` — the activities module to clone: deterministic scope reading a `v_dia_*_current` view via `ops_revrec._get_ops_persistence_client()` (L79); severity/bucket + SHA-256 fingerprint computed deterministically (L45-66); `ops_*_assess` async activity with a 15 s heartbeat loop (L166-177) calling the agent module; **NAMED**-activity wrappers delegating to `ops_revrec` with `@activity.defn(name="ops_<agent>_<verb>")` (L203-221, L255-269); `_<agent>_finding_for_storage` shaping the canonical finding row — `contract_id`=anchor entity_id, `line_item_id`=None, `delta`=recoverable value, `proposed_action`=recommended_action, `expected`=facts, `billed`={} (L223-252); `__all__` (L272-281).
- `temporal/src/agents/vehicle_aging_analyst.py:1-75` — the agent module to clone: closed Pydantic `…FindingV1(BaseModel)` with `model_config = ConfigDict(extra="forbid")` (L21-33); `…_finding_v1_schema()` returning `model_json_schema()` (L36-37); `_no_tool_executor` (L40-44); `run_…_analyst(payload, *, system_prompt, user_prompt_template, max_tool_rounds=0, transport=None)` calling `chat_with_tools(messages=[system,user], tools=[], tool_executor=_no_tool_executor, response_format=<Model>, max_tool_rounds, transport)` and returning `result.response.model_dump(mode="json")` (L47-67). **NO tools; evidence inline.**
- `temporal/src/agents/openai_client.py:162` — `async def chat_with_tools(...)` is the transport entrypoint (signature confirmed; called exactly as in revrec/vehicle_aging — do not change it).
- `temporal/src/agents/tools/dia_bi.py:32-63` — read-only Supabase client pattern: `PostgrestReadClient` over `settings.supabase_url` + `settings.supabase_service_role_key`; `_read()` does `client.select(view, columns="*", filters=…, order_by=…, limit=…)`. The DIA `v_dia_*` views are read with the **service role**; `tenant_id` is plumbed for context but does not filter these aggregate views today (L7-12). (Confirms the scope activity reads its view with the service-role persistence client, same as `ops_vehicle_aging`.)
- `supabase/migrations/20260625160000_dia_service_order_entity_crud.sql:23-340` — the `service_order` entity + view to extend. Catalog re-created with FULL list incl `('vehicle'),('service_order')` (L23-40). Hardened writer guard `dia_assert_service_order_writer()` (service_role OR authenticated+admin/branch_manager; else `42501`) L50-81. `dia_validate_service_order_data` (status enum aberta/em_andamento/concluida/cancelada; customer+description required) L84-108. `create/update/delete_service_order` RPCs (SECURITY DEFINER, write via `create_entity_with_version` / append `entity_versions`) L114-293. **HEADER-ONLY** read view `v_dia_service_order_current` (`security_invoker=true`) exposing order_number, customer, vehicle, description, status, opened_at, closed_at, revenue, technician, turnaround_hours — and NOTHING about estimate lines (L302-339). This is the precise gap Phase A fills.
- `supabase/migrations/20260625150200_dia_part_entity_crud.sql:28-351` — the cleanest entity-mirror template: catalog re-create with FULL list (L28-45); writer guard + validate + create/update/delete RPCs; **`security_invoker` read view** `v_dia_part_current` deriving fields with `rces.data ->> '…'` from `rental_current_entity_state` filtered `entity_type='part'` and `coalesce((data->>'retired')::boolean,false)=false` (L292-330); a **secondary** criticality view `v_dia_parts_critical` ordered by a `criticality_rank` CASE (L337-351). Phase B's scope view mirrors this secondary-view idea (a `v_dia_service_estimate_current` that surfaces and ranks recoverable estimates).
- `supabase/migrations/20260626140001_vehicle_aging_agent.sql:7-34` — the output-schema-registry seed pattern: a single `insert into public.ops_output_schema_registry (schema_key, schema_json, description) values (…) on conflict (schema_key) do update set schema_json=…, description=…, updated_at=now();` whose `schema_json` is the exact JSON Schema of the Pydantic model (additionalProperties false, type object, title, required, properties).
- `supabase/migrations/20260607170000_ops_factory_persistence.sql:39-67,300-365` — the `finding` table: `(tenant_id, fingerprint)` unique (L63), status check incl `pending_approval`/`approved`/`rejected`/`informational` (L61), confidence in [0,1] (L62), columns `contract_id uuid`, `line_item_id uuid`, `expected/billed/evidence jsonb`, `delta numeric`, `proposed_action`, `rationale`, `severity`. Surfacing view `ops_findings_view` (`security_invoker`) joins `finding` to current entities for contract/line/customer labels (L300-365). NOTE: those joins are keyed to `entity_type='rental_contract'`/`'rental_contract_line'`/`'customer'`, so a service-estimate finding's `contract_id`/`line_item_id` will simply not resolve a label — that is acceptable (vehicle_aging has the same property; the finding's own `expected`/`evidence`/`rationale`/`delta`/`severity` columns carry the payload).
- `temporal/src/activities/ops_revrec.py:288-304,461-540,611-685` — shared persistence: `_get_ops_persistence_client()` / `get_ops_persistence_client()` (service-role PostgREST) L288-304; `interpolate_prompt_template(template, variables)` (supports `{var}` and `{{var}}`, raises on missing) L315-331; `ops_load_agent_config` raises `AgentConfigNotFoundError` when no config row, `AgentConfigError` when disabled, normalizes tools/model/bounds/thresholds/schedule, attaches resolved `output_schema`, and **forces `auto_apply=False`** L502-539; `ops_list_open_finding_fingerprints` (status `pending_approval`) L611-619; `ops_create_workflow_run` L622-636; `ops_finalize_workflow_run` L639-651; `ops_record_finding` upserts on `tenant_id,fingerprint` with status `pending_approval` (L654-684).
- `temporal/src/worker.py:43-44,82,102-104,357-423,1358-1362,1434,1519-1526` — registration + cron: activities module imported in the big `from .activities import (…)` block (L25-46), workflow imported (L82), agent-key constant + default cron (L102-104), `_fetch_*_schedule_rows`/`_build_*_schedule`/`_reconcile_tenant_*_schedule`/`reconcile_*_schedules` (L357-423 for vehicle-aging — copy verbatim), best-effort reconcile call in `main()` (L1359-1362), workflow added to `Worker(workflows=[…])` (L1434), every activity added to `Worker(activities=[…])` (L1519-1526). `_schedule_id_for_tenant(tenant_id, agent_key)` → `ops:{tenant}:{agent_key}` (L110-111).
- `temporal/src/ops_api/app.py:76-96,716-725,2306-2335` — run-now: `_OPS_AGENT_KEYS` tuple (L76-88) feeds `_AGENT_SCHEDULE_ID_BUILDERS` (L90-96); `TemporalSignalClient.run_agent_now` triggers schedule `ops:{tenant}:{agent_key}` with `ScheduleOverlapPolicy.SKIP`, raising `AgentScheduleNotProvisioned` on NOT_FOUND (L716-725); endpoint `POST /api/ops/agents/{agent_key}/run` rejects unknown keys with 404 and not-provisioned with 409 (L2306-2335). Adding the agent_key to `_OPS_AGENT_KEYS` is the only edit needed to expose run-now.
- `temporal/src/workflows/ops/__init__.py:1-86` — package exports; new workflow + input must be importable here for `worker.py`'s `from .workflows.ops.<mod> import …` (vehicle_aging is imported directly from its submodule at worker.py:82, NOT via `ops/__init__.py`; this PRD follows the same direct-import path and additionally exports from `__init__.py` for parity per the user's target-file list).
- `temporal/tests/test_ops_vehicle_aging.py:28-712` — the test template to clone: deterministic-helper unit tests (severity/fingerprint/finding-row) L63-155; pydantic schema tests incl a **schema-vs-migration parity** test that regex-extracts the `'{…}'::jsonb` literal from the agent migration and asserts `title`/`additionalProperties`/`required`/`properties` match the Python model L179-195; a `_FakeTransport` recording `tools_seen` (asserts `[[]]` — no tools) L198-260; a `_FakeSelectClient` for scope tests L289-311; a `_build_harness` patching `temporalio.workflow.execute_activity` to drive the workflow L439-477; workflow tests for record-all / dedupe-all / dedupe-some / auto_apply-false / bounding / empty-scope / heartbeat+retry L500-659; **worker-registration test** asserting the workflow + every `@activity.defn` is wired into `worker.py` L667-693; an **import-hygiene test** asserting new source files do not import `rental_*` (note `_NEW_SOURCE_FILES` includes `temporal/scripts/run_vehicle_aging.py`) L48-53, L696-711.
- `temporal/tests/test_worker_registration.py:72-143` — `_resolve_activity_module_alias` has a **hard-coded `alias_map`** (L75-101); `test_*_activities_registered_in_worker` style tests assert every aliased module path **resolves and the function exists** (L122-143). A new activity module alias `ops_service_estimate` MUST be added to this `alias_map`, or registration tests fail with "unknown module alias".
- `supabase/seed.sql:269-366` — the `vehicle-aging-analyst` seed block to clone: seeds the agent in BOTH the entity store (`entity_type='agent_config'`, read by `ops_agent_config_current`) AND the base `ops_agent_config` table (parity), for tenant keys `demo-ops-a`/`demo-ops-b`, `enabled=true` but `schedule.enabled=false` (recurring run off by default). Idempotent via DELETE-then-INSERT + ON CONFLICT. Also L63: a guard `DELETE FROM ops_output_schema_registry WHERE schema_key <> 'vehicle_aging_finding_v1';` — Phase B must add the new `schema_key` to this allow-set so the seed reset does not delete the new registry row (see T-B5).
- `temporal/scripts/run_vehicle_aging.py:1-40` — manual-trigger CLI convention (`python -m temporal.scripts.run_…  --tenant-key demo-ops-a`): resolves tenant via `ops_revrec.get_ops_persistence_client()`, starts the workflow, prints a compact summary. Referenced by the import-hygiene test's `_NEW_SOURCE_FILES`.

### Stack facts
- Language/runtime: Python 3.14; Temporal Python SDK (`temporalio`); Pydantic v2 (`ConfigDict(extra="forbid")`). Postgres via Supabase; PostgREST service-role HTTP client (no ORM). Frontend untouched.
- Test runner: `pytest` (`temporal/tests/`), `node --test` (`supabase/tests/*.test.mjs`).
- SQL validation (shared DB, **never `supabase db reset`**): `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f <migration>`.

### Existing patterns to follow
- Entity-mirror migration: `…dia_part_entity_crud.sql:28-330` (catalog re-create with FULL list; `security_invoker` derived view).
- Output-schema registry: `…vehicle_aging_agent.sql:7-34` (single upsert; schema literal == Pydantic JSON Schema).
- Workflow/activities/agent triad: the three `vehicle_aging` files above (scope → no-op → gather assess → dedupe → bound → record → finalize-in-finally; closed `*V1(extra="forbid")`; NAMED activity wrappers delegating to `ops_revrec`).
- Worker wiring: `worker.py` vehicle-aging blocks (import module + workflow; agent-key const + cron; reconcile fns; reconcile call in `main()`; add to `workflows=[…]` and `activities=[…]`).
- Tests: `test_ops_vehicle_aging.py` (mirror every section, including schema-vs-migration parity, no-tools assertion, dedupe/bounding/auto_apply-false, registration, import-hygiene).

### Integration points
- Scope source view: NEW `public.v_dia_service_estimate_current` (Phase A), read by the scope activity through `ops_revrec._get_ops_persistence_client().select(...)`.
- Finding store: `public.finding` (upsert on `tenant_id,fingerprint`) via `ops_revrec.ops_record_finding`; surfaced through `ops_findings_view` → `frontend-portal/.../FindingsQueue.tsx` (no frontend change in scope).
- Agent config: `ops_agent_config` / `ops_agent_config_current` (seed) + `ops_output_schema_registry` (migration).
- Run-now: `ops_api/app.py` `_OPS_AGENT_KEYS`; cron reconcile in `worker.py`.

### Input-vs-code conflicts
| Input claim | Code reality (path:line) | Resolution |
|---|---|---|
| "`v_dia_service_order_current` could expose estimate authorization status" | `…dia_service_order_entity_crud.sql:302-339` view is HEADER-ONLY (no estimate/line columns) | **intended change** — Phase A adds a NEW `v_dia_service_estimate_current` view + extends the `service_order` payload contract; the header view is left untouched. |
| "register the agent_key for run-now in `_OPS_AGENT_KEYS`" | `ops_api/app.py:76-88` is the live tuple | confirmed — append the new key (T-B6). |
| "new activity module just needs registering in `worker.py`" | `test_worker_registration.py:75-101` ALSO needs the module alias in a hard-coded `alias_map` | **drift in the input's mental model** — code wins; T-B7 updates the `alias_map` too. |
| "seed reset is harmless to the new registry row" | `seed.sql:63` deletes every `ops_output_schema_registry` row whose `schema_key <> 'vehicle_aging_finding_v1'` | **drift** — code wins; T-B5 widens that guard to keep the new `schema_key`. |

### Unknowns
- The exact ERP→DIA mirror field names for estimate lines (the ETL that writes `service_order.data.estimates[]` is out of scope; this PRD only **reads/derives** from the entity payload — see A-002/A-003 and NC-002).
- Whether a separate `service_estimate` entity would be cleaner than extending `service_order` (NC-001).

---

## 3. Outcome Contract
- **Goal (1 sentence):** Ship a DIA ops agent (Phase A data-ETL view + Phase B Temporal triad) that scopes pending/declined service estimates from the `service_order` mirror, has an LLM rank each by recoverable revenue and recommend a contact/recovery action, and records ranked assist-only `pending_approval` findings a service manager acts on — never sending SMS, authorizing, or moving money.
- **Phase note:** **Phase A is the data precondition** (the `service_order` mirror is header-only today, so estimate status must be surfaced first); Phase B (the agent triad) depends on Phase A's `v_dia_service_estimate_current` view existing.
- **Non-goals (explicit):** NOT a static aging queue; NOT the live bay-sequencing queue (`shop_queue`/`technician_queue` are distinct rental-leftover flows — do not touch). Does NOT send SMS / WhatsApp / email; does NOT authorize, re-price, discount, cancel, or generate VendaPerdida; does NOT auto-apply (`auto_apply` forced False); does NOT build the ERP→DIA estimate-ingestion ETL (consumes the entity payload as-is); does NOT modify the frontend, `v_dia_service_order_current`, or the `service_order` write RPCs.
- **Observable truths (goal-backward):**
  1. Applying the two new migrations against the shared container succeeds with `ON_ERROR_STOP=1`; `select * from public.v_dia_service_estimate_current limit 1;` and `select * from public.ops_output_schema_registry where schema_key='service_estimate_finding_v1';` both run without error.
  2. `python -m pytest temporal/tests/test_ops_service_estimate.py -v` passes.
  3. `python -m pytest temporal/tests/test_worker_registration.py -v` passes (new workflow + activities + module alias all resolve).
  4. `python -c "from temporal.src.workflows.ops.service_estimate_rescue import ServiceEstimateRescueWorkflow"` and the agent/activities imports succeed.
  5. A run over pending/declined estimates records `pending_approval` findings of `finding_type='estimate_rescue'`, deduped on re-run (recorded=0/deduped=N), with `auto_apply=False` always; empty scope finalizes the run with `total_estimates_scoped=0` and records nothing.
- **Success metrics:** all Verify commands in §9 PASS; `_NEW_SOURCE_FILES` import-hygiene test green (no `rental_*` imports in new Python files); schema-vs-migration parity test green; zero edits to forbidden files (§8).

---

## 4. Clarifications & Assumptions
- **Asked & answered:** none blocking — defaults below chosen to keep the agent shippable autonomously.
- **[ASSUMPTION A-001]** We **extend the existing `service_order` entity payload** (add an `estimates` array + per-line authorization status into `entity_versions.data`) and surface it via a new `v_dia_service_estimate_current` view, rather than introducing a separate `service_estimate` entity type. Rationale: an estimate belongs to exactly one OS and the `service_order` mirror already exists; this avoids a new entity_type + catalog churn + new write RPCs. Alternative captured in NC-001.
- **[ASSUMPTION A-002]** The estimate lines live under `service_order.data -> 'estimates'` as a JSONB array of objects with keys: `estimate_id` (string, stable per orçamento), `status` (`pending`|`authorized`|`declined` — mapped from ERP AguardandoAutorizacao/Pendente→`pending`, Autorizada→`authorized`, Cancelada/VendaPerdida→`declined`), `line_value` (numeric, recoverable revenue), `lost_sale_reason` (string|null, ERP VendaPerdida motive), and optional `description`/`opened_at`. The view derives one row per in-scope estimate. Rationale: matches the generic `data->>` derivation used by `v_dia_part_current`/`v_dia_service_order_current`; keeps the ERP ingestion contract minimal. The view + scope are written defensively (missing/empty `estimates` ⇒ zero rows, never an error). The seed (T-B5) plants demo `estimates[]` so the slice is exercisable end-to-end.
- **[ASSUMPTION A-003]** "Recoverable revenue" = the estimate's `line_value`; total estimate value for an OS is the sum across its in-scope lines. `delta` on the finding = the single estimate line's recoverable `line_value`. Rationale: mirrors vehicle_aging's `delta = estimated_exposure` (a deterministic, view-derived money figure, never model output).
- **[ASSUMPTION A-004]** Scope = estimates whose `status` is `pending` OR `declined`, excluding the parent OS being `cancelada` (the header view already filters cancelled OS; the scope activity additionally skips `status='cancelada'` OS payloads). `authorized` lines are out of scope. Severity: `declined`→`high`, `pending`→`medium`, with an override to `high` when `line_value` ≥ a configurable `high_value_threshold` (default from `config.thresholds.high_value_threshold`, fallback 5000). Rationale: declined = a confirmed lost sale to recover; high-value pending is the manager's priority.
- **[ASSUMPTION A-005]** Fingerprint = `sha256(f"{tenant_id}:{estimate_id}:estimate_rescue")` (estimate-scoped, deterministic), mirroring `_stock_aging_fingerprint`. Finding anchor `contract_id` = the **OS entity_id** (a uuid, satisfies the `finding.contract_id uuid` column); `line_item_id`=None; the `estimate_id` is carried in `expected`/the surfaced dict (estimate_id is not necessarily a uuid).
- **[ASSUMPTION A-006]** Agent key = `service-estimate-rescue`; workflow key constant = `service-estimate-rescue`; output schema key = `service_estimate_finding_v1`; finding_type = `estimate_rescue`; default cron `0 7 * * 1-5` with `schedule.enabled=false` (off by default, like vehicle_aging). Rationale: kebab-case agent keys are the house convention (`vehicle-aging-analyst`, `shop-morning-queue`).
- **[NEEDS CLARIFICATION NC-001]** Extend `service_order` payload (A-001) vs introduce a dedicated `service_estimate` entity type (new catalog row + create/update/delete RPCs + own `v_dia_service_estimate_current` sourced from `entity_type='service_estimate'`)? Impact if wrong: a separate entity is cleaner long-term (estimates get their own SCD2 history and write path) but is ~2–3× the Phase-A surface. Default proceeds with A-001; flip to a separate entity only if product wants estimate-level write/audit independent of the OS.
- **[NEEDS CLARIFICATION NC-002]** Who/what populates `service_order.data.estimates[]` from the ERP (AguardandoAutorizacao / Pendente / VendaPerdida)? Impact if wrong: in production the view is empty until that ingestion exists. Default: out of scope here; the seed plants demo data so the agent is verifiable now.

---

## 6. Requirements

**Phase A — data ETL (view) precondition**
- **FR-A1** — The system SHALL define a `security_invoker=true` view `public.v_dia_service_estimate_current` that, from `rental_current_entity_state` rows with `entity_type='service_order'` and the OS not cancelled, expands `data->'estimates'` to one row per estimate exposing: `os_id` (entity_id), `order_number`, `customer`, `vehicle`, `technician`, `estimate_id`, `estimate_status` (pending/authorized/declined), `line_value numeric`, `lost_sale_reason`, plus a derived `severity_seed` and `recovery_rank`.  [Realizes: A-001/A-002]
- **FR-A2** — `v_dia_service_estimate_current` SHALL surface ONLY estimates with `estimate_status in ('pending','declined')` and SHALL exclude rows from OS payloads with `status='cancelada'`, ordered by `recovery_rank` (declined-before-pending, then `line_value` desc), and SHALL return zero rows (never error) when `data->'estimates'` is absent/empty/non-array.  [Realizes: A-004]
- **NFR-A1** — The migration SHALL `grant select on table public.v_dia_service_estimate_current to authenticated, service_role` and SHALL NOT drop or alter `v_dia_service_order_current`, the `service_order` write RPCs, or the `rental_entity_type_catalog` type list (no catalog change is needed since no new entity_type is introduced under A-001).  [Realizes: Non-goals]

**Phase B — agent triad**
- **FR-B1** — The system SHALL register an output-schema-registry row `service_estimate_finding_v1` whose `schema_json` equals `ServiceEstimateFindingV1.model_json_schema()` (additionalProperties false; required = `estimate_id`, `recommended_action`, `rationale`).  [Realizes: §3.1]
- **FR-B2** — The agent module SHALL define `ServiceEstimateFindingV1` (`ConfigDict(extra="forbid")`) with fields `estimate_id`, `os_id`, `finding_type` (default `estimate_rescue`), `severity` (default `medium`), `recommended_action` (one of `contact_customer`|`offer_discount`|`reprice`|`escalate`|`monitor`), `recoverable_value` (default 0.0), `evidence` (list[str]), `confidence` (default 0.0), `rationale`; required = `estimate_id`, `recommended_action`, `rationale`; and `run_service_estimate_rescue(...)` SHALL call `chat_with_tools` with `tools=[]` (no tool_choice sent) and `response_format=ServiceEstimateFindingV1`.  [Realizes: §3.2/§3.4]
- **FR-B3** — `ops_scope_service_estimates(tenant_id, run_context)` SHALL read `v_dia_service_estimate_current` via the service-role persistence client, compute `severity` (A-004), `recoverable_value` (=`line_value`), and the fingerprint (A-005) deterministically, sort by (recovery_rank, line_value desc), and bound the result by `run_context.max_estimates` (clamped 1..500, default 200).  [Realizes: A-003/A-004/A-005]
- **FR-B4** — `ServiceEstimateRescueWorkflow.run(input)` SHALL: create a run; load config (auto_apply forced False); early-return on empty scope; assess each estimate concurrently via the LLM activity (45 s heartbeat timeout, retry cap 2); dedupe against open `pending_approval` fingerprints; bound by `config.bounds.max_findings_per_run` (default 50); record each as `pending_approval` via `ops_record_finding`; and finalize the run in a `finally` block. The returned summary SHALL include `status`, `total_estimates_scoped`, `processed_findings`, `recorded_findings`, `deduped_findings`, `remaining_findings_count`, `auto_apply` (always False), `run_id`.  [Realizes: §3.5]
- **FR-B5** — The named activity wrappers (`ops_load_agent_config`, `ops_list_open_finding_fingerprints`, `ops_create_workflow_run`, `ops_finalize_workflow_run`, `ops_record_finding`, `ops_record_finding_disposition`) SHALL delegate to `ops_revrec`, with `ops_record_finding` shaping the canonical finding row via `_service_estimate_finding_for_storage` (`contract_id`=os_id, `line_item_id`=None, `delta`=recoverable_value, `proposed_action`=recommended_action, `expected`=estimate facts incl `estimate_id`, `billed`={}).  [Realizes: §3.5]
- **FR-B6** — `worker.py` SHALL import and register `ServiceEstimateRescueWorkflow` and every `ops_service_estimate` activity, define the agent-key constant + default cron + `_fetch/_build/_reconcile/reconcile_*` schedule functions, and call the reconcile (best-effort) in `main()`. `ops_api/app.py` `_OPS_AGENT_KEYS` SHALL include `service-estimate-rescue` so run-now works.  [Realizes: §3.3]
- **FR-B7** — `supabase/seed.sql` SHALL seed `service-estimate-rescue` config for `demo-ops-a`/`demo-ops-b` in both the entity store and `ops_agent_config` (enabled=true, `schedule.enabled=false`), plant demo `estimates[]` on at least one seeded `service_order` per tenant so `v_dia_service_estimate_current` is non-empty, and the registry-reset guard SHALL preserve `service_estimate_finding_v1`.  [Realizes: §3.1/§3.5]
- **NFR-B1** — New Python source files SHALL NOT import any `rental_*` module (enforced by the import-hygiene test).  [Realizes: §3 success metrics]
- **SEC-B1** — The agent SHALL be assist-only: it SHALL NOT send SMS/notifications, authorize/reprice/discount/cancel estimates, generate VendaPerdida, draft invoices, or move money; it records findings only and forces `auto_apply=False`.  [Realizes: Non-goals; see §8]
- **SEC-B2** — All DB reads/writes SHALL go through the service-role PostgREST client (`ops_revrec._get_ops_persistence_client`); the new view SHALL be `security_invoker` so caller RLS applies; finding writes SHALL go through `ops_record_finding` (RLS keeps direct authenticated writes scoped). Customer PII (name/phone/vehicle) SHALL be minimized — only fields needed for the manager's contact decision are surfaced; no PII is logged in plaintext beyond existing finding columns.  [Realizes: §8]

---

## 7. Acceptance Criteria

- **AC-A1 (FR-A1/FR-A2):**
  - Given the shared container with the `service_order` slice applied and at least one `service_order` whose `data.estimates` contains a `pending` line (value 1200), a `declined` line (value 8000, lost_sale_reason set), and an `authorized` line.
  - When the Phase-A migration is applied and `select estimate_id, estimate_status, line_value, recovery_rank from public.v_dia_service_estimate_current order by recovery_rank;` is run.
  - Then exactly the `pending` and `declined` lines appear (the `authorized` line is absent), the `declined` line sorts before the `pending` line, and `line_value` is numeric.
  - And for a `service_order` with no `estimates` key the view yields zero rows and raises no error.
- **AC-A2 (NFR-A1):**
  - Given the Phase-A migration.
  - When applied via `docker exec … psql … -v ON_ERROR_STOP=1 -f <migration>`.
  - Then it completes successfully and `\d+ public.v_dia_service_order_current` is unchanged (the header view and write RPCs are not redefined by this migration).
- **AC-B1 (FR-B1, schema parity):**
  - Given `ServiceEstimateFindingV1` and the agent migration.
  - When `test_finding_v1_schema_matches_db_registry_contract`-style test runs.
  - Then the migration's embedded `'{…}'::jsonb` literal has `title='ServiceEstimateFindingV1'`, `additionalProperties=false`, `required` sorted == `['estimate_id','rationale','recommended_action']`, and the same `properties` keys as the Python model.
- **AC-B2 (FR-B2, no tools + extra=forbid):**
  - Given a `_FakeTransport` returning a valid finding JSON.
  - When `run_service_estimate_rescue({...}, system_prompt=…, user_prompt_template=…, transport=fake)` runs.
  - Then `transport.tools_seen == [[]]` and the result is the validated finding dict; and a response with an unknown extra key raises after the bounded retry (`StructuredOutputRetriesExceededError`).
- **AC-B3 (FR-B3, scope):**
  - Given a faked `v_dia_service_estimate_current` with declined+pending+high-value rows and one row from a `cancelada` OS.
  - When `ops_scope_service_estimates(tenant, {})` runs.
  - Then only the non-cancelled pending/declined estimates are returned, ordered declined-then-value-desc; severity is `high` for declined and for pending with `line_value≥high_value_threshold`, else `medium`; each row carries `fingerprint == sha256(f"{tenant}:{estimate_id}:estimate_rescue")`, `finding_type='estimate_rescue'`, and `recoverable_value==line_value`; and `max_estimates` bounds the count.
- **AC-B4 (FR-B4, workflow happy path + no-op):**
  - Given a stubbed activity layer (à la `_build_harness`) with three scoped estimates and no open fingerprints.
  - When the workflow runs.
  - Then `recorded_findings==3`, `deduped_findings==0`, `auto_apply is False`, recorded in (recovery_rank, value desc) order with `finding_type='estimate_rescue'`; and with empty scope it returns `total_estimates_scoped==0`, records nothing, and still finalizes the run with the workflow key.
- **AC-B5 (FR-B4, dedupe + bounding):**
  - Given all three scoped fingerprints already open → `recorded==0, deduped==3`; given only one open → `recorded==2, deduped==1`; given `max_findings_per_run=1` → `processed==1, remaining==2`, recording the top-ranked estimate.
- **AC-B6 (FR-B5, finding row shaping):**
  - Given a surfaced estimate finding.
  - When `_service_estimate_finding_for_storage(finding)` runs.
  - Then `contract_id==os_id`, `line_item_id is None`, `delta==recoverable_value`, `proposed_action==recommended_action`, `finding_type='estimate_rescue'`, `billed=={}`, and `expected` carries `estimate_id`, `estimate_status`, `line_value`, `lost_sale_reason`, `customer`.
- **AC-B7 (FR-B6, registration + run-now):**
  - Given the worker and ops-api edits.
  - When `python -m pytest temporal/tests/test_worker_registration.py -v` runs.
  - Then `ServiceEstimateRescueWorkflow` is in the workflows list, every `ops_service_estimate` `@activity.defn` is in the activities list, the `ops_service_estimate` alias resolves in `_resolve_activity_module_alias`, and `service-estimate-rescue` is in `_OPS_AGENT_KEYS`.
- **AC-B8 (NFR-B1, import hygiene):**
  - Given the new Python files added to `_NEW_SOURCE_FILES`.
  - When the import-hygiene test runs.
  - Then none import a module containing `rental`.
- **AC-B9 (FR-B7, seed):**
  - Given the seed edit.
  - When applied to the shared container (manually; not via `db reset`).
  - Then `select count(*) from ops_agent_config where agent_key='service-estimate-rescue';` ≥ 2, `service_estimate_finding_v1` survives the registry-reset guard, and `select count(*) from v_dia_service_estimate_current;` > 0.

---

## 8. Implementation Contract

- **Target files (create unless noted):**
  - `supabase/migrations/<timestamp>_service_estimate_etl.sql` — Phase A: `v_dia_service_estimate_current` view (+ comment documenting the `service_order.data.estimates[]` payload contract). No catalog change (A-001).
  - `supabase/migrations/<timestamp>_service_estimate_rescue_agent.sql` — Phase B: `ops_output_schema_registry` upsert for `service_estimate_finding_v1`.
  - `temporal/src/agents/service_estimate_rescue.py` — `ServiceEstimateFindingV1`, `service_estimate_finding_v1_schema()`, `run_service_estimate_rescue(...)`.
  - `temporal/src/activities/ops_service_estimate.py` — `ops_scope_service_estimates`, `ops_service_estimate_assess`, named wrappers, `_service_estimate_finding_for_storage`.
  - `temporal/src/workflows/ops/service_estimate_rescue.py` — `ServiceEstimateRescueWorkflowInput`, `ServiceEstimateRescueWorkflow`.
  - `temporal/scripts/run_service_estimate_rescue.py` — manual-trigger CLI (clone of `run_vehicle_aging.py`).
  - **Modify:** `temporal/src/worker.py`; `temporal/src/ops_api/app.py`; `temporal/src/workflows/ops/__init__.py`; `temporal/tests/test_worker_registration.py` (`alias_map`); `supabase/seed.sql`.
  - **Create test:** `temporal/tests/test_ops_service_estimate.py`.
- **Allowed dependencies:** only what the cloned files already use — `temporalio`, `pydantic`, stdlib (`asyncio`, `hashlib`, `json`, `logging`), `temporal.src.agents.openai_client.chat_with_tools`, `temporal.src.activities.ops_revrec`. **Forbidden:** any new third-party package; any `rental_*` import in new Python files (NFR-B1); any Twilio/SMS/notification client; any new DB table (Phase A is a view only); editing `v_dia_service_order_current`, the `service_order`/`part`/`vehicle` write RPCs, or `rental_entity_type_catalog`.
- **Data / migration / rollback:** Two additive migrations (a view; an upsert into `ops_output_schema_registry`). No new tables, no destructive DDL. Rollback: `drop view if exists public.v_dia_service_estimate_current;` and `delete from public.ops_output_schema_registry where schema_key='service_estimate_finding_v1';` (only if needed; both are idempotent re-runnable via `create or replace` / `on conflict`). Validate against the shared container only (`docker exec … psql … -v ON_ERROR_STOP=1 -f …`); **never `supabase db reset`** (breaks parallel runs).
- **Security-trigger check (one line):**
  > Does this feature cross a trust boundary, handle sensitive data, add an external dependency, perform a destructive operation, touch auth/permissions, run a migration, or carry compliance risk? **YES** — it runs migrations, touches the finding store, and reads customer PII (name/phone/vehicle) for the contact recommendation.
  - **STRIDE-lite register:**
    | Threat | Category | Component | Disposition | Mitigation |
    |---|---|---|---|---|
    | Agent autonomously contacts customers / discounts / authorizes | Elevation of Privilege / Tampering | workflow + activities | mitigate | Assist-only: no SMS/notification/auth/money paths; `recommended_action` is advisory; `auto_apply` forced False (FR-B4, SEC-B1). |
    | Cross-tenant finding/estimate leakage | Information Disclosure | view + finding writes | mitigate | `v_dia_service_estimate_current` is `security_invoker` (caller RLS); writes via `ops_record_finding` under tenant RLS; service-role reads scoped by `tenant_id` plumbing (SEC-B2). |
    | Customer PII over-exposure (phone/name) in findings/logs | Information Disclosure | scope + record | mitigate | PII minimization — surface only fields needed to decide a contact; no extra PII logged beyond existing `finding` columns (SEC-B2). |
    | Bad/missing estimate payload crashes the run | Denial of Service | view + scope | mitigate | View returns zero rows on absent/empty/non-array `estimates`; scope skips malformed/cancelada rows (FR-A2/FR-B3). |
    | New dependency supply-chain risk | Tampering | deps | accept(=none) | No new packages introduced (Allowed/Forbidden above). |
- **Stop gates:** (1) If `v_dia_service_order_current` or any `service_order` write RPC would need editing to deliver Phase A — STOP and re-confirm A-001 (the view must be additive). (2) If applying a migration would require `supabase db reset` — STOP (use `docker exec … psql`). (3) If NC-001 is answered "separate entity" before coding — STOP and re-scope Phase A. (4) If any task implies sending a customer message or authorizing an estimate — STOP (out of scope, SEC-B1).

---

## 9. Executable Task Layer

> Order: **Phase A (T-A1..T-A2)** is the data precondition; **Phase B (T-B1..T-B9)** depends on it. `[P]` = parallelizable (different files, no incomplete dependency). Pick migration timestamps `> 20260626140001`, Phase A strictly before Phase B (e.g. `20260627090000` and `20260627090100`).

### Phase A — data ETL extension

- [ ] **T-A1** [reqs: FR-A1, FR-A2, NFR-A1, AC-A1, AC-A2] [depends: —]
      Files: `supabase/migrations/<ts_A>_service_estimate_etl.sql`
      Precondition / skip-if: skip if `select to_regclass('public.v_dia_service_estimate_current')` is non-null AND its definition already expands `data->'estimates'` with a `recovery_rank` column.
      Read first: `supabase/migrations/20260625150200_dia_part_entity_crud.sql:292-351` (security_invoker derived + secondary ranked view); `supabase/migrations/20260625160000_dia_service_order_entity_crud.sql:302-339` (header view + the `coalesce((data->>'cancelled')::boolean,false)=false` / status pattern).
      Action: Write a migration that, in a leading comment, documents the `service_order.data.estimates[]` contract (A-002 keys). Then `create or replace view public.v_dia_service_estimate_current with (security_invoker = true) as` selecting from `public.rental_current_entity_state rces` where `rces.entity_type='service_order'` and `coalesce((rces.data->>'cancelled')::boolean,false)=false` and `coalesce(nullif(rces.data->>'status',''),'aberta') <> 'cancelada'`, `cross join lateral jsonb_array_elements(case when jsonb_typeof(rces.data->'estimates')='array' then rces.data->'estimates' else '[]'::jsonb end) as est(item)`, exposing: `rces.entity_id as os_id`, `rces.data->>'order_number' as order_number`, `rces.data->>'customer' as customer`, `rces.data->>'vehicle' as vehicle`, `rces.data->>'technician' as technician`, `est.item->>'estimate_id' as estimate_id`, `coalesce(nullif(est.item->>'status',''),'pending') as estimate_status`, `nullif(est.item->>'line_value','')::numeric as line_value`, `est.item->>'lost_sale_reason' as lost_sale_reason`, `est.item->>'description' as estimate_description`, and a `recovery_rank` via `case coalesce(nullif(est.item->>'status',''),'pending') when 'declined' then 0 when 'pending' then 1 else 2 end`. Wrap in an outer filter `where estimate_status in ('pending','declined')` and `order by recovery_rank, line_value desc nulls last, estimate_id`. End with `grant select on table public.v_dia_service_estimate_current to authenticated, service_role;`. Do NOT touch the catalog, header view, or write RPCs.
      Re-run safety: `create or replace view` + `grant` are idempotent.
      Verify: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/<ts_A>_service_estimate_etl.sql` → PASS = `CREATE VIEW` + `GRANT`, no error; then `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select count(*) from public.v_dia_service_estimate_current;"` returns a count without error.
      Done: `v_dia_service_estimate_current` exists, is `security_invoker`, returns only pending/declined estimate rows ordered declined-then-value-desc, and is empty-safe (no error when `estimates` is absent). `v_dia_service_order_current` definition unchanged.
      Recovery/Rollback: `drop view if exists public.v_dia_service_estimate_current;`

- [ ] **T-A2** [reqs: FR-A2, AC-A1] [depends: T-A1]
      Files: (validation only — no file change; uses ad-hoc SQL in the shared container)
      Precondition / skip-if: skip if T-A1 Verify already exercised pending+declined+authorized fixtures.
      Read first: `temporal/tests/test_ops_vehicle_aging.py:332-395` (fixture-shaped expectations to mirror in the seed/test later).
      Action: Insert a throwaway `service_order` (via the existing `create_service_order` RPC or a direct `entities`/`entity_versions` insert under `set local request.jwt.claim.role='service_role'`) whose `data.estimates` has one `pending` (1200), one `declined` (8000, lost_sale_reason='cliente sem retorno'), one `authorized` (500); query the view; assert only pending+declined appear and declined sorts first; then delete the throwaway rows.
      Re-run safety: throwaway rows are deleted at the end; uses a unique `source_record_id` like `prd-A2-probe-%`.
      Verify: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "<the probe SQL>"` → PASS = two rows, declined first, authorized absent.
      Done: AC-A1 demonstrated against the live view; probe rows removed.
      Recovery/Rollback: `delete from entities where source_record_id like 'prd-A2-probe-%';` (cascades versions).

### Phase B — agent triad

- [ ] **T-B1** [P] [reqs: FR-B2, AC-B2] [depends: T-A1]
      Files: `temporal/src/agents/service_estimate_rescue.py`
      Precondition / skip-if: skip if the module already defines `ServiceEstimateFindingV1` with `extra="forbid"` and `run_service_estimate_rescue`.
      Read first: `temporal/src/agents/vehicle_aging_analyst.py:1-75` (clone exactly); `temporal/src/agents/openai_client.py:162` (`chat_with_tools` signature).
      Action: Clone the vehicle_aging analyst. Define `_RECOMMENDED_ACTIONS = ("contact_customer","offer_discount","reprice","escalate","monitor")`. Define `ServiceEstimateFindingV1(BaseModel)` with `model_config=ConfigDict(extra="forbid")` and fields per FR-B2 (`estimate_id: str`, `os_id: str = ""`, `finding_type: str = "estimate_rescue"`, `severity: str = "medium"`, `recommended_action: str`, `recoverable_value: float = 0.0`, `evidence: list[str]=Field(default_factory=list)`, `confidence: float = 0.0`, `rationale: str`). Add `service_estimate_finding_v1_schema()` returning `.model_json_schema()`, a `_no_tool_executor`, and `async def run_service_estimate_rescue(estimate_payload, *, system_prompt, user_prompt_template, max_tool_rounds=0, transport=None)` calling `chat_with_tools(messages=[system,user], tools=[], tool_executor=_no_tool_executor, response_format=ServiceEstimateFindingV1, max_tool_rounds, transport)` and returning `result.response.model_dump(mode="json")`. Export all three in `__all__`. Do NOT import any `rental_*` module.
      Re-run safety: pure module definition; rewriting is deterministic.
      Verify: `python -c "from temporal.src.agents.service_estimate_rescue import ServiceEstimateFindingV1, run_service_estimate_rescue, service_estimate_finding_v1_schema; s=service_estimate_finding_v1_schema(); assert s['additionalProperties'] is False and sorted(s['required'])==['estimate_id','rationale','recommended_action'], s"` → PASS = no output, exit 0.
      Done: closed schema importable; required set exact; no tools wired.

- [ ] **T-B2** [reqs: FR-B1, AC-B1] [depends: T-B1]
      Files: `supabase/migrations/<ts_B>_service_estimate_rescue_agent.sql`
      Precondition / skip-if: skip if `select 1 from public.ops_output_schema_registry where schema_key='service_estimate_finding_v1'` returns a row whose `schema_json->>'title'='ServiceEstimateFindingV1'`.
      Read first: `supabase/migrations/20260626140001_vehicle_aging_agent.sql:7-34` (the upsert shape).
      Action: Generate the JSON Schema from T-B1 (`python -c "import json;from temporal.src.agents.service_estimate_rescue import service_estimate_finding_v1_schema as s;print(json.dumps(s(),indent=2))"`) and paste it verbatim as the `schema_json` literal in `insert into public.ops_output_schema_registry (schema_key, schema_json, description) values ('service_estimate_finding_v1', '<schema>'::jsonb, 'Service estimate authorization rescue finding output schema v1 (estimate_rescue)') on conflict (schema_key) do update set schema_json=excluded.schema_json, description=excluded.description, updated_at=now();`.
      Re-run safety: `on conflict (schema_key) do update` upsert.
      Verify: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/<ts_B>_service_estimate_rescue_agent.sql` → PASS = `INSERT 0 1`, no error.
      Done: registry row present and equals the Pydantic schema (verified end-to-end by T-B8's parity test).
      Recovery/Rollback: `delete from public.ops_output_schema_registry where schema_key='service_estimate_finding_v1';`

- [ ] **T-B3** [reqs: FR-B3, FR-B5, SEC-B2, AC-B3, AC-B6] [depends: T-B1, T-A1]
      Files: `temporal/src/activities/ops_service_estimate.py`
      Precondition / skip-if: skip if the module defines `ops_scope_service_estimates`, `ops_service_estimate_assess`, and the named wrappers.
      Read first: `temporal/src/activities/ops_vehicle_aging.py:1-282` (clone whole-file structure); `temporal/src/activities/ops_revrec.py:288-304,315-331` (persistence client + `interpolate_prompt_template`).
      Action: Clone `ops_vehicle_aging.py`. Constants: `_AGENT_KEY="service-estimate-rescue"`, `_FINDING_TYPE="estimate_rescue"`, `_DEFAULT_MAX_ESTIMATES=200`, `_MIN/_MAX_SCOPED=1/500`, `_DEFAULT_HIGH_VALUE_THRESHOLD=5000`. `_estimate_fingerprint(tenant_id, estimate_id)=sha256(f"{tenant_id}:{estimate_id}:estimate_rescue")`. `_severity_for(status, line_value, high_value_threshold)` → `high` if status=='declined' or line_value>=threshold else `medium`. `@activity.defn ops_scope_service_estimates(tenant_id, run_context)`: read `v_dia_service_estimate_current` via `ops_revrec._get_ops_persistence_client().select(...)`, skip rows with empty `estimate_id`, build per-row dict (`estimate_id`, `os_id`, `tenant_id`, `order_number`, `customer`, `vehicle`, `technician`, `estimate_status`, `line_value` (coerced float), `recoverable_value`=line_value, `lost_sale_reason`, `severity`, `recovery_rank`, `finding_type`, `fingerprint`), sort by `(recovery_rank, -line_value, estimate_id)`, clamp+bound by `run_context.max_estimates`. `@activity.defn async ops_service_estimate_assess(estimate_payload, config)`: clone the heartbeat-loop + prompt-interpolation wrapper, call `run_service_estimate_rescue`, then pin deterministic fields (`estimate_id`, `os_id`, `finding_type`, `severity`, `recoverable_value`) back onto the result and `setdefault` `recommended_action='monitor'`, `evidence=[]`, `confidence=0.0`, `rationale`. Named wrappers `@activity.defn(name="ops_service_estimate_<verb>")` for `ops_load_agent_config`, `ops_list_open_finding_fingerprints`, `ops_create_workflow_run`, `ops_finalize_workflow_run`, `ops_record_finding`, `ops_record_finding_disposition`, each delegating to `ops_revrec`. `_service_estimate_finding_for_storage(finding)` → `{**finding, "contract_id": os_id, "line_item_id": None, "finding_type": estimate_rescue, "severity": …, "expected": {estimate_id, estimate_status, line_value, lost_sale_reason, customer, vehicle, order_number, recommended_action}, "billed": {}, "delta": recoverable_value, "proposed_action": recommended_action}`. No `rental_*` imports. Populate `__all__`.
      Re-run safety: deterministic module rewrite.
      Verify: `python -c "from temporal.src.activities.ops_service_estimate import ops_scope_service_estimates, ops_service_estimate_assess, _service_estimate_finding_for_storage, _estimate_fingerprint; r=_service_estimate_finding_for_storage({'estimate_id':'e1','os_id':'os-uuid','recoverable_value':8000.0,'recommended_action':'contact_customer','estimate_status':'declined','line_value':8000.0,'lost_sale_reason':'x','customer':'ACME'}); assert r['contract_id']=='os-uuid' and r['line_item_id'] is None and r['delta']==8000.0 and r['finding_type']=='estimate_rescue' and r['expected']['estimate_id']=='e1'"` → PASS = exit 0.
      Done: scope + assess + wrappers + finding-shaper importable; finding row maps per AC-B6.

- [ ] **T-B4** [reqs: FR-B4, SEC-B1, AC-B4, AC-B5] [depends: T-B3]
      Files: `temporal/src/workflows/ops/service_estimate_rescue.py`, `temporal/src/workflows/ops/__init__.py`
      Precondition / skip-if: skip if `ServiceEstimateRescueWorkflow` is defined and exported from `ops/__init__.py`.
      Read first: `temporal/src/workflows/ops/vehicle_aging.py:1-184` (clone whole-file); `temporal/src/workflows/ops/__init__.py:1-86` (export style).
      Action: Clone `vehicle_aging.py`. `_WORKFLOW_KEY="service-estimate-rescue"`. `@dataclass ServiceEstimateRescueWorkflowInput(tenant_id: str, run_window_start: str|None=None, run_window_end: str|None=None)`. `@workflow.defn class ServiceEstimateRescueWorkflow` with `run()` mirroring the vehicle_aging pipeline but over estimates: summary keys `status, total_estimates_scoped, processed_findings, recorded_findings, deduped_findings, remaining_findings_count, auto_apply` (force False at L~75 equivalent); call `ops_service_estimate.ops_create_workflow_run/ops_load_agent_config/ops_scope_service_estimates`; early-return on empty; `asyncio.gather` of `ops_service_estimate_assess` with `start_to_close_timeout=2min`, `heartbeat_timeout=45s`, `retry_policy=_AI_RETRY(max_attempts=2)`; build surfaced dicts (incl `estimate_id`, `os_id`, `agent_key=_WORKFLOW_KEY`, `workflow_id=f"ops-service-estimate-rescue:{run_id}"`, `finding_type='estimate_rescue'`, `recommended_action`, `recoverable_value`, `evidence`, `confidence`, `rationale`, `fingerprint`, and the estimate facts); sort by `(recovery_rank asc, -line_value, fingerprint)`; dedupe via `ops_list_open_finding_fingerprints`; bound by `config.bounds.max_findings_per_run` (default 50); record via `ops_record_finding`; finalize in `finally`. Add imports/exports to `ops/__init__.py` (`ServiceEstimateRescueWorkflow`, `ServiceEstimateRescueWorkflowInput`) and `__all__`.
      Re-run safety: deterministic rewrite; workflow is fire-and-forget (never blocks on approval).
      Verify: `python -c "from temporal.src.workflows.ops.service_estimate_rescue import ServiceEstimateRescueWorkflow, ServiceEstimateRescueWorkflowInput; from temporal.src.workflows.ops import ServiceEstimateRescueWorkflow as X; assert X is ServiceEstimateRescueWorkflow and hasattr(ServiceEstimateRescueWorkflow,'__temporal_workflow_definition')"` → PASS = exit 0.
      Done: workflow importable from both the submodule and `ops/__init__.py`; decorated; summary contract per FR-B4.

- [ ] **T-B5** [reqs: FR-B7, AC-B9] [depends: T-B2]
      Files: `supabase/seed.sql`
      Precondition / skip-if: skip if `seed.sql` already contains a `service-estimate-rescue` DO-block AND `schema_key <> 'vehicle_aging_finding_v1'` guard widened.
      Read first: `supabase/seed.sql:63` (registry-reset guard) and `:269-366` (vehicle-aging seed block to clone).
      Action: (1) Widen the guard at L63 to keep the new key, e.g. `DELETE FROM ops_output_schema_registry WHERE schema_key NOT IN ('vehicle_aging_finding_v1','service_estimate_finding_v1');`. (2) Append a DO-block cloned from the vehicle-aging block: `v_agent_key='service-estimate-rescue'`, `v_schema_key='service_estimate_finding_v1'`, a service-manager `system_prompt`/`user_prompt_template` (assist-only language: recommend a next contact, never send/authorize), `v_thresholds='{"high_value_threshold":5000}'::jsonb`, `v_bounds='{"max_findings_per_run":50,"max_tool_rounds":2}'::jsonb`, `v_schedule='{"cron":"0 7 * * 1-5","enabled":false}'::jsonb`, seeding both the entity store (`entity_type='agent_config'`) and `ops_agent_config` for `demo-ops-a`/`demo-ops-b` (idempotent DELETE-then-INSERT + ON CONFLICT, exactly like the cloned block). (3) Plant demo `estimates[]` on ≥1 existing seeded `service_order` per tenant: locate or insert a `service_order` and append `data` with an `estimates` array containing ≥1 `pending` and ≥1 `declined` line (with `line_value` + `lost_sale_reason`), via `update_service_order` RPC or a direct current-version update under `set local request.jwt.claim.role='service_role'` (idempotent on a stable `source_record_id`).
      Re-run safety: all writes idempotent (DELETE+ON CONFLICT; stable source_record_ids).
      Verify: apply only the appended block(s) to the shared container: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "<paste the new DO-block(s)>"` then `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select count(*) from ops_agent_config where agent_key='service-estimate-rescue'; select count(*) from v_dia_service_estimate_current;"` → PASS = first count ≥2, second count >0. (Do NOT run `supabase db reset`.)
      Done: agent seeded for both tenants; new registry key survives the reset guard; view non-empty.
      Recovery/Rollback: `delete from ops_agent_config where agent_key='service-estimate-rescue'; delete from entities where entity_type='agent_config' and source_record_id like '%service-estimate-rescue';`

- [ ] **T-B6** [reqs: FR-B6, AC-B7] [depends: T-B4]
      Files: `temporal/src/ops_api/app.py`
      Precondition / skip-if: skip if `'service-estimate-rescue'` is already in `_OPS_AGENT_KEYS`.
      Read first: `temporal/src/ops_api/app.py:76-96` (`_OPS_AGENT_KEYS` → `_AGENT_SCHEDULE_ID_BUILDERS`).
      Action: Append `"service-estimate-rescue",` to the `_OPS_AGENT_KEYS` tuple (L76-88). No other change (the schedule-id builder + run-now endpoint are generic over the tuple).
      Re-run safety: single-membership edit; adding twice is prevented by skip-if.
      Verify: `python -c "from temporal.src.ops_api.app import _OPS_AGENT_KEYS; assert 'service-estimate-rescue' in _OPS_AGENT_KEYS"` → PASS = exit 0.
      Done: `POST /api/ops/agents/service-estimate-rescue/run` resolves a schedule id (no 404 on unknown key).

- [ ] **T-B7** [reqs: FR-B6, AC-B7] [depends: T-B3, T-B4]
      Files: `temporal/src/worker.py`, `temporal/tests/test_worker_registration.py`
      Precondition / skip-if: skip if `ServiceEstimateRescueWorkflow` is in `Worker(workflows=[…])` AND all `ops_service_estimate` activities are in `Worker(activities=[…])` AND `'ops_service_estimate'` is in the test's `alias_map`.
      Read first: `temporal/src/worker.py:43-44,82,102-104,357-423,1359-1362,1434,1519-1526` (every vehicle-aging touch-point); `temporal/tests/test_worker_registration.py:75-101` (the `alias_map`).
      Action: In `worker.py`: add `ops_service_estimate` to the `from .activities import (…)` block; add `from .workflows.ops.service_estimate_rescue import ServiceEstimateRescueWorkflow, ServiceEstimateRescueWorkflowInput`; add constants `_SERVICE_ESTIMATE_RESCUE_AGENT_KEY="service-estimate-rescue"` + `_SERVICE_ESTIMATE_RESCUE_DEFAULT_CRON="0 7 * * 1-5"`; clone the `_fetch_vehicle_aging_schedule_rows`/`_build_vehicle_aging_schedule`/`_reconcile_tenant_vehicle_aging_schedule`/`reconcile_vehicle_aging_schedules` quartet (L357-423) renamed for service-estimate (workflow id `ops-service-estimate-rescue-{tenant_id}`); add a best-effort `await reconcile_service_estimate_schedules(client)` try/except in `main()` (next to L1359-1362); add `ServiceEstimateRescueWorkflow` to `workflows=[…]` (L1434 area); add all eight `ops_service_estimate.*` activities to `activities=[…]` (the six named wrappers + `ops_scope_service_estimates` + `ops_service_estimate_assess`) next to the `ops_vehicle_aging.*` block (L1519-1526). In `test_worker_registration.py`: add `"ops_service_estimate": "temporal.src.activities.ops_service_estimate",` to the `alias_map` (L75-101).
      Re-run safety: additive edits guarded by skip-if; no reordering of existing entries.
      Verify: `python -m pytest temporal/tests/test_worker_registration.py -v` → PASS = all tests pass (no "unknown module alias", no missing workflow/activity).
      Done: worker registers the workflow + all activities; cron reconcile wired; module alias resolves.

- [ ] **T-B8** [reqs: FR-B1..FR-B5, NFR-B1, AC-B1..AC-B6, AC-B8] [depends: T-B1, T-B2, T-B3, T-B4]
      Files: `temporal/tests/test_ops_service_estimate.py`, `temporal/scripts/run_service_estimate_rescue.py`
      Precondition / skip-if: skip if both files exist and the test module imports the new triad.
      Read first: `temporal/tests/test_ops_vehicle_aging.py:1-712` (clone every section, adapting names/fields); `temporal/scripts/run_vehicle_aging.py:1-40` (clone the CLI).
      Action: Create `run_service_estimate_rescue.py` cloning the vehicle CLI (resolve tenant via `ops_revrec.get_ops_persistence_client()`, start `ServiceEstimateRescueWorkflow`, print `{scoped, recorded, deduped}`). Create the test module cloning `test_ops_vehicle_aging.py`: (a) deterministic helpers — `_severity_for` boundaries, `_estimate_fingerprint` exactness, `_service_estimate_finding_for_storage` mapping (AC-B6) + defaults; (b) schema-vs-migration **parity** test that regex-extracts `'(\{.*?\})'::jsonb` from `supabase/migrations/<ts_B>_service_estimate_rescue_agent.sql` and asserts title/additionalProperties/required/properties match `service_estimate_finding_v1_schema()` (AC-B1); (c) a `_FakeTransport` asserting `tools_seen==[[]]` + extra-field rejection (AC-B2); (d) scope tests over a `_FakeSelectClient` seeded with declined/pending/high-value/cancelada rows (AC-B3); (e) workflow tests via a `_build_harness` patching `temporalio.workflow.execute_activity` — record-all / dedupe-all / dedupe-some / auto_apply-false / bounding / empty-scope / heartbeat(45s)+retry(2) (AC-B4/AC-B5); (f) the registration test (reuse `test_worker_registration` helpers) asserting `ServiceEstimateRescueWorkflow` + every `ops_service_estimate` `@activity.defn` are wired; (g) set `_NEW_SOURCE_FILES = ("temporal/src/agents/service_estimate_rescue.py","temporal/src/activities/ops_service_estimate.py","temporal/src/workflows/ops/service_estimate_rescue.py","temporal/scripts/run_service_estimate_rescue.py")` and the import-hygiene test (AC-B8).
      Re-run safety: tests are read-only against code/migrations; deterministic.
      Verify: `python -m pytest temporal/tests/test_ops_service_estimate.py -v` → PASS = all tests pass.
      Done: full test pyramid green; CLI importable (`python -c "import temporal.scripts.run_service_estimate_rescue"`).

- [ ] **T-B9** [reqs: §3 success metrics, AC-B7, AC-B8] [depends: T-B1..T-B8]
      Files: (no new file — full-suite gate)
      Precondition / skip-if: never skip (final gate).
      Read first: §10 Coverage Matrix (confirm every row's Verify has run green).
      Action: Run the two Python suites touched by this change and confirm no regressions in worker registration.
      Re-run safety: read-only.
      Verify: `python -m pytest temporal/tests/test_ops_service_estimate.py temporal/tests/test_worker_registration.py -v` → PASS = all pass.
      Done: both suites green; the agent is registered, scoped, schema-verified, and assist-only.

---

## 10. Coverage Matrix

| Requirement | Acceptance | Task(s) | Verify command | Source evidence (path:line) |
|---|---|---|---|---|
| FR-A1 | AC-A1 | T-A1 | `docker exec … psql … -f <ts_A>_service_estimate_etl.sql` | `…dia_part_entity_crud.sql:292-351`; `…dia_service_order_entity_crud.sql:302-339` |
| FR-A2 | AC-A1 | T-A1, T-A2 | `docker exec … psql … -c "select … from v_dia_service_estimate_current order by recovery_rank;"` | `…dia_service_order_entity_crud.sql:319-337` |
| NFR-A1 | AC-A2 | T-A1 | `docker exec … psql … -v ON_ERROR_STOP=1 -f <ts_A>…sql` | `…dia_part_entity_crud.sql:330` (grant); CLAUDE.md catalog gotcha |
| FR-B1 | AC-B1 | T-B2, T-B8 | `python -m pytest temporal/tests/test_ops_service_estimate.py -v` | `…vehicle_aging_agent.sql:7-34`; `test_ops_vehicle_aging.py:179-195` |
| FR-B2 | AC-B2 | T-B1, T-B8 | `python -m pytest temporal/tests/test_ops_service_estimate.py -v` | `vehicle_aging_analyst.py:21-67`; `openai_client.py:162` |
| FR-B3 | AC-B3 | T-B3, T-B8 | `python -m pytest temporal/tests/test_ops_service_estimate.py -v` | `ops_vehicle_aging.py:69-134`; `ops_revrec.py:288-304` |
| FR-B4 | AC-B4, AC-B5 | T-B4, T-B8 | `python -m pytest temporal/tests/test_ops_service_estimate.py -v` | `workflows/ops/vehicle_aging.py:34-184` |
| FR-B5 | AC-B6 | T-B3, T-B8 | `python -m pytest temporal/tests/test_ops_service_estimate.py -v` | `ops_vehicle_aging.py:203-269`; `ops_revrec.py:654-684` |
| FR-B6 | AC-B7 | T-B6, T-B7 | `python -m pytest temporal/tests/test_worker_registration.py -v` | `worker.py:357-423,1434,1519-1526`; `ops_api/app.py:76-96` |
| FR-B7 | AC-B9 | T-B5 | `docker exec … psql … -c "select count(*) from ops_agent_config where agent_key='service-estimate-rescue'; select count(*) from v_dia_service_estimate_current;"` | `seed.sql:63,269-366` |
| NFR-B1 | AC-B8 | T-B8 | `python -m pytest temporal/tests/test_ops_service_estimate.py -v` | `test_ops_vehicle_aging.py:48-53,696-711` |
| SEC-B1 | AC-B4 | T-B3, T-B4 | `python -m pytest temporal/tests/test_ops_service_estimate.py -v` (auto_apply False; no SMS/auth paths) | `workflows/ops/vehicle_aging.py:75`; `ops_revrec.py:536-539` |
| SEC-B2 | AC-A2, AC-B6 | T-A1, T-B3 | `docker exec … psql …` + `python -m pytest …test_ops_service_estimate.py -v` | `…dia_part_entity_crud.sql:293`; `ops_revrec.py:292-304,654-684` |

---

## 11. Self-Verification Report
- [x] No placeholders / TODOs in tasks — every task has concrete Files/Action/Verify/Done; `<ts_A>`/`<ts_B>` are the only author-chosen literals (timestamp instructions given: `>20260626140001`, A before B).
- [x] Every FR → ≥1 task; every task → ≥1 requirement (matrix closes) — FR-A1/A2/NFR-A1 → T-A1/T-A2; FR-B1..B7/NFR-B1/SEC-B1/SEC-B2 → T-B1..T-B9; no orphan tasks.
- [x] Every task has Files / Action / Verify / Done — confirmed for T-A1, T-A2, T-B1..T-B9.
- [x] Every code fact cites path:line; no invented paths — all citations verified by reading the files in §2 (incl the `alias_map` and `_OPS_AGENT_KEYS` gotchas, the seed reset guard at `seed.sql:63`, and the schema-parity test at `test_ops_vehicle_aging.py:179-195`).
- [x] Size/split gate — 11 tasks across two phases. Exceeds the ≤8 soft cap, but the user **explicitly requires ONE PRD per agent**; tasks are split into Phase A (data, 2) + Phase B (agent, 9), each tight and independently verifiable, and §3 names Phase A as the precondition. Target files = 11 (6 new + 5 modified); the extra surface is inherent to "view + triad + registration + seed + tests" and each file maps to a distinct task.
- [x] Security-trigger check done — triggered (migrations + finding store + customer PII); STRIDE-lite + assist-only mitigations expanded in §8.
- **Verdict:** EXECUTABLE ✅
