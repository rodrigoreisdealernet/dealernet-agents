-- Project hierarchy + mixed-fleet allocation foundation (issue #1485).
--
-- Implements the shared contractor-project model direction from #444 by
-- introducing first-class project_equipment_assignment entities on the shared
-- entity substrate (not a separate standalone fleet model).

create or replace view public.rental_entity_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company'),
    ('region'),
    ('branch'),
    ('project'),
    ('project_equipment_assignment'),
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
    ('company_has_region',                         'company',                    'region'),
    ('region_has_branch',                          'region',                     'branch'),
    ('branch_has_project',                         'branch',                     'project'),
    ('project_inherits_requirements_from_project', 'project',                    'project'),
    ('project_has_asset',                          'project',                    'asset'),
    ('project_has_equipment_assignment',           'project',                    'project_equipment_assignment'),
    ('equipment_assignment_has_asset',             'project_equipment_assignment','asset'),
    ('branch_has_equipment_assignment',            'branch',                     'project_equipment_assignment'),
    ('customer_has_billing_account',               'customer',                   'billing_account'),
    ('customer_has_contact',                       'customer',                   'contact'),
    ('customer_has_job_site',                      'customer',                   'job_site'),
    ('customer_has_document',                      'customer',                   'document'),
    ('customer_has_note',                          'customer',                   'note'),
    ('customer_has_issue',                         'customer',                   'customer_issue'),
    ('billing_account_has_issue',                  'billing_account',            'customer_issue'),
    ('branch_has_asset',                           'branch',                     'asset'),
    ('asset_category_has_asset',                   'asset_category',             'asset'),
    ('branch_has_stock_item',                      'branch',                     'stock_item'),
    ('asset_category_has_stock_item',              'asset_category',             'stock_item'),
    ('kit_has_asset',                              'inventory_kit',              'asset'),
    ('kit_has_asset_category',                     'inventory_kit',              'asset_category'),
    ('kit_has_stock_item',                         'inventory_kit',              'stock_item'),
    ('asset_has_maintenance_record',               'asset',                      'maintenance_record'),
    ('asset_has_inspection',                       'asset',                      'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

create or replace function public.project_upsert_hierarchy_node(
  p_project_source_record_id text,
  p_project_data jsonb default '{}'::jsonb,
  p_branch_id uuid default null,
  p_parent_project_id uuid default null
)
returns table (
  project_id uuid,
  branch_relationship_id uuid,
  parent_relationship_id uuid
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_project_data jsonb;
  v_branch_relationship_id uuid;
  v_parent_relationship_id uuid;
begin
  if nullif(trim(coalesce(p_project_source_record_id, '')), '') is null then
    raise exception 'project_upsert_hierarchy_node requires project_source_record_id'
      using errcode = '22023';
  end if;

  v_project_data := coalesce(p_project_data, '{}'::jsonb);

  if coalesce(nullif(v_project_data ->> 'tenant', ''), '') = '' and coalesce(public.get_my_tenant(), '') <> '' then
    v_project_data := v_project_data || jsonb_build_object('tenant', public.get_my_tenant());
  end if;

  select upserted.entity_id
  into project_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'project',
    p_source_record_id => p_project_source_record_id,
    p_data => v_project_data
  ) upserted;

  if p_branch_id is not null then
    v_branch_relationship_id := public.rental_upsert_relationship(
      p_relationship_type => 'branch_has_project',
      p_parent_id => p_branch_id,
      p_child_id => project_id
    );
  end if;

  if p_parent_project_id is not null then
    v_parent_relationship_id := public.rental_upsert_relationship(
      p_relationship_type => 'project_inherits_requirements_from_project',
      p_parent_id => p_parent_project_id,
      p_child_id => project_id
    );
  end if;

  branch_relationship_id := v_branch_relationship_id;
  parent_relationship_id := v_parent_relationship_id;
  return next;
end;
$$;

create or replace function public.project_allocate_equipment(
  p_assignment_source_record_id text,
  p_project_id uuid,
  p_asset_id uuid,
  p_branch_id uuid default null,
  p_yard_context text default null,
  p_planned_start timestamptz default null,
  p_planned_end timestamptz default null,
  p_status text default 'planned',
  p_allocation_source text default null,
  p_labor_context jsonb default '{}'::jsonb,
  p_allow_override boolean default false,
  p_actor text default null
)
returns table (
  assignment_id uuid,
  assignment_version_id uuid,
  relationship_id uuid,
  blocked boolean,
  blockers jsonb
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_project_name text;
  v_project_tenant text;
  v_asset_name text;
  v_asset_tenant text;
  v_ownership_type text;
  v_assignment_source text;
  v_assignment_status text;
  v_assignment_data jsonb;
  v_assignment_result record;
  v_assignment_relationship_id uuid;
begin
  if p_project_id is null or p_asset_id is null then
    raise exception 'project_allocate_equipment requires project_id and asset_id'
      using errcode = '22023';
  end if;

  select r.name, r.data ->> 'tenant'
  into v_project_name, v_project_tenant
  from public.rental_current_entity_state r
  where r.entity_id = p_project_id
    and r.entity_type = 'project';

  if not found then
    raise exception 'Unknown project %', p_project_id
      using errcode = '22023';
  end if;

  select
    r.name,
    r.data ->> 'tenant',
    lower(coalesce(r.data ->> 'ownership_type', 'owned'))
  into v_asset_name, v_asset_tenant, v_ownership_type
  from public.rental_current_entity_state r
  where r.entity_id = p_asset_id
    and r.entity_type = 'asset';

  if not found then
    raise exception 'Unknown asset %', p_asset_id
      using errcode = '22023';
  end if;

  if coalesce(v_project_tenant, '') <> ''
     and coalesce(v_asset_tenant, '') <> ''
     and v_project_tenant <> v_asset_tenant then
    raise exception 'project_allocate_equipment tenant mismatch between project and asset'
      using errcode = '42501';
  end if;

  v_assignment_source := lower(coalesce(nullif(p_allocation_source, ''), v_ownership_type));
  if v_assignment_source in ('owned', 'internal', 'company_owned') then
    v_assignment_source := 'owned';
  else
    v_assignment_source := 'external_rental';
  end if;

  v_assignment_status := lower(coalesce(nullif(p_status, ''), 'planned'));

  select *
  into v_assignment_result
  from public.project_assign_asset_with_readiness_check(
    p_project_id => p_project_id,
    p_asset_id => p_asset_id,
    p_labor_context => coalesce(p_labor_context, '{}'::jsonb),
    p_allow_override => p_allow_override,
    p_actor => p_actor
  );

  relationship_id := v_assignment_result.relationship_id;
  blocked := coalesce(v_assignment_result.blocked, false);
  blockers := coalesce(v_assignment_result.blockers, '[]'::jsonb);

  if blocked and not p_allow_override then
    assignment_id := null;
    assignment_version_id := null;
    return next;
    return;
  end if;

  v_assignment_data := jsonb_strip_nulls(
    jsonb_build_object(
      'project_id', p_project_id,
      'project_name', v_project_name,
      'asset_id', p_asset_id,
      'asset_name', v_asset_name,
      'branch_id', p_branch_id,
      'yard_context', nullif(trim(coalesce(p_yard_context, '')), ''),
      'planned_start',
        case when p_planned_start is null
          then null
          else to_char(p_planned_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        end,
      'planned_end',
        case when p_planned_end is null
          then null
          else to_char(p_planned_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        end,
      'status', v_assignment_status,
      'allocation_source', v_assignment_source,
      'tenant', coalesce(v_project_tenant, v_asset_tenant),
      'project_asset_relationship_id', v_assignment_result.relationship_id,
      'labor_context', coalesce(p_labor_context, '{}'::jsonb),
      'actor', p_actor
    )
  );

  select upserted.entity_id, upserted.entity_version_id
  into assignment_id, assignment_version_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'project_equipment_assignment',
    p_source_record_id => nullif(p_assignment_source_record_id, ''),
    p_data => v_assignment_data
  ) upserted;

  v_assignment_relationship_id := public.rental_upsert_relationship(
    p_relationship_type => 'project_has_equipment_assignment',
    p_parent_id => p_project_id,
    p_child_id => assignment_id,
    p_metadata => jsonb_build_object('source', 'project_allocate_equipment')
  );

  perform public.rental_upsert_relationship(
    p_relationship_type => 'equipment_assignment_has_asset',
    p_parent_id => assignment_id,
    p_child_id => p_asset_id,
    p_metadata => jsonb_build_object('source', 'project_allocate_equipment')
  );

  if p_branch_id is not null then
    perform public.rental_upsert_relationship(
      p_relationship_type => 'branch_has_equipment_assignment',
      p_parent_id => p_branch_id,
      p_child_id => assignment_id,
      p_metadata => jsonb_build_object('source', 'project_allocate_equipment')
    );
  end if;

  relationship_id := coalesce(v_assignment_relationship_id, relationship_id);
  return next;
end;
$$;

create or replace view public.v_project_equipment_allocations_current
with (security_invoker = true) as
with request_context as (
  select
    coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') as request_role,
    public.get_my_tenant()                                                     as request_tenant
),
assignment_state as (
  select
    a.entity_id as assignment_id,
    a.source_record_id as assignment_source_record_id,
    a.data,
    a.updated_at
  from public.rental_current_entity_state a
  where a.entity_type = 'project_equipment_assignment'
),
project_assignment_rel as (
  select rel.child_id as assignment_id, rel.parent_id as project_id
  from public.relationships_v2 rel
  where rel.relationship_type = 'project_has_equipment_assignment'
    and rel.is_current
),
assignment_asset_rel as (
  select rel.parent_id as assignment_id, rel.child_id as asset_id
  from public.relationships_v2 rel
  where rel.relationship_type = 'equipment_assignment_has_asset'
    and rel.is_current
),
assignment_branch_rel as (
  select rel.child_id as assignment_id, rel.parent_id as branch_id
  from public.relationships_v2 rel
  where rel.relationship_type = 'branch_has_equipment_assignment'
    and rel.is_current
),
projects as (
  select r.entity_id, r.name, r.data
  from public.rental_current_entity_state r
  where r.entity_type = 'project'
),
assets as (
  select r.entity_id, r.name, r.data
  from public.rental_current_entity_state r
  where r.entity_type = 'asset'
),
branches as (
  select r.entity_id, r.name
  from public.rental_current_entity_state r
  where r.entity_type = 'branch'
)
select
  assn.assignment_id,
  assn.assignment_source_record_id,
  coalesce(
    public.parse_uuid_or_null(assn.data ->> 'project_id'),
    par.project_id
  ) as project_id,
  coalesce(project_state.name, assn.data ->> 'project_name') as project_name,
  coalesce(
    public.parse_uuid_or_null(assn.data ->> 'asset_id'),
    aar.asset_id
  ) as asset_id,
  coalesce(asset_state.name, assn.data ->> 'asset_name') as asset_name,
  lower(coalesce(asset_state.data ->> 'ownership_type', 'owned')) as ownership_type,
  lower(
    coalesce(
      assn.data ->> 'allocation_source',
      case
        when lower(coalesce(asset_state.data ->> 'ownership_type', 'owned')) = 'owned' then 'owned'
        else 'external_rental'
      end
    )
  ) as allocation_source,
  coalesce(
    public.parse_uuid_or_null(assn.data ->> 'branch_id'),
    abr.branch_id
  ) as branch_id,
  branch_state.name as branch_name,
  nullif(assn.data ->> 'yard_context', '') as yard_context,
  case
    when coalesce(nullif(assn.data ->> 'planned_start', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
      then (assn.data ->> 'planned_start')::timestamptz
    else null
  end as planned_start,
  case
    when coalesce(nullif(assn.data ->> 'planned_end', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
      then (assn.data ->> 'planned_end')::timestamptz
    else null
  end as planned_end,
  lower(coalesce(nullif(assn.data ->> 'status', ''), 'planned')) as current_status,
  assn.updated_at as status_updated_at,
  coalesce(nullif(assn.data ->> 'tenant', ''), nullif(project_state.data ->> 'tenant', ''), nullif(asset_state.data ->> 'tenant', '')) as tenant_key,
  assn.data
from assignment_state assn
left join project_assignment_rel par
  on par.assignment_id = assn.assignment_id
left join assignment_asset_rel aar
  on aar.assignment_id = assn.assignment_id
left join assignment_branch_rel abr
  on abr.assignment_id = assn.assignment_id
left join projects project_state
  on project_state.entity_id = coalesce(public.parse_uuid_or_null(assn.data ->> 'project_id'), par.project_id)
left join assets asset_state
  on asset_state.entity_id = coalesce(public.parse_uuid_or_null(assn.data ->> 'asset_id'), aar.asset_id)
left join branches branch_state
  on branch_state.entity_id = coalesce(public.parse_uuid_or_null(assn.data ->> 'branch_id'), abr.branch_id)
cross join request_context req
where req.request_role = 'service_role'
   or coalesce(nullif(assn.data ->> 'tenant', ''), nullif(project_state.data ->> 'tenant', ''), nullif(asset_state.data ->> 'tenant', ''), 'default') = coalesce(nullif(req.request_tenant, ''), 'default');

revoke all on public.v_project_equipment_allocations_current from public, anon;
grant select on public.v_project_equipment_allocations_current to authenticated, service_role;

revoke all on function public.project_upsert_hierarchy_node(text, jsonb, uuid, uuid) from public, anon;
grant execute on function public.project_upsert_hierarchy_node(text, jsonb, uuid, uuid) to authenticated, service_role;

revoke all on function public.project_allocate_equipment(text, uuid, uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb, boolean, text) from public, anon;
grant execute on function public.project_allocate_equipment(text, uuid, uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb, boolean, text) to authenticated, service_role;
