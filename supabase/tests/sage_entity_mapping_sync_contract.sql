begin;

do $$
declare
  v_tenant_id uuid := '30000000-0000-0000-0000-000000001367';
  v_tenant_key text := 'tenant-sage-1367';
  v_other_tenant_id uuid := '30000000-0000-0000-0000-000000001368';
  v_other_tenant_key text := 'tenant-sage-1368';
  v_integration_id uuid;
  v_other_integration_id uuid;
  v_alias_id uuid;
  v_wynne_entity_id uuid := '40000000-0000-0000-0000-000000001367';
  v_delivery_id uuid;
  v_count int;
  v_blocked boolean;
  v_posting_state text;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  insert into public.tenants (id, tenant_key, name)
  values (v_tenant_id, v_tenant_key, 'Sage Contract Test Tenant')
  on conflict (id) do update set tenant_key = excluded.tenant_key, name = excluded.name;

  insert into public.tenants (id, tenant_key, name)
  values (v_other_tenant_id, v_other_tenant_key, 'Sage Contract Other Tenant')
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
    'sage',
    'sage',
    'sage',
    'Sage Finance Connector',
    'oauth2',
    jsonb_build_object(
      'invoice', jsonb_build_object('entity_id', 'id', 'external_id', 'invoiceNumber', 'posting_state', 'postingState'),
      'general_ledger', jsonb_build_object('entity_id', 'entryLineId', 'external_id', 'journalNumber', 'posting_state', 'postingState'),
      'accounts_payable', jsonb_build_object('entity_id', 'lineId', 'external_id', 'documentNumber', 'posting_state', 'postingState'),
      'accounts_receivable', jsonb_build_object('entity_id', 'lineId', 'external_id', 'documentNumber', 'posting_state', 'postingState')
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
    'sage',
    'sage',
    'sage',
    'Sage Finance Connector (Other Tenant)',
    'oauth2',
    jsonb_build_object('invoice', jsonb_build_object('entity_id', 'id', 'external_id', 'invoiceNumber', 'posting_state', 'postingState')),
    jsonb_build_object('environment', 'sandbox'),
    true
  )
  returning id into v_other_integration_id;

  select count(*) into v_count
  from jsonb_array_elements(public.sage_supported_entity_contract() -> 'entities') e
  where
    (e ->> 'entity_type' = 'invoice' and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'general_ledger' and e ->> 'direction' = 'outbound')
    or (e ->> 'entity_type' = 'accounts_payable' and e ->> 'direction' = 'inbound')
    or (e ->> 'entity_type' = 'accounts_receivable' and e ->> 'direction' = 'inbound');

  if v_count <> 4 then
    raise exception 'Expected 4 required Sage entities+directions, got %', v_count;
  end if;

  select count(*) into v_count
  from jsonb_array_elements(public.sage_supported_entity_contract() -> 'entities') e
  where nullif(btrim(coalesce(e ->> 'conflict_rule', '')), '') is null
     or nullif(btrim(coalesce(e ->> 'reconciliation_behavior', '')), '') is null;

  if v_count <> 0 then
    raise exception 'Expected explicit conflict_rule/reconciliation_behavior for each Sage entity class';
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
  from public.v_sage_entity_mapping_contract
  where integration_id = v_integration_id;

  if v_count <> 1 then
    raise exception 'Expected admin to read Sage mapping contract row, got %', v_count;
  end if;

  select count(*) into v_count
  from public.v_sage_entity_mapping_contract
  where integration_id = v_other_integration_id;

  if v_count <> 0 then
    raise exception 'Expected tenant isolation to hide cross-tenant Sage mapping contract rows, got %', v_count;
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
  from public.v_sage_entity_mapping_contract;

  if v_count <> 0 then
    raise exception 'Expected read_only tenant role to be denied Sage mapping contract rows, got %', v_count;
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
      'sage',
      'erp_finance',
      'outbound',
      'invoice_sync',
      'wynne',
      'sage-invoice-001',
      'pending',
      jsonb_build_object('entity_type', 'invoice', 'entity_id', 'inv-001', 'posting_state', 'posted')
    );
  exception
    when check_violation then v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'Expected Sage payload missing external_id to fail check constraint';
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
    'sage',
    'erp_finance',
    'outbound',
    'invoice_sync',
    'wynne',
    'sage-invoice-002',
    'pending',
    jsonb_build_object(
      'external_id', 'SG-INV-1002',
      'entity_type', 'invoice',
      'entity_id', 'inv-002',
      'posting_state', 'posted'
    )
  )
  on conflict (tenant_id, connector_key, direction, exchange_key, idempotency_key)
  do update set status = excluded.status
  returning id into v_delivery_id;

  if v_delivery_id is null then
    raise exception 'Expected Sage payload with required external identifier fields to insert';
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
    'sage',
    'erp_finance',
    'outbound',
    'invoice_sync',
    'wynne',
    'sage-invoice-002',
    'sent',
    jsonb_build_object(
      'external_id', 'SG-INV-1002',
      'entity_type', 'invoice',
      'entity_id', 'inv-002',
      'posting_state', 'posted'
    )
  )
  on conflict (tenant_id, connector_key, direction, exchange_key, idempotency_key)
  do update
    set status = excluded.status,
        request_payload = excluded.request_payload;

  select count(*) into v_count
  from public.integration_delivery_log
  where tenant_id = v_tenant_id
    and connector_key = 'sage'
    and exchange_key = 'erp_finance'
    and idempotency_key = 'sage-invoice-002';

  if v_count <> 1 then
    raise exception 'Expected duplicate delivery/replay to preserve one Sage delivery row, got %', v_count;
  end if;

  insert into public.external_id_map (
    tenant_id,
    connector_key,
    provider,
    exchange_key,
    entity_type,
    entity_id,
    wynne_entity_id,
    external_id,
    external_system,
    metadata
  ) values (
    v_tenant_id,
    'sage',
    'sage',
    'erp_finance',
    'invoice',
    'inv-002',
    v_wynne_entity_id,
    'SG-INV-1002',
    'sage',
    jsonb_build_object('source', 'initial')
  )
  returning id into v_alias_id;

  v_blocked := false;
  begin
    update public.external_id_map
       set external_id = 'SG-INV-UPDATED'
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
    raise exception 'Expected Sage external_id updates to be blocked for idempotency safety';
  end if;

  insert into public.external_id_map (
    tenant_id,
    connector_key,
    provider,
    exchange_key,
    entity_type,
    entity_id,
    wynne_entity_id,
    external_id,
    external_system,
    metadata
  ) values (
    v_tenant_id,
    'sage',
    'sage',
    'erp_finance',
    'invoice',
    'inv-002',
    v_wynne_entity_id,
    'SG-INV-1002',
    'sage',
    jsonb_build_object('source', 'replay')
  )
  on conflict (tenant_id, connector_key, exchange_key, entity_type, entity_id)
  do update
    set metadata = excluded.metadata;

  select count(*) into v_count
  from public.external_id_map
  where tenant_id = v_tenant_id
    and connector_key = 'sage'
    and exchange_key = 'erp_finance'
    and entity_type = 'invoice'
    and entity_id = 'inv-002'
    and external_id = 'SG-INV-1002';

  if v_count <> 1 then
    raise exception 'Expected replay/upsert to preserve one stable Sage external identifier row, got %', v_count;
  end if;

  insert into public.integration_sync_state (
    integration_id,
    tenant_id,
    connector_key,
    exchange_key,
    scope_key,
    source_of_truth,
    direction,
    cursor,
    last_success_at,
    state
  ) values (
    v_integration_id,
    v_tenant_id,
    'sage',
    'erp_finance',
    'invoice:inv-002',
    'wynne',
    'outbound',
    'cursor-1',
    now(),
    jsonb_build_object('posting_state', 'pending', 'delivery_log_id', v_delivery_id)
  )
  on conflict (tenant_id, connector_key, exchange_key, scope_key)
  do update
    set cursor = excluded.cursor,
        last_success_at = excluded.last_success_at,
        state = excluded.state;

  insert into public.integration_sync_state (
    integration_id,
    tenant_id,
    connector_key,
    exchange_key,
    scope_key,
    source_of_truth,
    direction,
    cursor,
    last_success_at,
    state
  ) values (
    v_integration_id,
    v_tenant_id,
    'sage',
    'erp_finance',
    'invoice:inv-002',
    'wynne',
    'outbound',
    'cursor-2',
    now(),
    jsonb_build_object('posting_state', 'posted', 'delivery_log_id', v_delivery_id)
  )
  on conflict (tenant_id, connector_key, exchange_key, scope_key)
  do update
    set cursor = excluded.cursor,
        last_success_at = excluded.last_success_at,
        state = excluded.state;

  select count(*) into v_count
  from public.integration_sync_state
  where tenant_id = v_tenant_id
    and connector_key = 'sage'
    and exchange_key = 'erp_finance'
    and scope_key = 'invoice:inv-002';

  if v_count <> 1 then
    raise exception 'Expected restart/replay cursor advancement to upsert one Sage sync-state row, got %', v_count;
  end if;

  select state ->> 'posting_state' into v_posting_state
  from public.integration_sync_state
  where tenant_id = v_tenant_id
    and connector_key = 'sage'
    and exchange_key = 'erp_finance'
    and scope_key = 'invoice:inv-002';

  if coalesce(v_posting_state, '') <> 'posted' then
    raise exception 'Expected accounting posting_state to stay correct after replay/restart upsert, got %', coalesce(v_posting_state, '<null>');
  end if;

  raise notice 'PASS sage entity mapping and sync contract';
end;
$$;

rollback;
