-- Reset-path guard for 20260613060000_fleet_idle_rebalancing_view.sql.
--
-- Confirms that after a full `supabase db reset --config supabase/config.toml`
-- (migrations + seed.sql), the v_fleet_idle_rebalancing view:
--   1. Exists in pg_class (migration applied cleanly).
--   2. Returns at least one rebalancing recommendation row (seed data wires up
--      an idle asset at branch 1 and open demand at branch 2 for the same
--      category, guaranteeing a surplus→deficit pair).
--   3. Every returned row carries branch/category recommendation context:
--      surplus_branch_id, surplus_branch_name, asset_category_id,
--      asset_category_name, deficit_branch_id, deficit_branch_name.
--   4. suggested_transfer_qty is positive (> 0) on every returned row.
--   5. suggested_transfer_qty <= idle_count (never over-promises supply).
--   6. suggested_transfer_qty <= demand_gap (never over-promises demand).
--
-- Security context: all checks run as service_role (bypasses RLS) so that
-- the read-back is unaffected by caller-specific policies. RLS behaviour is
-- separately covered by fleet_idle_rebalancing_rls.sql.

begin;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

-- ── 1. View exists after reset ─────────────────────────────────────────────
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
      'FAIL 1: v_fleet_idle_rebalancing not found in pg_class after reset — '
      'migration 20260613060000_fleet_idle_rebalancing_view.sql did not apply cleanly';
  end if;

  raise notice 'PASS 1: v_fleet_idle_rebalancing found in pg_class after reset';
end;
$$;

-- ── 2-6. View returns recommendation rows with full branch/category context ──
do $$
declare
  v_count              bigint;
  v_bad_surplus_id     bigint;
  v_bad_surplus_name   bigint;
  v_bad_category_id    bigint;
  v_bad_category_name  bigint;
  v_bad_deficit_id     bigint;
  v_bad_deficit_name   bigint;
  v_bad_qty_zero       bigint;
  v_bad_qty_supply     bigint;
  v_bad_qty_demand     bigint;
begin
  -- 2. At least one rebalancing row must exist after seed rebuild.
  -- The seed places an idle asset at branch 1 and open order lines at branch 2
  -- for the same category, guaranteeing one surplus→deficit pair.
  select count(*)
    into v_count
  from public.v_fleet_idle_rebalancing;

  if v_count = 0 then
    raise exception
      'FAIL 2: v_fleet_idle_rebalancing returned 0 rows after reset; '
      'expected at least one surplus→deficit pair from the seeded demo data';
  end if;

  raise notice 'PASS 2: v_fleet_idle_rebalancing returned % row(s) after reset', v_count;

  -- 3a. surplus_branch_id must never be null.
  select count(*)
    into v_bad_surplus_id
  from public.v_fleet_idle_rebalancing
  where surplus_branch_id is null;

  if v_bad_surplus_id > 0 then
    raise exception 'FAIL 3a: % row(s) have NULL surplus_branch_id', v_bad_surplus_id;
  end if;

  -- 3b. surplus_branch_name must never be null.
  select count(*)
    into v_bad_surplus_name
  from public.v_fleet_idle_rebalancing
  where surplus_branch_name is null;

  if v_bad_surplus_name > 0 then
    raise exception 'FAIL 3b: % row(s) have NULL surplus_branch_name', v_bad_surplus_name;
  end if;

  -- 3c. asset_category_id must never be null.
  select count(*)
    into v_bad_category_id
  from public.v_fleet_idle_rebalancing
  where asset_category_id is null;

  if v_bad_category_id > 0 then
    raise exception 'FAIL 3c: % row(s) have NULL asset_category_id', v_bad_category_id;
  end if;

  -- 3d. asset_category_name must never be null.
  select count(*)
    into v_bad_category_name
  from public.v_fleet_idle_rebalancing
  where asset_category_name is null;

  if v_bad_category_name > 0 then
    raise exception 'FAIL 3d: % row(s) have NULL asset_category_name', v_bad_category_name;
  end if;

  -- 3e. deficit_branch_id must never be null.
  select count(*)
    into v_bad_deficit_id
  from public.v_fleet_idle_rebalancing
  where deficit_branch_id is null;

  if v_bad_deficit_id > 0 then
    raise exception 'FAIL 3e: % row(s) have NULL deficit_branch_id', v_bad_deficit_id;
  end if;

  -- 3f. deficit_branch_name must never be null.
  select count(*)
    into v_bad_deficit_name
  from public.v_fleet_idle_rebalancing
  where deficit_branch_name is null;

  if v_bad_deficit_name > 0 then
    raise exception 'FAIL 3f: % row(s) have NULL deficit_branch_name', v_bad_deficit_name;
  end if;

  raise notice 'PASS 3: all rows carry complete branch/category recommendation context';

  -- 4. suggested_transfer_qty must be > 0 on every row.
  select count(*)
    into v_bad_qty_zero
  from public.v_fleet_idle_rebalancing
  where suggested_transfer_qty <= 0;

  if v_bad_qty_zero > 0 then
    raise exception
      'FAIL 4: % row(s) have suggested_transfer_qty <= 0; '
      'the view predicate should suppress zero-transfer candidates', v_bad_qty_zero;
  end if;

  raise notice 'PASS 4: suggested_transfer_qty > 0 on all rows';

  -- 5. suggested_transfer_qty must not exceed idle_count.
  select count(*)
    into v_bad_qty_supply
  from public.v_fleet_idle_rebalancing
  where suggested_transfer_qty > idle_count;

  if v_bad_qty_supply > 0 then
    raise exception
      'FAIL 5: % row(s) have suggested_transfer_qty > idle_count; '
      'the view must cap the recommendation at available supply', v_bad_qty_supply;
  end if;

  raise notice 'PASS 5: suggested_transfer_qty <= idle_count on all rows';

  -- 6. suggested_transfer_qty must not exceed demand_gap.
  select count(*)
    into v_bad_qty_demand
  from public.v_fleet_idle_rebalancing
  where suggested_transfer_qty > demand_gap;

  if v_bad_qty_demand > 0 then
    raise exception
      'FAIL 6: % row(s) have suggested_transfer_qty > demand_gap; '
      'the view must cap the recommendation at unsatisfied demand', v_bad_qty_demand;
  end if;

  raise notice 'PASS 6: suggested_transfer_qty <= demand_gap on all rows';

  raise notice 'Fleet idle-rebalancing reset assertions passed (% recommendation row(s))', v_count;
end;
$$;

rollback;
