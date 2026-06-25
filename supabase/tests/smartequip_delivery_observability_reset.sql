-- Reset-path validation for SmartEquip delivery observability
-- (migration 20260611203000_smartequip_delivery_observability.sql).
--
-- Confirms that a fully-reset schema still supports:
--   1.  Structural integrity: base tables exist with RLS enabled
--   2.  Views exist with security_invoker = true
--   3.  Operator RPCs exist and are callable
--   4.  Delivery-event persistence: INSERT + SELECT via service_role
--   5.  Quarantine flow: smartequip_quarantine_exchange happy path
--   6.  Replay flow: smartequip_mark_replayed happy path
--   7.  Disable-retry flow: smartequip_disable_exchange_retry happy path
--   8.  Diagnostic views return expected aggregate shape after reset
--
-- All data is inserted and rolled back; this script makes no lasting changes.

begin;

-- ── 1. Structural: base tables exist with RLS ────────────────────────────────
do $$
declare
  v_table text;
  v_has_rls bool;
begin
  foreach v_table in array array[
    'smartequip_delivery_events',
    'smartequip_dead_letter_queue'
  ] loop
    select c.relrowsecurity
      into v_has_rls
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_table;

    if not found then
      raise exception 'FAIL 1: table public.% not found after reset', v_table;
    end if;

    if not coalesce(v_has_rls, false) then
      raise exception 'FAIL 1: RLS not enabled on public.% after reset', v_table;
    end if;
  end loop;

  raise notice 'PASS 1: base tables exist with RLS enabled after reset';
end;
$$;

-- ── 2. Views declare security_invoker = true ─────────────────────────────────
do $$
declare
  v_view text;
  v_has_invoker bool;
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

    if not found or not coalesce(v_has_invoker, false) then
      raise exception
        'FAIL 2: view public.% must declare security_invoker = true after reset',
        v_view;
    end if;
  end loop;

  raise notice 'PASS 2: all three views declare security_invoker = true after reset';
end;
$$;

-- ── 3. Operator RPCs exist ───────────────────────────────────────────────────
do $$
declare
  v_proc text;
  v_exists bool;
begin
  foreach v_proc in array array[
    'smartequip_quarantine_exchange',
    'smartequip_mark_replayed',
    'smartequip_disable_exchange_retry'
  ] loop
    select exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_proc
    ) into v_exists;

    if not v_exists then
      raise exception 'FAIL 3: RPC public.% not found after reset', v_proc;
    end if;
  end loop;

  raise notice 'PASS 3: operator RPCs exist after reset';
end;
$$;

-- ── 4-8. Functional checks via service_role ──────────────────────────────────
set local role service_role;

do $$
declare
  v_tenant_id              uuid := 'bc000000-0000-0000-0000-000000000001';
  v_tenant_key             text := 'smartequip-reset-check';
  v_retry_event_id         uuid;
  v_disable_event_id       uuid;
  v_quarantine_dlq_id      uuid;
  v_disable_dlq_id         uuid;
  v_replay_id              uuid;

  v_fetched_status         text;
  v_dashboard_rows         int;
  v_failed_rows            int;
  v_reconcile_rows         int;
  v_disable_replay_eligible bool;
  v_dlq_replayed_at        timestamptz;
  v_failed_visible         bool;
begin
  -- ── 4a. Tenant fixture ───────────────────────────────────────────────────
  insert into public.tenants (id, tenant_key, name)
  values (v_tenant_id, v_tenant_key, 'SmartEquip Reset Validation Tenant')
  on conflict (id) do nothing;

  -- ── 4b. Delivery event INSERTs ───────────────────────────────────────────
  insert into public.smartequip_delivery_events (
    tenant_id,
    exchange_id,
    flow_name,
    object_scope,
    direction,
    delivery_status,
    failure_class,
    failure_code,
    failure_message,
    retry_count,
    source_system,
    source_event_id,
    idempotency_key,
    correlation_id,
    payload_digest
  ) values (
    v_tenant_id,
    'reset-check-exchange-001',
    'work-order-sync',
    'work_orders',
    'outbound',
    'retrying',
    'timeout',
    'CONN_TIMEOUT',
    'connection timed out during reset validation',
    2,
    'smartequip',
    'reset-src-event-001',
    'reset-idem-001',
    'reset-corr-001',
    'reset-digest-001'
  )
  returning id into v_retry_event_id;

  insert into public.smartequip_delivery_events (
    tenant_id,
    exchange_id,
    flow_name,
    object_scope,
    direction,
    delivery_status,
    failure_class,
    failure_code,
    failure_message,
    retry_count,
    source_system,
    source_event_id,
    idempotency_key,
    correlation_id,
    payload_digest
  ) values (
    v_tenant_id,
    'reset-check-exchange-002',
    'service-request-sync',
    'service_requests',
    'outbound',
    'retrying',
    'rate_limit',
    'HTTP_429',
    'provider rate limit during reset validation',
    3,
    'smartequip',
    'reset-src-event-002',
    'reset-idem-002',
    'reset-corr-002',
    'reset-digest-002'
  )
  returning id into v_disable_event_id;

  if v_retry_event_id is null or v_disable_event_id is null then
    raise exception 'FAIL 4: smartequip_delivery_events INSERT returned null id(s)';
  end if;

  -- ── 4c. Delivery event SELECT ────────────────────────────────────────────
  select delivery_status into v_fetched_status
  from public.smartequip_delivery_events
  where id = v_retry_event_id;

  if v_fetched_status <> 'retrying' then
    raise exception
      'FAIL 4: expected delivery_status=retrying after INSERT, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 4: delivery-event INSERT + SELECT round-trip works after reset';

  -- Simulate an authenticated admin JWT context so the operator role checks pass.
  perform set_config(
    'request.jwt.claims',
    format(
      '{"sub":"%s","role":"service_role","app_metadata":{"role":"admin","tenant":"%s"}}',
      gen_random_uuid(),
      v_tenant_key
    ),
    true
  );

  -- ── 5. Quarantine flow ────────────────────────────────────────────────────
  v_quarantine_dlq_id := public.smartequip_quarantine_exchange(
    v_retry_event_id,
    'reset-path validation quarantine',
    true,
    'quarantined during reset-path check'
  );

  if v_quarantine_dlq_id is null then
    raise exception 'FAIL 5: smartequip_quarantine_exchange returned null DLQ id';
  end if;

  select delivery_status into v_fetched_status
  from public.smartequip_delivery_events
  where id = v_retry_event_id;

  if v_fetched_status <> 'quarantined' then
    raise exception
      'FAIL 5: delivery event status should be quarantined, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 5: quarantine flow works after reset';

  -- ── 6. Replay flow ────────────────────────────────────────────────────────
  v_replay_id := public.smartequip_mark_replayed(
    v_quarantine_dlq_id,
    'reset-path-operator',
    'replayed during reset-path check'
  );

  if v_replay_id is null then
    raise exception 'FAIL 6: smartequip_mark_replayed returned null replay event id';
  end if;

  select replayed_at into v_dlq_replayed_at
  from public.smartequip_dead_letter_queue
  where id = v_quarantine_dlq_id;

  if v_dlq_replayed_at is null then
    raise exception 'FAIL 6: DLQ entry replayed_at should be set after mark_replayed';
  end if;

  select delivery_status into v_fetched_status
  from public.smartequip_delivery_events
  where id = v_replay_id;

  if v_fetched_status <> 'replayed' then
    raise exception
      'FAIL 6: replay delivery event should have status=replayed, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  if not exists (
    select 1
    from public.smartequip_delivery_events
    where id = v_replay_id
      and replayed_from_id = v_retry_event_id
  ) then
    raise exception 'FAIL 6: replay event must keep replayed_from_id audit linkage';
  end if;

  raise notice 'PASS 6: replay flow works after reset';

  -- ── 7. Disable-retry flow ────────────────────────────────────────────────
  v_disable_dlq_id := public.smartequip_disable_exchange_retry(
    v_disable_event_id,
    'disabled until provider rate window resets',
    'disable retry during reset-path check'
  );

  if v_disable_dlq_id is null then
    raise exception 'FAIL 7: smartequip_disable_exchange_retry returned null DLQ id';
  end if;

  select replay_eligible into v_disable_replay_eligible
  from public.smartequip_dead_letter_queue
  where id = v_disable_dlq_id;

  if coalesce(v_disable_replay_eligible, true) then
    raise exception 'FAIL 7: disable-retry DLQ entry should have replay_eligible=false';
  end if;

  select exists (
    select 1
    from public.v_smartequip_failed_exchanges
    where id = v_disable_event_id
      and delivery_status = 'quarantined'
  ) into v_failed_visible;

  if not v_failed_visible then
    raise exception 'FAIL 7: disabled-retry event should remain visible in failed exchanges';
  end if;

  raise notice 'PASS 7: disable-retry flow works after reset';

  -- ── 8. Diagnostic views return expected aggregate shape ───────────────────
  select count(*) into v_dashboard_rows
  from public.v_smartequip_delivery_dashboard
  where tenant_id = v_tenant_id;

  if v_dashboard_rows < 2 then
    raise exception
      'FAIL 8: v_smartequip_delivery_dashboard returned too few rows (%) for test tenant after reset',
      v_dashboard_rows;
  end if;

  select count(*) into v_failed_rows
  from public.v_smartequip_failed_exchanges
  where tenant_id = v_tenant_id;

  if v_failed_rows < 1 then
    raise exception
      'FAIL 8: v_smartequip_failed_exchanges returned 0 rows for test tenant after reset';
  end if;

  select count(*) into v_reconcile_rows
  from public.v_smartequip_reconciliation_summary
  where tenant_id = v_tenant_id;

  if v_reconcile_rows < 2 then
    raise exception
      'FAIL 8: v_smartequip_reconciliation_summary returned too few rows (%) for test tenant after reset',
      v_reconcile_rows;
  end if;

  raise notice 'PASS 8: dashboard, failed-exchange, and reconciliation views return rows after reset';
end;
$$;

reset role;

rollback;
