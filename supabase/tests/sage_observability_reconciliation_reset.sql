-- Reset-path validation for Sage observability, reconciliation, and recovery audit
-- (migration 20260613092645_sage_observability_reconciliation.sql).
--
-- Confirms that a fully-reset schema still supports:
--   1.  Structural integrity: base tables exist with RLS enabled
--   2.  Views declare security_invoker = true
--   3.  Operator RPCs exist
--   4.  Telemetry event persistence: INSERT + SELECT via service_role
--   5.  DLQ quarantine flow: sage_quarantine_sync_event happy path
--   6.  DLQ replay flow + recovery-audit lookup: sage_mark_replayed happy path
--   7.  Reconciliation queue reads: v_sage_reconciliation_drift returns rows
--   8.  Telemetry status view: v_sage_sync_dashboard returns rows after reset
--
-- All data is inserted and rolled back; this script makes no lasting changes.

begin;

-- ── 1. Structural: base tables exist with RLS ────────────────────────────────
do $$
declare
  v_table  text;
  v_has_rls bool;
begin
  foreach v_table in array array[
    'sage_sync_events',
    'sage_dead_letter_queue',
    'sage_sync_controls',
    'sage_reconciliation_results',
    'sage_sync_checkpoint_audit'
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
  v_view        text;
  v_has_invoker bool;
begin
  foreach v_view in array array[
    'v_sage_sync_dashboard',
    'v_sage_failed_sync_work',
    'v_sage_reconciliation_drift',
    'v_sage_reconciliation_summary',
    'v_sage_sync_audit_history'
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

  raise notice 'PASS 2: all Sage views declare security_invoker = true after reset';
end;
$$;

-- ── 3. Operator RPCs exist ───────────────────────────────────────────────────
do $$
declare
  v_proc   text;
  v_exists bool;
begin
  foreach v_proc in array array[
    'sage_upsert_sync_checkpoint',
    'sage_quarantine_sync_event',
    'sage_mark_replayed',
    'sage_disable_sync_scope',
    'sage_enable_sync_scope'
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

  raise notice 'PASS 3: all Sage operator RPCs exist after reset';
end;
$$;

-- ── 4-8. Functional checks ───────────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_tenant_id      uuid := 'ee000000-0000-0000-0000-000000000001';
  v_integration_id uuid := 'ee000000-0000-0000-0002-000000000001';
  v_event_id       uuid;
  v_dlq_id         uuid;
  v_replay_id      uuid;

  v_fetched_status  text;
  v_dashboard_rows  int;
  v_drift_rows      int;
  v_audit_rows      int;
  v_dlq_eligible    bool;
  v_dlq_replayed_at timestamptz;
begin
  -- ── 4a. Tenant + integration fixtures ───────────────────────────────────
  insert into public.tenants (id, tenant_key, name)
  values (v_tenant_id, 'sage-reset-check', 'Sage Reset Validation Tenant')
  on conflict (id) do nothing;

  insert into public.integration_config (
    id, tenant_id, connector_key, provider, provider_key, display_name,
    enabled, auth_type, connection_config, feature_config
  ) values (
    v_integration_id, v_tenant_id, 'sage', 'sage', 'sage', 'Sage Reset Check',
    true, 'oauth2', '{"environment":"sandbox"}'::jsonb, '{"ledger":"primary"}'::jsonb
  ) on conflict (id) do nothing;

  -- ── 4b. Sync event INSERT ────────────────────────────────────────────────
  insert into public.sage_sync_events (
    tenant_id,
    object_type,
    object_key,
    internal_record_id,
    sage_record_id,
    direction,
    sync_status,
    failure_class,
    failure_code,
    failure_message,
    retry_count,
    max_retries,
    source_system,
    source_event_id,
    idempotency_key
  ) values (
    v_tenant_id,
    'invoice',
    'INV-RESET-001',
    'internal-inv-reset-001',
    'sage-inv-reset-001',
    'outbound',
    'retrying',
    'auth',
    'OAUTH_401',
    'token expired during reset-path check',
    1,
    3,
    'sage',
    'reset-src-event-001',
    'reset-idem-inv-001'
  )
  returning id into v_event_id;

  if v_event_id is null then
    raise exception 'FAIL 4: sage_sync_events INSERT returned null id';
  end if;

  -- ── 4c. Sync event SELECT ────────────────────────────────────────────────
  select sync_status into v_fetched_status
  from public.sage_sync_events
  where id = v_event_id;

  if v_fetched_status <> 'retrying' then
    raise exception
      'FAIL 4: expected sync_status=retrying after INSERT, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 4: telemetry event INSERT + SELECT round-trip works after reset';

  -- ── 5. DLQ quarantine flow ───────────────────────────────────────────────
  -- Simulate admin JWT context so the RPC role check passes.
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',          gen_random_uuid(),
      'role',         'authenticated',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', 'sage-reset-check')
    )::text,
    true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_dlq_id := public.sage_quarantine_sync_event(
    v_event_id,
    'reset-path validation quarantine',
    true,
    'quarantined during reset-path check'
  );

  if v_dlq_id is null then
    raise exception 'FAIL 5: sage_quarantine_sync_event returned null DLQ id';
  end if;

  select replay_eligible into v_dlq_eligible
  from public.sage_dead_letter_queue
  where id = v_dlq_id;

  if not coalesce(v_dlq_eligible, false) then
    raise exception 'FAIL 5: DLQ entry should be replay_eligible=true after quarantine';
  end if;

  select sync_status into v_fetched_status
  from public.sage_sync_events
  where id = v_event_id;

  if v_fetched_status <> 'quarantined' then
    raise exception
      'FAIL 5: sync event status should be quarantined after DLQ quarantine, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 5: DLQ quarantine flow works after reset';

  -- ── 6. DLQ replay flow + recovery-audit lookup ───────────────────────────
  v_replay_id := public.sage_mark_replayed(
    v_dlq_id,
    'reset-path-operator',
    'replayed during reset-path check'
  );

  if v_replay_id is null then
    raise exception 'FAIL 6: sage_mark_replayed returned null replay event id';
  end if;

  select replayed_at into v_dlq_replayed_at
  from public.sage_dead_letter_queue
  where id = v_dlq_id;

  if v_dlq_replayed_at is null then
    raise exception 'FAIL 6: DLQ entry replayed_at should be set after sage_mark_replayed';
  end if;

  select sync_status into v_fetched_status
  from public.sage_sync_events
  where id = v_replay_id;

  if v_fetched_status <> 'replayed' then
    raise exception
      'FAIL 6: replay event should have sync_status=replayed, got %',
      coalesce(v_fetched_status, 'NULL');
  end if;

  raise notice 'PASS 6: DLQ replay flow works after reset';

  -- ── 6b. Recovery-audit lookup via sage_upsert_sync_checkpoint ────────────
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  perform public.sage_upsert_sync_checkpoint(
    v_integration_id,
    v_tenant_id,
    'invoice',
    'INV-RESET-001',
    'outbound',
    'reset-cursor-001',
    'recovered',
    '{"checkpoint_phase":"recovered","resumed_from":"reset-cursor-000"}'::jsonb,
    now()
  );

  select count(*) into v_audit_rows
  from public.sage_sync_checkpoint_audit
  where tenant_id = v_tenant_id
    and object_key = 'INV-RESET-001';

  if v_audit_rows < 1 then
    raise exception
      'FAIL 6b: sage_sync_checkpoint_audit should have at least 1 row after checkpoint upsert';
  end if;

  raise notice 'PASS 6b: recovery-audit lookup works after reset';

  -- ── 7. Reconciliation queue reads ────────────────────────────────────────
  insert into public.sage_reconciliation_results (
    tenant_id, provider_name, object_type, object_key,
    internal_record_id, sage_record_id, drift_status,
    internal_digest, sage_digest, compared_fields, diagnostic_summary
  ) values (
    v_tenant_id, 'sage', 'invoice', 'INV-RESET-001',
    'internal-inv-reset-001', 'sage-inv-reset-001', 'drifted',
    'digest-r1', 'digest-r2', '["invoice_total","posting_period"]'::jsonb,
    'invoice drift detected during reset-path check'
  );

  select count(*) into v_drift_rows
  from public.v_sage_reconciliation_drift
  where tenant_id = v_tenant_id;

  if v_drift_rows < 1 then
    raise exception
      'FAIL 7: v_sage_reconciliation_drift returned 0 rows for test tenant after reset';
  end if;

  raise notice 'PASS 7: v_sage_reconciliation_drift returns rows after reset';

  -- ── 8. Telemetry status view ─────────────────────────────────────────────
  select count(*) into v_dashboard_rows
  from public.v_sage_sync_dashboard
  where tenant_id = v_tenant_id;

  if v_dashboard_rows < 1 then
    raise exception
      'FAIL 8: v_sage_sync_dashboard returned 0 rows for test tenant after reset';
  end if;

  raise notice 'PASS 8: v_sage_sync_dashboard returns rows after reset';

  -- ── 8b. Audit-history view ───────────────────────────────────────────────
  select count(*) into v_audit_rows
  from public.v_sage_sync_audit_history
  where tenant_id = v_tenant_id
    and object_key = 'INV-RESET-001';

  if v_audit_rows < 3 then
    raise exception
      'FAIL 8b: expected at least 3 v_sage_sync_audit_history rows (quarantined, replayed, recovered checkpoint) after reset; got %',
      v_audit_rows;
  end if;

  raise notice 'PASS 8b: v_sage_sync_audit_history includes quarantine/replay/recovery rows after reset';

  select count(*) into v_audit_rows
  from public.v_sage_sync_audit_history
  where tenant_id = v_tenant_id
    and object_key = 'INV-RESET-001'
    and event_kind = 'checkpoint';

  if v_audit_rows < 1 then
    raise exception
      'FAIL 8c: expected checkpoint audit rows in v_sage_sync_audit_history after reset';
  end if;

  raise notice 'PASS 8c: checkpoint audit rows are visible in v_sage_sync_audit_history after reset';
end;
$$;

reset role;

rollback;
