-- Reset-path regression checks for the portal financials asset_category extension
-- (migration 20260619010000_portal_financials_asset_category.sql).
--
-- Run after `supabase db reset --config supabase/config.toml` to confirm:
--   1. Schema shape: portal_get_financial_entities() exists as a SECURITY DEFINER
--      function with no parameters.
--   2. Grant posture: authenticated and service_role can EXECUTE; anon cannot.
--   3. Scope enforcement on a clean rebuild: a customer-scoped JWT only receives
--      asset_category rows referenced by its own authorized contract lines, and
--      cross-customer categories are filtered out.
--   4. service_role bypass: service_role receives asset_category rows from all
--      customers.
--
-- Intended to be run against the local Supabase stack immediately after
-- `supabase db reset --config supabase/config.toml` so seed.sql has been applied.

begin;

-- ---------------------------------------------------------------------------
-- 1. Schema shape + 2. Grant posture (structural checks, no data needed)
-- ---------------------------------------------------------------------------

do $$
declare
  v_func_exists   bool;
  v_is_secdef     bool;
  v_anon_can_exec bool;
  v_auth_can_exec bool;
  v_svc_can_exec  bool;
begin
  -- 1a. Function exists
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'portal_get_financial_entities'
      and pronargs  = 0
  ) into v_func_exists;

  if not v_func_exists then
    raise exception 'FAIL 1a: portal_get_financial_entities() is missing after clean reset — migration 20260619010000 may not have applied';
  end if;

  raise notice 'PASS 1a: portal_get_financial_entities() exists';

  -- 1b. SECURITY DEFINER
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname  = 'public'
      and p.proname  = 'portal_get_financial_entities'
      and p.prosecdef = true
      and pronargs   = 0
  ) into v_is_secdef;

  if not v_is_secdef then
    raise exception 'FAIL 1b: portal_get_financial_entities() is not SECURITY DEFINER after clean reset';
  end if;

  raise notice 'PASS 1b: portal_get_financial_entities() is SECURITY DEFINER';

  -- 2a. anon role must NOT have EXECUTE
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join information_schema.role_routine_grants g
      on g.specific_schema = n.nspname
     and g.routine_name    = p.proname
    where n.nspname  = 'public'
      and p.proname  = 'portal_get_financial_entities'
      and pronargs   = 0
      and g.grantee  = 'anon'
      and g.privilege_type = 'EXECUTE'
  ) into v_anon_can_exec;

  if v_anon_can_exec then
    raise exception 'FAIL 2a: anon role has EXECUTE on portal_get_financial_entities() — grant was added unexpectedly after reset';
  end if;

  raise notice 'PASS 2a: anon role has no EXECUTE grant on portal_get_financial_entities()';

  -- 2b. authenticated role must have EXECUTE
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join information_schema.role_routine_grants g
      on g.specific_schema = n.nspname
     and g.routine_name    = p.proname
    where n.nspname  = 'public'
      and p.proname  = 'portal_get_financial_entities'
      and pronargs   = 0
      and g.grantee  = 'authenticated'
      and g.privilege_type = 'EXECUTE'
  ) into v_auth_can_exec;

  if not v_auth_can_exec then
    raise exception 'FAIL 2b: authenticated role is missing EXECUTE grant on portal_get_financial_entities() after reset';
  end if;

  raise notice 'PASS 2b: authenticated role has EXECUTE grant on portal_get_financial_entities()';

  -- 2c. service_role must have EXECUTE
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join information_schema.role_routine_grants g
      on g.specific_schema = n.nspname
     and g.routine_name    = p.proname
    where n.nspname  = 'public'
      and p.proname  = 'portal_get_financial_entities'
      and pronargs   = 0
      and g.grantee  = 'service_role'
      and g.privilege_type = 'EXECUTE'
  ) into v_svc_can_exec;

  if not v_svc_can_exec then
    raise exception 'FAIL 2c: service_role is missing EXECUTE grant on portal_get_financial_entities() after reset';
  end if;

  raise notice 'PASS 2c: service_role has EXECUTE grant on portal_get_financial_entities()';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3 & 4. Scope enforcement + service_role bypass on fresh rebuild
--
-- Insert a minimal fixture scoped to two customers, two contracts, and three
-- asset_category entities.  All changes are rolled back at the end of the
-- outer transaction so the seed is not polluted.
-- ---------------------------------------------------------------------------

do $$
-- Fixture layout:
--   customer_1 owns contract_a with two category-only lines:
--     line_f: references category_a via the current  'category_id' field
--     line_g: references category_b via the legacy   'asset_category_id' field
--   customer_2 owns contract_b with one line referencing category_c;
--     an authenticated customer_1 JWT must NOT see category_c
declare
  v_category_a_id constant uuid := 'beefcafe-3000-0000-000a-000000000001';
  v_category_b_id constant uuid := 'beefcafe-3000-0000-000a-000000000002';
  v_category_c_id constant uuid := 'beefcafe-3000-0000-000a-000000000003';
  v_customer_1_id constant uuid := 'beefcafe-3000-0000-0001-000000000001';
  v_customer_2_id constant uuid := 'beefcafe-3000-0000-0001-000000000002';
  v_contract_a_id constant uuid := 'beefcafe-3000-0000-0004-000000000001';
  v_contract_b_id constant uuid := 'beefcafe-3000-0000-0004-000000000002';
  v_line_f_id     constant uuid := 'beefcafe-3000-0000-0006-000000000001';
  v_line_g_id     constant uuid := 'beefcafe-3000-0000-0006-000000000002';
  v_line_h_id     constant uuid := 'beefcafe-3000-0000-0006-000000000003';
begin
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_category_a_id, 'asset_category',       'reset-category-a'),
    (v_category_b_id, 'asset_category',       'reset-category-b'),
    (v_category_c_id, 'asset_category',       'reset-category-c'),
    (v_customer_1_id, 'customer',              'reset-customer-1'),
    (v_customer_2_id, 'customer',              'reset-customer-2'),
    (v_contract_a_id, 'rental_contract',       'reset-contract-a'),
    (v_contract_b_id, 'rental_contract',       'reset-contract-b'),
    (v_line_f_id,     'rental_contract_line',  'reset-line-f'),
    (v_line_g_id,     'rental_contract_line',  'reset-line-g'),
    (v_line_h_id,     'rental_contract_line',  'reset-line-h');

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_category_a_id, 1, true, jsonb_build_object('name', 'Excavators'), now()),
    (v_category_b_id, 1, true, jsonb_build_object('name', 'Lifts'), now()),
    (v_category_c_id, 1, true, jsonb_build_object('name', 'Compressors'), now()),
    (v_customer_1_id, 1, true, jsonb_build_object('name', 'Reset Customer One'), now()),
    (v_customer_2_id, 1, true, jsonb_build_object('name', 'Reset Customer Two'), now()),
    (v_contract_a_id, 1, true, jsonb_build_object(
      'contract_number', 'RESET-A',
      'status', 'active',
      'customer_id', v_customer_1_id
    ), now()),
    (v_contract_b_id, 1, true, jsonb_build_object(
      'contract_number', 'RESET-B',
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
    -- line_h belongs to customer_2; category_c must not be visible to customer_1 JWT
    (v_line_h_id, 1, true, jsonb_build_object(
      'contract_id', v_contract_b_id,
      'category_id', v_category_c_id,
      'rate_amount', 300
    ), now());
end;
$$;

-- PASS 3a: authenticated customer_1 receives asset_category row via 'category_id'

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',         '00000000-0000-0000-0000-000000000099',
    'role',        'authenticated',
    'customer_id', 'beefcafe-3000-0000-0001-000000000001',
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
      and id = 'beefcafe-3000-0000-000a-000000000001'::uuid
  ) then
    raise exception 'FAIL 3a: category_a (via category_id) not returned for authorized customer after clean reset';
  end if;

  raise notice 'PASS 3a: authorized customer receives asset_category row referenced via category_id after clean reset';
end;
$$;

reset role;

-- PASS 3b: authenticated customer_1 receives asset_category row via legacy 'asset_category_id'

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',         '00000000-0000-0000-0000-000000000099',
    'role',        'authenticated',
    'customer_id', 'beefcafe-3000-0000-0001-000000000001',
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
      and id = 'beefcafe-3000-0000-000a-000000000002'::uuid
  ) then
    raise exception 'FAIL 3b: category_b (via legacy asset_category_id) not returned for authorized customer after clean reset';
  end if;

  raise notice 'PASS 3b: authorized customer receives asset_category row referenced via legacy asset_category_id after clean reset';
end;
$$;

reset role;

-- PASS 3c: cross-customer category_c is filtered out for customer_1 JWT

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',         '00000000-0000-0000-0000-000000000099',
    'role',        'authenticated',
    'customer_id', 'beefcafe-3000-0000-0001-000000000001',
    'app_metadata', jsonb_build_object('role', 'read_only')
  )::text,
  true
);

do $$
begin
  if exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-3000-0000-000a-000000000003'::uuid
  ) then
    raise exception 'FAIL 3c: category_c (cross-customer, belongs to customer_2) was returned for customer_1 JWT after clean reset';
  end if;

  raise notice 'PASS 3c: cross-customer category is filtered out for authenticated customer after clean reset';
end;
$$;

reset role;

-- PASS 4: service_role bypasses customer scope and receives all asset_category rows

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
      and id = 'beefcafe-3000-0000-000a-000000000001'::uuid
  ) then
    raise exception 'FAIL 4: service_role missing category_a after clean reset';
  end if;

  if not exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-3000-0000-000a-000000000002'::uuid
  ) then
    raise exception 'FAIL 4: service_role missing category_b (legacy field) after clean reset';
  end if;

  if not exists (
    select 1
    from public.portal_get_financial_entities()
    where entity_type = 'asset_category'
      and id = 'beefcafe-3000-0000-000a-000000000003'::uuid
  ) then
    raise exception 'FAIL 4: service_role missing category_c (customer_2 contract) after clean reset — scope bypass broken';
  end if;

  raise notice 'PASS 4: service_role receives cross-customer asset_category rows after clean reset';
end;
$$;

reset role;

do $$ begin
  raise notice 'All portal_financials_asset_category reset-path checks passed';
end; $$;

rollback;
