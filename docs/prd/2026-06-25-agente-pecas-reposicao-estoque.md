# Agent-Executable PRD: Parts Fill-Rate, Replenishment & Inventory-Health Advisor (`parts-inventory-advisor`)

## 0. Execution Header

- **Input source:** the REPORT below (the task brief describing a near-clone of the existing `vehicle-aging-analyst` ops agent), grounded against the live repo.
- **Repo root:** `/mnt/c/Dev/AIAccelerator/dealernet-agents`
- **Stack:** Python + Temporal workers (`temporal/`), Supabase/Postgres migrations (`supabase/`), pytest. Worker SDK `temporalio==1.5.0`, `pydantic==2.7.3` (`temporal/pyproject.toml:7-8`). Note: `temporal/pyproject.toml:5` declares `requires-python = ">=3.11"` and `ruff target-version = "py311"` (`:54`); the task brief names Python 3.14 as the deploy target — code config is ground truth, write 3.11-compatible code.
- **Runtime targets:** Claude Code / Codex (autonomous coding agent via `/ship-issue`).
- **Size tier:** Small — a clean clone of an existing agent. 8 tasks, ≤10 target files, 1 user journey.
- **Date:** 2026-06-25
- **Status:** executable

---

## 1. Input Extraction Ledger

**Goals / decisions (from the REPORT):**
- Build a proactive **assist-only** DIA ops agent for the parts manager / dealer principal that ranks parts inventory and records ranked "findings" (recommend only; a human authorizes any purchase).
- Two finding types in v1: `replenish_now` (parts at `stock_status` zerado/critico/baixo, ranked by criticality × velocity × tied-up value; group by supplier where available) and `dead_stock` (low/no movement × stock value, ranked for liquidation).
- It is a **near-clone of `vehicle-aging-analyst`**: same workflow skeleton (create run → load config → scope → no-op early return → assess concurrently via `asyncio.gather` → dedup by fingerprint → record → finalize in `finally`), same closed-Pydantic + no-tools analyst, same canonical `finding` persistence, same worker/ops_api/cron wiring.
- Data readiness is **HIGH** — scope views already exist (`v_dia_part_current`, `v_dia_parts_critical`, `v_dia_part_sale_current`). No mirror work.

**Users:** Parts manager and dealer principal (parts/aftersales decision-makers). Findings surface in the Portal via `ops_findings_view` → `FindingsQueue.tsx` / `FindingDetail.tsx`.

**Risks / open questions (resolved as assumptions in §4):** cron cadence; ships disabled-by-default like vehicle-aging; velocity window (months); dead-stock movement threshold; how to compute a single fingerprint when one part could in principle qualify for both finding types.

**Grounding seeds (cited as `path:line` in §2):** `temporal/src/workflows/ops/vehicle_aging.py`, `temporal/src/activities/ops_vehicle_aging.py`, `temporal/src/agents/vehicle_aging_analyst.py`, `temporal/src/activities/ops_revrec.py`, `temporal/src/worker.py`, `temporal/src/ops_api/app.py`, `temporal/tests/test_ops_vehicle_aging.py`, `supabase/migrations/20260625150200_dia_part_entity_crud.sql`, `supabase/migrations/20260626120000_dia_part_sale_entity_crud.sql`, `supabase/migrations/20260626140001_vehicle_aging_agent.sql`, `supabase/seed.sql`.

---

## 2. Source Grounding Ledger

### Files read (what each establishes)

| File:lines | What it establishes |
|---|---|
| `temporal/src/workflows/ops/vehicle_aging.py:1-184` | **The workflow skeleton to clone.** Module constants (`_DEFAULT_MAX_FINDINGS_PER_RUN=50`, retry policies `_STANDARD_RETRY`/`_MONEY_RETRY`/`_AI_RETRY`, `_AI_HEARTBEAT_TIMEOUT=45s`, `_WORKFLOW_KEY`). `@dataclass` input (`tenant_id`, optional window). `@workflow.defn` run: create run (`_MONEY_RETRY`) → load config (forces `summary["auto_apply"]=False`, `:75`) → scope → early return on empty scope (`:85-86`) → `asyncio.gather` over assess (`:88-98`) → build surfaced dicts + sort (`:100-134`) → list open fingerprints + dedup (`:136-150`) → bound by `bounds.max_findings_per_run` (`:152-161`) → record loop (`:163-170`) → `finally` finalize (`:176-183`). |
| `temporal/src/activities/ops_vehicle_aging.py:1-281` | **The activities to clone.** `_AGENT_KEY`/`_FINDING_TYPE` constants; `_coerce_int`/`_coerce_float`; deterministic severity (`_severity_for_days:45-62`) + fingerprint (`_stock_aging_fingerprint:65-66`, `sha256(f"{tenant}:{id}:{type}")`); `ops_scope_vehicle_aging:69-134` (reads view via `ops_revrec._get_ops_persistence_client()`, computes severity+fingerprint deterministically, sorts desc, caps at `max_vehicles`); `ops_vehicle_aging_assess:137-200` (async; 15s heartbeat loop `:166-177`; renders prompts via `ops_revrec.interpolate_prompt_template:161-162`; calls analyst; **pins deterministic money fields after the LLM returns** `:190-199`); `_vehicle_finding_for_storage:223-252` (maps to canonical `finding` row: `contract_id=entity_id`, `line_item_id=None`, `expected{}`, `billed={}`, `delta`, `proposed_action`); **named-activity wrappers** `:203-269` that delegate to `ops_revrec` (`ops_vehicle_aging_load_agent_config|list_open_finding_fingerprints|create_workflow_run|finalize_workflow_run|record_finding|record_finding_disposition`). |
| `temporal/src/agents/vehicle_aging_analyst.py:1-75` | **The agent module to clone.** Closed Pydantic `VehicleAgingFindingV1(extra="forbid")` (`:21-33`) + `vehicle_aging_finding_v1_schema()` (`:36-37`) + `run_vehicle_aging_analyst(...)` (`:47-67`) calling `chat_with_tools(tools=[], tool_executor=_no_tool_executor, response_format=...)`. **NO tools** — evidence is inline in the prompt. Returns `result.response.model_dump(mode="json")`. |
| `temporal/src/activities/ops_revrec.py:292-539, 611-722` | **Persistence facts.** `_get_ops_persistence_client():292` (shared client; tests monkeypatch `ops_revrec._ops_client`). `interpolate_prompt_template:315`. `ops_load_agent_config:503-539` raises `AgentConfigNotFoundError` if no config row (`:511`), raises if disabled (`:513-514`), validates `output_schema_key` against `ops_output_schema_registry` (`:515-526`), **forces `row["auto_apply"]=False` (`:538`)**. `ops_list_open_finding_fingerprints:611-619` filters `finding` by `status='pending_approval'`. `ops_record_finding:655-684` upserts `finding` on `tenant_id,fingerprint` with `status="pending_approval"` (`:665-676`). |
| `temporal/src/agents/tools/dia_bi.py:32-63` | Read-only Supabase client pattern (`build_service_role_dia_client`, `PostgrestReadClient.select`). The advisor reuses `ops_revrec._get_ops_persistence_client()` exactly like `ops_scope_vehicle_aging` (`:79`), so it does NOT need this client — listed for completeness. |
| `supabase/migrations/20260625150200_dia_part_entity_crud.sql:292-352` | **Data source A.** `v_dia_part_current` (`:292-330`): columns `entity_id, entity_version_id, version_number, source_record_id, name, part_number, description, manufacturer, unit_cost, unit_price, quantity_in_stock, min_stock, reorder_point, location, status, stock_value (=round(qty*unit_cost,2)), stock_status (zerado|critico|baixo|ok)`. `v_dia_parts_critical` (`:337-352`): pre-filtered `stock_status in ('baixo','critico','zerado')` + `criticality_rank` (zerado=0, critico=1, baixo=2, ok=3), ordered by `criticality_rank, part_number`. **No `supplier` column exists** (see conflicts table). |
| `supabase/migrations/20260626120000_dia_part_sale_entity_crud.sql:362-394` | **Data source B (velocity).** `v_dia_part_sale_current` (`:362-394`): columns `entity_id, part_id (uuid), part_number, description, quantity, unit_price, discount, total, sale_date (text), customer, salesperson, channel, status`. Filters out cancelled sales. `part_id` joins to `v_dia_part_current.entity_id`. |
| `supabase/migrations/20260626140001_vehicle_aging_agent.sql:1-34` | **The output-schema registry seed pattern.** A single `insert into public.ops_output_schema_registry (schema_key, schema_json, description) values (...) on conflict (schema_key) do update ...`. The new migration mirrors this exactly with `parts_inventory_finding_v1`. |
| `supabase/seed.sql:266-366` | **The config-row shape to mirror.** A `DO $$` block seeding `vehicle-aging-analyst` for tenants `demo-ops-a`/`demo-ops-b` into BOTH the entity store (`entity_type='agent_config'`, `source_record_id=format('demo-ops-agent-config:%s:%s', tenant_id, agent_key)`) and the base `ops_agent_config` table. Config JSON keys: `tenant_id, agent_key, enabled, model, system_prompt, user_prompt_template, tools, output_schema_key, thresholds, bounds, schedule, auto_apply`. `schedule.enabled=false` ships the recurring run OFF (`:287`, `:332`). Idempotent via DELETE-then-INSERT + ON CONFLICT. |
| `supabase/seed.sql:558-700` | **Demo data exists.** ~30 demo parts (`demo-dia-part-NNN`) spanning all `stock_status` values (`:575-...`), and ~18 demo part sales (`demo-dia-part-sale-NNN`) via `create_part_sale`. Comments at `:563-564` document the stock_status precedence; `:678-685` shows several parts with sales. Parts with NO matching active sale (e.g. `demo-dia-part-011` Amortecedor, and `demo-dia-part-019` whose only sale `demo-dia-part-sale-019` is `cancel=true` → drops from `v_dia_part_sale_current`) are natural **dead-stock** candidates. Parts `006/007/008/010/012` drop to critico/zerado after sales (`:660-664`) → natural **replenish-now** candidates. |
| `temporal/src/worker.py:43, 82, 102-103, 357-423, 1357-1362, 1434, 1519-1526` | **Registration surface.** Activity module import (`:43`); workflow import (`:82`); agent-key + default-cron constants (`:102-103`); the `_fetch_*`/`_build_*`/`_reconcile_*`/`reconcile_*` schedule block to clone (`:357-423` for vehicle-aging); best-effort reconcile call in `main()` (`:1359-1362`); workflow registered in `Worker(workflows=[...])` (`:1434`); all 8 activities (incl. named wrappers) registered in `Worker(activities=[...])` (`:1519-1526`). `_schedule_id_for_tenant(tenant_id, agent_key)` → `ops:{tenant}:{key}` (`:110-111`). |
| `temporal/src/ops_api/app.py:76-88` | `_OPS_AGENT_KEYS` tuple — adding the new key here makes it run-now-able (drives `_AGENT_SCHEDULE_ID_BUILDERS` at `:90-96`). |
| `temporal/tests/test_ops_vehicle_aging.py:1-712` | **The test pattern to clone.** `_FakeTransport` for Azure (`:198-218`); `_FakeSelectClient` equality-filtered `select` (`:289-311`); `monkeypatch.setattr(ops_revrec, "_ops_client", client)` (`:349`); unit tests of deterministic helpers (`:63-155`); schema↔migration-registry parity test (`:179-195`); workflow driven by patching `temporalio.workflow.execute_activity` via `_build_harness` (`:439-497`); worker-registration assertion (`:667-693`); no-rental-imports guard (`:696-711`, with `_NEW_SOURCE_FILES` at `:48-53`). |
| `temporal/tests/conftest.py:34-49` | Heavy DB-reset tests are deselected when `SKIP_SUPABASE_RESET_VALIDATION=1`; the new pure-Python unit tests are unaffected (no `_reset_validation`/`_smoke_validation` suffix). |
| `temporal/pyproject.toml:43-60` | **Stack/lint facts.** pytest config (`timeout=600`); `ruff target-version=py311`, `line-length=120`, `select=["E","F","W","I","UP","B","SIM"]`, `ignore=["E501"]`. |

### Stack facts (commands)

- **Run the new unit tests:** `python -m pytest temporal/tests/test_ops_parts_inventory.py -v`
- **Worker registration test:** `python -m pytest temporal/tests/test_worker_registration.py -v`
- **Import smoke:** `python -c "import temporal.src.worker"` (from repo root) — proves all imports + decorated activities resolve.
- **Lint:** `cd temporal && ruff check src/agents/parts_inventory_advisor.py src/activities/ops_parts_inventory.py src/workflows/ops/parts_inventory.py` (ruff 0.8.4; `cd frontend-portal && npm run lint` is frontend-only and irrelevant here).
- **SQL validation (shared DB — NEVER `supabase db reset`):** `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20260627130000_parts_inventory_agent.sql`

### Existing patterns to follow

- Deterministic-in-scope, LLM-only-for-judgment: severity/value/fingerprint computed in `ops_scope_*`; LLM picks the recommended action; money/severity re-pinned after the LLM (`ops_vehicle_aging.py:190-199`).
- Named-activity wrappers delegate generic persistence to `ops_revrec` (`ops_vehicle_aging.py:203-269`).
- Config + schema split: schema registry row in a migration; full config row in `seed.sql`.
- Ships disabled-by-default: `schedule.enabled=false` (`seed.sql:287`).

### Integration points

- `ops_revrec._get_ops_persistence_client()` (read views + write `finding`/`ops_workflow_run`).
- `ops_output_schema_registry` (validated by `ops_load_agent_config`).
- `ops_agent_config_current` + base `ops_agent_config` (config source).
- `finding` table, unique `(tenant_id, fingerprint)` — `supabase/migrations/20260607170000_ops_factory_persistence.sql`.
- Worker registration + cron reconcile (`temporal/src/worker.py`); run-now allowlist (`temporal/src/ops_api/app.py`).
- Downstream UI: `ops_findings_view` → `FindingsQueue.tsx` / `FindingDetail.tsx` via `frontend-portal/src/portal/lib/agentsApi.ts` (no change required — generic finding surface).

### Input-vs-code conflicts

| Input claim | Code reality | Resolution |
|---|---|---|
| "group by supplier where available" | `v_dia_part_current` has **no `supplier` column** (`20260625150200...sql:292-330`); only `manufacturer`. No open-PO / in-transit / supplier mirror exists. | **Drift.** Use `manufacturer` as the available grouping proxy and surface it in evidence/rationale; do NOT invent a supplier join. True supplier grouping is a non-goal (§3). |
| "in-transit / open-PO reconciliation" | No mirrored fields; ERP `PRC_SugestaoCompra` logic (net of in-transit/blocked/requisition/back-order) is NOT mirrored. | **Non-goal** (§3). `quantity_suggested` is a simple deterministic gap (see A-005), explicitly labelled a starting point, never an ERP-grade buy-qty. |
| Python 3.14 runtime | `pyproject.toml:5` `requires-python>=3.11`; ruff `py311`. | Write 3.11-compatible code; the higher deploy runtime is forward-compatible. |
| "rank by velocity" | Velocity is derivable only from `v_dia_part_sale_current.sale_date` (text) (`20260626120000...sql:381`). | Compute a deterministic per-part sold-quantity over a window in scope (A-003); inline it as evidence for the LLM ranking. |

### Unknowns

- None blocking. All scope views, persistence, and demo data exist and are verified. Velocity/threshold defaults are pinned as assumptions (§4) with config overrides, exactly like vehicle-aging thresholds.

---

## 3. Outcome Contract

**Goal (1 sentence):** Ship an assist-only DIA ops agent `parts-inventory-advisor` that, on demand or on a (default-off) cron, deterministically scopes parts inventory, has an LLM rank/assess each part, and records ranked `pending_approval` findings of type `replenish_now` (understocked parts) and `dead_stock` (stagnant parts) into the canonical `finding` store for human authorization.

**Non-goals (explicit — the cut items):**
- **No autonomous PO creation / order placement.** The agent recommends; `auto_apply` is forced `False` (`ops_revrec.py:538`). No write to any PO/requisition entity.
- **No finite-budget optimization** (knapsack over a purchasing budget).
- **No full MOQ / lot-size optimization.** `quantity_suggested` is a simple gap-to-target, not an optimized buy quantity.
- **No in-transit / open-PO / requisition / back-order reconciliation** — those ERP fields are NOT mirrored (`PRC_SugestaoCompra_Processa` net-of-pipeline logic is out of scope).
- **No true supplier grouping** — no supplier entity/column exists; `manufacturer` is used as the grouping proxy only.
- **No new UI** — findings reuse the existing generic `ops_findings_view` → FindingsQueue surface.
- **No schema change to `v_dia_part_current` / `v_dia_part_sale_current` / `finding`** — read-only consumer + one registry-row migration.

**Observable truths (after build):**
- `python -c "import temporal.src.worker"` succeeds (agent fully wired, no import error).
- `python -m pytest temporal/tests/test_ops_parts_inventory.py -v` passes.
- `python -m pytest temporal/tests/test_worker_registration.py -v` passes (all new `@activity.defn` registered).
- The migration applies cleanly against the shared DB and inserts a `parts_inventory_finding_v1` row in `ops_output_schema_registry`.
- The seeded config row for `parts-inventory-advisor` exists for `demo-ops-a`/`demo-ops-b` with `schedule.enabled=false`.
- `parts-inventory-advisor` is in `_OPS_AGENT_KEYS` (run-now-able) and registered in the worker workflow + activity lists with its cron reconcile wired.

**Success metrics:**
- A run over the demo dataset records ≥1 `replenish_now` finding (parts at zerado/critico/baixo exist) and ≥1 `dead_stock` finding (parts with no active sale exist), all `status='pending_approval'`, `auto_apply=False`.
- Re-running with the same open findings records 0 new and deduplicates the rest (fingerprint stability).
- 0 new `rental_*` imports in the new source files (import-hygiene test green).

---

## 4. Clarifications & Assumptions

No blocking questions — this is a clone with a known-good reference and complete data. Assumptions (each with a config override mirroring vehicle-aging's `thresholds`/`bounds`):

- **[ASSUMPTION A-001] Agent key + finding type names.** `agent_key = "parts-inventory-advisor"`; `_WORKFLOW_KEY` matches. Finding types: `replenish_now` and `dead_stock`. Output schema key `parts_inventory_finding_v1`. Rationale: mirrors the `vehicle-aging-analyst` / `stock_aging_90d` / `vehicle_aging_finding_v1` naming convention.
- **[ASSUMPTION A-002] Ships disabled by default.** Seed config `enabled=true` but `schedule.enabled=false`, exactly like vehicle-aging (`seed.sql:287`). Default cron `_PARTS_INVENTORY_DEFAULT_CRON = "0 6 * * 1"` (weekly, Monday 06:00) — replenishment is a weekly review cadence; reconcile deletes any stray schedule while disabled (`worker.py:384-394`).
- **[ASSUMPTION A-003] Velocity window.** Default `thresholds.velocity_window_days = 90`. Velocity per part = sum of `quantity` from `v_dia_part_sale_current` rows for that `part_id` whose `sale_date` is within the window of "today". `sale_date` is text `YYYY-MM-DD` (or ISO prefix); parse the leading 10 chars; rows that fail to parse are ignored (counted as 0). Overridable via config.
- **[ASSUMPTION A-004] Dead-stock rule.** A part is a `dead_stock` candidate when its windowed velocity is `<= thresholds.dead_stock_max_velocity` (default `0`, i.e. no movement in the window) AND `stock_value >= thresholds.dead_stock_min_value` (default `0`, so any held value qualifies) AND `quantity_in_stock > 0` (you cannot liquidate zero stock). Ranked by `stock_value` desc (capital tied up). Severity: `stock_value >= dead_stock_high_value` (default `1000`) → `high`, else `medium`.
- **[ASSUMPTION A-005] Replenish-now scope, ranking & suggested quantity.** Scope = `v_dia_parts_critical` (already `stock_status in zerado|critico|baixo`, with `criticality_rank`). Severity maps from `stock_status`: `zerado`→`critical`, `critico`→`high`, `baixo`→`medium`. A deterministic priority score ranks findings: `priority = (3 - criticality_rank) * 1000 + windowed_velocity * 10 + stock_value/100` (criticality dominates, then velocity, then tied-up value); sort desc. `quantity_suggested = max(0, reorder_point - quantity_in_stock)` rounded to int (a simple gap-to-reorder starting point, explicitly NOT an ERP buy-qty; MOQ/in-transit are non-goals). `value_at_risk` for replenish = `round(quantity_suggested * unit_cost, 2)`; for dead_stock = `stock_value`.
- **[ASSUMPTION A-006] One finding per part per type; fingerprint.** `fingerprint = sha256(f"{tenant_id}:{part_id}:{finding_type}")` (mirrors `_stock_aging_fingerprint`, but the finding type is part of the hash so a single part could theoretically surface once as `replenish_now` and once as `dead_stock` without colliding — in practice the two scopes are disjoint because dead_stock requires `quantity_in_stock>0` movement-free while replenish requires low/zero stock). Caps: `bounds.max_findings_per_run` default 50; scope cap `max_parts` default 200 (min 1, max 500), mirroring `ops_vehicle_aging`.
- **[ASSUMPTION A-007] Grouping proxy.** Where the REPORT says "group by supplier", surface `manufacturer` in the finding `evidence[]` and `rationale` as the grouping/sourcing hint. No supplier join (none exists).
- **[ASSUMPTION A-008] LLM action vocabulary.** `recommended_action ∈ {order_now, expedite, substitute, transfer, liquidate, monitor}`. The deterministic severity/value/quantity are re-pinned after the LLM returns (mirroring `ops_vehicle_aging.py:190-199`); only `recommended_action`, `evidence`, `confidence`, `rationale` are taken from the model. Required output fields: `part_id`, `recommended_action`, `rationale` (closed schema, `extra="forbid"`).

---

## 6. Requirements

EARS-light. One observable response each.

- **FR-001** WHEN the workflow runs, the system SHALL create an `ops_workflow_run` row keyed by `workflow_key="parts-inventory-advisor"` before any scoping, and finalize it with the run summary in a `finally` block. *(clone `vehicle_aging.py:56-66, 176-183`)*
- **FR-002** WHEN the workflow loads config, the system SHALL call `ops_load_agent_config(tenant_id, "parts-inventory-advisor")` and set `summary["auto_apply"]=False` regardless of stored config. *(clone `vehicle_aging.py:68-75`)*
- **FR-003** WHEN scoping replenishment, the system SHALL read `v_dia_parts_critical` and emit one candidate per part with deterministic `severity` (from `stock_status`), `quantity_suggested`, `value_at_risk`, windowed `velocity`, `priority`, and `fingerprint`, sorted by `priority` desc and capped at `max_parts`. *(A-005, A-006; data `20260625150200...sql:337-352`)*
- **FR-004** WHEN scoping dead-stock, the system SHALL read `v_dia_part_current` joined to windowed velocity from `v_dia_part_sale_current`, and emit one candidate per part meeting the dead-stock rule (A-004) with deterministic `severity`, `value_at_risk=stock_value`, `velocity`, and `fingerprint`, sorted by `stock_value` desc and capped at `max_parts`. *(A-004, A-006; data `20260626120000...sql:362-394`)*
- **FR-005** WHEN computing windowed velocity, the system SHALL sum `quantity` over `v_dia_part_sale_current` rows for the part whose parsed `sale_date` falls within `thresholds.velocity_window_days` of the run date, ignoring unparseable dates. *(A-003)*
- **FR-006** WHEN assessing a scoped part, the system SHALL render the configured `system_prompt`/`user_prompt_template` via `ops_revrec.interpolate_prompt_template`, call the no-tools analyst (`run_parts_inventory_advisor`), and re-pin `severity`, `quantity_suggested`, `value_at_risk`, `finding_type`, and `part_id` from the deterministic scope values after the model returns. *(clone `ops_vehicle_aging.py:137-200`)*
- **FR-007** WHEN the analyst is invoked, the system SHALL validate the model output against the closed `PartsInventoryFindingV1` schema (`extra="forbid"`, required = `part_id, recommended_action, rationale`) with an empty tools list (no `tool_choice` sent). *(clone `vehicle_aging_analyst.py:21-67`)*
- **FR-008** WHEN deduplicating, the system SHALL list open `pending_approval` fingerprints and skip any surfaced finding whose fingerprint is already open, counting it under `deduped_findings`. *(clone `vehicle_aging.py:136-150`)*
- **FR-009** WHEN recording, the system SHALL upsert each non-deduped, in-bounds finding into `finding` on `(tenant_id, fingerprint)` with `status="pending_approval"` via the `parts-inventory-advisor` named record wrapper, mapping it to the canonical row (`contract_id=part_id`, `line_item_id=None`, `expected{}`, `delta=value_at_risk`, `proposed_action=recommended_action`). *(clone `ops_vehicle_aging.py:223-257`; persistence `ops_revrec.py:655-676`)*
- **FR-010** WHEN the scope is empty, the system SHALL return early with `total_parts_scoped=0` and zero recorded/deduped findings, after still finalizing the run. *(clone `vehicle_aging.py:85-86, 176-183`)*
- **FR-011** WHEN the worker process imports, the system SHALL register `PartsInventoryWorkflow` in `Worker(workflows=[...])` and every `@activity.defn` in `ops_parts_inventory` (incl. named wrappers) in `Worker(activities=[...])`, and wire a best-effort `reconcile_parts_inventory_schedules` call in `main()`. *(clone `worker.py:1434, 1519-1526, 1359-1362`)*
- **FR-012** WHEN cron reconcile runs for the agent, the system SHALL use schedule id `ops:{tenant_id}:parts-inventory-advisor` and, while `schedule.enabled=false`, delete any stray schedule. *(clone `worker.py:373-423`; A-002)*
- **FR-013** WHEN the ops API resolves agent keys, the system SHALL include `parts-inventory-advisor` in `_OPS_AGENT_KEYS` so the agent is run-now-able. *(`ops_api/app.py:76-88`)*
- **FR-014** WHEN the migration is applied, the system SHALL upsert a `parts_inventory_finding_v1` row into `ops_output_schema_registry` whose `schema_json` matches `parts_inventory_finding_v1_schema()` (same `title`, `additionalProperties:false`, `required`, `properties` keys). *(clone `20260626140001_vehicle_aging_agent.sql`; validated by `ops_load_agent_config:515-526`)*
- **FR-015** WHEN the seed runs, the system SHALL upsert a `parts-inventory-advisor` config row for tenants `demo-ops-a`/`demo-ops-b` into both the entity store and `ops_agent_config`, with `output_schema_key='parts_inventory_finding_v1'`, the A-003/A-004/A-005 thresholds/bounds, `schedule.enabled=false`, and `auto_apply=false`. *(clone `seed.sql:277-366`)*
- **NFR-001** The new source files SHALL NOT import any `rental_*` helper module (import-hygiene). *(clone test `test_ops_vehicle_aging.py:696-711`)*
- **NFR-002** The LLM activity SHALL run with a 45s `heartbeat_timeout` and a retry cap of 2 attempts (`_AI_RETRY`). *(clone `vehicle_aging.py:88-98`; test `:640-658`)*
- **NFR-003** New Python SHALL pass `ruff check` under the repo config (py311, line-length 120, E/F/W/I/UP/B/SIM). *(`temporal/pyproject.toml:53-60`)*
- **SEC-001** The agent SHALL be assist-only: no PO/requisition/inventory write; `auto_apply` forced `False`; all DB reads via the service-role persistence client; the only write is to `finding`/`ops_workflow_run` with `status='pending_approval'`. *(STRIDE-lite in §8)*

---

## 7. Acceptance Criteria

Given/When/Then. Each links a requirement; error/no-op cases included.

- **AC-001 [FR-007]** *Given* a `_FakeTransport` returning `{"part_id":"p1","recommended_action":"order_now","rationale":"x"}`, *When* `run_parts_inventory_advisor` is awaited with no tools, *Then* `transport.tools_seen == [[]]`, exactly one call is made, and the result is the validated dict with defaults filled (`finding_type`, `severity`, `quantity_suggested=0`, `value_at_risk=0.0`, `evidence=[]`, `confidence=0.0`).
- **AC-002 [FR-007]** *Given* a model response containing an extra key, *When* `run_parts_inventory_advisor` is awaited (two bad responses), *Then* it raises `StructuredOutputRetriesExceededError` (extra=forbid enforced end-to-end).
- **AC-003 [FR-014]** *Given* `parts_inventory_finding_v1_schema()` and the migration's embedded jsonb literal, *When* both are parsed, *Then* `title`, `additionalProperties:false`, sorted `required`, and the `properties` key set are equal.
- **AC-004 [FR-003, A-005]** *Given* a faked `v_dia_parts_critical` with parts at zerado/critico/baixo plus a part-sales table giving them velocities, *When* `ops_scope_parts_replenish(tenant, {})` runs, *Then* every row has the expected `severity` (zerado→critical, critico→high, baixo→medium), `quantity_suggested = max(0, reorder_point - quantity_in_stock)`, `finding_type="replenish_now"`, `fingerprint = sha256(f"{tenant}:{part_id}:replenish_now")`, and rows are sorted by `priority` desc.
- **AC-005 [FR-004, FR-005, A-003, A-004]** *Given* a faked `v_dia_part_current` with one part that has zero windowed sales and `quantity_in_stock>0` and one part with recent sales, *When* `ops_scope_parts_dead_stock(tenant, {})` runs, *Then* only the zero-velocity, in-stock part is returned with `finding_type="dead_stock"`, `value_at_risk == stock_value`, `velocity == 0`, and `fingerprint = sha256(f"{tenant}:{part_id}:dead_stock")`.
- **AC-006 [FR-005]** *Given* part-sale rows with `sale_date` 10 days ago, 200 days ago, and a malformed date, and a 90-day window, *When* velocity is computed, *Then* only the 10-day-ago row's quantity is counted (200-days-ago is outside the window; malformed is ignored).
- **AC-007 [FR-006, A-008]** *Given* a scoped part with deterministic `severity="critical"`, `quantity_suggested=5`, `value_at_risk=100.0` and an LLM returning `recommended_action="monitor"`, *When* `ops_parts_inventory_assess` runs, *Then* the returned dict keeps `severity="critical"`, `quantity_suggested=5`, `value_at_risk=100.0`, `finding_type` from scope, `part_id` from scope, and `recommended_action="monitor"` from the model.
- **AC-008 [FR-009]** *Given* a surfaced finding `{part_id, finding_type, severity, value_at_risk, recommended_action, ...}`, *When* `_parts_finding_for_storage` maps it, *Then* `contract_id == part_id`, `line_item_id is None`, `delta == value_at_risk`, `proposed_action == recommended_action`, `billed == {}`, and `tenant_id`/`fingerprint` survive the spread.
- **AC-009 [FR-001, FR-002, FR-008, FR-009]** *Given* a stubbed activity layer (patched `temporalio.workflow.execute_activity`) with 3 scoped parts and no open fingerprints, *When* `PartsInventoryWorkflow.run` executes, *Then* `status="succeeded"`, `total_parts_scoped==3`, `recorded_findings==3`, `deduped_findings==0`, `auto_apply is False`, and findings are recorded in `priority`-desc order.
- **AC-010 [FR-008]** *Given* the same 3 scoped parts but all 3 fingerprints already open, *When* the workflow runs, *Then* `recorded_findings==0` and `deduped_findings==3` (idempotent re-run).
- **AC-011 [FR-010]** *Given* an empty scope, *When* the workflow runs, *Then* `total_parts_scoped==0`, `recorded_findings==0`, the run is still finalized, and `created_workflow_key=="parts-inventory-advisor"`.
- **AC-012 [NFR-002]** *Given* the workflow runs, *When* the assess activity is scheduled, *Then* its `heartbeat_timeout.total_seconds()==45` and `retry_policy.maximum_attempts==2`.
- **AC-013 [FR-011]** *Given* the worker module, *When* `_extract_worker_workflow_references()` / `_extract_worker_activity_references()` are inspected, *Then* `PartsInventoryWorkflow` is registered and every `@activity.defn` in `ops_parts_inventory` is in the activity list (worker-registration test green).
- **AC-014 [NFR-001]** *Given* the new source files, *When* their ASTs are walked for imports, *Then* none import a module containing `rental`.
- **AC-015 [FR-013, FR-012]** *Given* the worker + ops_api, *When* `_OPS_AGENT_KEYS` and the schedule builders are read, *Then* `parts-inventory-advisor` is present and maps to schedule id `ops:{tenant}:parts-inventory-advisor`.
- **AC-016 [SEC-001]** *Given* the whole change, *When* grepped, *Then* there is no write to any part/PO/requisition/inventory entity from the new code; the only persistence calls are the generic `finding`/`ops_workflow_run` wrappers, and the workflow forces `auto_apply=False`.

---

## 8. Implementation Contract

**Target files (exact paths):**
- Create `temporal/src/agents/parts_inventory_advisor.py` — closed Pydantic model + `run_parts_inventory_advisor`.
- Create `temporal/src/activities/ops_parts_inventory.py` — scope (replenish + dead-stock), velocity helper, assess, finding-shaper, named wrappers.
- Create `temporal/src/workflows/ops/parts_inventory.py` — the workflow.
- Edit `temporal/src/workflows/ops/__init__.py` — export `PartsInventoryWorkflow` + input.
- Edit `temporal/src/worker.py` — import, agent-key/cron constants, schedule reconcile block, `main()` call, workflow + activity registration.
- Edit `temporal/src/ops_api/app.py` — add key to `_OPS_AGENT_KEYS`.
- Create `supabase/migrations/20260627130000_parts_inventory_agent.sql` — output-schema registry row.
- Edit `supabase/seed.sql` — config row block for the new agent.
- Create `temporal/tests/test_ops_parts_inventory.py` — the cloned test suite.

**Allowed deps (already in repo):** `temporalio==1.5.0`, `pydantic==2.7.3`, stdlib (`hashlib`, `json`, `datetime`, `asyncio`, `logging`). Internal: `ops_revrec`, `agents.openai_client.chat_with_tools`, `ops_vehicle_aging` test helpers for reference only.
**Forbidden:** any `rental_*` import (NFR-001); any new third-party dep; any write to part/PO/requisition entities; editing already-published migrations; `supabase db reset` (shared DB).

**Data / migration / rollback:**
- Migration adds exactly one `ops_output_schema_registry` row (`schema_key='parts_inventory_finding_v1'`), `on conflict (schema_key) do update`. Idempotent.
- Rollback: `delete from public.ops_output_schema_registry where schema_key='parts_inventory_finding_v1';` and remove the seed config block (DELETE the two `agent_config` entities + `ops_agent_config` rows for `parts-inventory-advisor`). No data migration, no destructive DDL.

**Security-trigger check:** **YES** — this runs a migration AND touches the finding store. STRIDE-lite:
- **Spoofing/Auth:** reads use the existing service-role persistence client (`ops_revrec._get_ops_persistence_client`), same trust boundary as every other ops agent; the read views are `security_invoker` (`20260625150200...sql:287`). No new endpoint, no new credential.
- **Tampering/Integrity:** the only writes are upserts to `finding`/`ops_workflow_run` with `status='pending_approval'`; deterministic money fields (`value_at_risk`, `quantity_suggested`, `severity`) are computed in-scope and re-pinned after the LLM, so model output cannot move money or alter ranking.
- **Repudiation/Audit:** `ops_record_finding` writes an audit event (`ops_revrec.py:677-683`); run lifecycle captured in `ops_workflow_run`.
- **Info disclosure:** only aggregate parts/sales views are read; no PII beyond customer name already present in existing views; findings carry only part facts.
- **DoS:** scope capped (`max_parts` 1..500), findings bounded (`max_findings_per_run`), LLM activity heartbeats every 15s with a 45s timeout and 2-attempt cap.
- **Elevation:** **assist-only** — `auto_apply` forced `False` (`ops_revrec.py:538`, workflow `:75`); a human authorizes any purchase via the existing findings decision flow. No autonomous PO.

**Stop gates:**
- Stop and surface if `temporalio==1.5.0` is not importable or `chat_with_tools` signature differs from what `vehicle_aging_analyst.py:59-66` uses.
- Stop if `docker exec ... psql` reports the migration errors (do NOT fall back to `supabase db reset`).
- Stop if the worker-registration test or import smoke fails — do not paper over with try/except.

---

## 9. Executable Task Layer

8 core tasks, ordered by dependency. `[P]` = parallelizable.

---
- [ ] **T-001** [P] [reqs: FR-007, AC-001, AC-002] [depends: —]
  - **Files:** create `temporal/src/agents/parts_inventory_advisor.py`
  - **Precondition / skip-if:** file already defines `PartsInventoryFindingV1` and `run_parts_inventory_advisor` → skip.
  - **Read first:** `temporal/src/agents/vehicle_aging_analyst.py:1-75` (the exact module to clone).
  - **Action:** Clone the module. Define `PartsInventoryFindingV1(BaseModel)` with `model_config = ConfigDict(extra="forbid")` and fields: `part_id: str`; `finding_type: str = "replenish_now"`; `severity: str = "medium"`; `recommended_action: str`; `quantity_suggested: int = 0`; `value_at_risk: float = 0.0`; `evidence: list[str] = Field(default_factory=list)`; `confidence: float = 0.0`; `rationale: str`. (Required-by-Pydantic = the no-default fields `part_id`, `recommended_action`, `rationale`.) Add `parts_inventory_finding_v1_schema()` returning `PartsInventoryFindingV1.model_json_schema()`. Add `_no_tool_executor` and `async def run_parts_inventory_advisor(part_payload, *, system_prompt, user_prompt_template, max_tool_rounds=0, transport=None)` that calls `chat_with_tools(messages=[system,user], tools=[], tool_executor=_no_tool_executor, response_format=PartsInventoryFindingV1, max_tool_rounds=..., transport=...)` and returns `result.response.model_dump(mode="json")`. Export all three names in `__all__`.
  - **Re-run safety:** pure file create/overwrite; deterministic content.
  - **Verify:** `python -c "from temporal.src.agents.parts_inventory_advisor import PartsInventoryFindingV1, parts_inventory_finding_v1_schema, run_parts_inventory_advisor; s=parts_inventory_finding_v1_schema(); assert s['additionalProperties'] is False and sorted(s['required'])==['part_id','rationale','recommended_action'], s['required']; print('OK')"` → prints `OK`.
  - **Done:** the closed schema imports and its `required` is exactly `['part_id','rationale','recommended_action']`.

---
- [ ] **T-002** [reqs: FR-003, FR-004, FR-005, FR-006, FR-009, A-003, A-004, A-005, A-006, A-008, NFR-002] [depends: T-001]
  - **Files:** create `temporal/src/activities/ops_parts_inventory.py`
  - **Read first:** `temporal/src/activities/ops_vehicle_aging.py:1-281` (full clone target); `supabase/migrations/20260625150200_dia_part_entity_crud.sql:292-352` (view columns); `supabase/migrations/20260626120000_dia_part_sale_entity_crud.sql:362-394` (sales columns); `temporal/src/activities/ops_revrec.py:611-684` (persistence wrappers it delegates to).
  - **Action:** Clone `ops_vehicle_aging.py`. Set `_AGENT_KEY="parts-inventory-advisor"`. Keep `_coerce_int`/`_coerce_float`. Implement:
    - `_parts_fingerprint(tenant_id, part_id, finding_type) -> sha256(f"{tenant_id}:{part_id}:{finding_type}").hexdigest()`.
    - `_windowed_velocity(sale_rows, part_id, window_days, now) -> float`: sum `quantity` for rows where `part_id` matches and `sale_date[:10]` parses (`datetime.date.fromisoformat`) within `window_days` of `now`; ignore unparseable (A-003).
    - `_severity_for_stock_status(stock_status) -> str`: `zerado→critical, critico→high, baixo→medium, else medium` (A-005).
    - `@activity.defn ops_scope_parts_replenish(tenant_id, run_context)`: read `v_dia_parts_critical` (cols incl. `entity_id, part_number, manufacturer, unit_cost, quantity_in_stock, min_stock, reorder_point, stock_value, stock_status, criticality_rank`) + `v_dia_part_sale_current` for velocity; for each row compute `velocity`, `quantity_suggested=max(0,int(reorder_point-quantity_in_stock))`, `value_at_risk=round(quantity_suggested*unit_cost,2)`, `severity`, `priority=(3-criticality_rank)*1000 + velocity*10 + stock_value/100`, `finding_type="replenish_now"`, `fingerprint`; sort by `priority` desc then `part_id`; cap at `max_parts` (default 200, clamp 1..500; window from `thresholds.velocity_window_days` default 90). Each dict carries `part_id, tenant_id, part_number, manufacturer, unit_cost, quantity_in_stock, min_stock, reorder_point, stock_value, stock_status, velocity, quantity_suggested, value_at_risk, severity, priority, finding_type, fingerprint`.
    - `@activity.defn ops_scope_parts_dead_stock(tenant_id, run_context)`: read `v_dia_part_current` + `v_dia_part_sale_current`; for each part compute windowed `velocity`; keep parts with `velocity <= dead_stock_max_velocity` (default 0) AND `stock_value >= dead_stock_min_value` (default 0) AND `quantity_in_stock>0`; set `value_at_risk=stock_value`, `quantity_suggested=0`, `severity= "high" if stock_value>=dead_stock_high_value(default 1000) else "medium"`, `finding_type="dead_stock"`, `fingerprint`; sort by `stock_value` desc then `part_id`; cap at `max_parts`.
    - `@activity.defn async ops_parts_inventory_assess(part_payload, config)`: clone `ops_vehicle_aging_assess` — render prompts via `ops_revrec.interpolate_prompt_template` with variables (`tenant_id, part_id, part_number, manufacturer, stock_status, quantity_in_stock, reorder_point, stock_value, velocity, quantity_suggested, value_at_risk, finding_type, evidence_json=json.dumps(part_payload, sort_keys=True)`); 15s heartbeat loop; call `run_parts_inventory_advisor`; after return re-pin `part_id`, `finding_type`, `severity`, `quantity_suggested`, `value_at_risk` from `part_payload`; `setdefault` `recommended_action="monitor"`, `evidence=[]`, `confidence=0.0`, `rationale`.
    - `_parts_finding_for_storage(finding)`: clone `_vehicle_finding_for_storage` — `contract_id=part_id`, `line_item_id=None`, `expected={part_number, manufacturer, stock_status, quantity_in_stock, reorder_point, stock_value, velocity, quantity_suggested, recommended_action}`, `billed={}`, `delta=value_at_risk`, `proposed_action=recommended_action`, `finding_type` defaulting to `replenish_now`.
    - Named wrappers delegating to `ops_revrec` (copy verbatim with the new prefix): `@activity.defn(name="ops_parts_inventory_load_agent_config") ops_load_agent_config`; `..._list_open_finding_fingerprints`; `..._create_workflow_run`; `..._finalize_workflow_run`; `..._record_finding` (wrapping `_parts_finding_for_storage`); `..._record_finding_disposition`.
    - `__all__` listing all `@activity.defn` callables + the two scope fns + assess.
  - **Re-run safety:** file create/overwrite; helpers are pure; activities read-only except the delegated finding upsert (idempotent on `(tenant_id,fingerprint)`).
  - **Verify:** `python -c "from temporal.src.activities import ops_parts_inventory as m; import inspect; defs=[n for n,o in inspect.getmembers(m) if hasattr(o,'__temporal_activity_definition')]; assert {'ops_scope_parts_replenish','ops_scope_parts_dead_stock','ops_parts_inventory_assess','ops_load_agent_config','ops_record_finding'} <= set(defs), defs; assert m._parts_fingerprint('t','p','dead_stock')==__import__('hashlib').sha256(b't:p:dead_stock').hexdigest(); print('OK')"` → prints `OK`.
  - **Done:** module imports; the five core activities are decorated; fingerprint matches the spec hash.

---
- [ ] **T-003** [reqs: FR-001, FR-002, FR-006, FR-008, FR-009, FR-010, NFR-002, AC-009, AC-010, AC-011, AC-012] [depends: T-002]
  - **Files:** create `temporal/src/workflows/ops/parts_inventory.py`
  - **Read first:** `temporal/src/workflows/ops/vehicle_aging.py:1-184` (the exact clone target).
  - **Action:** Clone the workflow. Keep the retry/heartbeat constants and `_DEFAULT_MAX_FINDINGS_PER_RUN=50`. `_WORKFLOW_KEY="parts-inventory-advisor"`. `@dataclass PartsInventoryWorkflowInput(tenant_id: str, run_window_start: str|None=None, run_window_end: str|None=None)`. `@workflow.defn class PartsInventoryWorkflow` with summary keys `{status, total_parts_scoped, processed_findings, recorded_findings, deduped_findings, remaining_findings_count, auto_apply}`. Run: create run via `ops_parts_inventory.ops_create_workflow_run` (`_MONEY_RETRY`) → load config via `ops_parts_inventory.ops_load_agent_config` (`_STANDARD_RETRY`), set `summary["auto_apply"]=False` → call BOTH scopes (`ops_scope_parts_replenish` then `ops_scope_parts_dead_stock`, each `_STANDARD_RETRY`), concatenate into `scoped_parts`; `summary["total_parts_scoped"]=len(...)`; early-return if empty → `asyncio.gather` over `ops_parts_inventory_assess` (`start_to_close_timeout=2min`, `heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT`, `retry_policy=_AI_RETRY`) → build surfaced dicts carrying `part_id, tenant_id, agent_key=_WORKFLOW_KEY, workflow_id=f"ops-parts-inventory:{run_id}", finding_type, severity, quantity_suggested, value_at_risk, manufacturer, stock_status, velocity, recommended_action, evidence, confidence, rationale, fingerprint, priority` → sort by `(-priority, fingerprint)` → list open fingerprints + dedup → bound by `bounds.max_findings_per_run` → record loop via `ops_parts_inventory.ops_record_finding` → `finally` finalize. (Match `vehicle_aging.py` control flow exactly, two scopes instead of one.)
  - **Re-run safety:** workflow is deterministic; dedup + idempotent finding upsert make re-runs safe.
  - **Verify:** `python -c "from temporal.src.workflows.ops.parts_inventory import PartsInventoryWorkflow, PartsInventoryWorkflowInput; assert hasattr(PartsInventoryWorkflow,'__temporal_workflow_definition'); print('OK')"` → prints `OK`.
  - **Done:** workflow class is decorated and imports with its input dataclass.

---
- [ ] **T-004** [reqs: FR-011 (export), AC-013] [depends: T-003]
  - **Files:** edit `temporal/src/workflows/ops/__init__.py`
  - **Read first:** `temporal/src/workflows/ops/__init__.py:1-86` (export style).
  - **Action:** Add `from .parts_inventory import PartsInventoryWorkflow, PartsInventoryWorkflowInput` and append both names to `__all__` (keep alphabetic-ish grouping consistent with neighbors).
  - **Re-run safety:** idempotent edit; skip if the import line already present.
  - **Verify:** `python -c "from temporal.src.workflows.ops import PartsInventoryWorkflow, PartsInventoryWorkflowInput; print('OK')"` → prints `OK`.
  - **Done:** both symbols importable from the package.

---
- [ ] **T-005** [reqs: FR-011, FR-012, NFR-002, AC-013, AC-015] [depends: T-002, T-003]
  - **Files:** edit `temporal/src/worker.py`
  - **Read first:** `temporal/src/worker.py:43, 82, 102-103, 357-423, 1357-1362, 1434, 1519-1526` (every clone insertion point for vehicle-aging).
  - **Action:** (a) add `ops_parts_inventory` to the `from .activities import (...)` group (`:25-46`); (b) add `from .workflows.ops.parts_inventory import PartsInventoryWorkflow, PartsInventoryWorkflowInput` near `:82`; (c) add constants `_PARTS_INVENTORY_AGENT_KEY = "parts-inventory-advisor"` and `_PARTS_INVENTORY_DEFAULT_CRON = "0 6 * * 1"` near `:102-103`; (d) clone the entire vehicle-aging schedule block (`:357-423`) as `_fetch_parts_inventory_schedule_rows` / `_build_parts_inventory_schedule` (using `PartsInventoryWorkflow.run`, `PartsInventoryWorkflowInput(tenant_id=tenant_id)`, `id=f"ops-parts-inventory-{tenant_id}"`) / `_reconcile_tenant_parts_inventory_schedule` / `reconcile_parts_inventory_schedules`, using `_PARTS_INVENTORY_DEFAULT_CRON` and `_schedule_id_for_tenant(tenant_id, _PARTS_INVENTORY_AGENT_KEY)`; (e) add a best-effort `try/except` calling `await reconcile_parts_inventory_schedules(client)` in `main()` next to the vehicle-aging one (`:1359-1362`); (f) add `PartsInventoryWorkflow,` to `Worker(workflows=[...])` (`:1434`); (g) add the 8 activities (`ops_parts_inventory.ops_load_agent_config, .ops_scope_parts_replenish, .ops_scope_parts_dead_stock, .ops_parts_inventory_assess, .ops_list_open_finding_fingerprints, .ops_create_workflow_run, .ops_finalize_workflow_run, .ops_record_finding, .ops_record_finding_disposition`) to `Worker(activities=[...])` right after the `ops_vehicle_aging.*` block (`:1519-1526`).
  - **Re-run safety:** each edit is an additive insert keyed by a unique symbol; skip any insert whose symbol is already present.
  - **Verify:** `python -c "import temporal.src.worker as w; assert w._PARTS_INVENTORY_AGENT_KEY=='parts-inventory-advisor'; assert hasattr(w,'reconcile_parts_inventory_schedules'); print('OK')"` → prints `OK`; then `python -m pytest temporal/tests/test_worker_registration.py -v` → all tests pass (`PASS`/green, exit 0).
  - **Done:** worker imports cleanly, the reconcile fn exists, and the worker-registration test is green.

---
- [ ] **T-006** [P] [reqs: FR-013, AC-015] [depends: —]
  - **Files:** edit `temporal/src/ops_api/app.py`
  - **Read first:** `temporal/src/ops_api/app.py:76-96` (the `_OPS_AGENT_KEYS` tuple + `_AGENT_SCHEDULE_ID_BUILDERS`).
  - **Action:** Add `"parts-inventory-advisor",` to `_OPS_AGENT_KEYS` (placement near `"vehicle-aging-analyst",`). No other change — the schedule-id builder is derived from the tuple.
  - **Re-run safety:** skip if the key already present.
  - **Verify:** `python -c "from temporal.src.ops_api.app import _OPS_AGENT_KEYS, _AGENT_SCHEDULE_ID_BUILDERS as B; assert 'parts-inventory-advisor' in _OPS_AGENT_KEYS; assert B['parts-inventory-advisor']('t')=='ops:t:parts-inventory-advisor'; print('OK')"` → prints `OK`.
  - **Done:** the key is run-now-able and maps to `ops:{tenant}:parts-inventory-advisor`.

---
- [ ] **T-007** [reqs: FR-014, FR-015, AC-003] [depends: T-001]
  - **Files:** create `supabase/migrations/20260627130000_parts_inventory_agent.sql`; edit `supabase/seed.sql`
  - **Read first:** `supabase/migrations/20260626140001_vehicle_aging_agent.sql:1-34` (registry-row migration); `supabase/seed.sql:266-366` (config block to clone); the schema printed by T-001's Verify (use it verbatim as the registry `schema_json`).
  - **Action — migration:** Clone the registry insert with `schema_key='parts_inventory_finding_v1'`, `description='Parts inventory advisor finding output schema v1 (replenish_now/dead_stock)'`, and `schema_json` = the exact JSON Schema from `parts_inventory_finding_v1_schema()` (object, `additionalProperties:false`, `title:"PartsInventoryFindingV1"`, `required:["part_id","recommended_action","rationale"]`, `properties` for all 9 fields with matching defaults). Use `on conflict (schema_key) do update set schema_json=excluded.schema_json, description=excluded.description, updated_at=now()`.
  - **Action — seed:** Clone the `DO $$` block at `seed.sql:266-366` as a new block for `parts-inventory-advisor`: `v_schema_key='parts_inventory_finding_v1'`; `v_system_prompt` = an assist-only parts-manager prompt (recommend `order_now|expedite|substitute|transfer|liquidate|monitor`; never order automatically; group/source hint by manufacturer; explain whether replenishment is true demand vs a one-off spike using velocity); `v_user_prompt` interpolating `{part_id} {part_number} {manufacturer} {finding_type} {stock_status} {quantity_in_stock} {reorder_point} {stock_value} {velocity} {quantity_suggested} {value_at_risk}` + `{evidence_json}`; `v_tools='[]'`; `v_thresholds='{"velocity_window_days":90,"dead_stock_max_velocity":0,"dead_stock_min_value":0,"dead_stock_high_value":1000}'`; `v_bounds='{"max_findings_per_run":50,"max_parts":200,"max_tool_rounds":2}'`; `v_schedule='{"cron":"0 6 * * 1","enabled":false}'`; `auto_apply=false`. Keep the DELETE-then-INSERT idempotency, both the entity-store and `ops_agent_config` writes, and tenants `demo-ops-a`/`demo-ops-b`.
  - **Re-run safety:** migration `on conflict` upsert; seed block is DELETE-then-INSERT + ON CONFLICT — replay-safe.
  - **Verify (no shared DB needed):** `python - <<'PY'` checking the migration's embedded JSON equals the Python schema:
    `import json,re,pathlib; from temporal.src.agents.parts_inventory_advisor import parts_inventory_finding_v1_schema as S; mig=pathlib.Path("supabase/migrations/20260627130000_parts_inventory_agent.sql").read_text(); m=re.search(r"'(\{.*?\})'::jsonb",mig,re.S); reg=json.loads(m.group(1)); s=S(); assert reg["title"]==s["title"]=="PartsInventoryFindingV1"; assert reg["additionalProperties"] is False; assert sorted(reg["required"])==sorted(s["required"]); assert set(reg["properties"])==set(s["properties"]); assert "parts-inventory-advisor" in pathlib.Path("supabase/seed.sql").read_text(); print("OK")` `PY` → prints `OK`. **If Docker is up**, also run `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20260627130000_parts_inventory_agent.sql` → no error (do NOT `supabase db reset`).
  - **Done:** registry JSON matches the Python schema and the seed mentions the new agent; migration applies without error when the shared DB is reachable.

---
- [ ] **T-008** [reqs: all FR/AC/NFR — verification suite] [depends: T-001..T-007]
  - **Files:** create `temporal/tests/test_ops_parts_inventory.py`
  - **Read first:** `temporal/tests/test_ops_vehicle_aging.py:1-712` (the full clone target: `_FakeTransport`, `_FakeSelectClient`, `_build_harness`, registration + import-hygiene tests).
  - **Action:** Clone the test file, retargeted to the parts agent. Include:
    - **Helpers/schema:** `_parts_fingerprint` exactness (AC-005 hash); `_parts_finding_for_storage` mapping (AC-008); `PartsInventoryFindingV1` rejects extra (AC-002 helper) and defaults; schema↔migration parity reading `supabase/migrations/20260627130000_parts_inventory_agent.sql` (AC-003).
    - **Analyst:** `_FakeTransport` → `run_parts_inventory_advisor` sends no tools + returns validated dict (AC-001); two-bad-response → `StructuredOutputRetriesExceededError` (AC-002).
    - **Scope:** `_FakeSelectClient` seeded with `v_dia_parts_critical` rows (zerado/critico/baixo) + `v_dia_part_sale_current` rows; assert replenish severity/`quantity_suggested`/`priority` ordering/fingerprint (AC-004); a `v_dia_part_current` set where one part has zero windowed sales (`quantity_in_stock>0`) and another has recent sales → only the dead one returned (AC-005); velocity windowing with a 10-day, 200-day and malformed date (AC-006). Monkeypatch `ops_revrec._ops_client` per the vehicle-aging fixture (`:349`).
    - **Assess:** re-pin test — deterministic fields survive, model `recommended_action` taken (AC-007).
    - **Workflow:** clone `_build_harness` (handle BOTH `ops_scope_parts_replenish` and `ops_scope_parts_dead_stock` in the fake `execute_activity`); records-all (AC-009), dedup-all (AC-010), dedup-some, force `auto_apply=False`, bounding, empty-scope finalize + `created_workflow_key` (AC-011), and the heartbeat/retry assertion (AC-012).
    - **Registration + hygiene:** `PartsInventoryWorkflow` registered + all `ops_parts_inventory` activities registered via `test_worker_registration` helpers (AC-013); `_NEW_SOURCE_FILES = ("temporal/src/agents/parts_inventory_advisor.py","temporal/src/activities/ops_parts_inventory.py","temporal/src/workflows/ops/parts_inventory.py")` → no `rental` imports (AC-014).
  - **Re-run safety:** test file create/overwrite; tests are pure (fakes only, no network/DB).
  - **Verify:** `python -m pytest temporal/tests/test_ops_parts_inventory.py -v` → all tests pass (exit 0); then `python -m pytest temporal/tests/test_worker_registration.py temporal/tests/test_ops_parts_inventory.py -v` → green; then `cd temporal && ruff check src/agents/parts_inventory_advisor.py src/activities/ops_parts_inventory.py src/workflows/ops/parts_inventory.py` → `All checks passed!`.
  - **Done:** the parts-inventory test suite + worker-registration test are green and the three new modules lint clean.

---

## 10. Coverage Matrix

| Requirement | Acceptance | Task(s) | Verify command | Source evidence |
|---|---|---|---|---|
| FR-001 | AC-009, AC-011 | T-003, T-008 | `pytest temporal/tests/test_ops_parts_inventory.py -v` | `vehicle_aging.py:56-66,176-183` |
| FR-002 | AC-009 | T-003, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `vehicle_aging.py:68-75`; `ops_revrec.py:538` |
| FR-003 | AC-004 | T-002, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `20260625150200...sql:337-352` |
| FR-004 | AC-005 | T-002, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `20260626120000...sql:362-394` |
| FR-005 | AC-006 | T-002, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `20260626120000...sql:381` (sale_date) |
| FR-006 | AC-007 | T-002, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `ops_vehicle_aging.py:137-200` |
| FR-007 | AC-001, AC-002 | T-001, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `vehicle_aging_analyst.py:21-67` |
| FR-008 | AC-009, AC-010 | T-003, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `vehicle_aging.py:136-150` |
| FR-009 | AC-008, AC-009 | T-002, T-003, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `ops_vehicle_aging.py:223-257`; `ops_revrec.py:655-676` |
| FR-010 | AC-011 | T-003, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `vehicle_aging.py:85-86` |
| FR-011 | AC-013 | T-004, T-005, T-008 | `pytest temporal/tests/test_worker_registration.py -v` | `worker.py:1434,1519-1526` |
| FR-012 | AC-015 | T-005 | `python -c "import temporal.src.worker..."` (T-005) | `worker.py:373-423,110-111` |
| FR-013 | AC-015 | T-006 | `python -c "...ops_api.app..."` (T-006) | `ops_api/app.py:76-96` |
| FR-014 | AC-003 | T-001, T-007 | T-007 Verify (schema↔migration parity) | `20260626140001_vehicle_aging_agent.sql:1-34`; `ops_revrec.py:515-526` |
| FR-015 | (seed config) | T-007 | T-007 Verify (`"parts-inventory-advisor" in seed.sql`) | `seed.sql:277-366` |
| NFR-001 | AC-014 | T-008 | `pytest .../test_ops_parts_inventory.py -v` | `test_ops_vehicle_aging.py:696-711` |
| NFR-002 | AC-012 | T-003, T-008 | `pytest .../test_ops_parts_inventory.py -v` | `vehicle_aging.py:88-98`; test `:640-658` |
| NFR-003 | (lint) | T-008 | `cd temporal && ruff check <3 new files>` | `temporal/pyproject.toml:53-60` |
| SEC-001 | AC-016 | T-002, T-003, T-007 | code review + `pytest .../test_ops_parts_inventory.py -v` (auto_apply False) | `ops_revrec.py:538`; `vehicle_aging.py:75` |

Every FR/NFR/SEC maps to ≥1 task and ≥1 acceptance; every task maps back to ≥1 requirement. No orphans.

---

## 11. Self-Verification Report

Binary checklist:

- [x] **No placeholders** — every task has concrete paths, actions, and runnable Verify commands; no "TBD"/"similar to"/"add appropriate X".
- [x] **Every requirement maps to ≥1 task** (Coverage Matrix) — FR-001..FR-015, NFR-001..003, SEC-001 all covered.
- [x] **Every task maps to ≥1 requirement** — T-001..T-008 each list `[reqs: ...]`.
- [x] **Every task has Files / Action / Verify / Done** — present for all 8.
- [x] **Every code fact carries `path:line`** — §2 ledger, §6 requirements, §8, and each task's "Read first" cite real lines.
- [x] **Code-wins conflicts recorded** — supplier-column drift, in-transit non-goal, Python-version, velocity-source resolved in §2 conflicts table.
- [x] **Size/split gates respected** — 8 tasks, 9 target files (one is a single-key edit), 1 user journey; within bounds.
- [x] **Security-trigger check done** — YES (migration + finding store); STRIDE-lite block in §8; SEC-001 + AC-016.
- [x] **Migration timestamp is valid** — `20260627130000` is later than the latest existing migration `20260627120000` (verified via `ls supabase/migrations/`).
- [x] **Verify commands are real and available** — `python -m pytest <file> -v`, `python -c "import ..."`, `ruff check`, and (DB-optional) `docker exec ... psql -f` per CLAUDE.md; no `supabase db reset`.
- [x] **Each task is idempotent/restartable** — Precondition/skip-if + Re-run safety on every task; additive worker/ops_api/seed edits keyed by unique symbols; migration + finding upserts idempotent.

**Verdict: EXECUTABLE ✅**

No `[NEEDS CLARIFICATION]` remain — all open questions were resolvable from the reference agent and the verified demo dataset, and are captured as `[ASSUMPTION A-001..A-008]` with config overrides.
