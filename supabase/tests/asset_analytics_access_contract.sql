-- Behavioral SQL access-contract checks for asset analytics projection surfaces
-- added by 20260613003000_asset_analytics_projection.sql.
--
-- Assertions:
--   1. Structural grants are least-privilege:
--      - v_asset_analytics_current SELECT granted to authenticated/service_role,
--        not anon.
--      - rental_recompute_asset_analytics(uuid) EXECUTE granted only to service_role.
--      - v_asset_analytics_current and rental_current_assets declare security_invoker=true.
--   2. service_role can seed tenant-scoped assets, invoke recompute, and read analytics rows.
--   3. anon is denied both recompute RPC execution and direct analytics-view reads.
--   4. authenticated(read_only) can read only same-tenant analytics rows and is denied recompute.
--   5. authenticated without app_metadata.role can still read same-tenant analytics rows but
--      remains denied from recompute execution.

begin;

do $$
declare
  v_tenant_a_asset_id uuid;
  v_tenant_b_asset_id uuid;
  v_count int;
  v_cross_tenant_count int;
  v_caught bool;
  v_relopts text;
begin
  -- 1. Structural grant checks
  if not has_table_privilege('authenticated', 'public.v_asset_analytics_current', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on public.v_asset_analytics_current';
  end if;

  if not has_table_privilege('service_role', 'public.v_asset_analytics_current', 'SELECT') then
    raise exception 'Expected service_role SELECT grant on public.v_asset_analytics_current';
  end if;

  if has_table_privilege('anon', 'public.v_asset_analytics_current', 'SELECT') then
    raise exception 'anon should not have SELECT on public.v_asset_analytics_current';
  end if;

  select c.reloptions::text
    into v_relopts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'v_asset_analytics_current';

  if coalesce(v_relopts, '') not like '%security_invoker=true%' then
    raise exception 'v_asset_analytics_current must declare security_invoker = true';
  end if;

  select c.reloptions::text
    into v_relopts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'rental_current_assets';

  if coalesce(v_relopts, '') not like '%security_invoker=true%' then
    raise exception 'rental_current_assets must declare security_invoker = true';
  end if;

  if not has_function_privilege('service_role', 'public.rental_recompute_asset_analytics(uuid)', 'EXECUTE') then
    raise exception 'Expected service_role EXECUTE grant on rental_recompute_asset_analytics(uuid)';
  end if;

  if has_function_privilege('authenticated', 'public.rental_recompute_asset_analytics(uuid)', 'EXECUTE') then
    raise exception 'authenticated should not have EXECUTE on rental_recompute_asset_analytics(uuid)';
  end if;

  if has_function_privilege('anon', 'public.rental_recompute_asset_analytics(uuid)', 'EXECUTE') then
    raise exception 'anon should not have EXECUTE on rental_recompute_asset_analytics(uuid)';
  end if;

  raise notice 'PASS 1: grants + security_invoker chain verified for analytics view and recompute RPC';

  -- 2. service_role path: seed + recompute + read
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select entity_id
    into v_tenant_a_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_data             => '{"name":"Analytics Access Contract Asset A","tenant":"tenant-a","ownership_type":"owned","operational_status":"available","source_record_id":"asset-analytics-access-contract-a"}'::jsonb,
    p_source_record_id => 'asset-analytics-access-contract-a'
  );

  select entity_id
    into v_tenant_b_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_data             => '{"name":"Analytics Access Contract Asset B","tenant":"tenant-b","ownership_type":"owned","operational_status":"available","source_record_id":"asset-analytics-access-contract-b"}'::jsonb,
    p_source_record_id => 'asset-analytics-access-contract-b'
  );

  if v_tenant_a_asset_id is null or v_tenant_b_asset_id is null then
    raise exception 'service_role seed failed: expected both tenant fixture assets';
  end if;

  perform public.rental_recompute_asset_analytics(v_tenant_a_asset_id);
  perform public.rental_recompute_asset_analytics(v_tenant_b_asset_id);

  select count(*)
    into v_count
  from public.v_asset_analytics_current
  where asset_id in (v_tenant_a_asset_id, v_tenant_b_asset_id);

  if v_count <> 2 then
    raise exception 'service_role expected 2 analytics rows for seeded assets, got %', v_count;
  end if;

  raise notice 'PASS 2: service_role can recompute + read analytics rows for both tenants';
  execute 'reset role';

  -- 3. anon denied for recompute + view
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  v_caught := false;
  begin
    perform public.rental_recompute_asset_analytics(v_tenant_a_asset_id);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 3a: unexpected error for anon recompute: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 3a: anon unexpectedly executed rental_recompute_asset_analytics(uuid)';
  end if;

  v_caught := false;
  begin
    perform 1
    from public.v_asset_analytics_current
    where asset_id = v_tenant_a_asset_id;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 3b: unexpected error for anon analytics view read: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 3b: anon unexpectedly read public.v_asset_analytics_current';
  end if;

  raise notice 'PASS 3: anon denied recompute and analytics view read';
  execute 'reset role';

  -- 4. authenticated(read_only) can read analytics view but cannot recompute
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000a001","app_metadata":{"role":"read_only","tenant":"tenant-a"}}',
    true
  );

  v_caught := false;
  begin
    perform public.rental_recompute_asset_analytics(v_tenant_a_asset_id);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 4a: unexpected error for authenticated(read_only) recompute: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4a: authenticated(read_only) unexpectedly executed recompute RPC';
  end if;

  select count(*)
    into v_count
  from public.v_asset_analytics_current
  where asset_id = v_tenant_a_asset_id;

  if v_count <> 1 then
    raise exception 'FAIL 4b: authenticated(read_only, tenant-a) expected 1 same-tenant analytics row, got %', v_count;
  end if;

  select count(*)
    into v_cross_tenant_count
  from public.v_asset_analytics_current
  where asset_id = v_tenant_b_asset_id;

  if v_cross_tenant_count <> 0 then
    raise exception 'FAIL 4c: authenticated(read_only, tenant-a) should see 0 tenant-b analytics rows, got %', v_cross_tenant_count;
  end if;

  raise notice 'PASS 4: authenticated(read_only) same-tenant read allowed; cross-tenant and recompute denied';
  execute 'reset role';

  -- 5. authenticated with no app role claim can read same-tenant analytics rows (same
  --    view-read surface as other authenticated sessions) while recompute
  --    remains service-role-only by execute grant.
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000a002","app_metadata":{"tenant":"tenant-b"}}',
    true
  );

  select count(*)
    into v_count
  from public.v_asset_analytics_current
  where asset_id = v_tenant_b_asset_id;

  if v_count <> 1 then
    raise exception 'FAIL 5: expected authenticated (no app role claim, tenant-b) to read 1 same-tenant analytics row, got %', v_count;
  end if;

  select count(*)
    into v_cross_tenant_count
  from public.v_asset_analytics_current
  where asset_id = v_tenant_a_asset_id;

  if v_cross_tenant_count <> 0 then
    raise exception 'FAIL 5a: authenticated (tenant-b) should see 0 tenant-a analytics rows, got %', v_cross_tenant_count;
  end if;

  v_caught := false;
  begin
    perform public.rental_recompute_asset_analytics(v_tenant_b_asset_id);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 5b: unexpected error for authenticated(no app role) recompute: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5b: authenticated(no app role) unexpectedly executed recompute RPC';
  end if;

  raise notice 'PASS 5: authenticated without app role claim same-tenant read allowed; cross-tenant/recompute denied';

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

rollback;
