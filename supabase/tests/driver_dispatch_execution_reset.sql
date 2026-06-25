begin;

-- Validate full reset-path shape for driver dispatch execution.
-- Confirms seeded demo baseline data exists alongside dispatch objects, then
-- seeds a deterministic route + ordered stops fixture and validates the
-- view/RPC workflow shape used by /field/dispatch.

do $$
declare
  v_demo_entities int;
  v_has_rls_routes bool;
  v_has_rls_stops bool;
  v_view_exists bool;
  v_rpc_exists bool;
begin
  select count(*) into v_demo_entities
  from entities
  where source_record_id like 'demo-baseline-%';

  if v_demo_entities < 100 then
    raise exception
      'Expected demo baseline entities to exist after reset; found %',
      v_demo_entities;
  end if;

  select c.relrowsecurity
    into v_has_rls_routes
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'dispatch_routes';

  if not found or not coalesce(v_has_rls_routes, false) then
    raise exception 'Expected RLS enabled on public.dispatch_routes after reset';
  end if;

  select c.relrowsecurity
    into v_has_rls_stops
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'route_stops';

  if not found or not coalesce(v_has_rls_stops, false) then
    raise exception 'Expected RLS enabled on public.route_stops after reset';
  end if;

  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and c.relname = 'v_driver_dispatch_stops'
  ) into v_view_exists;

  if not v_view_exists then
    raise exception 'Expected public.v_driver_dispatch_stops view after reset';
  end if;

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'update_route_stop_state'
  ) into v_rpc_exists;

  if not v_rpc_exists then
    raise exception 'Expected public.update_route_stop_state RPC after reset';
  end if;

  raise notice 'Reset-path object checks passed';
end;
$$;

set local role service_role;

do $$
declare
  v_driver_id uuid := gen_random_uuid();
  v_route_id uuid;
  v_stop_a uuid;
  v_sequence_orders int[];
  v_stop_statuses text[];
  v_stop_types text[];
  v_route_status text;
  v_signature text;
  v_condition_notes text;
  v_photo_count int;
begin
  insert into public.dispatch_routes (driver_id, route_date, status, notes)
  values (v_driver_id, current_date, 'pending', 'reset-path demo route')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name, notes
  ) values (
    v_route_id, 0, 'delivery', 'pending',
    '100 Demo Way, Austin TX 78701', 'Demo Contractor', 'Demo Site North',
    'First stop from reset fixture'
  )
  returning id into v_stop_a;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name, notes
  ) values (
    v_route_id, 1, 'pickup', 'pending',
    '200 Demo Way, Austin TX 78702', 'Demo Contractor', 'Demo Site South',
    'Second stop from reset fixture'
  );

  select array_agg(sequence_order order by sequence_order),
         array_agg(stop_status order by sequence_order),
         array_agg(stop_type order by sequence_order)
    into v_sequence_orders, v_stop_statuses, v_stop_types
  from public.v_driver_dispatch_stops
  where route_id = v_route_id;

  if v_sequence_orders is null
     or array_length(v_sequence_orders, 1) <> 2
     or v_sequence_orders <> array[0, 1]
  then
    raise exception
      'Expected ordered dispatch stops [0,1], got %',
      coalesce(v_sequence_orders::text, 'NULL');
  end if;

  if v_stop_statuses <> array['pending', 'pending'] then
    raise exception 'Expected pending stop statuses from reset fixture, got %', v_stop_statuses;
  end if;

  if v_stop_types <> array['delivery', 'pickup'] then
    raise exception 'Expected stop types [delivery,pickup], got %', v_stop_types;
  end if;

  perform set_config('request.jwt.claims',
    '{"app_metadata":{"role":"admin"}}', true);

  perform public.update_route_stop_state(v_stop_a, 'departed');
  perform public.update_route_stop_state(v_stop_a, 'arrived');
  perform public.update_route_stop_state(
    v_stop_a,
    'completed',
    'Dispatch Driver',
    'Delivered via reset-path validation',
    array['dispatch/reset/stop-a-photo-1.jpg']
  );

  select status into v_route_status
  from public.dispatch_routes
  where id = v_route_id;

  if v_route_status <> 'in_progress' then
    raise exception 'Expected route to be in_progress after first stop completion, got %', v_route_status;
  end if;

  select signature, condition_notes, array_length(photo_paths, 1)
    into v_signature, v_condition_notes, v_photo_count
  from public.route_stops
  where id = v_stop_a;

  if v_signature <> 'Dispatch Driver' then
    raise exception 'Expected signature persisted via RPC, got %', v_signature;
  end if;

  if v_condition_notes <> 'Delivered via reset-path validation' then
    raise exception 'Expected condition_notes persisted via RPC, got %', v_condition_notes;
  end if;

  if coalesce(v_photo_count, 0) <> 1 then
    raise exception 'Expected exactly one photo path after completion, got %', coalesce(v_photo_count, 0);
  end if;

  raise notice 'Reset-path fixture checks passed for /field/dispatch shape';
end;
$$;

reset role;

rollback;
