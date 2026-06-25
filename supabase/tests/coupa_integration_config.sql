-- Behavioral tests for Coupa integration_config setup and tenant scoping.
-- Covers create/update/disable, secret-ref isolation, supported scopes, and audit events.

begin;

do $$
declare
  v_tenant_a_id constant uuid := 'cc110000-0000-0000-0000-000000000001';
  v_tenant_b_id constant uuid := 'cc220000-0000-0000-0000-000000000001';
  v_count int;
  v_val text;
begin
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a_id, 'coupa-test-tenant-a', 'Coupa Test Tenant A'),
    (v_tenant_b_id, 'coupa-test-tenant-b', 'Coupa Test Tenant B')
  on conflict (id) do update set tenant_key = excluded.tenant_key, name = excluded.name;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;

  insert into public.integration_config (
    tenant_id, connector_key, provider, provider_key, auth_type, enabled, settings, mappings, secret_refs, schedule
  ) values (
    v_tenant_a_id,
    'coupa',
    'coupa',
    'coupa',
    'client_credentials',
    true,
    jsonb_build_object(
      'api_base_url', 'https://tenant.coupahost.com',
      'tenant_slug', 'wynne-rental-a',
      'enabled_scopes', jsonb_build_array('requisitions', 'purchase_orders'),
      'healthcheck_path', '/api/health',
      'healthcheck_timeout_seconds', 5
    ),
    jsonb_build_object(
      'requisition_mapping_profile', jsonb_build_object('requisition_id_field', 'id'),
      'purchase_order_mapping_profile', jsonb_build_object('purchase_order_id_field', 'id'),
      'supplier_mapping_profile', jsonb_build_object('supplier_id_field', 'id'),
      'invoice_mapping_profile', jsonb_build_object('invoice_id_field', 'id')
    ),
    jsonb_build_object(
      'client_id_secret_ref', 'secret://integrations/coupa/client_id',
      'client_secret_secret_ref', 'secret://integrations/coupa/client_secret'
    ),
    '{}'::jsonb
  )
  on conflict (tenant_id, connector_key) do update
    set enabled = excluded.enabled,
        settings = excluded.settings,
        mappings = excluded.mappings,
        secret_refs = excluded.secret_refs,
        schedule = excluded.schedule;

  -- update and disable to force audit rows
  update public.integration_config
     set settings = settings || jsonb_build_object('tenant_slug', 'wynne-rental-a-v2')
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';

  update public.integration_config
     set enabled = false
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';

  -- seed tenant_b row to validate tenant filtering
  insert into public.integration_config (
    tenant_id, connector_key, provider, provider_key, auth_type, enabled, settings, mappings, secret_refs, schedule
  ) values (
    v_tenant_b_id,
    'coupa',
    'coupa',
    'coupa',
    'client_credentials',
    true,
    jsonb_build_object(
      'api_base_url', 'https://tenant-b.coupahost.com',
      'tenant_slug', 'wynne-rental-b',
      'enabled_scopes', jsonb_build_array('suppliers')
    ),
    jsonb_build_object(
      'supplier_mapping_profile', jsonb_build_object('supplier_id_field', 'id')
    ),
    jsonb_build_object(
      'client_id_secret_ref', 'secret://integrations/coupa/client_id-b',
      'client_secret_secret_ref', 'secret://integrations/coupa/client_secret-b'
    ),
    '{}'::jsonb
  )
  on conflict (tenant_id, connector_key) do update
    set enabled = excluded.enabled,
        settings = excluded.settings,
        mappings = excluded.mappings,
        secret_refs = excluded.secret_refs,
        schedule = excluded.schedule;

  -- secret refs must not appear in settings
  select settings ->> 'client_id_secret_ref'
    into v_val
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';
  if v_val is not null then
    raise exception 'FAIL 1: client_id_secret_ref must not be stored in settings';
  end if;

  select secret_refs ->> 'client_id_secret_ref'
    into v_val
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';
  if v_val is distinct from 'secret://integrations/coupa/client_id' then
    raise exception 'FAIL 2: client_id_secret_ref must be stored in secret_refs';
  end if;

  -- audit rows emitted for insert + update + disable update
  select count(*)
    into v_count
    from public.integration_config_audit
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';
  if v_count < 3 then
    raise exception 'FAIL 3: expected at least 3 coupa audit rows, got %', v_count;
  end if;

  reset role;
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', 'cccccccc-0000-0000-0000-000000000001',
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', 'coupa-test-tenant-a')
    )::text,
    true
  );

  select count(*)
    into v_count
    from public.integration_config
   where connector_key = 'coupa';
  if v_count <> 1 then
    raise exception 'FAIL 4: tenant admin should see exactly one coupa row, got %', v_count;
  end if;

  select enabled::text
    into v_val
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';
  if v_val is distinct from 'false' then
    raise exception 'FAIL 5: coupa row should be disabled after disable step';
  end if;

  raise notice 'PASS: coupa integration_config checks passed';
end;
$$;

rollback;
