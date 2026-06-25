-- Reset-path validation for 20260613001000_inventory_rate_structures.sql.
--
-- Confirms that after a full `supabase db reset`:
--   1. Required tables and functions exist with the expected permission grants.
--   2. Effective-dated rate plans can be created and resolved correctly.
--   3. Deterministic resolution precedence (asset > category_or_kit > branch) is intact.
--   4. staff_save_quote_order persists a resolved_rate_snapshot on the quote line.
--   5. Updating a rate plan after a quote line has been saved does NOT retroactively
--      mutate the snapshot already persisted on that line.

begin;

do $$
declare
  -- 1. Schema-level checks
  v_plans_table         bool;
  v_specials_table      bool;
  v_create_fn           bool;
  v_resolve_fn          bool;
  v_save_quote_fn       bool;
  v_auth_create         bool;
  v_auth_resolve        bool;
  v_anon_create         bool;
  v_anon_resolve        bool;

  -- 2. Rate-plan IDs seeded for behavior checks
  v_branch_plan_id      uuid;
  v_category_plan_id    uuid;
  v_asset_plan_id       uuid;
  v_v2_plan_id          uuid;

  -- 3. Resolution outputs
  v_asset_row           record;
  v_category_row        record;
  v_branch_row          record;
  v_old_row             record;
  v_new_row             record;

  -- 4. Quote-line snapshot persistence
  v_order_id            uuid;
  v_line_id             uuid;
  v_snapshot_before     jsonb;
  v_snapshot_after      jsonb;
  v_src_before          text;
  v_src_after           text;
  v_daily_before        numeric;
begin

  ---------------------------------------------------------------------------
  -- 1. Schema-level checks
  ---------------------------------------------------------------------------
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name = 'inventory_rate_plans'
  ) into v_plans_table;

  if not v_plans_table then
    raise exception 'RESET FAIL 1: table public.inventory_rate_plans missing after reset';
  end if;

  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name = 'inventory_rate_plan_specials'
  ) into v_specials_table;

  if not v_specials_table then
    raise exception 'RESET FAIL 1: table public.inventory_rate_plan_specials missing after reset';
  end if;

  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_create_rate_plan'
  ) into v_create_fn;

  if not v_create_fn then
    raise exception 'RESET FAIL 1: function public.inventory_create_rate_plan missing after reset';
  end if;

  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rental_resolve_rate_plan'
  ) into v_resolve_fn;

  if not v_resolve_fn then
    raise exception 'RESET FAIL 1: function public.rental_resolve_rate_plan missing after reset';
  end if;

  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'staff_save_quote_order'
  ) into v_save_quote_fn;

  if not v_save_quote_fn then
    raise exception 'RESET FAIL 1: function public.staff_save_quote_order missing after reset';
  end if;

  -- authenticated should have execute on both RPCs (look up by OID to avoid
  -- signature drift when the function is updated with new default parameters)
  select has_function_privilege('authenticated', p.oid, 'execute')
    into v_auth_create
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'inventory_create_rate_plan';

  if not v_auth_create then
    raise exception 'RESET FAIL 1: authenticated lacks execute on inventory_create_rate_plan';
  end if;

  select has_function_privilege('authenticated', p.oid, 'execute')
    into v_auth_resolve
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'rental_resolve_rate_plan';

  if not v_auth_resolve then
    raise exception 'RESET FAIL 1: authenticated lacks execute on rental_resolve_rate_plan';
  end if;

  -- anon should NOT have execute on either RPC
  select not has_function_privilege('anon', p.oid, 'execute')
    into v_anon_create
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'inventory_create_rate_plan';

  if not v_anon_create then
    raise exception 'RESET FAIL 1: anon should not have execute on inventory_create_rate_plan';
  end if;

  select not has_function_privilege('anon', p.oid, 'execute')
    into v_anon_resolve
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'rental_resolve_rate_plan';

  if not v_anon_resolve then
    raise exception 'RESET FAIL 1: anon should not have execute on rental_resolve_rate_plan';
  end if;

  raise notice 'RESET PASS 1: schema checks passed (tables, functions, permission grants)';

  ---------------------------------------------------------------------------
  -- 2. Seed test users required for JWT claim resolution
  ---------------------------------------------------------------------------
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (
    'aaaaaaaa-0000-0000-0000-000000000001',
    'authenticated', 'authenticated',
    'reset-rate-admin@example.com', now(), now()
  )
  on conflict (id) do nothing;

  ---------------------------------------------------------------------------
  -- 3. Effective-dated rate plan creation (admin context)
  ---------------------------------------------------------------------------
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"admin"}}',
    true
  );

  -- Branch default plan (v1, effective from 2026-06-01)
  select rate_plan_id into v_branch_plan_id
  from public.inventory_create_rate_plan(
    p_name           => 'Reset branch default',
    p_effective_from => date '2026-06-01',
    p_daily_rate     => 100,
    p_weekly_rate    => 600,
    p_monthly_rate   => 2000,
    p_weekend_rate   => 140,
    p_branch_id      => 'bbbbbbbb-0000-0000-0000-000000000001'
  );

  if v_branch_plan_id is null then
    raise exception 'RESET FAIL 3: branch plan creation returned null';
  end if;

  -- Category plan (higher specificity than branch)
  select rate_plan_id into v_category_plan_id
  from public.inventory_create_rate_plan(
    p_name           => 'Reset category plan',
    p_effective_from => date '2026-06-01',
    p_daily_rate     => 120,
    p_category_id    => 'cccccccc-0000-0000-0000-000000000001',
    p_branch_id      => 'bbbbbbbb-0000-0000-0000-000000000001'
  );

  if v_category_plan_id is null then
    raise exception 'RESET FAIL 3: category plan creation returned null';
  end if;

  -- Asset override plan (highest specificity)
  select rate_plan_id into v_asset_plan_id
  from public.inventory_create_rate_plan(
    p_name           => 'Reset asset override',
    p_effective_from => date '2026-06-01',
    p_daily_rate     => 160,
    p_asset_id       => 'dddddddd-0000-0000-0000-000000000001',
    p_branch_id      => 'bbbbbbbb-0000-0000-0000-000000000001'
  );

  if v_asset_plan_id is null then
    raise exception 'RESET FAIL 3: asset plan creation returned null';
  end if;

  -- Category plan v2 effective from 2026-07-01 (tests effective-date switching)
  select rate_plan_id into v_v2_plan_id
  from public.inventory_create_rate_plan(
    p_name               => 'Reset category plan v2',
    p_effective_from     => date '2026-07-01',
    p_daily_rate         => 150,
    p_category_id        => 'cccccccc-0000-0000-0000-000000000001',
    p_branch_id          => 'bbbbbbbb-0000-0000-0000-000000000001',
    p_supersedes_plan_id => v_category_plan_id
  );

  if v_v2_plan_id is null then
    raise exception 'RESET FAIL 3: category v2 plan creation returned null';
  end if;

  raise notice 'RESET PASS 3: rate plan seeding succeeded on reset schema';

  ---------------------------------------------------------------------------
  -- 4. Deterministic precedence: asset > category > branch
  ---------------------------------------------------------------------------
  select * into v_asset_row
  from public.rental_resolve_rate_plan(
    p_asset_id    => 'dddddddd-0000-0000-0000-000000000001',
    p_category_id => 'cccccccc-0000-0000-0000-000000000001',
    p_branch_id   => 'bbbbbbbb-0000-0000-0000-000000000001',
    p_start_date  => date '2026-06-15',
    p_end_date    => date '2026-06-17',
    p_quantity    => 1
  );

  if v_asset_row.resolution_scope <> 'asset' then
    raise exception 'RESET FAIL 4: expected asset precedence, got %', v_asset_row.resolution_scope;
  end if;

  select * into v_category_row
  from public.rental_resolve_rate_plan(
    p_category_id => 'cccccccc-0000-0000-0000-000000000001',
    p_branch_id   => 'bbbbbbbb-0000-0000-0000-000000000001',
    p_start_date  => date '2026-06-15',
    p_end_date    => date '2026-06-17',
    p_quantity    => 1
  );

  if v_category_row.resolution_scope <> 'category_or_kit' then
    raise exception 'RESET FAIL 4: expected category_or_kit precedence over branch, got %', v_category_row.resolution_scope;
  end if;

  select * into v_branch_row
  from public.rental_resolve_rate_plan(
    p_branch_id  => 'bbbbbbbb-0000-0000-0000-000000000001',
    p_start_date => date '2026-06-15',
    p_end_date   => date '2026-06-17',
    p_quantity   => 1
  );

  if v_branch_row.resolution_scope <> 'branch' then
    raise exception 'RESET FAIL 4: expected branch fallback, got %', v_branch_row.resolution_scope;
  end if;

  raise notice 'RESET PASS 4: deterministic precedence (asset > category_or_kit > branch) verified';

  ---------------------------------------------------------------------------
  -- 5. Effective-date switching: same context, different start date => different plan version
  ---------------------------------------------------------------------------
  select * into v_old_row
  from public.rental_resolve_rate_plan(
    p_category_id => 'cccccccc-0000-0000-0000-000000000001',
    p_branch_id   => 'bbbbbbbb-0000-0000-0000-000000000001',
    p_start_date  => date '2026-06-20',
    p_end_date    => date '2026-06-22',
    p_quantity    => 1
  );

  select * into v_new_row
  from public.rental_resolve_rate_plan(
    p_category_id => 'cccccccc-0000-0000-0000-000000000001',
    p_branch_id   => 'bbbbbbbb-0000-0000-0000-000000000001',
    p_start_date  => date '2026-07-10',
    p_end_date    => date '2026-07-12',
    p_quantity    => 1
  );

  if v_old_row.plan_version = v_new_row.plan_version then
    raise exception 'RESET FAIL 5: expected different plan versions for different effective dates, both returned version %', v_old_row.plan_version;
  end if;

  raise notice 'RESET PASS 5: effective-date version switching verified (v% vs v%)', v_old_row.plan_version, v_new_row.plan_version;

  ---------------------------------------------------------------------------
  -- 6. Quote-line snapshot persistence and immutability after rate-plan edit
  ---------------------------------------------------------------------------

  -- Save a quote line that will auto-resolve against the category plan.
  -- The category plan currently has daily_rate = 120.
  select r.order_id, (r.saved_lines->0->>'line_id')::uuid
    into v_order_id, v_line_id
  from public.staff_save_quote_order(
    p_customer_id        => 'eeeeeeee-0000-0000-0000-000000000001',
    p_billing_account_id => 'ffffffff-0000-0000-0000-000000000001',
    p_lines              => '[
      {
        "line_id": null,
        "category_id": "cccccccc-0000-0000-0000-000000000001",
        "asset_id": null,
        "branch_id": "bbbbbbbb-0000-0000-0000-000000000001",
        "start_date": "2026-06-15",
        "end_date": "2026-06-17",
        "quantity": 1,
        "daily_rate": null,
        "rate_type": "daily",
        "name": "Reset snapshot test line"
      }
    ]'::jsonb
  ) r;

  if v_order_id is null or v_line_id is null then
    raise exception 'RESET FAIL 6: staff_save_quote_order did not return an order/line id';
  end if;

  -- Read the snapshot and resolution source that were persisted at save time.
  select
    ev.data->'resolved_rate_snapshot',
    ev.data->>'rate_resolution_source',
    (ev.data->'resolved_rate_snapshot'->>'resolved_daily_rate')::numeric
    into v_snapshot_before, v_src_before, v_daily_before
  from entities e
  join entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = v_line_id
    and e.entity_type = 'rental_order_line';

  if v_src_before <> 'rate_plan' then
    raise exception 'RESET FAIL 6: expected rate_resolution_source=rate_plan at save, got %', coalesce(v_src_before, '<null>');
  end if;

  if v_snapshot_before is null or jsonb_typeof(v_snapshot_before) <> 'object' then
    raise exception 'RESET FAIL 6: expected resolved_rate_snapshot jsonb object at save, got %', coalesce(jsonb_typeof(v_snapshot_before), 'null');
  end if;

  -- Now mutate the underlying rate plan (simulate a pricing update by an admin).
  -- Direct UPDATE is allowed for admin role.
  update public.inventory_rate_plans
     set daily_rate = 999
   where id = v_category_plan_id;

  -- Re-read the persisted snapshot on the same quote line. It must be unchanged.
  select
    ev.data->'resolved_rate_snapshot',
    ev.data->>'rate_resolution_source'
    into v_snapshot_after, v_src_after
  from entities e
  join entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = v_line_id
    and e.entity_type = 'rental_order_line';

  if v_snapshot_after is distinct from v_snapshot_before then
    raise exception
      'RESET FAIL 6: snapshot mutated after rate-plan update; before=%, after=%',
      v_snapshot_before, v_snapshot_after;
  end if;

  if (v_snapshot_after->>'resolved_daily_rate')::numeric = 999 then
    raise exception
      'RESET FAIL 6: snapshot daily_rate was retroactively changed to 999; snapshot=%',
      v_snapshot_after;
  end if;

  raise notice 'RESET PASS 6: quote-line snapshot is immutable after rate-plan update (daily_rate stayed at %, not 999)', v_daily_before;

end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

rollback;
