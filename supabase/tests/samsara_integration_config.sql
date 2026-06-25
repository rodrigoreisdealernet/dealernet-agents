-- Behavioral tests for Samsara telematics integration config.
-- Covers: migration replay metadata, config storage, secret-ref isolation,
-- supported scopes (gps, hours, eld, dashcam_events), tenant isolation,
-- enable/disable toggling, credential rotation, and read_only write denial.

begin;

do $$
declare
  v_tenant_a_id constant uuid := 'dd110000-0000-0000-0000-000000000001';
  v_tenant_b_id constant uuid := 'dd220000-0000-0000-0000-000000000002';
  v_config_id   uuid;
  v_count       int;
  v_val         text;
  v_json        jsonb;
  v_caught      bool;
begin
  -- Seed tenants
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a_id, 'samsara-test-tenant-a', 'Samsara Test Tenant A'),
    (v_tenant_b_id, 'samsara-test-tenant-b', 'Samsara Test Tenant B')
  on conflict (id) do update set tenant_key = excluded.tenant_key, name = excluded.name;

  -- 0) Migration replay: version recorded (only verifiable via Supabase CLI reset path),
  --    table comment updated, index present
  if (select count(*) from information_schema.schemata where schema_name = 'supabase_migrations') > 0 then
    select count(*)
      into v_count
      from supabase_migrations.schema_migrations
     where version = '20260612030000';

    if v_count <> 1 then
      raise exception 'FAIL 0a: expected migration 20260612030000 to be recorded once after replay, got %', v_count;
    end if;
    raise notice 'PASS 0a: migration 20260612030000 recorded';
  else
    raise notice 'SKIP 0a: supabase_migrations schema absent (Docker path) – migration version check skipped';
  end if;

  select obj_description('public.integration_config'::regclass, 'pg_class')
    into v_val;

  if position('samsara' in coalesce(v_val, '')) = 0
     or position('opaque references in the secret_refs column' in coalesce(v_val, '')) = 0 then
    raise exception 'FAIL 0b: integration_config comment must mention samsara after replay (got %)', coalesce(v_val, '<null>');
  end if;
  raise notice 'PASS 0b: integration_config table comment mentions samsara';

  select pg_get_indexdef(idx.oid)
    into v_val
      from pg_class idx
      join pg_namespace nsp on nsp.oid = idx.relnamespace
     where nsp.nspname = 'public'
       and idx.relname = 'idx_integration_config_samsara_tenant'
       and idx.relkind = 'i';

  if v_val is null
     or position('USING btree (tenant_id)' in v_val) = 0
     or position('WHERE (connector_key = ''samsara''' in v_val) = 0 then
    raise exception 'FAIL 0c: idx_integration_config_samsara_tenant must exist with samsara predicate after replay (got %)', coalesce(v_val, '<null>');
  end if;
  raise notice 'PASS 0c: idx_integration_config_samsara_tenant index present with correct predicate';

  -- 1) service_role can insert a samsara config row
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
    'samsara',
    'samsara',
    'samsara',
    'api_key',
    true,
    jsonb_build_object(
      'api_base_url', 'https://api.samsara.com',
      'enabled_scopes', jsonb_build_array('gps', 'hours', 'eld', 'dashcam_events'),
      'fleet_targeting', jsonb_build_object('group_ids', jsonb_build_array('group-1', 'group-2')),
      'healthcheck_path', '/v1/me',
      'healthcheck_timeout_seconds', 5
    ),
    jsonb_build_object(
      'gps_mapping_profile', jsonb_build_object('asset_id_field', 'vehicleId'),
      'hours_mapping_profile', jsonb_build_object('driver_id_field', 'driverId'),
      'eld_profile', jsonb_build_object('hos_mode', 'property'),
      'dashcam_event_profile', jsonb_build_object('event_types', jsonb_build_array('harsh_acceleration'))
    ),
    jsonb_build_object(
      'api_secret_ref', 'secret://integrations/samsara/api_key'
    ),
    '{}'::jsonb
  )
  returning id into v_config_id;

  if v_config_id is null then
    raise exception 'FAIL 1: service_role insert should return a row id';
  end if;
  raise notice 'PASS 1: service_role insert for samsara succeeded';

  -- 1a) connector_key and provider_key stored correctly
  select connector_key
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'samsara' then
    raise exception 'FAIL 1a: connector_key should be samsara (got %)', v_val;
  end if;

  select provider_key
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'samsara' then
    raise exception 'FAIL 1b: provider_key should be samsara (got %)', v_val;
  end if;

  -- 1c) Supported scopes persist as expected
  select settings -> 'enabled_scopes'
    into v_json
    from public.integration_config
   where id = v_config_id;
  if v_json is distinct from jsonb_build_array('gps', 'hours', 'eld', 'dashcam_events') then
    raise exception 'FAIL 1c: enabled_scopes should persist exactly (got %)', coalesce(v_json::text, '<null>');
  end if;
  raise notice 'PASS 1: samsara connector_key, provider_key, and enabled_scopes verified';

  -- 2) Secret ref isolation: api_secret_ref must NOT appear in settings
  select settings ->> 'api_secret_ref'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is not null then
    raise exception 'FAIL 2: api_secret_ref must NOT appear in settings column (got %)', v_val;
  end if;
  raise notice 'PASS 2: api_secret_ref not stored in settings';

  -- 3) Secret ref stored in secret_refs column
  select secret_refs ->> 'api_secret_ref'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'secret://integrations/samsara/api_key' then
    raise exception 'FAIL 3: api_secret_ref should be in secret_refs (got %)', v_val;
  end if;
  raise notice 'PASS 3: api_secret_ref stored in secret_refs column';

  -- 4) Mapping profiles stored in mappings column; all four scope profiles verified
  select mappings -> 'gps_mapping_profile' ->> 'asset_id_field'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'vehicleId' then
    raise exception 'FAIL 4a: gps_mapping_profile.asset_id_field should be in mappings (got %)', v_val;
  end if;

  select mappings -> 'hours_mapping_profile' ->> 'driver_id_field'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'driverId' then
    raise exception 'FAIL 4b: hours_mapping_profile.driver_id_field should be in mappings (got %)', v_val;
  end if;

  select mappings -> 'eld_profile' ->> 'hos_mode'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'property' then
    raise exception 'FAIL 4c: eld_profile.hos_mode should be in mappings (got %)', v_val;
  end if;

  select (mappings -> 'dashcam_event_profile' -> 'event_types' ->> 0)
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'harsh_acceleration' then
    raise exception 'FAIL 4d: dashcam_event_profile.event_types should be in mappings (got %)', v_val;
  end if;

  -- profiles must NOT appear in settings
  select settings ->> 'gps_mapping_profile'
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is not null then
    raise exception 'FAIL 4e: gps_mapping_profile must NOT appear in settings column (got %)', v_val;
  end if;

  -- fleet_targeting connection config persists in settings
  select settings -> 'fleet_targeting' -> 'group_ids' ->> 0
    into v_val
    from public.integration_config
   where id = v_config_id;
  if v_val is distinct from 'group-1' then
    raise exception 'FAIL 4f: fleet_targeting.group_ids[0] should be in settings (got %)', v_val;
  end if;
  raise notice 'PASS 4: all mapping profiles in mappings, profiles absent from settings, fleet_targeting in settings';

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
    'samsara',
    'samsara',
    'samsara',
    'api_key',
    true,
    jsonb_build_object(
      'api_base_url', 'https://api.samsara.com',
      'enabled_scopes', jsonb_build_array('gps'),
      'fleet_targeting', jsonb_build_object('group_ids', jsonb_build_array('group-b-1'))
    ),
    jsonb_build_object(
      'gps_mapping_profile', jsonb_build_object('asset_id_field', 'assetId')
    ),
    jsonb_build_object(
      'api_secret_ref', 'secret://integrations/samsara/api_key-b'
    ),
    '{}'::jsonb
  );
  raise notice 'PASS 5: tenant_b samsara row inserted';

  -- 6) Authenticated admin for tenant_a sees only tenant_a row
  reset role;
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', 'daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', 'samsara-test-tenant-a')
    )::text,
    true
  );

  select count(*)
    into v_count
    from public.integration_config
   where connector_key = 'samsara';

  if v_count <> 1 then
    raise exception 'FAIL 6: tenant_a admin should see exactly 1 samsara row (got %)', v_count;
  end if;
  raise notice 'PASS 6: tenant_a admin sees only its own row';

  -- 7) Tenant_a admin cannot read tenant_b row
  select count(*)
    into v_count
    from public.integration_config
   where connector_key = 'samsara'
     and tenant_id = v_tenant_b_id;

  if v_count <> 0 then
    raise exception 'FAIL 7: tenant_a admin must not see tenant_b samsara row (got %)', v_count;
  end if;
  raise notice 'PASS 7: tenant_a admin cannot see tenant_b row (tenant isolation)';

  -- 8) Admin can disable the connector in own tenant
  update public.integration_config
     set enabled = false
   where tenant_id = v_tenant_a_id
     and connector_key = 'samsara';

  if not found then
    raise exception 'FAIL 8: admin should be able to disable samsara in own tenant';
  end if;

  select count(*)
    into v_count
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'samsara'
     and enabled = false;

  if v_count <> 1 then
    raise exception 'FAIL 8b: samsara row should now be disabled (got %)', v_count;
  end if;
  raise notice 'PASS 8: admin can disable samsara connector in own tenant';

  -- 9) Admin can re-enable and rotate the secret ref (credential rotation)
  update public.integration_config
     set enabled     = true,
         secret_refs = jsonb_build_object(
           'api_secret_ref', 'secret://integrations/samsara/api_key-v2'
         )
   where tenant_id = v_tenant_a_id
     and connector_key = 'samsara';

  select secret_refs ->> 'api_secret_ref'
    into v_val
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'samsara';

  if v_val is distinct from 'secret://integrations/samsara/api_key-v2' then
    raise exception 'FAIL 9: rotated api_secret_ref not persisted (got %)', v_val;
  end if;
  raise notice 'PASS 9: credential rotation persists new secret ref';

  select enabled::text
    into v_val
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'samsara';

  if v_val is distinct from 'true' then
    raise exception 'FAIL 9b: samsara row should be enabled after re-enable (got %)', v_val;
  end if;
  raise notice 'PASS 9b: samsara connector re-enabled';

  -- 10) read_only role cannot write samsara config
  reset role;
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', 'd0000000-1111-2222-3333-444444444444',
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'samsara-test-tenant-a')
    )::text,
    true
  );

  v_caught := false;
  begin
    insert into public.integration_config (
      tenant_id, connector_key, provider, provider_key, auth_type, enabled, settings, mappings, secret_refs, schedule
    ) values (
      v_tenant_a_id, 'samsara_ro_attempt', 'samsara_ro_attempt', 'samsara_ro_attempt', 'api_key', false,
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
