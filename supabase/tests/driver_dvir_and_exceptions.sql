-- Behavioral tests for field driver DVIR and route exception capture
-- (migration 20260615180000_field_driver_dvir_and_exceptions.sql).
--
-- Verifies:
--   1. dvir_submissions and route_stop_exceptions tables exist with RLS enabled.
--   2. Correct grants on both tables.
--   3. submit_dvir RPC: inserts record, sets requires_review for unsafe DVIR,
--      rejects unknown route, rejects wrong driver.
--   4. submit_stop_exception RPC: inserts record, rejects invalid exception_type,
--      rejects wrong driver's stop.
--   5. v_driver_dispatch_stops exposes dvir_submitted and exception_count.

begin;

-- ── 1. Structural checks ─────────────────────────────────────────────────────

do $$
declare
  v_has_rls_dvir bool;
  v_has_rls_rse  bool;
begin
  select c.relrowsecurity
    into v_has_rls_dvir
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'dvir_submissions';

  if not found or not coalesce(v_has_rls_dvir, false) then
    raise exception 'Expected RLS enabled on public.dvir_submissions';
  end if;

  select c.relrowsecurity
    into v_has_rls_rse
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'route_stop_exceptions';

  if not found or not coalesce(v_has_rls_rse, false) then
    raise exception 'Expected RLS enabled on public.route_stop_exceptions';
  end if;

  raise notice 'Structural checks: RLS enabled on dvir_submissions and route_stop_exceptions';
end;
$$;

-- ── 2. Grants ─────────────────────────────────────────────────────────────────

do $$
begin
  if not has_table_privilege('authenticated', 'public.dvir_submissions', 'SELECT') then
    raise exception 'Expected authenticated SELECT on dvir_submissions';
  end if;
  -- INSERT must be denied: drivers write exclusively through the submit_dvir RPC.
  if has_table_privilege('authenticated', 'public.dvir_submissions', 'INSERT') then
    raise exception 'Did not expect authenticated INSERT on dvir_submissions (RPC-only write path)';
  end if;
  if has_table_privilege('authenticated', 'public.dvir_submissions', 'DELETE') then
    raise exception 'Did not expect authenticated DELETE on dvir_submissions';
  end if;

  if not has_table_privilege('authenticated', 'public.route_stop_exceptions', 'SELECT') then
    raise exception 'Expected authenticated SELECT on route_stop_exceptions';
  end if;
  -- INSERT must be denied: drivers write exclusively through the submit_stop_exception RPC.
  if has_table_privilege('authenticated', 'public.route_stop_exceptions', 'INSERT') then
    raise exception 'Did not expect authenticated INSERT on route_stop_exceptions (RPC-only write path)';
  end if;
  if has_table_privilege('authenticated', 'public.route_stop_exceptions', 'DELETE') then
    raise exception 'Did not expect authenticated DELETE on route_stop_exceptions';
  end if;

  if not has_table_privilege('service_role', 'public.dvir_submissions', 'DELETE') then
    raise exception 'Expected service_role DELETE on dvir_submissions';
  end if;
  if not has_table_privilege('service_role', 'public.route_stop_exceptions', 'DELETE') then
    raise exception 'Expected service_role DELETE on route_stop_exceptions';
  end if;

  raise notice 'Grant checks passed for dvir_submissions and route_stop_exceptions';
end;
$$;

-- ── 3. submit_dvir RPC ────────────────────────────────────────────────────────

do $$
declare
  v_driver_a   uuid := gen_random_uuid();
  v_driver_b   uuid := gen_random_uuid();
  v_route_a    uuid;
  v_dvir_id    uuid;
  v_safe       bool;
  v_requires   bool;
  v_err_hit    bool;
begin
  -- Seed a dispatch route for driver A.
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_a, current_date, 'pending')
  returning id into v_route_a;

  -- Establish driver A JWT claims so auth.uid() returns v_driver_a inside
  -- security-definer RPCs for tests 3a and 3b.
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  -- ── Test 3a: submit a safe DVIR as service_role ───────────────────────────

  -- service_role bypasses RLS; we test RPC logic directly here.
  v_dvir_id := public.submit_dvir(
    p_route_id         => v_route_a,
    p_truck_id         => 'TRK-001',
    p_odometer_reading => 12345.0,
    p_defects          => '[]',
    p_is_safe_to_drive => true,
    p_notes            => 'All clear',
    p_signature        => 'Driver A Sig'
  );

  select is_safe_to_drive, requires_review
    into v_safe, v_requires
  from public.dvir_submissions
  where id = v_dvir_id;

  if not v_safe then
    raise exception 'Expected is_safe_to_drive = true for safe DVIR';
  end if;
  if v_requires then
    raise exception 'Expected requires_review = false for safe DVIR';
  end if;

  raise notice 'Test 3a passed: safe DVIR inserted, requires_review = false';

  -- ── Test 3b: unsafe DVIR must set requires_review = true ─────────────────

  v_dvir_id := public.submit_dvir(
    p_route_id         => v_route_a,
    p_is_safe_to_drive => false,
    p_defects          => '[{"item":"brakes","severity":"critical"}]',
    p_notes            => 'Brake issue'
  );

  select requires_review
    into v_requires
  from public.dvir_submissions
  where id = v_dvir_id;

  if not v_requires then
    raise exception 'Expected requires_review = true for unsafe DVIR (system must not auto-clear safety exceptions)';
  end if;

  raise notice 'Test 3b passed: unsafe DVIR sets requires_review = true';

  -- ── Test 3c: invalid route rejected ──────────────────────────────────────

  v_err_hit := false;
  begin
    -- Run bundle access assertions as authenticated so security-invoker + RLS
    -- are evaluated the same way as application callers.
    set local role authenticated;
    perform set_config('request.jwt.claims',
      jsonb_build_object(
        'sub',          v_driver_b::text,
        'app_metadata', jsonb_build_object('role', 'field_operator')
      )::text, true);

    perform public.submit_dvir(
      p_route_id         => gen_random_uuid(),  -- non-existent route
      p_is_safe_to_drive => true
    );
  exception when others then
    v_err_hit := true;
    raise notice 'Test 3c: got expected error: %', sqlerrm;
  end;

  if not v_err_hit then
    raise exception 'Test 3c failed: expected rejection for DVIR against unknown route';
  end if;

  raise notice 'Test 3c passed: unknown route rejected';

  -- ── Test 3d: driver B cannot submit DVIR for driver A route ──────────────

  v_err_hit := false;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims',
      jsonb_build_object(
        'sub',          v_driver_b::text,
        'app_metadata', jsonb_build_object('role', 'field_operator')
      )::text, true);

    perform public.submit_dvir(
      p_route_id         => v_route_a,
      p_is_safe_to_drive => true
    );
  exception when others then
    v_err_hit := true;
    raise notice 'Test 3d: got expected error: %', sqlerrm;
  end;

  if not v_err_hit then
    raise exception 'Test 3d failed: expected rejection for driver B submitting DVIR for driver A route';
  end if;

  raise notice 'Test 3d passed: wrong driver rejected for DVIR';
end;
$$;

-- ── 4. submit_stop_exception RPC ─────────────────────────────────────────────

do $$
declare
  v_driver_a   uuid := gen_random_uuid();
  v_driver_b   uuid := gen_random_uuid();
  v_route_a    uuid;
  v_stop_a     uuid;
  v_eta_exc_id uuid;
  v_exc_id     uuid;
  v_exc_id_2   uuid;
  v_exc_type   text;
  v_requires   bool;
  v_delay_min  int;
  v_notes      text;
  v_photo_len  int;
  v_err_hit    bool;
begin
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_a, current_date, 'in_progress')
  returning id into v_route_a;

  insert into public.route_stops (route_id, sequence_order, stop_type, address)
  values (v_route_a, 0, 'delivery', '10 Test Ln')
  returning id into v_stop_a;

  -- Establish driver A JWT claims so auth.uid() returns v_driver_a inside
  -- security-definer RPCs for tests 4a and 4b.
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  -- ── Test 4a: valid ETA delay exception ───────────────────────────────────

  v_eta_exc_id := public.submit_stop_exception(
    p_stop_id                 => v_stop_a,
    p_exception_type          => 'eta_delay',
    p_notes                   => 'Traffic on Main St',
    p_photo_paths             => array['evidence/eta-initial.jpg'],
    p_estimated_delay_minutes => 20
  );

  select exception_type, requires_human_review
    into v_exc_type, v_requires
  from public.route_stop_exceptions
  where id = v_eta_exc_id;

  if v_exc_type <> 'eta_delay' then
    raise exception 'Expected exception_type = eta_delay; got %', v_exc_type;
  end if;
  if not v_requires then
    raise exception 'Expected requires_human_review = true for eta_delay exception';
  end if;

  raise notice 'Test 4a passed: eta_delay exception inserted with requires_human_review = true';

  -- ── Test 4b: damage exception ─────────────────────────────────────────────

  v_exc_id := public.submit_stop_exception(
    p_stop_id        => v_stop_a,
    p_exception_type => 'damage',
    p_notes          => 'Bucket bent',
    p_photo_paths    => array['evidence/photo1.jpg']
  );

  select requires_human_review
    into v_requires
  from public.route_stop_exceptions
  where id = v_exc_id;

  if not v_requires then
    raise exception 'Expected requires_human_review = true for damage exception';
  end if;

  raise notice 'Test 4b passed: damage exception inserted';

  -- ── Test 4b2: repeated exception update collapses into current thread ─────

  v_exc_id_2 := public.submit_stop_exception(
    p_stop_id                 => v_stop_a,
    p_exception_type          => 'eta_delay',
    p_notes                   => 'Traffic easing, revised ETA',
    p_photo_paths             => array['evidence/eta-followup.jpg'],
    p_estimated_delay_minutes => 12
  );

  if v_exc_id_2 <> v_eta_exc_id then
    raise exception
      'Expected eta_delay update to collapse into existing thread. First id %, second id %',
      v_eta_exc_id, v_exc_id_2;
  end if;

  select estimated_delay_minutes, notes, cardinality(photo_paths)
    into v_delay_min, v_notes, v_photo_len
  from public.route_stop_exceptions
  where id = v_eta_exc_id;

  if v_delay_min <> 12 then
    raise exception 'Expected deduped eta_delay thread to update estimated_delay_minutes to 12; got %', v_delay_min;
  end if;
  if v_notes <> 'Traffic easing, revised ETA' then
    raise exception 'Expected deduped eta_delay thread to update notes; got %', coalesce(v_notes, '<null>');
  end if;
  if coalesce(v_photo_len, 0) <> 2 then
    raise exception 'Expected deduped eta_delay thread to preserve both photo paths; got %', coalesce(v_photo_len, 0);
  end if;

  raise notice 'Test 4b2 passed: repeated eta_delay updates collapse into one unresolved thread';

  -- ── Test 4c: invalid exception_type rejected ─────────────────────────────

  v_err_hit := false;
  begin
    perform public.submit_stop_exception(
      p_stop_id        => v_stop_a,
      p_exception_type => 'bad_type'
    );
  exception when others then
    v_err_hit := true;
    raise notice 'Test 4c: got expected error: %', sqlerrm;
  end;

  if not v_err_hit then
    raise exception 'Test 4c failed: expected rejection for invalid exception_type';
  end if;

  raise notice 'Test 4c passed: invalid exception_type rejected';

  -- ── Test 4d: driver B cannot submit exception for driver A stop ───────────

  v_err_hit := false;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims',
      jsonb_build_object(
        'sub',          v_driver_b::text,
        'app_metadata', jsonb_build_object('role', 'field_operator')
      )::text, true);

    perform public.submit_stop_exception(
      p_stop_id        => v_stop_a,
      p_exception_type => 'eta_delay',
      p_notes          => 'Unauthorized'
    );
  exception when others then
    v_err_hit := true;
    raise notice 'Test 4d: got expected error: %', sqlerrm;
  end;

  if not v_err_hit then
    raise exception 'Test 4d failed: expected rejection for driver B submitting exception for driver A stop';
  end if;

  raise notice 'Test 4d passed: wrong driver rejected for exception submission';
end;
$$;

-- ── 5. v_driver_dispatch_stops: dvir_submitted and exception_count ────────────

do $$
declare
  v_driver_a uuid := gen_random_uuid();
  v_route_a  uuid;
  v_stop_a   uuid;
  v_dvir_submitted bool;
  v_exc_count      int;
begin
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_a, current_date, 'pending')
  returning id into v_route_a;

  insert into public.route_stops (route_id, sequence_order, stop_type, address)
  values (v_route_a, 0, 'pickup', '20 Sample Ave')
  returning id into v_stop_a;

  -- Before DVIR: dvir_submitted should be false.
  select dvir_submitted, exception_count
    into v_dvir_submitted, v_exc_count
  from public.v_driver_dispatch_stops
  where stop_id = v_stop_a;

  if coalesce(v_dvir_submitted, true) then
    raise exception 'Expected dvir_submitted = false before any DVIR';
  end if;
  if coalesce(v_exc_count, -1) <> 0 then
    raise exception 'Expected exception_count = 0 before any exception; got %', v_exc_count;
  end if;

  raise notice 'Test 5a passed: dvir_submitted = false, exception_count = 0 before DVIR/exceptions';

  -- Set driver A JWT claims so auth.uid() is non-null inside the security-definer
  -- RPCs called below (submit_dvir inserts driver_id NOT NULL).
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  -- Submit DVIR: dvir_submitted should become true.
  perform public.submit_dvir(p_route_id => v_route_a, p_is_safe_to_drive => true);

  select dvir_submitted
    into v_dvir_submitted
  from public.v_driver_dispatch_stops
  where stop_id = v_stop_a;

  if not coalesce(v_dvir_submitted, false) then
    raise exception 'Expected dvir_submitted = true after DVIR submission';
  end if;

  raise notice 'Test 5b passed: dvir_submitted = true after DVIR submission';

  -- Submit exception: exception_count should increment.
  perform public.submit_stop_exception(
    p_stop_id        => v_stop_a,
    p_exception_type => 'access_issue',
    p_notes          => 'Gate locked'
  );

  select exception_count
    into v_exc_count
  from public.v_driver_dispatch_stops
  where stop_id = v_stop_a;

  if coalesce(v_exc_count, 0) <> 1 then
    raise exception 'Expected exception_count = 1 after one exception; got %', v_exc_count;
  end if;

  raise notice 'Test 5c passed: exception_count = 1 after one unresolved exception';

  -- Re-submit same stop + type; count should remain 1 because thread is collapsed.
  perform public.submit_stop_exception(
    p_stop_id        => v_stop_a,
    p_exception_type => 'access_issue',
    p_notes          => 'No callback yet'
  );

  select exception_count
    into v_exc_count
  from public.v_driver_dispatch_stops
  where stop_id = v_stop_a;

  if coalesce(v_exc_count, 0) <> 1 then
    raise exception 'Expected exception_count = 1 after repeated access_issue update; got %', v_exc_count;
  end if;

  raise notice 'Test 5d passed: repeated stop updates stay collapsed in one current thread';
end;
$$;

-- ── 6. RLS behavioral checks ──────────────────────────────────────────────────
--
-- Verifies the four RLS boundaries that the migration comment promises:
--   a/b) field_operator sees only their own dvir_submissions rows.
--   c/d) field_operator sees only route_stop_exceptions for their own stops.
--   e)   branch_manager sees all rows on both tables.
--   f/g) Authenticated callers cannot INSERT directly; writes go through RPCs.

do $$
declare
  v_driver_a uuid := gen_random_uuid();
  v_driver_b uuid := gen_random_uuid();
  v_route_a  uuid;
  v_route_b  uuid;
  v_stop_a   uuid;
  v_stop_b   uuid;
  v_count    int;
  v_caught   bool;
begin
  -- Seed two routes and stops via superuser (bypasses RLS).
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_a, current_date, 'pending')
  returning id into v_route_a;

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_b, current_date, 'pending')
  returning id into v_route_b;

  insert into public.route_stops (route_id, sequence_order, stop_type, address)
  values (v_route_a, 0, 'delivery', '1 Alpha St')
  returning id into v_stop_a;

  insert into public.route_stops (route_id, sequence_order, stop_type, address)
  values (v_route_b, 0, 'delivery', '2 Beta St')
  returning id into v_stop_b;

  -- Seed one DVIR and one exception per driver directly (service_role path).
  insert into public.dvir_submissions (route_id, driver_id, is_safe_to_drive)
  values (v_route_a, v_driver_a, true);
  insert into public.dvir_submissions (route_id, driver_id, is_safe_to_drive)
  values (v_route_b, v_driver_b, true);

  insert into public.route_stop_exceptions (stop_id, exception_type)
  values (v_stop_a, 'eta_delay');
  insert into public.route_stop_exceptions (stop_id, exception_type)
  values (v_stop_b, 'access_issue');

  -- ── 6a/b: field_operator sees only their own dvir_submissions ────────────
  set local role authenticated;
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  select count(*) into v_count from public.dvir_submissions where driver_id = v_driver_a;
  if v_count <> 1 then
    raise exception 'RLS 6a: driver_a should see 1 own DVIR; got %', v_count;
  end if;

  select count(*) into v_count from public.dvir_submissions where driver_id = v_driver_b;
  if v_count <> 0 then
    raise exception 'RLS 6b: driver_a must not see driver_b DVIR rows; got %', v_count;
  end if;

  raise notice 'RLS 6a/b passed: field_operator sees only own dvir_submissions';

  -- ── 6c/d: field_operator sees only exceptions for their own stops ─────────
  select count(*) into v_count from public.route_stop_exceptions where stop_id = v_stop_a;
  if v_count <> 1 then
    raise exception 'RLS 6c: driver_a should see 1 exception for own stop; got %', v_count;
  end if;

  select count(*) into v_count from public.route_stop_exceptions where stop_id = v_stop_b;
  if v_count <> 0 then
    raise exception 'RLS 6d: driver_a must not see exceptions for driver_b stop; got %', v_count;
  end if;

  raise notice 'RLS 6c/d passed: field_operator sees only exceptions for own stops';

  -- ── 6e: branch_manager sees all rows on both tables ──────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          gen_random_uuid()::text,
      'app_metadata', jsonb_build_object('role', 'branch_manager')
    )::text, true);

  select count(*) into v_count
    from public.dvir_submissions
   where driver_id in (v_driver_a, v_driver_b);
  if v_count <> 2 then
    raise exception 'RLS 6e: branch_manager should see 2 DVIRs (one per driver); got %', v_count;
  end if;

  select count(*) into v_count
    from public.route_stop_exceptions
   where stop_id in (v_stop_a, v_stop_b);
  if v_count <> 2 then
    raise exception 'RLS 6e: branch_manager should see 2 exceptions (one per stop); got %', v_count;
  end if;

  raise notice 'RLS 6e passed: branch_manager sees all rows on both tables';

  -- ── 6f/g: authenticated field_operator cannot INSERT directly ────────────
  --          (no INSERT privilege granted; writes go through RPCs only)
  set local role authenticated;
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  v_caught := false;
  begin
    insert into public.dvir_submissions (route_id, driver_id, is_safe_to_drive)
    values (v_route_a, v_driver_a, true);
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'RLS 6f: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'RLS 6f: direct INSERT into dvir_submissions must be denied for authenticated';
  end if;

  v_caught := false;
  begin
    insert into public.route_stop_exceptions (stop_id, exception_type)
    values (v_stop_a, 'eta_delay');
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'RLS 6g: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'RLS 6g: direct INSERT into route_stop_exceptions must be denied for authenticated';
  end if;

  raise notice 'RLS 6f/g passed: direct INSERT denied for authenticated (RPC-only write path enforced)';
end;
$$;

-- ── 7. Branch review bundle projection ─────────────────────────────────────────

reset role;

do $$
declare
  v_driver_a uuid := gen_random_uuid();
  v_driver_b uuid := gen_random_uuid();
  v_manager_id uuid := gen_random_uuid();
  v_admin_id uuid := gen_random_uuid();
  v_route_a  uuid;
  v_route_b  uuid;
  v_stop_a   uuid;
  v_stop_b   uuid;
  v_bundle   jsonb;
  v_hidden_count int;
  v_reverse_hidden_count int;
  v_driver_b_self_count int;
  v_driver_a_self_count int;
  v_manager_count int;
  v_admin_count int;
begin
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_a, current_date, 'in_progress')
  returning id into v_route_a;

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_b, current_date, 'in_progress')
  returning id into v_route_b;

  insert into public.route_stops (
    route_id,
    sequence_order,
    stop_type,
    contract_line_id,
    asset_id,
    customer_name,
    job_site_name,
    address
  )
  values (
    v_route_a,
    1,
    'delivery',
    gen_random_uuid(),
    gen_random_uuid(),
    'Acme Contracting',
    'South Yard',
    '500 Evidence Ave'
  )
  returning id into v_stop_a;

  insert into public.route_stops (
    route_id,
    sequence_order,
    stop_type,
    contract_line_id,
    asset_id,
    customer_name,
    job_site_name,
    address
  )
  values (
    v_route_b,
    1,
    'delivery',
    gen_random_uuid(),
    gen_random_uuid(),
    'Bravo Builders',
    'North Yard',
    '900 Isolation Dr'
  )
  returning id into v_stop_b;

  set local role authenticated;

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  perform public.submit_stop_exception(
    p_stop_id        => v_stop_a,
    p_exception_type => 'damage',
    p_notes          => 'Hydraulic line cracked',
    p_photo_paths    => array['evidence/damage-1.jpg', 'evidence/damage-2.jpg']
  );

  select evidence_bundle
    into v_bundle
  from public.v_route_exception_review_bundle
  where stop_id = v_stop_a
    and exception_type = 'damage';

  if v_bundle is null then
    raise exception 'Expected v_route_exception_review_bundle to return a row for damage exception';
  end if;
  if v_bundle #>> '{exception,notes}' <> 'Hydraulic line cracked' then
    raise exception 'Expected damage notes in evidence bundle; got %', coalesce(v_bundle #>> '{exception,notes}', '<null>');
  end if;
  if coalesce(jsonb_array_length(v_bundle #> '{exception,photo_paths}'), 0) <> 2 then
    raise exception 'Expected two damage photos in evidence bundle';
  end if;
  if (v_bundle #>> '{stop,customer_name}') <> 'Acme Contracting' then
    raise exception 'Expected customer context in evidence bundle; got %', coalesce(v_bundle #>> '{stop,customer_name}', '<null>');
  end if;
  if (v_bundle #>> '{stop,job_site_name}') <> 'South Yard' then
    raise exception 'Expected job-site context in evidence bundle; got %', coalesce(v_bundle #>> '{stop,job_site_name}', '<null>');
  end if;
  if (v_bundle #>> '{route,route_status}') <> 'in_progress' then
    raise exception 'Expected route status context in evidence bundle; got %', coalesce(v_bundle #>> '{route,route_status}', '<null>');
  end if;
  if (v_bundle #>> '{exception,submitted_at}') is null then
    raise exception 'Expected submitted_at timestamp in evidence bundle';
  end if;

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_b::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  select count(*)
    into v_hidden_count
  from public.v_route_exception_review_bundle
  where stop_id = v_stop_a
    and exception_type = 'damage';

  if v_hidden_count <> 0 then
    raise exception 'Expected driver B (field_operator role) to see 0 rows for driver A exception in v_route_exception_review_bundle; got %', v_hidden_count;
  end if;

  perform public.submit_stop_exception(
    p_stop_id        => v_stop_b,
    p_exception_type => 'damage',
    p_notes          => 'Panel bent',
    p_photo_paths    => array['evidence/damage-b-1.jpg']
  );

  select count(*)
    into v_driver_b_self_count
  from public.v_route_exception_review_bundle
  where stop_id = v_stop_b
    and exception_type = 'damage';

  if v_driver_b_self_count <> 1 then
    raise exception 'Expected driver B (field_operator role) to see their own exception row in v_route_exception_review_bundle; got %', v_driver_b_self_count;
  end if;

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  select count(*)
    into v_reverse_hidden_count
  from public.v_route_exception_review_bundle
  where stop_id = v_stop_b
    and exception_type = 'damage';

  if v_reverse_hidden_count <> 0 then
    raise exception 'Expected driver A (field_operator role) to see 0 rows for driver B''s exception in v_route_exception_review_bundle; got %', v_reverse_hidden_count;
  end if;

  select count(*)
    into v_driver_a_self_count
  from public.v_route_exception_review_bundle
  where stop_id = v_stop_a
    and exception_type = 'damage';

  if v_driver_a_self_count <> 1 then
    raise exception 'Expected driver A (field_operator role) to still see their own exception row in v_route_exception_review_bundle; got %', v_driver_a_self_count;
  end if;

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_manager_id::text,
      'app_metadata', jsonb_build_object('role', 'branch_manager')
    )::text, true);

  select count(*)
    into v_manager_count
  from public.v_route_exception_review_bundle
  where stop_id = v_stop_a
    and exception_type = 'damage';

  if v_manager_count <> 1 then
    raise exception 'Expected branch_manager to see driver damage exception review bundle; got % rows', v_manager_count;
  end if;

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_admin_id::text,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text, true);

  select count(*)
    into v_admin_count
  from public.v_route_exception_review_bundle
  where stop_id = v_stop_a
    and exception_type = 'damage';

  if v_admin_count <> 1 then
    raise exception 'Expected admin to see driver damage exception review bundle; got % rows', v_admin_count;
  end if;

  raise notice 'Test 7 passed: branch review bundle enforces driver scoping and preserves manager/admin visibility';
end;
$$;

-- ── 8. RPC existence checks ───────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'submit_dvir'
  ) then
    raise exception 'Expected public.submit_dvir function to exist';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'submit_stop_exception'
  ) then
    raise exception 'Expected public.submit_stop_exception function to exist';
  end if;

  raise notice 'RPC existence checks passed: submit_dvir and submit_stop_exception exist';
end;
$$;

rollback;
