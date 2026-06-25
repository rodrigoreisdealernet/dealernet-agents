-- Tenant-scoped agent configuration in generic entity/SCD2 model + output schema registry.

create or replace view public.rental_entity_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('branch'),
    ('customer'),
    ('billing_account'),
    ('contact'),
    ('job_site'),
    ('asset_category'),
    ('asset'),
    ('maintenance_record'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line'),
    ('agent_config')
) as rental_entity_types(entity_type);

create table if not exists public.ops_output_schema_registry (
  schema_key text primary key,
  schema_json jsonb not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_ops_output_schema_registry_updated_at on public.ops_output_schema_registry;
create trigger trg_ops_output_schema_registry_updated_at
  before update on public.ops_output_schema_registry
  for each row execute function update_updated_at();

revoke all on table public.ops_output_schema_registry from anon, authenticated;
grant select on table public.ops_output_schema_registry to authenticated;
grant select, insert, update, delete on table public.ops_output_schema_registry to service_role;

alter table public.ops_output_schema_registry enable row level security;

drop policy if exists ops_output_schema_registry_authenticated_read on public.ops_output_schema_registry;
drop policy if exists ops_output_schema_registry_service_role_all on public.ops_output_schema_registry;
create policy ops_output_schema_registry_authenticated_read
  on public.ops_output_schema_registry
  for select
  to authenticated
  using (public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only'));
create policy ops_output_schema_registry_service_role_all
  on public.ops_output_schema_registry
  for all
  to service_role
  using (true)
  with check (true);

insert into public.entities (entity_type, source_record_id)
select
  'agent_config',
  cfg.tenant_id::text || ':' || cfg.agent_key
from public.ops_agent_config cfg
on conflict (entity_type, source_record_id) do nothing;

insert into public.entity_versions (entity_id, version_number, data)
select
  e.id,
  1,
  jsonb_build_object(
    'tenant_id', cfg.tenant_id,
    'agent_key', cfg.agent_key,
    'enabled', cfg.enabled,
    'model', cfg.model,
    'system_prompt', cfg.system_prompt,
    'user_prompt_template', cfg.user_prompt_template,
    'tools', cfg.tools,
    'output_schema_key', cfg.output_schema_key,
    'thresholds', cfg.thresholds,
    'bounds', cfg.bounds,
    'schedule', cfg.schedule,
    'auto_apply', cfg.auto_apply
  )
from public.ops_agent_config cfg
join public.entities e
  on e.entity_type = 'agent_config'
 and e.source_record_id = cfg.tenant_id::text || ':' || cfg.agent_key
where not exists (
  select 1
  from public.entity_versions ev
  where ev.entity_id = e.id
);

create or replace view public.ops_agent_config_current
with (security_invoker = true) as
select
  e.id as entity_id,
  ev.id as entity_version_id,
  (ev.data ->> 'tenant_id')::uuid as tenant_id,
  ev.data ->> 'agent_key' as agent_key,
  coalesce((ev.data ->> 'enabled')::boolean, true) as enabled,
  coalesce(ev.data -> 'model', '{}'::jsonb) as model,
  ev.data ->> 'system_prompt' as system_prompt,
  ev.data ->> 'user_prompt_template' as user_prompt_template,
  coalesce(ev.data -> 'tools', '[]'::jsonb) as tools,
  ev.data ->> 'output_schema_key' as output_schema_key,
  coalesce(ev.data -> 'thresholds', '{}'::jsonb) as thresholds,
  coalesce(ev.data -> 'bounds', '{}'::jsonb) as bounds,
  coalesce(ev.data -> 'schedule', '{}'::jsonb) as schedule,
  coalesce((ev.data ->> 'auto_apply')::boolean, false) as auto_apply,
  ev.version_number,
  ev.valid_from,
  ev.valid_to,
  ev.created_at as version_created_at
from public.entities e
join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current = true
where e.entity_type = 'agent_config';

comment on view public.ops_agent_config_current is
  'Current tenant-scoped agent config from entity_versions; runtime still hard-locks auto_apply=false in v1.';

create or replace view public.ops_agent_status_view
with (security_invoker = true)
as
select
  c.tenant_id,
  c.agent_key,
  c.enabled,
  c.auto_apply,
  last_run.run_id as last_run_id,
  last_run.started_at as last_run_started_at,
  last_run.finished_at as last_run_finished_at,
  last_run.status as last_run_status,
  case
    when coalesce(c.schedule ->> 'next_run_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}$'
      or coalesce(c.schedule ->> 'next_run_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?$'
      then (c.schedule ->> 'next_run_at')::timestamptz
    else null
  end as next_run_at,
  run_counts.total_runs,
  run_counts.succeeded_runs,
  run_counts.failed_runs,
  pending.pending_findings,
  (pending.pending_findings > 0) as has_pending_badge
from public.ops_agent_config_current c
left join lateral (
  select
    r.run_id,
    r.started_at,
    r.finished_at,
    r.status
  from public.ops_workflow_run r
  where r.tenant_id = c.tenant_id
    and r.workflow_key = c.agent_key
  order by r.started_at desc nulls last
  limit 1
) as last_run on true
left join lateral (
  select
    count(*) as total_runs,
    count(*) filter (where r.status = 'succeeded') as succeeded_runs,
    count(*) filter (where r.status = 'failed') as failed_runs
  from public.ops_workflow_run r
  where r.tenant_id = c.tenant_id
    and r.workflow_key = c.agent_key
) as run_counts on true
left join lateral (
  select
    count(*) as pending_findings
  from public.finding f
  where f.tenant_id = c.tenant_id
    and f.agent_key = c.agent_key
    and f.status = 'pending_approval'
) as pending on true;
