-- Behavioral authorization tests for inventory-kit surfaces added in
-- 20260613002000_inventory_kits_bundles.sql.
--
-- Assertions:
--   0. Grant checks for new kit RPCs/views.
--   1. anon is denied staff_upsert_inventory_kit.
--   2. authenticated read_only is denied staff_upsert_inventory_kit.
--   3. authenticated field_operator is denied staff_upsert_inventory_kit.
--   4. admin can upsert a kit and read kit views.
--   5. branch_manager can update an existing kit.
--   6. anon cannot read kit views.
--   7. read_only can read kit views.
--   8. anon is denied rental_kit_availability.
--   9. authenticated read_only can call rental_kit_availability.
--  10. authenticated read_only is denied staff_save_quote_order.
--  11. admin staff_save_quote_order persists kit_id + kit_component_snapshot.

begin;

create temporary table if not exists _kit_test_ctx (
  kit_id uuid not null,
  category_id uuid not null
);
grant select, insert, update, delete on _kit_test_ctx to authenticated, anon;
truncate table _kit_test_ctx;

-- ── 0. Grant checks ───────────────────────────────────────────────────────────
do $$
begin
  if not has_function_privilege(
    'authenticated',
    'public.staff_upsert_inventory_kit(uuid,text,text,date,date,uuid,jsonb,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Expected authenticated EXECUTE grant on staff_upsert_inventory_kit';
  end if;

  if has_function_privilege(
    'anon',
    'public.staff_upsert_inventory_kit(uuid,text,text,date,date,uuid,jsonb,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'anon should NOT have EXECUTE on staff_upsert_inventory_kit';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.rental_kit_availability(uuid,uuid,date,date,int)',
    'EXECUTE'
  ) then
    raise exception 'Expected authenticated EXECUTE grant on rental_kit_availability';
  end if;

  if has_function_privilege(
    'anon',
    'public.rental_kit_availability(uuid,uuid,date,date,int)',
    'EXECUTE'
  ) then
    raise exception 'anon should NOT have EXECUTE on rental_kit_availability';
  end if;

  if not has_table_privilege('authenticated', 'public.rental_current_inventory_kits', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on rental_current_inventory_kits';
  end if;

  if not has_table_privilege('authenticated', 'public.rental_inventory_kit_components_current', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on rental_inventory_kit_components_current';
  end if;

  if has_table_privilege('anon', 'public.rental_current_inventory_kits', 'SELECT') then
    raise exception 'anon should NOT have SELECT on rental_current_inventory_kits';
  end if;

  if has_table_privilege('anon', 'public.rental_inventory_kit_components_current', 'SELECT') then
    raise exception 'anon should NOT have SELECT on rental_inventory_kit_components_current';
  end if;

  raise notice 'PASS 0: grant checks passed for kit RPCs/views';
end;
$$;

-- ── 1. anon denied staff_upsert_inventory_kit ─────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_upsert_inventory_kit(p_name => 'Anon Blocked Kit');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' or sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 1: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 1: anon should be denied staff_upsert_inventory_kit';
  end if;

  raise notice 'PASS 1: anon denied staff_upsert_inventory_kit';
end;
$$;

reset role;

-- ── 2. read_only denied staff_upsert_inventory_kit ────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000010","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_upsert_inventory_kit(p_name => 'Read Only Blocked Kit');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 2: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 2: read_only should be denied staff_upsert_inventory_kit';
  end if;

  raise notice 'PASS 2: read_only denied staff_upsert_inventory_kit';
end;
$$;

reset role;

-- ── 3. field_operator denied staff_upsert_inventory_kit ───────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000011","app_metadata":{"role":"field_operator"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_upsert_inventory_kit(p_name => 'Field Operator Blocked Kit');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 3: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 3: field_operator should be denied staff_upsert_inventory_kit';
  end if;

  raise notice 'PASS 3: field_operator denied staff_upsert_inventory_kit';
end;
$$;

reset role;

-- ── 4. admin can upsert kit + read kit views ───────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000012","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_kit_id uuid;
  v_category_id uuid;
  v_entity_version_id uuid;
  v_version_number bigint;
  v_component_count int;
begin
  select seeded.entity_id
    into v_category_id
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_data => jsonb_build_object(
      'name', 'Auth Test Category',
      'description', 'Category created by inventory_kits_access.sql'
    )
  ) as seeded;

  if v_category_id is null then
    raise exception 'FAIL 4: unable to seed asset_category for kit component';
  end if;

  select k.kit_id, k.entity_version_id, k.version_number
    into v_kit_id, v_entity_version_id, v_version_number
  from public.staff_upsert_inventory_kit(
    p_name => 'Auth Test Kit',
    p_description => 'kit auth behavior test',
    p_components => jsonb_build_array(
      jsonb_build_object(
        'component_type', 'asset_category',
        'component_id', v_category_id,
        'component_name', 'Auth Test Category',
        'quantity', 2,
        'is_required', true,
        'is_default', true
      )
    )
  ) as k;

  if v_kit_id is null or v_entity_version_id is null or v_version_number < 1 then
    raise exception 'FAIL 4: admin upsert did not return expected identifiers';
  end if;

  insert into _kit_test_ctx(kit_id, category_id) values (v_kit_id, v_category_id);

  if not exists (
    select 1
    from public.rental_current_inventory_kits kits
    where kits.entity_id = v_kit_id
      and kits.name = 'Auth Test Kit'
  ) then
    raise exception 'FAIL 4: upserted kit not visible in rental_current_inventory_kits';
  end if;

  select count(*)
    into v_component_count
  from public.rental_inventory_kit_components_current components
  where components.kit_id = v_kit_id;

  if v_component_count <> 1 then
    raise exception 'FAIL 4: expected 1 component row, got %', v_component_count;
  end if;

  raise notice 'PASS 4: admin upserted kit and can read kit views';
end;
$$;

reset role;

-- ── 5. branch_manager can update existing kit ──────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000013","app_metadata":{"role":"branch_manager"}}',
  true
);

do $$
declare
  v_kit_id uuid;
  v_category_id uuid;
  v_name text;
begin
  select kit_id, category_id into v_kit_id, v_category_id from _kit_test_ctx limit 1;

  perform public.staff_upsert_inventory_kit(
    p_kit_id => v_kit_id,
    p_name => 'Auth Test Kit Updated',
    p_description => 'kit auth behavior test (updated)',
    p_components => jsonb_build_array(
      jsonb_build_object(
        'component_type', 'asset_category',
        'component_id', v_category_id,
        'quantity', 1,
        'is_required', true,
        'is_default', false
      )
    )
  );

  select kits.name
    into v_name
  from public.rental_current_inventory_kits kits
  where kits.entity_id = v_kit_id;

  if v_name <> 'Auth Test Kit Updated' then
    raise exception 'FAIL 5: branch_manager update not reflected in kit view (name=%)', coalesce(v_name, '<null>');
  end if;

  raise notice 'PASS 5: branch_manager updated existing kit';
end;
$$;

reset role;

-- ── 6. anon cannot read kit views ───────────────────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform 1 from public.rental_current_inventory_kits limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then v_caught := true;
      else raise exception 'FAIL 6: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 6: anon should be denied rental_current_inventory_kits';
  end if;

  v_caught := false;
  begin
    perform 1 from public.rental_inventory_kit_components_current limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then v_caught := true;
      else raise exception 'FAIL 6: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 6: anon should be denied rental_inventory_kit_components_current';
  end if;

  raise notice 'PASS 6: anon denied kit views';
end;
$$;

reset role;

-- ── 7. read_only can read kit views ────────────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000014","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_kit_id uuid;
  v_component_count int;
begin
  select kit_id into v_kit_id from _kit_test_ctx limit 1;

  if not exists (
    select 1
    from public.rental_current_inventory_kits kits
    where kits.entity_id = v_kit_id
  ) then
    raise exception 'FAIL 7: read_only could not read expected kit row';
  end if;

  select count(*)
    into v_component_count
  from public.rental_inventory_kit_components_current components
  where components.kit_id = v_kit_id;

  if v_component_count < 1 then
    raise exception 'FAIL 7: read_only could not read expected kit component rows';
  end if;

  raise notice 'PASS 7: read_only can read kit views';
end;
$$;

reset role;

-- ── 8. anon denied rental_kit_availability ─────────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_kit_id uuid;
  v_caught bool := false;
begin
  select kit_id into v_kit_id from _kit_test_ctx limit 1;

  begin
    perform * from public.rental_kit_availability(p_kit_id => v_kit_id, p_quantity => 1);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then v_caught := true;
      else raise exception 'FAIL 8: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 8: anon should be denied rental_kit_availability';
  end if;

  raise notice 'PASS 8: anon denied rental_kit_availability';
end;
$$;

reset role;

-- ── 9. read_only can call rental_kit_availability ──────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000015","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_kit_id uuid;
  v_row record;
begin
  select kit_id into v_kit_id from _kit_test_ctx limit 1;

  select *
    into v_row
  from public.rental_kit_availability(
    p_kit_id => v_kit_id,
    p_start_date => current_date,
    p_end_date => current_date + 1,
    p_quantity => 1
  );

  if v_row.kit_id is distinct from v_kit_id then
    raise exception 'FAIL 9: expected rental_kit_availability kit_id %, got %', v_kit_id, v_row.kit_id;
  end if;

  raise notice 'PASS 9: read_only can call rental_kit_availability';
end;
$$;

reset role;

-- ── 10. read_only denied staff_save_quote_order ────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000016","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_save_quote_order(
      p_lines => '[]'::jsonb
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 10: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 10: read_only should be denied staff_save_quote_order';
  end if;

  raise notice 'PASS 10: read_only denied staff_save_quote_order';
end;
$$;

reset role;

-- ── 11. admin save persists kit_id + kit_component_snapshot ────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000017","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_kit_id uuid;
  v_category_id uuid;
  v_saved_lines jsonb;
  v_line_id uuid;
  v_line_data jsonb;
  v_kit_snapshot jsonb;
begin
  select kit_id, category_id into v_kit_id, v_category_id from _kit_test_ctx limit 1;

  select r.saved_lines
    into v_saved_lines
  from public.staff_save_quote_order(
    p_lines => jsonb_build_array(
      jsonb_build_object(
        'line_id', null,
        'category_id', v_category_id,
        'asset_id', null,
        'branch_id', null,
        'kit_id', v_kit_id,
        'start_date', to_char(current_date + 2, 'YYYY-MM-DD'),
        'end_date', to_char(current_date + 4, 'YYYY-MM-DD'),
        'quantity', 1,
        'daily_rate', 125.00,
        'rate_type', 'daily',
        'name', 'Kit line auth test'
      )
    )
  ) as r;

  v_line_id := nullif(v_saved_lines->0->>'line_id', '')::uuid;
  if v_line_id is null then
    raise exception 'FAIL 11: expected line_id from staff_save_quote_order';
  end if;

  select ev.data
    into v_line_data
  from entities e
  join entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.id = v_line_id
    and e.entity_type = 'rental_order_line';

  if coalesce(v_line_data->>'kit_id', '') <> v_kit_id::text then
    raise exception 'FAIL 11: expected persisted kit_id % on rental_order_line, got %',
      v_kit_id,
      coalesce(v_line_data->>'kit_id', '<null>');
  end if;

  v_kit_snapshot := coalesce(v_line_data->'kit_component_snapshot', '[]'::jsonb);
  if jsonb_typeof(v_kit_snapshot) <> 'array'
     or jsonb_array_length(v_kit_snapshot) < 1 then
    raise exception 'FAIL 11: expected non-empty kit_component_snapshot array on rental_order_line';
  end if;

  raise notice 'PASS 11: staff_save_quote_order persisted kit linkage and snapshot';
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

rollback;
