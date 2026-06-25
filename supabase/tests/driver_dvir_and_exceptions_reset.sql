begin;

-- Reset-path validation for field driver DVIR + route stop exceptions
-- (migration 20260615180000_field_driver_dvir_and_exceptions.sql).
-- Ensures full `supabase db reset` provisions the tables/RLS/RPCs and that
-- submit_dvir + submit_stop_exception persist records and project route-stop
-- context as expected.

do $$
declare
  v_dvir_rls bool;
  v_exc_rls  bool;
begin
  select c.relrowsecurity
    into v_dvir_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'dvir_submissions';

  if not found or not coalesce(v_dvir_rls, false) then
    raise exception 'Expected RLS enabled on public.dvir_submissions after reset';
  end if;

  select c.relrowsecurity
    into v_exc_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'route_stop_exceptions';

  if not found or not coalesce(v_exc_rls, false) then
    raise exception 'Expected RLS enabled on public.route_stop_exceptions after reset';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'submit_dvir'
  ) then
    raise exception 'submit_dvir RPC not found after reset';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'submit_stop_exception'
  ) then
    raise exception 'submit_stop_exception RPC not found after reset';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'v_driver_dispatch_stops'
      and column_name = 'dvir_submitted'
  ) then
    raise exception 'v_driver_dispatch_stops missing dvir_submitted after reset';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'v_driver_dispatch_stops'
      and column_name = 'exception_count'
  ) then
    raise exception 'v_driver_dispatch_stops missing exception_count after reset';
  end if;
end;
$$;

set local role authenticated;

do $$
declare
  v_driver_id uuid := gen_random_uuid();
  v_route_id  uuid;
  v_stop_id   uuid;
  v_dvir_id   uuid;
  v_exc_id    uuid;
  v_requires_review bool;
  v_is_safe        bool;
  v_signature      text;
  v_delay          int;
  v_exception_type text;
  v_notes          text;
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_driver_id::text,
      'app_metadata', json_build_object('role', 'admin')
    )::text,
    true
  );

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id,
    sequence_order,
    stop_type,
    status,
    address,
    customer_name,
    job_site_name
  ) values (
    v_route_id,
    0,
    'delivery',
    'pending',
    '100 Reset Validation Way',
    'Reset Customer',
    'Reset Site'
  )
  returning id into v_stop_id;

  v_dvir_id := public.submit_dvir(
    p_route_id => v_route_id,
    p_truck_id => 'RESET-TRK-1',
    p_is_safe_to_drive => false,
    p_signature => 'Reset Driver'
  );

  v_exc_id := public.submit_stop_exception(
    p_stop_id => v_stop_id,
    p_exception_type => 'eta_delay',
    p_notes => 'Reset-path ETA validation',
    p_estimated_delay_minutes => 30
  );

  if v_dvir_id is null then
    raise exception 'submit_dvir returned null id during reset validation';
  end if;

  if v_exc_id is null then
    raise exception 'submit_stop_exception returned null id during reset validation';
  end if;

  select d.requires_review, d.is_safe_to_drive, d.signature
    into v_requires_review, v_is_safe, v_signature
  from public.dvir_submissions d
  where d.id = v_dvir_id;

  if not found then
    raise exception 'Reset-path: expected DVIR submission row for id %', v_dvir_id;
  end if;
  if coalesce(v_is_safe, true) then
    raise exception 'Reset-path: expected unsafe DVIR row';
  end if;
  if not coalesce(v_requires_review, false) then
    raise exception 'Reset-path: unsafe DVIR must set requires_review=true';
  end if;
  if coalesce(v_signature, '') <> 'Reset Driver' then
    raise exception 'Reset-path: DVIR signature mismatch';
  end if;

  select e.exception_type, e.estimated_delay_minutes, e.notes
    into v_exception_type, v_delay, v_notes
  from public.route_stop_exceptions e
  where e.id = v_exc_id;

  if not found then
    raise exception 'Reset-path: expected route_stop_exceptions row for id %', v_exc_id;
  end if;
  if v_exception_type <> 'eta_delay' then
    raise exception 'Reset-path: exception_type mismatch (%).', v_exception_type;
  end if;
  if coalesce(v_delay, 0) <> 30 then
    raise exception 'Reset-path: estimated_delay_minutes mismatch (%).', v_delay;
  end if;
  if coalesce(v_notes, '') <> 'Reset-path ETA validation' then
    raise exception 'Reset-path: exception notes mismatch';
  end if;

  if not exists (
    select 1
    from public.v_driver_dispatch_stops s
    where s.stop_id = v_stop_id
      and coalesce(s.dvir_submitted, false) = true
      and coalesce(s.exception_count, 0) >= 1
  ) then
    raise exception 'Reset-path: v_driver_dispatch_stops did not expose DVIR/exception projection for stop %', v_stop_id;
  end if;
end;
$$;

reset role;

rollback;
