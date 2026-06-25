begin;

do $$
declare
  v_tenant_id uuid := '30000000-0000-0000-0000-000000001349';
  v_tenant_key text := 'tenant-netsuite-1349';
  v_other_tenant_id uuid := '30000000-0000-0000-0000-000000001350';
  v_other_tenant_key text := 'tenant-netsuite-1350';
  v_integration_id uuid;
  v_other_integration_id uuid;
  v_alias_id uuid;
  v_dia_entity_id uuid := '40000000-0000-0000-0000-000000001349';
  v_count int;
  v_blocked boolean;
  v_payload_id uuid;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  insert into public.tenants (id, tenant_key, name)
  values (v_tenant_id, v_tenant_key, 'NetSuite Contract Test Tenant')
  on conflict (id) do update set tenant_key = excluded.tenant_key, name = excluded.name;

  insert into public.tenants (id, tenant_key, name)
  values (v_other_tenant_id, v_other_tenant_key, 'NetSuite Contract Other Tenant')
  on conflict (id) do update set tenant_key = excluded.tenant_key, name = excluded.name;

  insert into public.integration_config (
    tenant_id,
    connector_key,
    provider,
    provider_key,
    display_name,
    auth_type,
    mappings,
    settings,
    enabled
  ) values (
    v_tenant_id,
    'netsuite',
    'netsuite',
    'netsuite',
    'NetSuite Finance Connector',
    'oauth2',
    jsonb_build_object(
      'customer', jsonb_build_object('entity_id', 'internalId', 'external_id', 'entityId'),
      'invoice', jsonb_build_object('entity_id', 'internalId', 'external_id', 'tranId'),
      'general_ledger', jsonb_build_object('entity_id', 'lineUniqueKey', 'external_id', 'tranId'),
      'accounts_payable', jsonb_build_object('entity_id', 'billId', 'external_id', 'tranId'),
      'accounts_receivable', jsonb_build_object('entity_id', 'arLineId', 'external_id', 'tranId')
    ),
    jsonb_build_object('environment', 'sandbox'),
    true
  )
  returning id into v_integration_id;

  insert into public.integration_config (
    tenant_id,
    connector_key,
    provider,
    provider_key,
    display_name,
    auth_type,
    mappings,
    settings,
    enabled
  ) values (
    v_other_tenant_id,
    'netsuite',
    'netsuite',
    'netsuite',
    'NetSuite Finance Connector (Other Tenant)',
    'oauth2',
    jsonb_build_object('invoice', jsonb_build_object('entity_id', 'internalId', 'external_id', 'tranId')),
    jsonb_build_object('environment', 'sandbox'),
    true
  )
  returning id into v_other_integration_id;

  select count(*) into v_count
  from jsonb_array_elements(public.netsuite_supported_entity_contract() -> 'entities') e
  where
    (e ->> 'entity_type' = 'customer' and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'invoice' and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'general_ledger' and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'accounts_payable' and e ->> 'direction' = 'inbound')
    or (e ->> 'entity_type' = 'accounts_receivable' and e ->> 'direction' = 'inbound');

  if v_count <> 5 then
    raise exception 'Expected 5 required NetSuite entities+directions, got %', v_count;
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', v_tenant_key, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', v_tenant_key)
    )::text,
    true
  );

  select count(*) into v_count
  from public.v_netsuite_entity_mapping_contract
  where integration_id = v_integration_id;

  if v_count <> 1 then
    raise exception 'Expected admin to read NetSuite mapping contract row, got %', v_count;
  end if;

  select count(*) into v_count
  from public.v_netsuite_entity_mapping_contract
  where integration_id = v_other_integration_id;

  if v_count <> 0 then
    raise exception 'Expected tenant isolation to hide cross-tenant NetSuite mapping contract rows, got %', v_count;
  end if;

  update public.integration_config
     set mappings = mappings || jsonb_build_object(
       'invoice',
       (mappings -> 'invoice') || jsonb_build_object('due_date', 'dueDate')
     )
   where id = v_integration_id;

  if not found then
    raise exception 'Expected admin mapping update to succeed for netsuite integration_config';
  end if;

  if not exists (
    select 1
    from public.integration_config
    where id = v_integration_id
      and mappings -> 'invoice' ->> 'due_date' = 'dueDate'
  ) then
    raise exception 'Expected admin mapping update to persist without code changes';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', v_tenant_key)
    )::text,
    true
  );

  select count(*) into v_count
  from public.v_netsuite_entity_mapping_contract;

  if v_count <> 0 then
    raise exception 'Expected read_only tenant role to be denied NetSuite mapping contract rows, got %', v_count;
  end if;

  select count(*) into v_count
  from public.v_netsuite_entity_mapping_contract
  where integration_id = v_other_integration_id;

  if v_count <> 0 then
    raise exception 'Expected read_only tenant role to be denied cross-tenant NetSuite mapping contract rows, got %', v_count;
  end if;

  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  v_blocked := false;
  begin
    insert into public.integration_delivery_log (
      integration_id,
      tenant_id,
      connector_key,
      exchange_key,
      direction,
      scope_key,
      source_of_truth,
      idempotency_key,
      status,
      request_payload
    ) values (
      v_integration_id,
      v_tenant_id,
      'netsuite',
      'erp_finance',
      'outbound',
      'invoice_sync',
      'dia',
      'netsuite-invoice-001',
      'pending',
      jsonb_build_object('entity_type', 'invoice', 'entity_id', 'inv-001')
    );
  exception
    when check_violation then v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'Expected netsuite payload missing external_id to fail check constraint';
  end if;

  insert into public.integration_delivery_log (
    integration_id,
    tenant_id,
    connector_key,
    exchange_key,
    direction,
    scope_key,
    source_of_truth,
    idempotency_key,
    status,
    request_payload
  ) values (
    v_integration_id,
    v_tenant_id,
    'netsuite',
    'erp_finance',
    'outbound',
    'invoice_sync',
    'dia',
    'netsuite-invoice-002',
    'pending',
    jsonb_build_object('external_id', 'NS-INV-1002', 'entity_type', 'invoice', 'entity_id', 'inv-002')
  )
  returning id into v_payload_id;

  if v_payload_id is null then
    raise exception 'Expected netsuite payload with external identifier fields to insert';
  end if;

  insert into public.external_id_map (
    tenant_id,
    connector_key,
    provider,
    exchange_key,
    entity_type,
    entity_id,
    dia_entity_id,
    external_id,
    external_system,
    metadata
  ) values (
    v_tenant_id,
    'netsuite',
    'netsuite',
    'erp_finance',
    'invoice',
    'inv-002',
    v_dia_entity_id,
    'NS-INV-1002',
    'netsuite',
    jsonb_build_object('source', 'initial')
  )
  returning id into v_alias_id;

  v_blocked := false;
  begin
    update public.external_id_map
       set external_id = 'NS-INV-UPDATED'
     where id = v_alias_id;
  exception
    when others then
      if sqlstate = 'P0001' then
        v_blocked := true;
      else
        raise;
      end if;
  end;

  if not v_blocked then
    raise exception 'Expected netsuite external_id updates to be blocked for idempotency safety';
  end if;

  insert into public.external_id_map (
    tenant_id,
    connector_key,
    provider,
    exchange_key,
    entity_type,
    entity_id,
    dia_entity_id,
    external_id,
    external_system,
    metadata
  ) values (
    v_tenant_id,
    'netsuite',
    'netsuite',
    'erp_finance',
    'invoice',
    'inv-002',
    v_dia_entity_id,
    'NS-INV-1002',
    'netsuite',
    jsonb_build_object('source', 'replay')
  )
  on conflict (tenant_id, connector_key, exchange_key, entity_type, entity_id)
  do update
    set metadata = excluded.metadata;

  select count(*) into v_count
  from public.external_id_map
  where tenant_id = v_tenant_id
    and connector_key = 'netsuite'
    and exchange_key = 'erp_finance'
    and entity_type = 'invoice'
    and entity_id = 'inv-002'
    and external_id = 'NS-INV-1002';

  if v_count <> 1 then
    raise exception 'Expected replay/upsert to preserve one stable external identifier row, got %', v_count;
  end if;

  raise notice 'PASS netsuite entity mapping and sync contract';
end;
$$;

rollback;
