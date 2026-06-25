-- Behavioral SQL access-contract checks for v_fleet_idle_rebalancing
-- (migration 20260613060000_fleet_idle_rebalancing_view.sql).
--
-- Asserts the GRANT → security_invoker → base-table RLS/JWT chain behaves
-- correctly for the three PostgREST role contexts:
--   anon        — no SELECT grant on the view; base-table anon SELECT revoked
--                 (20260607131500_lock_down_anon_read_access.sql)
--   authenticated — SELECT granted; security_invoker view body runs as caller;
--                  fixture rebalancing row is visible
--   service_role — SELECT granted; bypasses RLS; sees all rows
--
-- These assertions would fail if:
--   * the view loses security_invoker = true (bypasses RLS chain)
--   * SELECT is accidentally granted to anon
--   * the authenticated or service_role GRANT is removed
--
-- Pattern: single BEGIN/ROLLBACK block with SET LOCAL ROLE + set_config() to
-- simulate PostgREST JWT contexts without persisting data.

begin;

-- ── Fixture setup (superuser context) ─────────────────────────────────────
-- Two branches: surplus-branch (has idle assets) and deficit-branch (has
-- open demand for the same category, no local idle supply).
-- One asset category shared between both scenarios.
-- Three idle assets at the surplus branch; two open order lines at the deficit branch.
do $$
declare
  v_surplus_branch_id   constant uuid := 'f1ee0000-0000-0000-0001-000000000001';
  v_deficit_branch_id   constant uuid := 'f1ee0000-0000-0000-0001-000000000002';
  v_category_id         constant uuid := 'f1ee0000-0000-0000-0002-000000000001';
  v_asset1_id           constant uuid := 'f1ee0000-0000-0000-0003-000000000001';
  v_asset2_id           constant uuid := 'f1ee0000-0000-0000-0003-000000000002';
  v_asset3_id           constant uuid := 'f1ee0000-0000-0000-0003-000000000003';
  v_order_id            constant uuid := 'f1ee0000-0000-0000-0004-000000000001';
  v_line1_id            constant uuid := 'f1ee0000-0000-0000-0005-000000000001';
  v_line2_id            constant uuid := 'f1ee0000-0000-0000-0005-000000000002';
begin
  -- Surplus branch
  insert into public.entities (id, entity_type, source_record_id)
  values (v_surplus_branch_id, 'branch', 'rls-rebal-surplus-branch')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values (v_surplus_branch_id, 1, true, '{"name":"RLS Rebal Surplus Depot"}'::jsonb, now())
  on conflict (entity_id, version_number) do nothing;

  -- Deficit branch
  insert into public.entities (id, entity_type, source_record_id)
  values (v_deficit_branch_id, 'branch', 'rls-rebal-deficit-branch')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values (v_deficit_branch_id, 1, true, '{"name":"RLS Rebal Deficit Depot"}'::jsonb, now())
  on conflict (entity_id, version_number) do nothing;

  -- Asset category
  insert into public.entities (id, entity_type, source_record_id)
  values (v_category_id, 'asset_category', 'rls-rebal-test-category')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values (v_category_id, 1, true, '{"name":"RLS Rebal Test Category"}'::jsonb, now())
  on conflict (entity_id, version_number) do nothing;

  -- Three idle assets at the surplus branch
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_asset1_id, 'asset', 'rls-rebal-asset-1'),
    (v_asset2_id, 'asset', 'rls-rebal-asset-2'),
    (v_asset3_id, 'asset', 'rls-rebal-asset-3')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_asset1_id, 1, true, '{"name":"Rebal Asset 1","operational_status":"available"}'::jsonb, now()),
    (v_asset2_id, 1, true, '{"name":"Rebal Asset 2","operational_status":"returned"}'::jsonb,  now()),
    (v_asset3_id, 1, true, '{"name":"Rebal Asset 3","operational_status":"available"}'::jsonb, now())
  on conflict (entity_id, version_number) do nothing;

  -- branch_has_asset relationships (surplus branch)
  insert into public.relationships_v2 (relationship_type, parent_id, child_id, is_current)
  values
    ('branch_has_asset', v_surplus_branch_id, v_asset1_id, true),
    ('branch_has_asset', v_surplus_branch_id, v_asset2_id, true),
    ('branch_has_asset', v_surplus_branch_id, v_asset3_id, true)
  on conflict do nothing;

  -- asset_category_has_asset relationships
  insert into public.relationships_v2 (relationship_type, parent_id, child_id, is_current)
  values
    ('asset_category_has_asset', v_category_id, v_asset1_id, true),
    ('asset_category_has_asset', v_category_id, v_asset2_id, true),
    ('asset_category_has_asset', v_category_id, v_asset3_id, true)
  on conflict do nothing;

  -- Open rental order placed against the deficit branch
  insert into public.entities (id, entity_type, source_record_id)
  values (v_order_id, 'rental_order', 'rls-rebal-order-1')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values (
    v_order_id, 1, true,
    jsonb_build_object(
      'branch_id', v_deficit_branch_id::text,
      'status',    'open'
    ),
    now()
  )
  on conflict (entity_id, version_number) do nothing;

  -- Two open order lines referencing the shared category at the deficit branch
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_line1_id, 'rental_order_line', 'rls-rebal-line-1'),
    (v_line2_id, 'rental_order_line', 'rls-rebal-line-2')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_line1_id, 1, true,
      jsonb_build_object(
        'rental_order_id', v_order_id::text,
        'category_id',     v_category_id::text,
        'status',          'open'
      ),
      now()
    ),
    (
      v_line2_id, 1, true,
      jsonb_build_object(
        'rental_order_id', v_order_id::text,
        'category_id',     v_category_id::text,
        'status',          'confirmed'
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;
end;
$$;

-- ── 1. v_fleet_idle_rebalancing declares security_invoker = true ──────────
-- Without security_invoker the view body executes as its owner (typically a
-- superuser), bypassing base-table RLS for the calling role.
do $$
declare
  v_relopts text;
begin
  select c.reloptions::text
    into v_relopts
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'v_fleet_idle_rebalancing';

  if v_relopts is null then
    raise exception
      'FAIL 1: v_fleet_idle_rebalancing not found in pg_class — '
      'migration did not apply cleanly';
  end if;

  if v_relopts not like '%security_invoker=true%' then
    raise exception
      'FAIL 1: v_fleet_idle_rebalancing must declare security_invoker = true; '
      'current reloptions: %', v_relopts;
  end if;

  raise notice 'PASS 1: v_fleet_idle_rebalancing has security_invoker = true';
end;
$$;

-- ── 2. Grant structure is least-privilege ─────────────────────────────────
-- authenticated and service_role hold SELECT; anon must not.
do $$
begin
  if not has_table_privilege('authenticated', 'public.v_fleet_idle_rebalancing', 'SELECT') then
    raise exception
      'FAIL 2a: authenticated does not have SELECT on public.v_fleet_idle_rebalancing';
  end if;

  if not has_table_privilege('service_role', 'public.v_fleet_idle_rebalancing', 'SELECT') then
    raise exception
      'FAIL 2b: service_role does not have SELECT on public.v_fleet_idle_rebalancing';
  end if;

  if has_table_privilege('anon', 'public.v_fleet_idle_rebalancing', 'SELECT') then
    raise exception
      'FAIL 2c: anon must not have SELECT on public.v_fleet_idle_rebalancing — '
      'revoke the GRANT to prevent unauthenticated access';
  end if;

  raise notice 'PASS 2: grant structure is least-privilege (authenticated + service_role only; anon excluded)';
end;
$$;

-- ── 3. anon is denied SELECT on the view ─────────────────────────────────
-- Two layers enforce this: the missing GRANT on the view itself, and the
-- SELECT revoke on base tables (20260607131500_lock_down_anon_read_access.sql).
set local role anon;

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_fleet_idle_rebalancing;
    raise exception
      'FAIL 3: anon SELECT on v_fleet_idle_rebalancing succeeded — '
      'the view must not be granted to the anon role';
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 3: unexpected SQLSTATE % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 3: anon should receive insufficient_privilege (42501)';
  end if;

  raise notice 'PASS 3: anon denied SELECT on v_fleet_idle_rebalancing (42501)';
end;
$$;

reset role;

-- ── 4. authenticated + valid JWT can read the view ────────────────────────
-- The fixture creates a surplus→deficit rebalancing pair; the authenticated
-- caller must see exactly one row for the fixture category pair.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_surplus_branch_id  constant uuid := 'f1ee0000-0000-0000-0001-000000000001';
  v_deficit_branch_id  constant uuid := 'f1ee0000-0000-0000-0001-000000000002';
  v_category_id        constant uuid := 'f1ee0000-0000-0000-0002-000000000001';
  v_row                record;
  v_count              int;
begin
  -- Must not raise an exception
  begin
    select count(*) into v_count from public.v_fleet_idle_rebalancing;
  exception
    when others then
      raise exception
        'FAIL 4a: authenticated SELECT on v_fleet_idle_rebalancing raised % "%"',
        sqlstate, sqlerrm;
  end;

  -- The fixture rebalancing candidate must be visible
  select * into v_row
    from public.v_fleet_idle_rebalancing
   where surplus_branch_id = v_surplus_branch_id
     and deficit_branch_id = v_deficit_branch_id
     and asset_category_id = v_category_id;

  if v_row is null then
    raise exception
      'FAIL 4b: authenticated caller did not see the fixture rebalancing row — '
      'surplus_branch_id=%, deficit_branch_id=%, category_id=%',
      v_surplus_branch_id, v_deficit_branch_id, v_category_id;
  end if;

  if v_row.idle_count <> 3 then
    raise exception
      'FAIL 4c: expected idle_count = 3 for fixture surplus branch; got %',
      v_row.idle_count;
  end if;

  if v_row.open_demand_count <> 2 then
    raise exception
      'FAIL 4d: expected open_demand_count = 2 for fixture deficit branch; got %',
      v_row.open_demand_count;
  end if;

  if v_row.demand_gap <> 2 then
    raise exception
      'FAIL 4e: expected demand_gap = 2 (2 demand - 0 local supply); got %',
      v_row.demand_gap;
  end if;

  if v_row.suggested_transfer_qty <> 2 then
    raise exception
      'FAIL 4f: expected suggested_transfer_qty = 2 (min(3, 2)); got %',
      v_row.suggested_transfer_qty;
  end if;

  raise notice 'PASS 4: authenticated caller sees fixture rebalancing row with correct counts (idle=3, demand=2, gap=2, suggested=2)';
end;
$$;

reset role;

-- ── 5. service_role can read the view ────────────────────────────────────
-- service_role bypasses RLS; the fixture row must be visible.
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

do $$
declare
  v_surplus_branch_id  constant uuid := 'f1ee0000-0000-0000-0001-000000000001';
  v_deficit_branch_id  constant uuid := 'f1ee0000-0000-0000-0001-000000000002';
  v_category_id        constant uuid := 'f1ee0000-0000-0000-0002-000000000001';
  v_count              int;
  v_transfer_qty       int;
begin
  begin
    select count(*) into v_count from public.v_fleet_idle_rebalancing;
  exception
    when others then
      raise exception
        'FAIL 5a: service_role SELECT on v_fleet_idle_rebalancing raised % "%"',
        sqlstate, sqlerrm;
  end;

  select suggested_transfer_qty into v_transfer_qty
    from public.v_fleet_idle_rebalancing
   where surplus_branch_id = v_surplus_branch_id
     and deficit_branch_id = v_deficit_branch_id
     and asset_category_id = v_category_id;

  if v_transfer_qty is null then
    raise exception
      'FAIL 5b: service_role did not see fixture rebalancing row '
      '(surplus=%, deficit=%, category=%)',
      v_surplus_branch_id, v_deficit_branch_id, v_category_id;
  end if;

  raise notice 'PASS 5: service_role sees fixture rebalancing row (suggested_transfer_qty=%)', v_transfer_qty;
end;
$$;

reset role;

rollback;
