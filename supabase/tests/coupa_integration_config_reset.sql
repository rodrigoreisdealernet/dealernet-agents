-- Reset-path validation for Coupa integration_config setup and tenant-scoped configuration
-- (migration 20260614143000_coupa_integration_config.sql).
--
-- Confirms that a fully-reset schema still supports:
--   0.  Migration replay metadata: version recorded, index exists, table comment updated
--   1.  service_role can insert a coupa config row with all supported scopes
--   2.  Non-secret config lands in settings; credentials must NOT appear in settings
--   3.  Secret refs land in secret_refs column only
--   4.  Mapping profiles land in mappings column
--   5.  A second tenant row can be inserted (multi-tenant setup)
--   6.  Authenticated admin for tenant_a sees only tenant_a Coupa row (tenant isolation)
--   7.  Tenant_a admin cannot read tenant_b Coupa row (cross-tenant deny)
--   8.  Admin can disable/enable Coupa connector in own tenant
--   9.  Admin can rotate credential refs in own tenant
--   10. read_only role cannot write Coupa integration_config
--
-- All data is inserted and rolled back; this script makes no lasting changes.

begin;

do $$
declare
  v_tenant_a_id constant uuid := 'ca110000-0000-0000-0000-000000000001';
  v_tenant_b_id constant uuid := 'cb220000-0000-0000-0000-000000000001';
  v_config_id   uuid;
  v_count       int;
  v_val         text;
  v_json        jsonb;
  v_caught      bool;
begin
  -- Seed tenants
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a_id, 'coupa-reset-tenant-a', 'Coupa Reset Tenant A'),
    (v_tenant_b_id, 'coupa-reset-tenant-b', 'Coupa Reset Tenant B')
  on conflict (id) do update set tenant_key = excluded.tenant_key, name = excluded.name;

  -- 0) Migration replay should record 20260614143000, keep the Coupa index, and update the table comment
  select count(*)
    into v_count
    from supabase_migrations.schema_migrations
   where version = '20260614143000';

  if v_count <> 1 then
    raise exception 'FAIL 0a: expected migration 20260614143000 to be recorded once after replay, got %', v_count;
  end if;

  select obj_description('public.integration_config'::regclass, 'pg_class')
    into v_val;

  if position('coupa' in coalesce(v_val, '')) = 0
     or position('opaque references in the secret_refs column' in coalesce(v_val, '')) = 0 then
    raise exception 'FAIL 0b: integration_config comment must mention coupa after replay (got %)', coalesce(v_val, '<null>');
  end if;

  select pg_get_indexdef(idx.oid)
    into v_val
    from pg_class idx
    join pg_namespace nsp on nsp.oid = idx.relnamespace
   where nsp.nspname = 'public'
     and idx.relname = 'idx_integration_config_coupa_tenant'
     and idx.relkind = 'i';

  if v_val is null
     or position('USING btree (tenant_id)' in v_val) = 0
     or position('WHERE (connector_key = ''coupa''' in v_val) = 0 then
    raise exception 'FAIL 0c: idx_integration_config_coupa_tenant must exist with coupa predicate after replay';
  end if;
  raise notice 'PASS 0: Coupa integration_config migration replay metadata verified';

  -- 1) service_role can insert a Coupa config row with all supported scopes
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;

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
    v_tenant_a_id,
    'coupa',
    'coupa',
    'coupa',
    'client_credentials',
    true,
    jsonb_build_object(
      'api_base_url', 'https://tenant.coupahost.com',
      'tenant_slug', 'wynne-rental-a',
      'enabled_scopes', jsonb_build_array('requisitions', 'purchase_orders', 'suppliers', 'invoices'),
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
  returning id into v_config_id;

  if v_config_id is null then
    raise exception 'FAIL 1: service_role insert should return a row id';
  end if;

  select connector_key
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'coupa' then
    raise exception 'FAIL 1a: connector_key should be coupa (got %)', v_val;
  end if;

  select auth_type
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'client_credentials' then
    raise exception 'FAIL 1b: auth_type should be client_credentials (got %)', v_val;
  end if;

  select settings -> 'enabled_scopes'
    into v_json
    from public.integration_config
   where id = v_config_id;
  if v_json is distinct from jsonb_build_array('requisitions', 'purchase_orders', 'suppliers', 'invoices') then
    raise exception 'FAIL 1c: all four supported scopes should persist in enabled_scopes (got %)', coalesce(v_json::text, '<null>');
  end if;
  raise notice 'PASS 1: service_role insert for coupa succeeded with all supported scopes';

  -- 2) Non-secret config lands in settings; raw credential values must NOT be present in settings
  select settings ->> 'api_base_url'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'https://tenant.coupahost.com' then
    raise exception 'FAIL 2a: api_base_url should be in settings (got %)', v_val;
  end if;

  select settings ->> 'tenant_slug'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'wynne-rental-a' then
    raise exception 'FAIL 2b: tenant_slug should be in settings (got %)', v_val;
  end if;

  select settings ->> 'client_id_secret_ref'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is not null then
    raise exception 'FAIL 2c: client_id_secret_ref must NOT appear in settings column (got %)', v_val;
  end if;

  select settings ->> 'client_secret_secret_ref'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is not null then
    raise exception 'FAIL 2d: client_secret_secret_ref must NOT appear in settings column (got %)', v_val;
  end if;
  raise notice 'PASS 2: non-secret config in settings, secret refs absent from settings';

  -- 3) Secret refs land in secret_refs column, not settings
  select secret_refs ->> 'client_id_secret_ref'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'secret://integrations/coupa/client_id' then
    raise exception 'FAIL 3a: client_id_secret_ref should be in secret_refs (got %)', v_val;
  end if;

  select secret_refs ->> 'client_secret_secret_ref'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'secret://integrations/coupa/client_secret' then
    raise exception 'FAIL 3b: client_secret_secret_ref should be in secret_refs (got %)', v_val;
  end if;
  raise notice 'PASS 3: secret refs stored in secret_refs column only';

  -- 4) Mapping profiles land in mappings column
  select mappings -> 'requisition_mapping_profile' ->> 'requisition_id_field'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'id' then
    raise exception 'FAIL 4a: requisition_mapping_profile.requisition_id_field should be in mappings (got %)', v_val;
  end if;

  select mappings -> 'invoice_mapping_profile' ->> 'invoice_id_field'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'id' then
    raise exception 'FAIL 4b: invoice_mapping_profile.invoice_id_field should be in mappings (got %)', v_val;
  end if;
  raise notice 'PASS 4: mapping profiles stored in mappings column';

  -- 5) Insert a row for tenant_b to enable tenant isolation checks
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
  );
  raise notice 'PASS 5: tenant_b coupa row inserted';

  -- 6) Authenticated admin for tenant_a sees only tenant_a Coupa row
  reset role;
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', 'coupa-reset-tenant-a')
    )::text,
    true
  );

  select count(*)
    into v_count
    from public.integration_config
   where connector_key = 'coupa';

  if v_count <> 1 then
    raise exception 'FAIL 6: tenant_a admin should see exactly 1 coupa row (got %)', v_count;
  end if;
  raise notice 'PASS 6: tenant_a admin sees only its own Coupa row';

  -- 7) Tenant_a admin cannot read tenant_b Coupa row
  select count(*)
    into v_count
    from public.integration_config
   where connector_key = 'coupa'
     and tenant_id = v_tenant_b_id;

  if v_count <> 0 then
    raise exception 'FAIL 7: tenant_a admin must not see tenant_b coupa row (got %)', v_count;
  end if;
  raise notice 'PASS 7: tenant_a admin cannot see tenant_b Coupa row (tenant isolation)';

  -- 8) Admin can disable Coupa connector in own tenant
  update public.integration_config
     set enabled = false
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';

  if not found then
    raise exception 'FAIL 8a: admin should be able to disable coupa in own tenant';
  end if;

  select count(*)
    into v_count
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa'
     and enabled = false;

  if v_count <> 1 then
    raise exception 'FAIL 8b: coupa row should now be disabled (got %)', v_count;
  end if;
  raise notice 'PASS 8: admin can disable Coupa connector in own tenant';

  -- 9) Admin can re-enable and rotate credential refs (config rotation)
  update public.integration_config
     set enabled     = true,
         settings    = settings || jsonb_build_object('tenant_slug', 'wynne-rental-a-v2'),
         secret_refs = jsonb_build_object(
           'client_id_secret_ref',     'secret://integrations/coupa/client_id-v2',
           'client_secret_secret_ref', 'secret://integrations/coupa/client_secret-v2'
         )
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';

  select settings ->> 'tenant_slug'
    into v_val
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';

  if v_val is distinct from 'wynne-rental-a-v2' then
    raise exception 'FAIL 9a: updated tenant_slug not persisted (got %)', v_val;
  end if;

  select secret_refs ->> 'client_id_secret_ref'
    into v_val
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'coupa';

  if v_val is distinct from 'secret://integrations/coupa/client_id-v2' then
    raise exception 'FAIL 9b: rotated client_id_secret_ref not persisted (got %)', v_val;
  end if;
  raise notice 'PASS 9: Coupa config update and credential rotation persist correctly';

  -- 10) read_only role cannot write Coupa integration_config
  reset role;
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'coupa-reset-tenant-a')
    )::text,
    true
  );

  v_caught := false;
  begin
    insert into public.integration_config (
      tenant_id, connector_key, provider, provider_key, auth_type, enabled, settings, mappings, secret_refs, schedule
    ) values (
      v_tenant_a_id, 'coupa_ro_attempt', 'coupa_ro_attempt', 'coupa_ro_attempt', 'client_credentials', false,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
    );
  exception when others then
    v_caught := true;
  end;

  if not v_caught then
    raise exception 'FAIL 10: read_only should not be able to insert integration_config';
  end if;
  raise notice 'PASS 10: read_only write correctly denied';

  raise notice 'PASS: coupa integration_config reset-path checks passed';
end;
$$;

rollback;
