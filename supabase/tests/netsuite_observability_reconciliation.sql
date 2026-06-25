-- RLS / role-gating behavioral tests for netsuite_observability_reconciliation
-- (migration 20260612200000_netsuite_observability_reconciliation.sql).

begin;

do $$
declare
  v_tenant_a constant uuid := 'dd000000-0000-0000-0000-000000000001';
  v_tenant_b constant uuid := 'dd000000-0000-0000-0000-000000000002';
  v_event_a1 constant uuid := 'dd000000-0000-0000-0001-000000000001';
  v_event_a2 constant uuid := 'dd000000-0000-0000-0001-000000000002';
  v_event_b1 constant uuid := 'dd000000-0000-0000-0001-000000000003';
begin
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a, 'netsuite-rls-a', 'NetSuite RLS Test Tenant A'),
    (v_tenant_b, 'netsuite-rls-b', 'NetSuite RLS Test Tenant B')
  on conflict (id) do nothing;

  insert into public.netsuite_sync_events (
    id, tenant_id, provider_name, sync_run_id, object_type, object_key,
    internal_record_id, netsuite_record_id, direction, sync_status,
    failure_class, failure_code, failure_message, retry_count, max_retries,
    source_system, source_event_id, idempotency_key
  ) values
    (
      v_event_a1, v_tenant_a, 'netsuite', 'run-a1', 'customer', 'CUST-100',
      'internal-cust-100', 'ns-cust-100', 'outbound', 'retrying',
      'auth', 'OAUTH_401', 'token expired', 1, 3,
      'netsuite', 'src-ns-a-001', 'idem-ns-a-001'
    ),
    (
      v_event_a2, v_tenant_a, 'netsuite', 'run-a2', 'invoice', 'INV-200',
      'internal-inv-200', 'ns-inv-200', 'outbound', 'retrying',
      'transport', 'CONN_TIMEOUT', 'connection timed out', 1, 3,
      'netsuite', 'src-ns-a-002', 'idem-ns-a-002'
    ),
    (
      v_event_b1, v_tenant_b, 'netsuite', 'run-b1', 'journal_entry', 'JE-300',
      'internal-je-300', 'ns-je-300', 'outbound', 'retrying',
      'rate_limit', 'HTTP_429', 'rate limit exceeded', 1, 3,
      'netsuite', 'src-ns-b-001', 'idem-ns-b-001'
    )
  on conflict (id) do update
    set sync_status   = excluded.sync_status,
        failure_class = excluded.failure_class,
        resolved_at   = null;

  insert into public.netsuite_reconciliation_results (
    tenant_id, provider_name, object_type, object_key,
    internal_record_id, netsuite_record_id, drift_status,
    internal_digest, netsuite_digest, compared_fields, diagnostic_summary,
    last_sync_event_id
  ) values
    (
      v_tenant_a, 'netsuite', 'customer', 'CUST-100',
      'internal-cust-100', 'ns-cust-100', 'drifted',
      'digest-c1', 'digest-c2', '["credit_limit","terms"]'::jsonb,
      'customer credit-limit drift detected', v_event_a1
    ),
    (
      v_tenant_a, 'netsuite', 'invoice', 'INV-200',
      'internal-inv-200', null, 'missing_netsuite',
      'digest-i1', null, '["status"]'::jsonb,
      'invoice recorded internally but absent in NetSuite', v_event_a2
    ),
    (
      v_tenant_b, 'netsuite', 'journal_entry', 'JE-300',
      'internal-je-300', 'ns-je-300', 'drifted',
      'digest-j1', 'digest-j2', '["amount","posting_period"]'::jsonb,
      'journal-entry amount drifted from NetSuite', v_event_b1
    )
  on conflict (tenant_id, provider_name, object_type, object_key) do update
    set drift_status = excluded.drift_status,
        checked_at   = now();
end;
$$;

-- PASS 1: all NetSuite views declare security_invoker = true
do $$
declare
  v_has_invoker bool;
  v_view text;
begin
  foreach v_view in array array[
    'v_netsuite_sync_dashboard',
    'v_netsuite_failed_sync_work',
    'v_netsuite_reconciliation_drift',
    'v_netsuite_reconciliation_summary'
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

  raise notice 'PASS 1: all NetSuite views declare security_invoker = true';
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
    'netsuite_sync_events',
    'netsuite_dead_letter_queue',
    'netsuite_sync_controls',
    'netsuite_reconciliation_results'
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

  raise notice 'PASS 2: anon denied SELECT on NetSuite base tables';
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
    'v_netsuite_sync_dashboard',
    'v_netsuite_failed_sync_work',
    'v_netsuite_reconciliation_drift',
    'v_netsuite_reconciliation_summary'
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

  raise notice 'PASS 3: anon denied SELECT on NetSuite views';
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
    perform public.netsuite_quarantine_sync_event(gen_random_uuid(), 'test');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4a: anon should be denied netsuite_quarantine_sync_event';
  end if;

  v_caught := false;
  begin
    perform public.netsuite_mark_replayed(gen_random_uuid(), 'anon');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4b: anon should be denied netsuite_mark_replayed';
  end if;

  v_caught := false;
  begin
    perform public.netsuite_disable_sync_scope(gen_random_uuid(), 'anon');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4c: anon should be denied netsuite_disable_sync_scope';
  end if;

  v_caught := false;
  begin
    perform public.netsuite_enable_sync_scope(gen_random_uuid());
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4d: anon should be denied netsuite_enable_sync_scope';
  end if;

  raise notice 'PASS 4: anon denied EXECUTE on NetSuite operator RPCs';
end;
$$;
reset role;

-- PASS 5: authenticated without app_role sees 0 rows
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-dddddddddddd","role":"authenticated"}',
  true
);
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.netsuite_sync_events;
  if v_count <> 0 then
    raise exception 'FAIL 5a: authenticated without app_role should see 0 events; got %', v_count;
  end if;

  select count(*) into v_count from public.netsuite_sync_controls;
  if v_count <> 0 then
    raise exception 'FAIL 5b: authenticated without app_role should see 0 controls; got %', v_count;
  end if;

  select count(*) into v_count from public.netsuite_reconciliation_results;
  if v_count <> 0 then
    raise exception 'FAIL 5c: authenticated without app_role should see 0 reconciliation rows; got %', v_count;
  end if;

  raise notice 'PASS 5: authenticated without app_role sees 0 NetSuite rows';
end;
$$;
reset role;

-- PASS 6: read_only sees 0 rows and cannot invoke operator controls
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-ddddddddddd1","role":"authenticated","app_metadata":{"role":"read_only","tenant":"netsuite-rls-a"}}',
  true
);
do $$
declare
  v_count int;
  v_caught bool := false;
begin
  select count(*) into v_count from public.netsuite_sync_events;
  if v_count <> 0 then
    raise exception 'FAIL 6a: read_only should see 0 NetSuite events; got %', v_count;
  end if;

  begin
    perform public.netsuite_disable_sync_scope(
      'dd000000-0000-0000-0001-000000000001'::uuid,
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
    raise exception 'FAIL 6b: read_only should be denied netsuite_disable_sync_scope';
  end if;

  raise notice 'PASS 6: read_only sees 0 rows and cannot invoke NetSuite operator controls';
end;
$$;
reset role;

-- PASS 7: admin tenant-A sees only tenant-A rows
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-ddddddddddd2","role":"authenticated","app_metadata":{"role":"admin","tenant":"netsuite-rls-a"}}',
  true
);
do $$
declare
  v_tenant_b constant uuid := 'dd000000-0000-0000-0000-000000000002';
  v_count int;
begin
  select count(*) into v_count from public.netsuite_sync_events;
  if v_count <> 2 then
    raise exception 'FAIL 7a: admin tenant-A should see 2 NetSuite events; got %', v_count;
  end if;

  if exists (select 1 from public.netsuite_sync_events where tenant_id = v_tenant_b) then
    raise exception 'FAIL 7b: admin tenant-A must not see tenant-B events';
  end if;

  select count(*) into v_count from public.v_netsuite_reconciliation_drift;
  if v_count <> 2 then
    raise exception 'FAIL 7c: admin tenant-A should see 2 drift rows; got %', v_count;
  end if;

  if exists (select 1 from public.v_netsuite_reconciliation_drift where tenant_id = v_tenant_b) then
    raise exception 'FAIL 7d: admin tenant-A must not see tenant-B drift rows';
  end if;

  raise notice 'PASS 7: admin tenant-A sees only tenant-A NetSuite rows';
end;
$$;
reset role;

-- PASS 8: branch_manager tenant-A sees tenant-scoped dashboard and failed work
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-ddddddddddd3","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"netsuite-rls-a"}}',
  true
);
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.v_netsuite_sync_dashboard;
  if v_count <> 2 then
    raise exception 'FAIL 8a: branch_manager tenant-A should see 2 dashboard rows; got %', v_count;
  end if;

  select count(*) into v_count from public.v_netsuite_failed_sync_work;
  if v_count <> 2 then
    raise exception 'FAIL 8b: branch_manager tenant-A should see 2 failed-work rows; got %', v_count;
  end if;

  raise notice 'PASS 8: branch_manager tenant-A sees tenant-scoped NetSuite dashboard and failed work';
end;
$$;
reset role;

-- PASS 9: admin quarantines a sync event and failed-work view surfaces it
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-ddddddddddd4","role":"authenticated","app_metadata":{"role":"admin","tenant":"netsuite-rls-a"}}',
  true
);
do $$
declare
  v_dlq_id uuid;
  v_status text;
  v_count int;
begin
  select public.netsuite_quarantine_sync_event(
    'dd000000-0000-0000-0001-000000000001'::uuid,
    'tenant-A quarantine test',
    true,
    'operator note for replay'
  ) into v_dlq_id;

  if v_dlq_id is null then
    raise exception 'FAIL 9a: netsuite_quarantine_sync_event returned null';
  end if;

  select sync_status into v_status
  from public.netsuite_sync_events
  where id = 'dd000000-0000-0000-0001-000000000001'::uuid;

  if v_status <> 'quarantined' then
    raise exception 'FAIL 9b: expected quarantined status, got %', coalesce(v_status, '<null>');
  end if;

  select count(*) into v_count
  from public.v_netsuite_failed_sync_work
  where id = 'dd000000-0000-0000-0001-000000000001'::uuid
    and dlq_id = v_dlq_id
    and replay_eligible = true;

  if v_count <> 1 then
    raise exception 'FAIL 9c: quarantined event should appear in failed-work view with replay_eligible=true';
  end if;

  raise notice 'PASS 9: admin quarantined NetSuite sync event and failed-work view surfaced it';
end;
$$;
reset role;

-- PASS 10: admin replays from DLQ and audit chain is correct
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-ddddddddddd5","role":"authenticated","app_metadata":{"role":"admin","tenant":"netsuite-rls-a"}}',
  true
);
do $$
declare
  v_dlq_id uuid;
  v_replay_id uuid;
  v_source_resolved timestamptz;
begin
  select id into v_dlq_id
  from public.netsuite_dead_letter_queue
  where sync_event_id = 'dd000000-0000-0000-0001-000000000001'::uuid;

  select public.netsuite_mark_replayed(v_dlq_id, 'test-operator', 'replayed after auth fix')
    into v_replay_id;

  if v_replay_id is null then
    raise exception 'FAIL 10a: netsuite_mark_replayed returned null';
  end if;

  if not exists (
    select 1 from public.netsuite_sync_events
    where id = v_replay_id
      and sync_status = 'replayed'
      and replayed_from_id = 'dd000000-0000-0000-0001-000000000001'::uuid
  ) then
    raise exception 'FAIL 10b: replay event missing or audit chain incorrect';
  end if;

  select resolved_at into v_source_resolved
  from public.netsuite_sync_events
  where id = 'dd000000-0000-0000-0001-000000000001'::uuid;

  if v_source_resolved is null then
    raise exception 'FAIL 10c: source event should be resolved after replay';
  end if;

  raise notice 'PASS 10: replay created audit-linked NetSuite sync event and resolved the source row';
end;
$$;
reset role;

-- PASS 11: admin disables a sync scope and failed-work view reflects it
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-ddddddddddd6","role":"authenticated","app_metadata":{"role":"admin","tenant":"netsuite-rls-a"}}',
  true
);
do $$
declare
  v_control_id uuid;
  v_count int;
begin
  select public.netsuite_disable_sync_scope(
    'dd000000-0000-0000-0001-000000000002'::uuid,
    'disable invoice until transport fix',
    'pause invoice syncs'
  ) into v_control_id;

  if v_control_id is null then
    raise exception 'FAIL 11a: netsuite_disable_sync_scope returned null';
  end if;

  if not exists (
    select 1 from public.netsuite_sync_controls
    where id = v_control_id
      and control_status = 'disabled'
      and disabled_reason = 'disable invoice until transport fix'
  ) then
    raise exception 'FAIL 11b: disabled control row missing';
  end if;

  select count(*) into v_count
  from public.v_netsuite_failed_sync_work
  where id = 'dd000000-0000-0000-0001-000000000002'::uuid
    and control_id = v_control_id
    and sync_status = 'disabled';

  if v_count <> 1 then
    raise exception 'FAIL 11c: disabled event should appear in failed-work view with control_id';
  end if;

  raise notice 'PASS 11: disable control created tenant-safe NetSuite control state';
end;
$$;
reset role;

-- PASS 12: admin re-enables a sync scope and resolves the disabled event
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-ddddddddddd7","role":"authenticated","app_metadata":{"role":"admin","tenant":"netsuite-rls-a"}}',
  true
);
do $$
declare
  v_control_id uuid;
  v_reenabled_at timestamptz;
  v_event_resolved timestamptz;
begin
  select id into v_control_id
  from public.netsuite_sync_controls
  where object_key = 'INV-200'
    and tenant_id = 'dd000000-0000-0000-0000-000000000001'::uuid;

  perform public.netsuite_enable_sync_scope(v_control_id, 'test-operator', 'resume invoice syncs');

  select reenabled_at into v_reenabled_at
  from public.netsuite_sync_controls
  where id = v_control_id
    and control_status = 'active';

  if v_reenabled_at is null then
    raise exception 'FAIL 12a: enabled control should have reenabled_at set';
  end if;

  select resolved_at into v_event_resolved
  from public.netsuite_sync_events
  where id = 'dd000000-0000-0000-0001-000000000002'::uuid;

  if v_event_resolved is null then
    raise exception 'FAIL 12b: disabled event should be resolved after re-enable';
  end if;

  raise notice 'PASS 12: re-enable control resolved the disabled NetSuite scope without direct DB edits';
end;
$$;
reset role;

-- PASS 13: cross-tenant isolation — tenant-A admin cannot touch tenant-B scope
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-ddddddddddd8","role":"authenticated","app_metadata":{"role":"admin","tenant":"netsuite-rls-a"}}',
  true
);
do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.netsuite_disable_sync_scope(
      'dd000000-0000-0000-0001-000000000003'::uuid,
      'cross-tenant disable attempt'
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
    raise exception 'FAIL 13: tenant-A admin should not disable tenant-B scope';
  end if;

  if exists (
    select 1 from public.netsuite_sync_controls
    where tenant_id = 'dd000000-0000-0000-0000-000000000002'::uuid
  ) then
    raise exception 'FAIL 13: cross-tenant disable wrote a tenant-B control row';
  end if;

  raise notice 'PASS 13: NetSuite controls preserve cross-tenant isolation';
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
  select count(*) into v_count from public.netsuite_sync_events;
  if v_count < 3 then
    raise exception 'FAIL 14a: service_role should see all NetSuite events; got %', v_count;
  end if;

  select count(*) into v_count from public.netsuite_reconciliation_results;
  if v_count <> 3 then
    raise exception 'FAIL 14b: service_role should see all reconciliation rows; got %', v_count;
  end if;

  raise notice 'PASS 14: service_role sees all NetSuite rows';
end;
$$;

rollback;
