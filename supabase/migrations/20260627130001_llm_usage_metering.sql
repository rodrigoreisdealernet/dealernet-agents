-- LLM usage metering foundation (issue #70).
-- Records, prices, and exposes the LLM token cost of each Operations Factory
-- agent execution, provider-agnostic, with Azure cost + per-tenant markup.
--
-- Three worker-write / UI-read tables (mirrors credit_change_proposal RLS):
--   * ops_llm_rate_card     -- dated price per provider/model/unit (global, authenticated-read)
--   * ops_tenant_llm_plan   -- per-tenant markup override (tenant_id null = plan default)
--   * ops_llm_usage_event   -- one row per real provider call (tenant-scoped read)
-- Plus three rollup views for per-customer cost reporting.
--
-- DB is SHARED: validate only inside BEGIN;...ROLLBACK; via docker exec psql.
-- Additive + idempotent; rollback = drop the new views/tables (nothing existing is altered).

-- Rate card: dated price per (provider, model, unit_of_measure, effective_from). ----------
create table if not exists public.ops_llm_rate_card (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'azure_openai',
  provider_model text not null,
  unit_of_measure text not null default 'per_1k',
  billing_mode text not null default 'payg',
  currency text not null default 'USD',
  price_input numeric not null,
  price_output numeric not null,
  price_cached_input numeric not null default 0,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  source text,
  version int not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists idx_ops_llm_rate_card_lookup
  on public.ops_llm_rate_card (provider, provider_model, effective_from desc);

-- Tenant plan: markup_pct resolved per tenant (override) or null tenant (plan default). ----
create table if not exists public.ops_tenant_llm_plan (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  plan_key text,
  markup_pct numeric not null default 0,
  markup_floor numeric not null default 0,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_ops_tenant_llm_plan_lookup
  on public.ops_tenant_llm_plan (tenant_id, effective_from desc);

-- Usage event: exactly one row per real provider HTTP call. ---------------------------------
create table if not exists public.ops_llm_usage_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id text references public.ops_workflow_run(run_id) on delete set null,
  workflow_id text,
  activity_id text,
  activity_attempt int,
  agent_key text not null,
  item_key text,
  provider text not null default 'azure_openai',
  provider_model text,
  deployment text,
  api_version text,
  meter_name text,
  unit_of_measure text,
  round_index int,
  schema_attempt int,
  prompt_tokens int,
  completion_tokens int,
  total_tokens int,
  cached_input_tokens int,
  reasoning_tokens int,
  -- raw_usage stores ONLY the provider `usage` object (token counts), never the
  -- prompt/messages, so prompts are not persisted here (see issue #70 threat model).
  raw_usage jsonb,
  metering_status text not null default 'ok',
  provider_cost_usd numeric,
  billable_cost_usd numeric,
  rate_card_id uuid references public.ops_llm_rate_card(id),
  markup_pct numeric,
  chargeable boolean not null default true,
  chargeability_reason text,
  priced_at timestamptz,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint uq_ops_llm_usage_idempotency unique (idempotency_key),
  constraint chk_ops_llm_metering_status check (metering_status in ('ok', 'missing', 'partial'))
);

create index if not exists idx_ops_llm_usage_event_tenant_created
  on public.ops_llm_usage_event (tenant_id, created_at);

create index if not exists idx_ops_llm_usage_event_run
  on public.ops_llm_usage_event (run_id);

-- Rollup views (security_invoker=true so RLS of the querying role applies). ------------------
create or replace view public.ops_llm_cost_by_run
with (security_invoker = true) as
select
  tenant_id,
  run_id,
  agent_key,
  count(*) as event_count,
  sum(provider_cost_usd) as provider_cost_usd,
  sum(billable_cost_usd) as billable_cost_usd
from public.ops_llm_usage_event
where metering_status = 'ok' and chargeable
group by tenant_id, run_id, agent_key;

create or replace view public.ops_llm_cost_by_tenant_day
with (security_invoker = true) as
select
  tenant_id,
  date(created_at) as usage_date,
  count(*) as event_count,
  sum(provider_cost_usd) as provider_cost_usd,
  sum(billable_cost_usd) as billable_cost_usd
from public.ops_llm_usage_event
where metering_status = 'ok' and chargeable
group by tenant_id, date(created_at);

create or replace view public.ops_llm_cost_by_agent_model
with (security_invoker = true) as
select
  tenant_id,
  agent_key,
  provider_model,
  count(*) as event_count,
  sum(provider_cost_usd) as provider_cost_usd,
  sum(billable_cost_usd) as billable_cost_usd
from public.ops_llm_usage_event
where metering_status = 'ok' and chargeable
group by tenant_id, agent_key, provider_model;

-- RLS / grants (mirrors credit_change_proposal: worker-write / UI tenant-read). --------------

-- ops_llm_rate_card: global pricing reference -> authenticated may read all rows.
revoke all on table public.ops_llm_rate_card from anon, authenticated;
grant select on table public.ops_llm_rate_card to authenticated;
grant select, insert, update, delete on table public.ops_llm_rate_card to service_role;
alter table public.ops_llm_rate_card enable row level security;

drop policy if exists "ops_llm_rate_card_authenticated_read" on public.ops_llm_rate_card;
create policy "ops_llm_rate_card_authenticated_read"
  on public.ops_llm_rate_card
  for select
  to authenticated
  using (true);

drop policy if exists "ops_llm_rate_card_service_role_all" on public.ops_llm_rate_card;
create policy "ops_llm_rate_card_service_role_all"
  on public.ops_llm_rate_card
  for all
  to service_role
  using (true)
  with check (true);

-- ops_tenant_llm_plan: tenant override rows are tenant-scoped; null tenant = default plan.
revoke all on table public.ops_tenant_llm_plan from anon, authenticated;
grant select on table public.ops_tenant_llm_plan to authenticated;
grant select, insert, update, delete on table public.ops_tenant_llm_plan to service_role;
alter table public.ops_tenant_llm_plan enable row level security;

drop policy if exists "ops_tenant_llm_plan_tenant_read" on public.ops_tenant_llm_plan;
create policy "ops_tenant_llm_plan_tenant_read"
  on public.ops_tenant_llm_plan
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and (tenant_id is null or public.ops_tenant_match(tenant_id))
  );

drop policy if exists "ops_tenant_llm_plan_service_role_all" on public.ops_tenant_llm_plan;
create policy "ops_tenant_llm_plan_service_role_all"
  on public.ops_tenant_llm_plan
  for all
  to service_role
  using (true)
  with check (true);

-- ops_llm_usage_event: financial cost rows, strictly tenant-scoped read, service_role write.
revoke all on table public.ops_llm_usage_event from anon, authenticated;
grant select on table public.ops_llm_usage_event to authenticated;
grant select, insert, update, delete on table public.ops_llm_usage_event to service_role;
alter table public.ops_llm_usage_event enable row level security;

drop policy if exists "ops_llm_usage_event_tenant_read" on public.ops_llm_usage_event;
create policy "ops_llm_usage_event_tenant_read"
  on public.ops_llm_usage_event
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

drop policy if exists "ops_llm_usage_event_service_role_all" on public.ops_llm_usage_event;
create policy "ops_llm_usage_event_service_role_all"
  on public.ops_llm_usage_event
  for all
  to service_role
  using (true)
  with check (true);

-- Seed (PLACEHOLDERS to calibrate against the real Azure invoice — NC-001). ------------------
-- gpt-4.1-mini rate card: per-1k prices, PAYG assumption. Recalibrate when the
-- PAYG-vs-PTU inventory is confirmed; under PTU tokens*price overcharges.
insert into public.ops_llm_rate_card
  (provider, provider_model, unit_of_measure, billing_mode, currency, price_input, price_output, price_cached_input, source)
select 'azure_openai', 'gpt-4.1-mini', 'per_1k', 'payg', 'USD', 0.0004, 0.0016, 0.0001, 'seed-placeholder'
where not exists (
  select 1 from public.ops_llm_rate_card
  where provider = 'azure_openai' and provider_model = 'gpt-4.1-mini' and source = 'seed-placeholder'
);

-- Default plan (tenant_id null): 30% markup. PLACEHOLDER to calibrate per plan.
insert into public.ops_tenant_llm_plan (tenant_id, plan_key, markup_pct)
select null, 'default', 0.30
where not exists (
  select 1 from public.ops_tenant_llm_plan where tenant_id is null and plan_key = 'default'
);
