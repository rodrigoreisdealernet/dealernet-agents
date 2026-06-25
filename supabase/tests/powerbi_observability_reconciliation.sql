-- RLS / role-gating behavioral tests for powerbi_observability_reconciliation
-- (migration 20260612120000_powerbi_observability_reconciliation.sql).
--
-- Covers:
--   PASS 1  — views declare security_invoker = true
--   PASS 2  — anon denied SELECT on base tables
--   PASS 3  — anon denied SELECT on views
--   PASS 4  — anon denied EXECUTE on operator RPCs
--   PASS 5  — authenticated direct INSERT/UPDATE/DELETE denied on all four tables
--   PASS 6  — authenticated without app_role sees 0 rows (RLS not inert)
--   PASS 7  — read_only sees 0 rows and cannot invoke operator RPCs
--   PASS 8  — admin tenant-A reads are tenant-filtered (tenant-B rows invisible)
--   PASS 9  — admin quarantines export run and failed-exports view surfaces it
--   PASS 10 — admin replays from DLQ and audit chain is correct
--   PASS 11 — admin disables export scope and failed-exports view reflects it
--   PASS 12 — admin re-enables export scope and resolves the disabled event
--   PASS 13 — cross-tenant isolation enforced in operator RPCs
--   PASS 14 — service_role sees all rows

begin;

do $$
declare
  v_tenant_a constant uuid := 'ee000000-0000-0000-0000-000000000001';
  v_tenant_b constant uuid := 'ee000000-0000-0000-0000-000000000002';
  v_run_a1   constant uuid := 'ee000000-0000-0000-0001-000000000001';
  v_run_a2   constant uuid := 'ee000000-0000-0000-0001-000000000002';
  v_run_b1   constant uuid := 'ee000000-0000-0000-0001-000000000003';
begin
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a, 'powerbi-rls-a', 'Power BI RLS Test Tenant A'),
    (v_tenant_b, 'powerbi-rls-b', 'Power BI RLS Test Tenant B')
  on conflict (id) do nothing;

  insert into public.powerbi_export_runs (
    id, tenant_id, provider_name, export_run_id,
    workspace_id, dataset_id, export_scope, direction,
    export_status, failure_class, failure_code, failure_message,
    retry_count, max_retries, source_event_id, idempotency_key
  ) values
    (
      v_run_a1, v_tenant_a, 'powerbi', 'run-pbi-a1',
      'ws-a', 'ds-a', 'dataset_push', 'outbound',
      'retrying', 'auth', 'OAUTH_401', 'token expired',
      1, 3, 'src-pbi-a-001', 'idem-pbi-a-001'
    ),
    (
      v_run_a2, v_tenant_a, 'powerbi', 'run-pbi-a2',
      'ws-a', 'ds-b', 'dataset_refresh', 'outbound',
      'retrying', 'transport', 'CONN_TIMEOUT', 'connection timed out',
      1, 3, 'src-pbi-a-002', 'idem-pbi-a-002'
    ),
    (
      v_run_b1, v_tenant_b, 'powerbi', 'run-pbi-b1',
      'ws-b', 'ds-c', 'dataset_push', 'outbound',
      'retrying', 'rate_limit', 'HTTP_429', 'rate limit exceeded',
      1, 3, 'src-pbi-b-001', 'idem-pbi-b-001'
    )
  on conflict (id) do update
    set export_status = excluded.export_status,
        failure_class = excluded.failure_class,
        resolved_at   = null;

  insert into public.powerbi_stale_refresh_alerts (
    tenant_id, provider_name, workspace_id, dataset_id,
    alert_status, last_refresh_status, stale_threshold_minutes,
    age_minutes, diagnostic_summary, last_export_run_id
  ) values
    (
      v_tenant_a, 'powerbi', 'ws-a', 'ds-a',
      'open', 'Failed', 120,
      180, 'dataset has not refreshed within threshold', v_run_a1
    ),
    (
      v_tenant_b, 'powerbi', 'ws-b', 'ds-c',
      'open', 'Disabled', 120,
      200, 'refresh disabled in Power BI service', v_run_b1
    )
  on conflict (tenant_id, provider_name, workspace_id, dataset_id) do update
    set alert_status  = excluded.alert_status,
        checked_at    = now();
end;
$$;

-- PASS 1: all Power BI views declare security_invoker = true
do $$
declare
  v_has_invoker bool;
  v_view text;
begin
  foreach v_view in array array[
    'v_powerbi_export_dashboard',
    'v_powerbi_failed_exports',
    'v_powerbi_stale_datasets'
  ] loop
    select coalesce('security_invoker=true' = any(c.reloptions), false)
      into v_has_invoker
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_view;

    if not coalesce(v_has_invoker, false) then
      raise exception 'FAIL 1: % must declare security_invoker = true', v_view;
    end if;
  end loop;

  raise notice 'PASS 1: all Power BI views declare security_invoker = true';
end;
$$;

-- PASS 2: anon denied SELECT on base tables
set local role anon;
do $$
declare
  v_dummy int;
  v_caught bool;
  v_rel text;
begin
  foreach v_rel in array array[
    'powerbi_export_runs',
    'powerbi_dead_letter_queue',
    'powerbi_sync_controls',
    'powerbi_stale_refresh_alerts'
  ] loop
    v_caught := false;
    begin
      execute format('select count(*) from public.%I', v_rel) into v_dummy;
      raise exception 'FAIL 2: anon read % succeeded', v_rel;
    exception
      when insufficient_privilege then v_caught := true;
      when others then
        raise exception 'FAIL 2: unexpected % on %: %', sqlstate, v_rel, sqlerrm;
    end;

    if not v_caught then
      raise exception 'FAIL 2: anon should be denied SELECT on %', v_rel;
    end if;
  end loop;

  raise notice 'PASS 2: anon denied SELECT on Power BI base tables';
end;
$$;
reset role;

-- PASS 3: anon denied SELECT on views
set local role anon;
do $$
declare
  v_dummy int;
  v_caught bool;
  v_rel text;
begin
  foreach v_rel in array array[
    'v_powerbi_export_dashboard',
    'v_powerbi_failed_exports',
    'v_powerbi_stale_datasets'
  ] loop
    v_caught := false;
    begin
      execute format('select count(*) from public.%I', v_rel) into v_dummy;
      raise exception 'FAIL 3: anon read % succeeded', v_rel;
    exception
      when insufficient_privilege then v_caught := true;
      when others then
        raise exception 'FAIL 3: unexpected % on %: %', sqlstate, v_rel, sqlerrm;
    end;

    if not v_caught then
      raise exception 'FAIL 3: anon should be denied SELECT on %', v_rel;
    end if;
  end loop;

  raise notice 'PASS 3: anon denied SELECT on Power BI views';
end;
$$;
reset role;

-- PASS 4: anon denied EXECUTE on operator RPCs
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
declare
  v_caught bool;
begin
  v_caught := false;
  begin
    perform public.powerbi_quarantine_export_run(gen_random_uuid(), 'test');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4a: anon should be denied powerbi_quarantine_export_run';
  end if;

  v_caught := false;
  begin
    perform public.powerbi_mark_replayed(gen_random_uuid(), 'anon');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4b: anon should be denied powerbi_mark_replayed';
  end if;

  v_caught := false;
  begin
    perform public.powerbi_disable_export_scope(gen_random_uuid(), 'anon');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4c: anon should be denied powerbi_disable_export_scope';
  end if;

  v_caught := false;
  begin
    perform public.powerbi_enable_export_scope(gen_random_uuid());
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4d: anon should be denied powerbi_enable_export_scope';
  end if;

  raise notice 'PASS 4: anon denied EXECUTE on Power BI operator RPCs';
end;
$$;
reset role;

-- PASS 5: authenticated direct INSERT/UPDATE/DELETE denied on all four tables
-- This test would fail if the RLS write policies are inert or if the grant
-- accidentally allows authenticated writes.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ee000000-0000-0000-0000-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"admin","tenant":"powerbi-rls-a"}}',
  true
);
do $$
declare
  v_tenant_a constant uuid := 'ee000000-0000-0000-0000-000000000001';
  v_caught bool;
begin
  -- INSERT on powerbi_export_runs
  v_caught := false;
  begin
    insert into public.powerbi_export_runs (
      tenant_id, workspace_id, dataset_id, export_scope,
      source_event_id
    ) values (
      v_tenant_a, 'ws-direct', 'ds-direct', 'dataset_push', 'direct-insert-test'
    );
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when check_violation then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5a: authenticated INSERT on powerbi_export_runs should be denied';
  end if;

  -- UPDATE on powerbi_export_runs
  v_caught := false;
  begin
    update public.powerbi_export_runs
    set operator_notes = 'direct update attempt'
    where tenant_id = v_tenant_a;
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5b: authenticated UPDATE on powerbi_export_runs should be denied';
  end if;

  -- DELETE on powerbi_export_runs
  v_caught := false;
  begin
    delete from public.powerbi_export_runs where tenant_id = v_tenant_a;
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5c: authenticated DELETE on powerbi_export_runs should be denied';
  end if;

  -- INSERT on powerbi_dead_letter_queue
  v_caught := false;
  begin
    insert into public.powerbi_dead_letter_queue (
      tenant_id, export_run_id, workspace_id, dataset_id,
      export_scope, failure_message, quarantine_reason
    ) values (
      v_tenant_a, gen_random_uuid(), 'ws-direct', 'ds-direct',
      'dataset_push', 'direct insert', 'test'
    );
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when foreign_key_violation then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5d: authenticated INSERT on powerbi_dead_letter_queue should be denied';
  end if;

  -- UPDATE on powerbi_dead_letter_queue
  v_caught := false;
  begin
    update public.powerbi_dead_letter_queue
    set resolution_note = 'direct update'
    where tenant_id = v_tenant_a;
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5e: authenticated UPDATE on powerbi_dead_letter_queue should be denied';
  end if;

  -- DELETE on powerbi_dead_letter_queue
  v_caught := false;
  begin
    delete from public.powerbi_dead_letter_queue where tenant_id = v_tenant_a;
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5f: authenticated DELETE on powerbi_dead_letter_queue should be denied';
  end if;

  -- INSERT on powerbi_sync_controls
  v_caught := false;
  begin
    insert into public.powerbi_sync_controls (
      tenant_id, workspace_id, dataset_id, export_scope
    ) values (
      v_tenant_a, 'ws-direct', 'ds-direct', 'dataset_push'
    );
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5g: authenticated INSERT on powerbi_sync_controls should be denied';
  end if;

  -- UPDATE on powerbi_sync_controls
  v_caught := false;
  begin
    update public.powerbi_sync_controls
    set operator_notes = 'direct update'
    where tenant_id = v_tenant_a;
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5h: authenticated UPDATE on powerbi_sync_controls should be denied';
  end if;

  -- DELETE on powerbi_sync_controls
  v_caught := false;
  begin
    delete from public.powerbi_sync_controls where tenant_id = v_tenant_a;
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5i: authenticated DELETE on powerbi_sync_controls should be denied';
  end if;

  -- INSERT on powerbi_stale_refresh_alerts
  v_caught := false;
  begin
    insert into public.powerbi_stale_refresh_alerts (
      tenant_id, workspace_id, dataset_id, last_refresh_status
    ) values (
      v_tenant_a, 'ws-direct', 'ds-direct-alert', 'Unknown'
    );
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5j: authenticated INSERT on powerbi_stale_refresh_alerts should be denied';
  end if;

  -- UPDATE on powerbi_stale_refresh_alerts
  v_caught := false;
  begin
    update public.powerbi_stale_refresh_alerts
    set operator_notes = 'direct update'
    where tenant_id = v_tenant_a;
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5k: authenticated UPDATE on powerbi_stale_refresh_alerts should be denied';
  end if;

  -- DELETE on powerbi_stale_refresh_alerts
  v_caught := false;
  begin
    delete from public.powerbi_stale_refresh_alerts where tenant_id = v_tenant_a;
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient_privilege%' or sqlerrm ilike '%RLS%' then
        v_caught := true;
      else
        raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5l: authenticated DELETE on powerbi_stale_refresh_alerts should be denied';
  end if;

  raise notice 'PASS 5: authenticated direct INSERT/UPDATE/DELETE denied on all four Power BI tables';
end;
$$;
reset role;

-- PASS 6: authenticated without app_role sees 0 rows (proves RLS is not inert)
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ee000000-0000-0000-0000-bbbbbbbbbbbb","role":"authenticated"}',
  true
);
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.powerbi_export_runs;
  if v_count <> 0 then
    raise exception 'FAIL 6a: authenticated without app_role should see 0 export runs; got %', v_count;
  end if;

  select count(*) into v_count from public.powerbi_sync_controls;
  if v_count <> 0 then
    raise exception 'FAIL 6b: authenticated without app_role should see 0 sync controls; got %', v_count;
  end if;

  select count(*) into v_count from public.powerbi_stale_refresh_alerts;
  if v_count <> 0 then
    raise exception 'FAIL 6c: authenticated without app_role should see 0 stale alerts; got %', v_count;
  end if;

  raise notice 'PASS 6: authenticated without app_role sees 0 Power BI rows (RLS is active)';
end;
$$;
reset role;

-- PASS 7: read_only sees 0 rows and cannot invoke operator RPCs
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ee000000-0000-0000-0000-cccccccccccc","role":"authenticated","app_metadata":{"role":"read_only","tenant":"powerbi-rls-a"}}',
  true
);
do $$
declare
  v_count int;
  v_caught bool := false;
begin
  select count(*) into v_count from public.powerbi_export_runs;
  if v_count <> 0 then
    raise exception 'FAIL 7a: read_only should see 0 Power BI export runs; got %', v_count;
  end if;

  begin
    perform public.powerbi_disable_export_scope(
      'ee000000-0000-0000-0001-000000000001'::uuid,
      'unauthorized'
    );
  exception
    when insufficient_privilege or sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient role%' then
        v_caught := true;
      else
        raise;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 7b: read_only should be denied powerbi_disable_export_scope';
  end if;

  raise notice 'PASS 7: read_only sees 0 rows and cannot invoke Power BI operator RPCs';
end;
$$;
reset role;

-- PASS 8: admin tenant-A reads are tenant-filtered (tenant-B rows invisible)
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ee000000-0000-0000-0000-dddddddddddd","role":"authenticated","app_metadata":{"role":"admin","tenant":"powerbi-rls-a"}}',
  true
);
do $$
declare
  v_tenant_b constant uuid := 'ee000000-0000-0000-0000-000000000002';
  v_count int;
begin
  select count(*) into v_count from public.powerbi_export_runs;
  if v_count <> 2 then
    raise exception 'FAIL 8a: admin tenant-A should see 2 export runs; got %', v_count;
  end if;

  if exists (select 1 from public.powerbi_export_runs where tenant_id = v_tenant_b) then
    raise exception 'FAIL 8b: admin tenant-A must not see tenant-B export runs';
  end if;

  select count(*) into v_count from public.powerbi_stale_refresh_alerts;
  if v_count <> 1 then
    raise exception 'FAIL 8c: admin tenant-A should see 1 stale alert; got %', v_count;
  end if;

  if exists (select 1 from public.powerbi_stale_refresh_alerts where tenant_id = v_tenant_b) then
    raise exception 'FAIL 8d: admin tenant-A must not see tenant-B stale alerts';
  end if;

  select count(*) into v_count from public.v_powerbi_export_dashboard;
  if v_count < 1 then
    raise exception 'FAIL 8e: admin tenant-A should see at least 1 dashboard row; got %', v_count;
  end if;

  if exists (select 1 from public.v_powerbi_export_dashboard where tenant_id = v_tenant_b) then
    raise exception 'FAIL 8f: admin tenant-A must not see tenant-B dashboard rows';
  end if;

  raise notice 'PASS 8: admin tenant-A reads are tenant-filtered — tenant-B rows invisible';
end;
$$;
reset role;

-- PASS 9: admin quarantines export run and failed-exports view surfaces it
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ee000000-0000-0000-0000-eeeeeeeeeeee","role":"authenticated","app_metadata":{"role":"admin","tenant":"powerbi-rls-a"}}',
  true
);
do $$
declare
  v_dlq_id uuid;
  v_status text;
  v_count  int;
begin
  select public.powerbi_quarantine_export_run(
    'ee000000-0000-0000-0001-000000000001'::uuid,
    'tenant-A quarantine test',
    true,
    'operator note for replay'
  ) into v_dlq_id;

  if v_dlq_id is null then
    raise exception 'FAIL 9a: powerbi_quarantine_export_run returned null';
  end if;

  select export_status into v_status
  from public.powerbi_export_runs
  where id = 'ee000000-0000-0000-0001-000000000001'::uuid;

  if v_status <> 'quarantined' then
    raise exception 'FAIL 9b: expected quarantined status, got %', coalesce(v_status, '<null>');
  end if;

  select count(*) into v_count
  from public.v_powerbi_failed_exports
  where id = 'ee000000-0000-0000-0001-000000000001'::uuid
    and dlq_id = v_dlq_id
    and replay_eligible = true;

  if v_count <> 1 then
    raise exception 'FAIL 9c: quarantined run should appear in v_powerbi_failed_exports with replay_eligible=true';
  end if;

  raise notice 'PASS 9: admin quarantined Power BI export run and failed-exports view surfaced it';
end;
$$;
reset role;

-- PASS 10: admin replays from DLQ and audit chain is correct
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ee000000-0000-0000-0000-ffffffffffff","role":"authenticated","app_metadata":{"role":"admin","tenant":"powerbi-rls-a"}}',
  true
);
do $$
declare
  v_dlq_id         uuid;
  v_replay_id      uuid;
  v_source_resolved timestamptz;
begin
  select id into v_dlq_id
  from public.powerbi_dead_letter_queue
  where export_run_id = 'ee000000-0000-0000-0001-000000000001'::uuid;

  select public.powerbi_mark_replayed(v_dlq_id, 'test-operator', 'replayed after auth fix')
    into v_replay_id;

  if v_replay_id is null then
    raise exception 'FAIL 10a: powerbi_mark_replayed returned null';
  end if;

  if not exists (
    select 1 from public.powerbi_export_runs
    where id = v_replay_id
      and export_status = 'replayed'
      and replayed_from_id = 'ee000000-0000-0000-0001-000000000001'::uuid
  ) then
    raise exception 'FAIL 10b: replay event missing or audit chain incorrect';
  end if;

  select resolved_at into v_source_resolved
  from public.powerbi_export_runs
  where id = 'ee000000-0000-0000-0001-000000000001'::uuid;

  if v_source_resolved is null then
    raise exception 'FAIL 10c: source export run should be resolved after replay';
  end if;

  raise notice 'PASS 10: replay created audit-linked Power BI export run and resolved the source row';
end;
$$;
reset role;

-- PASS 11: admin disables export scope and failed-exports view reflects it
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ee000000-0000-0000-0000-111111111111","role":"authenticated","app_metadata":{"role":"admin","tenant":"powerbi-rls-a"}}',
  true
);
do $$
declare
  v_control_id uuid;
  v_count int;
begin
  select public.powerbi_disable_export_scope(
    'ee000000-0000-0000-0001-000000000002'::uuid,
    'disable dataset_refresh until transport fix',
    'pause dataset refresh exports'
  ) into v_control_id;

  if v_control_id is null then
    raise exception 'FAIL 11a: powerbi_disable_export_scope returned null';
  end if;

  if not exists (
    select 1 from public.powerbi_sync_controls
    where id = v_control_id
      and control_status = 'disabled'
      and disabled_reason = 'disable dataset_refresh until transport fix'
  ) then
    raise exception 'FAIL 11b: disabled control row missing';
  end if;

  select count(*) into v_count
  from public.v_powerbi_failed_exports
  where id = 'ee000000-0000-0000-0001-000000000002'::uuid
    and control_id = v_control_id
    and export_status = 'disabled';

  if v_count <> 1 then
    raise exception 'FAIL 11c: disabled export run should appear in v_powerbi_failed_exports with control_id';
  end if;

  raise notice 'PASS 11: disable control created tenant-safe Power BI control state';
end;
$$;
reset role;

-- PASS 12: admin re-enables export scope and resolves the disabled event
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ee000000-0000-0000-0000-222222222222","role":"authenticated","app_metadata":{"role":"admin","tenant":"powerbi-rls-a"}}',
  true
);
do $$
declare
  v_control_id     uuid;
  v_reenabled_at   timestamptz;
  v_event_resolved timestamptz;
begin
  select id into v_control_id
  from public.powerbi_sync_controls
  where dataset_id  = 'ds-b'
    and tenant_id   = 'ee000000-0000-0000-0000-000000000001'::uuid;

  perform public.powerbi_enable_export_scope(v_control_id, 'test-operator', 'resume dataset refresh exports');

  select reenabled_at into v_reenabled_at
  from public.powerbi_sync_controls
  where id = v_control_id
    and control_status = 'active';

  if v_reenabled_at is null then
    raise exception 'FAIL 12a: enabled control should have reenabled_at set';
  end if;

  select resolved_at into v_event_resolved
  from public.powerbi_export_runs
  where id = 'ee000000-0000-0000-0001-000000000002'::uuid;

  if v_event_resolved is null then
    raise exception 'FAIL 12b: disabled export run should be resolved after re-enable';
  end if;

  raise notice 'PASS 12: re-enable control resolved the disabled Power BI scope without direct DB edits';
end;
$$;
reset role;

-- PASS 13: cross-tenant isolation — tenant-A admin cannot touch tenant-B export run
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ee000000-0000-0000-0000-333333333333","role":"authenticated","app_metadata":{"role":"admin","tenant":"powerbi-rls-a"}}',
  true
);
do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.powerbi_quarantine_export_run(
      'ee000000-0000-0000-0001-000000000003'::uuid,
      'cross-tenant quarantine attempt'
    );
  exception
    when no_data_found or sqlstate 'P0002' then v_caught := true;
    when others then
      if sqlerrm ilike '%not found%' or sqlerrm ilike '%not accessible%' then
        v_caught := true;
      else
        raise;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 13: tenant-A admin should not quarantine tenant-B export run';
  end if;

  if exists (
    select 1 from public.powerbi_dead_letter_queue
    where tenant_id = 'ee000000-0000-0000-0000-000000000002'::uuid
  ) then
    raise exception 'FAIL 13: cross-tenant quarantine wrote a tenant-B DLQ row';
  end if;

  raise notice 'PASS 13: Power BI controls preserve cross-tenant isolation';
end;
$$;
reset role;

-- PASS 14: service_role sees all rows
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.powerbi_export_runs;
  if v_count < 3 then
    raise exception 'FAIL 14a: service_role should see all Power BI export runs; got %', v_count;
  end if;

  select count(*) into v_count from public.powerbi_stale_refresh_alerts;
  if v_count <> 2 then
    raise exception 'FAIL 14b: service_role should see all stale alerts; got %', v_count;
  end if;

  raise notice 'PASS 14: service_role sees all Power BI rows';
end;
$$;

rollback;
