-- Post-reset smoke-check for logistics_compliance_surface
-- (migration 20260609143000_logistics_compliance_surface.sql).
--
-- Run after `supabase db reset` to confirm:
--   1. logistics_telematics_events table exists with expected columns.
--   2. v_dispatch_route_live includes normalized telemetry/compliance columns.
--   3. v_transport_efficiency_summary includes ELD/GPS summary columns.
--   4. v_driver_dispatch_stops includes compliance columns.
--   5. The dispatcher + driver query paths return valid rows with compliance
--      defaults when no telemetry events are present.

begin;

do $$
declare
  v_asset_id     constant uuid := 'cafebeef-0000-0000-0001-000000000abc';
  v_line_id      constant uuid := 'cafebeef-0000-0000-0002-000000000abc';
  v_route_id     uuid;
  v_driver_id    uuid := gen_random_uuid();

  v_table_exists       bool;
  v_col_count          int;
  v_view_eld           text;
  v_view_gps           text;
  v_view_driver_log    text;
  v_driver_eld         text;
  v_driver_gps         text;
  v_summary_count      int;
  v_stop_count         int;
  v_eld_warning_col    int;
  v_stale_gps_col      int;
begin
  -- 1. Table existence.
  select exists(
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name   = 'logistics_telematics_events'
  ) into v_table_exists;
  if not v_table_exists then
    raise exception 'logistics_telematics_events table missing after db reset';
  end if;

  -- 2. Expected columns on logistics_telematics_events.
  select count(*) into v_col_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'logistics_telematics_events'
    and column_name  in (
      'id', 'contract_line_id', 'route_id',
      'source_system', 'source_event_id', 'event_time',
      'telemetry_position_status', 'eld_compliance_status', 'driver_log_status',
      'latitude', 'longitude',
      'sync_status', 'retry_count', 'sync_error', 'payload',
      'created_at', 'updated_at'
    );
  if v_col_count <> 17 then
    raise exception
      'logistics_telematics_events column count mismatch after reset: expected 17, got %',
      v_col_count;
  end if;

  -- 3. Seed minimal fixture data so views can return rows.
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_asset_id, 'asset',                'compliance-reset-asset'),
    (v_line_id,  'rental_contract_line', 'compliance-reset-line')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_asset_id, 1, true,
      '{"status":"available","name":"Reset Smoke Excavator","serial_number":"RST-001"}'::jsonb,
      now()
    ),
    (
      v_line_id, 1, true,
      jsonb_build_object(
        'status',       'checked_out',
        'contract_id',  gen_random_uuid()::text,
        'asset_id',     v_asset_id::text,
        'actual_start', (now() - interval '1 hour')::text,
        'confirm_load', jsonb_build_object(
          'assigned_driver', 'reset-smoke-driver',
          'assigned_truck',  'reset-smoke-truck',
          'departure_at',    (now() - interval '1 hour')::text
        )
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    contract_line_id, asset_id, address, customer_name, job_site_name
  )
  values (
    v_route_id, 0, 'delivery', 'pending',
    v_line_id, v_asset_id, '1 Reset Ave', 'Reset Customer', 'Reset Site'
  );

  -- 4. v_dispatch_route_live returns the compliance columns defaulting to 'unknown'
  --    when no telemetry events are present.
  select eld_compliance_status, telemetry_position_status, driver_log_status
  into v_view_eld, v_view_gps, v_view_driver_log
  from public.v_dispatch_route_live
  where line_id = v_line_id;

  if v_view_eld is null then
    raise exception
      'v_dispatch_route_live returned NULL eld_compliance_status — view join is broken';
  end if;
  if v_view_eld <> 'unknown' then
    raise exception
      'v_dispatch_route_live expected eld_compliance_status=unknown (no telemetry), got %',
      v_view_eld;
  end if;
  if v_view_gps <> 'unknown' then
    raise exception
      'v_dispatch_route_live expected telemetry_position_status=unknown, got %', v_view_gps;
  end if;
  if v_view_driver_log <> 'unknown' then
    raise exception
      'v_dispatch_route_live expected driver_log_status=unknown, got %', v_view_driver_log;
  end if;

  -- 5. v_transport_efficiency_summary returns ELD/GPS aggregate columns.
  select eld_warning_count, stale_position_count
  into v_eld_warning_col, v_stale_gps_col
  from public.v_transport_efficiency_summary;

  if v_eld_warning_col is null then
    raise exception
      'v_transport_efficiency_summary missing eld_warning_count column after reset';
  end if;
  if v_stale_gps_col is null then
    raise exception
      'v_transport_efficiency_summary missing stale_position_count column after reset';
  end if;

  -- 6. v_driver_dispatch_stops returns compliance columns defaulting to 'unknown'.
  select eld_compliance_status, telemetry_position_status
  into v_driver_eld, v_driver_gps
  from public.v_driver_dispatch_stops
  where contract_line_id = v_line_id;

  if v_driver_eld is null then
    raise exception
      'v_driver_dispatch_stops returned NULL eld_compliance_status — view join is broken';
  end if;
  if v_driver_eld <> 'unknown' then
    raise exception
      'v_driver_dispatch_stops expected eld_compliance_status=unknown (no telemetry), got %',
      v_driver_eld;
  end if;

  -- 7. Insert a telemetry event and confirm views pick up the override.
  insert into public.logistics_telematics_events (
    contract_line_id, route_id, source_system, source_event_id,
    event_time, telemetry_position_status, eld_compliance_status,
    driver_log_status, sync_status
  )
  values (
    v_line_id, v_route_id, 'reset_smoke_eld', 'reset-evt-001',
    now(), 'fresh', 'warning', 'current', 'applied'
  );

  select eld_compliance_status, telemetry_position_status
  into v_view_eld, v_view_gps
  from public.v_dispatch_route_live
  where line_id = v_line_id;

  if v_view_eld <> 'warning' then
    raise exception
      'v_dispatch_route_live expected eld_compliance_status=warning after telemetry insert, got %',
      v_view_eld;
  end if;
  if v_view_gps <> 'fresh' then
    raise exception
      'v_dispatch_route_live expected telemetry_position_status=fresh after telemetry insert, got %',
      v_view_gps;
  end if;

  -- 8. Dedupe constraint: inserting the same source_system+source_event_id+contract_line_id
  --    a second time must fail with a unique violation.
  begin
    insert into public.logistics_telematics_events (
      contract_line_id, route_id, source_system, source_event_id,
      event_time, telemetry_position_status, eld_compliance_status,
      driver_log_status, sync_status
    )
    values (
      v_line_id, v_route_id, 'reset_smoke_eld', 'reset-evt-001',
      now(), 'stale', 'compliant', 'current', 'applied'
    );
    raise exception
      'Dedupe constraint did not fire — logistics_telematics_events_dedupe_uniq is missing';
  exception
    when unique_violation then null; -- expected
  end;

  raise notice 'PASS logistics_compliance_surface reset-path smoke checks';
end;
$$;

rollback;
