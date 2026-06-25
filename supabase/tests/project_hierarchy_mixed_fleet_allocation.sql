-- Behavioral checks for 20260614180000_project_hierarchy_mixed_fleet_allocation.sql.

begin;

do $$
declare
  v_branch_id uuid;
  v_parent_project_id uuid;
  v_child_project_id uuid;
  v_sibling_project_id uuid;
  v_owned_asset_id uuid;
  v_rented_asset_id uuid;
  v_in_transit_asset_id uuid;

  v_assignment_owned_id uuid;
  v_assignment_rented_id uuid;

  v_owned_source text;
  v_rented_source text;
  v_alloc_count int;
  v_cross_tenant_count int;

  v_caught boolean;
begin
  if not has_function_privilege('authenticated', 'public.project_upsert_hierarchy_node(text,jsonb,uuid,uuid)', 'EXECUTE') then
    raise exception 'Expected authenticated EXECUTE on project_upsert_hierarchy_node';
  end if;

  if not has_function_privilege('authenticated', 'public.project_allocate_equipment(text,uuid,uuid,uuid,text,timestamptz,timestamptz,text,text,jsonb,boolean,text)', 'EXECUTE') then
    raise exception 'Expected authenticated EXECUTE on project_allocate_equipment';
  end if;

  if has_table_privilege('anon', 'public.v_project_equipment_allocations_current', 'SELECT') then
    raise exception 'anon should not have SELECT on v_project_equipment_allocations_current';
  end if;

  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select entity_id
  into v_branch_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'project-hierarchy-branch-1',
    p_data => jsonb_build_object('name', 'Project Branch A', 'tenant', 'tenant-a')
  );

  select entity_id
  into v_parent_project_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'project',
    p_source_record_id => 'project-hierarchy-parent',
    p_data => jsonb_build_object('name', 'Airport Program', 'tenant', 'tenant-a')
  );

  select entity_id
  into v_owned_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'project-hierarchy-owned-asset',
    p_data => jsonb_build_object('name', 'Owned Excavator', 'tenant', 'tenant-a', 'ownership_type', 'owned')
  );

  select entity_id
  into v_rented_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'project-hierarchy-rented-asset',
    p_data => jsonb_build_object('name', 'External Rerent Boom', 'tenant', 'tenant-a', 'ownership_type', 'leased')
  );

  select entity_id
  into v_in_transit_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'project-hierarchy-in-transit-asset',
    p_data => jsonb_build_object(
      'name', 'In Transit Owned Loader',
      'tenant', 'tenant-a',
      'ownership_type', 'owned',
      'status', 'in_transit'
    )
  );

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000b901","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}',
    true
  );

  select upserted.project_id
  into v_child_project_id
  from public.project_upsert_hierarchy_node(
    p_project_source_record_id => 'project-hierarchy-child',
    p_project_data => jsonb_build_object('name', 'Airport Program - Phase 2'),
    p_branch_id => v_branch_id,
    p_parent_project_id => v_parent_project_id
  ) upserted;

  if v_child_project_id is null then
    raise exception 'Expected child project id from project_upsert_hierarchy_node';
  end if;

  select upserted.project_id
  into v_sibling_project_id
  from public.project_upsert_hierarchy_node(
    p_project_source_record_id => 'project-hierarchy-sibling',
    p_project_data => jsonb_build_object('name', 'Airport Program - Phase 3'),
    p_branch_id => v_branch_id,
    p_parent_project_id => v_parent_project_id
  ) upserted;

  if v_sibling_project_id is null then
    raise exception 'Expected sibling project id from project_upsert_hierarchy_node';
  end if;

  if not exists (
    select 1
    from public.relationships_v2 rel
    where rel.relationship_type = 'branch_has_project'
      and rel.parent_id = v_branch_id
      and rel.child_id = v_child_project_id
      and rel.is_current
  ) then
    raise exception 'Expected branch_has_project hierarchy relationship for child project';
  end if;

  if not exists (
    select 1
    from public.relationships_v2 rel
    where rel.relationship_type = 'project_inherits_requirements_from_project'
      and rel.parent_id = v_parent_project_id
      and rel.child_id = v_child_project_id
      and rel.is_current
  ) then
    raise exception 'Expected parent->child project hierarchy relationship';
  end if;

  select allocated.assignment_id
  into v_assignment_owned_id
  from public.project_allocate_equipment(
    p_assignment_source_record_id => 'project-hierarchy-owned-allocation',
    p_project_id => v_child_project_id,
    p_asset_id => v_owned_asset_id,
    p_branch_id => v_branch_id,
    p_yard_context => 'north-yard',
    p_planned_start => now() + interval '1 day',
    p_planned_end => now() + interval '4 days',
    p_status => 'planned',
    p_actor => 'dispatcher-owned'
  ) allocated;

  if v_assignment_owned_id is null then
    raise exception 'Expected owned allocation assignment id';
  end if;

  select allocated.assignment_id
  into v_assignment_rented_id
  from public.project_allocate_equipment(
    p_assignment_source_record_id => 'project-hierarchy-rented-allocation',
    p_project_id => v_child_project_id,
    p_asset_id => v_rented_asset_id,
    p_branch_id => v_branch_id,
    p_yard_context => 'south-yard',
    p_planned_start => now() + interval '2 day',
    p_planned_end => now() + interval '5 days',
    p_status => 'on_rent',
    p_actor => 'dispatcher-rerent'
  ) allocated;

  if v_assignment_rented_id is null then
    raise exception 'Expected rented allocation assignment id';
  end if;

  v_caught := false;
  begin
    perform 1
    from public.project_allocate_equipment(
      p_assignment_source_record_id => 'project-hierarchy-owned-double-book',
      p_project_id => v_sibling_project_id,
      p_asset_id => v_owned_asset_id,
      p_branch_id => v_branch_id,
      p_status => 'planned',
      p_actor => 'dispatcher-double-book'
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected active owned-asset double-book allocation to fail with 23514';
  end if;

  v_caught := false;
  begin
    perform 1
    from public.project_allocate_equipment(
      p_assignment_source_record_id => 'project-hierarchy-in-transit-allocation',
      p_project_id => v_child_project_id,
      p_asset_id => v_in_transit_asset_id,
      p_branch_id => v_branch_id,
      p_status => 'planned',
      p_actor => 'dispatcher-in-transit'
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected in_transit asset allocation to fail with 23514';
  end if;

  select count(*)
  into v_alloc_count
  from public.rental_current_entity_state r
  where r.entity_type = 'project_equipment_assignment'
    and r.entity_id in (v_assignment_owned_id, v_assignment_rented_id);

  if v_alloc_count <> 2 then
    raise exception 'Expected two project_equipment_assignment entities, got %', v_alloc_count;
  end if;

  select allocation_source
  into v_owned_source
  from public.v_project_equipment_allocations_current
  where assignment_id = v_assignment_owned_id;

  if v_owned_source <> 'owned' then
    raise exception 'Expected owned allocation_source for owned asset, got %', coalesce(v_owned_source, '<null>');
  end if;

  select allocation_source
  into v_rented_source
  from public.v_project_equipment_allocations_current
  where assignment_id = v_assignment_rented_id;

  if v_rented_source <> 'external_rental' then
    raise exception 'Expected external_rental allocation_source for leased asset, got %', coalesce(v_rented_source, '<null>');
  end if;

  select count(*)
  into v_alloc_count
  from public.v_project_equipment_allocations_current alloc
  where alloc.project_id = v_child_project_id
    and alloc.branch_id = v_branch_id
    and alloc.current_status in ('planned', 'on_rent')
    and alloc.yard_context in ('north-yard', 'south-yard')
    and alloc.planned_start is not null
    and alloc.planned_end is not null;

  if v_alloc_count <> 2 then
    raise exception 'Expected 2 allocation rows with project/branch/yard/planned/status context, got %', v_alloc_count;
  end if;

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000b902","app_metadata":{"role":"branch_manager","tenant":"tenant-b"}}',
    true
  );

  select count(*)
  into v_cross_tenant_count
  from public.v_project_equipment_allocations_current
  where assignment_id in (v_assignment_owned_id, v_assignment_rented_id);

  if v_cross_tenant_count <> 0 then
    raise exception 'Expected tenant-b authenticated claim to see 0 tenant-a allocations, got %', v_cross_tenant_count;
  end if;

  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  v_caught := false;
  begin
    perform 1
    from public.v_project_equipment_allocations_current
    limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected anon project equipment allocation read to fail';
  end if;
end;
$$;

rollback;
