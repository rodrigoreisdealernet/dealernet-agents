-- Inventory item-type model regression tests
--
-- Tests the create_stock_item RPC, inventory_kind_guard function,
-- and the rental_current_stock_items view.
--
-- Run via: bash supabase/tests/run_inventory_item_type_model.sh

begin;

do $$
declare
  v_branch_id          uuid;
  v_category_id        uuid;
  v_stock_item_id      uuid;
  v_entity_version_id  uuid;
  v_version_number     int;
  v_inventory_kind     text;
  v_fact_type_id_ob    uuid;
  v_fact_type_id_adj   uuid;
  v_name               text;
  v_op_status          text;
  v_is_valid           boolean;
  v_error_msg          text;
  v_count              bigint;
  v_description        text;
begin
  -- Functional tests exercise validation and data logic, not the auth guard.
  -- Set service_role claim so the RPC auth guard passes for all calls in this block.
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- -------------------------------------------------------------------------
  -- Setup: create a branch and asset_category to use in relationship tests
  -- -------------------------------------------------------------------------

  -- Create branch entity
  insert into entities (entity_type) values ('branch') returning id into v_branch_id;
  insert into entity_versions (entity_id, version_number, data)
  values (v_branch_id, 1, '{"name":"Test Branch"}'::jsonb);

  -- Create asset_category entity
  insert into entities (entity_type) values ('asset_category') returning id into v_category_id;
  insert into entity_versions (entity_id, version_number, data)
  values (v_category_id, 1, '{"name":"Test Category"}'::jsonb);

  -- -------------------------------------------------------------------------
  -- Test 1: fact types for stock quantity tracking are present
  -- -------------------------------------------------------------------------

  select id into v_fact_type_id_ob from fact_types where key = 'stock_opening_balance';
  assert v_fact_type_id_ob is not null,
    'FAIL: stock_opening_balance fact type must exist';

  select id into v_fact_type_id_adj from fact_types where key = 'stock_quantity_adjustment';
  assert v_fact_type_id_adj is not null,
    'FAIL: stock_quantity_adjustment fact type must exist';

  raise notice 'PASS: stock quantity fact types exist';

  -- -------------------------------------------------------------------------
  -- Test 2: inventory_kind_guard — valid combinations
  -- -------------------------------------------------------------------------

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('serialized', 'asset');
  assert v_is_valid = true,
    'FAIL: serialized + asset should be valid';

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('bulk', 'stock_item');
  assert v_is_valid = true,
    'FAIL: bulk + stock_item should be valid';

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('sale', 'stock_item');
  assert v_is_valid = true,
    'FAIL: sale + stock_item should be valid';

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('part', 'stock_item');
  assert v_is_valid = true,
    'FAIL: part + stock_item should be valid';

  raise notice 'PASS: inventory_kind_guard valid combinations';

  -- -------------------------------------------------------------------------
  -- Test 3: inventory_kind_guard — invalid combinations
  -- -------------------------------------------------------------------------

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('bulk', 'asset');
  assert v_is_valid = false,
    'FAIL: bulk + asset should be invalid';
  assert v_error_msg is not null,
    'FAIL: invalid combination must return an error message';

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('serialized', 'stock_item');
  assert v_is_valid = false,
    'FAIL: serialized + stock_item should be invalid';

  raise notice 'PASS: inventory_kind_guard invalid combinations rejected';

  -- -------------------------------------------------------------------------
  -- Test 4: create_stock_item rejects invalid inventory_kind
  -- -------------------------------------------------------------------------

  begin
    perform create_stock_item(
      p_name           => 'Test Item',
      p_inventory_kind => 'serialized'
    );
    assert false, 'FAIL: create_stock_item should reject inventory_kind=serialized';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: create_stock_item rejects inventory_kind=serialized with 22023';
  end;

  begin
    perform create_stock_item(
      p_name           => 'Test Item',
      p_inventory_kind => 'invalid_kind'
    );
    assert false, 'FAIL: create_stock_item should reject unknown inventory_kind';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: create_stock_item rejects unknown inventory_kind';
  end;

  -- -------------------------------------------------------------------------
  -- Test 5: create_stock_item rejects empty name
  -- -------------------------------------------------------------------------

  begin
    perform create_stock_item(
      p_name           => '   ',
      p_inventory_kind => 'bulk'
    );
    assert false, 'FAIL: create_stock_item should reject blank name';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: create_stock_item rejects blank name';
  end;

  -- -------------------------------------------------------------------------
  -- Test 6: create_stock_item rejects non-existent branch_id
  -- -------------------------------------------------------------------------

  begin
    perform create_stock_item(
      p_name           => 'Test Item',
      p_inventory_kind => 'bulk',
      p_branch_id      => gen_random_uuid()
    );
    assert false, 'FAIL: create_stock_item should reject non-existent branch_id';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: create_stock_item rejects non-existent branch_id';
  end;

  -- -------------------------------------------------------------------------
  -- Test 7: create_stock_item rejects non-existent asset_category_id
  -- -------------------------------------------------------------------------

  begin
    perform create_stock_item(
      p_name                => 'Test Item',
      p_inventory_kind      => 'bulk',
      p_asset_category_id   => gen_random_uuid()
    );
    assert false, 'FAIL: create_stock_item should reject non-existent asset_category_id';
  exception
    when sqlstate '22023' then
      raise notice 'PASS: create_stock_item rejects non-existent asset_category_id';
  end;

  -- -------------------------------------------------------------------------
  -- Test 8: create_stock_item succeeds for bulk kind
  -- -------------------------------------------------------------------------

  select entity_id, entity_version_id, version_number
  into v_stock_item_id, v_entity_version_id, v_version_number
  from create_stock_item(
    p_name              => 'Hydraulic Oil 20L',
    p_inventory_kind    => 'bulk',
    p_branch_id         => v_branch_id,
    p_asset_category_id => v_category_id,
    p_description       => 'Premium hydraulic oil for machinery',
    p_opening_quantity  => 50
  );

  assert v_stock_item_id is not null, 'FAIL: create_stock_item must return entity_id';
  assert v_entity_version_id is not null, 'FAIL: create_stock_item must return entity_version_id';
  assert v_version_number = 1, 'FAIL: first version must be version_number = 1';

  raise notice 'PASS: create_stock_item created entity with id %', v_stock_item_id;

  -- Verify entity_type
  select count(*) into v_count
  from entities
  where id = v_stock_item_id and entity_type = 'stock_item';
  assert v_count = 1, 'FAIL: entity must have entity_type = stock_item';

  -- Verify version data
  select
    data ->> 'name'               as name,
    data ->> 'inventory_kind'     as inventory_kind,
    data ->> 'description'        as description,
    data ->> 'operational_status' as op_status
  into v_name, v_inventory_kind, v_description, v_op_status
  from entity_versions
  where entity_id = v_stock_item_id and is_current;

  assert v_name = 'Hydraulic Oil 20L', 'FAIL: name must be stored correctly';
  assert v_inventory_kind = 'bulk', 'FAIL: inventory_kind must be bulk';
  assert v_description = 'Premium hydraulic oil for machinery', 'FAIL: description must be stored';
  assert v_op_status = 'available', 'FAIL: operational_status must default to available';

  raise notice 'PASS: entity version data correct';

  -- -------------------------------------------------------------------------
  -- Test 9: branch and category relationships created
  -- -------------------------------------------------------------------------

  select count(*) into v_count
  from relationships_v2
  where relationship_type = 'branch_has_stock_item'
    and parent_id = v_branch_id
    and child_id = v_stock_item_id
    and is_current;
  assert v_count = 1, 'FAIL: branch_has_stock_item relationship must be created';

  select count(*) into v_count
  from relationships_v2
  where relationship_type = 'asset_category_has_stock_item'
    and parent_id = v_category_id
    and child_id = v_stock_item_id
    and is_current;
  assert v_count = 1, 'FAIL: asset_category_has_stock_item relationship must be created';

  raise notice 'PASS: branch and category relationships created';

  -- -------------------------------------------------------------------------
  -- Test 10: opening balance time-series point recorded
  -- -------------------------------------------------------------------------

  select count(*) into v_count
  from time_series_points tsp
  join fact_types ft on ft.id = tsp.fact_type_id
  where tsp.entity_id = v_stock_item_id
    and ft.key = 'stock_opening_balance'
    and (tsp.data_payload ->> 'quantity')::numeric = 50;
  assert v_count = 1, 'FAIL: opening balance time-series point must be recorded with quantity=50';

  raise notice 'PASS: opening balance recorded in time_series_points';

  -- -------------------------------------------------------------------------
  -- Test 11: create_stock_item without branch/category/quantity succeeds
  -- -------------------------------------------------------------------------

  declare
    v_minimal_id uuid;
  begin
    select entity_id into v_minimal_id
    from create_stock_item(
      p_name           => 'Minimal Item',
      p_inventory_kind => 'part'
    );
    assert v_minimal_id is not null, 'FAIL: minimal create must succeed';

    -- No opening balance TSP should be created
    select count(*) into v_count
    from time_series_points tsp
    join fact_types ft on ft.id = tsp.fact_type_id
    where tsp.entity_id = v_minimal_id
      and ft.key = 'stock_opening_balance';
    assert v_count = 0, 'FAIL: no opening balance when opening_quantity is null';
  end;

  raise notice 'PASS: minimal create_stock_item (no branch/category/quantity)';

  -- -------------------------------------------------------------------------
  -- Test 12: create_stock_item for sale kind
  -- -------------------------------------------------------------------------

  declare
    v_sale_id uuid;
  begin
    select entity_id into v_sale_id
    from create_stock_item(
      p_name           => 'Safety Helmet',
      p_inventory_kind => 'sale',
      p_opening_quantity => 100
    );
    assert v_sale_id is not null, 'FAIL: sale item create must succeed';

    select data ->> 'inventory_kind' into v_inventory_kind
    from entity_versions
    where entity_id = v_sale_id and is_current;
    assert v_inventory_kind = 'sale', 'FAIL: inventory_kind must be sale';
  end;

  raise notice 'PASS: create_stock_item for sale kind';

  -- -------------------------------------------------------------------------
  -- Test 13: rental_current_stock_items view returns created items
  -- -------------------------------------------------------------------------

  select count(*) into v_count
  from rental_current_stock_items
  where entity_id = v_stock_item_id;
  assert v_count = 1, 'FAIL: created stock item must appear in rental_current_stock_items';

  select inventory_kind into v_inventory_kind
  from rental_current_stock_items
  where entity_id = v_stock_item_id;
  assert v_inventory_kind = 'bulk', 'FAIL: rental_current_stock_items must expose inventory_kind';

  raise notice 'PASS: rental_current_stock_items returns correct data';

  -- -------------------------------------------------------------------------
  -- Test 14: rental_current_inventory_records includes both asset and stock_item
  -- -------------------------------------------------------------------------

  -- Create an asset for comparison
  declare
    v_asset_id uuid;
  begin
    insert into entities (entity_type) values ('asset') returning id into v_asset_id;
    insert into entity_versions (entity_id, version_number, data)
    values (v_asset_id, 1, jsonb_build_object(
      'name', 'Test Excavator',
      'inventory_kind', 'serialized',
      'operational_status', 'available'
    ));
    insert into relationships_v2 (relationship_type, parent_id, child_id)
    values ('branch_has_asset', v_branch_id, v_asset_id);

    select count(*) into v_count
    from rental_current_inventory_records
    where entity_id in (v_stock_item_id, v_asset_id);
    assert v_count >= 2, 'FAIL: rental_current_inventory_records must include both asset and stock_item';

    select inventory_kind into v_inventory_kind
    from rental_current_inventory_records
    where entity_id = v_asset_id;
    assert v_inventory_kind = 'serialized', 'FAIL: asset inventory_kind defaults to serialized';
  end;

  raise notice 'PASS: rental_current_inventory_records unified view';

  raise notice 'ALL TESTS PASSED';
end;
$$;

rollback;

-- ============================================================================
-- Role/JWT behavioral authorization tests
--
-- Assertions:
--   A.  Grant checks: authenticated has EXECUTE on create_stock_item and SELECT
--       on rental_current_stock_items; anon has neither.
--   B.  anon denied execute on create_stock_item.
--   C.  authenticated with no app-role claim denied (42501).
--   D.  authenticated with read_only app-role denied (42501).
--   E.  service_role (via request.jwt.claim.role) allowed.
--   F.  authenticated with admin app-role allowed.
--   G.  authenticated with branch_manager app-role allowed.
--   H.  authenticated with field_operator app-role allowed.
--   I.  anon denied SELECT on rental_current_stock_items.
--   J.  authenticated (admin) can SELECT from rental_current_stock_items.
--   K.  Direct INSERT into all 4 write-boundary tables (entities, entity_versions,
--       relationships_v2, time_series_points) denied for anon (no privilege).
--   L.  Direct INSERT into all 4 write-boundary tables denied for authenticated
--       (read_only) — RLS enforces the write boundary (not privilege-level).
-- ============================================================================

begin;

-- ── A. Grant-presence checks (superuser context) ────────────────────────────

do $$
begin
  if not has_function_privilege(
    'authenticated',
    'public.create_stock_item(text,text,uuid,uuid,text,numeric,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'FAIL A1: authenticated must have EXECUTE on create_stock_item';
  end if;

  if has_function_privilege(
    'anon',
    'public.create_stock_item(text,text,uuid,uuid,text,numeric,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'FAIL A2: anon must NOT have EXECUTE on create_stock_item';
  end if;

  if not has_table_privilege(
    'authenticated',
    'public.rental_current_stock_items',
    'SELECT'
  ) then
    raise exception 'FAIL A3: authenticated must have SELECT on rental_current_stock_items';
  end if;

  if has_table_privilege(
    'anon',
    'public.rental_current_stock_items',
    'SELECT'
  ) then
    raise exception 'FAIL A4: anon must NOT have SELECT on rental_current_stock_items';
  end if;

  raise notice 'PASS A: grant checks — authenticated=write+read, anon=denied';
end;
$$;

-- ── B. anon denied execute on create_stock_item ─────────────────────────────

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.create_stock_item(
      p_name           => 'Anon Test',
      p_inventory_kind => 'bulk'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' or sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL B: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL B: anon must be denied create_stock_item';
  end if;
  raise notice 'PASS B: anon denied create_stock_item';
end;
$$;

reset role;

-- ── C. authenticated (no app-role claim) denied ──────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001"}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.create_stock_item(
      p_name           => 'No-Role Test',
      p_inventory_kind => 'bulk'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL C: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL C: authenticated (no app-role) must be denied create_stock_item';
  end if;
  raise notice 'PASS C: authenticated (no app-role) denied create_stock_item';
end;
$$;

reset role;

-- ── D. authenticated (read_only) denied ──────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.create_stock_item(
      p_name           => 'ReadOnly Test',
      p_inventory_kind => 'bulk'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL D: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL D: authenticated (read_only) must be denied create_stock_item';
  end if;
  raise notice 'PASS D: authenticated (read_only) denied create_stock_item';
end;
$$;

reset role;

-- ── E. service_role allowed ──────────────────────────────────────────────────
-- Simulates seed.sql / temporal harness: SET LOCAL request.jwt.claim.role = 'service_role'.

do $$
declare
  v_entity_id uuid;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '', true);

  select entity_id into v_entity_id
  from public.create_stock_item(
    p_name           => 'Service Role Test Item',
    p_inventory_kind => 'bulk'
  );

  if v_entity_id is null then
    raise exception 'FAIL E: service_role must be allowed to call create_stock_item';
  end if;
  raise notice 'PASS E: service_role allowed — entity_id=%', v_entity_id;
end;
$$;

-- Clear legacy claim before authenticated tests so they rely solely on request.jwt.claims.
select set_config('request.jwt.claim.role', '', true);

-- ── F. authenticated admin allowed ───────────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_entity_id uuid;
begin
  select entity_id into v_entity_id
  from public.create_stock_item(
    p_name           => 'Admin Test Item',
    p_inventory_kind => 'sale'
  );

  if v_entity_id is null then
    raise exception 'FAIL F: admin must be allowed to call create_stock_item';
  end if;
  raise notice 'PASS F: authenticated (admin) allowed — entity_id=%', v_entity_id;
end;
$$;

reset role;

-- ── G. authenticated branch_manager allowed ───────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000003","app_metadata":{"role":"branch_manager"}}',
  true
);

do $$
declare
  v_entity_id uuid;
begin
  select entity_id into v_entity_id
  from public.create_stock_item(
    p_name           => 'Branch Manager Test Item',
    p_inventory_kind => 'part'
  );

  if v_entity_id is null then
    raise exception 'FAIL G: branch_manager must be allowed to call create_stock_item';
  end if;
  raise notice 'PASS G: authenticated (branch_manager) allowed — entity_id=%', v_entity_id;
end;
$$;

reset role;

-- ── H. authenticated field_operator allowed ───────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000004","app_metadata":{"role":"field_operator"}}',
  true
);

do $$
declare
  v_entity_id uuid;
begin
  select entity_id into v_entity_id
  from public.create_stock_item(
    p_name           => 'Field Operator Test Item',
    p_inventory_kind => 'bulk'
  );

  if v_entity_id is null then
    raise exception 'FAIL H: field_operator must be allowed to call create_stock_item';
  end if;
  raise notice 'PASS H: authenticated (field_operator) allowed — entity_id=%', v_entity_id;
end;
$$;

reset role;

-- ── I. rental_current_stock_items denied for anon ─────────────────────────────

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform (select count(*) from public.rental_current_stock_items);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL I: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL I: anon must be denied SELECT on rental_current_stock_items';
  end if;
  raise notice 'PASS I: anon denied SELECT on rental_current_stock_items';
end;
$$;

reset role;

-- ── J. rental_current_stock_items accessible to authenticated ─────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_count bigint;
begin
  select count(*) into v_count from public.rental_current_stock_items;
  -- Row count may be > 0 (rows from tests E–H are visible within the transaction).
  -- The assertion is that SELECT succeeds without privilege error.
  raise notice 'PASS J: authenticated (admin) can SELECT from rental_current_stock_items (% rows)', v_count;
end;
$$;

reset role;

-- ── K. Direct INSERT into all write-boundary tables denied for anon ──────────
-- anon has no INSERT privilege on any of the four write-boundary tables; the
-- attempt is rejected at the privilege level before RLS is even evaluated.

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  -- K1: entities
  v_caught := false;
  begin
    insert into public.entities (entity_type) values ('stock_item');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL K1: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL K1: anon must not be able to INSERT directly into entities';
  end if;
  raise notice 'PASS K1: direct INSERT into entities denied for anon';

  -- K2: entity_versions
  v_caught := false;
  begin
    insert into public.entity_versions (entity_id, version_number, data)
    values (gen_random_uuid(), 1, '{}'::jsonb);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL K2: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL K2: anon must not be able to INSERT directly into entity_versions';
  end if;
  raise notice 'PASS K2: direct INSERT into entity_versions denied for anon';

  -- K3: relationships_v2
  v_caught := false;
  begin
    insert into public.relationships_v2 (relationship_type, parent_id, child_id)
    values ('branch_has_stock_item', gen_random_uuid(), gen_random_uuid());
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL K3: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL K3: anon must not be able to INSERT directly into relationships_v2';
  end if;
  raise notice 'PASS K3: direct INSERT into relationships_v2 denied for anon';

  -- K4: time_series_points
  v_caught := false;
  begin
    insert into public.time_series_points (entity_id, fact_type_id, observed_at, data_payload)
    values (gen_random_uuid(), gen_random_uuid(), now(), '{}'::jsonb);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL K4: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL K4: anon must not be able to INSERT directly into time_series_points';
  end if;
  raise notice 'PASS K4: direct INSERT into time_series_points denied for anon';
end;
$$;

reset role;

-- ── L. Direct INSERT into all write-boundary tables denied for authenticated
--        (read_only) — RLS enforces the write boundary ─────────────────────────
-- The authenticated DB role has INSERT privilege on all base tables (granted in
-- 20260607133000_authenticated_write_rpc_hardening.sql), but the
-- authenticated_manager_write RLS policy (FOR ALL, WITH CHECK) restricts INSERTs
-- to get_my_role() IN ('admin','branch_manager') and authenticated_field_insert
-- adds field_operator for entities/entity_versions/entity_facts.
-- read_only is not in either set, so every direct INSERT is blocked by RLS,
-- confirming that unprivileged authenticated callers cannot bypass create_stock_item.

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  -- L1: entities
  v_caught := false;
  begin
    insert into public.entities (entity_type) values ('stock_item');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL L1: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL L1: authenticated (read_only) must not INSERT into entities';
  end if;
  raise notice 'PASS L1: direct INSERT into entities denied for authenticated (read_only) — RLS enforces write boundary';

  -- L2: entity_versions
  v_caught := false;
  begin
    insert into public.entity_versions (entity_id, version_number, data)
    values (gen_random_uuid(), 1, '{}'::jsonb);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL L2: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL L2: authenticated (read_only) must not INSERT into entity_versions';
  end if;
  raise notice 'PASS L2: direct INSERT into entity_versions denied for authenticated (read_only) — RLS enforces write boundary';

  -- L3: relationships_v2
  v_caught := false;
  begin
    insert into public.relationships_v2 (relationship_type, parent_id, child_id)
    values ('branch_has_stock_item', gen_random_uuid(), gen_random_uuid());
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL L3: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL L3: authenticated (read_only) must not INSERT into relationships_v2';
  end if;
  raise notice 'PASS L3: direct INSERT into relationships_v2 denied for authenticated (read_only) — RLS enforces write boundary';

  -- L4: time_series_points
  v_caught := false;
  begin
    insert into public.time_series_points (entity_id, fact_type_id, observed_at, data_payload)
    values (gen_random_uuid(), gen_random_uuid(), now(), '{}'::jsonb);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL L4: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL L4: authenticated (read_only) must not INSERT into time_series_points';
  end if;
  raise notice 'PASS L4: direct INSERT into time_series_points denied for authenticated (read_only) — RLS enforces write boundary';
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.role', '', true);

do $$
begin
  raise notice 'ALL ROLE/AUTH TESTS PASSED';
end;
$$;

rollback;
