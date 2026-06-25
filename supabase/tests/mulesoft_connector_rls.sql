-- Behavioral RLS + compatibility checks for the MuleSoft connector tables.
-- Validates the shared table contract is replay-safe and that only admin /
-- branch_manager can read or write inside their own tenant scope.

begin;

-- ── 1. Contract / grant smoke checks ─────────────────────────────────────────
do $$
declare
  v_count int;
begin
  -- 10 integration_config + 8 integration_delivery_log + 8 external_id_map +
  -- 9 integration_sync_state compatibility columns from the shared contract.
  select count(*)
    into v_count
    from information_schema.columns
   where table_schema = 'public'
     and (
       (table_name = 'integration_config' and column_name in ('id', 'tenant_id', 'connector_key', 'provider', 'provider_key', 'settings', 'secret_refs', 'mappings', 'connection_config', 'feature_config'))
       or (table_name = 'integration_delivery_log' and column_name in ('integration_id', 'tenant_id', 'connector_key', 'exchange_key', 'idempotency_key', 'scope_key', 'request_payload', 'response_payload'))
       or (table_name = 'external_id_map' and column_name in ('tenant_id', 'connector_key', 'provider', 'exchange_key', 'entity_type', 'entity_id', 'wynne_entity_id', 'external_system'))
       or (table_name = 'integration_sync_state' and column_name in ('integration_id', 'tenant_id', 'connector_key', 'exchange_key', 'scope_key', 'cursor', 'cursor_value', 'state', 'metadata'))
     );

  if v_count <> 35 then
    raise exception 'Expected 35 compatibility columns across MuleSoft connector tables, found %', v_count;
  end if;

  if not has_table_privilege('authenticated', 'public.integration_config', 'SELECT, INSERT, UPDATE') then
    raise exception 'Expected authenticated SELECT/INSERT/UPDATE grants on integration_config';
  end if;
  if not has_table_privilege('authenticated', 'public.integration_delivery_log', 'SELECT, INSERT, UPDATE') then
    raise exception 'Expected authenticated SELECT/INSERT/UPDATE grants on integration_delivery_log';
  end if;
  if not has_table_privilege('authenticated', 'public.external_id_map', 'SELECT, INSERT, UPDATE') then
    raise exception 'Expected authenticated SELECT/INSERT/UPDATE grants on external_id_map';
  end if;
  if not has_table_privilege('authenticated', 'public.integration_sync_state', 'SELECT, INSERT, UPDATE') then
    raise exception 'Expected authenticated SELECT/INSERT/UPDATE grants on integration_sync_state';
  end if;

  if has_table_privilege('authenticated', 'public.integration_config', 'DELETE')
     or has_table_privilege('authenticated', 'public.integration_delivery_log', 'DELETE')
     or has_table_privilege('authenticated', 'public.external_id_map', 'DELETE')
     or has_table_privilege('authenticated', 'public.integration_sync_state', 'DELETE') then
    raise exception 'Authenticated must not receive DELETE on integration connector tables';
  end if;

  raise notice 'PASS 1: compatibility columns and grants are present';
end;
$$;

-- ── 2. Fixture setup (superuser / service context) ──────────────────────────
do $$
declare
  v_tenant_a uuid := 'a1111111-1111-1111-1111-111111111111';
  v_tenant_b uuid := 'b2222222-2222-2222-2222-222222222222';
begin
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a, 'mulesoft-test-a', 'MuleSoft Test A'),
    (v_tenant_b, 'mulesoft-test-b', 'MuleSoft Test B')
  on conflict (id) do update
    set tenant_key = excluded.tenant_key,
        name = excluded.name;

  insert into public.integration_config (
    id,
    tenant_id,
    connector_key,
    provider,
    provider_key,
    auth_type,
    enabled,
    settings,
    mappings,
    secret_refs,
    schedule,
    connection_config,
    feature_config
  ) values
    (
      '10000000-0000-0000-0000-000000000001'::uuid,
      v_tenant_a,
      'mulesoft',
      'mulesoft',
      'mulesoft',
      'client_credentials',
      true,
      '{"base_url":"https://tenant-a.example.test"}'::jsonb,
      '{}'::jsonb,
      '{"webhook_secret_env":"MULESOFT_TEST_SECRET"}'::jsonb,
      '{}'::jsonb,
      '{"base_url":"https://tenant-a.example.test"}'::jsonb,
      '{}'::jsonb
    ),
    (
      '20000000-0000-0000-0000-000000000002'::uuid,
      v_tenant_b,
      'mulesoft',
      'mulesoft',
      'mulesoft',
      'client_credentials',
      true,
      '{"base_url":"https://tenant-b.example.test"}'::jsonb,
      '{}'::jsonb,
      '{"webhook_secret_env":"MULESOFT_TEST_SECRET"}'::jsonb,
      '{}'::jsonb,
      '{"base_url":"https://tenant-b.example.test"}'::jsonb,
      '{}'::jsonb
    )
  on conflict (tenant_id, connector_key) do update
    set provider = excluded.provider,
        provider_key = excluded.provider_key,
        enabled = excluded.enabled,
        settings = excluded.settings,
        mappings = excluded.mappings,
        secret_refs = excluded.secret_refs,
        schedule = excluded.schedule,
        connection_config = excluded.connection_config,
        feature_config = excluded.feature_config;
end;
$$;

-- ── 3. Admin can read/write same-tenant rows on each table ──────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', '00000000-0000-0000-0000-000000000011',
    'app_metadata', jsonb_build_object('role', 'admin', 'tenant', 'mulesoft-test-a')
  )::text,
  true
);

do $$
declare
  v_count int;
begin
  insert into public.integration_config (
    tenant_id,
    connector_key,
    provider,
    provider_key,
    auth_type,
    enabled,
    settings,
    mappings,
    secret_refs,
    schedule
  ) values (
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'mulesoft_admin',
    'mulesoft_admin',
    'mulesoft_admin',
    'client_credentials',
    true,
    '{"base_url":"https://admin.example.test"}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb
  );

  insert into public.integration_delivery_log (
    tenant_id,
    connector_key,
    exchange_key,
    direction,
    scope_key,
    entity_type,
    entity_id,
    source_of_truth,
    idempotency_key,
    status,
    request_payload
  ) values (
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'mulesoft',
    'rental_contract_snapshot',
    'outbound',
    'admin-scope',
    'rental_contract',
    '00000000-0000-0000-0000-000000000101',
    'wynne',
    'admin-delivery',
    'pending',
    '{"contract_id":"contract-admin"}'::jsonb
  );

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
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'mulesoft',
    'mulesoft',
    'rental_contract_snapshot',
    'rental_contract',
    'contract-admin',
    '00000000-0000-0000-0000-000000000201'::uuid,
    'external-admin',
    'mulesoft',
    '{"source":"admin"}'::jsonb
  );

  insert into public.integration_sync_state (
    tenant_id,
    connector_key,
    exchange_key,
    scope_key,
    source_of_truth,
    direction,
    cursor,
    state
  ) values (
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'mulesoft',
    'rental_contract_snapshot',
    'admin-scope',
    'wynne',
    'outbound',
    'cursor-admin',
    '{"source":"admin"}'::jsonb
  );

  select count(*) into v_count from public.integration_config where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid;
  if v_count < 2 then
    raise exception 'FAIL 3a: admin should read same-tenant integration_config rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_config_audit where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid and connector_key = 'mulesoft_admin';
  if v_count < 1 then
    raise exception 'FAIL 3aa: admin should read same-tenant integration_config_audit rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_delivery_log where idempotency_key = 'admin-delivery';
  if v_count <> 1 then
    raise exception 'FAIL 3b: admin delivery log insert/read should succeed; count=%', v_count;
  end if;

  select count(*) into v_count from public.external_id_map where external_id = 'external-admin';
  if v_count <> 1 then
    raise exception 'FAIL 3c: admin external_id_map insert/read should succeed; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_sync_state where scope_key = 'admin-scope';
  if v_count <> 1 then
    raise exception 'FAIL 3d: admin integration_sync_state insert/read should succeed; count=%', v_count;
  end if;

  raise notice 'PASS 3: admin same-tenant reads/writes succeeded on all connector tables';
end;
$$;

-- ── 4. Branch manager can update same-tenant rows on each table ─────────────
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', '00000000-0000-0000-0000-000000000022',
    'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', 'mulesoft-test-a')
  )::text,
  true
);

do $$
declare
  v_count int;
begin
  update public.integration_config
     set settings = jsonb_build_object('base_url', 'https://manager.example.test')
   where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'mulesoft_admin';
  if not found then
    raise exception 'FAIL 4a: branch_manager integration_config update should succeed';
  end if;

  update public.integration_delivery_log
     set status = 'processed'
   where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid
     and idempotency_key = 'admin-delivery';
  if not found then
    raise exception 'FAIL 4b: branch_manager integration_delivery_log update should succeed';
  end if;

  update public.external_id_map
     set metadata = jsonb_build_object('updated_by', 'branch_manager')
   where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid
     and external_id = 'external-admin';
  if not found then
    raise exception 'FAIL 4c: branch_manager external_id_map update should succeed';
  end if;

  update public.integration_sync_state
     set cursor = 'cursor-manager',
         state = jsonb_build_object('updated_by', 'branch_manager')
   where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid
     and scope_key = 'admin-scope';
  if not found then
    raise exception 'FAIL 4d: branch_manager integration_sync_state update should succeed';
  end if;

  select count(*) into v_count from public.integration_config where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid;
  if v_count < 2 then
    raise exception 'FAIL 4e: branch_manager should read same-tenant integration_config rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_config_audit where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid and connector_key = 'mulesoft_admin';
  if v_count < 1 then
    raise exception 'FAIL 4ea: branch_manager should read same-tenant integration_config_audit rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_delivery_log where idempotency_key = 'admin-delivery';
  if v_count <> 1 then
    raise exception 'FAIL 4f: branch_manager should read same-tenant integration_delivery_log rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.external_id_map where external_id = 'external-admin';
  if v_count <> 1 then
    raise exception 'FAIL 4g: branch_manager should read same-tenant external_id_map rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_sync_state where scope_key = 'admin-scope';
  if v_count <> 1 then
    raise exception 'FAIL 4h: branch_manager should read same-tenant integration_sync_state rows; count=%', v_count;
  end if;

  raise notice 'PASS 4: branch_manager same-tenant reads/writes succeeded on all connector tables';
end;
$$;

-- 5. field_operator cannot read or write same-tenant rows
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', '00000000-0000-0000-0000-000000000033',
    'app_metadata', jsonb_build_object('role', 'field_operator', 'tenant', 'mulesoft-test-a')
  )::text,
  true
);

do $$
declare
  v_blocked bool;
  v_count int;
begin
  select count(*) into v_count from public.integration_config where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid;
  if v_count <> 0 then
    raise exception 'FAIL 5a: field_operator should not read integration_config rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_config_audit where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid and connector_key = 'mulesoft_admin';
  if v_count <> 0 then
    raise exception 'FAIL 5aa: field_operator should not read integration_config_audit rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_delivery_log where idempotency_key = 'admin-delivery';
  if v_count <> 0 then
    raise exception 'FAIL 5b: field_operator should not read integration_delivery_log rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.external_id_map where external_id = 'external-admin';
  if v_count <> 0 then
    raise exception 'FAIL 5c: field_operator should not read external_id_map rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_sync_state where scope_key = 'admin-scope';
  if v_count <> 0 then
    raise exception 'FAIL 5d: field_operator should not read integration_sync_state rows; count=%', v_count;
  end if;

  v_blocked := false;
  begin
    insert into public.integration_config (tenant_id, connector_key, provider, provider_key, auth_type, enabled, settings, mappings, secret_refs, schedule)
    values ('a1111111-1111-1111-1111-111111111111'::uuid, 'mulesoft_field_operator', 'mulesoft_field_operator', 'mulesoft_field_operator', 'client_credentials', true, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 5e: field_operator should not insert integration_config';
  end if;

  v_blocked := false;
  begin
    insert into public.integration_delivery_log (
      tenant_id, connector_key, exchange_key, direction, scope_key, entity_type, entity_id, source_of_truth, idempotency_key, status, request_payload
    ) values (
      'a1111111-1111-1111-1111-111111111111'::uuid,
      'mulesoft',
      'rental_contract_snapshot',
      'outbound',
      'field-operator-scope',
      'rental_contract',
      '00000000-0000-0000-0000-000000000102',
      'wynne',
      'field-operator-delivery',
      'pending',
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 5f: field_operator should not insert integration_delivery_log';
  end if;

  v_blocked := false;
  begin
    insert into public.external_id_map (
      tenant_id, connector_key, provider, exchange_key, entity_type, entity_id, wynne_entity_id, external_id, external_system, metadata
    ) values (
      'a1111111-1111-1111-1111-111111111111'::uuid,
      'mulesoft',
      'mulesoft',
      'rental_contract_snapshot',
      'rental_contract',
      'contract-field',
      '00000000-0000-0000-0000-000000000202'::uuid,
      'external-field',
      'mulesoft',
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 5g: field_operator should not insert external_id_map';
  end if;

  v_blocked := false;
  begin
    insert into public.integration_sync_state (
      tenant_id, connector_key, exchange_key, scope_key, source_of_truth, direction, cursor, state
    ) values (
      'a1111111-1111-1111-1111-111111111111'::uuid,
      'mulesoft',
      'rental_contract_snapshot',
      'field-operator-scope',
      'wynne',
      'outbound',
      'cursor-field',
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 5h: field_operator should not insert integration_sync_state';
  end if;

  raise notice 'PASS 5: field_operator reads/writes blocked on all connector tables';
end;
$$;

-- 6. read_only cannot read or write same-tenant rows
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', '00000000-0000-0000-0000-000000000044',
    'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'mulesoft-test-a')
  )::text,
  true
);

do $$
declare
  v_blocked bool;
  v_count int;
begin
  select count(*) into v_count from public.integration_config where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid;
  if v_count <> 0 then
    raise exception 'FAIL 6a: read_only should not read integration_config rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_config_audit where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid and connector_key = 'mulesoft_admin';
  if v_count <> 0 then
    raise exception 'FAIL 6aa: read_only should not read integration_config_audit rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_delivery_log where idempotency_key = 'admin-delivery';
  if v_count <> 0 then
    raise exception 'FAIL 6b: read_only should not read integration_delivery_log rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.external_id_map where external_id = 'external-admin';
  if v_count <> 0 then
    raise exception 'FAIL 6c: read_only should not read external_id_map rows; count=%', v_count;
  end if;

  select count(*) into v_count from public.integration_sync_state where scope_key = 'admin-scope';
  if v_count <> 0 then
    raise exception 'FAIL 6d: read_only should not read integration_sync_state rows; count=%', v_count;
  end if;

  v_blocked := false;
  begin
    insert into public.integration_config (tenant_id, connector_key, provider, provider_key, auth_type, enabled, settings, mappings, secret_refs, schedule)
    values ('a1111111-1111-1111-1111-111111111111'::uuid, 'mulesoft_read_only', 'mulesoft_read_only', 'mulesoft_read_only', 'client_credentials', true, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 6e: read_only should not insert integration_config';
  end if;

  v_blocked := false;
  begin
    insert into public.integration_delivery_log (
      tenant_id, connector_key, exchange_key, direction, scope_key, entity_type, entity_id, source_of_truth, idempotency_key, status, request_payload
    ) values (
      'a1111111-1111-1111-1111-111111111111'::uuid,
      'mulesoft',
      'rental_contract_snapshot',
      'outbound',
      'read-only-scope',
      'rental_contract',
      '00000000-0000-0000-0000-000000000103',
      'wynne',
      'read-only-delivery',
      'pending',
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 6f: read_only should not insert integration_delivery_log';
  end if;

  v_blocked := false;
  begin
    insert into public.external_id_map (
      tenant_id, connector_key, provider, exchange_key, entity_type, entity_id, wynne_entity_id, external_id, external_system, metadata
    ) values (
      'a1111111-1111-1111-1111-111111111111'::uuid,
      'mulesoft',
      'mulesoft',
      'rental_contract_snapshot',
      'rental_contract',
      'contract-read-only',
      '00000000-0000-0000-0000-000000000203'::uuid,
      'external-read-only',
      'mulesoft',
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 6g: read_only should not insert external_id_map';
  end if;

  v_blocked := false;
  begin
    insert into public.integration_sync_state (
      tenant_id, connector_key, exchange_key, scope_key, source_of_truth, direction, cursor, state
    ) values (
      'a1111111-1111-1111-1111-111111111111'::uuid,
      'mulesoft',
      'rental_contract_snapshot',
      'read-only-scope',
      'wynne',
      'outbound',
      'cursor-read-only',
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 6h: read_only should not insert integration_sync_state';
  end if;

  raise notice 'PASS 6: read_only reads/writes blocked on all connector tables';
end;
$$;

-- ── 7. Cross-tenant writes are blocked on each table ────────────────────────
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', '00000000-0000-0000-0000-000000000055',
    'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', 'mulesoft-test-b')
  )::text,
  true
);

do $$
declare
  v_blocked bool;
  v_count int;
begin
  select count(*) into v_count from public.integration_config_audit where tenant_id = 'a1111111-1111-1111-1111-111111111111'::uuid and connector_key = 'mulesoft_admin';
  if v_count <> 0 then
    raise exception 'FAIL 7aa: cross-tenant integration_config_audit read should be blocked; count=%', v_count;
  end if;

  v_blocked := false;
  begin
    insert into public.integration_config (tenant_id, connector_key, provider, provider_key, auth_type, enabled, settings, mappings, secret_refs, schedule)
    values ('a1111111-1111-1111-1111-111111111111'::uuid, 'mulesoft_cross_tenant', 'mulesoft_cross_tenant', 'mulesoft_cross_tenant', 'client_credentials', true, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 7a: cross-tenant integration_config insert should be blocked';
  end if;

  v_blocked := false;
  begin
    insert into public.integration_delivery_log (
      tenant_id, connector_key, exchange_key, direction, scope_key, entity_type, entity_id, source_of_truth, idempotency_key, status, request_payload
    ) values (
      'a1111111-1111-1111-1111-111111111111'::uuid,
      'mulesoft',
      'rental_contract_snapshot',
      'outbound',
      'cross-tenant-scope',
      'rental_contract',
      '00000000-0000-0000-0000-000000000104',
      'wynne',
      'cross-tenant-delivery',
      'pending',
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 7b: cross-tenant integration_delivery_log insert should be blocked';
  end if;

  v_blocked := false;
  begin
    insert into public.external_id_map (
      tenant_id, connector_key, provider, exchange_key, entity_type, entity_id, wynne_entity_id, external_id, external_system, metadata
    ) values (
      'a1111111-1111-1111-1111-111111111111'::uuid,
      'mulesoft',
      'mulesoft',
      'rental_contract_snapshot',
      'rental_contract',
      'contract-cross-tenant',
      '00000000-0000-0000-0000-000000000204'::uuid,
      'external-cross-tenant',
      'mulesoft',
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 7c: cross-tenant external_id_map insert should be blocked';
  end if;

  v_blocked := false;
  begin
    insert into public.integration_sync_state (
      tenant_id, connector_key, exchange_key, scope_key, source_of_truth, direction, cursor, state
    ) values (
      'a1111111-1111-1111-1111-111111111111'::uuid,
      'mulesoft',
      'rental_contract_snapshot',
      'cross-tenant-scope',
      'wynne',
      'outbound',
      'cursor-cross-tenant',
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL 7d: cross-tenant integration_sync_state insert should be blocked';
  end if;

  raise notice 'PASS 7: cross-tenant writes blocked on all connector tables';
end;
$$;

reset role;
rollback;
