-- Behavioral access-contract checks for logistics_compliance_surface
-- (migration 20260609143000_logistics_compliance_surface.sql).
--
-- Verifies:
--   * anon cannot read logistics_telematics_events or the exposed views
--   * ops authenticated role can read table + views
--   * non-ops authenticated role is filtered from table rows and denied on
--     driver view rows by existing route RLS
--   * service_role can write/read telemetry rows

begin;

set local role service_role;

-- Fixture entities for dispatcher views.
do $$
declare
  v_asset_id constant uuid := 'deadbeef-0000-0000-0001-0000000000aa';
  v_line_id  constant uuid := 'deadbeef-0000-0000-0002-0000000000aa';
  v_route_id uuid;
  v_driver_id uuid := gen_random_uuid();
begin
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_asset_id, 'asset',                'logistics-compliance-access-asset'),
    (v_line_id,  'rental_contract_line', 'logistics-compliance-access-line')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_asset_id, 1, true,
      '{"status":"available","name":"Compliance Test Excavator","serial_number":"COMP-001"}'::jsonb,
      now()
    ),
    (
      v_line_id, 1, true,
      jsonb_build_object(
        'status',       'checked_out',
        'contract_id',  gen_random_uuid()::text,
        'asset_id',     v_asset_id::text,
        'actual_start', (now() - interval '2 hours')::text,
        'confirm_load', jsonb_build_object(
          'assigned_driver', 'compliance-driver-001',
          'assigned_truck',  'compliance-truck-001',
          'departure_at',    (now() - interval '2 hours')::text
        )
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id,
    sequence_order,
    stop_type,
    status,
    contract_line_id,
    asset_id,
    address,
    customer_name,
    job_site_name
  )
  values (
    v_route_id,
    0,
    'delivery',
    'pending',
    v_line_id,
    v_asset_id,
    '100 Compliance Ave',
    'Compliance Customer',
    'Compliance Site'
  );
end;
$$;

-- Anon cannot read the table or any exposed logistics views.
set local role anon;

do $$
declare
  v_dummy int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_dummy from public.logistics_telematics_events;
    raise exception 'anon should not read logistics_telematics_events';
  exception
    when insufficient_privilege then v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on logistics_telematics_events';
  end if;

  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_dispatch_route_live;
    raise exception 'anon should not read v_dispatch_route_live';
  exception
    when insufficient_privilege then v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on v_dispatch_route_live';
  end if;

  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_transport_efficiency_summary;
    raise exception 'anon should not read v_transport_efficiency_summary';
  exception
    when insufficient_privilege then v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on v_transport_efficiency_summary';
  end if;

  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_driver_dispatch_stops;
    raise exception 'anon should not read v_driver_dispatch_stops';
  exception
    when insufficient_privilege then v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on v_driver_dispatch_stops';
  end if;

  raise notice 'PASS anon denies on logistics table and views';
end;
$$;

reset role;

-- service_role can write/read telemetry events.
set local role service_role;

insert into public.logistics_telematics_events (
  contract_line_id,
  route_id,
  source_system,
  source_event_id,
  event_time,
  telemetry_position_status,
  eld_compliance_status,
  driver_log_status,
  sync_status
)
select
  'deadbeef-0000-0000-0002-0000000000aa'::uuid,
  rs.route_id,
  'test_eld',
  'evt-001',
  now(),
  'fresh',
  'warning',
  'current',
  'applied'
from public.route_stops rs
where rs.contract_line_id = 'deadbeef-0000-0000-0002-0000000000aa'::uuid
limit 1;

do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.logistics_telematics_events
  where source_system = 'test_eld' and source_event_id = 'evt-001';

  if v_count <> 1 then
    raise exception 'service_role expected to read inserted telemetry row, got %', v_count;
  end if;

  raise notice 'PASS service_role write/read on logistics_telematics_events';
end;
$$;

reset role;

-- Ops authenticated role can read table + views and sees telemetry values.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_count int;
  v_eld text;
  v_driver_rows int;
begin
  select count(*) into v_count
  from public.logistics_telematics_events
  where source_system = 'test_eld' and source_event_id = 'evt-001';
  if v_count <> 1 then
    raise exception 'ops authenticated expected 1 telemetry row, got %', v_count;
  end if;

  select eld_compliance_status into v_eld
  from public.v_dispatch_route_live
  where line_id = 'deadbeef-0000-0000-0002-0000000000aa'::uuid;
  if v_eld <> 'warning' then
    raise exception 'ops authenticated expected warning in v_dispatch_route_live, got %', v_eld;
  end if;

  select count(*) into v_driver_rows
  from public.v_driver_dispatch_stops
  where contract_line_id = 'deadbeef-0000-0000-0002-0000000000aa'::uuid;
  if v_driver_rows < 1 then
    raise exception 'ops authenticated expected to read v_driver_dispatch_stops rows, got %', v_driver_rows;
  end if;

  raise notice 'PASS ops authenticated role reads telemetry table + views';
end;
$$;

-- Non-ops authenticated role is filtered/denied by table and route RLS.
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_table_count int;
  v_driver_rows int;
  v_eld text;
begin
  select count(*) into v_table_count
  from public.logistics_telematics_events
  where source_system = 'test_eld' and source_event_id = 'evt-001';
  if v_table_count <> 0 then
    raise exception 'non-ops authenticated should be filtered from telemetry rows, got %', v_table_count;
  end if;

  select count(*) into v_driver_rows
  from public.v_driver_dispatch_stops
  where contract_line_id = 'deadbeef-0000-0000-0002-0000000000aa'::uuid;
  if v_driver_rows <> 0 then
    raise exception 'non-ops authenticated should be denied/filtered from driver view rows, got %', v_driver_rows;
  end if;

  select eld_compliance_status into v_eld
  from public.v_dispatch_route_live
  where line_id = 'deadbeef-0000-0000-0002-0000000000aa'::uuid;
  if v_eld <> 'unknown' then
    raise exception 'non-ops authenticated should see masked telemetry status (unknown), got %', v_eld;
  end if;

  raise notice 'PASS non-ops authenticated filtering/denial checks';
end;
$$;

reset role;

rollback;
