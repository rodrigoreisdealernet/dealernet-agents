-- Behavioral tests for 20260612032000_visionlink_observability_reconciliation.sql

begin;

do $$
declare
  v_tenant_a constant uuid := 'cc000000-0000-0000-0000-000000000001';
  v_tenant_b constant uuid := 'cc000000-0000-0000-0000-000000000002';
  v_event_a  constant uuid := 'cc000000-0000-0000-0001-000000000001';
  v_event_b  constant uuid := 'cc000000-0000-0000-0001-000000000002';
begin
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a, 'visionlink-ops-a', 'VisionLink Ops Tenant A'),
    (v_tenant_b, 'visionlink-ops-b', 'VisionLink Ops Tenant B')
  on conflict (id) do nothing;

  insert into public.visionlink_sync_events (
    id, tenant_id, asset_external_id, signal_type, direction, sync_status,
    failure_class, failure_code, failure_message, retry_count, max_retries,
    lag_seconds, source_event_id, source_system
  ) values
    (
      v_event_a, v_tenant_a, 'CAT-100', 'route_position', 'inbound', 'retrying',
      'timeout', 'HTTP_504', 'provider timeout', 1, 3,
      180, 'evt-a-1', 'visionlink'
    ),
    (
      v_event_b, v_tenant_b, 'CAT-200', 'gps_status', 'inbound', 'retrying',
      'auth', 'HTTP_401', 'token expired', 1, 3,
      240, 'evt-b-1', 'visionlink'
    )
  on conflict (id) do update
    set sync_status = excluded.sync_status,
        failure_class = excluded.failure_class,
        source_event_id = excluded.source_event_id,
        lag_seconds = excluded.lag_seconds,
        retry_count = excluded.retry_count;

  insert into public.visionlink_reconciliation_results (
    tenant_id, asset_external_id, signal_type, drift_status, lag_seconds,
    diagnostic_summary, dia_value, provider_value
  ) values
    (
      v_tenant_a, 'CAT-100', 'route_position', 'mismatch', 300,
      'Dealernet position differs from VisionLink payload',
      jsonb_build_object('lat', 51.501, 'lng', -0.141),
      jsonb_build_object('lat', 51.492, 'lng', -0.130)
    ),
    (
      v_tenant_b, 'CAT-200', 'gps_status', 'lagging', 420,
      'Provider GPS update delayed beyond SLA',
      jsonb_build_object('gps_status', 'online'),
      jsonb_build_object('gps_status', 'stale')
    )
  on conflict do nothing;
end;
$$;

do $$
declare
  v_has_invoker bool;
  v_view text;
begin
  foreach v_view in array array[
    'v_visionlink_sync_dashboard',
    'v_visionlink_failed_work',
    'v_visionlink_reconciliation_drift',
    'v_visionlink_reconciliation_summary'
  ] loop
    select coalesce('security_invoker=true' = any(c.reloptions), false)
      into v_has_invoker
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_view;

    if not coalesce(v_has_invoker, false) then
      raise exception 'FAIL: % must declare security_invoker = true', v_view;
    end if;
  end loop;
end;
$$;

set local role anon;

do $$
declare
  v_dummy int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_dummy from public.visionlink_sync_events;
  exception
    when insufficient_privilege then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL: anon should be denied on visionlink_sync_events';
  end if;

  v_caught := false;
  begin
    perform public.visionlink_quarantine_sync_event(gen_random_uuid(), 'test');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL: anon should be denied execute on visionlink_quarantine_sync_event';
  end if;
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbbb","role":"authenticated","app_metadata":{"role":"read_only","tenant":"visionlink-ops-a"}}',
  true
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.visionlink_sync_events;
  if v_count <> 0 then
    raise exception 'FAIL: read_only should see 0 visionlink_sync_events rows, got %', v_count;
  end if;

  select count(*) into v_count from public.v_visionlink_reconciliation_drift;
  if v_count <> 0 then
    raise exception 'FAIL: read_only should see 0 drift rows, got %', v_count;
  end if;
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-cccccccccccc","role":"authenticated","app_metadata":{"role":"admin","tenant":"visionlink-ops-a"}}',
  true
);

do $$
declare
  v_event_a constant uuid := 'cc000000-0000-0000-0001-000000000001';
  v_tenant_b constant uuid := 'cc000000-0000-0000-0000-000000000002';
  v_dlq_id uuid;
  v_replay_event_id uuid;
  v_control_id uuid;
  v_count int;
begin
  select count(*) into v_count from public.v_visionlink_failed_work;
  if v_count <> 1 then
    raise exception 'FAIL: admin tenant-A should see 1 failed row, got %', v_count;
  end if;

  if exists (
    select 1 from public.v_visionlink_failed_work where tenant_id = v_tenant_b
  ) then
    raise exception 'FAIL: tenant-A should not see tenant-B failed work rows';
  end if;

  v_dlq_id := public.visionlink_quarantine_sync_event(
    v_event_a,
    'manual quarantine for replay',
    true,
    'operator note'
  );

  if not exists (
    select 1
    from public.visionlink_dead_letter_queue
    where id = v_dlq_id and replay_eligible = true and asset_external_id = 'CAT-100'
  ) then
    raise exception 'FAIL: quarantine did not create replay-eligible DLQ row';
  end if;

  v_replay_event_id := public.visionlink_mark_replayed(v_dlq_id, 'ops-user', 'replayed after fix');

  if not exists (
    select 1
    from public.visionlink_sync_events
    where id = v_replay_event_id
      and sync_status = 'replayed'
      and replayed_from_id = v_event_a
  ) then
    raise exception 'FAIL: replay did not create replayed sync event';
  end if;

  v_control_id := public.visionlink_disable_sync_scope(
    v_replay_event_id,
    'provider maintenance window',
    'pause retries during outage'
  );

  if not exists (
    select 1
    from public.visionlink_sync_controls
    where id = v_control_id
      and control_status = 'disabled'
      and signal_type = 'route_position'
  ) then
    raise exception 'FAIL: disable scope did not persist control row';
  end if;

  if not exists (
    select 1
    from public.visionlink_sync_events
    where id = v_replay_event_id
      and sync_status = 'disabled'
  ) then
    raise exception 'FAIL: disable scope did not mark event disabled';
  end if;

  select count(*) into v_count
  from public.v_visionlink_reconciliation_drift
  where signal_type = 'route_position';

  if v_count <> 1 then
    raise exception 'FAIL: tenant-A should see 1 route_position drift row, got %', v_count;
  end if;

  if exists (
    select 1 from public.v_visionlink_reconciliation_drift where tenant_id = v_tenant_b
  ) then
    raise exception 'FAIL: tenant-A should not see tenant-B drift rows';
  end if;
end;
$$;

reset role;

set local role service_role;

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.visionlink_sync_events;
  if v_count < 2 then
    raise exception 'FAIL: service_role should see all tenant rows, got %', v_count;
  end if;
end;
$$;

rollback;
