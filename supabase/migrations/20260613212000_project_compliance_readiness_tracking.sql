-- Project compliance and readiness tracking for project-equipment allocations.
--
-- Adds:
--   * project entity type + project readiness relationship contract
--   * project_assignment_readiness_audit append-only audit trail
--   * project_get_required_readiness(...) inheritance resolver
--   * project_evaluate_assignment_readiness(...) explicit blocker evaluation
--   * project_assign_asset_with_readiness_check(...) blocking assignment gate
--   * v_project_equipment_readiness_current projection for project views

create or replace view public.rental_entity_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company'),
    ('region'),
    ('branch'),
    ('project'),
    ('customer'),
    ('billing_account'),
    ('contact'),
    ('job_site'),
    ('asset_category'),
    ('asset'),
    ('stock_item'),
    ('inventory_kit'),
    ('maintenance_record'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line'),
    ('invoice'),
    ('invoice_line'),
    ('transfer'),
    ('rate_card'),
    ('document'),
    ('note'),
    ('agent_config'),
    ('customer_issue'),
    ('requisition'),
    ('supplier'),
    ('purchase_order')
) as rental_entity_types(entity_type);

create or replace view public.rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company_has_region',                      'company',         'region'),
    ('region_has_branch',                       'region',          'branch'),
    ('branch_has_project',                      'branch',          'project'),
    ('project_inherits_requirements_from_project','project',       'project'),
    ('project_has_asset',                       'project',         'asset'),
    ('customer_has_billing_account',            'customer',        'billing_account'),
    ('customer_has_contact',                    'customer',        'contact'),
    ('customer_has_job_site',                   'customer',        'job_site'),
    ('customer_has_document',                   'customer',        'document'),
    ('customer_has_note',                       'customer',        'note'),
    ('customer_has_issue',                      'customer',        'customer_issue'),
    ('billing_account_has_issue',               'billing_account', 'customer_issue'),
    ('branch_has_asset',                        'branch',          'asset'),
    ('asset_category_has_asset',                'asset_category',  'asset'),
    ('branch_has_stock_item',                   'branch',          'stock_item'),
    ('asset_category_has_stock_item',           'asset_category',  'stock_item'),
    ('kit_has_asset',                           'inventory_kit',   'asset'),
    ('kit_has_asset_category',                  'inventory_kit',   'asset_category'),
    ('kit_has_stock_item',                      'inventory_kit',   'stock_item'),
    ('asset_has_maintenance_record',            'asset',           'maintenance_record'),
    ('asset_has_inspection',                    'asset',           'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

create table if not exists public.project_assignment_readiness_audit (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.entities(id) on delete cascade,
  asset_id           uuid not null references public.entities(id) on delete cascade,
  labor_context      jsonb not null default '{}'::jsonb,
  requirement_source text not null,
  requirements       jsonb not null default '{}'::jsonb,
  blockers           jsonb not null default '[]'::jsonb,
  blocked            boolean not null,
  action             text not null check (action in ('evaluation', 'assignment_blocked', 'assignment_committed', 'assignment_override')),
  relationship_id    uuid,
  acted_by           text,
  acted_at           timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create index if not exists idx_project_assignment_readiness_audit_project_time
  on public.project_assignment_readiness_audit (project_id, acted_at desc);

create index if not exists idx_project_assignment_readiness_audit_asset_time
  on public.project_assignment_readiness_audit (asset_id, acted_at desc);

alter table public.project_assignment_readiness_audit enable row level security;

drop policy if exists project_assignment_readiness_audit_authenticated_select
  on public.project_assignment_readiness_audit;
create policy project_assignment_readiness_audit_authenticated_select
  on public.project_assignment_readiness_audit
  for select
  to authenticated
  using (
    public.get_my_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and exists (
      select 1
      from public.rental_current_entity_state project_state
      where project_state.entity_id = project_assignment_readiness_audit.project_id
        and project_state.entity_type = 'project'
        and coalesce(project_state.data ->> 'tenant', '') = coalesce(public.get_my_tenant(), '')
    )
  );

drop policy if exists project_assignment_readiness_audit_service_role_select
  on public.project_assignment_readiness_audit;
create policy project_assignment_readiness_audit_service_role_select
  on public.project_assignment_readiness_audit
  for select
  to service_role
  using (true);

create or replace function public.project_get_required_readiness(
  p_project_id uuid
)
returns table (
  source_project_id uuid,
  requirement_source text,
  requirements jsonb
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_requirements jsonb;
  v_parent_project_id uuid;
  v_parent_requirements jsonb;
begin
  if p_project_id is null then
    raise exception 'project_get_required_readiness requires project_id'
      using errcode = '22023';
  end if;

  select
    case
      when jsonb_typeof(r.data -> 'required_readiness') = 'object'
      then r.data -> 'required_readiness'
      else null
    end
  into v_requirements
  from public.rental_current_entity_state r
  where r.entity_id = p_project_id
    and r.entity_type = 'project';

  if not found then
    raise exception 'Unknown project %', p_project_id
      using errcode = '22023';
  end if;

  if v_requirements is not null and v_requirements <> '{}'::jsonb then
    source_project_id := p_project_id;
    requirement_source := 'project';
    requirements := v_requirements;
    return next;
    return;
  end if;

  select
    rel.parent_id,
    case
      when jsonb_typeof(parent_state.data -> 'required_readiness') = 'object'
      then parent_state.data -> 'required_readiness'
      else null
    end
  into v_parent_project_id, v_parent_requirements
  from public.relationships_v2 rel
  join public.rental_current_entity_state parent_state
    on parent_state.entity_id = rel.parent_id
   and parent_state.entity_type = 'project'
  where rel.relationship_type = 'project_inherits_requirements_from_project'
    and rel.child_id = p_project_id
    and rel.is_current
  order by rel.valid_from desc nulls last, rel.created_at desc
  limit 1;

  if found and v_parent_requirements is not null and v_parent_requirements <> '{}'::jsonb then
    source_project_id := v_parent_project_id;
    requirement_source := 'inherited_project';
    requirements := v_parent_requirements;
    return next;
    return;
  end if;

  source_project_id := p_project_id;
  requirement_source := 'none';
  requirements := '{}'::jsonb;
  return next;
end;
$$;

create or replace function public.project_evaluate_assignment_readiness(
  p_project_id uuid,
  p_asset_id uuid,
  p_labor_context jsonb default '{}'::jsonb
)
returns table (
  blocked boolean,
  blockers jsonb,
  requirement_source text,
  requirements jsonb,
  evaluated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_source text;
  v_requirements jsonb := '{}'::jsonb;
  v_project_source uuid;
  v_asset_data jsonb;
  v_required jsonb;
  v_requirement_key text;
  v_matching_cert jsonb;
  v_expires_at timestamptz;
  v_blockers jsonb := '[]'::jsonb;
  v_asset_name text;
  v_project_name text;
  v_labor_certifications jsonb;
  v_labor_flags jsonb;
begin
  if p_project_id is null or p_asset_id is null then
    raise exception 'project_evaluate_assignment_readiness requires project_id and asset_id'
      using errcode = '22023';
  end if;

  select
    r.name,
    r.data
  into v_asset_name, v_asset_data
  from public.rental_current_entity_state r
  where r.entity_id = p_asset_id
    and r.entity_type = 'asset';

  if not found then
    raise exception 'Unknown asset %', p_asset_id
      using errcode = '22023';
  end if;

  select r.name
  into v_project_name
  from public.rental_current_entity_state r
  where r.entity_id = p_project_id
    and r.entity_type = 'project';

  if not found then
    raise exception 'Unknown project %', p_project_id
      using errcode = '22023';
  end if;

  select
    readiness.source_project_id,
    readiness.requirement_source,
    coalesce(readiness.requirements, '{}'::jsonb)
  into v_project_source, v_source, v_requirements
  from public.project_get_required_readiness(p_project_id) readiness;

  v_labor_certifications := case
    when jsonb_typeof(p_labor_context -> 'certifications') = 'array' then p_labor_context -> 'certifications'
    else '[]'::jsonb
  end;

  v_labor_flags := case
    when jsonb_typeof(p_labor_context -> 'readiness_flags') = 'array' then p_labor_context -> 'readiness_flags'
    else '[]'::jsonb
  end;

  if jsonb_typeof(v_requirements -> 'equipment_certifications') = 'array' then
    for v_required in
      select value
      from jsonb_array_elements(v_requirements -> 'equipment_certifications')
    loop
      v_requirement_key := nullif(
        case
          when jsonb_typeof(v_required) = 'string' then trim(both '"' from v_required::text)
          when jsonb_typeof(v_required) = 'object' then v_required ->> 'key'
          else null
        end,
        ''
      );

      if v_requirement_key is null then
        continue;
      end if;

      select cert.value
      into v_matching_cert
      from jsonb_array_elements(
        case
          when jsonb_typeof(v_asset_data -> 'certifications') = 'array' then v_asset_data -> 'certifications'
          else '[]'::jsonb
        end
      ) cert(value)
      where nullif(cert.value ->> 'key', '') = v_requirement_key
      order by nullif(cert.value ->> 'expires_at', '')::timestamptz desc nulls last
      limit 1;

      if v_matching_cert is null then
        v_blockers := v_blockers || jsonb_build_array(
          jsonb_build_object(
            'code', 'missing_equipment_certification',
            'requirement', v_requirement_key,
            'reason', format('Asset %s is missing required certification %s.', coalesce(v_asset_name, p_asset_id::text), v_requirement_key)
          )
        );
        continue;
      end if;

      v_expires_at := nullif(v_matching_cert ->> 'expires_at', '')::timestamptz;
      if v_expires_at is not null and v_expires_at <= now() then
        v_blockers := v_blockers || jsonb_build_array(
          jsonb_build_object(
            'code', 'expired_equipment_certification',
            'requirement', v_requirement_key,
            'expires_at', v_expires_at,
            'reason', format('Asset %s certification %s expired at %s.', coalesce(v_asset_name, p_asset_id::text), v_requirement_key, v_expires_at)
          )
        );
      end if;
    end loop;
  end if;

  if jsonb_typeof(v_requirements -> 'labor_certifications') = 'array' then
    for v_required in
      select value
      from jsonb_array_elements(v_requirements -> 'labor_certifications')
    loop
      v_requirement_key := nullif(
        case
          when jsonb_typeof(v_required) = 'string' then trim(both '"' from v_required::text)
          when jsonb_typeof(v_required) = 'object' then v_required ->> 'key'
          else null
        end,
        ''
      );

      if v_requirement_key is null then
        continue;
      end if;

      select cert.value
      into v_matching_cert
      from jsonb_array_elements(v_labor_certifications) cert(value)
      where nullif(cert.value ->> 'key', '') = v_requirement_key
      order by nullif(cert.value ->> 'expires_at', '')::timestamptz desc nulls last
      limit 1;

      if v_matching_cert is null then
        v_blockers := v_blockers || jsonb_build_array(
          jsonb_build_object(
            'code', 'missing_labor_certification',
            'requirement', v_requirement_key,
            'reason', format('Labor context is missing required certification %s for project %s.', v_requirement_key, coalesce(v_project_name, p_project_id::text))
          )
        );
        continue;
      end if;

      v_expires_at := nullif(v_matching_cert ->> 'expires_at', '')::timestamptz;
      if v_expires_at is not null and v_expires_at <= now() then
        v_blockers := v_blockers || jsonb_build_array(
          jsonb_build_object(
            'code', 'expired_labor_certification',
            'requirement', v_requirement_key,
            'expires_at', v_expires_at,
            'reason', format('Labor certification %s expired at %s for project %s.', v_requirement_key, v_expires_at, coalesce(v_project_name, p_project_id::text))
          )
        );
      end if;
    end loop;
  end if;

  if jsonb_typeof(v_requirements -> 'labor_readiness_flags') = 'array' then
    for v_required in
      select value
      from jsonb_array_elements(v_requirements -> 'labor_readiness_flags')
    loop
      v_requirement_key := nullif(trim(both '"' from v_required::text), '');
      if v_requirement_key is null then
        continue;
      end if;

      if not exists (
        select 1
        from jsonb_array_elements_text(v_labor_flags) provided(flag)
        where provided.flag = v_requirement_key
      ) then
        v_blockers := v_blockers || jsonb_build_array(
          jsonb_build_object(
            'code', 'missing_labor_readiness_flag',
            'requirement', v_requirement_key,
            'reason', format('Labor readiness flag %s is required for project %s.', v_requirement_key, coalesce(v_project_name, p_project_id::text))
          )
        );
      end if;
    end loop;
  end if;

  blocked := jsonb_array_length(v_blockers) > 0;
  blockers := v_blockers;
  requirement_source := coalesce(v_source, 'none');
  requirements := coalesce(v_requirements, '{}'::jsonb);
  evaluated_at := now();
  return next;
end;
$$;

create or replace function public.project_assign_asset_with_readiness_check(
  p_project_id uuid,
  p_asset_id uuid,
  p_labor_context jsonb default '{}'::jsonb,
  p_allow_override boolean default false,
  p_actor text default null
)
returns table (
  relationship_id uuid,
  blocked boolean,
  blockers jsonb,
  audit_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evaluation record;
  v_relationship_id uuid;
  v_audit_id uuid;
  v_action text;
  v_request_role text;
  v_app_role public.app_role;
  v_request_tenant text;
  v_project_tenant text;
  v_asset_tenant text;
begin
  if p_project_id is null or p_asset_id is null then
    raise exception 'project_assign_asset_with_readiness_check requires project_id and asset_id'
      using errcode = '22023';
  end if;

  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );
  v_app_role := public.get_my_role();
  v_request_tenant := public.get_my_tenant();

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and v_app_role in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'project_assign_asset_with_readiness_check requires authenticated manager write access'
      using errcode = '42501';
  end if;

  if v_request_role <> 'service_role' then
    select r.data ->> 'tenant'
    into v_project_tenant
    from public.rental_current_entity_state r
    where r.entity_id = p_project_id
      and r.entity_type = 'project';

    if not found then
      raise exception 'Unknown project %', p_project_id
        using errcode = '22023';
    end if;

    select r.data ->> 'tenant'
    into v_asset_tenant
    from public.rental_current_entity_state r
    where r.entity_id = p_asset_id
      and r.entity_type = 'asset';

    if not found then
      raise exception 'Unknown asset %', p_asset_id
        using errcode = '22023';
    end if;

    if coalesce(v_project_tenant, '') = ''
      or coalesce(v_asset_tenant, '') = ''
      or v_project_tenant <> v_asset_tenant
      or v_project_tenant <> coalesce(v_request_tenant, '')
    then
      raise exception 'project_assign_asset_with_readiness_check tenant scope violation'
        using errcode = '42501';
    end if;
  end if;

  select *
  into v_evaluation
  from public.project_evaluate_assignment_readiness(
    p_project_id => p_project_id,
    p_asset_id => p_asset_id,
    p_labor_context => coalesce(p_labor_context, '{}'::jsonb)
  );

  if not v_evaluation.blocked or p_allow_override then
    select public.rental_upsert_relationship(
      p_relationship_type => 'project_has_asset',
      p_parent_id => p_project_id,
      p_child_id => p_asset_id,
      p_metadata => jsonb_strip_nulls(jsonb_build_object(
        'actor', p_actor,
        'labor_context', coalesce(p_labor_context, '{}'::jsonb),
        'readiness_checked_at', v_evaluation.evaluated_at,
        'requirement_source', v_evaluation.requirement_source,
        'blocked', v_evaluation.blocked,
        'blockers', v_evaluation.blockers
      )),
      p_valid_from => now()
    )
    into v_relationship_id;
  end if;

  v_action := case
    when v_evaluation.blocked and not p_allow_override then 'assignment_blocked'
    when v_evaluation.blocked and p_allow_override then 'assignment_override'
    else 'assignment_committed'
  end;

  insert into public.project_assignment_readiness_audit (
    project_id,
    asset_id,
    labor_context,
    requirement_source,
    requirements,
    blockers,
    blocked,
    action,
    relationship_id,
    acted_by,
    acted_at
  )
  values (
    p_project_id,
    p_asset_id,
    coalesce(p_labor_context, '{}'::jsonb),
    coalesce(v_evaluation.requirement_source, 'none'),
    coalesce(v_evaluation.requirements, '{}'::jsonb),
    coalesce(v_evaluation.blockers, '[]'::jsonb),
    coalesce(v_evaluation.blocked, false),
    v_action,
    v_relationship_id,
    p_actor,
    coalesce(v_evaluation.evaluated_at, now())
  )
  returning id into v_audit_id;

  relationship_id := v_relationship_id;
  blocked := coalesce(v_evaluation.blocked, false);
  blockers := coalesce(v_evaluation.blockers, '[]'::jsonb);
  audit_id := v_audit_id;
  return next;
end;
$$;

create or replace view public.v_project_equipment_readiness_current
with (security_invoker = true) as
with project_asset_assignments as (
  select
    rel.id as relationship_id,
    rel.parent_id as project_id,
    rel.child_id as asset_id,
    rel.metadata,
    rel.valid_from as assigned_at
  from public.relationships_v2 rel
  where rel.relationship_type = 'project_has_asset'
    and rel.is_current
),
projects as (
  select
    r.entity_id,
    r.name,
    r.data
  from public.rental_current_entity_state r
  where r.entity_type = 'project'
),
assets as (
  select
    r.entity_id,
    r.name,
    r.data
  from public.rental_current_entity_state r
  where r.entity_type = 'asset'
)
select
  a.relationship_id,
  a.project_id,
  p.name as project_name,
  a.asset_id,
  s.name as asset_name,
  a.assigned_at,
  a.metadata ->> 'actor' as assigned_by,
  eval.requirement_source,
  eval.requirements,
  eval.blocked,
  eval.blockers,
  jsonb_array_length(eval.blockers) as blocker_count,
  case
    when eval.blocked then 'blocked'
    else 'ready'
  end as readiness_state,
  eval.evaluated_at
from project_asset_assignments a
join projects p
  on p.entity_id = a.project_id
join assets s
  on s.entity_id = a.asset_id
cross join lateral public.project_evaluate_assignment_readiness(
  p_project_id => a.project_id,
  p_asset_id => a.asset_id,
  p_labor_context => case
    when jsonb_typeof(a.metadata -> 'labor_context') = 'object' then a.metadata -> 'labor_context'
    else '{}'::jsonb
  end
) eval;

revoke all on table public.project_assignment_readiness_audit from public, anon;
grant select on table public.project_assignment_readiness_audit to authenticated, service_role;

revoke all on table public.v_project_equipment_readiness_current from public, anon;
grant select on table public.v_project_equipment_readiness_current to authenticated, service_role;

revoke all on function public.project_get_required_readiness(uuid) from public, anon;
revoke execute on function public.project_get_required_readiness(uuid) from authenticated;
grant execute on function public.project_get_required_readiness(uuid) to authenticated, service_role;

revoke all on function public.project_evaluate_assignment_readiness(uuid, uuid, jsonb) from public, anon;
revoke execute on function public.project_evaluate_assignment_readiness(uuid, uuid, jsonb) from authenticated;
grant execute on function public.project_evaluate_assignment_readiness(uuid, uuid, jsonb) to authenticated, service_role;

revoke all on function public.project_assign_asset_with_readiness_check(uuid, uuid, jsonb, boolean, text) from public, anon;
revoke execute on function public.project_assign_asset_with_readiness_check(uuid, uuid, jsonb, boolean, text) from authenticated;
grant execute on function public.project_assign_asset_with_readiness_check(uuid, uuid, jsonb, boolean, text) to authenticated, service_role;
