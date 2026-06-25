-- Reset-path validation for Samsara observability, reconciliation, and operator controls
-- (migration 20260612113000_samsara_observability_reconciliation.sql).
--
-- Confirms that a fully-reset schema still supports:
--   1.  Structural integrity: base tables exist with RLS enabled
--   2.  Views declare security_invoker = true
--   3.  Operator RPCs exist
--   4.  Sync event persistence: INSERT + SELECT via service_role
--   5.  DLQ quarantine flow: samsara_quarantine_sync_event happy path
--   6.  DLQ replay flow: samsara_mark_replayed happy path
--   7.  Reconciliation queue reads: v_samsara_reconciliation_drift returns rows
--   8.  Sync dashboard view: v_samsara_sync_dashboard returns rows after reset
--
-- All data is inserted and rolled back; this script makes no lasting changes.

begin;

-- ── 1. Structural: base tables exist with RLS ─────────────────────────────────
do $$
declare
  v_table   text;
  v_has_rls bool;
begin
  foreach v_table in array array[
    'samsara_sync_events',
    'samsara_dead_letter_queue',
    'samsara_sync_controls',
    'samsara_reconciliation_results'
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

-- ── 2. Views declare security_invoker = true ──────────────────────────────────
do $$
declare
  v_view        text;
  v_has_invoker bool;
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

    if not found or not coalesce(v_has_invoker, false) then
      raise exception
        'FAIL 2: view public.% must declare security_invoker = true after reset',
        v_view;
    end if;
  end loop;

  raise notice 'PASS 2: all Samsara views declare security_invoker = true after reset';
end;
$$;

-- ── 3. Operator RPCs exist ────────────────────────────────────────────────────
do $$
declare
  v_proc   text;
  v_exists bool;
begin
  foreach v_proc in array array[
    'samsara_quarantine_sync_event',
    'samsara_mark_replayed',
    'samsara_disable_sync_scope',
    'samsara_enable_sync_scope'
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

  raise notice 'PASS 3: all Samsara operator RPCs exist after reset';
end;
$$;

-- ── 4-8. Functional checks ────────────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_tenant_id      uuid := 'cc000000-0000-0000-0000-000000000001';
  v_event_id       uuid;
  v_dlq_id         uuid;
  v_replay_id      uuid;

  v_fetched_status  text;
  v_dashboard_rows  int;
  v_drift_rows      int;
  v_dlq_eligible    bool;
begin
  -- ── 4a. Tenant fixture ───────────────────────────────────────────────────
  insert into public.tenants (id, tenant_key, name)
  values (v_tenant_id, 'samsara-reset-check', 'Samsara Reset Validation Tenant')
  on conflict (id) do nothing;

  -- ── 4b. Sync event INSERT ────────────────────────────────────────────────
  insert into public.samsara_sync_events (
    tenant_id,
    asset_external_id,
    signal_type,
    direction,
    sync_status,
    failure_class,
    failure_code,
    failure_message,
    retry_count,
    max_retries,
    lag_seconds,
    source_system,
    source_event_id
  ) values (
    v_tenant_id,
    'RESET-ASSET-001',
    'gps',
    'inbound',
    'retrying',
    'timeout',
    'HTTP_504',
    'provider timeout during reset-path check',
    1,
    3,
    120,
    'samsara',
    'reset-src-event-001'
  )
  returning id into v_event_id;

  if v_event_id is null then
    raise exception 'FAIL 4: samsara_sync_events INSERT returned null id';
  end if;

  -- ── 4c. Sync event SELECT ────────────────────────────────────────────────
  select sync_status into v_fetched_status
  from public.samsara_sync_events
  where id = v_event_id;

  if v_fetched_status <> 'retrying' then
    raise exception
      'FAIL 4: expected sync_status=retrying after INSERT, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 4: sync event INSERT + SELECT round-trip works after reset';

  -- ── 5. DLQ quarantine flow ───────────────────────────────────────────────
  -- Simulate admin JWT context so the RPC role check passes.
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          gen_random_uuid(),
      'role',         'authenticated',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', 'samsara-reset-check')
    )::text,
    true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_dlq_id := public.samsara_quarantine_sync_event(
    v_event_id,
    'reset-path validation quarantine',
    true,
    'quarantined during reset-path check'
  );

  if v_dlq_id is null then
    raise exception 'FAIL 5: samsara_quarantine_sync_event returned null DLQ id';
  end if;

  select replay_eligible into v_dlq_eligible
  from public.samsara_dead_letter_queue
  where id = v_dlq_id;

  if not coalesce(v_dlq_eligible, false) then
    raise exception 'FAIL 5: DLQ entry should be replay_eligible=true after quarantine';
  end if;

  select sync_status into v_fetched_status
  from public.samsara_sync_events
  where id = v_event_id;

  if v_fetched_status <> 'quarantined' then
    raise exception
      'FAIL 5: sync event status should be quarantined after DLQ quarantine, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 5: DLQ quarantine flow works after reset';

  -- ── 6. DLQ replay flow ───────────────────────────────────────────────────
  v_replay_id := public.samsara_mark_replayed(
    v_dlq_id,
    'reset-path-operator',
    'replayed during reset-path check'
  );

  if v_replay_id is null then
    raise exception 'FAIL 6: samsara_mark_replayed returned null replay event id';
  end if;

  select sync_status into v_fetched_status
  from public.samsara_sync_events
  where id = v_replay_id;

  if v_fetched_status <> 'replayed' then
    raise exception
      'FAIL 6: replay event should have sync_status=replayed, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 6: DLQ replay flow works after reset';

  -- ── 7. Reconciliation queue reads ────────────────────────────────────────
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  insert into public.samsara_reconciliation_results (
    tenant_id, asset_external_id, signal_type, drift_status, lag_seconds,
    diagnostic_summary, dia_value, provider_value
  ) values (
    v_tenant_id, 'RESET-ASSET-001', 'gps', 'mismatch', 300,
    'Dealernet position differs from Samsara payload during reset-path check',
    jsonb_build_object('lat', 51.501, 'lng', -0.141),
    jsonb_build_object('lat', 51.492, 'lng', -0.130)
  );

  select count(*) into v_drift_rows
  from public.v_samsara_reconciliation_drift
  where tenant_id = v_tenant_id;

  if v_drift_rows < 1 then
    raise exception
      'FAIL 7: v_samsara_reconciliation_drift returned 0 rows for test tenant after reset';
  end if;

  raise notice 'PASS 7: v_samsara_reconciliation_drift returns rows after reset';

  -- ── 8. Sync dashboard view ───────────────────────────────────────────────
  select count(*) into v_dashboard_rows
  from public.v_samsara_sync_dashboard
  where tenant_id = v_tenant_id;

  if v_dashboard_rows < 1 then
    raise exception
      'FAIL 8: v_samsara_sync_dashboard returned 0 rows for test tenant after reset';
  end if;

  raise notice 'PASS 8: v_samsara_sync_dashboard returns rows after reset';
end;
$$;

reset role;

rollback;
