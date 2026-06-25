-- portal_demo_intake_url_reset.sql
--
-- Reset-path contract coverage for 20260618120000_portal_demo_intake_url.sql.
-- Run after `supabase db reset` (seed.sql applied) to verify:
--
--   1. Schema: portal_get_demo_intake_url() exists as a security definer
--      function, has EXECUTE granted to service_role, and is NOT callable
--      by anon (service_role only).
--   2. Seed: the demo intake token 'dia-demo-intake-token-001' is present in
--      portal_intake_scope_tokens after seed.sql runs.
--   3. URL contract: portal_get_demo_intake_url() called under the actual
--      service_role PostgreSQL session role returns a non-empty string
--      matching /portal/intake/<uuid>#token=dia-demo-intake-token-001
--      — the exact format that the e2e-dev.yml "Resolve portal intake demo URL"
--      step exports as E2E_PORTAL_INTAKE_SCOPED_URL.
--   4. Access control: anon cannot call portal_get_demo_intake_url().
--
-- Intended to run immediately after `supabase db reset --config supabase/config.toml`.

begin;

do $$
declare
  v_demo_token      constant text := 'dia-demo-intake-token-001';
  v_demo_token_hash constant text := '5467ab75215992bc249e670aa6827ed439067156ec4d6647f5f21fb37bf29c26';
  v_token_count     int;
  v_intake_url      text;
  v_caught          bool;
begin

  -- ──────────────────────────────────────────────────────────────────────────
  -- 1. Schema: function exists, is security definer, grant is service_role only
  -- ──────────────────────────────────────────────────────────────────────────

  -- 1a. Function exists
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'portal_get_demo_intake_url'
  ) then
    raise exception 'FAIL 1a: portal_get_demo_intake_url() does not exist — migration 20260618120000_portal_demo_intake_url.sql may not have applied';
  end if;

  raise notice 'PASS 1a: portal_get_demo_intake_url() exists';

  -- 1b. Security definer
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'portal_get_demo_intake_url'
      and p.prosecdef = true
  ) then
    raise exception 'FAIL 1b: portal_get_demo_intake_url() is not SECURITY DEFINER — the migration must mark it definer so service_role can resolve the token hash';
  end if;

  raise notice 'PASS 1b: portal_get_demo_intake_url() is SECURITY DEFINER';

  -- 1c. public (anon) has no EXECUTE privilege
  if exists (
    select 1
    from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name   = 'portal_get_demo_intake_url'
      and grantee        = 'public'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'FAIL 1c: portal_get_demo_intake_url() grants EXECUTE to PUBLIC — the demo token must not be exposed to anon callers';
  end if;

  raise notice 'PASS 1c: portal_get_demo_intake_url() does not grant EXECUTE to PUBLIC (anon cannot call it)';

  -- 1d. service_role has EXECUTE privilege (the workflow RPC path relies on this)
  if not exists (
    select 1
    from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name   = 'portal_get_demo_intake_url'
      and grantee        = 'service_role'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'FAIL 1d: portal_get_demo_intake_url() is not granted EXECUTE to service_role — the e2e-dev.yml workflow RPC call will fail';
  end if;

  raise notice 'PASS 1d: portal_get_demo_intake_url() has EXECUTE grant for service_role';

  raise notice 'PASS 1: Migration schema shape verified (1a–1d)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 2. Seed: demo intake token row present in portal_intake_scope_tokens
  -- ──────────────────────────────────────────────────────────────────────────

  select count(*) into v_token_count
  from public.portal_intake_scope_tokens
  where token_hash = v_demo_token_hash;

  if v_token_count <> 1 then
    raise exception 'FAIL 2: demo intake token row not found in portal_intake_scope_tokens (found % rows) — seed.sql must insert dia-demo-intake-token-001', v_token_count;
  end if;

  raise notice 'PASS 2: demo intake token is seeded in portal_intake_scope_tokens';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 3. URL contract: portal_get_demo_intake_url() returns a usable URL
  --    Called under the actual service_role PostgreSQL session role (matching
  --    the PostgREST execution path used by the e2e-dev.yml workflow step) so
  --    a regression in the EXECUTE grant fails this check, not just the anon
  --    check in section 4.
  -- ──────────────────────────────────────────────────────────────────────────

  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  select portal_get_demo_intake_url() into v_intake_url;

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  -- 3a. Non-null
  if v_intake_url is null then
    raise exception 'FAIL 3a: portal_get_demo_intake_url() returned null — demo intake token may not be seeded or token_hash mismatch';
  end if;

  raise notice 'PASS 3a: portal_get_demo_intake_url() returned a non-null value';

  -- 3b. Starts with /portal/intake/
  if v_intake_url not like '/portal/intake/%' then
    raise exception 'FAIL 3b: portal_get_demo_intake_url() returned URL with unexpected prefix: % (expected /portal/intake/<uuid>#token=...)', v_intake_url;
  end if;

  raise notice 'PASS 3b: URL starts with /portal/intake/';

  -- 3c. Fragment contains the raw token (E2E_PORTAL_INTAKE_SCOPED_URL contract)
  if v_intake_url not like '%#token=' || v_demo_token then
    raise exception 'FAIL 3c: portal_get_demo_intake_url() URL does not contain expected fragment #token=%: %', v_demo_token, v_intake_url;
  end if;

  raise notice 'PASS 3c: URL fragment contains raw token (e2e-dev.yml E2E_PORTAL_INTAKE_SCOPED_URL contract satisfied): %', v_intake_url;

  raise notice 'PASS 3: URL contract verified (3a–3c)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 4. Access control: anon is denied
  -- ──────────────────────────────────────────────────────────────────────────

  v_caught := false;

  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

    perform portal_get_demo_intake_url();
    raise exception 'FAIL 4: anon was allowed to call portal_get_demo_intake_url() — demo token is exposed to unauthenticated callers';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 4: anon calling portal_get_demo_intake_url() raised unexpected error: % "%"', sqlstate, sqlerrm;
  end;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  execute 'reset role';

  if not v_caught then
    raise exception 'FAIL 4: anon + portal_get_demo_intake_url was not blocked';
  end if;

  raise notice 'PASS 4: anon cannot call portal_get_demo_intake_url() (insufficient_privilege raised as expected)';

  raise notice 'PASS: all portal_demo_intake_url_reset assertions passed';
end;
$$;

rollback;
