begin;

-- Reset-path validation for stop_pod_bundles (20260616120000_stop_pod_bundles.sql).
-- Confirms the table/indexes/RPCs exist after supabase db reset and that the full
-- update_route_stop_state completion path writes a POD bundle as expected against the
-- live Supabase schema (which includes demo seed data).

do $$
declare
  v_has_rls        bool;
  v_get_pod_exists bool;
  v_upd_exists     bool;
begin
  select c.relrowsecurity
    into v_has_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'stop_pod_bundles';

  if not found or not coalesce(v_has_rls, false) then
    raise exception 'Expected RLS enabled on public.stop_pod_bundles after reset';
  end if;

  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_stop_pod'
  ) into v_get_pod_exists;

  if not v_get_pod_exists then
    raise exception 'get_stop_pod RPC not found after reset';
  end if;

  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_route_stop_state'
  ) into v_upd_exists;

  if not v_upd_exists then
    raise exception 'update_route_stop_state RPC not found after reset';
  end if;

  raise notice 'Reset-path object checks passed: table/RLS/RPCs exist';
end;
$$;

set local role service_role;

do $$
declare
  v_driver_id    uuid := gen_random_uuid();
  v_route_id     uuid;
  v_stop_id      uuid;
  v_bundle       record;
  v_result       json;
begin
  -- Seed a minimal route + stop fixture on top of the demo baseline.
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name
  ) values (
    v_route_id, 0, 'delivery', 'pending',
    '100 Pod Reset Way, Austin TX 78701', 'Reset Contractor', 'Reset Site'
  ) returning id into v_stop_id;

  -- Use admin claims so the RPC role gate passes.
  perform set_config('request.jwt.claims',
    '{"app_metadata":{"role":"admin"}}', true);

  -- Advance through the full state machine.
  perform public.update_route_stop_state(v_stop_id, 'departed');
  perform public.update_route_stop_state(v_stop_id, 'arrived');
  perform public.update_route_stop_state(
    v_stop_id,
    'completed',
    'Reset Driver',
    'Delivered via reset-path POD validation',
    array['pod/reset/photo1.jpg']
  );

  -- Verify the bundle was created with correct fields.
  select * into v_bundle
  from public.stop_pod_bundles
  where stop_id = v_stop_id;

  if not found then
    raise exception 'Reset-path: no POD bundle created after stop completion';
  end if;

  if v_bundle.evidence_status <> 'complete' then
    raise exception 'Reset-path: expected evidence_status=complete, got %', v_bundle.evidence_status;
  end if;

  if v_bundle.driver_id <> v_driver_id then
    raise exception 'Reset-path: bundle driver_id mismatch';
  end if;

  if array_length(v_bundle.photo_paths, 1) <> 1 then
    raise exception 'Reset-path: expected 1 photo_path, got %', array_length(v_bundle.photo_paths, 1);
  end if;

  -- Verify get_stop_pod returns evidence fields and excludes driver identity.
  v_result := public.get_stop_pod(v_stop_id);

  if v_result is null then
    raise exception 'Reset-path: get_stop_pod returned null';
  end if;

  if (v_result::jsonb ->> 'driver_id') is not null then
    raise exception 'Reset-path: driver_id must not appear in get_stop_pod output';
  end if;

  if (v_result::jsonb ->> 'evidence_status') <> 'complete' then
    raise exception 'Reset-path: evidence_status not in get_stop_pod output';
  end if;

  raise notice 'Reset-path fixture checks passed for stop_pod_bundles + get_stop_pod';
end;
$$;

reset role;

rollback;
