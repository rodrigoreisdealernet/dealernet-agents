-- Behavioral access-control tests for portal_get_contract_schedule
-- (migration 20260610120000_fix_seed_entity_types_and_schedule_join.sql
--  and 20260613222000_portal_schedule_public_read.sql).
--
-- These assertions would fail if:
--   * anon with no token is denied (public read should be allowed after the
--     portal_schedule_public_read migration)
--   * anon with a forged/wrong token is not denied (token guard bypassed when
--     a non-empty token is supplied)
--   * anon with a valid token cannot read the scoped contract rows
--   * the ::uuid cast on l.asset_id is missing/broken (asset_name would be NULL)
--   * service_role is unexpectedly denied or requires a token
--   * a token issued for contract A is accepted for contract B
--   * the EXECUTE grant for anon/authenticated/service_role is absent
--
-- Pattern: SET LOCAL ROLE + set_config('request.jwt.claims', ...) simulates
-- the PostgREST JWT context used in production; all changes are rolled back.

begin;

-- ── Fixture setup (superuser context) ─────────────────────────────────────
-- Two contracts (A and B), one contract line on A, one asset, and a scope
-- token registered only for contract A.
do $$
declare
  v_contract_a_id  constant uuid := 'beefcafe-0001-0000-0001-000000000001';
  v_contract_b_id  constant uuid := 'beefcafe-0001-0000-0001-000000000002';
  v_line_a_id      constant uuid := 'beefcafe-0001-0000-0002-000000000001';
  v_asset_id       constant uuid := 'beefcafe-0001-0000-0003-000000000001';
  v_valid_token    constant text := 'portal-schedule-rls-test-token-001';
begin
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_contract_a_id, 'rental_contract',      'portal-sched-rls-contract-a'),
    (v_contract_b_id, 'rental_contract',      'portal-sched-rls-contract-b'),
    (v_line_a_id,     'rental_contract_line', 'portal-sched-rls-line-a'),
    (v_asset_id,      'asset',                'portal-sched-rls-asset-001')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_contract_a_id, 1, true,
      jsonb_build_object(
        'status',          'active',
        'contract_number', 'RLS-TEST-0001',
        'order_id',        gen_random_uuid()::text
      ),
      now()
    ),
    (
      v_contract_b_id, 1, true,
      jsonb_build_object(
        'status',          'active',
        'contract_number', 'RLS-TEST-0002',
        'order_id',        gen_random_uuid()::text
      ),
      now()
    ),
    (
      v_line_a_id, 1, true,
      jsonb_build_object(
        'status',       'checked_out',
        'contract_id',  v_contract_a_id::text,
        'asset_id',     v_asset_id::text,
        'actual_start', (now() - interval '1 day')::text
      ),
      now()
    ),
    (
      v_asset_id, 1, true,
      jsonb_build_object(
        'status',        'on_rent',
        'name',          'Portal RLS Test Excavator',
        'serial_number', 'PRLS-001'
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  -- Scope token registered for contract A only
  insert into public.portal_contract_scope_tokens (contract_id, token_hash)
  values (
    v_contract_a_id,
    encode(digest(v_valid_token, 'sha256'), 'hex')
  )
  on conflict (contract_id) do nothing;
end;
$$;

-- ── 1. anon + no token → public read (schedule visible) ───────────────────
-- After 20260613222000_portal_schedule_public_read.sql, null and empty-string
-- tokens must succeed so the page renders for customers who visit without a
-- scope token. Off-rent actions still require a valid token (tested in section 4).
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_contract_a_id constant uuid := 'beefcafe-0001-0000-0001-000000000001';
  v_count         int;
begin
  -- 1a. null token → rows returned (public read)
  select count(*) into v_count
  from public.portal_get_contract_schedule(v_contract_a_id, null);
  if v_count < 1 then
    raise exception
      'FAIL 1a: anon + null token returned 0 rows — public read should be allowed '
      '(20260613222000_portal_schedule_public_read.sql may not have applied)';
  end if;

  -- 1b. empty-string token → rows returned (treated as absent; public read)
  select count(*) into v_count
  from public.portal_get_contract_schedule(v_contract_a_id, '');
  if v_count < 1 then
    raise exception
      'FAIL 1b: anon + empty-string token returned 0 rows — public read should be '
      'allowed for blank tokens';
  end if;

  raise notice 'PASS 1: anon + missing/empty token reads schedule (public read allowed)';
end;
$$;

reset role;

-- ── 2. anon + wrong token → denied ────────────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_contract_a_id constant uuid := 'beefcafe-0001-0000-0001-000000000001';
  v_caught        bool := false;
begin
  begin
    perform * from public.portal_get_contract_schedule(
      v_contract_a_id, 'definitely-not-the-right-token'
    );
    raise exception
      'FAIL 2: anon + wrong token succeeded — token hash validation is not effective';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 2: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2: anon + invalid token should raise 42501';
  end if;

  raise notice 'PASS 2: anon + invalid token denied (42501)';
end;
$$;

reset role;

-- ── 3. anon + correct token → returns scoped rows ─────────────────────────
-- Also verifies the ::uuid cast on l.asset_id (asset_name must be non-NULL).
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_contract_a_id constant uuid := 'beefcafe-0001-0000-0001-000000000001';
  v_valid_token   constant text := 'portal-schedule-rls-test-token-001';
  v_count         int;
  v_asset_name    text;
begin
  select count(*) into v_count
  from public.portal_get_contract_schedule(v_contract_a_id, v_valid_token);

  if v_count < 1 then
    raise exception
      'FAIL 3a: anon + valid token returned 0 rows; expected >= 1 (fixture contract line)';
  end if;

  -- asset_name comes through the v_current_assets LEFT JOIN using ::uuid cast.
  -- A NULL here means the cast is missing or the join is broken.
  select r.asset_name into v_asset_name
  from public.portal_get_contract_schedule(v_contract_a_id, v_valid_token) r
  limit 1;

  if v_asset_name is null then
    raise exception
      'FAIL 3b: asset_name is NULL — the ::uuid cast on l.asset_id in the '
      'v_current_assets JOIN may be missing or broken';
  end if;

  raise notice 'PASS 3: anon + valid token returns rows; asset JOIN (::uuid cast) intact';
end;
$$;

reset role;

-- ── 4. authenticated + correct token → returns rows ───────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_contract_a_id constant uuid := 'beefcafe-0001-0000-0001-000000000001';
  v_valid_token   constant text := 'portal-schedule-rls-test-token-001';
  v_count         int;
begin
  select count(*) into v_count
  from public.portal_get_contract_schedule(v_contract_a_id, v_valid_token);

  if v_count < 1 then
    raise exception
      'FAIL 4: authenticated + valid token returned 0 rows; expected >= 1';
  end if;

  raise notice 'PASS 4: authenticated + valid token returns rows';
end;
$$;

reset role;

-- ── 5. service_role bypasses token check ─────────────────────────────────
-- service_role callers (backend/CI) must be able to query without a scope token.
-- This is intentional — the service key is never exposed to browser clients.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_contract_a_id constant uuid := 'beefcafe-0001-0000-0001-000000000001';
  v_count         int;
begin
  select count(*) into v_count
  from public.portal_get_contract_schedule(v_contract_a_id, null);

  if v_count < 1 then
    raise exception
      'FAIL 5: service_role + null token returned 0 rows; '
      'token bypass must be active for service_role (expected >= 1 fixture row)';
  end if;

  raise notice 'PASS 5: service_role bypasses token check and returns rows';
end;
$$;

reset role;

-- ── 6. Cross-contract token isolation ────────────────────────────────────
-- A valid token for contract A must be rejected when presented for contract B.
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_contract_b_id constant uuid := 'beefcafe-0001-0000-0001-000000000002';
  v_valid_token   constant text := 'portal-schedule-rls-test-token-001';
  v_caught        bool := false;
begin
  begin
    perform * from public.portal_get_contract_schedule(v_contract_b_id, v_valid_token);
    raise exception
      'FAIL 6: contract-A token accepted for contract B — '
      'cross-contract token isolation is broken';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 6: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6: contract-A token used against contract B should raise 42501';
  end if;

  raise notice 'PASS 6: cross-contract token isolation enforced';
end;
$$;

reset role;

-- ── 7. Grant verification ─────────────────────────────────────────────────
-- Confirms the EXECUTE grants applied in the migration are in place.
-- A missing grant would prevent anon/authenticated from even reaching the JWT
-- check inside the function body.
do $$
declare
  v_roles text[] := array['anon', 'authenticated', 'service_role'];
  v_role  text;
  v_has_execute bool;
begin
  foreach v_role in array v_roles loop
    select has_function_privilege(
      v_role,
      'public.portal_get_contract_schedule(uuid, text)',
      'execute'
    ) into v_has_execute;

    if not v_has_execute then
      raise exception
        'FAIL 7: role % does not have EXECUTE on portal_get_contract_schedule — grant is missing',
        v_role;
    end if;
  end loop;

  raise notice
    'PASS 7: anon, authenticated, and service_role all hold EXECUTE grant';
end;
$$;

rollback;
