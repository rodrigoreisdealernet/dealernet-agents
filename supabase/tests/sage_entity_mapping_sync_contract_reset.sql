-- Reset-path validation for Sage entity mapping and sync contract
-- (migration 20260613092641_sage_entity_mapping_sync_contract.sql).
--
-- Confirms that a fully-reset schema still supports:
--   1.  sage_supported_entity_contract() function exists and returns expected
--       entity/direction shape
--   2.  v_sage_entity_mapping_contract view exists with security_invoker = true
--   3.  external_id_map_sage_external_id_guard trigger exists on external_id_map
--   4.  integration_delivery_log Sage check constraint exists
--   5.  Replay-safe delivery log: constraint blocks missing external_id, allows
--       correct payload, and idempotent upsert preserves one row
--   6.  Replay-safe external_id_map: external_id immutability guard fires on
--       UPDATE; stable-id replay upsert preserves one row
--   7.  integration_sync_state cursor advancement produces one row after replay
--
-- All data is inserted and rolled back; this script makes no lasting changes.

begin;

-- ── 1. sage_supported_entity_contract() function exists and returns expected shape ──
do $$
declare
  v_count int;
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sage_supported_entity_contract'
  ) then
    raise exception 'FAIL 1: public.sage_supported_entity_contract() not found after reset';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(public.sage_supported_entity_contract() -> 'entities') e
  where
    (e ->> 'entity_type' = 'invoice'             and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'general_ledger'   and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'accounts_payable' and e ->> 'direction' = 'inbound')
    or (e ->> 'entity_type' = 'accounts_receivable' and e ->> 'direction' = 'inbound');

  if v_count <> 4 then
    raise exception 'FAIL 1: expected 4 Sage entity+direction entries, got %', v_count;
  end if;

  select count(*) into v_count
  from jsonb_array_elements(public.sage_supported_entity_contract() -> 'entities') e
  where nullif(btrim(coalesce(e ->> 'conflict_rule', '')), '') is null
     or nullif(btrim(coalesce(e ->> 'reconciliation_behavior', '')), '') is null;

  if v_count <> 0 then
    raise exception 'FAIL 1: every Sage entity must declare conflict_rule and reconciliation_behavior';
  end if;

  raise notice 'PASS 1: sage_supported_entity_contract() returns expected shape after reset';
end;
$$;

-- ── 2. v_sage_entity_mapping_contract view exists with security_invoker = true ──
do $$
declare
  v_invoker bool;
begin
  select opt.option_value::bool
    into v_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_options_to_table(c.reloptions) as opt
   where n.nspname = 'public'
     and c.relname = 'v_sage_entity_mapping_contract'
     and opt.option_name = 'security_invoker';

  if not found then
    raise exception 'FAIL 2: public.v_sage_entity_mapping_contract not found or security_invoker option missing after reset';
  end if;

  if not coalesce(v_invoker, false) then
    raise exception 'FAIL 2: public.v_sage_entity_mapping_contract does not have security_invoker = true after reset';
  end if;

  raise notice 'PASS 2: v_sage_entity_mapping_contract exists with security_invoker = true after reset';
end;
$$;

-- ── 3. external_id_map_sage_external_id_guard trigger exists ─────────────────
do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'external_id_map'
      and t.tgname = 'trg_external_id_map_sage_external_id_guard'
      and not t.tgisinternal
  ) then
    raise exception 'FAIL 3: trg_external_id_map_sage_external_id_guard trigger not found after reset';
  end if;

  raise notice 'PASS 3: trg_external_id_map_sage_external_id_guard trigger exists after reset';
end;
$$;

-- ── 4. integration_delivery_log Sage check constraint exists ─────────────────
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'integration_delivery_log_sage_external_identifier_chk'
      and conrelid = 'public.integration_delivery_log'::regclass
  ) then
    raise exception 'FAIL 4: integration_delivery_log_sage_external_identifier_chk not found after reset';
  end if;

  raise notice 'PASS 4: Sage check constraint exists on integration_delivery_log after reset';
end;
$$;

-- ── 5–7. Replay-safe end-to-end flow ─────────────────────────────────────────
do $$
declare
  v_tenant_id uuid := '30000000-0000-0000-0000-000000009641';
  v_tenant_key text := 'tenant-sage-reset-9641';
  v_integration_id uuid;
  v_alias_id uuid;
  v_wynne_entity_id uuid := '40000000-0000-0000-0000-000000009641';
  v_delivery_id uuid;
  v_count int;
  v_blocked boolean;
  v_posting_state text;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  insert into public.tenants (id, tenant_key, name)
  values (v_tenant_id, v_tenant_key, 'Sage Reset Test Tenant')
  on conflict (id) do update set tenant_key = excluded.tenant_key, name = excluded.name;

  insert into public.integration_config (
    tenant_id, connector_key, provider, provider_key, display_name,
    auth_type, mappings, settings, enabled
  ) values (
    v_tenant_id, 'sage', 'sage', 'sage', 'Sage Reset Connector',
    'oauth2',
    jsonb_build_object(
      'invoice',          jsonb_build_object('entity_id', 'id',        'external_id', 'invoiceNumber',  'posting_state', 'postingState'),
      'general_ledger',   jsonb_build_object('entity_id', 'entryLineId','external_id', 'journalNumber',  'posting_state', 'postingState'),
      'accounts_payable', jsonb_build_object('entity_id', 'lineId',    'external_id', 'documentNumber', 'posting_state', 'postingState'),
      'accounts_receivable', jsonb_build_object('entity_id', 'lineId', 'external_id', 'documentNumber', 'posting_state', 'postingState')
    ),
    jsonb_build_object('environment', 'sandbox'),
    true
  )
  returning id into v_integration_id;

  -- 5a. Delivery log: constraint blocks missing external_id ─────────────────
  v_blocked := false;
  begin
    insert into public.integration_delivery_log (
      integration_id, tenant_id, connector_key, exchange_key,
      direction, scope_key, source_of_truth, idempotency_key, status, request_payload
    ) values (
      v_integration_id, v_tenant_id, 'sage', 'erp_finance',
      'outbound', 'invoice_sync', 'wynne', 'sage-reset-inv-001', 'pending',
      jsonb_build_object('entity_type', 'invoice', 'entity_id', 'inv-r01', 'posting_state', 'posted')
    );
  exception
    when check_violation then v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL 5a: Sage delivery log payload missing external_id should be blocked after reset';
  end if;

  raise notice 'PASS 5a: delivery log constraint blocks missing external_id after reset';

  -- 5b. Delivery log: correct payload inserts and idempotent upsert preserves one row
  insert into public.integration_delivery_log (
    integration_id, tenant_id, connector_key, exchange_key,
    direction, scope_key, source_of_truth, idempotency_key, status, request_payload
  ) values (
    v_integration_id, v_tenant_id, 'sage', 'erp_finance',
    'outbound', 'invoice_sync', 'wynne', 'sage-reset-inv-002', 'pending',
    jsonb_build_object(
      'external_id', 'SG-RESET-INV-1002', 'entity_type', 'invoice',
      'entity_id', 'inv-r02', 'posting_state', 'posted'
    )
  )
  on conflict (tenant_id, connector_key, direction, exchange_key, idempotency_key)
  do update set status = excluded.status
  returning id into v_delivery_id;

  if v_delivery_id is null then
    raise exception 'FAIL 5b: Sage delivery log with required fields should insert after reset';
  end if;

  insert into public.integration_delivery_log (
    integration_id, tenant_id, connector_key, exchange_key,
    direction, scope_key, source_of_truth, idempotency_key, status, request_payload
  ) values (
    v_integration_id, v_tenant_id, 'sage', 'erp_finance',
    'outbound', 'invoice_sync', 'wynne', 'sage-reset-inv-002', 'sent',
    jsonb_build_object(
      'external_id', 'SG-RESET-INV-1002', 'entity_type', 'invoice',
      'entity_id', 'inv-r02', 'posting_state', 'posted'
    )
  )
  on conflict (tenant_id, connector_key, direction, exchange_key, idempotency_key)
  do update set status = excluded.status, request_payload = excluded.request_payload;

  select count(*) into v_count
  from public.integration_delivery_log
  where tenant_id = v_tenant_id
    and connector_key = 'sage'
    and exchange_key = 'erp_finance'
    and idempotency_key = 'sage-reset-inv-002';

  if v_count <> 1 then
    raise exception 'FAIL 5b: replay upsert should preserve one Sage delivery row, got %', v_count;
  end if;

  raise notice 'PASS 5b: delivery log idempotent upsert preserves one row after reset';

  -- 6. external_id_map: external_id immutability guard and stable-id replay ──
  insert into public.external_id_map (
    tenant_id, connector_key, provider, exchange_key,
    entity_type, entity_id, wynne_entity_id, external_id, external_system, metadata
  ) values (
    v_tenant_id, 'sage', 'sage', 'erp_finance',
    'invoice', 'inv-r02', v_wynne_entity_id, 'SG-RESET-INV-1002', 'sage',
    jsonb_build_object('source', 'initial')
  )
  returning id into v_alias_id;

  v_blocked := false;
  begin
    update public.external_id_map
       set external_id = 'SG-RESET-INV-CHANGED'
     where id = v_alias_id;
  exception
    when others then
      if sqlstate = 'P0001' then v_blocked := true;
      else raise;
      end if;
  end;

  if not v_blocked then
    raise exception 'FAIL 6: Sage external_id update should be blocked for immutability after reset';
  end if;

  insert into public.external_id_map (
    tenant_id, connector_key, provider, exchange_key,
    entity_type, entity_id, wynne_entity_id, external_id, external_system, metadata
  ) values (
    v_tenant_id, 'sage', 'sage', 'erp_finance',
    'invoice', 'inv-r02', v_wynne_entity_id, 'SG-RESET-INV-1002', 'sage',
    jsonb_build_object('source', 'replay')
  )
  on conflict (tenant_id, connector_key, exchange_key, entity_type, entity_id)
  do update set metadata = excluded.metadata;

  select count(*) into v_count
  from public.external_id_map
  where tenant_id = v_tenant_id
    and connector_key = 'sage'
    and exchange_key = 'erp_finance'
    and entity_type = 'invoice'
    and entity_id = 'inv-r02'
    and external_id = 'SG-RESET-INV-1002';

  if v_count <> 1 then
    raise exception 'FAIL 6: replay upsert should preserve one stable Sage external_id row, got %', v_count;
  end if;

  raise notice 'PASS 6: external_id immutability guard and stable-id replay work after reset';

  -- 7. integration_sync_state cursor advancement preserves one row ───────────
  insert into public.integration_sync_state (
    integration_id, tenant_id, connector_key, exchange_key, scope_key,
    source_of_truth, direction, cursor, last_success_at, state
  ) values (
    v_integration_id, v_tenant_id, 'sage', 'erp_finance', 'invoice:inv-r02',
    'wynne', 'outbound', 'cursor-r1', now(),
    jsonb_build_object('posting_state', 'pending', 'delivery_log_id', v_delivery_id)
  )
  on conflict (tenant_id, connector_key, exchange_key, scope_key)
  do update set cursor = excluded.cursor,
               last_success_at = excluded.last_success_at,
               state = excluded.state;

  insert into public.integration_sync_state (
    integration_id, tenant_id, connector_key, exchange_key, scope_key,
    source_of_truth, direction, cursor, last_success_at, state
  ) values (
    v_integration_id, v_tenant_id, 'sage', 'erp_finance', 'invoice:inv-r02',
    'wynne', 'outbound', 'cursor-r2', now(),
    jsonb_build_object('posting_state', 'posted', 'delivery_log_id', v_delivery_id)
  )
  on conflict (tenant_id, connector_key, exchange_key, scope_key)
  do update set cursor = excluded.cursor,
               last_success_at = excluded.last_success_at,
               state = excluded.state;

  select count(*) into v_count
  from public.integration_sync_state
  where tenant_id = v_tenant_id
    and connector_key = 'sage'
    and exchange_key = 'erp_finance'
    and scope_key = 'invoice:inv-r02';

  if v_count <> 1 then
    raise exception 'FAIL 7: cursor advancement should upsert one Sage sync-state row, got %', v_count;
  end if;

  select state ->> 'posting_state' into v_posting_state
  from public.integration_sync_state
  where tenant_id = v_tenant_id
    and connector_key = 'sage'
    and exchange_key = 'erp_finance'
    and scope_key = 'invoice:inv-r02';

  if coalesce(v_posting_state, '') <> 'posted' then
    raise exception 'FAIL 7: posting_state should be ''posted'' after cursor replay, got %', coalesce(v_posting_state, '<null>');
  end if;

  raise notice 'PASS 7: sync-state cursor advancement preserves one row with correct posting_state after reset';
end;
$$;

rollback;
