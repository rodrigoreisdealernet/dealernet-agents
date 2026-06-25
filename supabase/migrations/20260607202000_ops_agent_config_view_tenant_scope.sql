-- Tighten tenant-claim scoping for entity-backed ops agent config reads.

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
where e.entity_type = 'agent_config'
  and (
    current_user in ('postgres', 'service_role')
    or (
      public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
      and coalesce(ev.data ->> 'tenant_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and public.ops_tenant_match((ev.data ->> 'tenant_id')::uuid)
    )
  );

revoke all on table public.ops_agent_config_current from anon;
grant select on table public.ops_agent_config_current to authenticated, service_role;
revoke all on table public.ops_agent_status_view from anon;
grant select on table public.ops_agent_status_view to authenticated, service_role;
