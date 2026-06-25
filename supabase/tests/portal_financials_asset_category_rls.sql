-- Behavioral access-control tests for the asset_category surface of
-- portal_get_financial_entities().
--
-- Validates that:
--   1. Unauthenticated (anon role) callers are denied via PostgreSQL grant
--   2. Authenticated customers only see asset_category rows referenced by
--      authorized contract lines using the current 'category_id' field
--   3. Authenticated customers only see asset_category rows referenced by
--      authorized contract lines using the legacy 'asset_category_id' field
--   4. Unrelated categories (not referenced by any authorized line) are filtered out
--   5. service_role bypasses customer scope and receives cross-customer category rows

begin;

do $$
-- Fixture layout:
--   customer_1 owns contract_a with two category-only lines:
--     line_f: references category_a via the current 'category_id' field
--     line_g: references category_b via the legacy 'asset_category_id' field
--   customer_2 owns contract_b with one line referencing category_c;
--     an authenticated customer_1 JWT must NOT see category_c
--   category_x exists in the DB but is not referenced by any contract line
declare
  v_category_a_id constant uuid := 'beefcafe-2000-0000-000a-000000000001';
  v_category_b_id constant uuid := 'beefcafe-2000-0000-000a-000000000002';
  v_category_c_id constant uuid := 'beefcafe-2000-0000-000a-000000000003';
  v_category_x_id constant uuid := 'beefcafe-2000-0000-000a-000000000009';
  v_customer_1_id constant uuid := 'beefcafe-2000-0000-0001-000000000001';
  v_customer_2_id constant uuid := 'beefcafe-2000-0000-0001-000000000002';
  v_contract_a_id constant uuid := 'beefcafe-2000-0000-0004-000000000001';
  v_contract_b_id constant uuid := 'beefcafe-2000-0000-0004-000000000002';
  v_line_f_id     constant uuid := 'beefcafe-2000-0000-0006-000000000001';
  v_line_g_id     constant uuid := 'beefcafe-2000-0000-0006-000000000002';
  v_line_h_id     constant uuid := 'beefcafe-2000-0000-0006-000000000003';
begin
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_category_a_id, 'asset_category', 'catscope-category-a'),
    (v_category_b_id, 'asset_category', 'catscope-category-b'),
    (v_category_c_id, 'asset_category', 'catscope-category-c'),
    (v_category_x_id, 'asset_category', 'catscope-category-x'),
    (v_customer_1_id, 'customer',        'catscope-customer-1'),
    (v_customer_2_id, 'customer',        'catscope-customer-2'),
    (v_contract_a_id, 'rental_contract', 'catscope-contract-a'),
    (v_contract_b_id, 'rental_contract', 'catscope-contract-b'),
    (v_line_f_id,     'rental_contract_line', 'catscope-line-f'),
    (v_line_g_id,     'rental_contract_line', 'catscope-line-g'),
    (v_line_h_id,     'rental_contract_line', 'catscope-line-h');

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_category_a_id, 1, true, jsonb_build_object('name', 'Excavators'), now()),
    (v_category_b_id, 1, true, jsonb_build_object('name', 'Lifts'), now()),
    (v_category_c_id, 1, true, jsonb_build_object('name', 'Compressors'), now()),
    (v_category_x_id, 1, true, jsonb_build_object('name', 'Unrelated Category'), now()),
    (v_customer_1_id, 1, true, jsonb_build_object('name', 'Authorized Customer'), now()),
    (v_customer_2_id, 1, true, jsonb_build_object('name', 'Other Customer'), now()),
    (v_contract_a_id, 1, true, jsonb_build_object(
      'contract_number', 'CATSCOPE-A',
      'status', 'active',
      'customer_id', v_customer_1_id
    ), now()),
    (v_contract_b_id, 1, true, jsonb_build_object(
      'contract_number', 'CATSCOPE-B',
      'status', 'active',
      'customer_id', v_customer_2_id
    ), now()),
    -- line_f references category_a via the current 'category_id' field
    (v_line_f_id, 1, true, jsonb_build_object(
      'contract_id', v_contract_a_id,
      'category_id', v_category_a_id,
      'rate_amount', 100
    ), now()),
    -- line_g references category_b via the legacy 'asset_category_id' field
    (v_line_g_id, 1, true, jsonb_build_object(
      'contract_id', v_contract_a_id,
      'asset_category_id', v_category_b_id,
      'rate_amount', 200
    ), now()),
    -- line_h belongs to customer_2; category_c must not be visible to a customer_1 JWT
    (v_line_h_id, 1, true, jsonb_build_object(
      'contract_id', v_contract_b_id,
      'category_id', v_category_c_id,
      'rate_amount', 300
    ), now());
end;
$$;

-- PASS 1: anon role has no EXECUTE grant on the function; call must be denied

set local role anon;

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_get_financial_entities();
    raise exception 'FAIL 1: anon role was not denied access to portal_get_financial_entities';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 1: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 1: anon role should be denied with 42501';
  end if;

  raise notice 'PASS 1: anon role is denied access to portal_get_financial_entities';
end;
$$;

reset role;

-- PASS 2: authenticated customer receives asset_category row via current 'category_id' field

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000000099',
    'role', 'authenticated',
    'customer_id', 'beefcafe-2000-0000-0001-000000000001',
    'app_metadata', jsonb_build_object('role', 'read_only')
  )::text,
  true
);

do $$
begin
  if not exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-2000-0000-000a-000000000001'::uuid
  ) then
    raise exception 'FAIL 2: category_a (via category_id) not returned for authorized customer';
  end if;

  raise notice 'PASS 2: authorized customer receives asset_category row referenced via category_id';
end;
$$;

reset role;

-- PASS 3: authenticated customer receives asset_category row via legacy 'asset_category_id' field

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000000099',
    'role', 'authenticated',
    'customer_id', 'beefcafe-2000-0000-0001-000000000001',
    'app_metadata', jsonb_build_object('role', 'read_only')
  )::text,
  true
);

do $$
begin
  if not exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-2000-0000-000a-000000000002'::uuid
  ) then
    raise exception 'FAIL 3: category_b (via asset_category_id legacy field) not returned for authorized customer';
  end if;

  raise notice 'PASS 3: authorized customer receives asset_category row referenced via legacy asset_category_id';
end;
$$;

reset role;

-- PASS 4: cross-customer category and unreferenced category are both filtered out
-- for a customer_1 scoped JWT

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000000099',
    'role', 'authenticated',
    'customer_id', 'beefcafe-2000-0000-0001-000000000001',
    'app_metadata', jsonb_build_object('role', 'read_only')
  )::text,
  true
);

do $$
begin
  -- category_c belongs to customer_2's contract; must not be visible to customer_1
  if exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-2000-0000-000a-000000000003'::uuid
  ) then
    raise exception 'FAIL 4: category_c (cross-customer, customer_2 only) was returned for customer_1 JWT';
  end if;

  -- category_x is unreferenced by any contract line; must not be visible
  if exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-2000-0000-000a-000000000009'::uuid
  ) then
    raise exception 'FAIL 4: category_x (not referenced by any line) was returned for authorized customer';
  end if;

  raise notice 'PASS 4: cross-customer and unreferenced categories are filtered out for authenticated customer';
end;
$$;

reset role;

-- PASS 5: service_role bypasses customer scope and receives cross-customer category rows

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"service_role"}',
  true
);

do $$
begin
  if not exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-2000-0000-000a-000000000001'::uuid
  ) then
    raise exception 'FAIL 5: service_role missing category_a (customer_1 contract)';
  end if;

  if not exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-2000-0000-000a-000000000002'::uuid
  ) then
    raise exception 'FAIL 5: service_role missing category_b (customer_1 contract, legacy field)';
  end if;

  -- category_c is only on customer_2's contract; service_role must see it despite no customer scope
  if not exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-2000-0000-000a-000000000003'::uuid
  ) then
    raise exception 'FAIL 5: service_role missing category_c (customer_2 contract; should bypass scope)';
  end if;

  raise notice 'PASS 5: service_role receives cross-customer asset_category rows';
end;
$$;

reset role;

rollback;
