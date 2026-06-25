begin;

do $$
declare
  v_migration_count int;
  v_pk_columns text;
  v_rls_enabled bool;
begin
  select count(*) into v_migration_count
    from supabase_migrations.schema_migrations
   where version in ('20260611160000', '20260611170000', '20260614143000');

  if v_migration_count <> 3 then
    raise exception 'FAIL reset 1: expected integration_config migrations 20260611160000 + 20260611170000 + 20260614143000 to be recorded, got %', v_migration_count;
  end if;

  select string_agg(att.attname, ',' order by ord.ordinality)
    into v_pk_columns
    from pg_index idx
    join pg_class cls on cls.oid = idx.indrelid
    join pg_namespace nsp on nsp.oid = cls.relnamespace
    join unnest(idx.indkey) with ordinality as ord(attnum, ordinality) on true
    join pg_attribute att on att.attrelid = cls.oid and att.attnum = ord.attnum
   where nsp.nspname = 'public'
     and cls.relname = 'integration_config'
     and idx.indisprimary;

  if v_pk_columns is distinct from 'id' then
    raise exception 'FAIL reset 2: integration_config PK should remain id (got %)', coalesce(v_pk_columns, '<null>');
  end if;

  perform 1
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'integration_config'
     and column_name = 'provider_key';

  if not found then
    raise exception 'FAIL reset 3: integration_config.provider_key should remain available for replay compatibility';
  end if;

  select c.relrowsecurity
    into v_rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'integration_config';

  if v_rls_enabled is distinct from true then
    raise exception 'FAIL reset 4: integration_config should have RLS enabled';
  end if;

  raise notice 'PASS reset schema: shared integration_config migration replay verified';
end;
$$;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.tenant', '', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, tenant_key, name)
values
  ('11111111-1111-1111-1111-111111111111', 'tenant-a', 'Tenant A'),
  ('22222222-2222-2222-2222-222222222222', 'tenant-b', 'Tenant B')
on conflict (id) do update
  set tenant_key = excluded.tenant_key,
      name = excluded.name;

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
) values
(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'descartes',
  'descartes',
  'descartes',
  'api_key',
  true,
  '{"endpoint_base_url":"https://api.descartes.example","enabled_scopes":["route"]}'::jsonb,
  '{"route_mapping_profile":{"route_id_field":"routeNumber"}}'::jsonb,
  '{"auth_secret_ref":"secret://integrations/descartes/token-a"}'::jsonb,
  '{}'::jsonb
),
(
  '22222222-2222-2222-2222-222222222222'::uuid,
  'descartes',
  'descartes',
  'descartes',
  'api_key',
  true,
  '{"endpoint_base_url":"https://api.descartes.other","enabled_scopes":["shipment"]}'::jsonb,
  '{}'::jsonb,
  '{"auth_secret_ref":"secret://integrations/descartes/token-b"}'::jsonb,
  '{}'::jsonb
),
(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'coupa',
  'coupa',
  'coupa',
  'client_credentials',
  true,
  '{"api_base_url":"https://tenant.coupahost.com","tenant_slug":"wynne-rental-a","enabled_scopes":["requisitions","purchase_orders"],"healthcheck_path":"/api/health","healthcheck_timeout_seconds":5}'::jsonb,
  '{"requisition_mapping_profile":{"requisition_id_field":"id"},"purchase_order_mapping_profile":{"purchase_order_id_field":"id"},"supplier_mapping_profile":{"supplier_id_field":"id"},"invoice_mapping_profile":{"invoice_id_field":"id"}}'::jsonb,
  '{"client_id_secret_ref":"secret://integrations/coupa/client_id-a","client_secret_secret_ref":"secret://integrations/coupa/client_secret-a"}'::jsonb,
  '{}'::jsonb
),
(
  '22222222-2222-2222-2222-222222222222'::uuid,
  'coupa',
  'coupa',
  'coupa',
  'client_credentials',
  true,
  '{"api_base_url":"https://tenant-b.coupahost.com","tenant_slug":"wynne-rental-b","enabled_scopes":["suppliers"]}'::jsonb,
  '{"supplier_mapping_profile":{"supplier_id_field":"id"}}'::jsonb,
  '{"client_id_secret_ref":"secret://integrations/coupa/client_id-b","client_secret_secret_ref":"secret://integrations/coupa/client_secret-b"}'::jsonb,
  '{}'::jsonb
)
on conflict (tenant_id, connector_key) do update
  set provider = excluded.provider,
      provider_key = excluded.provider_key,
      auth_type = excluded.auth_type,
      enabled = excluded.enabled,
      settings = excluded.settings,
      mappings = excluded.mappings,
      secret_refs = excluded.secret_refs,
      schedule = excluded.schedule;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
  true
);

do $$
declare
  v_count int;
  v_timeout text;
  v_enabled bool;
  v_coupa_tenant_slug text;
  v_coupa_secret_ref text;
  v_coupa_visible_tenant text;
begin
  update public.integration_config
     set settings = settings || jsonb_build_object('healthcheck_timeout_seconds', 10)
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'descartes';

  if not found then
    raise exception 'FAIL reset 5: admin update in own tenant should succeed';
  end if;

  select settings ->> 'healthcheck_timeout_seconds'
    into v_timeout
    from public.integration_config
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'descartes';

  if v_timeout is distinct from '10' then
    raise exception 'FAIL reset 6: admin update should persist healthcheck_timeout_seconds=10 (got %)', v_timeout;
  end if;

  select count(*) into v_count
    from public.integration_config
   where connector_key = 'descartes';

  if v_count <> 1 then
    raise exception 'FAIL reset 7: admin read should be tenant-filtered (expected 1 row, got %)', v_count;
  end if;

  update public.integration_config
     set settings = settings || jsonb_build_object('tenant_slug', 'wynne-rental-a-v2')
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'coupa';

  if not found then
    raise exception 'FAIL reset 7b: admin Coupa update in own tenant should succeed';
  end if;

  select settings ->> 'tenant_slug'
    into v_coupa_tenant_slug
    from public.integration_config
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'coupa';

  if v_coupa_tenant_slug is distinct from 'wynne-rental-a-v2' then
    raise exception 'FAIL reset 7c: Coupa tenant_slug update should persist (got %)', v_coupa_tenant_slug;
  end if;

  select settings ->> 'client_id_secret_ref'
    into v_coupa_secret_ref
    from public.integration_config
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'coupa';

  if v_coupa_secret_ref is not null then
    raise exception 'FAIL reset 7d: Coupa client_id_secret_ref found in settings (expected null, got %)', v_coupa_secret_ref;
  end if;

  select settings ->> 'client_secret_secret_ref'
    into v_coupa_secret_ref
    from public.integration_config
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'coupa';

  if v_coupa_secret_ref is not null then
    raise exception 'FAIL reset 7e: Coupa client_secret_secret_ref found in settings (expected null, got %)', v_coupa_secret_ref;
  end if;

  select secret_refs ->> 'client_id_secret_ref'
    into v_coupa_secret_ref
    from public.integration_config
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'coupa';

  if v_coupa_secret_ref is distinct from 'secret://integrations/coupa/client_id-a' then
    raise exception 'FAIL reset 7f: Coupa client_id_secret_ref mismatch in secret_refs (expected secret://integrations/coupa/client_id-a, got %)', v_coupa_secret_ref;
  end if;

  select secret_refs ->> 'client_secret_secret_ref'
    into v_coupa_secret_ref
    from public.integration_config
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'coupa';

  if v_coupa_secret_ref is distinct from 'secret://integrations/coupa/client_secret-a' then
    raise exception 'FAIL reset 7g: Coupa client_secret_secret_ref mismatch in secret_refs (expected secret://integrations/coupa/client_secret-a, got %)', v_coupa_secret_ref;
  end if;

  select count(*) into v_count
    from public.integration_config
   where connector_key = 'coupa';

  if v_count <> 1 then
    raise exception 'FAIL reset 7h: Coupa admin read should be tenant-filtered (expected 1 row, got %)', v_count;
  end if;

  select tenant_id::text
    into v_coupa_visible_tenant
    from public.integration_config
   where connector_key = 'coupa'
   limit 1;

  if v_coupa_visible_tenant is distinct from '11111111-1111-1111-1111-111111111111' then
    raise exception 'FAIL reset 7i: Coupa tenant-visible row mismatch (expected 11111111-1111-1111-1111-111111111111, got %)', coalesce(v_coupa_visible_tenant, '<null>');
  end if;

  update public.integration_config
     set enabled = false
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'descartes';

  if not found then
    raise exception 'FAIL reset 8: admin disable in own tenant should succeed';
  end if;

  select enabled
    into v_enabled
    from public.integration_config
   where tenant_id = '11111111-1111-1111-1111-111111111111'::uuid
     and connector_key = 'descartes';

  if v_enabled is distinct from false then
    raise exception 'FAIL reset 9: disable should persist enabled=false (got %)', v_enabled;
  end if;
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}',
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
    '11111111-1111-1111-1111-111111111111'::uuid,
    'descartes_secondary',
    'descartes_secondary',
    'descartes_secondary',
    'api_key',
    true,
    '{"endpoint_base_url":"https://api.descartes.example"}'::jsonb,
    '{}'::jsonb,
    '{"auth_secret_ref":"secret://integrations/descartes/token-secondary"}'::jsonb,
    '{}'::jsonb
  );

  select count(*) into v_count
    from public.integration_config
   where connector_key like 'descartes%';

  if v_count <> 2 then
    raise exception 'FAIL reset 10: branch_manager insert should expose 2 tenant-a rows, got %', v_count;
  end if;
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated","app_metadata":{"role":"read_only","tenant":"tenant-a"}}',
  true
);

do $$
declare
  v_count int;
  v_caught bool := false;
begin
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
      '11111111-1111-1111-1111-111111111111'::uuid,
      'read_only_write_attempt',
      'descartes_read_only',
      'descartes_read_only',
      'api_key',
      true,
      '{"endpoint_base_url":"https://api.descartes.example"}'::jsonb,
      '{}'::jsonb,
      '{"auth_secret_ref":"secret://integrations/descartes/token-readonly"}'::jsonb,
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'FAIL reset 11: read_only write should be denied (RLS)';
  end if;

  select count(*) into v_count
    from public.integration_config
   where connector_key like 'descartes%';

  if v_count <> 0 then
    raise exception 'FAIL reset 12: read_only should not see integration_config rows (expected 0, got %)', v_count;
  end if;
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
  true
);

do $$
begin
  update public.integration_config
     set enabled = false
   where tenant_id = '22222222-2222-2222-2222-222222222222'::uuid
     and connector_key = 'descartes';

  if found then
    raise exception 'FAIL reset 13: cross-tenant update should not be visible to tenant-a admin';
  end if;

  update public.integration_config
     set enabled = false
   where tenant_id = '22222222-2222-2222-2222-222222222222'::uuid
     and connector_key = 'coupa';

  if found then
    raise exception 'FAIL reset 14: cross-tenant Coupa update should not be visible to tenant-a admin';
  end if;
end;
$$;

reset role;

do $$
begin
  raise notice 'PASS: integration_config reset-path schema, tenant-scoped writes, replay-order migration history, and RLS expectations verified';
end;
$$;

rollback;
