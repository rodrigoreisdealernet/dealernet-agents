-- Reset-path validation for NetSuite entity mapping and sync contract
-- (migration 20260612214000_netsuite_entity_mapping_sync_contract.sql).
--
-- Confirms that a fully-reset schema still supports:
--   1.  netsuite_supported_entity_contract() function exists and returns expected
--       entity/direction shape (5 entries)
--   2.  v_netsuite_entity_mapping_contract view exists with security_invoker = true
--   3.  trg_external_id_map_netsuite_external_id_guard trigger exists on external_id_map
--   4.  integration_delivery_log NetSuite check constraint exists
--   5.  Replay-safe delivery log: constraint blocks missing external_id, allows
--       correct payload, and idempotent upsert preserves one row
--   6.  Replay-safe external_id_map: external_id immutability guard fires on
--       UPDATE; stable-id replay upsert preserves one row
--
-- All data is inserted and rolled back; this script makes no lasting changes.

begin;

-- ── 1. netsuite_supported_entity_contract() function exists and returns expected shape ──
do $$
declare
  v_count int;
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'netsuite_supported_entity_contract'
  ) then
    raise exception 'FAIL 1: public.netsuite_supported_entity_contract() not found after reset';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(public.netsuite_supported_entity_contract() -> 'entities') e
  where
    (e ->> 'entity_type' = 'customer'            and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'invoice'           and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'general_ledger'    and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'accounts_payable'  and e ->> 'direction' = 'inbound')
    or (e ->> 'entity_type' = 'accounts_receivable' and e ->> 'direction' = 'inbound');

  if v_count <> 5 then
    raise exception 'FAIL 1: expected 5 NetSuite entity+direction entries, got %', v_count;
  end if;

  select count(*) into v_count
  from jsonb_array_elements(
    public.netsuite_supported_entity_contract() -> 'required_external_identifier_fields'
  ) f
  where f #>> '{}' in ('idempotency_key', 'external_id', 'entity_type', 'entity_id');

  if v_count <> 4 then
    raise exception 'FAIL 1: expected 4 required_external_identifier_fields, got %', v_count;
  end if;

  raise notice 'PASS 1: netsuite_supported_entity_contract() returns expected shape after reset';
end;
$$;

-- ── 2. v_netsuite_entity_mapping_contract view exists with security_invoker = true ──
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
     and c.relname = 'v_netsuite_entity_mapping_contract'
     and opt.option_name = 'security_invoker';

  if not found then
    raise exception 'FAIL 2: public.v_netsuite_entity_mapping_contract not found or security_invoker option missing after reset';
  end if;

  if not coalesce(v_invoker, false) then
    raise exception 'FAIL 2: public.v_netsuite_entity_mapping_contract does not have security_invoker = true after reset';
  end if;

  raise notice 'PASS 2: v_netsuite_entity_mapping_contract exists with security_invoker = true after reset';
end;
$$;

-- ── 3. trg_external_id_map_netsuite_external_id_guard trigger exists ──────────
do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'external_id_map'
      and t.tgname = 'trg_external_id_map_netsuite_external_id_guard'
      and not t.tgisinternal
  ) then
    raise exception 'FAIL 3: trg_external_id_map_netsuite_external_id_guard trigger not found after reset';
  end if;

  raise notice 'PASS 3: trg_external_id_map_netsuite_external_id_guard trigger exists after reset';
end;
$$;

-- ── 4. integration_delivery_log NetSuite check constraint exists ──────────────
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'integration_delivery_log_netsuite_external_identifier_chk'
      and conrelid = 'public.integration_delivery_log'::regclass
  ) then
    raise exception 'FAIL 4: integration_delivery_log_netsuite_external_identifier_chk not found after reset';
  end if;

  raise notice 'PASS 4: NetSuite check constraint exists on integration_delivery_log after reset';
end;
$$;

-- ── 5–6. Replay-safe end-to-end flow ─────────────────────────────────────────
do $$
declare
  v_tenant_id uuid := '30000000-0000-0000-0000-000000009214';
  v_tenant_key text := 'tenant-netsuite-reset-9214';
  v_integration_id uuid;
  v_alias_id uuid;
  v_dia_entity_id uuid := '40000000-0000-0000-0000-000000009214';
  v_delivery_id uuid;
  v_count int;
  v_blocked boolean;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  insert into public.tenants (id, tenant_key, name)
  values (v_tenant_id, v_tenant_key, 'NetSuite Reset Test Tenant')
  on conflict (id) do update set tenant_key = excluded.tenant_key, name = excluded.name;

  insert into public.integration_config (
    tenant_id, connector_key, provider, provider_key, display_name,
    auth_type, mappings, settings, enabled
  ) values (
    v_tenant_id, 'netsuite', 'netsuite', 'netsuite', 'NetSuite Reset Connector',
    'oauth2',
    jsonb_build_object(
      'customer',           jsonb_build_object('entity_id', 'internalId',    'external_id', 'entityId'),
      'invoice',            jsonb_build_object('entity_id', 'internalId',    'external_id', 'tranId'),
      'general_ledger',     jsonb_build_object('entity_id', 'lineUniqueKey', 'external_id', 'tranId'),
      'accounts_payable',   jsonb_build_object('entity_id', 'billId',        'external_id', 'tranId'),
      'accounts_receivable',jsonb_build_object('entity_id', 'arLineId',      'external_id', 'tranId')
    ),
    jsonb_build_object('environment', 'sandbox'),
    true
  )
  returning id into v_integration_id;

  -- 5a. Delivery log: constraint blocks missing external_id ───────────────────
  v_blocked := false;
  begin
    insert into public.integration_delivery_log (
      integration_id, tenant_id, connector_key, exchange_key,
      direction, scope_key, source_of_truth, idempotency_key, status, request_payload
    ) values (
      v_integration_id, v_tenant_id, 'netsuite', 'erp_finance',
      'outbound', 'invoice_sync', 'dia', 'ns-reset-inv-001', 'pending',
      jsonb_build_object('entity_type', 'invoice', 'entity_id', 'inv-r01')
    );
  exception
    when check_violation then v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL 5a: NetSuite delivery log payload missing external_id should be blocked after reset';
  end if;

  raise notice 'PASS 5a: delivery log constraint blocks missing external_id after reset';

  -- 5b. Delivery log: correct payload inserts and idempotent upsert preserves one row
  insert into public.integration_delivery_log (
    integration_id, tenant_id, connector_key, exchange_key,
    direction, scope_key, source_of_truth, idempotency_key, status, request_payload
  ) values (
    v_integration_id, v_tenant_id, 'netsuite', 'erp_finance',
    'outbound', 'invoice_sync', 'dia', 'ns-reset-inv-002', 'pending',
    jsonb_build_object(
      'external_id', 'NS-RESET-INV-1002', 'entity_type', 'invoice',
      'entity_id', 'inv-r02'
    )
  )
  on conflict (tenant_id, connector_key, direction, exchange_key, idempotency_key)
  do update set status = excluded.status
  returning id into v_delivery_id;

  if v_delivery_id is null then
    raise exception 'FAIL 5b: NetSuite delivery log with required fields should insert after reset';
  end if;

  insert into public.integration_delivery_log (
    integration_id, tenant_id, connector_key, exchange_key,
    direction, scope_key, source_of_truth, idempotency_key, status, request_payload
  ) values (
    v_integration_id, v_tenant_id, 'netsuite', 'erp_finance',
    'outbound', 'invoice_sync', 'dia', 'ns-reset-inv-002', 'sent',
    jsonb_build_object(
      'external_id', 'NS-RESET-INV-1002', 'entity_type', 'invoice',
      'entity_id', 'inv-r02'
    )
  )
  on conflict (tenant_id, connector_key, direction, exchange_key, idempotency_key)
  do update set status = excluded.status, request_payload = excluded.request_payload;

  select count(*) into v_count
  from public.integration_delivery_log
  where tenant_id = v_tenant_id
    and connector_key = 'netsuite'
    and exchange_key = 'erp_finance'
    and idempotency_key = 'ns-reset-inv-002';

  if v_count <> 1 then
    raise exception 'FAIL 5b: replay upsert should preserve one NetSuite delivery row, got %', v_count;
  end if;

  raise notice 'PASS 5b: delivery log idempotent upsert preserves one row after reset';

  -- 6. external_id_map: external_id immutability guard and stable-id replay ───
  insert into public.external_id_map (
    tenant_id, connector_key, provider, exchange_key,
    entity_type, entity_id, dia_entity_id, external_id, external_system, metadata
  ) values (
    v_tenant_id, 'netsuite', 'netsuite', 'erp_finance',
    'invoice', 'inv-r02', v_dia_entity_id, 'NS-RESET-INV-1002', 'netsuite',
    jsonb_build_object('source', 'initial')
  )
  returning id into v_alias_id;

  v_blocked := false;
  begin
    update public.external_id_map
       set external_id = 'NS-RESET-INV-CHANGED'
     where id = v_alias_id;
  exception
    when others then
      if sqlstate = 'P0001' then v_blocked := true;
      else raise;
      end if;
  end;

  if not v_blocked then
    raise exception 'FAIL 6: NetSuite external_id update should be blocked for immutability after reset';
  end if;

  insert into public.external_id_map (
    tenant_id, connector_key, provider, exchange_key,
    entity_type, entity_id, dia_entity_id, external_id, external_system, metadata
  ) values (
    v_tenant_id, 'netsuite', 'netsuite', 'erp_finance',
    'invoice', 'inv-r02', v_dia_entity_id, 'NS-RESET-INV-1002', 'netsuite',
    jsonb_build_object('source', 'replay')
  )
  on conflict (tenant_id, connector_key, exchange_key, entity_type, entity_id)
  do update set metadata = excluded.metadata;

  select count(*) into v_count
  from public.external_id_map
  where tenant_id = v_tenant_id
    and connector_key = 'netsuite'
    and exchange_key = 'erp_finance'
    and entity_type = 'invoice'
    and entity_id = 'inv-r02'
    and external_id = 'NS-RESET-INV-1002';

  if v_count <> 1 then
    raise exception 'FAIL 6: replay upsert should preserve one stable NetSuite external_id row, got %', v_count;
  end if;

  raise notice 'PASS 6: external_id immutability guard and stable-id replay work after reset';
end;
$$;

rollback;
