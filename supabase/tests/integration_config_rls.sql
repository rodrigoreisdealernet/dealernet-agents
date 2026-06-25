-- Behavioral RLS and privilege tests for integration_config / integration_config_audit.
-- Covers allowed tenant-scoped admin/branch_manager writes, denied read_only/field_operator writes,
-- denied cross-tenant access, authenticated tenant-filtered reads, and service_role audit writes.

begin;

do $$
declare
  v_tenant_a_id constant uuid := '11111111-1111-1111-1111-111111111111';
  v_tenant_b_id constant uuid := '22222222-2222-2222-2222-222222222222';
  v_count int;
  v_timeout text;
  v_caught bool;
begin
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a_id, 'tenant-a', 'Tenant A'),
    (v_tenant_b_id, 'tenant-b', 'Tenant B')
  on conflict (tenant_key) do update set name = excluded.name;

  -- seed baseline rows under service_role context
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;

  insert into public.integration_config (
    tenant_id,
    connector_key,
    enabled,
    settings,
    mappings,
    secret_refs,
    schedule
  ) values (
    v_tenant_a_id,
    'descartes',
    true,
    '{"endpoint_base_url":"https://api.descartes.example","enabled_scopes":["route"]}'::jsonb,
    '{"route_mapping_profile":{"route_id_field":"routeNumber"}}'::jsonb,
    '{"auth_secret_ref":"secret://integrations/descartes/token-a"}'::jsonb,
    '{}'::jsonb
  )
  on conflict (tenant_id, connector_key) do update
    set enabled = excluded.enabled,
        settings = excluded.settings,
        mappings = excluded.mappings,
        secret_refs = excluded.secret_refs,
        schedule = excluded.schedule;

  insert into public.integration_config (
    tenant_id,
    connector_key,
    enabled,
    settings,
    mappings,
    secret_refs,
    schedule
  ) values (
    v_tenant_b_id,
    'descartes',
    true,
    '{"endpoint_base_url":"https://api.descartes.other","enabled_scopes":["shipment"]}'::jsonb,
    '{}'::jsonb,
    '{"auth_secret_ref":"secret://integrations/descartes/token-b"}'::jsonb,
    '{}'::jsonb
  )
  on conflict (tenant_id, connector_key) do update
    set enabled = excluded.enabled,
        settings = excluded.settings,
        mappings = excluded.mappings,
        secret_refs = excluded.secret_refs,
        schedule = excluded.schedule;

  reset role;

  -- 1) admin can write in-tenant and read only in-tenant
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
    true
  );

  update public.integration_config
     set settings = settings || jsonb_build_object('healthcheck_timeout_seconds', 10)
   where tenant_id = v_tenant_a_id
     and connector_key = 'descartes';

  if not found then
    raise exception 'FAIL 1a: admin update in own tenant should succeed';
  end if;

  select settings ->> 'healthcheck_timeout_seconds'
    into v_timeout
    from public.integration_config
   where tenant_id = v_tenant_a_id
     and connector_key = 'descartes';

  if v_timeout is distinct from '10' then
    raise exception 'FAIL 1c: admin update should persist healthcheck_timeout_seconds=10 (got %)', v_timeout;
  end if;

  select count(*) into v_count
    from public.integration_config
   where connector_key = 'descartes';

  if v_count <> 1 then
    raise exception 'FAIL 1b: admin read should be tenant-filtered (expected 1 row, got %)', v_count;
  end if;

  reset role;

  -- 2) branch_manager can insert in own tenant
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}',
    true
  );

  insert into public.integration_config (
    tenant_id,
    connector_key,
    enabled,
    settings,
    mappings,
    secret_refs,
    schedule
  ) values (
    v_tenant_a_id,
    'descartes_secondary',
    true,
    '{"endpoint_base_url":"https://api.descartes.example"}'::jsonb,
    '{}'::jsonb,
    '{"auth_secret_ref":"secret://integrations/descartes/token-secondary"}'::jsonb,
    '{}'::jsonb
  );

  reset role;

  -- 3) read_only cannot write
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated","app_metadata":{"role":"read_only","tenant":"tenant-a"}}',
    true
  );

  v_caught := false;
  begin
    insert into public.integration_config (
      tenant_id,
      connector_key,
      enabled,
      settings,
      mappings,
      secret_refs,
      schedule
    ) values (
      v_tenant_a_id,
      'read-only-write-attempt',
      true,
      '{"endpoint_base_url":"https://api.descartes.example"}'::jsonb,
      '{}'::jsonb,
      '{"auth_secret_ref":"secret://integrations/descartes/token-readonly"}'::jsonb,
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 3: read_only write raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 3: read_only write should be denied (RLS)';
  end if;

  reset role;

  -- 4) field_operator cannot write
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated","app_metadata":{"role":"field_operator","tenant":"tenant-a"}}',
    true
  );

  v_caught := false;
  begin
    insert into public.integration_config (
      tenant_id,
      connector_key,
      enabled,
      settings,
      mappings,
      secret_refs,
      schedule
    ) values (
      v_tenant_a_id,
      'field-op-write-attempt',
      true,
      '{"endpoint_base_url":"https://api.descartes.example"}'::jsonb,
      '{}'::jsonb,
      '{"auth_secret_ref":"secret://integrations/descartes/token-field"}'::jsonb,
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 4: field_operator write raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 4: field_operator write should be denied (RLS)';
  end if;

  reset role;

  -- 5) cross-tenant write denied for admin tenant-a user
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
    true
  );

  v_caught := false;
  begin
    insert into public.integration_config (
      tenant_id,
      connector_key,
      enabled,
      settings,
      mappings,
      secret_refs,
      schedule
    ) values (
      v_tenant_b_id,
      'cross-tenant-write-attempt',
      true,
      '{"endpoint_base_url":"https://api.descartes.other"}'::jsonb,
      '{}'::jsonb,
      '{"auth_secret_ref":"secret://integrations/descartes/token-cross"}'::jsonb,
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 5: cross-tenant write raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 5: cross-tenant write should be blocked';
  end if;

  reset role;

  -- 6) authenticated read is tenant-filtered for read_only
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated","app_metadata":{"role":"read_only","tenant":"tenant-a"}}',
    true
  );

  select count(*) into v_count
    from public.integration_config
   where connector_key like 'descartes%';

  if v_count <> 2 then
    raise exception 'FAIL 6: tenant-filtered read expected 2 rows for tenant-a, got %', v_count;
  end if;

  reset role;

  -- 7) authenticated cannot write audit table directly
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated","app_metadata":{"role":"admin","tenant":"tenant-a"}}',
    true
  );

  v_caught := false;
  begin
    insert into public.integration_config_audit (
      tenant_id,
      connector_key,
      action,
      actor,
      old_row,
      new_row
    ) values (
      v_tenant_a_id,
      'descartes',
      'insert',
      '{}'::jsonb,
      null,
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 7: authenticated direct audit insert raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 7: authenticated direct audit insert should be denied';
  end if;

  reset role;

  -- 8) service_role can write/read audit table
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);

  insert into public.integration_config_audit (
    tenant_id,
    connector_key,
    action,
    actor,
    old_row,
    new_row
  ) values (
    v_tenant_a_id,
    'descartes',
    'update',
    '{"sub":"svc"}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb
  );

  select count(*) into v_count
    from public.integration_config_audit
   where tenant_id = v_tenant_a_id
     and connector_key = 'descartes';

  if v_count < 2 then
    raise exception 'FAIL 8: service_role audit writes expected at least 2 rows, got %', v_count;
  end if;

  reset role;

  raise notice 'PASS: integration_config RLS and audit privileges verified';
end;
$$;

rollback;
