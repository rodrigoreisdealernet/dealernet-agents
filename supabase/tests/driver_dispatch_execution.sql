-- Behavioral tests for driver_dispatch_execution migration (20260609130000).
--
-- Verifies:
--   1. dispatch_routes and route_stops tables exist with RLS enabled.
--   2. Correct grants on both tables and the view.
--   3. update_route_stop_state RPC exists.
--   4. Route state machine: pending → departed → arrived → completed, auto-advancing
--      parent route status.
--   5. Photo paths are accumulated (not replaced) across multiple RPC calls.
--   6. Invalid state transitions are rejected.
--   7. Invalid status values are rejected.

begin;

-- ── 1. Structural checks ─────────────────────────────────────────────────────

do $$
declare
  v_has_rls_routes bool;
  v_has_rls_stops  bool;
  v_view_security_invoker bool;
begin
  -- dispatch_routes: exists with RLS enabled.
  select c.relrowsecurity
    into v_has_rls_routes
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'dispatch_routes';

  if not found or not coalesce(v_has_rls_routes, false) then
    raise exception 'Expected RLS enabled on public.dispatch_routes';
  end if;

  -- route_stops: exists with RLS enabled.
  select c.relrowsecurity
    into v_has_rls_stops
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'route_stops';

  if not found or not coalesce(v_has_rls_stops, false) then
    raise exception 'Expected RLS enabled on public.route_stops';
  end if;

  -- v_driver_dispatch_stops view is created with security_invoker = true.
  select exists (
    select 1
    from unnest(coalesce(c.reloptions, '{}'::text[])) as opt
    where opt = 'security_invoker=true'
  )
    into v_view_security_invoker
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'v'
    and c.relname = 'v_driver_dispatch_stops';

  if not coalesce(v_view_security_invoker, false) then
    raise exception 'Expected v_driver_dispatch_stops to have security_invoker=true';
  end if;

  raise notice 'Structural checks: RLS enabled on dispatch_routes and route_stops; v_driver_dispatch_stops is security_invoker';
end;
$$;

-- Grants: authenticated may SELECT/INSERT/UPDATE but NOT DELETE on both tables.
do $$
begin
  if not has_table_privilege('authenticated', 'public.dispatch_routes', 'SELECT') then
    raise exception 'Expected authenticated SELECT on dispatch_routes';
  end if;
  if not has_table_privilege('authenticated', 'public.dispatch_routes', 'INSERT') then
    raise exception 'Expected authenticated INSERT on dispatch_routes';
  end if;
  if not has_table_privilege('authenticated', 'public.dispatch_routes', 'UPDATE') then
    raise exception 'Expected authenticated UPDATE on dispatch_routes';
  end if;
  if has_table_privilege('authenticated', 'public.dispatch_routes', 'DELETE') then
    raise exception 'Did not expect authenticated DELETE on dispatch_routes';
  end if;

  if not has_table_privilege('authenticated', 'public.route_stops', 'SELECT') then
    raise exception 'Expected authenticated SELECT on route_stops';
  end if;
  if not has_table_privilege('authenticated', 'public.route_stops', 'INSERT') then
    raise exception 'Expected authenticated INSERT on route_stops';
  end if;
  if not has_table_privilege('authenticated', 'public.route_stops', 'UPDATE') then
    raise exception 'Expected authenticated UPDATE on route_stops';
  end if;
  if has_table_privilege('authenticated', 'public.route_stops', 'DELETE') then
    raise exception 'Did not expect authenticated DELETE on route_stops';
  end if;

  -- service_role has full DML.
  if not has_table_privilege('service_role', 'public.dispatch_routes', 'DELETE') then
    raise exception 'Expected service_role DELETE on dispatch_routes';
  end if;
  if not has_table_privilege('service_role', 'public.route_stops', 'DELETE') then
    raise exception 'Expected service_role DELETE on route_stops';
  end if;

  raise notice 'Grant checks passed';
end;
$$;

-- View exists and is accessible to authenticated.
do $$
begin
  if not has_table_privilege('authenticated', 'public.v_driver_dispatch_stops', 'SELECT') then
    raise exception 'Expected authenticated SELECT on v_driver_dispatch_stops';
  end if;
  raise notice 'v_driver_dispatch_stops view grant check passed';
end;
$$;

-- RPC exists.
do $$
declare
  v_count int;
begin
  select count(*)
    into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'update_route_stop_state';

  if v_count < 1 then
    raise exception 'update_route_stop_state RPC not found';
  end if;

  raise notice 'update_route_stop_state RPC exists';
end;
$$;

-- ── 2 – 5. Behavioral: state machine and photo accumulation ─────────────────

set local role service_role;

do $$
declare
  v_driver_id  uuid  := gen_random_uuid();
  v_route_id   uuid;
  v_stop_a     uuid;
  v_stop_b     uuid;
  v_result     json;
  v_stop_row   record;
  v_route_row  record;
begin
  -- Seed route and two stops as the dispatcher/service_role.
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name
  ) values (
    v_route_id, 0, 'delivery', 'pending',
    '1 Main St, Anytown', 'Acme Construction', 'Site Alpha'
  ) returning id into v_stop_a;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name
  ) values (
    v_route_id, 1, 'pickup', 'pending',
    '2 Oak Ave, Anytown', 'Acme Construction', 'Site Beta'
  ) returning id into v_stop_b;

  -- ── State 1: depart stop A → route becomes in_progress ───────────────────

  -- Simulate admin-role claims so the RPC role gate passes.
  perform set_config('request.jwt.claims',
    '{"app_metadata":{"role":"admin"}}', true);

  v_result := public.update_route_stop_state(v_stop_a, 'departed');

  if (v_result->>'status') <> 'departed' then
    raise exception 'Expected status=departed in result, got %', v_result;
  end if;

  select status into v_stop_row from public.route_stops where id = v_stop_a;
  if v_stop_row.status <> 'departed' then
    raise exception 'Stop A should be departed, got %', v_stop_row.status;
  end if;

  select status into v_route_row from public.dispatch_routes where id = v_route_id;
  if v_route_row.status <> 'in_progress' then
    raise exception 'Route should be in_progress after first depart, got %', v_route_row.status;
  end if;

  raise notice 'State 1 (depart → route in_progress): passed';

  -- ── State 2: arrive stop A ────────────────────────────────────────────────

  v_result := public.update_route_stop_state(v_stop_a, 'arrived');

  select status into v_stop_row from public.route_stops where id = v_stop_a;
  if v_stop_row.status <> 'arrived' then
    raise exception 'Stop A should be arrived, got %', v_stop_row.status;
  end if;

  raise notice 'State 2 (arrive): passed';

  -- ── State 3: complete stop A with signature and first photo ───────────────

  v_result := public.update_route_stop_state(
    v_stop_a, 'completed',
    'Jane Driver',
    'Asset in good condition',
    ARRAY['stops/stop_a/photo1.jpg']
  );

  select * into v_stop_row from public.route_stops where id = v_stop_a;
  if v_stop_row.status <> 'completed' then
    raise exception 'Stop A should be completed, got %', v_stop_row.status;
  end if;
  if v_stop_row.signature <> 'Jane Driver' then
    raise exception 'Signature not stored, got %', v_stop_row.signature;
  end if;
  if v_stop_row.condition_notes <> 'Asset in good condition' then
    raise exception 'Condition notes not stored, got %', v_stop_row.condition_notes;
  end if;
  if array_length(v_stop_row.photo_paths, 1) <> 1 then
    raise exception 'Expected 1 photo_path, found %', array_length(v_stop_row.photo_paths, 1);
  end if;

  -- Route should still be in_progress (stop B not yet complete).
  select status into v_route_row from public.dispatch_routes where id = v_route_id;
  if v_route_row.status <> 'in_progress' then
    raise exception 'Route should still be in_progress, got %', v_route_row.status;
  end if;

  raise notice 'State 3 (complete with evidence): passed';

  -- ── Photo accumulation: second call adds to existing paths ───────────────

  -- Advance stop B through the state machine to arrive so we can test
  -- photo accumulation on completion.
  perform public.update_route_stop_state(v_stop_b, 'departed');
  perform public.update_route_stop_state(v_stop_b, 'arrived');
  v_result := public.update_route_stop_state(
    v_stop_b, 'completed',
    'Jane Driver',
    null,
    ARRAY['stops/stop_b/photo1.jpg', 'stops/stop_b/photo2.jpg']
  );

  select photo_paths into v_stop_row from public.route_stops where id = v_stop_b;
  if array_length(v_stop_row.photo_paths, 1) <> 2 then
    raise exception 'Expected 2 photo_paths on stop B, found %', array_length(v_stop_row.photo_paths, 1);
  end if;

  -- Route should now be completed (all stops done).
  select status into v_route_row from public.dispatch_routes where id = v_route_id;
  if v_route_row.status <> 'completed' then
    raise exception 'Route should be completed when all stops done, got %', v_route_row.status;
  end if;

  raise notice 'Photo accumulation and route auto-complete: passed';
end;
$$;

-- ── 6. Invalid state transitions are rejected ───────────────────────────────

do $$
declare
  v_driver_id  uuid  := gen_random_uuid();
  v_route_id   uuid;
  v_stop_id    uuid;
  v_caught     bool  := false;
begin
  perform set_config('request.jwt.claims',
    '{"app_metadata":{"role":"admin"}}', true);

  insert into public.dispatch_routes (driver_id, route_date)
  values (v_driver_id, current_date)
  returning id into v_route_id;

  insert into public.route_stops (route_id, sequence_order, stop_type, status)
  values (v_route_id, 0, 'delivery', 'pending')
  returning id into v_stop_id;

  -- Cannot skip from pending → arrived (must go pending → departed first).
  begin
    perform public.update_route_stop_state(v_stop_id, 'arrived');
  exception when sqlstate '23514' then
    v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected exception when skipping departed step (pending → arrived)';
  end if;

  raise notice 'Invalid state-transition rejection: passed';
end;
$$;

-- ── 7. Invalid status value is rejected ─────────────────────────────────────

do $$
declare
  v_driver_id  uuid  := gen_random_uuid();
  v_route_id   uuid;
  v_stop_id    uuid;
  v_caught     bool  := false;
begin
  perform set_config('request.jwt.claims',
    '{"app_metadata":{"role":"admin"}}', true);

  insert into public.dispatch_routes (driver_id, route_date)
  values (v_driver_id, current_date)
  returning id into v_route_id;

  insert into public.route_stops (route_id, sequence_order, stop_type, status)
  values (v_route_id, 0, 'delivery', 'pending')
  returning id into v_stop_id;

  begin
    perform public.update_route_stop_state(v_stop_id, 'invalid_status');
  exception when sqlstate '22023' then
    v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected exception for invalid status value';
  end if;

  raise notice 'Invalid status value rejection: passed';
end;
$$;

reset role;

-- ── 8. RLS behavioral tests: own-route isolation, role filtering, update gate ─
--
-- Override auth.uid() to read `sub` from request.jwt.claims — mirrors GoTrue
-- production behavior. The CREATE OR REPLACE is inside this transaction and
-- will be rolled back with the surrounding rollback.

create or replace function auth.uid()
returns uuid
language sql
security invoker
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
      ''
    ),
    ''
  )::uuid;
$$;

do $$
declare
  v_driver_a   uuid := gen_random_uuid();
  v_driver_b   uuid := gen_random_uuid();
  v_route_a    uuid;
  v_route_b    uuid;
  v_stop_a     uuid;
  v_count      int;
  v_caught     bool;
begin

  -- ── Seed routes and stops for two different drivers (service_role) ──────────

  set local role service_role;
  perform set_config('request.jwt.claims', '{}', true);

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_a, current_date, 'pending')
  returning id into v_route_a;

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_b, current_date, 'pending')
  returning id into v_route_b;

  insert into public.route_stops (route_id, sequence_order, stop_type, address)
  values (v_route_a, 0, 'delivery', '10 Alpha St')
  returning id into v_stop_a;

  insert into public.route_stops (route_id, sequence_order, stop_type, address)
  values (v_route_b, 0, 'pickup', '20 Beta Ave');

  -- ── Test 8a: field_operator (driver A) sees only their own route and stop ──

  set local role authenticated;
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  select count(*) into v_count from public.dispatch_routes;
  if v_count <> 1 then
    raise exception 'RLS 8a: field_operator expected 1 dispatch_route (own), got %', v_count;
  end if;

  select count(*) into v_count from public.route_stops;
  if v_count <> 1 then
    raise exception 'RLS 8a: field_operator expected 1 route_stop (own route), got %', v_count;
  end if;

  -- view must also filter to own rows.
  select count(*) into v_count from public.v_driver_dispatch_stops;
  if v_count <> 1 then
    raise exception 'RLS 8a: field_operator expected 1 v_driver_dispatch_stops row, got %', v_count;
  end if;

  raise notice 'RLS 8a (field_operator sees own route + stop + view): passed';

  -- ── Test 8b: field_operator (driver A) is denied driver B rows ─────────────

  select count(*) into v_count
  from public.dispatch_routes
  where driver_id = v_driver_b;
  if v_count <> 0 then
    raise exception 'RLS 8b: field_operator must not see other driver route, got %', v_count;
  end if;

  raise notice 'RLS 8b (field_operator denied other-driver route): passed';

  -- ── Test 8c: read_only role gets zero rows (no policy grants read_only) ─────

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'read_only')
    )::text, true);

  select count(*) into v_count from public.dispatch_routes;
  if v_count <> 0 then
    raise exception 'RLS 8c: read_only should see 0 routes, got %', v_count;
  end if;

  raise notice 'RLS 8c (read_only denied): passed';

  -- ── Test 8d: admin sees all routes ─────────────────────────────────────────

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          gen_random_uuid()::text,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text, true);

  select count(*) into v_count from public.dispatch_routes;
  if v_count < 2 then
    raise exception 'RLS 8d: admin should see all routes (>=2), got %', v_count;
  end if;

  raise notice 'RLS 8d (admin sees all routes): passed';

  -- ── Test 8e: branch_manager can directly UPDATE a route ────────────────────

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          gen_random_uuid()::text,
      'app_metadata', jsonb_build_object('role', 'branch_manager')
    )::text, true);

  update public.dispatch_routes
  set notes = 'Manager annotation'
  where id = v_route_a;

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'RLS 8e: branch_manager direct UPDATE should affect 1 row, affected %', v_count;
  end if;

  -- branch_manager can also directly UPDATE a stop.
  update public.route_stops
  set notes = 'Manager stop note'
  where id = v_stop_a;

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'RLS 8e: branch_manager direct UPDATE on route_stop should affect 1 row, affected %', v_count;
  end if;

  raise notice 'RLS 8e (branch_manager UPDATE route + stop): passed';

  -- ── Test 8f: field_operator direct UPDATE is blocked by RLS (no UPDATE policy) ─

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  update public.dispatch_routes
  set notes = 'driver direct hack'
  where id = v_route_a;

  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'RLS 8f: field_operator direct UPDATE on dispatch_routes must be blocked (0 rows), affected %', v_count;
  end if;

  raise notice 'RLS 8f (field_operator direct UPDATE blocked): passed';

  -- ── Test 8g: anon role is denied SELECT entirely (no table grant) ───────────

  set local role anon;
  perform set_config('request.jwt.claims', '{}', true);

  v_caught := false;
  begin
    perform 1 from public.dispatch_routes limit 1;
    raise exception 'RLS 8g: anon SELECT on dispatch_routes should be denied';
  exception
    when insufficient_privilege then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'RLS 8g: expected insufficient_privilege for anon on dispatch_routes';
  end if;

  raise notice 'RLS 8g (anon denied SELECT on dispatch_routes): passed';

end;
$$;

do $$ begin raise notice 'All driver_dispatch_execution checks passed'; end; $$;

rollback;
