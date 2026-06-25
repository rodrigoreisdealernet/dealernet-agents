-- Post-reset smoke-check for project hierarchy + mixed-fleet allocation
-- (migration 20260614180000_project_hierarchy_mixed_fleet_allocation.sql).
--
-- Run after `supabase db reset --config supabase/config.toml` to confirm:
--   1. project_upsert_hierarchy_node and project_allocate_equipment functions
--      exist and grant EXECUTE to authenticated after reset.
--   2. v_project_equipment_allocations_current view exists and is accessible
--      only by authenticated/service_role (not anon) after reset.
--   3. Project hierarchy upsert creates branch_has_project and
--      project_inherits_requirements_from_project relationships coherently.
--   4. Equipment allocation writes produce project_equipment_assignment
--      entities with correct allocation_source derivation for owned vs leased
--      assets after a fresh reset.
--   5. Current-allocation reads via the view surface project, branch, yard,
--      status, and planned date context for both allocation types.
--   6. Cross-tenant RLS prevents tenant-b authenticated claims from reading
--      tenant-a allocations.

begin;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v_branch_id           uuid;
  v_parent_project_id   uuid;
  v_child_project_id    uuid;
  v_owned_asset_id      uuid;
  v_rented_asset_id     uuid;

  v_assignment_owned_id uuid;
  v_assignment_rented_id uuid;

  v_owned_source        text;
  v_rented_source       text;
  v_alloc_count         bigint;
  v_cross_tenant_count  bigint;

  v_fn_upsert_exists    bool;
  v_fn_alloc_exists     bool;
  v_view_exists         bool;

  v_caught              boolean;
begin
  -- 1. Structural verification: RPCs and view must be present after a fresh db reset.

  select exists(
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'project_upsert_hierarchy_node'
  ) into v_fn_upsert_exists;
  if not v_fn_upsert_exists then
    raise exception 'project_upsert_hierarchy_node function missing after db reset';
  end if;

  select exists(
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'project_allocate_equipment'
  ) into v_fn_alloc_exists;
  if not v_fn_alloc_exists then
    raise exception 'project_allocate_equipment function missing after db reset';
  end if;

  select exists(
    select 1 from information_schema.views
    where table_schema = 'public'
      and table_name   = 'v_project_equipment_allocations_current'
  ) into v_view_exists;
  if not v_view_exists then
    raise exception 'v_project_equipment_allocations_current view missing after db reset';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.project_upsert_hierarchy_node(text,jsonb,uuid,uuid)',
    'EXECUTE'
  ) then
    raise exception 'Expected authenticated EXECUTE on project_upsert_hierarchy_node after reset';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.project_allocate_equipment(text,uuid,uuid,uuid,text,timestamptz,timestamptz,text,text,jsonb,boolean,text)',
    'EXECUTE'
  ) then
    raise exception 'Expected authenticated EXECUTE on project_allocate_equipment after reset';
  end if;

  if has_table_privilege('anon', 'public.v_project_equipment_allocations_current', 'SELECT') then
    raise exception 'anon must not have SELECT on v_project_equipment_allocations_current after reset';
  end if;

  raise notice 'PASS 1: RPCs and view present with correct grants after reset';

  -- 2. Seed minimal fixtures for behavioural assertions.

  select entity_id into v_branch_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'branch',
    p_source_record_id => 'reset-phm-branch',
    p_data             => jsonb_build_object('name', 'Reset PHM Branch', 'tenant', 'tenant-reset-phm')
  );

  select entity_id into v_parent_project_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'project',
    p_source_record_id => 'reset-phm-parent-project',
    p_data             => jsonb_build_object('name', 'Reset PHM Program', 'tenant', 'tenant-reset-phm')
  );

  select entity_id into v_owned_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'reset-phm-owned-asset',
    p_data             => jsonb_build_object(
      'name',           'Reset PHM Owned Excavator',
      'tenant',         'tenant-reset-phm',
      'ownership_type', 'owned'
    )
  );

  select entity_id into v_rented_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'reset-phm-rented-asset',
    p_data             => jsonb_build_object(
      'name',           'Reset PHM Leased Boom Lift',
      'tenant',         'tenant-reset-phm',
      'ownership_type', 'leased'
    )
  );

  perform public.rental_upsert_relationship('branch_has_project',  v_branch_id, v_parent_project_id);
  perform public.rental_upsert_relationship('branch_has_asset',    v_branch_id, v_owned_asset_id);
  perform public.rental_upsert_relationship('branch_has_asset',    v_branch_id, v_rented_asset_id);

  raise notice 'PASS 2: minimal fixtures seeded after reset';

  -- 3. project_upsert_hierarchy_node creates child project with both
  --    branch_has_project and project_inherits_requirements_from_project.

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000c30001","app_metadata":{"role":"branch_manager","tenant":"tenant-reset-phm"}}',
    true
  );

  select upserted.project_id into v_child_project_id
  from public.project_upsert_hierarchy_node(
    p_project_source_record_id => 'reset-phm-child-project',
    p_project_data             => jsonb_build_object('name', 'Reset PHM Phase 2'),
    p_branch_id                => v_branch_id,
    p_parent_project_id        => v_parent_project_id
  ) upserted;

  if v_child_project_id is null then
    raise exception 'Expected child project id from project_upsert_hierarchy_node after reset';
  end if;

  if not exists (
    select 1 from public.relationships_v2
    where relationship_type = 'branch_has_project'
      and parent_id = v_branch_id
      and child_id  = v_child_project_id
      and is_current
  ) then
    raise exception 'Expected branch_has_project relationship for child project after reset';
  end if;

  if not exists (
    select 1 from public.relationships_v2
    where relationship_type = 'project_inherits_requirements_from_project'
      and parent_id = v_parent_project_id
      and child_id  = v_child_project_id
      and is_current
  ) then
    raise exception 'Expected project_inherits_requirements_from_project relationship after reset';
  end if;

  raise notice 'PASS 3: project hierarchy upsert creates correct relationships after reset';

  -- 4. Equipment allocation writes: project_allocate_equipment produces
  --    project_equipment_assignment entities and correct allocation_source.

  select allocated.assignment_id into v_assignment_owned_id
  from public.project_allocate_equipment(
    p_assignment_source_record_id => 'reset-phm-owned-allocation',
    p_project_id                  => v_child_project_id,
    p_asset_id                    => v_owned_asset_id,
    p_branch_id                   => v_branch_id,
    p_yard_context                => 'north-yard',
    p_planned_start               => now() + interval '1 day',
    p_planned_end                 => now() + interval '4 days',
    p_status                      => 'planned',
    p_actor                       => 'reset-dispatcher-owned'
  ) allocated;

  if v_assignment_owned_id is null then
    raise exception 'Expected owned allocation assignment id from project_allocate_equipment after reset';
  end if;

  select allocated.assignment_id into v_assignment_rented_id
  from public.project_allocate_equipment(
    p_assignment_source_record_id => 'reset-phm-rented-allocation',
    p_project_id                  => v_child_project_id,
    p_asset_id                    => v_rented_asset_id,
    p_branch_id                   => v_branch_id,
    p_yard_context                => 'south-yard',
    p_planned_start               => now() + interval '2 days',
    p_planned_end                 => now() + interval '5 days',
    p_status                      => 'on_rent',
    p_actor                       => 'reset-dispatcher-rerent'
  ) allocated;

  if v_assignment_rented_id is null then
    raise exception 'Expected rented allocation assignment id from project_allocate_equipment after reset';
  end if;

  select count(*) into v_alloc_count
  from public.rental_current_entity_state
  where entity_type = 'project_equipment_assignment'
    and entity_id in (v_assignment_owned_id, v_assignment_rented_id);

  if v_alloc_count <> 2 then
    raise exception 'Expected two project_equipment_assignment entities after reset, got %', v_alloc_count;
  end if;

  raise notice 'PASS 4: equipment allocation writes produce assignment entities after reset';

  -- 5. Current-allocation reads: the view surfaces correct allocation_source
  --    for owned vs leased assets, with project/branch/yard/status/date context.

  select allocation_source into v_owned_source
  from public.v_project_equipment_allocations_current
  where assignment_id = v_assignment_owned_id;

  if v_owned_source <> 'owned' then
    raise exception
      'Expected owned allocation_source for owned asset after reset, got %',
      coalesce(v_owned_source, '<null>');
  end if;

  select allocation_source into v_rented_source
  from public.v_project_equipment_allocations_current
  where assignment_id = v_assignment_rented_id;

  if v_rented_source <> 'external_rental' then
    raise exception
      'Expected external_rental allocation_source for leased asset after reset, got %',
      coalesce(v_rented_source, '<null>');
  end if;

  select count(*) into v_alloc_count
  from public.v_project_equipment_allocations_current
  where project_id       = v_child_project_id
    and branch_id        = v_branch_id
    and current_status   in ('planned', 'on_rent')
    and yard_context     in ('north-yard', 'south-yard')
    and planned_start    is not null
    and planned_end      is not null;

  if v_alloc_count <> 2 then
    raise exception
      'Expected 2 allocation rows with full context after reset, got %', v_alloc_count;
  end if;

  raise notice 'PASS 5: current-allocation view returns coherent rows with context after reset';

  -- 6. Cross-tenant RLS: a tenant-b claim must not see tenant-a allocations.

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000c30002","app_metadata":{"role":"branch_manager","tenant":"tenant-b-reset"}}',
    true
  );

  select count(*) into v_cross_tenant_count
  from public.v_project_equipment_allocations_current
  where assignment_id in (v_assignment_owned_id, v_assignment_rented_id);

  if v_cross_tenant_count <> 0 then
    raise exception
      'Expected 0 cross-tenant allocation rows after reset, got %', v_cross_tenant_count;
  end if;

  raise notice 'PASS 6: cross-tenant RLS enforced on v_project_equipment_allocations_current after reset';

  -- 7. Anon read on the view must raise insufficient_privilege.

  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  v_caught := false;
  begin
    perform 1 from public.v_project_equipment_allocations_current limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected anon project equipment allocation read to fail after reset';
  end if;

  raise notice 'PASS 7: anon access on v_project_equipment_allocations_current denied after reset';
end;
$$;

rollback;
