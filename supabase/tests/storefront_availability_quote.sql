-- Behavioral tests for the storefront availability + quote-submission migration
-- (20260609010000_storefront_availability_quote.sql).
--
-- These assertions would fail if:
--   * security_invoker is not set on v_storefront_asset_catalog
--   * the anon GRANT on the RPC functions is missing or ineffective
--   * anon can directly INSERT/SELECT storefront_quote_requests
--   * authenticated admin cannot SELECT storefront_quote_requests
--   * non-staff authenticated users cannot be blocked from reading customer quote request PII
--
-- Pattern: multiple DO blocks within one transaction.  SET LOCAL ROLE +
-- set_config('request.jwt.claims', ...) simulate the PostgREST JWT contexts
-- used in production without persisting any data.

begin;

-- ── 1. v_storefront_asset_catalog must declare security_invoker = true ───────
-- Without security_invoker the view executes as its owner (typically a
-- superuser) and bypasses base-table RLS, which is a #272-style security hole.
do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_storefront_asset_catalog';

  if not v_has_invoker then
    raise exception
      'FAIL 1: v_storefront_asset_catalog must declare security_invoker = true '
      '(without it the view owner bypasses base-table RLS — #272-style bypass)';
  end if;

  raise notice 'PASS 1: v_storefront_asset_catalog has security_invoker = true';
end;
$$;

-- ── 2. anon can call portal_storefront_get_availability ──────────────────────
-- The RPC is SECURITY DEFINER with an explicit anon allowance; anon API clients
-- must be able to query availability without any auth token.
set local role anon;
select set_config(
  'request.jwt.claims',
  '{"role":"anon"}',
  true
);

do $$
declare
  v_count int;
begin
  -- Calling with NULL dates (no filter) must succeed and return a row count >= 0.
  -- We do not assert a specific count because fixture data may not be present;
  -- a clean schema with no asset rows is acceptable here.
  begin
    select count(*) into v_count
      from public.portal_storefront_get_availability(null, null, null, null);
  exception
    when others then
      raise exception 'FAIL 2: anon call to portal_storefront_get_availability failed: % "%"',
        sqlstate, sqlerrm;
  end;

  raise notice 'PASS 2: anon can call portal_storefront_get_availability (returned % rows)', v_count;
end;
$$;

reset role;

-- ── 3. anon can call portal_storefront_submit_quote ──────────────────────────
-- Anon customers submit quote requests through the SECURITY DEFINER RPC; a
-- direct table INSERT is not granted and must be refused (tested in § 5).
set local role anon;
select set_config(
  'request.jwt.claims',
  '{"role":"anon"}',
  true
);

do $$
declare
  v_quote_id  uuid;
  v_created   timestamptz;
begin
  select quote_request_id, created_at
    into v_quote_id, v_created
    from public.portal_storefront_submit_quote(
      p_asset_id          := null,
      p_asset_category_id := null,
      p_branch_id         := null,
      p_start_date        := current_date + 1,
      p_end_date          := current_date + 8,
      p_contact_name      := 'Test Customer',
      p_contact_email     := 'test@example.com'
    );

  if v_quote_id is null then
    raise exception 'FAIL 3: portal_storefront_submit_quote returned a NULL quote_request_id';
  end if;

  raise notice 'PASS 3: anon submitted quote via RPC; id=%', v_quote_id;
end;
$$;

reset role;

-- ── 4. authenticated admin can SELECT storefront_quote_requests ───────────────
-- The RLS policy uses ops_claim_app_role(); admin and branch_manager claims must
-- pass so that internal sales staff can read submitted quote requests.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_count int;
begin
  -- At least one row was inserted by § 3 above.
  select count(*) into v_count from public.storefront_quote_requests;

  if v_count < 1 then
    raise exception
      'FAIL 4: authenticated admin should see >= 1 row in storefront_quote_requests '
      '(the row inserted in test 3 via RPC); got %', v_count;
  end if;

  raise notice 'PASS 4: authenticated admin can SELECT storefront_quote_requests (% rows)', v_count;
end;
$$;

reset role;

-- ── 4b. ordinary authenticated user (non-staff) cannot SELECT quote requests ──
-- An authenticated user whose app_metadata.role is not admin/branch_manager
-- (e.g. read_only, or a customer account with no internal role) must be denied.
-- This proves the USING clause is not USING (true).
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000088","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_count  int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_count from public.storefront_quote_requests;
    -- If RLS is USING (true) this will succeed (v_count > 0) — that is the bug.
    -- A correct staff-scoped policy must return 0 rows (RLS filters them all out).
    if v_count > 0 then
      raise exception
        'FAIL 4b: non-staff authenticated user read % row(s) from storefront_quote_requests — '
        'RLS policy must restrict to admin/branch_manager only, not USING (true)',
        v_count;
    end if;
  exception
    when insufficient_privilege then
      -- Table-level GRANT is present; RLS zero-row response is also acceptable.
      -- Either outcome (0 rows or permission denied) proves the data is protected.
      v_caught := true;
    when others then
      raise exception 'FAIL 4b: unexpected % "%"', sqlstate, sqlerrm;
  end;

  raise notice 'PASS 4b: non-staff authenticated user cannot read customer quote requests';
end;
$$;

reset role;

-- ── 5. anon cannot directly INSERT into storefront_quote_requests ─────────────
-- No INSERT policy and no GRANT INSERT exist for anon; the only insertion path
-- is through portal_storefront_submit_quote (SECURITY DEFINER).
set local role anon;
select set_config(
  'request.jwt.claims',
  '{"role":"anon"}',
  true
);

do $$
declare
  v_caught bool;
begin
  v_caught := false;
  begin
    insert into public.storefront_quote_requests
      (start_date, end_date, contact_name, contact_email)
    values
      (current_date + 1, current_date + 8, 'Attacker', 'attacker@evil.example');
    raise exception
      'FAIL 5: anon direct INSERT into storefront_quote_requests succeeded — '
      'there must be no INSERT grant or policy for anon';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 5: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 5: anon should be denied INSERT on storefront_quote_requests';
  end if;

  raise notice 'PASS 5: anon denied direct INSERT on storefront_quote_requests';
end;
$$;

-- ── 6. anon cannot directly SELECT storefront_quote_requests ──────────────────
-- No SELECT grant exists for anon; PII and quote details must not be readable
-- without staff credentials.
do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_dummy from public.storefront_quote_requests;
    raise exception
      'FAIL 6: anon SELECT on storefront_quote_requests succeeded — '
      'there must be no SELECT grant for anon';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 6: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 6: anon should be denied SELECT on storefront_quote_requests';
  end if;

  raise notice 'PASS 6: anon denied SELECT on storefront_quote_requests';
end;
$$;

reset role;

rollback;
