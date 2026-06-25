-- RLS / role-gating behavioral tests for coupa_observability_reconciliation
-- (migration 20260611113000_coupa_observability_reconciliation.sql).

begin;

do $$
declare
  v_tenant_a constant uuid := 'bb000000-0000-0000-0000-000000000001';
  v_tenant_b constant uuid := 'bb000000-0000-0000-0000-000000000002';
  v_event_a  constant uuid := 'bb000000-0000-0000-0001-000000000001';
  v_event_b  constant uuid := 'bb000000-0000-0000-0001-000000000002';
  v_event_c  constant uuid := 'bb000000-0000-0000-0001-000000000003';
begin
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a, 'coupa-rls-a', 'Coupa RLS Test Tenant A'),
    (v_tenant_b, 'coupa-rls-b', 'Coupa RLS Test Tenant B')
  on conflict (id) do nothing;

  insert into public.coupa_sync_events (
    id, tenant_id, provider_name, sync_run_id, object_type, object_key,
    internal_record_id, coupa_record_id, direction, sync_status,
    failure_class, failure_code, failure_message, retry_count,
    source_system, source_event_id, idempotency_key
  ) values
    (
      v_event_a, v_tenant_a, 'coupa', 'run-a', 'requisition', 'REQ-100',
      'internal-req-100', 'coupa-req-100', 'outbound', 'retrying',
      'auth', 'OAUTH_401', 'token expired', 1,
      'coupa', 'src-coupa-001', 'idem-coupa-001'
    ),
    (
      v_event_b, v_tenant_b, 'coupa', 'run-b', 'invoice', 'INV-200',
      'internal-inv-200', 'coupa-inv-200', 'outbound', 'retrying',
      'timeout', 'CONN_TIMEOUT', 'connection timed out', 1,
      'coupa', 'src-coupa-002', 'idem-coupa-002'
    ),
    (
      v_event_c, v_tenant_a, 'coupa', 'run-c', 'supplier', 'SUP-300',
      'internal-sup-300', 'coupa-sup-300', 'outbound', 'retrying',
      'mapping', 'FIELD_MISSING', 'missing supplier address', 2,
      'coupa', 'src-coupa-003', 'idem-coupa-003'
    )
  on conflict (id) do update
    set sync_status   = excluded.sync_status,
        failure_class = excluded.failure_class,
        resolved_at   = null;

  insert into public.coupa_reconciliation_results (
    tenant_id, provider_name, object_type, object_key,
    internal_record_id, coupa_record_id, drift_status,
    internal_digest, coupa_digest, compared_fields, diagnostic_summary,
    last_sync_event_id
  ) values
    (
      v_tenant_a, 'coupa', 'supplier', 'SUP-300',
      'internal-sup-300', 'coupa-sup-300', 'field_mismatch',
      'digest-a1', 'digest-a2', '["address","payment_terms"]'::jsonb,
      'supplier master data drifted after address update', v_event_c
    ),
    (
      v_tenant_a, 'coupa', 'purchase_order', 'PO-400',
      'internal-po-400', null, 'missing_in_coupa',
      'digest-po-1', null, '["status"]'::jsonb,
      'purchase order exists internally but is absent in Coupa', v_event_a
    ),
    (
      v_tenant_a, 'coupa', 'requisition', 'REQ-100',
      'internal-req-100', 'coupa-req-100', 'in_sync',
      'digest-req-1', 'digest-req-1', '["status"]'::jsonb,
      'healthy', v_event_a
    ),
    (
      v_tenant_b, 'coupa', 'invoice', 'INV-200',
      'internal-inv-200', 'coupa-inv-200', 'missing_in_wynne',
      null, 'digest-inv-b', '["invoice_total"]'::jsonb,
      'invoice exists in Coupa but not in Wynne', v_event_b
    )
  on conflict (tenant_id, provider_name, object_type, object_key) do update
    set drift_status = excluded.drift_status,
        checked_at = now();
end;
$$;

do $$
declare
  v_has_invoker bool;
  v_view text;
begin
  foreach v_view in array array[
    'v_coupa_sync_dashboard',
    'v_coupa_failed_sync_work',
    'v_coupa_reconciliation_drift',
    'v_coupa_reconciliation_summary'
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

  raise notice 'PASS 1: all Coupa views declare security_invoker = true';
end;
$$;

set local role anon;
do $$
declare
  v_dummy int;
  v_caught bool;
  v_rel text;
begin
  foreach v_rel in array array[
    'coupa_sync_events',
    'coupa_dead_letter_queue',
    'coupa_sync_controls',
    'coupa_reconciliation_results'
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

  raise notice 'PASS 2: anon denied SELECT on Coupa base tables';
end;
$$;
reset role;

set local role anon;
do $$
declare
  v_dummy int;
  v_caught bool;
  v_rel text;
begin
  foreach v_rel in array array[
    'v_coupa_sync_dashboard',
    'v_coupa_failed_sync_work',
    'v_coupa_reconciliation_drift',
    'v_coupa_reconciliation_summary'
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

  raise notice 'PASS 3: anon denied SELECT on Coupa views';
end;
$$;
reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
declare
  v_caught bool;
begin
  v_caught := false;
  begin
    perform public.coupa_quarantine_sync_event(gen_random_uuid(), 'test');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4a: anon should be denied coupa_quarantine_sync_event';
  end if;

  v_caught := false;
  begin
    perform public.coupa_mark_replayed(gen_random_uuid(), 'anon');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4b: anon should be denied coupa_mark_replayed';
  end if;

  v_caught := false;
  begin
    perform public.coupa_disable_sync_scope(gen_random_uuid(), 'anon');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4c: anon should be denied coupa_disable_sync_scope';
  end if;

  v_caught := false;
  begin
    perform public.coupa_enable_sync_scope(gen_random_uuid(), 'anon');
  exception when insufficient_privilege or sqlstate '42501' then v_caught := true; end;
  if not v_caught then
    raise exception 'FAIL 4d: anon should be denied coupa_enable_sync_scope';
  end if;

  raise notice 'PASS 4: anon denied EXECUTE on Coupa operator RPCs';
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbbb","role":"authenticated"}',
  true
);
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.coupa_sync_events;
  if v_count <> 0 then
    raise exception 'FAIL 5a: authenticated without app_role should see 0 events; got %', v_count;
  end if;

  select count(*) into v_count from public.coupa_sync_controls;
  if v_count <> 0 then
    raise exception 'FAIL 5b: authenticated without app_role should see 0 controls; got %', v_count;
  end if;

  select count(*) into v_count from public.coupa_reconciliation_results;
  if v_count <> 0 then
    raise exception 'FAIL 5c: authenticated without app_role should see 0 reconciliation rows; got %', v_count;
  end if;

  raise notice 'PASS 5: authenticated without app_role sees 0 Coupa rows';
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbbc","role":"authenticated","app_metadata":{"role":"read_only","tenant":"coupa-rls-a"}}',
  true
);
do $$
declare
  v_count int;
  v_caught bool := false;
begin
  select count(*) into v_count from public.coupa_sync_events;
  if v_count <> 0 then
    raise exception 'FAIL 6a: read_only should see 0 events; got %', v_count;
  end if;

  begin
    perform public.coupa_disable_sync_scope('bb000000-0000-0000-0001-000000000001'::uuid, 'unauthorized');
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
    raise exception 'FAIL 6b: read_only should be denied coupa_disable_sync_scope';
  end if;

  raise notice 'PASS 6: read_only sees 0 rows and cannot invoke Coupa operator controls';
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbbd","role":"authenticated","app_metadata":{"role":"admin","tenant":"coupa-rls-a"}}',
  true
);
do $$
declare
  v_tenant_b constant uuid := 'bb000000-0000-0000-0000-000000000002';
  v_count int;
begin
  select count(*) into v_count from public.coupa_sync_events;
  if v_count <> 2 then
    raise exception 'FAIL 7a: admin tenant-A should see 2 Coupa events; got %', v_count;
  end if;

  if exists (select 1 from public.coupa_sync_events where tenant_id = v_tenant_b) then
    raise exception 'FAIL 7b: admin tenant-A must not see tenant-B events';
  end if;

  select count(*) into v_count from public.v_coupa_reconciliation_drift;
  if v_count <> 2 then
    raise exception 'FAIL 7c: admin tenant-A should see 2 drift rows; got %', v_count;
  end if;

  if exists (select 1 from public.v_coupa_reconciliation_drift where tenant_id = v_tenant_b) then
    raise exception 'FAIL 7d: admin tenant-A must not see tenant-B drift rows';
  end if;

  raise notice 'PASS 7: admin tenant-A sees only tenant-A Coupa rows';
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbbe","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"coupa-rls-a"}}',
  true
);
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.v_coupa_sync_dashboard;
  if v_count <> 2 then
    raise exception 'FAIL 8a: branch_manager tenant-A should see 2 dashboard rows; got %', v_count;
  end if;

  select count(*) into v_count from public.v_coupa_failed_sync_work;
  if v_count <> 2 then
    raise exception 'FAIL 8b: branch_manager tenant-A should see 2 failed-work rows; got %', v_count;
  end if;

  raise notice 'PASS 8: branch_manager tenant-A sees tenant-scoped Coupa dashboard and failed work';
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbbf","role":"authenticated","app_metadata":{"role":"admin","tenant":"coupa-rls-a"}}',
  true
);
do $$
declare
  v_dlq_id uuid;
  v_status text;
  v_count int;
begin
  select public.coupa_quarantine_sync_event(
    'bb000000-0000-0000-0001-000000000001'::uuid,
    'tenant-A quarantine test',
    true,
    'operator note'
  ) into v_dlq_id;

  if v_dlq_id is null then
    raise exception 'FAIL 9a: coupa_quarantine_sync_event returned null';
  end if;

  select sync_status into v_status
  from public.coupa_sync_events
  where id = 'bb000000-0000-0000-0001-000000000001'::uuid;

  if v_status <> 'quarantined' then
    raise exception 'FAIL 9b: expected quarantined status, got %', coalesce(v_status, '<null>');
  end if;

  select count(*) into v_count
  from public.v_coupa_failed_sync_work
  where id = 'bb000000-0000-0000-0001-000000000001'::uuid
    and dlq_id = v_dlq_id
    and replay_eligible = true;

  if v_count <> 1 then
    raise exception 'FAIL 9c: quarantined event should appear in failed-work view with replay=true';
  end if;

  raise notice 'PASS 9: admin quarantined Coupa sync event and failed-work view surfaced it';
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbc0","role":"authenticated","app_metadata":{"role":"admin","tenant":"coupa-rls-a"}}',
  true
);
do $$
declare
  v_dlq_id uuid;
  v_replay_id uuid;
  v_source_resolved timestamptz;
begin
  select id into v_dlq_id
  from public.coupa_dead_letter_queue
  where sync_event_id = 'bb000000-0000-0000-0001-000000000001'::uuid;

  select public.coupa_mark_replayed(v_dlq_id, 'test-operator', 'replayed after auth fix')
    into v_replay_id;

  if v_replay_id is null then
    raise exception 'FAIL 10a: coupa_mark_replayed returned null';
  end if;

  if not exists (
    select 1 from public.coupa_sync_events
    where id = v_replay_id
      and sync_status = 'replayed'
      and replayed_from_id = 'bb000000-0000-0000-0001-000000000001'::uuid
  ) then
    raise exception 'FAIL 10b: replay event missing or audit chain incorrect';
  end if;

  select resolved_at into v_source_resolved
  from public.coupa_sync_events
  where id = 'bb000000-0000-0000-0001-000000000001'::uuid;

  if v_source_resolved is null then
    raise exception 'FAIL 10c: source event should be resolved after replay';
  end if;

  raise notice 'PASS 10: replay created audit-linked Coupa sync event and resolved the source row';
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbc1","role":"authenticated","app_metadata":{"role":"admin","tenant":"coupa-rls-a"}}',
  true
);
do $$
declare
  v_control_id uuid;
  v_count int;
begin
  select public.coupa_disable_sync_scope(
    'bb000000-0000-0000-0001-000000000003'::uuid,
    'disable supplier until mapping fix',
    'pause supplier syncs'
  ) into v_control_id;

  if v_control_id is null then
    raise exception 'FAIL 11a: coupa_disable_sync_scope returned null';
  end if;

  if not exists (
    select 1 from public.coupa_sync_controls
    where id = v_control_id
      and control_status = 'disabled'
      and disabled_reason = 'disable supplier until mapping fix'
  ) then
    raise exception 'FAIL 11b: disabled control row missing';
  end if;

  select count(*) into v_count
  from public.v_coupa_failed_sync_work
  where id = 'bb000000-0000-0000-0001-000000000003'::uuid
    and control_id = v_control_id
    and sync_status = 'disabled';

  if v_count <> 1 then
    raise exception 'FAIL 11c: disabled event should appear in failed-work view';
  end if;

  raise notice 'PASS 11: disable control created tenant-safe Coupa control state';
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbc2","role":"authenticated","app_metadata":{"role":"admin","tenant":"coupa-rls-a"}}',
  true
);
do $$
declare
  v_control_id uuid;
  v_reenabled_at timestamptz;
  v_event_resolved timestamptz;
begin
  select id into v_control_id
  from public.coupa_sync_controls
  where object_key = 'SUP-300';

  perform public.coupa_enable_sync_scope(v_control_id, 'test-operator', 'resume supplier syncs');

  select reenabled_at into v_reenabled_at
  from public.coupa_sync_controls
  where id = v_control_id
    and control_status = 'active';

  if v_reenabled_at is null then
    raise exception 'FAIL 12a: enabled control should have reenabled_at set';
  end if;

  select resolved_at into v_event_resolved
  from public.coupa_sync_events
  where id = 'bb000000-0000-0000-0001-000000000003'::uuid;

  if v_event_resolved is null then
    raise exception 'FAIL 12b: disabled event should be resolved after re-enable';
  end if;

  raise notice 'PASS 12: re-enable control resolved the disabled Coupa scope without direct DB edits';
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-bbbbbbbbbbc3","role":"authenticated","app_metadata":{"role":"admin","tenant":"coupa-rls-a"}}',
  true
);
do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.coupa_disable_sync_scope(
      'bb000000-0000-0000-0001-000000000002'::uuid,
      'cross-tenant disable'
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
    select 1 from public.coupa_sync_controls
    where tenant_id = 'bb000000-0000-0000-0000-000000000002'::uuid
  ) then
    raise exception 'FAIL 13: cross-tenant disable wrote a tenant-B control row';
  end if;

  raise notice 'PASS 13: Coupa controls preserve cross-tenant isolation';
end;
$$;
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.coupa_sync_events;
  if v_count < 4 then
    raise exception 'FAIL 14a: service_role should see all Coupa events; got %', v_count;
  end if;

  select count(*) into v_count from public.coupa_reconciliation_results;
  if v_count <> 4 then
    raise exception 'FAIL 14b: service_role should see all reconciliation rows; got %', v_count;
  end if;

  raise notice 'PASS 14: service_role sees all Coupa rows';
end;
$$;

rollback;
