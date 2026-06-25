-- Behavioral tests for inventory rate structures / resolver.
-- Validates precedence, effective dating, weekend/special overrides, and
-- quote-line snapshot persistence from staff_save_quote_order.

begin;

-- Seed actor for admin JWT subject references.
insert into auth.users (id, aud, role, email, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000000199',
  'authenticated',
  'authenticated',
  'rate-admin@example.com',
  now(),
  now()
)
on conflict (id) do nothing;

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  (
    '00000000-0000-0000-0000-000000000200',
    'authenticated',
    'authenticated',
    'rate-manager@example.com',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000201',
    'authenticated',
    'authenticated',
    'rate-readonly@example.com',
    now(),
    now()
  )
on conflict (id) do nothing;

-- 1) anon denied admin create RPC
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform public.inventory_create_rate_plan(
      p_name => 'Anon denied',
      p_effective_from => date '2026-01-01',
      p_daily_rate => 100
    );
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 1: anon should be denied inventory_create_rate_plan';
  end if;

  raise notice 'PASS 1: anon denied inventory_create_rate_plan';
end;
$$;

reset role;

-- 2) seed plans as admin
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000199","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_branch_plan      uuid;
  v_category_plan    uuid;
  v_asset_plan       uuid;
  v_versioned_plan   uuid;
begin
  -- Branch default
  select rate_plan_id
    into v_branch_plan
  from public.inventory_create_rate_plan(
    p_name => 'Branch default',
    p_effective_from => date '2026-06-01',
    p_daily_rate => 100,
    p_weekly_rate => 600,
    p_monthly_rate => 2000,
    p_weekend_rate => 140,
    p_branch_id => '11111111-1111-1111-1111-111111111111',
    p_specials => '[{"name":"Holiday Weekend","start_date":"2026-06-13","end_date":"2026-06-13","daily_rate":180,"priority":1}]'::jsonb
  );

  -- Category-level plan (higher than branch)
  select rate_plan_id
    into v_category_plan
  from public.inventory_create_rate_plan(
    p_name => 'Category plan',
    p_effective_from => date '2026-06-01',
    p_daily_rate => 120,
    p_weekly_rate => 700,
    p_category_id => '22222222-2222-2222-2222-222222222222',
    p_branch_id => '11111111-1111-1111-1111-111111111111'
  );

  -- Asset override (highest)
  select rate_plan_id
    into v_asset_plan
  from public.inventory_create_rate_plan(
    p_name => 'Asset override',
    p_effective_from => date '2026-06-01',
    p_daily_rate => 160,
    p_asset_id => '33333333-3333-3333-3333-333333333333',
    p_branch_id => '11111111-1111-1111-1111-111111111111'
  );

  -- Versioned category plan update for effective-date test
  select rate_plan_id
    into v_versioned_plan
  from public.inventory_create_rate_plan(
    p_name => 'Category plan v2',
    p_effective_from => date '2026-07-01',
    p_daily_rate => 150,
    p_category_id => '22222222-2222-2222-2222-222222222222',
    p_branch_id => '11111111-1111-1111-1111-111111111111',
    p_supersedes_plan_id => v_category_plan
  );

  if v_branch_plan is null or v_category_plan is null or v_asset_plan is null or v_versioned_plan is null then
    raise exception 'FAIL 2: expected seeded rate plans to be created';
  end if;

  raise notice 'PASS 2: seeded branch/category/asset/versioned rate plans';
end;
$$;

-- 3) direct table write/read matrix (grant -> rls -> policy -> claims chain)

do $$
declare
  v_direct_plan_id uuid;
  v_count int;
begin
  insert into public.inventory_rate_plans (
    name,
    version_number,
    effective_from,
    daily_rate,
    branch_id
  )
  values (
    'Direct admin plan',
    1,
    date '2026-01-01',
    111,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  )
  returning id into v_direct_plan_id;

  if v_direct_plan_id is null then
    raise exception 'FAIL 3: admin direct insert to inventory_rate_plans failed';
  end if;

  update public.inventory_rate_plans
     set notes = 'updated-by-admin-direct'
   where id = v_direct_plan_id;

  if not found then
    raise exception 'FAIL 3: admin direct update to inventory_rate_plans failed';
  end if;

  insert into public.inventory_rate_plan_specials (
    rate_plan_id,
    name,
    start_date,
    end_date,
    daily_rate,
    priority
  )
  values (
    v_direct_plan_id,
    'Direct admin special',
    date '2026-01-10',
    date '2026-01-10',
    222,
    10
  );

  select count(*)
    into v_count
  from public.inventory_rate_plan_specials
  where rate_plan_id = v_direct_plan_id;

  if v_count <> 1 then
    raise exception 'FAIL 3: expected admin direct special insert to persist, got % row(s)', v_count;
  end if;

  raise notice 'PASS 3: admin direct table writes succeeded through grant + rls policy chain';
end;
$$;

-- 4) non-admin role matrix on table writes / reads + resolver RPC

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000200","role":"authenticated","app_metadata":{"role":"branch_manager"}}',
  true
);

do $$
declare
  v_caught boolean;
  v_plan_rows int;
  v_special_rows int;
  v_resolved record;
begin
  -- branch_manager: read + resolve allowed, admin-write surfaces denied
  select count(*) into v_plan_rows from public.inventory_rate_plans;
  select count(*) into v_special_rows from public.inventory_rate_plan_specials;
  if v_plan_rows <= 0 or v_special_rows <= 0 then
    raise exception 'FAIL 4: branch_manager expected to read rate plans/specials (plans=% specials=%)', v_plan_rows, v_special_rows;
  end if;

  select * into v_resolved
  from public.rental_resolve_rate_plan(
    p_category_id => '22222222-2222-2222-2222-222222222222',
    p_branch_id => '11111111-1111-1111-1111-111111111111',
    p_start_date => date '2026-06-20',
    p_end_date => date '2026-06-22',
    p_quantity => 1
  );

  if v_resolved.rate_plan_id is null then
    raise exception 'FAIL 4: branch_manager should resolve rate plan';
  end if;

  v_caught := false;
  begin
    insert into public.inventory_rate_plans (
      name,
      version_number,
      effective_from,
      daily_rate
    )
    values (
      'Branch manager denied direct write',
      1,
      date '2026-06-01',
      99
    );
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlstate = '42501' then v_caught := true;
      else raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4: branch_manager direct write should be denied by RLS policy';
  end if;

  v_caught := false;
  begin
    perform public.inventory_create_rate_plan(
      p_name => 'Branch manager denied RPC',
      p_effective_from => date '2026-06-01',
      p_daily_rate => 88
    );
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlstate = '42501' then v_caught := true;
      else raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4: branch_manager should be denied inventory_create_rate_plan';
  end if;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000201","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught boolean;
  v_plan_rows int;
begin
  -- read_only: no write and no table rows (policy excludes read_only)
  select count(*) into v_plan_rows from public.inventory_rate_plans;
  if v_plan_rows <> 0 then
    raise exception 'FAIL 4: read_only should not see inventory_rate_plans rows, got %', v_plan_rows;
  end if;

  v_caught := false;
  begin
    insert into public.inventory_rate_plans (
      name,
      version_number,
      effective_from,
      daily_rate
    )
    values (
      'Read only denied direct write',
      1,
      date '2026-06-01',
      77
    );
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlstate = '42501' then v_caught := true;
      else raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4: read_only direct write should be denied';
  end if;
end;
$$;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught boolean;
begin
  -- anon: no grant on table and no execute on resolver
  v_caught := false;
  begin
    perform count(*) from public.inventory_rate_plans;
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlstate = '42501' then v_caught := true;
      else raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4: anon should not have direct SELECT on inventory_rate_plans';
  end if;

  v_caught := false;
  begin
    perform public.rental_resolve_rate_plan(
      p_category_id => '22222222-2222-2222-2222-222222222222',
      p_branch_id => '11111111-1111-1111-1111-111111111111',
      p_start_date => date '2026-06-20',
      p_end_date => date '2026-06-22',
      p_quantity => 1
    );
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlstate = '42501' then v_caught := true;
      else raise;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4: anon should be denied rental_resolve_rate_plan';
  end if;

  raise notice 'PASS 4: non-admin role matrix validated for table/RPC authorization chain';
end;
$$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000199","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

-- 5) precedence + weekend/special resolution

do $$
declare
  v_row        record;
  v_branch_resolution record;
  v_segments   jsonb;
  v_has_special boolean;
begin
  select * into v_row
  from public.rental_resolve_rate_plan(
    p_asset_id => '33333333-3333-3333-3333-333333333333',
    p_category_id => '22222222-2222-2222-2222-222222222222',
    p_branch_id => '11111111-1111-1111-1111-111111111111',
    p_start_date => date '2026-06-12',
    p_end_date => date '2026-06-15',
    p_quantity => 1
  );

  -- Asset override should win in this context.
  if v_row.resolution_scope <> 'asset' then
    raise exception 'FAIL 5: expected asset precedence, got %', v_row.resolution_scope;
  end if;

  select * into v_branch_resolution
  from public.rental_resolve_rate_plan(
    p_branch_id => '11111111-1111-1111-1111-111111111111',
    p_start_date => date '2026-06-12',
    p_end_date => date '2026-06-15',
    p_quantity => 1
  );

  if v_branch_resolution.resolution_scope <> 'branch' then
    raise exception 'FAIL 5: expected branch fallback for segmentation check, got %', v_branch_resolution.resolution_scope;
  end if;

  v_segments := v_branch_resolution.rate_breakdown->'segments';
  if jsonb_array_length(v_segments) < 2 then
    raise exception 'FAIL 5: expected segmented weekend/special breakdown';
  end if;

  select exists (
    select 1
    from jsonb_array_elements(v_segments) as segment
    where segment->>'rate_type' = 'special'
  )
  into v_has_special;

  if not v_has_special then
    raise exception 'FAIL 5: expected at least one special-rate segment';
  end if;

  raise notice 'PASS 5: precedence + weekend/special segmentation resolved';
end;
$$;

-- 6) effective date versioning: same context, different start date => different plan

do $$
declare
  v_old record;
  v_new record;
begin
  select * into v_old
  from public.rental_resolve_rate_plan(
    p_category_id => '22222222-2222-2222-2222-222222222222',
    p_branch_id => '11111111-1111-1111-1111-111111111111',
    p_start_date => date '2026-06-20',
    p_end_date => date '2026-06-22',
    p_quantity => 1
  );

  select * into v_new
  from public.rental_resolve_rate_plan(
    p_category_id => '22222222-2222-2222-2222-222222222222',
    p_branch_id => '11111111-1111-1111-1111-111111111111',
    p_start_date => date '2026-07-10',
    p_end_date => date '2026-07-12',
    p_quantity => 1
  );

  if v_old.plan_version = v_new.plan_version then
    raise exception 'FAIL 6: expected different plan versions across effective dates';
  end if;

  raise notice 'PASS 6: effective-dated plan version selection works';
end;
$$;

-- 7) staff_save_quote_order auto-resolves and snapshots when daily_rate omitted

do $$
declare
  v_order_id          uuid;
  v_line_id           uuid;
  v_res_snapshot      jsonb;
  v_resolution_source text;
begin
  select r.order_id, (r.saved_lines->0->>'line_id')::uuid
    into v_order_id, v_line_id
  from public.staff_save_quote_order(
    p_customer_id => '44444444-4444-4444-4444-444444444444',
    p_billing_account_id => '55555555-5555-5555-5555-555555555555',
    p_lines => '[
      {
        "line_id": null,
        "category_id": "22222222-2222-2222-2222-222222222222",
        "asset_id": null,
        "branch_id": "11111111-1111-1111-1111-111111111111",
        "start_date": "2026-07-11",
        "end_date": "2026-07-13",
        "quantity": 2,
        "daily_rate": null,
        "rate_type": "daily",
        "name": "Auto-resolve line"
      }
    ]'::jsonb
  ) r;

  select ev.data->'resolved_rate_snapshot', ev.data->>'rate_resolution_source'
    into v_res_snapshot, v_resolution_source
  from entities e
  join entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = v_line_id
    and e.entity_type = 'rental_order_line';

  if v_order_id is null or v_line_id is null then
    raise exception 'FAIL 7: expected order and line ids from staff_save_quote_order';
  end if;

  if v_resolution_source <> 'rate_plan' then
    raise exception 'FAIL 7: expected rate_resolution_source=rate_plan, got %', coalesce(v_resolution_source, '<null>');
  end if;

  if v_res_snapshot is null or jsonb_typeof(v_res_snapshot) <> 'object' then
    raise exception 'FAIL 7: expected resolved_rate_snapshot object';
  end if;

  raise notice 'PASS 7: quote save persisted resolved snapshot from rate plan';
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

rollback;
