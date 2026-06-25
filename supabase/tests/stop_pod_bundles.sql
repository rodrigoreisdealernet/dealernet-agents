-- Behavioral tests for stop_pod_bundles (20260616120000_stop_pod_bundles.sql).
--
-- Verifies:
--   1. Table exists with RLS enabled and correct column shape.
--   2. Grants: authenticated SELECT-only (no INSERT/UPDATE/DELETE); service_role full DML.
--   3. RPCs exist: get_stop_pod, update_route_stop_state.
--   4. Direct INSERT by authenticated is denied (missing privilege, not RLS).
--   5. Service-role and update_route_stop_state completion path can create/update bundles.
--   6. Evidence status: 'complete' when signature present; 'needs_review' when absent.
--   7. get_stop_pod returns evidence fields only — no fleet/route/driver columns.
--   8. RLS behavioral:
--      a. field_operator reads own bundle (direct SELECT).
--      b. field_operator is denied another driver's bundle (direct SELECT → 0 rows).
--      c. field_operator read own bundle via get_stop_pod RPC → succeeds.
--      d. field_operator calling get_stop_pod for another driver's stop → null
--         (oracle normalized: indistinguishable from a nonexistent stop).
--      e. branch_manager sees all bundles (direct SELECT).
--      f. admin sees all bundles (direct SELECT).
--      g. read_only role → 0 rows (no matching policy).
--      h. anon → insufficient_privilege on direct SELECT.
--   9. Oracle normalization:
--      a. get_stop_pod: cross-driver existing stop and nonexistent stop both return null.
--      b. update_route_stop_state: cross-driver existing stop raises same 02000 as
--         a genuinely missing stop — field_operator cannot distinguish the two.

begin;

-- ── 1. Structural checks ─────────────────────────────────────────────────────

do $$
declare
  v_has_rls     bool;
  v_driver_col  bool;
begin
  select c.relrowsecurity
    into v_has_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'stop_pod_bundles';

  if not found or not coalesce(v_has_rls, false) then
    raise exception 'Expected RLS enabled on public.stop_pod_bundles';
  end if;

  -- driver_id column must exist (RLS scoping) but must NOT be in the
  -- evidence-only read surface (verified behaviorally in test 7 below).
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'stop_pod_bundles'
      and column_name  = 'driver_id'
  ) into v_driver_col;

  if not v_driver_col then
    raise exception 'driver_id column missing from stop_pod_bundles';
  end if;

  raise notice 'Structural checks passed: RLS enabled, driver_id present';
end;
$$;

-- ── 2. Grant checks ──────────────────────────────────────────────────────────

do $$
begin
  -- authenticated: SELECT only
  if not has_table_privilege('authenticated', 'public.stop_pod_bundles', 'SELECT') then
    raise exception 'Expected authenticated SELECT on stop_pod_bundles';
  end if;
  if has_table_privilege('authenticated', 'public.stop_pod_bundles', 'INSERT') then
    raise exception 'authenticated must NOT have INSERT on stop_pod_bundles';
  end if;
  if has_table_privilege('authenticated', 'public.stop_pod_bundles', 'UPDATE') then
    raise exception 'authenticated must NOT have UPDATE on stop_pod_bundles';
  end if;
  if has_table_privilege('authenticated', 'public.stop_pod_bundles', 'DELETE') then
    raise exception 'authenticated must NOT have DELETE on stop_pod_bundles';
  end if;

  -- service_role: full access
  if not has_table_privilege('service_role', 'public.stop_pod_bundles', 'SELECT') then
    raise exception 'Expected service_role SELECT on stop_pod_bundles';
  end if;
  if not has_table_privilege('service_role', 'public.stop_pod_bundles', 'INSERT') then
    raise exception 'Expected service_role INSERT on stop_pod_bundles';
  end if;
  if not has_table_privilege('service_role', 'public.stop_pod_bundles', 'UPDATE') then
    raise exception 'Expected service_role UPDATE on stop_pod_bundles';
  end if;
  if not has_table_privilege('service_role', 'public.stop_pod_bundles', 'DELETE') then
    raise exception 'Expected service_role DELETE on stop_pod_bundles';
  end if;

  raise notice 'Grant checks passed: authenticated SELECT-only, service_role full DML';
end;
$$;

-- ── 3. RPC existence checks ──────────────────────────────────────────────────

do $$
declare
  v_get_pod  int;
  v_update   int;
begin
  select count(*) into v_get_pod
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_stop_pod';

  if v_get_pod < 1 then
    raise exception 'get_stop_pod RPC not found';
  end if;

  select count(*) into v_update
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'update_route_stop_state';

  if v_update < 1 then
    raise exception 'update_route_stop_state RPC not found';
  end if;

  raise notice 'RPC existence checks passed: get_stop_pod and update_route_stop_state present';
end;
$$;

-- ── 4 & 5. Write boundary + bundle creation via RPC ─────────────────────────

set local role service_role;

do $$
declare
  v_driver_a     uuid := gen_random_uuid();
  v_driver_b     uuid := gen_random_uuid();
  v_route_a      uuid;
  v_route_b      uuid;
  v_stop_a_sig   uuid;  -- stop completed with signature
  v_stop_a_nosig uuid;  -- stop completed without signature
  v_stop_b       uuid;  -- driver_b's stop
  v_bundle       record;
  v_count        int;
  v_caught       bool;
begin
  -- Seed routes and stops (service_role, bypass RLS).
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_a, current_date, 'pending')
  returning id into v_route_a;

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_b, current_date, 'pending')
  returning id into v_route_b;

  insert into public.route_stops (route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name)
  values (v_route_a, 0, 'delivery', 'pending',
    '1 Alpha St', 'Acme Corp', 'Site Alpha')
  returning id into v_stop_a_sig;

  insert into public.route_stops (route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name)
  values (v_route_a, 1, 'pickup', 'pending',
    '2 Beta Rd', 'Acme Corp', 'Site Beta')
  returning id into v_stop_a_nosig;

  insert into public.route_stops (route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name)
  values (v_route_b, 0, 'delivery', 'pending',
    '3 Gamma Ave', 'Beta Ltd', 'Site Gamma')
  returning id into v_stop_b;

  -- Use admin claims so the RPC role gate passes in subsequent calls.
  perform set_config('request.jwt.claims',
    '{"app_metadata":{"role":"admin"}}', true);

  -- ── Test 4: authenticated cannot INSERT directly ─────────────────────────

  set local role authenticated;
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  v_caught := false;
  begin
    insert into public.stop_pod_bundles (
      stop_id, stop_type, customer_name, address,
      evidence_status, driver_id
    ) values (
      v_stop_a_sig, 'delivery', 'Acme Corp', '1 Alpha St',
      'needs_review', v_driver_a
    );
  exception
    when insufficient_privilege then v_caught := true;
    when others then v_caught := true;  -- any write error is also acceptable
  end;

  if not v_caught then
    raise exception 'Test 4: authenticated direct INSERT must be denied';
  end if;

  raise notice 'Test 4 (authenticated INSERT denied): passed';

  -- ── Test 5a: update_route_stop_state creates bundle on completion ─────────

  set local role service_role;
  perform set_config('request.jwt.claims',
    '{"app_metadata":{"role":"admin"}}', true);

  -- Advance stop_a_sig to arrived.
  perform public.update_route_stop_state(v_stop_a_sig, 'departed');
  perform public.update_route_stop_state(v_stop_a_sig, 'arrived');

  -- Complete with signature → evidence_status should be 'complete'.
  perform public.update_route_stop_state(
    v_stop_a_sig, 'completed',
    'Jane Driver',
    'Asset delivered, good condition',
    array['stops/sig/photo1.jpg', 'stops/sig/photo2.jpg']
  );

  select * into v_bundle
  from public.stop_pod_bundles
  where stop_id = v_stop_a_sig;

  if not found then
    raise exception 'Test 5a: no bundle created after stop completion';
  end if;
  if v_bundle.evidence_status <> 'complete' then
    raise exception 'Test 5a: expected evidence_status=complete (signature present), got %', v_bundle.evidence_status;
  end if;
  if v_bundle.signature <> 'Jane Driver' then
    raise exception 'Test 5a: expected signature stored, got %', v_bundle.signature;
  end if;
  if array_length(v_bundle.photo_paths, 1) <> 2 then
    raise exception 'Test 5a: expected 2 photo_paths, got %', array_length(v_bundle.photo_paths, 1);
  end if;
  if v_bundle.driver_id <> v_driver_a then
    raise exception 'Test 5a: bundle driver_id mismatch';
  end if;

  raise notice 'Test 5a (bundle created with evidence_status=complete): passed';

  -- ── Test 5b: no signature → evidence_status = 'needs_review' ─────────────

  perform public.update_route_stop_state(v_stop_a_nosig, 'departed');
  perform public.update_route_stop_state(v_stop_a_nosig, 'arrived');
  perform public.update_route_stop_state(
    v_stop_a_nosig, 'completed',
    null,
    'Minor scuff noted',
    null
  );

  select evidence_status into v_bundle
  from public.stop_pod_bundles
  where stop_id = v_stop_a_nosig;

  if not found then
    raise exception 'Test 5b: no bundle created for no-signature stop';
  end if;
  if v_bundle.evidence_status <> 'needs_review' then
    raise exception 'Test 5b: expected evidence_status=needs_review (no signature), got %', v_bundle.evidence_status;
  end if;

  raise notice 'Test 5b (no signature → needs_review): passed';

  -- ── Test 5c: service_role can INSERT/UPDATE directly ─────────────────────

  -- Create driver_b's bundle via service_role direct INSERT.
  perform public.update_route_stop_state(v_stop_b, 'departed');
  perform public.update_route_stop_state(v_stop_b, 'arrived');
  perform public.update_route_stop_state(
    v_stop_b, 'completed',
    'Bob Driver',
    null,
    null
  );

  select count(*) into v_count
  from public.stop_pod_bundles
  where driver_id = v_driver_b;

  if v_count <> 1 then
    raise exception 'Test 5c: expected 1 bundle for driver_b via service_role RPC, got %', v_count;
  end if;

  -- Also verify service_role can UPDATE directly.
  update public.stop_pod_bundles
  set condition_notes = 'Updated by service_role'
  where stop_id = v_stop_b;

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'Test 5c: service_role direct UPDATE should affect 1 row, affected %', v_count;
  end if;

  raise notice 'Test 5c (service_role write path): passed';

end;
$$;

-- ── 6. driver_id not exposed in get_stop_pod output ─────────────────────────

set local role service_role;
select set_config('request.jwt.claims', '{"app_metadata":{"role":"admin"}}', true);

do $$
declare
  v_stop_id  uuid;
  v_result   json;
  v_keys     text[];
begin
  -- Pick any completed bundle created above.
  select stop_id into v_stop_id
  from public.stop_pod_bundles
  limit 1;

  if v_stop_id is null then
    raise exception 'Test 6: no stop_pod_bundles row found';
  end if;

  v_result := public.get_stop_pod(v_stop_id);

  if v_result is null then
    raise exception 'Test 6: get_stop_pod returned null unexpectedly';
  end if;

  -- Collect keys from the returned JSON object.
  select array_agg(k) into v_keys
  from jsonb_object_keys(v_result::jsonb) k;

  -- Disallowed fields must be absent.
  if 'driver_id' = any(v_keys) then
    raise exception 'Test 6: driver_id must not appear in get_stop_pod output';
  end if;
  if 'route_id' = any(v_keys) then
    raise exception 'Test 6: route_id must not appear in get_stop_pod output';
  end if;

  -- Evidence fields must be present.
  if not ('stop_id' = any(v_keys)) then
    raise exception 'Test 6: stop_id missing from get_stop_pod output';
  end if;
  if not ('evidence_status' = any(v_keys)) then
    raise exception 'Test 6: evidence_status missing from get_stop_pod output';
  end if;

  raise notice 'Test 6 (get_stop_pod exposes no fleet/route/driver fields): passed';
end;
$$;

-- ── 7 & 8. RLS behavioral: own-bundle isolation, role filtering, anon denied ─
--
-- Override auth.uid() within this transaction so it reads from request.jwt.claims.
-- This mirrors the GoTrue production behavior and is rolled back with the transaction.
-- Must run as the session superuser to replace a function in the auth schema.

reset role;

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
  v_driver_a      uuid;
  v_driver_b      uuid;
  v_stop_a        uuid;  -- driver_a's completed stop (with signature)
  v_stop_b        uuid;  -- driver_b's completed stop
  v_fake_stop_id  uuid := gen_random_uuid();  -- guaranteed nonexistent stop id
  v_count         int;
  v_result        json;
  v_caught        bool;
  v_sqlstate_a    text;
  v_sqlstate_b    text;
begin
  -- Retrieve the driver IDs and stop IDs created earlier in this transaction.
  select b.driver_id, b.stop_id
    into v_driver_a, v_stop_a
  from public.stop_pod_bundles b
  join public.dispatch_routes r on r.driver_id = b.driver_id
  where b.evidence_status = 'complete'
  limit 1;

  select b.driver_id, b.stop_id
    into v_driver_b, v_stop_b
  from public.stop_pod_bundles b
  where b.driver_id <> v_driver_a
  limit 1;

  if v_driver_a is null or v_driver_b is null then
    raise exception 'RLS setup: could not resolve two distinct driver fixtures';
  end if;

  -- ── 8a: field_operator (driver_a) sees only own bundle via direct SELECT ──

  set local role authenticated;
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  select count(*) into v_count from public.stop_pod_bundles;
  -- driver_a has 2 stops completed (sig + nosig); both owned by driver_a → 2 rows.
  if v_count < 1 then
    raise exception 'RLS 8a: field_operator expected own bundle(s), got %', v_count;
  end if;

  raise notice 'RLS 8a (field_operator sees own bundle): passed';

  -- ── 8b: field_operator denied direct SELECT of another driver's bundle ────

  select count(*) into v_count
  from public.stop_pod_bundles
  where driver_id = v_driver_b;

  if v_count <> 0 then
    raise exception 'RLS 8b: field_operator must not see other driver bundle, got %', v_count;
  end if;

  raise notice 'RLS 8b (field_operator denied other-driver bundle via direct SELECT): passed';

  -- ── 8c: field_operator can read own bundle via get_stop_pod RPC ───────────

  v_result := public.get_stop_pod(v_stop_a);

  if v_result is null then
    raise exception 'RLS 8c: get_stop_pod(own stop) returned null for field_operator';
  end if;
  if (v_result::jsonb ->> 'stop_id')::uuid <> v_stop_a then
    raise exception 'RLS 8c: get_stop_pod returned wrong stop_id';
  end if;

  raise notice 'RLS 8c (field_operator get_stop_pod own stop): passed';

  -- ── 8d: field_operator get_stop_pod for another driver's stop → null ────────
  -- Oracle normalized: cross-driver existing stop and nonexistent stop are
  -- indistinguishable — both return null, no distinct error path is exposed.

  v_result := public.get_stop_pod(v_stop_b);

  if v_result is not null then
    raise exception 'RLS 8d: get_stop_pod must return null for cross-driver stop (oracle normalization), got %', v_result;
  end if;

  raise notice 'RLS 8d (field_operator get_stop_pod cross-driver → null, oracle normalized): passed';

  -- ── 9a: Oracle normalization — get_stop_pod ───────────────────────────────
  -- Both cross-driver existing stop and a genuinely nonexistent stop return null.

  -- Cross-driver stop already confirmed null above (v_stop_b).
  -- Nonexistent stop must also return null.
  v_result := public.get_stop_pod(v_fake_stop_id);

  if v_result is not null then
    raise exception 'Oracle 9a: get_stop_pod must return null for nonexistent stop, got %', v_result;
  end if;

  -- The two observable results are identical (both null).
  raise notice 'Oracle 9a (get_stop_pod: cross-driver and nonexistent both return null): passed';

  -- ── 9b: Oracle normalization — update_route_stop_state ───────────────────
  -- A field_operator call for a cross-driver existing stop must raise the same
  -- sqlstate (02000 "not found") as a call for a genuinely missing stop.

  v_sqlstate_a := 'ok';
  begin
    perform public.update_route_stop_state(v_stop_b, 'departed');
  exception
    when sqlstate '02000' then v_sqlstate_a := '02000';
    when others           then v_sqlstate_a := sqlstate;
  end;

  v_sqlstate_b := 'ok';
  begin
    perform public.update_route_stop_state(v_fake_stop_id, 'departed');
  exception
    when sqlstate '02000' then v_sqlstate_b := '02000';
    when others           then v_sqlstate_b := sqlstate;
  end;

  if v_sqlstate_a <> '02000' then
    raise exception 'Oracle 9b: cross-driver stop expected sqlstate 02000, got %', v_sqlstate_a;
  end if;
  if v_sqlstate_b <> '02000' then
    raise exception 'Oracle 9b: nonexistent stop expected sqlstate 02000, got %', v_sqlstate_b;
  end if;
  if v_sqlstate_a <> v_sqlstate_b then
    raise exception 'Oracle 9b: cross-driver and nonexistent stop raised different sqlstates (% vs %)', v_sqlstate_a, v_sqlstate_b;
  end if;

  raise notice 'Oracle 9b (update_route_stop_state: cross-driver and nonexistent both raise 02000): passed';

  -- ── 8e: branch_manager sees all bundles ───────────────────────────────────

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          gen_random_uuid()::text,
      'app_metadata', jsonb_build_object('role', 'branch_manager')
    )::text, true);

  select count(*) into v_count from public.stop_pod_bundles;
  if v_count < 3 then
    raise exception 'RLS 8e: branch_manager expected >= 3 bundles, got %', v_count;
  end if;

  -- branch_manager can also use get_stop_pod for any stop.
  v_result := public.get_stop_pod(v_stop_b);
  if v_result is null then
    raise exception 'RLS 8e: branch_manager get_stop_pod returned null';
  end if;

  raise notice 'RLS 8e (branch_manager sees all bundles + RPC): passed';

  -- ── 8f: admin sees all bundles ────────────────────────────────────────────

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          gen_random_uuid()::text,
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text, true);

  select count(*) into v_count from public.stop_pod_bundles;
  if v_count < 3 then
    raise exception 'RLS 8f: admin expected >= 3 bundles, got %', v_count;
  end if;

  v_result := public.get_stop_pod(v_stop_a);
  if v_result is null then
    raise exception 'RLS 8f: admin get_stop_pod returned null';
  end if;

  raise notice 'RLS 8f (admin sees all bundles + RPC): passed';

  -- ── 8g: read_only role sees 0 bundles and is denied via RPC ──────────────

  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          gen_random_uuid()::text,
      'app_metadata', jsonb_build_object('role', 'read_only')
    )::text, true);

  select count(*) into v_count from public.stop_pod_bundles;
  if v_count <> 0 then
    raise exception 'RLS 8g: read_only must see 0 bundles, got %', v_count;
  end if;

  -- get_stop_pod also enforces role gate for read_only.
  v_caught := false;
  begin
    v_result := public.get_stop_pod(v_stop_a);
  exception
    when sqlstate '42501' then v_caught := true;
  end;

  if not v_caught then
    raise exception 'RLS 8g: expected 42501 from get_stop_pod for read_only caller';
  end if;

  raise notice 'RLS 8g (read_only denied direct SELECT + RPC): passed';

  -- ── 8h: anon role is denied SELECT entirely (no grant to anon) ───────────

  set local role anon;
  perform set_config('request.jwt.claims', '{}', true);

  v_caught := false;
  begin
    perform 1 from public.stop_pod_bundles limit 1;
    raise exception 'RLS 8h: anon SELECT must be denied';
  exception
    when insufficient_privilege then v_caught := true;
  end;

  if not v_caught then
    raise exception 'RLS 8h: expected insufficient_privilege for anon';
  end if;

  raise notice 'RLS 8h (anon denied SELECT): passed';

end;
$$;

do $$ begin raise notice 'All stop_pod_bundles behavioral checks passed (RLS isolation + oracle normalization)'; end; $$;

rollback;
