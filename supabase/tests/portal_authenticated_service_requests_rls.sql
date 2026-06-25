-- Behavioral access-control tests for the portal authenticated service request RPCs:
--   portal_get_authenticated_rentals
--   portal_submit_authenticated_service_request
--   portal_list_authenticated_service_requests
-- (migration 20260617230000_portal_authenticated_service_requests.sql)
--
-- Tests would fail if:
--   * anon is not denied
--   * authenticated without portal_customer app role is not denied
--   * authenticated portal_customer with no customer scope claim is not denied (fail-closed)
--   * authenticated portal_customer can see contracts/requests outside their customer scope
--   * authenticated portal_customer can submit a request for a contract outside their scope
--   * service_role bypass is broken
--
-- Pattern: SET LOCAL ROLE + set_config('request.jwt.claims', ...) simulates the
-- PostgREST JWT context used in production; all changes are rolled back.

begin;

-- ── Fixture UUIDs ───────────────────────────────────────────────────────────
do $$
declare
  v_contract_a_id  constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_contract_b_id  constant uuid := 'deaf0000-aaaa-0001-0001-000000000002';
  v_line_a1_id     constant uuid := 'deaf0000-aaaa-0001-0002-000000000001';
  v_line_a2_id     constant uuid := 'deaf0000-aaaa-0001-0002-000000000002';
  v_asset_a_id     constant uuid := 'deaf0000-aaaa-0001-0003-000000000001';
  -- customer_id is stored as text in the entity jsonb (no FK constraint per ADR-0019);
  -- the portal RPCs compare c.data->>'customer_id' (text) against JWT claims (text array).
  v_customer_1_id  constant text := 'deaf0000-aaaa-cust-0001-000000000001';
  v_customer_2_id  constant text := 'deaf0000-aaaa-cust-0001-000000000002';
begin
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_contract_a_id, 'rental_contract',      'portal-auth-rls-contract-a'),
    (v_contract_b_id, 'rental_contract',      'portal-auth-rls-contract-b'),
    (v_line_a1_id,    'rental_contract_line', 'portal-auth-rls-line-a1'),
    (v_line_a2_id,    'rental_contract_line', 'portal-auth-rls-line-a2'),
    (v_asset_a_id,    'asset',                'portal-auth-rls-asset-a')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_contract_a_id, 1, true,
      jsonb_build_object(
        'status',          'active',
        'contract_number', 'AUTH-RLS-CUST1-001',
        'customer_id',     v_customer_1_id,
        'order_id',        gen_random_uuid()::text
      ),
      now()
    ),
    (
      v_contract_b_id, 1, true,
      jsonb_build_object(
        'status',          'active',
        'contract_number', 'AUTH-RLS-CUST2-001',
        'customer_id',     v_customer_2_id,
        'order_id',        gen_random_uuid()::text
      ),
      now()
    ),
    (
      v_line_a1_id, 1, true,
      jsonb_build_object(
        'status',       'checked_out',
        'contract_id',  v_contract_a_id::text,
        'asset_id',     v_asset_a_id::text,
        'actual_start', (now() - interval '3 days')::text
      ),
      now()
    ),
    (
      v_line_a2_id, 1, true,
      jsonb_build_object(
        'status',       'pending',
        'contract_id',  v_contract_a_id::text,
        'asset_id',     v_asset_a_id::text,
        'actual_start', now()::text
      ),
      now()
    ),
    (
      v_asset_a_id, 1, true,
      jsonb_build_object(
        'status', 'on_rent',
        'name',   'Auth RLS Test Excavator'
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;
end;
$$;

-- ── Grant fixtures ────────────────────────────────────────────────────────────
-- Insert portal_customer_access_grant rows for each test auth user that should
-- have access.  Sub 10 is inserted as revoked to drive test 12.
-- No grant is inserted for sub 99 (used in test 11 to verify no-grant denial).
do $$
begin
  insert into public.portal_customer_access_grant
    (tenant_id, auth_user_id, customer_id, status)
  values
    -- Tests 4–7, 9: customer_1 sessions
    ('test-tenant', '00000000-0000-0000-0000-000000000003', 'deaf0000-aaaa-cust-0001-000000000001', 'active'),
    ('test-tenant', '00000000-0000-0000-0000-000000000004', 'deaf0000-aaaa-cust-0001-000000000001', 'active'),
    ('test-tenant', '00000000-0000-0000-0000-000000000005', 'deaf0000-aaaa-cust-0001-000000000001', 'active'),
    ('test-tenant', '00000000-0000-0000-0000-000000000006', 'deaf0000-aaaa-cust-0001-000000000001', 'active'),
    ('test-tenant', '00000000-0000-0000-0000-000000000008', 'deaf0000-aaaa-cust-0001-000000000001', 'active'),
    -- Test 8: customer_2 session
    ('test-tenant', '00000000-0000-0000-0000-000000000007', 'deaf0000-aaaa-cust-0001-000000000002', 'active'),
    -- Test 12: revoked grant for customer_1
    ('test-tenant', '00000000-0000-0000-0000-000000000010', 'deaf0000-aaaa-cust-0001-000000000001', 'revoked'),
    -- Test 13: active grant for customer_2 only (JWT will claim customer_1 → intersection empty)
    ('test-tenant', '00000000-0000-0000-0000-000000000011', 'deaf0000-aaaa-cust-0001-000000000002', 'active')
  on conflict (auth_user_id) do nothing;
end;
$$;

-- ── 1. anon → denied on all three RPCs ─────────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_get_authenticated_rentals();
    raise exception 'FAIL 1a: anon was allowed to call portal_get_authenticated_rentals';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 1a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 1a: anon should be denied with 42501';
  end if;
  raise notice 'PASS 1a: anon denied on portal_get_authenticated_rentals';
end;
$$;

do $$
declare
  v_line_id  constant uuid := 'deaf0000-aaaa-0001-0002-000000000001';
  v_contr_id constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_submit_authenticated_service_request(v_contr_id, v_line_id);
    raise exception 'FAIL 1b: anon was allowed to call portal_submit_authenticated_service_request';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 1b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 1b: anon should be denied with 42501';
  end if;
  raise notice 'PASS 1b: anon denied on portal_submit_authenticated_service_request';
end;
$$;

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_list_authenticated_service_requests();
    raise exception 'FAIL 1c: anon was allowed to call portal_list_authenticated_service_requests';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 1c: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 1c: anon should be denied with 42501';
  end if;
  raise notice 'PASS 1c: anon denied on portal_list_authenticated_service_requests';
end;
$$;

reset role;

-- ── 2. authenticated + wrong app role → denied ──────────────────────────────
-- A staff user (e.g. read_only) with a valid authenticated session but no
-- portal_customer app role should be denied.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_get_authenticated_rentals();
    raise exception 'FAIL 2a: non-portal_customer authenticated caller was allowed on portal_get_authenticated_rentals';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 2a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2a: non-portal_customer role should be denied with 42501';
  end if;
  raise notice 'PASS 2a: non-portal_customer role denied on portal_get_authenticated_rentals';
end;
$$;

do $$
declare
  v_line_id  constant uuid := 'deaf0000-aaaa-0001-0002-000000000001';
  v_contr_id constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_submit_authenticated_service_request(v_contr_id, v_line_id);
    raise exception 'FAIL 2b: non-portal_customer authenticated caller was allowed on portal_submit_authenticated_service_request';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 2b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2b: non-portal_customer role should be denied with 42501';
  end if;
  raise notice 'PASS 2b: non-portal_customer role denied on portal_submit_authenticated_service_request';
end;
$$;

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_list_authenticated_service_requests();
    raise exception 'FAIL 2c: non-portal_customer authenticated caller was allowed on portal_list_authenticated_service_requests';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 2c: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2c: non-portal_customer role should be denied with 42501';
  end if;
  raise notice 'PASS 2c: non-portal_customer role denied on portal_list_authenticated_service_requests';
end;
$$;

reset role;

-- ── 3. portal_customer + no customer scope claim → denied (fail-closed) ─────
-- A valid portal_customer session with no customer_id / customer_ids claim should
-- be denied with 42501, never silently return all rows.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated","app_metadata":{"role":"portal_customer"}}',
  true
);

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_get_authenticated_rentals();
    raise exception 'FAIL 3a: portal_customer with no customer scope was allowed on portal_get_authenticated_rentals';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 3a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3a: portal_customer with no scope should be denied with 42501';
  end if;
  raise notice 'PASS 3a: portal_customer with no customer scope denied on portal_get_authenticated_rentals';
end;
$$;

do $$
declare
  v_line_id  constant uuid := 'deaf0000-aaaa-0001-0002-000000000001';
  v_contr_id constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_submit_authenticated_service_request(v_contr_id, v_line_id);
    raise exception 'FAIL 3b: portal_customer with no customer scope was allowed on portal_submit_authenticated_service_request';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 3b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3b: portal_customer with no scope should be denied with 42501';
  end if;
  raise notice 'PASS 3b: portal_customer with no customer scope denied on portal_submit_authenticated_service_request';
end;
$$;

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_list_authenticated_service_requests();
    raise exception 'FAIL 3c: portal_customer with no customer scope was allowed on portal_list_authenticated_service_requests';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 3c: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3c: portal_customer with no scope should be denied with 42501';
  end if;
  raise notice 'PASS 3c: portal_customer with no customer scope denied on portal_list_authenticated_service_requests';
end;
$$;

reset role;

-- ── 4. portal_customer + correct customer_id → can read own rentals ─────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '00000000-0000-0000-0000-000000000003',
    'role',         'authenticated',
    'customer_id',  'deaf0000-aaaa-cust-0001-000000000001',
    'app_metadata', jsonb_build_object(
      'role',        'portal_customer',
      'customer_id', 'deaf0000-aaaa-cust-0001-000000000001'
    )
  )::text,
  true
);

do $$
declare
  v_contract_a_id constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_contract_b_id constant uuid := 'deaf0000-aaaa-0001-0001-000000000002';
  v_count int;
begin
  -- Own contract (customer_1) should be returned.
  select count(*) into v_count
  from public.portal_get_authenticated_rentals()
  where contract_entity_id = v_contract_a_id::text;

  if v_count = 0 then
    raise exception 'FAIL 4a: customer_1 did not get their own contract line from portal_get_authenticated_rentals';
  end if;

  -- Other customer's contract should NOT be returned.
  if exists (
    select 1 from public.portal_get_authenticated_rentals()
    where contract_entity_id = v_contract_b_id::text
  ) then
    raise exception 'FAIL 4b: customer_1 received customer_2 contract rows from portal_get_authenticated_rentals';
  end if;

  raise notice 'PASS 4: portal_customer with correct scope sees only own contracts';
end;
$$;

reset role;

-- ── 5. portal_submit → denied for contract outside customer scope ────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '00000000-0000-0000-0000-000000000004',
    'role',         'authenticated',
    'customer_id',  'deaf0000-aaaa-cust-0001-000000000001',
    'app_metadata', jsonb_build_object(
      'role',        'portal_customer',
      'customer_id', 'deaf0000-aaaa-cust-0001-000000000001'
    )
  )::text,
  true
);

do $$
declare
  -- contract_b belongs to customer_2, not customer_1
  v_contract_b_id constant uuid := 'deaf0000-aaaa-0001-0001-000000000002';
  -- Use a dummy line ID; the scope check fires before the line lookup.
  v_dummy_line    constant uuid := gen_random_uuid();
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_submit_authenticated_service_request(v_contract_b_id, v_dummy_line);
    raise exception 'FAIL 5: customer_1 was allowed to submit a request against customer_2 contract';
  exception
    when sqlstate '42501' then v_caught := true;
    when sqlstate '22023' then v_caught := true;  -- contract not found is also acceptable
    when others then
      raise exception 'FAIL 5: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 5: cross-customer submission should be denied';
  end if;
  raise notice 'PASS 5: portal_submit denied for contract outside customer scope';
end;
$$;

reset role;

-- ── 6. portal_submit → succeeds for eligible (checked_out) line ─────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '00000000-0000-0000-0000-000000000005',
    'role',         'authenticated',
    'customer_id',  'deaf0000-aaaa-cust-0001-000000000001',
    'app_metadata', jsonb_build_object(
      'role',        'portal_customer',
      'customer_id', 'deaf0000-aaaa-cust-0001-000000000001'
    )
  )::text,
  true
);

do $$
declare
  v_contract_a_id  constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_line_a1_id     constant uuid := 'deaf0000-aaaa-0001-0002-000000000001';
  v_request_id     uuid;
  v_deduped        boolean;
begin
  select req.request_id, req.deduped
    into v_request_id, v_deduped
  from public.portal_submit_authenticated_service_request(
    v_contract_a_id, v_line_a1_id,
    'off_rent_pickup', 'standard', 'Test call-off', null, false, false
  ) req;

  if v_request_id is null then
    raise exception 'FAIL 6a: portal_submit returned null request_id for valid checked_out line';
  end if;
  if v_deduped then
    raise exception 'FAIL 6a: first submission unexpectedly returned deduped=true';
  end if;

  -- Idempotent re-submit should return deduped=true.
  select req.deduped into v_deduped
  from public.portal_submit_authenticated_service_request(
    v_contract_a_id, v_line_a1_id,
    'off_rent_pickup', 'standard', 'Test call-off', null, false, false
  ) req;

  if not v_deduped then
    raise exception 'FAIL 6b: re-submit of identical fields should return deduped=true';
  end if;

  raise notice 'PASS 6: portal_submit creates request for checked_out line and is idempotent';
end;
$$;

reset role;

-- ── 7. portal_submit → denied for non-checked_out line ──────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '00000000-0000-0000-0000-000000000006',
    'role',         'authenticated',
    'customer_id',  'deaf0000-aaaa-cust-0001-000000000001',
    'app_metadata', jsonb_build_object(
      'role',        'portal_customer',
      'customer_id', 'deaf0000-aaaa-cust-0001-000000000001'
    )
  )::text,
  true
);

do $$
declare
  v_contract_a_id  constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_line_a2_id     constant uuid := 'deaf0000-aaaa-0001-0002-000000000002';  -- status=pending
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_submit_authenticated_service_request(
      v_contract_a_id, v_line_a2_id, 'off_rent_pickup'
    );
    raise exception 'FAIL 7: submit was allowed for a pending (non-checked_out) line';
  exception
    when sqlstate '22023' then v_caught := true;
    when others then
      raise exception 'FAIL 7: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 7: non-checked_out line should raise 22023';
  end if;
  raise notice 'PASS 7: portal_submit denied for non-checked_out line';
end;
$$;

reset role;

-- ── 8. portal_list → customer sees only own requests ────────────────────────
-- Request created in test 6 is for customer_1 (contract_a).
-- A customer_2 session should see zero requests.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '00000000-0000-0000-0000-000000000007',
    'role',         'authenticated',
    'customer_id',  'deaf0000-aaaa-cust-0001-000000000002',
    'app_metadata', jsonb_build_object(
      'role',        'portal_customer',
      'customer_id', 'deaf0000-aaaa-cust-0001-000000000002'
    )
  )::text,
  true
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.portal_list_authenticated_service_requests();

  if v_count > 0 then
    raise exception 'FAIL 8: customer_2 received % request(s) belonging to customer_1', v_count;
  end if;

  raise notice 'PASS 8: portal_list scope isolation — customer_2 sees zero customer_1 requests';
end;
$$;

reset role;

-- customer_1 session should see the request created in test 6.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '00000000-0000-0000-0000-000000000008',
    'role',         'authenticated',
    'customer_id',  'deaf0000-aaaa-cust-0001-000000000001',
    'app_metadata', jsonb_build_object(
      'role',        'portal_customer',
      'customer_id', 'deaf0000-aaaa-cust-0001-000000000001'
    )
  )::text,
  true
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.portal_list_authenticated_service_requests();

  if v_count = 0 then
    raise exception 'FAIL 9: customer_1 received no requests even though one was submitted in test 6';
  end if;

  raise notice 'PASS 9: portal_list returns customer_1 own requests correctly';
end;
$$;

reset role;

-- ── 10. service_role bypass works ────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_count int;
begin
  -- service_role should be able to read all rentals without customer scope claims.
  select count(*) into v_count from public.portal_get_authenticated_rentals();
  -- At least the two test contracts should be present (active/pending_execution status required).
  raise notice 'PASS 10a: service_role can call portal_get_authenticated_rentals (% rows)', v_count;

  select count(*) into v_count from public.portal_list_authenticated_service_requests();
  raise notice 'PASS 10b: service_role can call portal_list_authenticated_service_requests (% rows)', v_count;
end;
$$;

reset role;

-- ── 11. portal_customer + no grant entry in portal_customer_access_grant → denied
-- Sub 99 has valid portal_customer claims and a matching customer_id in the JWT,
-- but has no row in portal_customer_access_grant.  All three RPCs must deny.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '00000000-0000-0000-0000-000000000099',
    'role',         'authenticated',
    'customer_id',  'deaf0000-aaaa-cust-0001-000000000001',
    'app_metadata', jsonb_build_object(
      'role',        'portal_customer',
      'customer_id', 'deaf0000-aaaa-cust-0001-000000000001'
    )
  )::text,
  true
);

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_get_authenticated_rentals();
    raise exception 'FAIL 11a: portal_customer with no grant was allowed on portal_get_authenticated_rentals';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 11a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 11a: portal_customer with no grant should be denied with 42501';
  end if;
  raise notice 'PASS 11a: portal_customer with no grant denied on portal_get_authenticated_rentals';
end;
$$;

do $$
declare
  v_line_id  constant uuid := 'deaf0000-aaaa-0001-0002-000000000001';
  v_contr_id constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_submit_authenticated_service_request(v_contr_id, v_line_id);
    raise exception 'FAIL 11b: portal_customer with no grant was allowed on portal_submit_authenticated_service_request';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 11b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 11b: portal_customer with no grant should be denied with 42501';
  end if;
  raise notice 'PASS 11b: portal_customer with no grant denied on portal_submit_authenticated_service_request';
end;
$$;

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_list_authenticated_service_requests();
    raise exception 'FAIL 11c: portal_customer with no grant was allowed on portal_list_authenticated_service_requests';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 11c: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 11c: portal_customer with no grant should be denied with 42501';
  end if;
  raise notice 'PASS 11c: portal_customer with no grant denied on portal_list_authenticated_service_requests';
end;
$$;

reset role;

-- ── 12. portal_customer + revoked grant → denied ─────────────────────────────
-- Sub 10 has a grant row but with status='revoked'.  All three RPCs must deny.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '00000000-0000-0000-0000-000000000010',
    'role',         'authenticated',
    'customer_id',  'deaf0000-aaaa-cust-0001-000000000001',
    'app_metadata', jsonb_build_object(
      'role',        'portal_customer',
      'customer_id', 'deaf0000-aaaa-cust-0001-000000000001'
    )
  )::text,
  true
);

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_get_authenticated_rentals();
    raise exception 'FAIL 12a: portal_customer with revoked grant was allowed on portal_get_authenticated_rentals';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 12a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 12a: portal_customer with revoked grant should be denied with 42501';
  end if;
  raise notice 'PASS 12a: portal_customer with revoked grant denied on portal_get_authenticated_rentals';
end;
$$;

do $$
declare
  v_line_id  constant uuid := 'deaf0000-aaaa-0001-0002-000000000001';
  v_contr_id constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_submit_authenticated_service_request(v_contr_id, v_line_id);
    raise exception 'FAIL 12b: portal_customer with revoked grant was allowed on portal_submit_authenticated_service_request';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 12b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 12b: portal_customer with revoked grant should be denied with 42501';
  end if;
  raise notice 'PASS 12b: portal_customer with revoked grant denied on portal_submit_authenticated_service_request';
end;
$$;

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_list_authenticated_service_requests();
    raise exception 'FAIL 12c: portal_customer with revoked grant was allowed on portal_list_authenticated_service_requests';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 12c: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 12c: portal_customer with revoked grant should be denied with 42501';
  end if;
  raise notice 'PASS 12c: portal_customer with revoked grant denied on portal_list_authenticated_service_requests';
end;
$$;

reset role;

-- ── 13. portal_customer + grant scope ≠ JWT scope (intersection empty) → denied
-- Sub 11 has an active grant for customer_2 only.  The JWT claims customer_1.
-- The intersection is empty, so all RPCs must fail closed.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '00000000-0000-0000-0000-000000000011',
    'role',         'authenticated',
    'customer_id',  'deaf0000-aaaa-cust-0001-000000000001',
    'app_metadata', jsonb_build_object(
      'role',        'portal_customer',
      'customer_id', 'deaf0000-aaaa-cust-0001-000000000001'
    )
  )::text,
  true
);

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_get_authenticated_rentals();
    raise exception 'FAIL 13a: portal_customer with mismatched grant/JWT scope was allowed on portal_get_authenticated_rentals';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 13a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 13a: portal_customer with empty grant/JWT intersection should be denied with 42501';
  end if;
  raise notice 'PASS 13a: empty grant/JWT intersection denied on portal_get_authenticated_rentals';
end;
$$;

do $$
declare
  v_line_id  constant uuid := 'deaf0000-aaaa-0001-0002-000000000001';
  v_contr_id constant uuid := 'deaf0000-aaaa-0001-0001-000000000001';
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_submit_authenticated_service_request(v_contr_id, v_line_id);
    raise exception 'FAIL 13b: portal_customer with mismatched grant/JWT scope was allowed on portal_submit_authenticated_service_request';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 13b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 13b: portal_customer with empty grant/JWT intersection should be denied with 42501';
  end if;
  raise notice 'PASS 13b: empty grant/JWT intersection denied on portal_submit_authenticated_service_request';
end;
$$;

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_list_authenticated_service_requests();
    raise exception 'FAIL 13c: portal_customer with mismatched grant/JWT scope was allowed on portal_list_authenticated_service_requests';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 13c: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 13c: portal_customer with empty grant/JWT intersection should be denied with 42501';
  end if;
  raise notice 'PASS 13c: empty grant/JWT intersection denied on portal_list_authenticated_service_requests';
end;
$$;

reset role;

rollback;
