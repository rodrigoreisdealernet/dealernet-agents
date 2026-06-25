-- Reset-path validation for MuleSoft delivery observability
-- (migration 20260611085000_mulesoft_delivery_observability.sql).
--
-- Confirms that a fully-reset schema still supports:
--   1.  Structural integrity: base tables exist with RLS enabled
--   2.  Views exist with security_invoker = true
--   3.  Operator RPCs exist and are callable
--   4.  Delivery-event persistence: INSERT + SELECT via service_role
--   5.  DLQ quarantine flow: mulesoft_quarantine_exchange happy path
--   6.  DLQ replay flow: mulesoft_mark_replayed happy path
--   7.  Diagnostic views return expected aggregate shape
--   8.  Reconciliation view returns expected per-day shape
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
    'mulesoft_delivery_events',
    'mulesoft_dead_letter_queue'
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
    'v_mulesoft_delivery_dashboard',
    'v_mulesoft_failed_exchanges',
    'v_mulesoft_reconciliation_summary'
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
    'mulesoft_quarantine_exchange',
    'mulesoft_mark_replayed'
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
  v_tenant_id  uuid := 'bb000000-0000-0000-0000-000000000001';
  v_event_id   uuid;
  v_dlq_id     uuid;
  v_replay_id  uuid;

  v_fetched_status  text;
  v_dashboard_rows  int;
  v_failed_rows     int;
  v_reconcile_rows  int;
  v_dlq_eligible    bool;
  v_dlq_replayed_at timestamptz;
begin
  -- ── 4a. Tenant fixture ───────────────────────────────────────────────────
  insert into public.tenants (id, tenant_key, name)
  values (v_tenant_id, 'mulesoft-reset-check', 'MuleSoft Reset Validation Tenant')
  on conflict (id) do nothing;

  -- ── 4b. Delivery event INSERT ────────────────────────────────────────────
  insert into public.mulesoft_delivery_events (
    tenant_id,
    exchange_id,
    flow_name,
    direction,
    delivery_status,
    failure_class,
    failure_code,
    failure_message,
    retry_count,
    source_system,
    source_event_id,
    idempotency_key
  ) values (
    v_tenant_id,
    'reset-check-exchange-001',
    'order-sync',
    'outbound',
    'retrying',
    'timeout',
    'CONN_TIMEOUT',
    'connection timed out after reset validation',
    2,
    'mulesoft',
    'reset-src-event-001',
    'reset-idem-001'
  )
  returning id into v_event_id;

  if v_event_id is null then
    raise exception 'FAIL 4: mulesoft_delivery_events INSERT returned null id';
  end if;

  -- ── 4c. Delivery event SELECT ────────────────────────────────────────────
  select delivery_status into v_fetched_status
  from public.mulesoft_delivery_events
  where id = v_event_id;

  if v_fetched_status <> 'retrying' then
    raise exception
      'FAIL 4: expected delivery_status=retrying after INSERT, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 4: delivery-event INSERT + SELECT round-trip works after reset';

  -- ── 5. DLQ quarantine flow ───────────────────────────────────────────────
  -- Simulate admin JWT context so the RPC role check passes.
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","app_metadata":{"role":"admin","tenant_id":"%s"}}',
           gen_random_uuid(), v_tenant_id),
    true);

  v_dlq_id := public.mulesoft_quarantine_exchange(
    v_event_id,
    'reset-path validation quarantine',
    true,
    'quarantined during reset-path check'
  );

  if v_dlq_id is null then
    raise exception 'FAIL 5: mulesoft_quarantine_exchange returned null DLQ id';
  end if;

  select replay_eligible into v_dlq_eligible
  from public.mulesoft_dead_letter_queue
  where id = v_dlq_id;

  if not coalesce(v_dlq_eligible, false) then
    raise exception 'FAIL 5: DLQ entry should be replay_eligible=true after quarantine';
  end if;

  select delivery_status into v_fetched_status
  from public.mulesoft_delivery_events
  where id = v_event_id;

  if v_fetched_status <> 'quarantined' then
    raise exception
      'FAIL 5: delivery event status should be quarantined, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 5: DLQ quarantine flow works after reset';

  -- ── 6. DLQ replay flow ───────────────────────────────────────────────────
  v_replay_id := public.mulesoft_mark_replayed(
    v_dlq_id,
    'reset-path-operator',
    'replayed during reset-path check'
  );

  if v_replay_id is null then
    raise exception 'FAIL 6: mulesoft_mark_replayed returned null replay event id';
  end if;

  select replayed_at into v_dlq_replayed_at
  from public.mulesoft_dead_letter_queue
  where id = v_dlq_id;

  if v_dlq_replayed_at is null then
    raise exception 'FAIL 6: DLQ entry replayed_at should be set after mark_replayed';
  end if;

  select delivery_status into v_fetched_status
  from public.mulesoft_delivery_events
  where id = v_replay_id;

  if v_fetched_status <> 'replayed' then
    raise exception
      'FAIL 6: replay delivery event should have status=replayed, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 6: DLQ replay flow works after reset';

  -- ── 7. Delivery dashboard view returns expected aggregate shape ──────────
  select count(*) into v_dashboard_rows
  from public.v_mulesoft_delivery_dashboard
  where tenant_id = v_tenant_id;

  if v_dashboard_rows < 1 then
    raise exception
      'FAIL 7: v_mulesoft_delivery_dashboard returned 0 rows for test tenant after reset';
  end if;

  raise notice 'PASS 7: v_mulesoft_delivery_dashboard returns rows after reset';

  -- ── 8. Reconciliation view returns expected per-day shape ─────────────────
  select count(*) into v_reconcile_rows
  from public.v_mulesoft_reconciliation_summary
  where tenant_id = v_tenant_id;

  if v_reconcile_rows < 1 then
    raise exception
      'FAIL 8: v_mulesoft_reconciliation_summary returned 0 rows for test tenant after reset';
  end if;

  raise notice 'PASS 8: v_mulesoft_reconciliation_summary returns rows after reset';
end;
$$;

reset role;

rollback;
