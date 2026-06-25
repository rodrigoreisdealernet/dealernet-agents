-- Reset-path smoke tests for outbound owned-asset assignment guards
-- (migration 20260617023000_outbound_owned_asset_assignment_guards.sql).
--
-- Closes #2030. Re-kick of PR #2018.
--
-- Run after `supabase db reset --config supabase/config.toml` to confirm:
--   1. project_allocate_equipment is present with authenticated EXECUTE and anon denied.
--   2. Fixtures seed cleanly: one idle asset, seven blocked-status assets, two projects.
--   3. An idle/available owned asset allocates successfully.
--   4. Each blocked status (on_rent, in_transit, inspection_hold, maintenance,
--      unavailable, retired, lost) raises SQLSTATE 23514.
--   5. Cross-project double-booking of an already-active owned asset raises SQLSTATE 23514.
--   6. Same-project re-upsert with the same source_record_id is allowed.

begin;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"role":"admin","tenant":"oag-reset-tenant"}}',
  true
);
set local role service_role;

do $$
declare
  v_fn_exists             bool;
  v_project_a_id          uuid;
  v_project_b_id          uuid;
  v_idle_asset_id         uuid;
  v_asset_on_rent         uuid;
  v_asset_in_transit      uuid;
  v_asset_inspection_hold uuid;
  v_asset_maintenance     uuid;
  v_asset_unavailable     uuid;
  v_asset_retired         uuid;
  v_asset_lost            uuid;
  v_assignment_id         uuid;
  v_caught                bool;
begin

  -- ── 1. Structural: function exists and has correct role grants ─────────────

  select exists(
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'project_allocate_equipment'
  ) into v_fn_exists;

  if not v_fn_exists then
    raise exception 'FAIL 1a: project_allocate_equipment missing after db reset';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.project_allocate_equipment(text,uuid,uuid,uuid,text,timestamptz,timestamptz,text,text,jsonb,boolean,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 1b: authenticated must have EXECUTE on project_allocate_equipment after reset';
  end if;

  if has_function_privilege(
    'anon',
    'public.project_allocate_equipment(text,uuid,uuid,uuid,text,timestamptz,timestamptz,text,text,jsonb,boolean,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 1c: anon must NOT have EXECUTE on project_allocate_equipment after reset';
  end if;

  raise notice 'PASS 1: project_allocate_equipment present with correct grants after reset (authenticated=allowed, anon=denied)';

  -- ── 2. Seed fixtures ────────────────────────────────────────────────────────

  select entity_id into v_project_a_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'project',
    p_source_record_id => 'oag-reset-project-a',
    p_data             => jsonb_build_object('name', 'OAG Reset Project A', 'tenant', 'oag-reset-tenant')
  );

  select entity_id into v_project_b_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'project',
    p_source_record_id => 'oag-reset-project-b',
    p_data             => jsonb_build_object('name', 'OAG Reset Project B', 'tenant', 'oag-reset-tenant')
  );

  select entity_id into v_idle_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'oag-reset-idle-asset',
    p_data             => jsonb_build_object(
      'name',           'OAG Reset Idle Excavator',
      'tenant',         'oag-reset-tenant',
      'ownership_type', 'owned',
      'status',         'available'
    )
  );

  select entity_id into v_asset_on_rent
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'oag-reset-asset-on-rent',
    p_data             => jsonb_build_object(
      'name', 'OAG Reset On-Rent Asset', 'tenant', 'oag-reset-tenant',
      'ownership_type', 'owned', 'status', 'on_rent'
    )
  );

  select entity_id into v_asset_in_transit
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'oag-reset-asset-in-transit',
    p_data             => jsonb_build_object(
      'name', 'OAG Reset In-Transit Asset', 'tenant', 'oag-reset-tenant',
      'ownership_type', 'owned', 'status', 'in_transit'
    )
  );

  select entity_id into v_asset_inspection_hold
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'oag-reset-asset-inspection-hold',
    p_data             => jsonb_build_object(
      'name', 'OAG Reset Inspection-Hold Asset', 'tenant', 'oag-reset-tenant',
      'ownership_type', 'owned', 'status', 'inspection_hold'
    )
  );

  select entity_id into v_asset_maintenance
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'oag-reset-asset-maintenance',
    p_data             => jsonb_build_object(
      'name', 'OAG Reset Maintenance Asset', 'tenant', 'oag-reset-tenant',
      'ownership_type', 'owned', 'status', 'maintenance'
    )
  );

  select entity_id into v_asset_unavailable
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'oag-reset-asset-unavailable',
    p_data             => jsonb_build_object(
      'name', 'OAG Reset Unavailable Asset', 'tenant', 'oag-reset-tenant',
      'ownership_type', 'owned', 'status', 'unavailable'
    )
  );

  select entity_id into v_asset_retired
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'oag-reset-asset-retired',
    p_data             => jsonb_build_object(
      'name', 'OAG Reset Retired Asset', 'tenant', 'oag-reset-tenant',
      'ownership_type', 'owned', 'status', 'retired'
    )
  );

  select entity_id into v_asset_lost
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'oag-reset-asset-lost',
    p_data             => jsonb_build_object(
      'name', 'OAG Reset Lost Asset', 'tenant', 'oag-reset-tenant',
      'ownership_type', 'owned', 'status', 'lost'
    )
  );

  if v_project_a_id is null or v_project_b_id is null then
    raise exception 'FAIL 2: project fixtures did not seed';
  end if;
  if v_idle_asset_id is null then
    raise exception 'FAIL 2: idle asset fixture did not seed';
  end if;
  if v_asset_on_rent is null or v_asset_in_transit is null
     or v_asset_inspection_hold is null or v_asset_maintenance is null
     or v_asset_unavailable is null or v_asset_retired is null
     or v_asset_lost is null then
    raise exception 'FAIL 2: one or more blocked-status asset fixtures did not seed';
  end if;

  raise notice 'PASS 2: fixtures seeded cleanly (2 projects, 1 idle asset, 7 blocked-status assets)';

  -- ── 3. Idle/available owned asset allocates successfully ───────────────────

  select allocated.assignment_id into v_assignment_id
  from public.project_allocate_equipment(
    p_assignment_source_record_id => 'oag-reset-idle-alloc',
    p_project_id                  => v_project_a_id,
    p_asset_id                    => v_idle_asset_id,
    p_status                      => 'planned',
    p_actor                       => 'oag-reset-dispatcher'
  ) allocated;

  if v_assignment_id is null then
    raise exception 'FAIL 3: expected non-null assignment_id for idle/available owned asset';
  end if;

  raise notice 'PASS 3: idle/available owned asset allocates successfully';

  -- ── 4. Blocked statuses each raise SQLSTATE 23514 ──────────────────────────

  -- 4a. on_rent
  v_caught := false;
  begin
    perform public.project_allocate_equipment(
      p_assignment_source_record_id => 'oag-reset-blocked-on-rent',
      p_project_id                  => v_project_a_id,
      p_asset_id                    => v_asset_on_rent
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 4a: on_rent asset must raise SQLSTATE 23514';
  end if;

  -- 4b. in_transit
  v_caught := false;
  begin
    perform public.project_allocate_equipment(
      p_assignment_source_record_id => 'oag-reset-blocked-in-transit',
      p_project_id                  => v_project_a_id,
      p_asset_id                    => v_asset_in_transit
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 4b: in_transit asset must raise SQLSTATE 23514';
  end if;

  -- 4c. inspection_hold
  v_caught := false;
  begin
    perform public.project_allocate_equipment(
      p_assignment_source_record_id => 'oag-reset-blocked-inspection-hold',
      p_project_id                  => v_project_a_id,
      p_asset_id                    => v_asset_inspection_hold
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 4c: inspection_hold asset must raise SQLSTATE 23514';
  end if;

  -- 4d. maintenance
  v_caught := false;
  begin
    perform public.project_allocate_equipment(
      p_assignment_source_record_id => 'oag-reset-blocked-maintenance',
      p_project_id                  => v_project_a_id,
      p_asset_id                    => v_asset_maintenance
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 4d: maintenance asset must raise SQLSTATE 23514';
  end if;

  -- 4e. unavailable
  v_caught := false;
  begin
    perform public.project_allocate_equipment(
      p_assignment_source_record_id => 'oag-reset-blocked-unavailable',
      p_project_id                  => v_project_a_id,
      p_asset_id                    => v_asset_unavailable
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 4e: unavailable asset must raise SQLSTATE 23514';
  end if;

  -- 4f. retired
  v_caught := false;
  begin
    perform public.project_allocate_equipment(
      p_assignment_source_record_id => 'oag-reset-blocked-retired',
      p_project_id                  => v_project_a_id,
      p_asset_id                    => v_asset_retired
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 4f: retired asset must raise SQLSTATE 23514';
  end if;

  -- 4g. lost
  v_caught := false;
  begin
    perform public.project_allocate_equipment(
      p_assignment_source_record_id => 'oag-reset-blocked-lost',
      p_project_id                  => v_project_a_id,
      p_asset_id                    => v_asset_lost
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 4g: lost asset must raise SQLSTATE 23514';
  end if;

  raise notice 'PASS 4: all seven blocked statuses (on_rent, in_transit, inspection_hold, maintenance, unavailable, retired, lost) raise SQLSTATE 23514';

  -- ── 5. Cross-project double-booking raises SQLSTATE 23514 ──────────────────
  -- The idle asset was allocated to project A in PASS 3 (source_record_id
  -- 'oag-reset-idle-alloc', status 'planned'). Allocating the same asset to
  -- project B with a different source_record_id must raise 23514.

  v_caught := false;
  begin
    perform public.project_allocate_equipment(
      p_assignment_source_record_id => 'oag-reset-cross-project-alloc',
      p_project_id                  => v_project_b_id,
      p_asset_id                    => v_idle_asset_id
    );
  exception
    when sqlstate '23514' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 5: cross-project double-booking must raise SQLSTATE 23514';
  end if;

  raise notice 'PASS 5: cross-project double-booking of active owned asset raises SQLSTATE 23514';

  -- ── 6. Same-project re-upsert with the same source_record_id is allowed ────

  v_assignment_id := null;
  begin
    select allocated.assignment_id into v_assignment_id
    from public.project_allocate_equipment(
      p_assignment_source_record_id => 'oag-reset-idle-alloc',
      p_project_id                  => v_project_a_id,
      p_asset_id                    => v_idle_asset_id,
      p_status                      => 'planned',
      p_actor                       => 'oag-reset-dispatcher'
    ) allocated;
  exception
    when others then
      raise exception 'FAIL 6: same-project re-upsert should be allowed, got % "%"',
        sqlstate, sqlerrm;
  end;

  if v_assignment_id is null then
    raise exception 'FAIL 6: expected non-null assignment_id from same-project re-upsert';
  end if;

  raise notice 'PASS 6: same-project re-upsert with the same source_record_id is allowed';

end;
$$;

rollback;
