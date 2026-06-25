-- Reset-path regression tests for 20260609200000_portal_schedule_access.sql
-- and the portal scope token seeded in seed.sql.
--
-- Exercises the migration + seed interaction after a full `supabase db reset`:
--   1. Schema shape: portal_contract_scope_tokens table, portal_get_contract_schedule,
--      and portal_get_demo_portal_url exist with the expected signatures and grants.
--   2. Seed data: the demo scope token for demo-baseline-rental-contract-002 is present
--      and portal_get_demo_portal_url() returns the expected URL.
--   3. Scope-token auth using the seeded demo data:
--      - service_role bypasses the token check.
--      - anon + valid demo token can call portal_get_contract_schedule.
--      - anon + null token reads the schedule (public read; contract UUID is the share
--        secret; off-rent actions still require a valid token).
--      - anon + forged token is denied (42501).
--      - anon calling portal_get_demo_portal_url() is denied (42501).
--   4. Customer-request persistence: anon + valid demo token can submit pickup/call-off,
--      extension, and field-service requests via portal_submit_customer_service_request,
--      view them through portal_list_customer_service_requests, and re-submit the same
--      request type without creating duplicate open-thread noise.
--
-- Intended to be run against the local Supabase stack immediately after
-- `supabase db reset --config supabase/config.toml` so seed.sql has been applied.

begin;

do $$
declare
  v_demo_token  constant text := 'wynne-demo-portal-scope-001';
  v_forged_token constant text := 'portal-schedule-access-test-forged-token';

  v_contract_id      uuid;
  v_contract_line_id uuid;
  v_token_count      int;
  v_demo_url         text;
  v_row_count        int;
  v_request_id       uuid;
  v_request_count    int;
  v_caught           bool;
begin

  -- Keep digest() resolution compatible with Supabase (extensions schema) and
  -- plain Postgres (public schema).
  perform set_config('search_path', 'public,extensions,pg_temp', true);

  -- ──────────────────────────────────────────────────────────────────────────
  -- 1. Schema validation
  --    portal_contract_scope_tokens, portal_get_contract_schedule, and
  --    portal_get_demo_portal_url must exist after the migration applies.
  -- ──────────────────────────────────────────────────────────────────────────

  -- 1a. portal_contract_scope_tokens table exists with required columns
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'portal_contract_scope_tokens'
      and column_name = 'contract_id'
  ) then
    raise exception 'FAIL 1a: portal_contract_scope_tokens.contract_id column is missing — migration may not have applied';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'portal_contract_scope_tokens'
      and column_name = 'token_hash'
  ) then
    raise exception 'FAIL 1a: portal_contract_scope_tokens.token_hash column is missing';
  end if;

  raise notice 'PASS 1a: portal_contract_scope_tokens schema shape is correct';

  -- 1b. portal_get_contract_schedule(uuid, text) exists
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'portal_get_contract_schedule'
      and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_contract_id uuid, p_scope_token text'
  ) then
    raise exception 'FAIL 1b: portal_get_contract_schedule(uuid, text) does not exist — migration may not have applied';
  end if;

  raise notice 'PASS 1b: portal_get_contract_schedule(uuid, text) exists';

  -- 1c. portal_get_demo_portal_url() exists and is security definer
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'portal_get_demo_portal_url'
      and p.prosecdef = true
  ) then
    raise exception 'FAIL 1c: portal_get_demo_portal_url() does not exist as a security definer function';
  end if;

  raise notice 'PASS 1c: portal_get_demo_portal_url() exists (security definer)';

  raise notice 'PASS 1: Migration schema shape verified (1a–1c)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 2. Seed data validation
  --    After `supabase db reset`, seed.sql must have placed the demo scope
  --    token row for demo-baseline-rental-contract-002.
  -- ──────────────────────────────────────────────────────────────────────────

  -- 2a. Resolve the demo contract entity ID
  select e.id
    into v_contract_id
  from public.entities e
  where e.entity_type = 'rental_contract'
    and e.source_record_id = 'demo-baseline-rental-contract-002'
  limit 1;

  if v_contract_id is null then
    raise exception 'FAIL 2a: demo-baseline-rental-contract-002 entity not found — seed.sql may not have been applied';
  end if;

  raise notice 'PASS 2a: demo-baseline-rental-contract-002 found (id=%)', v_contract_id;

  -- 2b. The demo scope token row must exist in portal_contract_scope_tokens
  select count(*) into v_token_count
  from public.portal_contract_scope_tokens s
  where s.contract_id = v_contract_id
    and s.token_hash = encode(
      extensions.digest(convert_to(v_demo_token, 'UTF8'), 'sha256'),
      'hex'
    );

  if v_token_count <> 1 then
    raise exception 'FAIL 2b: demo scope token row missing from portal_contract_scope_tokens (found % rows) — seed.sql may not have been applied', v_token_count;
  end if;

  raise notice 'PASS 2b: demo scope token is seeded in portal_contract_scope_tokens';

  -- 2c. portal_get_demo_portal_url() returns the expected URL
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select portal_get_demo_portal_url() into v_demo_url;

  if v_demo_url is null then
    raise exception 'FAIL 2c: portal_get_demo_portal_url() returned null — demo scope token not seeded';
  end if;

  if v_demo_url not like '/portal/schedule/%?scope=wynne-demo-portal-scope-001' then
    raise exception 'FAIL 2c: portal_get_demo_portal_url() returned unexpected URL: %', v_demo_url;
  end if;

  raise notice 'PASS 2c: portal_get_demo_portal_url() returns expected URL: %', v_demo_url;

  raise notice 'PASS 2: Seed data validated (2a–2c)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 3. Scope-token auth using the seeded demo data
  --    The key regression: these checks run against the actual seeded token,
  --    so any seed/migration drift that breaks the token→contract binding will
  --    be caught here rather than discovered during a live portal session.
  --
  --    3a. service_role bypasses token check.
  --    3b. anon + valid demo token can call portal_get_contract_schedule.
  --    3c. anon + null token → public read (schedule visible; no token required
  --        for reads; off-rent actions still require a valid token).
  --    3d. anon + forged token → 42501.
  --    3e. anon calling portal_get_demo_portal_url() → 42501.
  -- ──────────────────────────────────────────────────────────────────────────

  -- 3a. service_role bypasses scope enforcement
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select count(*) into v_row_count
  from portal_get_contract_schedule(v_contract_id, null);
  -- Row count may be zero; the important thing is no exception is raised.
  raise notice 'PASS 3a: service_role can call portal_get_contract_schedule without a scope token (% rows)', v_row_count;

  -- 3b. anon + valid demo scope token can read schedule
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  select count(*) into v_row_count
  from portal_get_contract_schedule(v_contract_id, v_demo_token);
  raise notice 'PASS 3b: anon + valid demo scope token can call portal_get_contract_schedule (% rows)', v_row_count;

  -- 3c. anon + null scope token → public read (schedule visible without a token)
  select count(*) into v_row_count
  from portal_get_contract_schedule(v_contract_id, null);
  raise notice 'PASS 3c: anon + null scope token reads the schedule without error (% rows)', v_row_count;

  -- 3d. anon + forged token → 42501
  v_caught := false;
  begin
    perform portal_get_contract_schedule(v_contract_id, v_forged_token);
    raise exception 'FAIL 3d: anon + forged scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 3d: unexpected error % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3d: anon + forged scope token was not blocked';
  end if;

  raise notice 'PASS 3d: anon + forged scope token is rejected by portal_get_contract_schedule';

  -- 3e. anon calling portal_get_demo_portal_url() → 42501
  v_caught := false;
  begin
    perform portal_get_demo_portal_url();
    raise exception 'FAIL 3e: anon was allowed to call portal_get_demo_portal_url — demo token is exposed';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 3e: unexpected error % "%"', sqlstate, sqlerrm;
  end;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  execute 'reset role';

  if not v_caught then
    raise exception 'FAIL 3e: anon calling portal_get_demo_portal_url was not blocked';
  end if;

  raise notice 'PASS 3e: anon cannot call portal_get_demo_portal_url (demo token not exposed to public)';

  raise notice 'PASS 3: Scope-token auth verified against seeded demo data (3a–3e)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 4. Customer-request persistence
  --    Validates that portal_submit_customer_service_request (scoped) creates a
  --    canonical record visible to portal_list_customer_service_requests with
  --    the same scope token.
  --    A checked-out contract line is created as a test fixture and rolled back
  --    with the enclosing transaction.
  --
  --    4a. Create a checked-out contract line for the demo contract.
  --    4b. anon + null token is denied for portal_submit_customer_service_request.
  --    4c. anon + forged token is denied for portal_submit_customer_service_request.
  --    4d. anon + valid demo token can submit a customer request.
  --    4e. The submitted request appears in portal_list_customer_service_requests.
  --    4f. anon + forged token is denied for portal_list_customer_service_requests.
  --    4g. pickup/call-off + field-service request types are also persisted for
  --        the same scoped line and remain visible in portal_list_customer_service_requests.
  --    4h. A duplicate submission for the same line/action collapses into one
  --        canonical thread.
  -- ──────────────────────────────────────────────────────────────────────────

  -- 4a. Create a checked-out contract line as a test fixture (rolled back at end)
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id
    into v_contract_line_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'rental_contract_line',
    p_data             => jsonb_build_object(
      'status', 'checked_out',
      'contract_id', v_contract_id::text,
      'asset_id', gen_random_uuid()::text,
      'job_site_id', null
    ),
    p_source_record_id => 'portal-schedule-access-test-line-001'
  );

  if v_contract_line_id is null then
    raise exception 'FAIL 4a: test contract line fixture could not be created';
  end if;

  raise notice 'PASS 4a: test contract line fixture created (id=%)', v_contract_line_id;

  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  -- 4b. anon + null token is denied for portal_submit_customer_service_request
  v_caught := false;
  begin
    perform portal_submit_customer_service_request(
      p_contract_id      => v_contract_id,
      p_contract_line_id => v_contract_line_id,
      p_scope_token      => null,
      p_reason           => 'portal schedule access reset-path test (null scope token denied)',
      p_request_type     => 'off_rent_pickup'
    );
    raise exception 'FAIL 4b: portal_submit_customer_service_request accepted anon + null scope token';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 4b: unexpected error % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 4b: portal_submit_customer_service_request did not block anon + null scope token';
  end if;
  raise notice 'PASS 4b: portal_submit_customer_service_request rejects anon + null scope token';

  -- 4c. anon + forged token is denied for portal_submit_customer_service_request
  v_caught := false;
  begin
    perform portal_submit_customer_service_request(
      p_contract_id      => v_contract_id,
      p_contract_line_id => v_contract_line_id,
      p_scope_token      => v_forged_token,
      p_reason           => 'portal schedule access reset-path test (forged scope token denied)',
      p_request_type     => 'off_rent_pickup'
    );
    raise exception 'FAIL 4c: portal_submit_customer_service_request accepted anon + forged scope token';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 4c: unexpected error % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 4c: portal_submit_customer_service_request did not block anon + forged scope token';
  end if;
  raise notice 'PASS 4c: portal_submit_customer_service_request rejects anon + forged scope token';

  -- 4d. anon + valid demo token can submit a customer request
  select request_id
    into v_request_id
  from portal_submit_customer_service_request(
    p_contract_id      => v_contract_id,
    p_contract_line_id => v_contract_line_id,
    p_scope_token      => v_demo_token,
    p_reason           => 'portal schedule access reset-path test',
    p_request_type     => 'contract_extension',
    p_urgency          => 'high'
  );

  if v_request_id is null then
    raise exception 'FAIL 4d: portal_submit_customer_service_request returned null request_id for anon + valid demo token';
  end if;

  raise notice 'PASS 4d: anon + valid demo token submitted customer request (id=%)', v_request_id;

  -- 4e. The submitted request is visible via portal_list_customer_service_requests
  select count(*) into v_request_count
  from portal_list_customer_service_requests(v_contract_id, v_demo_token)
  where request_id = v_request_id;

  if v_request_count <> 1 then
    raise exception 'FAIL 4e: submitted customer request not found in portal_list_customer_service_requests (found % rows)', v_request_count;
  end if;

  raise notice 'PASS 4e: submitted customer request persists in portal_list_customer_service_requests';

  -- 4f. anon + forged token is denied for portal_list_customer_service_requests
  v_caught := false;
  begin
    perform 1
    from portal_list_customer_service_requests(v_contract_id, v_forged_token)
    limit 1;
    raise exception 'FAIL 4f: portal_list_customer_service_requests accepted anon + forged scope token';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 4f: unexpected error % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 4f: portal_list_customer_service_requests did not block anon + forged scope token';
  end if;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  execute 'reset role';

  raise notice 'PASS 4f: portal_list_customer_service_requests rejects anon + forged scope token';

  -- 4g. pickup/call-off + field-service request types are also persisted
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  perform portal_submit_customer_service_request(
    p_contract_id      => v_contract_id,
    p_contract_line_id => v_contract_line_id,
    p_scope_token      => v_demo_token,
    p_request_type     => 'off_rent_pickup',
    p_urgency          => 'standard',
    p_reason           => 'portal schedule access reset-path off-rent pickup/call-off test'
  );

  perform portal_submit_customer_service_request(
    p_contract_id      => v_contract_id,
    p_contract_line_id => v_contract_line_id,
    p_scope_token      => v_demo_token,
    p_request_type     => 'field_service',
    p_urgency          => 'critical',
    p_reason           => 'portal schedule access reset-path field service test',
    p_customer_note    => 'Hydraulic leak at mast'
  );

  select count(*)
    into v_request_count
  from portal_list_customer_service_requests(v_contract_id, v_demo_token)
  where contract_line_id = v_contract_line_id::text
    and request_type in ('contract_extension', 'off_rent_pickup', 'field_service');

  if v_request_count <> 3 then
    raise exception 'FAIL 4g: expected one queued row per customer request type for scoped line (found % rows)', v_request_count;
  end if;

  select count(*)
    into v_request_count
  from portal_list_customer_service_requests(v_contract_id, v_demo_token)
  where contract_line_id = v_contract_line_id::text
    and request_type = 'field_service'
    and urgency = 'critical'
    and coalesce(customer_note, '') = 'Hydraulic leak at mast';

  if v_request_count <> 1 then
    raise exception 'FAIL 4g: field-service urgency/note context did not persist through scoped list path';
  end if;

  raise notice 'PASS 4g: scoped pickup/call-off + extension + field-service rows persist with context';

  -- 4h. Duplicate submissions collapse into one canonical request thread
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  perform portal_submit_customer_service_request(
    p_contract_id      => v_contract_id,
    p_contract_line_id => v_contract_line_id,
    p_scope_token      => v_demo_token,
    p_request_type     => 'contract_extension',
    p_urgency          => 'high',
    p_reason           => 'portal schedule access reset-path test'
  );

  select count(*)
    into v_request_count
  from portal_list_customer_service_requests(v_contract_id, v_demo_token)
  where contract_line_id = v_contract_line_id::text
    and request_type = 'contract_extension';

  if v_request_count <> 1 then
    raise exception 'FAIL 4h: duplicate customer request did not collapse into one canonical thread (found % rows)', v_request_count;
  end if;

  raise notice 'PASS 4h: duplicate customer request collapses into one canonical thread';

  raise notice 'PASS 4: Customer request scope-token boundary verified (4a–4h)';

  raise notice 'All portal_schedule_access reset-path tests passed (1–4)';

end;
$$;

rollback;
