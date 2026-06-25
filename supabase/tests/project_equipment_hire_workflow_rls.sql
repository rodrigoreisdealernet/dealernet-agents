-- Behavioral SQL tests for the project equipment hire workflow
-- (migration 20260614160000_project_equipment_hire_workflow.sql).
--
-- Coverage:
--   Check 1  – grants and RLS basics: anon denied INSERT/SELECT; authenticated denied direct INSERT;
--              service_role has all privileges; RLS is enabled
--   Check 2  – security_invoker = true on v_project_equipment_lifecycle_current
--   Check 3  – direct authenticated INSERT is blocked (bypass closed)
--   Check 4  – project_equipment_transition() callable by admin role; happy-path on_order entry
--   Check 5  – first-entry guard: non-on_order initial transition rejected (errcode 23514)
--   Check 6  – invalid state-machine edge rejected (errcode 23514)
--   Check 7  – terminal state blocks further transitions (errcode 23514)
--   Check 8  – cross-tenant access denied by the RPC (errcode 42501)
--   Check 9  – unauthorised role (read_only) blocked by the RPC (errcode 42501)
--   Check 10 – same-tenant authenticated SELECT allowed; cross-tenant row filtered
--   Check 11 – vendor_ref masked in v_project_equipment_lifecycle_current for field_operator
--
-- Pattern: multiple DO blocks within one transaction using SET LOCAL ROLE +
-- set_config('request.jwt.claims', ...) to simulate PostgREST JWT contexts.

begin;

-- ── Fixture UUIDs (stable so assertions are deterministic) ────────────────
-- project in tenant-a
-- project in tenant-b (cross-tenant probe)
-- two assets in tenant-a
-- one asset in tenant-b
do $$
declare
  v_project_a  constant uuid := 'bb000001-0000-0000-0000-000000000001';
  v_project_b  constant uuid := 'bb000001-0000-0000-0000-000000000002';
  v_asset_1    constant uuid := 'bb000001-0000-0000-0000-000000000011';
  v_asset_2    constant uuid := 'bb000001-0000-0000-0000-000000000012';
  v_asset_b    constant uuid := 'bb000001-0000-0000-0000-000000000021';
begin
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_project_a, 'project', 'hire-wf-project-a'),
    (v_project_b, 'project', 'hire-wf-project-b'),
    (v_asset_1,   'asset',   'hire-wf-asset-1'),
    (v_asset_2,   'asset',   'hire-wf-asset-2'),
    (v_asset_b,   'asset',   'hire-wf-asset-b')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_project_a, 1, true,
      '{"name":"Test Project A","tenant":"tenant-a","status":"active"}'::jsonb, now()),
    (v_project_b, 1, true,
      '{"name":"Test Project B","tenant":"tenant-b","status":"active"}'::jsonb, now()),
    (v_asset_1,   1, true,
      '{"name":"Excavator 1","tenant":"tenant-a","ownership_type":"owned"}'::jsonb, now()),
    (v_asset_2,   1, true,
      '{"name":"Compressor 1","tenant":"tenant-a","ownership_type":"external_rental"}'::jsonb, now()),
    (v_asset_b,   1, true,
      '{"name":"Excavator B","tenant":"tenant-b","ownership_type":"owned"}'::jsonb, now())
  on conflict (entity_id, version_number) do nothing;
end;
$$;

-- ── Check 1: grants and RLS ───────────────────────────────────────────────
do $$
begin
  -- RLS must be enabled
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'project_equipment_lifecycle_log'
      and c.relrowsecurity
  ) then
    raise exception 'FAIL 1a: RLS not enabled on project_equipment_lifecycle_log';
  end if;

  -- anon must have NO privileges on the log table
  if has_table_privilege('anon', 'public.project_equipment_lifecycle_log', 'SELECT') then
    raise exception 'FAIL 1b: anon should not have SELECT on project_equipment_lifecycle_log';
  end if;
  if has_table_privilege('anon', 'public.project_equipment_lifecycle_log', 'INSERT') then
    raise exception 'FAIL 1c: anon should not have INSERT on project_equipment_lifecycle_log';
  end if;

  -- authenticated must have SELECT but NOT INSERT (direct write bypass closed)
  if not has_table_privilege('authenticated', 'public.project_equipment_lifecycle_log', 'SELECT') then
    raise exception 'FAIL 1d: authenticated must have SELECT on project_equipment_lifecycle_log';
  end if;
  if has_table_privilege('authenticated', 'public.project_equipment_lifecycle_log', 'INSERT') then
    raise exception 'FAIL 1e: authenticated must NOT have direct INSERT on project_equipment_lifecycle_log';
  end if;

  -- service_role must have INSERT
  if not has_table_privilege('service_role', 'public.project_equipment_lifecycle_log', 'INSERT') then
    raise exception 'FAIL 1f: service_role must have INSERT on project_equipment_lifecycle_log';
  end if;

  -- authenticated must have EXECUTE on the RPC
  if not has_function_privilege(
    'authenticated',
    'public.project_equipment_transition(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 1g: authenticated must have EXECUTE on project_equipment_transition';
  end if;

  -- anon must NOT have EXECUTE on the RPC
  if has_function_privilege(
    'anon',
    'public.project_equipment_transition(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 1h: anon must not have EXECUTE on project_equipment_transition';
  end if;

  raise notice 'PASS 1: grants and RLS verified';
end;
$$;

-- ── Check 2: security_invoker on the current view ─────────────────────────
do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'v_project_equipment_lifecycle_current';

  if not v_has_invoker then
    raise exception 'FAIL 2: v_project_equipment_lifecycle_current must declare security_invoker = true';
  end if;

  raise notice 'PASS 2: security_invoker = true on v_project_equipment_lifecycle_current';
end;
$$;

-- ── Check 3: direct authenticated INSERT is blocked ───────────────────────
do $$
declare
  v_caught bool := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000a01","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
    true
  );

  begin
    insert into public.project_equipment_lifecycle_log (
      project_id, asset_id, status_key, changed_by, tenant
    ) values (
      'bb000001-0000-0000-0000-000000000001',
      'bb000001-0000-0000-0000-000000000011',
      'on_order',
      'bypass-attempt',
      'tenant-a'
    );
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      -- Any error (e.g. RLS violation) also counts as blocked
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'FAIL 3: authenticated direct INSERT must be denied on project_equipment_lifecycle_log';
  end if;

  raise notice 'PASS 3: direct authenticated INSERT correctly blocked';
end;
$$;

-- ── Check 4: happy-path — admin calls project_equipment_transition on_order ─
do $$
declare
  v_log_id         uuid;
  v_prev_status    text;
  v_new_status     text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000a01","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
    true
  );

  select t.log_id, t.previous_status, t.new_status
    into v_log_id, v_prev_status, v_new_status
    from public.project_equipment_transition(
      p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
      p_asset_id      => 'bb000001-0000-0000-0000-000000000011'::uuid,
      p_target_status => 'on_order',
      p_changed_by    => 'dispatch_system'
    ) t;

  if v_log_id is null then
    raise exception 'FAIL 4a: expected a log_id from project_equipment_transition';
  end if;
  if v_prev_status is not null then
    raise exception 'FAIL 4b: first transition previous_status must be NULL, got "%"', v_prev_status;
  end if;
  if v_new_status <> 'on_order' then
    raise exception 'FAIL 4c: new_status expected "on_order", got "%"', v_new_status;
  end if;

  raise notice 'PASS 4: happy-path on_order transition succeeded';
end;
$$;

-- ── Check 5: first-entry guard — must be on_order ─────────────────────────
do $$
declare
  v_caught bool := false;
  v_state  text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000a01","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
    true
  );

  begin
    -- asset_2 has no existing log row; first transition must be on_order
    perform public.project_equipment_transition(
      p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
      p_asset_id      => 'bb000001-0000-0000-0000-000000000012'::uuid,
      p_target_status => 'on_hire',
      p_changed_by    => 'test'
    );
  exception
    when check_violation then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
    when others then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
  end;

  if not v_caught then
    raise exception 'FAIL 5: first-entry non-on_order must be rejected';
  end if;
  if v_state <> '23514' then
    raise exception 'FAIL 5: expected errcode 23514, got %', v_state;
  end if;

  raise notice 'PASS 5: first-entry guard rejects non-on_order entry with 23514';
end;
$$;

-- ── Check 6: invalid state-machine edge rejected ──────────────────────────
do $$
declare
  v_caught bool := false;
  v_state  text;
begin
  -- First seed on_order for asset_2 via service_role so we can test an invalid edge
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  perform public.project_equipment_transition(
    p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
    p_asset_id      => 'bb000001-0000-0000-0000-000000000012'::uuid,
    p_target_status => 'on_order',
    p_changed_by    => 'test-seed'
  );

  -- Now attempt an invalid on_order → returned edge
  begin
    perform public.project_equipment_transition(
      p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
      p_asset_id      => 'bb000001-0000-0000-0000-000000000012'::uuid,
      p_target_status => 'returned',
      p_changed_by    => 'test'
    );
  exception
    when check_violation then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
    when others then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
  end;

  if not v_caught then
    raise exception 'FAIL 6: invalid edge on_order→returned must be rejected';
  end if;
  if v_state <> '23514' then
    raise exception 'FAIL 6: expected errcode 23514, got %', v_state;
  end if;

  raise notice 'PASS 6: invalid state-machine edge rejected with 23514';
end;
$$;

-- ── Check 7: terminal state blocks further transitions ────────────────────
do $$
declare
  v_caught bool := false;
  v_state  text;
begin
  -- Walk asset_1 through to returned via service_role
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  perform public.project_equipment_transition(
    p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
    p_asset_id      => 'bb000001-0000-0000-0000-000000000011'::uuid,
    p_target_status => 'on_hire',
    p_changed_by    => 'test-terminal'
  );
  perform public.project_equipment_transition(
    p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
    p_asset_id      => 'bb000001-0000-0000-0000-000000000011'::uuid,
    p_target_status => 'off_hire',
    p_changed_by    => 'test-terminal'
  );
  perform public.project_equipment_transition(
    p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
    p_asset_id      => 'bb000001-0000-0000-0000-000000000011'::uuid,
    p_target_status => 'returned',
    p_changed_by    => 'test-terminal'
  );

  -- Now try any further transition — must be blocked
  begin
    perform public.project_equipment_transition(
      p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
      p_asset_id      => 'bb000001-0000-0000-0000-000000000011'::uuid,
      p_target_status => 'on_order',
      p_changed_by    => 'test-terminal'
    );
  exception
    when check_violation then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
    when others then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
  end;

  if not v_caught then
    raise exception 'FAIL 7: transition out of terminal state "returned" must be rejected';
  end if;
  if v_state <> '23514' then
    raise exception 'FAIL 7: expected errcode 23514, got %', v_state;
  end if;

  raise notice 'PASS 7: terminal state correctly blocks further transitions';
end;
$$;

-- ── Check 8: cross-tenant access denied ───────────────────────────────────
do $$
declare
  v_caught bool := false;
  v_state  text;
begin
  -- tenant-a caller tries to act on a project that belongs to tenant-b
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000a01","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
    true
  );

  begin
    perform public.project_equipment_transition(
      p_project_id    => 'bb000001-0000-0000-0000-000000000002'::uuid,
      p_asset_id      => 'bb000001-0000-0000-0000-000000000021'::uuid,
      p_target_status => 'on_order',
      p_changed_by    => 'cross-tenant-attempt'
    );
  exception
    when insufficient_privilege then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
    when others then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
  end;

  if not v_caught then
    raise exception 'FAIL 8: cross-tenant transition must be denied';
  end if;
  if v_state <> '42501' then
    raise exception 'FAIL 8: expected errcode 42501, got %', v_state;
  end if;

  raise notice 'PASS 8: cross-tenant access denied with 42501';
end;
$$;

-- ── Check 9: read_only role blocked by the RPC ────────────────────────────
do $$
declare
  v_caught bool := false;
  v_state  text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000a02","app_metadata":{"role":"read_only","tenant":"tenant-a"}}',
    true
  );

  begin
    perform public.project_equipment_transition(
      p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
      p_asset_id      => 'bb000001-0000-0000-0000-000000000012'::uuid,
      p_target_status => 'on_order',
      p_changed_by    => 'read-only-attempt'
    );
  exception
    when insufficient_privilege then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
    when others then
      v_caught := true;
      get stacked diagnostics v_state = returned_sqlstate;
  end;

  if not v_caught then
    raise exception 'FAIL 9: read_only role must be denied by project_equipment_transition';
  end if;
  if v_state <> '42501' then
    raise exception 'FAIL 9: expected errcode 42501, got %', v_state;
  end if;

  raise notice 'PASS 9: read_only role correctly blocked by RPC';
end;
$$;

-- ── Check 10: same-tenant SELECT allowed; cross-tenant filtered ───────────
do $$
declare
  v_count int;
begin
  -- Insert a tenant-b log row directly as service_role for the cross-tenant probe
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  insert into public.project_equipment_lifecycle_log (
    project_id, asset_id, status_key, changed_by, tenant
  ) values (
    'bb000001-0000-0000-0000-000000000002',
    'bb000001-0000-0000-0000-000000000021',
    'on_order',
    'service-seed',
    'tenant-b'
  );

  -- Now switch to an authenticated tenant-a user
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000a01","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
    true
  );

  -- Should see tenant-a rows only; tenant-b row must be filtered
  select count(*) into v_count
  from public.project_equipment_lifecycle_log
  where tenant = 'tenant-b';

  if v_count > 0 then
    raise exception 'FAIL 10a: tenant-a caller must not see tenant-b rows; got % rows', v_count;
  end if;

  -- Must see tenant-a rows
  select count(*) into v_count
  from public.project_equipment_lifecycle_log
  where tenant = 'tenant-a';

  if v_count = 0 then
    raise exception 'FAIL 10b: tenant-a caller must see own-tenant rows';
  end if;

  raise notice 'PASS 10: same-tenant SELECT allowed; cross-tenant rows filtered';
end;
$$;

-- ── Check 11: vendor_ref masked for field_operator in the view ────────────
do $$
declare
  v_admin_vendor   text;
  v_field_vendor   text;
  v_log_id         uuid;
begin
  -- Seed a log row with a vendor_ref via service_role
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select t.log_id into v_log_id
  from public.project_equipment_transition(
    p_project_id    => 'bb000001-0000-0000-0000-000000000001'::uuid,
    p_asset_id      => 'bb000001-0000-0000-0000-000000000012'::uuid,
    p_target_status => 'on_hire',
    p_changed_by    => 'dispatch',
    p_vendor_ref    => 'HIRE-00421'
  ) t;

  if v_log_id is null then
    raise exception 'FAIL 11 setup: expected log_id from on_hire transition';
  end if;

  -- Admin sees the real vendor_ref
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000a01","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
    true
  );

  select vendor_ref into v_admin_vendor
  from public.v_project_equipment_lifecycle_current
  where project_id = 'bb000001-0000-0000-0000-000000000001'
    and asset_id   = 'bb000001-0000-0000-0000-000000000012';

  if v_admin_vendor is distinct from 'HIRE-00421' then
    raise exception 'FAIL 11a: admin should see vendor_ref "HIRE-00421", got "%"', v_admin_vendor;
  end if;

  -- field_operator sees NULL
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000a03","app_metadata":{"role":"field_operator","tenant":"tenant-a"}}',
    true
  );

  select vendor_ref into v_field_vendor
  from public.v_project_equipment_lifecycle_current
  where project_id = 'bb000001-0000-0000-0000-000000000001'
    and asset_id   = 'bb000001-0000-0000-0000-000000000012';

  if v_field_vendor is not null then
    raise exception 'FAIL 11b: field_operator should see NULL vendor_ref, got "%"', v_field_vendor;
  end if;

  raise notice 'PASS 11: vendor_ref correctly masked for field_operator in the view';
end;
$$;

rollback;
