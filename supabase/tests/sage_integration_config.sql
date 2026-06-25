-- Behavioral tests for Sage Intacct integration config.
-- Covers: config storage, secret_refs isolation, settings/mappings split,
-- tenant-scoped reads, cross-tenant denial, and enable/disable toggling.

begin;

do $$
declare
  v_tenant_a_id constant uuid := 'aa110000-0000-0000-0000-000000000001';
  v_tenant_b_id constant uuid := 'bb220000-0000-0000-0000-000000000001';
  v_config_id   uuid;
  v_count       int;
  v_val         text;
  v_json        jsonb;
  v_caught      bool;
begin
  -- Seed tenants
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a_id, 'sage-test-tenant-a', 'Sage Test Tenant A'),
    (v_tenant_b_id, 'sage-test-tenant-b', 'Sage Test Tenant B')
  on conflict (id) do update set tenant_key = excluded.tenant_key, name = excluded.name;

  -- 0) Migration replay should keep Sage Intacct registration metadata explicit
  select count(*)
    into v_count
    from supabase_migrations.schema_migrations
   where version = '20260613093000';

  if v_count <> 1 then
    raise exception 'FAIL 0a: expected migration 20260613093000 to be recorded once after replay, got %', v_count;
  end if;

  select obj_description('public.integration_config'::regclass, 'pg_class')
    into v_val;

  if position('sage_intacct' in coalesce(v_val, '')) = 0
     or position('opaque references in the secret_refs column' in coalesce(v_val, '')) = 0 then
    raise exception 'FAIL 0b: integration_config comment must mention sage_intacct after replay (got %)', coalesce(v_val, '<null>');
  end if;

  select pg_get_indexdef(idx.oid)
    into v_val
      from pg_class idx
      join pg_namespace nsp on nsp.oid = idx.relnamespace
     where nsp.nspname = 'public'
       and idx.relname = 'idx_integration_config_sage_intacct_tenant'
       and idx.relkind = 'i';

  if v_val is null
     or position('USING btree (tenant_id)' in v_val) = 0
     or position('WHERE (connector_key = ''sage_intacct''' in v_val) = 0 then
    raise exception 'FAIL 0c: idx_integration_config_sage_intacct_tenant must exist with sage_intacct predicate after replay';
  end if;
  raise notice 'PASS 0: Sage Intacct migration replay metadata verified';

  -- 1) service_role can insert a sage_intacct config row
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
    'sage_intacct',
    'sage_intacct',
    'sage_intacct',
    'client_credentials',
    true,
    jsonb_build_object(
      'api_base_url', 'https://api.intacct.com',
      'company_id', 'dia-rental-01',
      'enabled_scopes', jsonb_build_array('general_ledger', 'accounts_payable')
    ),
    jsonb_build_object(
      'general_ledger_profile', jsonb_build_object('account_id_field', 'glAccountNo'),
      'accounts_payable_profile', jsonb_build_object('vendor_id_field', 'vendorId')
    ),
    jsonb_build_object(
      'client_id_secret_ref', 'secret://integrations/sage_intacct/client_id',
      'client_secret_secret_ref', 'secret://integrations/sage_intacct/client_secret'
    ),
    '{}'::jsonb
  )
  returning id into v_config_id;

  if v_config_id is null then
    raise exception 'FAIL 1: service_role insert should return a row id';
  end if;
  raise notice 'PASS 1: service_role insert for sage_intacct succeeded';

  select connector_key
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'sage_intacct' then
    raise exception 'FAIL 1a: connector_key should stay on explicit sage_intacct variant (got %)', v_val;
  end if;

  select provider_key
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'sage_intacct' then
    raise exception 'FAIL 1b: provider_key should stay on explicit sage_intacct variant (got %)', v_val;
  end if;

  select settings -> 'enabled_scopes'
    into v_json
    from public.integration_config
   where id = v_config_id;
  if v_json is distinct from jsonb_build_array('general_ledger', 'accounts_payable') then
    raise exception 'FAIL 1c: enabled_scopes selection should persist exactly (got %)', coalesce(v_json::text, '<null>');
  end if;

  select count(*)
    into v_count
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'sage';
  if v_count <> 0 then
    raise exception 'FAIL 1d: explicit sage_intacct selection must not degrade to ambiguous sage rows (got %)', v_count;
  end if;
  raise notice 'PASS 1d: explicit Sage Intacct variant selection persisted without ambiguous defaults';

  -- 2) Non-secret config lands in settings; raw credential values must NOT be present in settings
  select settings ->> 'company_id'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'dia-rental-01' then
    raise exception 'FAIL 2a: company_id should be in settings (got %)', v_val;
  end if;

  select settings ->> 'client_id_secret_ref'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is not null then
    raise exception 'FAIL 2b: client_id_secret_ref must NOT appear in settings column (got %)', v_val;
  end if;
  raise notice 'PASS 2: secret refs not stored in settings';

  -- 3) Secret refs land in secret_refs column, not settings or mappings
  select secret_refs ->> 'client_id_secret_ref'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'secret://integrations/sage_intacct/client_id' then
    raise exception 'FAIL 3: client_id_secret_ref should be in secret_refs (got %)', v_val;
  end if;

  select secret_refs ->> 'client_secret_secret_ref'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'secret://integrations/sage_intacct/client_secret' then
    raise exception 'FAIL 3b: client_secret_secret_ref should be in secret_refs (got %)', v_val;
  end if;
  raise notice 'PASS 3: secret refs stored in secret_refs column';

  -- 4) Mapping profiles land in mappings column
  select mappings -> 'general_ledger_profile' ->> 'account_id_field'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'glAccountNo' then
    raise exception 'FAIL 4: general_ledger_profile.account_id_field should be in mappings (got %)', v_val;
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
    'sage_intacct',
    'sage_intacct',
    'sage_intacct',
    'client_credentials',
    true,
    jsonb_build_object(
      'api_base_url', 'https://api.intacct.com',
      'company_id', 'dia-rental-02',
      'enabled_scopes', jsonb_build_array('accounts_receivable')
    ),
    jsonb_build_object(
      'accounts_receivable_profile', jsonb_build_object('customer_id_field', 'customerId')
    ),
    jsonb_build_object(
      'client_id_secret_ref', 'secret://integrations/sage_intacct/client_id-b',
      'client_secret_secret_ref', 'secret://integrations/sage_intacct/client_secret-b'
    ),
    '{}'::jsonb
  );
  raise notice 'PASS 5: tenant_b sage_intacct row inserted';

  -- 6) Authenticated admin for tenant_a sees only tenant_a row
  reset role;
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', 'sage-test-tenant-a')
    )::text,
    true
  );

  select count(*)
    into v_count
    from public.integration_config
   where connector_key = 'sage_intacct';

  if v_count <> 1 then
    raise exception 'FAIL 6: tenant_a admin should see exactly 1 sage_intacct row (got %)', v_count;
  end if;
  raise notice 'PASS 6: tenant_a admin sees only its own row';

  -- 7) Tenant_a admin cannot read tenant_b row
  select count(*)
    into v_count
    from public.integration_config
   where connector_key = 'sage_intacct'
     and tenant_id = v_tenant_b_id;

  if v_count <> 0 then
    raise exception 'FAIL 7: tenant_a admin must not see tenant_b sage_intacct row (got %)', v_count;
  end if;
  raise notice 'PASS 7: tenant_a admin cannot see tenant_b row (tenant isolation)';

  -- 8) Admin can toggle enabled flag in own tenant
  update public.integration_config
     set enabled = false
   where tenant_id = v_tenant_a_id
     and connector_key = 'sage_intacct';

  if not found then
    raise exception 'FAIL 8: admin should be able to disable sage_intacct in own tenant';
  end if;

  select count(*)
    into v_count
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'sage_intacct'
     and enabled = false;

  if v_count <> 1 then
    raise exception 'FAIL 8b: sage_intacct row should now be disabled (got %)', v_count;
  end if;
  raise notice 'PASS 8: admin can disable sage_intacct connector in own tenant';

  -- 9) Admin can re-enable and rotate credential refs (config rotation)
  update public.integration_config
     set enabled    = true,
         secret_refs = jsonb_build_object(
           'client_id_secret_ref',     'secret://integrations/sage_intacct/client_id-v2',
           'client_secret_secret_ref', 'secret://integrations/sage_intacct/client_secret-v2'
         )
   where tenant_id = v_tenant_a_id
     and connector_key = 'sage_intacct';

  select secret_refs ->> 'client_id_secret_ref'
    into v_val
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'sage_intacct';

  if v_val is distinct from 'secret://integrations/sage_intacct/client_id-v2' then
    raise exception 'FAIL 9: rotated client_id_secret_ref not persisted (got %)', v_val;
  end if;
  raise notice 'PASS 9: credential rotation persists new secret refs';

  -- 10) read_only role cannot write sage_intacct config
  reset role;
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'sage-test-tenant-a')
    )::text,
    true
  );

  v_caught := false;
  begin
    insert into public.integration_config (
      tenant_id, connector_key, provider, provider_key, auth_type, enabled, settings, mappings, secret_refs, schedule
    ) values (
      v_tenant_a_id, 'sage_intacct_ro_attempt', 'sage_intacct_ro_attempt', 'sage_intacct_ro_attempt', 'client_credentials', false,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
    );
  exception when others then
    v_caught := true;
  end;

  if not v_caught then
    raise exception 'FAIL 10: read_only should not be able to insert integration_config';
  end if;
  raise notice 'PASS 10: read_only write correctly denied';

end;
$$;

rollback;
