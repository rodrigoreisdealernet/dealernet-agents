-- Behavioral tests for driver run-sheet contact fields
-- (migration 20260619153000_driver_runsheet_contact_fields.sql).
--
-- Verifies:
--   1. contact_name and contact_phone columns exist on route_stops.
--   2. v_driver_dispatch_stops exposes contact_name and contact_phone in the
--      correct positions (after exception_count — existing columns unchanged).
--   3. Contact values flow through the view correctly; null when not set.
--   4. anon is denied SELECT on v_driver_dispatch_stops.
--   5. authenticated field_operator can read the view via security_invoker
--      + RLS and sees the contact columns for their own route.
--   6. authenticated field_operator cannot read stops for another driver's route.

begin;

-- ── 1. Schema: contact columns exist on route_stops ──────────────────────────

do $$
declare
  v_name_type  text;
  v_phone_type text;
begin
  select data_type into v_name_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'route_stops'
    and column_name  = 'contact_name';

  if not found then
    raise exception 'Expected contact_name column on public.route_stops';
  end if;
  if v_name_type <> 'text' then
    raise exception 'Expected contact_name to be text; got %', v_name_type;
  end if;

  select data_type into v_phone_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'route_stops'
    and column_name  = 'contact_phone';

  if not found then
    raise exception 'Expected contact_phone column on public.route_stops';
  end if;
  if v_phone_type <> 'text' then
    raise exception 'Expected contact_phone to be text; got %', v_phone_type;
  end if;

  raise notice 'Test 1 passed: contact_name and contact_phone exist on route_stops';
end;
$$;

-- ── 2. View column order: existing columns are unchanged; new ones at end ──────
--
-- PostgreSQL assigns ordinal_position in SELECT order.  We verify that the
-- columns introduced in 20260615180000 (exception_count) still precede the
-- new contact columns, and that notes/signature/etc. retain their positions
-- relative to each other.

do $$
declare
  v_pos_notes        int;
  v_pos_exception    int;
  v_pos_contact_name int;
  v_pos_contact_phone int;
begin
  select ordinal_position into v_pos_notes
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'v_driver_dispatch_stops'
    and column_name  = 'notes';

  select ordinal_position into v_pos_exception
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'v_driver_dispatch_stops'
    and column_name  = 'exception_count';

  select ordinal_position into v_pos_contact_name
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'v_driver_dispatch_stops'
    and column_name  = 'contact_name';

  select ordinal_position into v_pos_contact_phone
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'v_driver_dispatch_stops'
    and column_name  = 'contact_phone';

  if v_pos_notes is null then
    raise exception 'notes column missing from v_driver_dispatch_stops';
  end if;
  if v_pos_exception is null then
    raise exception 'exception_count column missing from v_driver_dispatch_stops';
  end if;
  if v_pos_contact_name is null then
    raise exception 'contact_name column missing from v_driver_dispatch_stops';
  end if;
  if v_pos_contact_phone is null then
    raise exception 'contact_phone column missing from v_driver_dispatch_stops';
  end if;

  -- notes must appear before exception_count (pre-existing relative order).
  if v_pos_notes >= v_pos_exception then
    raise exception 'Column order regression: notes (pos %) must precede exception_count (pos %)',
      v_pos_notes, v_pos_exception;
  end if;

  -- contact_name must appear after exception_count (appended; not inserted mid-list).
  if v_pos_contact_name <= v_pos_exception then
    raise exception 'contact_name (pos %) must appear after exception_count (pos %)',
      v_pos_contact_name, v_pos_exception;
  end if;

  -- contact_phone must appear after contact_name.
  if v_pos_contact_phone <= v_pos_contact_name then
    raise exception 'contact_phone (pos %) must appear after contact_name (pos %)',
      v_pos_contact_phone, v_pos_contact_name;
  end if;

  raise notice 'Test 2 passed: view column order preserved; contact columns appended after exception_count';
end;
$$;

-- ── 3. Contact values flow through the view correctly ─────────────────────────

do $$
declare
  v_driver_id   uuid := gen_random_uuid();
  v_route_id    uuid;
  v_stop_id     uuid;
  v_cname       text;
  v_cphone      text;
begin
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  -- Stop with both contact fields populated.
  insert into public.route_stops (
    route_id, sequence_order, stop_type, address,
    contact_name, contact_phone
  )
  values (
    v_route_id, 0, 'delivery', '10 Contact Ave',
    'Jane Foreman', '555-0100'
  )
  returning id into v_stop_id;

  select contact_name, contact_phone
    into v_cname, v_cphone
  from public.v_driver_dispatch_stops
  where stop_id = v_stop_id;

  if v_cname <> 'Jane Foreman' then
    raise exception 'Test 3a: expected contact_name = ''Jane Foreman''; got %', v_cname;
  end if;
  if v_cphone <> '555-0100' then
    raise exception 'Test 3a: expected contact_phone = ''555-0100''; got %', v_cphone;
  end if;

  raise notice 'Test 3a passed: contact_name and contact_phone flow through view';

  -- Stop with no contact fields: both should be null.
  insert into public.route_stops (route_id, sequence_order, stop_type, address)
  values (v_route_id, 1, 'pickup', '11 No-Contact Rd')
  returning id into v_stop_id;

  select contact_name, contact_phone
    into v_cname, v_cphone
  from public.v_driver_dispatch_stops
  where stop_id = v_stop_id;

  if v_cname is not null then
    raise exception 'Test 3b: expected contact_name null for stop with no contact; got %', v_cname;
  end if;
  if v_cphone is not null then
    raise exception 'Test 3b: expected contact_phone null for stop with no contact; got %', v_cphone;
  end if;

  raise notice 'Test 3b passed: null contact fields are null in view';
end;
$$;

-- ── 4. anon is denied SELECT on v_driver_dispatch_stops ──────────────────────

set local role anon;

do $$
declare
  v_dummy int;
  v_caught bool := false;
begin
  begin
    select count(*) into v_dummy from public.v_driver_dispatch_stops;
    raise exception 'anon must not read v_driver_dispatch_stops';
  exception
    when insufficient_privilege then v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on v_driver_dispatch_stops';
  end if;

  raise notice 'Test 4 passed: anon denied on v_driver_dispatch_stops';
end;
$$;

reset role;

-- ── 5 & 6. authenticated field_operator role chain + RLS ─────────────────────

do $$
declare
  v_driver_a  uuid := gen_random_uuid();
  v_driver_b  uuid := gen_random_uuid();
  v_route_a   uuid;
  v_route_b   uuid;
  v_stop_a    uuid;
  v_stop_b    uuid;
  v_count     int;
  v_cname     text;
  v_cphone    text;
begin
  -- Seed two routes / stops as superuser (outside the security-invoker boundary).
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_a, current_date, 'pending')
  returning id into v_route_a;

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_b, current_date, 'pending')
  returning id into v_route_b;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, address,
    contact_name, contact_phone
  )
  values (
    v_route_a, 0, 'delivery', '1 Alpha St',
    'Alice Contact', '555-1001'
  )
  returning id into v_stop_a;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, address,
    contact_name, contact_phone
  )
  values (
    v_route_b, 0, 'delivery', '2 Beta St',
    'Bob Contact', '555-1002'
  )
  returning id into v_stop_b;

  -- ── 5: field_operator A reads their own stop and sees contact fields ─────
  set local role authenticated;
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          v_driver_a::text,
      'app_metadata', jsonb_build_object('role', 'field_operator')
    )::text, true);

  select count(*) into v_count
  from public.v_driver_dispatch_stops
  where stop_id = v_stop_a;

  if v_count <> 1 then
    raise exception 'Test 5a: field_operator A should see 1 own stop; got %', v_count;
  end if;

  select contact_name, contact_phone
    into v_cname, v_cphone
  from public.v_driver_dispatch_stops
  where stop_id = v_stop_a;

  if v_cname <> 'Alice Contact' then
    raise exception 'Test 5b: expected contact_name = ''Alice Contact''; got %', v_cname;
  end if;
  if v_cphone <> '555-1001' then
    raise exception 'Test 5b: expected contact_phone = ''555-1001''; got %', v_cphone;
  end if;

  raise notice 'Test 5 passed: authenticated field_operator reads own stop with contact columns via security_invoker + RLS';

  -- ── 6: field_operator A cannot read field_operator B stop ────────────────
  select count(*) into v_count
  from public.v_driver_dispatch_stops
  where stop_id = v_stop_b;

  if v_count <> 0 then
    raise exception 'Test 6: field_operator A must not see driver B stop; got %', v_count;
  end if;

  raise notice 'Test 6 passed: authenticated field_operator cannot read another driver''s stop';
end;
$$;

reset role;

rollback;
