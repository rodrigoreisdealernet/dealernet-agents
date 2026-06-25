-- Behavioral tests for 20260612113000_samsara_observability_reconciliation.sql

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
    (v_tenant_a, 'samsara-ops-a', 'Samsara Ops Tenant A'),
    (v_tenant_b, 'samsara-ops-b', 'Samsara Ops Tenant B')
  on conflict (id) do nothing;

  insert into public.samsara_sync_events (
    id, tenant_id, asset_external_id, signal_type, direction, sync_status,
    failure_class, failure_code, failure_message, retry_count, max_retries,
    lag_seconds, source_event_id, source_system
  ) values
    (
      v_event_a, v_tenant_a, 'CAT-100', 'gps', 'inbound', 'retrying',
      'timeout', 'HTTP_504', 'provider timeout', 1, 3,
      180, 'evt-a-1', 'samsara'
    ),
    (
      v_event_b, v_tenant_b, 'CAT-200', 'hours', 'inbound', 'retrying',
      'auth', 'HTTP_401', 'token expired', 1, 3,
      240, 'evt-b-1', 'samsara'
    )
  on conflict (id) do update
    set sync_status = excluded.sync_status,
        failure_class = excluded.failure_class,
        source_event_id = excluded.source_event_id,
        lag_seconds = excluded.lag_seconds,
        retry_count = excluded.retry_count;

  insert into public.samsara_reconciliation_results (
    tenant_id, asset_external_id, signal_type, drift_status, lag_seconds,
    diagnostic_summary, wynne_value, provider_value
  ) values
    (
      v_tenant_a, 'CAT-100', 'gps', 'mismatch', 300,
      'Wynne position differs from Samsara payload',
      jsonb_build_object('lat', 51.501, 'lng', -0.141),
      jsonb_build_object('lat', 51.492, 'lng', -0.130)
    ),
    (
      v_tenant_b, 'CAT-200', 'hours', 'lagging', 420,
      'Provider GPS update delayed beyond SLA',
      jsonb_build_object('hours', 'online'),
      jsonb_build_object('hours', 'stale')
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
    'v_samsara_sync_dashboard',
    'v_samsara_failed_work',
    'v_samsara_reconciliation_drift',
    'v_samsara_reconciliation_summary'
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
    select count(*) into v_dummy from public.samsara_sync_events;
  exception
    when insufficient_privilege then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL: anon should be denied on samsara_sync_events';
  end if;

  v_caught := false;
  begin
    perform public.samsara_quarantine_sync_event(gen_random_uuid(), 'test');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL: anon should be denied execute on samsara_quarantine_sync_event';
  end if;
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbbb","role":"authenticated","app_metadata":{"role":"read_only","tenant":"samsara-ops-a"}}',
  true
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.samsara_sync_events;
  if v_count <> 0 then
    raise exception 'FAIL: read_only should see 0 samsara_sync_events rows, got %', v_count;
  end if;

  select count(*) into v_count from public.v_samsara_reconciliation_drift;
  if v_count <> 0 then
    raise exception 'FAIL: read_only should see 0 drift rows, got %', v_count;
  end if;
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-cccccccccccc","role":"authenticated","app_metadata":{"role":"admin","tenant":"samsara-ops-a"}}',
  true
);

do $$
declare
  v_tenant_a constant uuid := 'cc000000-0000-0000-0000-000000000001';
  v_event_a  constant uuid := 'cc000000-0000-0000-0001-000000000001';
  v_table text;
  v_caught bool;
begin
  foreach v_table in array array[
    'samsara_sync_events',
    'samsara_dead_letter_queue',
    'samsara_sync_controls',
    'samsara_reconciliation_results'
  ] loop
    v_caught := false;
    begin
      if v_table = 'samsara_sync_events' then
        insert into public.samsara_sync_events (
          tenant_id, asset_external_id, signal_type, source_event_id
        ) values (
          v_tenant_a, 'AUTH-DENY-CAT-100', 'gps', 'auth-deny-sync-event'
        );
      elsif v_table = 'samsara_dead_letter_queue' then
        insert into public.samsara_dead_letter_queue (
          tenant_id, sync_event_id, asset_external_id, signal_type, failure_message, quarantine_reason
        ) values (
          v_tenant_a, v_event_a, 'AUTH-DENY-CAT-100', 'gps', 'auth deny test', 'auth deny test'
        );
      elsif v_table = 'samsara_sync_controls' then
        insert into public.samsara_sync_controls (
          tenant_id, asset_external_id, signal_type
        ) values (
          v_tenant_a, 'AUTH-DENY-CAT-100', 'gps'
        );
      elsif v_table = 'samsara_reconciliation_results' then
        insert into public.samsara_reconciliation_results (
          tenant_id, asset_external_id, signal_type, drift_status
        ) values (
          v_tenant_a, 'AUTH-DENY-CAT-100', 'gps', 'lagging'
        );
      else
        raise exception 'FAIL: unsupported table in auth write-denial test: %', v_table;
      end if;
    exception
      when insufficient_privilege then v_caught := true;
      when sqlstate '42501' then v_caught := true;
      when others then
        raise exception 'FAIL: authenticated insert on % should fail with insufficient_privilege, got %', v_table, sqlstate;
    end;
    if not v_caught then
      raise exception 'FAIL: authenticated insert on % should be denied', v_table;
    end if;

    v_caught := false;
    begin
      execute format('update public.%I set tenant_id = tenant_id where tenant_id is not null', v_table);
    exception
      when insufficient_privilege then v_caught := true;
      when sqlstate '42501' then v_caught := true;
      when others then
        raise exception 'FAIL: authenticated update on % should fail with insufficient_privilege, got %', v_table, sqlstate;
    end;
    if not v_caught then
      raise exception 'FAIL: authenticated update on % should be denied', v_table;
    end if;

    v_caught := false;
    begin
      execute format('delete from public.%I where tenant_id is not null', v_table);
    exception
      when insufficient_privilege then v_caught := true;
      when sqlstate '42501' then v_caught := true;
      when others then
        raise exception 'FAIL: authenticated delete on % should fail with insufficient_privilege, got %', v_table, sqlstate;
    end;
    if not v_caught then
      raise exception 'FAIL: authenticated delete on % should be denied', v_table;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_event_a constant uuid := 'cc000000-0000-0000-0001-000000000001';
  v_tenant_b constant uuid := 'cc000000-0000-0000-0000-000000000002';
  v_dlq_id uuid;
  v_replay_event_id uuid;
  v_control_id uuid;
  v_count int;
begin
  select count(*) into v_count from public.v_samsara_failed_work;
  if v_count <> 1 then
    raise exception 'FAIL: admin tenant-A should see 1 failed row, got %', v_count;
  end if;

  if exists (
    select 1 from public.v_samsara_failed_work where tenant_id = v_tenant_b
  ) then
    raise exception 'FAIL: tenant-A should not see tenant-B failed work rows';
  end if;

  v_dlq_id := public.samsara_quarantine_sync_event(
    v_event_a,
    'manual quarantine for replay',
    true,
    'operator note'
  );

  if not exists (
    select 1
    from public.samsara_dead_letter_queue
    where id = v_dlq_id and replay_eligible = true and asset_external_id = 'CAT-100'
  ) then
    raise exception 'FAIL: quarantine did not create replay-eligible DLQ row';
  end if;

  v_replay_event_id := public.samsara_mark_replayed(v_dlq_id, 'ops-user', 'replayed after fix');

  if not exists (
    select 1
    from public.samsara_sync_events
    where id = v_replay_event_id
      and sync_status = 'replayed'
      and replayed_from_id = v_event_a
  ) then
    raise exception 'FAIL: replay did not create replayed sync event';
  end if;

  v_control_id := public.samsara_disable_sync_scope(
    v_replay_event_id,
    'provider maintenance window',
    'pause retries during outage'
  );

  if not exists (
    select 1
    from public.samsara_sync_controls
    where id = v_control_id
      and control_status = 'disabled'
      and signal_type = 'gps'
  ) then
    raise exception 'FAIL: disable scope did not persist control row';
  end if;

  if not exists (
    select 1
    from public.samsara_sync_events
    where id = v_replay_event_id
      and sync_status = 'disabled'
  ) then
    raise exception 'FAIL: disable scope did not mark event disabled';
  end if;

  v_control_id := public.samsara_enable_sync_scope(
    v_control_id,
    'ops-user',
    'resume after provider recovery'
  );

  if not exists (
    select 1
    from public.samsara_sync_controls
    where id = v_control_id
      and control_status = 'enabled'
      and enabled_by = 'ops-user'
  ) then
    raise exception 'FAIL: enable scope did not reactivate control row';
  end if;

  if not exists (
    select 1
    from public.samsara_sync_events
    where id = v_replay_event_id
      and sync_status = 'disabled'
      and resolved_at is not null
  ) then
    raise exception 'FAIL: enable scope did not resolve disabled event';
  end if;

  select count(*) into v_count
  from public.v_samsara_reconciliation_drift
  where signal_type = 'gps';

  if v_count <> 1 then
    raise exception 'FAIL: tenant-A should see 1 gps drift row, got %', v_count;
  end if;

  if exists (
    select 1 from public.v_samsara_reconciliation_drift where tenant_id = v_tenant_b
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
  select count(*) into v_count from public.samsara_sync_events;
  if v_count < 2 then
    raise exception 'FAIL: service_role should see all tenant rows, got %', v_count;
  end if;
end;
$$;

rollback;
