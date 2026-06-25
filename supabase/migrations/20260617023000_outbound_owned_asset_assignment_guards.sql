-- Outbound owned-asset allocation guards
-- Closes #1276
--
-- Tightens project_allocate_equipment so outbound assignments only start from
-- idle assets and cannot double-book an asset across active allocations.

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
  v_asset_status text;
  v_assignment_source text;
  v_assignment_status text;
  v_assignment_data jsonb;
  v_assignment_result record;
  v_assignment_relationship_id uuid;
  v_conflicting_assignment_id uuid;
  v_conflicting_project_id uuid;
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
    lower(coalesce(r.data ->> 'ownership_type', 'owned')),
    lower(
      coalesce(
        nullif(r.data ->> 'status', ''),
        nullif(r.data ->> 'operational_status', ''),
        nullif(r.data ->> 'project_assignment_status', ''),
        'available'
      )
    )
  into v_asset_name, v_asset_tenant, v_ownership_type, v_asset_status
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

  -- Non-idle asset statuses that must block a new outbound allocation.
  -- These align with the shared rental lifecycle in the domain model.
  if v_asset_status in ('on_rent', 'in_transit', 'inspection_hold', 'maintenance', 'unavailable', 'retired', 'lost') then
    raise exception
      'project_allocate_equipment: asset % is not idle (status=%)',
      p_asset_id, v_asset_status
      using errcode = '23514';
  end if;

  v_assignment_source := lower(coalesce(nullif(p_allocation_source, ''), v_ownership_type));
  if v_assignment_source in ('owned', 'internal', 'company_owned') then
    v_assignment_source := 'owned';
  else
    v_assignment_source := 'external_rental';
  end if;

  v_assignment_status := lower(coalesce(nullif(p_status, ''), 'planned'));

  select
    existing.entity_id,
    public.parse_uuid_or_null(existing.data ->> 'project_id')
  into v_conflicting_assignment_id, v_conflicting_project_id
  from public.rental_current_entity_state existing
  where existing.entity_type = 'project_equipment_assignment'
    and public.parse_uuid_or_null(existing.data ->> 'asset_id') = p_asset_id
    -- Active assignment statuses that indicate custody is still open.
    and lower(coalesce(existing.data ->> 'status', 'planned')) in ('planned', 'on_order', 'on_hire', 'on_site', 'scheduled_pickup', 'on_rent')
    and (
      p_assignment_source_record_id is null
      or existing.source_record_id is distinct from p_assignment_source_record_id
    )
  order by existing.updated_at desc
  limit 1;

  -- Allow same-project re-upserts (for idempotent updates to an existing plan)
  -- while still blocking cross-project double-booking.
  if v_conflicting_assignment_id is not null
     and v_conflicting_project_id is distinct from p_project_id then
    raise exception
      'project_allocate_equipment: asset % is already allocated on active assignment % for project %',
      p_asset_id, v_conflicting_assignment_id, v_conflicting_project_id
      using errcode = '23514';
  end if;

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

revoke all on function public.project_allocate_equipment(text,uuid,uuid,uuid,text,timestamptz,timestamptz,text,text,jsonb,boolean,text) from public, anon;
grant execute on function public.project_allocate_equipment(text,uuid,uuid,uuid,text,timestamptz,timestamptz,text,text,jsonb,boolean,text) to authenticated, service_role;
