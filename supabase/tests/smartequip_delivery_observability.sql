-- RLS / role-gating behavioral tests for smartequip_delivery_observability
-- (migration 20260611203000_smartequip_delivery_observability.sql).
--
-- Verifies:
--   1.  Views declare security_invoker = true
--   2.  anon denied SELECT on both base tables
--   3.  anon denied SELECT on all three views
--   4.  anon denied EXECUTE on all operator RPCs
--   5.  authenticated (no app_role) sees 0 rows — RLS gates on app_role claim
--   6.  authenticated (read_only) sees 0 rows — role not in (admin, branch_manager)
--   7.  authenticated (admin, tenant-A) sees only tenant-A rows; tenant-B excluded
--   8.  authenticated (branch_manager, tenant-A) sees only tenant-A rows
--   9.  smartequip_quarantine_exchange: admin (tenant-A) happy path
--  10.  smartequip_quarantine_exchange: read_only denied (insufficient_privilege)
--  11.  smartequip_quarantine_exchange: admin (tenant-A) denied for tenant-B event (cross-tenant)
--  12.  smartequip_mark_replayed: admin (tenant-A) happy path
--  13.  smartequip_mark_replayed: read_only denied (insufficient_privilege)
--  14.  smartequip_disable_exchange_retry: admin (tenant-A) disables retry/quarantines
--  15.  service_role policy is effective: sees rows from all tenants
--
-- Pattern: multiple DO blocks within one transaction.  SET LOCAL ROLE +
-- set_config('request.jwt.claims', ...) simulate the PostgREST JWT contexts
-- used in production without persisting any data.

begin;

-- ── Fixture setup (superuser context) ──────────────────────────────────────
-- Two tenants and one delivery event per tenant.  Fixed UUIDs so subsequent
-- blocks can reference them as constants without cross-block variable sharing.
do $$
declare
  v_tenant_a constant uuid := 'aa000000-0000-0000-0000-000000000001';
  v_tenant_b constant uuid := 'aa000000-0000-0000-0000-000000000002';
  v_event_a  constant uuid := 'aa000000-0000-0000-0001-000000000001';
  v_event_b  constant uuid := 'aa000000-0000-0000-0001-000000000002';
begin
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a, 'smartequip-rls-a', 'SmartEquip RLS Test Tenant A'),
    (v_tenant_b, 'smartequip-rls-b', 'SmartEquip RLS Test Tenant B')
  on conflict (id) do nothing;

  insert into public.smartequip_delivery_events (
    id, tenant_id, exchange_id, flow_name, direction,
    delivery_status, failure_class, failure_code, failure_message,
    retry_count, source_system, source_event_id, idempotency_key
  ) values
    (
      v_event_a, v_tenant_a, 'exchange-rls-a', 'order-sync', 'outbound',
      'retrying', 'auth', 'OAUTH_401', 'token expired',
      1, 'smartequip', 'src-rls-001', 'idem-rls-001'
    ),
    (
      v_event_b, v_tenant_b, 'exchange-rls-b', 'order-sync', 'outbound',
      'retrying', 'timeout', 'CONN_TIMEOUT', 'connection timed out',
      1, 'smartequip', 'src-rls-002', 'idem-rls-002'
    )
  on conflict (id) do update
    set delivery_status = excluded.delivery_status,
        failure_class   = excluded.failure_class;
end;
$$;

-- ── 1. Views must declare security_invoker = true ────────────────────────
-- Without security_invoker the view executes as its owner (typically a
-- superuser) and bypasses base-table RLS, exposing cross-tenant data.
do $$
declare
  v_has_invoker bool;
  v_view        text;
begin
  foreach v_view in array array[
    'v_smartequip_delivery_dashboard',
    'v_smartequip_failed_exchanges',
    'v_smartequip_reconciliation_summary'
  ] loop
    select coalesce('security_invoker=true' = any(c.reloptions), false)
      into v_has_invoker
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_view;

    if not coalesce(v_has_invoker, false) then
      raise exception
        'FAIL 1: % must declare security_invoker = true '
        '(without it the view owner bypasses base-table RLS)', v_view;
    end if;
  end loop;

  raise notice 'PASS 1: all three SmartEquip views declare security_invoker = true';
end;
$$;

-- ── 2. anon denied SELECT on base tables ────────────────────────────────
set local role anon;

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  -- 2a. smartequip_delivery_events
  v_caught := false;
  begin
    select count(*) into v_dummy from public.smartequip_delivery_events;
    raise exception
      'FAIL 2a: anon read smartequip_delivery_events succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2a: anon should be denied SELECT on smartequip_delivery_events';
  end if;

  -- 2b. smartequip_dead_letter_queue
  v_caught := false;
  begin
    select count(*) into v_dummy from public.smartequip_dead_letter_queue;
    raise exception
      'FAIL 2b: anon read smartequip_dead_letter_queue succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2b: anon should be denied SELECT on smartequip_dead_letter_queue';
  end if;

  raise notice 'PASS 2: anon denied SELECT on both base tables';
end;
$$;

reset role;

-- ── 3. anon denied SELECT on all three views ────────────────────────────
set local role anon;

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  -- 3a. v_smartequip_delivery_dashboard
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_smartequip_delivery_dashboard;
    raise exception
      'FAIL 3a: anon read v_smartequip_delivery_dashboard succeeded';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 3a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3a: anon should be denied SELECT on v_smartequip_delivery_dashboard';
  end if;

  -- 3b. v_smartequip_failed_exchanges
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_smartequip_failed_exchanges;
    raise exception
      'FAIL 3b: anon read v_smartequip_failed_exchanges succeeded';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 3b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3b: anon should be denied SELECT on v_smartequip_failed_exchanges';
  end if;

  -- 3c. v_smartequip_reconciliation_summary
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_smartequip_reconciliation_summary;
    raise exception
      'FAIL 3c: anon read v_smartequip_reconciliation_summary succeeded';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 3c: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3c: anon should be denied SELECT on v_smartequip_reconciliation_summary';
  end if;

  raise notice 'PASS 3: anon denied SELECT on all three SmartEquip views';
end;
$$;

reset role;

-- ── 4. anon denied EXECUTE on operator RPCs ─────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool;
begin
  -- 4a. smartequip_quarantine_exchange
  v_caught := false;
  begin
    perform public.smartequip_quarantine_exchange(gen_random_uuid(), 'test');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      raise exception 'FAIL 4a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 4a: anon should be denied EXECUTE on smartequip_quarantine_exchange';
  end if;

  -- 4b. smartequip_mark_replayed
  v_caught := false;
  begin
    perform public.smartequip_mark_replayed(gen_random_uuid(), 'anon-actor');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      raise exception 'FAIL 4b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 4b: anon should be denied EXECUTE on smartequip_mark_replayed';
  end if;

  -- 4c. smartequip_disable_exchange_retry
  v_caught := false;
  begin
    perform public.smartequip_disable_exchange_retry(gen_random_uuid(), 'test disable');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      raise exception 'FAIL 4c: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 4c: anon should be denied EXECUTE on smartequip_disable_exchange_retry';
  end if;

  raise notice 'PASS 4: anon denied EXECUTE on all operator RPCs';
end;
$$;

reset role;

-- ── 5. authenticated (no app_role) sees 0 rows — RLS policy blocks ──────
-- The smartequip_delivery_events_ops_read policy requires
-- ops_claim_app_role() in ('admin', 'branch_manager').  A JWT with no
-- app_role claim resolves to NULL and fails that predicate, so no rows
-- are returned even though SELECT is granted to the authenticated role.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaaa","role":"authenticated"}',
  true
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.smartequip_delivery_events;
  if v_count <> 0 then
    raise exception
      'FAIL 5: authenticated (no app_role) should see 0 rows from smartequip_delivery_events '
      'via RLS; got %', v_count;
  end if;

  select count(*) into v_count from public.smartequip_dead_letter_queue;
  if v_count <> 0 then
    raise exception
      'FAIL 5: authenticated (no app_role) should see 0 rows from smartequip_dead_letter_queue '
      'via RLS; got %', v_count;
  end if;

  raise notice 'PASS 5: authenticated (no app_role) sees 0 rows — RLS policy effective';
end;
$$;

reset role;

-- ── 6. authenticated (read_only, tenant-A) sees 0 rows ──────────────────
-- read_only is not in ('admin', 'branch_manager') so the RLS policy
-- denies access to both tables.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaab","role":"authenticated","app_metadata":{"role":"read_only","tenant":"smartequip-rls-a"}}',
  true
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.smartequip_delivery_events;
  if v_count <> 0 then
    raise exception
      'FAIL 6: authenticated (read_only) should see 0 rows from smartequip_delivery_events; got %',
      v_count;
  end if;

  select count(*) into v_count from public.smartequip_dead_letter_queue;
  if v_count <> 0 then
    raise exception
      'FAIL 6: authenticated (read_only) should see 0 rows from smartequip_dead_letter_queue; got %',
      v_count;
  end if;

  raise notice 'PASS 6: authenticated (read_only) sees 0 rows — RLS correctly excludes non-operator role';
end;
$$;

reset role;

-- ── 7. authenticated (admin, tenant-A) sees only tenant-A rows ──────────
-- The RLS policy uses ops_tenant_match(tenant_id) which checks that the
-- row's tenant matches the caller's JWT tenant claim.  Tenant-B rows must
-- not appear even though SELECT is granted to authenticated.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaac","role":"authenticated","app_metadata":{"role":"admin","tenant":"smartequip-rls-a"}}',
  true
);

do $$
declare
  v_tenant_a constant uuid := 'aa000000-0000-0000-0000-000000000001';
  v_tenant_b constant uuid := 'aa000000-0000-0000-0000-000000000002';
  v_count    int;
begin
  -- Should see exactly the 1 event for tenant-A.
  select count(*) into v_count from public.smartequip_delivery_events;
  if v_count <> 1 then
    raise exception
      'FAIL 7a: admin (tenant-A) should see exactly 1 row in smartequip_delivery_events; got %',
      v_count;
  end if;

  -- Must NOT see tenant-B's row.
  if exists (
    select 1 from public.smartequip_delivery_events
     where tenant_id = v_tenant_b
  ) then
    raise exception
      'FAIL 7b: admin (tenant-A) must not see tenant-B events — cross-tenant leak via RLS';
  end if;

  -- Must see tenant-A's row.
  if not exists (
    select 1 from public.smartequip_delivery_events
     where tenant_id = v_tenant_a
  ) then
    raise exception
      'FAIL 7c: admin (tenant-A) should see tenant-A event but found none';
  end if;

  -- Views should also filter: dashboard shows only tenant-A data.
  select count(*) into v_count from public.v_smartequip_delivery_dashboard;
  if v_count <> 1 then
    raise exception
      'FAIL 7d: v_smartequip_delivery_dashboard should return 1 row for tenant-A admin; got %',
      v_count;
  end if;

  if exists (
    select 1 from public.v_smartequip_delivery_dashboard
     where tenant_id = v_tenant_b
  ) then
    raise exception
      'FAIL 7e: v_smartequip_delivery_dashboard must not expose tenant-B rows to tenant-A admin';
  end if;

  raise notice 'PASS 7: admin (tenant-A) sees only tenant-A rows; tenant-B excluded from table and view';
end;
$$;

reset role;

-- ── 8. authenticated (branch_manager, tenant-A) sees only tenant-A rows ─
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaad","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"smartequip-rls-a"}}',
  true
);

do $$
declare
  v_tenant_a constant uuid := 'aa000000-0000-0000-0000-000000000001';
  v_tenant_b constant uuid := 'aa000000-0000-0000-0000-000000000002';
  v_count    int;
begin
  select count(*) into v_count from public.smartequip_delivery_events;
  if v_count <> 1 then
    raise exception
      'FAIL 8a: branch_manager (tenant-A) should see exactly 1 row; got %', v_count;
  end if;

  if exists (
    select 1 from public.smartequip_delivery_events
     where tenant_id = v_tenant_b
  ) then
    raise exception
      'FAIL 8b: branch_manager (tenant-A) must not see tenant-B events';
  end if;

  raise notice 'PASS 8: branch_manager (tenant-A) sees only tenant-A rows';
end;
$$;

reset role;

-- ── 9. smartequip_quarantine_exchange — admin (tenant-A) happy path ────────
-- Security-definer RPC.  Reads ops_claim_app_role() / ops_tenant_match()
-- from the JWT GUC so the claims context must be set before calling.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaae","role":"authenticated","app_metadata":{"role":"admin","tenant":"smartequip-rls-a"}}',
  true
);

do $$
declare
  v_event_a constant uuid := 'aa000000-0000-0000-0001-000000000001';
  v_dlq_id  uuid;
  v_status  text;
  v_dlq_exists bool;
  v_failed_visible bool;
begin
  -- Call the RPC as authenticated admin of tenant-A.
  select public.smartequip_quarantine_exchange(
    v_event_a,
    'rls-test quarantine',
    true,
    'test operator notes'
  ) into v_dlq_id;

  if v_dlq_id is null then
    raise exception 'FAIL 9a: smartequip_quarantine_exchange returned null DLQ id';
  end if;

  -- Delivery event must now be quarantined.
  select delivery_status into v_status
    from public.smartequip_delivery_events
   where id = v_event_a;

  if v_status <> 'quarantined' then
    raise exception
      'FAIL 9b: expected delivery_status = quarantined after RPC call, got %',
      coalesce(v_status, '<null>');
  end if;

  -- DLQ row must exist with replay_eligible = true.
  select exists(
    select 1 from public.smartequip_dead_letter_queue
     where id = v_dlq_id
       and replay_eligible = true
       and replayed_at is null
  ) into v_dlq_exists;

  if not v_dlq_exists then
    raise exception
      'FAIL 9c: DLQ row missing or replay_eligible/replayed_at not as expected for dlq_id=%',
      v_dlq_id;
  end if;

  -- Quarantined exchanges should remain visible in failed-exchanges triage.
  select exists(
    select 1
    from public.v_smartequip_failed_exchanges
    where id = v_event_a
      and delivery_status = 'quarantined'
  ) into v_failed_visible;

  if not v_failed_visible then
    raise exception
      'FAIL 9d: quarantined event should remain visible in v_smartequip_failed_exchanges until replayed/resolved';
  end if;

  raise notice 'PASS 9: admin (tenant-A) quarantined event via RPC; DLQ row created, replay_eligible=true, failed-exchanges visibility preserved';
end;
$$;

reset role;

-- ── 10. smartequip_quarantine_exchange — read_only denied ──────────────────
-- The RPC checks ops_claim_app_role() first; read_only must be rejected
-- before any data is touched.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaaf","role":"authenticated","app_metadata":{"role":"read_only","tenant":"smartequip-rls-a"}}',
  true
);

do $$
declare
  v_event_b constant uuid := 'aa000000-0000-0000-0001-000000000002';
  v_caught  bool := false;
begin
  begin
    perform public.smartequip_quarantine_exchange(v_event_b, 'unauthorized quarantine');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient role%' or sqlerrm ilike '%insufficient_privilege%' then
        v_caught := true;
      else
        raise exception 'FAIL 10: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception
      'FAIL 10: read_only should be denied smartequip_quarantine_exchange but call succeeded';
  end if;

  raise notice 'PASS 10: read_only denied smartequip_quarantine_exchange (insufficient_privilege)';
end;
$$;

reset role;

-- ── 11. smartequip_quarantine_exchange — cross-tenant denied ───────────────
-- Admin of tenant-A must not be able to quarantine an event that belongs
-- to tenant-B.  The RPC's internal ops_tenant_match check raises no_data_found.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaac","role":"authenticated","app_metadata":{"role":"admin","tenant":"smartequip-rls-a"}}',
  true
);

do $$
declare
  v_event_b constant uuid := 'aa000000-0000-0000-0001-000000000002';
  v_caught  bool := false;
begin
  begin
    perform public.smartequip_quarantine_exchange(v_event_b, 'cross-tenant attempt');
  exception
    when no_data_found            then v_caught := true;
    when sqlstate 'P0002'         then v_caught := true;
    when others then
      if sqlerrm ilike '%not found%' or sqlerrm ilike '%not accessible%' then
        v_caught := true;
      else
        raise exception 'FAIL 11: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception
      'FAIL 11: admin (tenant-A) should be denied quarantine of tenant-B event '
      '(cross-tenant isolation breach)';
  end if;

  -- Confirm tenant-B event is still untouched.
  if exists (
    select 1 from public.smartequip_dead_letter_queue
     where delivery_event_id = v_event_b
  ) then
    raise exception
      'FAIL 11: tenant-B event was inserted into DLQ despite cross-tenant denial';
  end if;

  raise notice 'PASS 11: admin (tenant-A) denied quarantine of tenant-B event (cross-tenant isolation)';
end;
$$;

reset role;

-- ── 12. smartequip_mark_replayed — admin (tenant-A) happy path ─────────────
-- Looks up the DLQ entry created in test 9 and replays it.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaac","role":"authenticated","app_metadata":{"role":"admin","tenant":"smartequip-rls-a"}}',
  true
);

do $$
declare
  v_event_a     constant uuid := 'aa000000-0000-0000-0001-000000000001';
  v_dlq_id      uuid;
  v_replay_id   uuid;
  v_replayed_at timestamptz;
  v_replay_status text;
  v_still_visible bool;
begin
  -- Retrieve the DLQ row created in test 9.
  select id into v_dlq_id
    from public.smartequip_dead_letter_queue
   where delivery_event_id = v_event_a
     and replayed_at is null;

  if v_dlq_id is null then
    raise exception
      'FAIL 12: could not find unreplayed DLQ row for event_a — test 9 may not have run';
  end if;

  -- Replay via RPC.
  select public.smartequip_mark_replayed(v_dlq_id, 'test-operator', 'rls-test replay')
    into v_replay_id;

  if v_replay_id is null then
    raise exception 'FAIL 12a: smartequip_mark_replayed returned null replay delivery event id';
  end if;

  -- DLQ row must now have replayed_at set and replay_delivery_id pointing to the new event.
  select replayed_at into v_replayed_at
    from public.smartequip_dead_letter_queue
   where id = v_dlq_id;

  if v_replayed_at is null then
    raise exception 'FAIL 12b: DLQ row replayed_at must be set after smartequip_mark_replayed call';
  end if;

  -- The new replay delivery event must exist with status = 'replayed' and replayed_from_id set.
  select delivery_status into v_replay_status
    from public.smartequip_delivery_events
   where id = v_replay_id;

  if v_replay_status <> 'replayed' then
    raise exception
      'FAIL 12c: replay delivery event should have status = replayed; got %',
      coalesce(v_replay_status, '<null>');
  end if;

  if not exists (
    select 1 from public.smartequip_delivery_events
     where id = v_replay_id
       and replayed_from_id = v_event_a
  ) then
    raise exception
      'FAIL 12d: replay delivery event must have replayed_from_id = event_a for audit chain';
  end if;

  select exists(
    select 1
    from public.v_smartequip_failed_exchanges
    where id = v_event_a
  ) into v_still_visible;

  if v_still_visible then
    raise exception
      'FAIL 12e: quarantined source event should leave v_smartequip_failed_exchanges after replay/resolution';
  end if;

  raise notice 'PASS 12: admin (tenant-A) replayed DLQ entry; replay event created with correct audit chain';
end;
$$;

reset role;

-- ── 13. smartequip_mark_replayed — read_only denied ───────────────────────
-- Role check fires before the DLQ lookup; any DLQ id (even non-existent)
-- will trigger the role guard.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaaf","role":"authenticated","app_metadata":{"role":"read_only","tenant":"smartequip-rls-a"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.smartequip_mark_replayed(gen_random_uuid(), 'unauthorized-actor');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%insufficient role%' or sqlerrm ilike '%insufficient_privilege%' then
        v_caught := true;
      else
        raise exception 'FAIL 13: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception
      'FAIL 13: read_only should be denied smartequip_mark_replayed but call succeeded';
  end if;

  raise notice 'PASS 13: read_only denied smartequip_mark_replayed (insufficient_privilege)';
end;
$$;

reset role;

-- ── 14. smartequip_disable_exchange_retry — admin (tenant-A) happy path ───
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-aaaaaaaaaaac","role":"authenticated","app_metadata":{"role":"admin","tenant":"smartequip-rls-a"}}',
  true
);

do $$
declare
  v_event_id uuid;
  v_dlq_id   uuid;
begin
  select e.id
  into v_event_id
  from public.smartequip_delivery_events e
  where e.tenant_id = 'aa000000-0000-0000-0000-000000000001'::uuid
    and e.delivery_status = 'replayed'
  order by e.occurred_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'FAIL 14a: expected replayed tenant-A event fixture from PASS 12';
  end if;

  select public.smartequip_disable_exchange_retry(
    v_event_id,
    'disabled until provider rate window resets',
    'pause retries'
  )
  into v_dlq_id;

  if v_dlq_id is null then
    raise exception 'FAIL 14b: smartequip_disable_exchange_retry returned null DLQ id';
  end if;

  if not exists (
    select 1 from public.smartequip_dead_letter_queue
    where id = v_dlq_id
      and replay_eligible = false
  ) then
    raise exception 'FAIL 14c: disable retry should quarantine with replay_eligible=false';
  end if;

  raise notice 'PASS 14: admin disabled retry and quarantined exchange via wrapper RPC';
end;
$$;

reset role;

-- ── 15. service_role policy is effective — sees all tenants ─────────────
-- The smartequip_delivery_events_service_role policy has using(true),
-- so service_role reads rows for every tenant.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.smartequip_delivery_events;

  if v_count < 2 then
    raise exception
      'FAIL 15: service_role should see rows from both tenants (>= 2); got %', v_count;
  end if;

  -- Both tenant rows must be visible.
  -- This block is intentionally self-contained, so tenant UUID fixtures are repeated here.
  if not exists (
    select 1 from public.smartequip_delivery_events
     where tenant_id = 'aa000000-0000-0000-0000-000000000001'::uuid
  ) then
    raise exception 'FAIL 15: service_role must see tenant-A event';
  end if;

  if not exists (
    select 1 from public.smartequip_delivery_events
     where tenant_id = 'aa000000-0000-0000-0000-000000000002'::uuid
  ) then
    raise exception 'FAIL 15: service_role must see tenant-B event';
  end if;

  raise notice 'PASS 15: service_role sees rows from all tenants (policy using(true) effective)';
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

rollback;
