-- RLS / security-invoker / GRANT behavioral tests for fleet_get_availability_calendar
-- (migration 20260610191000_fleet_availability_calendar.sql).
--
-- These assertions would fail if:
--   * the function is changed to SECURITY DEFINER (bypasses caller RLS)
--   * the anon GRANT is accidentally added (allows unauthenticated read)
--   * the in-function JWT role guard is removed (empty-claim callers bypass the check)
--   * the GRANT to authenticated or service_role is removed (legitimate callers blocked)
--   * the security_invoker chain on dependent views is broken
--
-- Pattern: multiple DO blocks within one transaction.  SET LOCAL ROLE +
-- set_config('request.jwt.claims', ...) simulate the PostgREST JWT contexts
-- used in production without persisting any data.

begin;

-- ── Fixture setup (superuser / service_role context) ─────────────────────
-- Minimal branch + asset_category + asset rows so the calendar RPC has
-- something to return for authenticated/service_role read tests.
do $$
declare
  v_branch_id    constant uuid := 'ca1e0000-0000-0000-0001-000000000001';
  v_category_id  constant uuid := 'ca1e0000-0000-0000-0002-000000000001';
  v_asset_id     constant uuid := 'ca1e0000-0000-0000-0003-000000000001';
begin
  -- branch
  insert into public.entities (id, entity_type, source_record_id)
  values (v_branch_id, 'branch', 'cal-rls-test-branch')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values (v_branch_id, 1, true, '{"name":"RLS Test Depot"}'::jsonb, now())
  on conflict (entity_id, version_number) do nothing;

  -- asset category
  insert into public.entities (id, entity_type, source_record_id)
  values (v_category_id, 'asset_category', 'cal-rls-test-category')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values (v_category_id, 1, true, '{"name":"RLS Test Category"}'::jsonb, now())
  on conflict (entity_id, version_number) do nothing;

  -- asset (available, assigned to branch + category)
  insert into public.entities (id, entity_type, source_record_id)
  values (v_asset_id, 'asset', 'cal-rls-test-asset')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values (
    v_asset_id, 1, true,
    '{"name":"RLS Calendar Excavator","identifier":"RLS-CAL-001","operational_status":"available"}'::jsonb,
    now()
  )
  on conflict (entity_id, version_number) do nothing;

  -- branch_has_asset relationship
  insert into public.relationships_v2 (relationship_type, parent_id, child_id, is_current)
  values ('branch_has_asset', v_branch_id, v_asset_id, true)
  on conflict do nothing;

  -- asset_category_has_asset relationship
  insert into public.relationships_v2 (relationship_type, parent_id, child_id, is_current)
  values ('asset_category_has_asset', v_category_id, v_asset_id, true)
  on conflict do nothing;
end;
$$;

-- ── 1. fleet_get_availability_calendar must be SECURITY INVOKER ───────────
-- SECURITY DEFINER would run the function body as its owner (typically a
-- superuser) instead of as the calling role, bypassing base-table RLS and
-- allowing any authenticated caller to read the full fleet dataset regardless
-- of what the caller's own policies permit.
do $$
declare
  v_is_definer bool;
begin
  select p.prosecdef
    into v_is_definer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'fleet_get_availability_calendar';

  if v_is_definer is null then
    raise exception
      'FAIL 1: fleet_get_availability_calendar not found in pg_proc — '
      'migration did not apply cleanly';
  end if;

  if v_is_definer then
    raise exception
      'FAIL 1: fleet_get_availability_calendar must be SECURITY INVOKER '
      '(prosecdef = false); a SECURITY DEFINER function runs as its owner '
      'and bypasses the caller''s RLS boundary';
  end if;

  raise notice 'PASS 1: fleet_get_availability_calendar is SECURITY INVOKER (prosecdef = false)';
end;
$$;

-- ── 2. Dependent views must declare security_invoker = true ──────────────
-- fleet_get_availability_calendar queries rental_current_assets and
-- v_rental_contract_line_current.  Both views must carry security_invoker =
-- true so that the caller's RLS policies apply when the function body reads
-- from them.  A non-invoker view in the dependency chain would silently
-- execute as the view owner and expose data beyond the caller's RLS boundary.
do $$
declare
  v_has_invoker bool;
begin
  -- rental_current_assets
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'rental_current_assets';

  if not v_has_invoker then
    raise exception
      'FAIL 2a: rental_current_assets must declare security_invoker = true '
      '(it is queried inside the SECURITY INVOKER function; a non-invoker '
      'dependency breaks the RLS enforcement chain)';
  end if;

  -- v_rental_contract_line_current
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_rental_contract_line_current';

  if not v_has_invoker then
    raise exception
      'FAIL 2b: v_rental_contract_line_current must declare security_invoker = true '
      '(queried inside fleet_get_availability_calendar; non-invoker view '
      'would bypass base-table RLS for contract-line data)';
  end if;

  raise notice 'PASS 2: rental_current_assets and v_rental_contract_line_current both have security_invoker = true';
end;
$$;

-- ── 3. anon cannot execute fleet_get_availability_calendar ────────────────
-- The GRANT is restricted to authenticated and service_role; anon must receive
-- a permission-denied error before the function body is even entered.
set local role anon;

do $$
declare
  v_count  int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_count
      from public.fleet_get_availability_calendar(null, null, null, null, null);
    raise exception
      'FAIL 3: anon call to fleet_get_availability_calendar succeeded — '
      'the function must not be granted to the anon role';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 3: unexpected SQLSTATE % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 3: anon should receive insufficient_privilege (42501)';
  end if;

  raise notice 'PASS 3: anon denied execute on fleet_get_availability_calendar (42501)';
end;
$$;

reset role;

-- ── 4. Empty JWT role context is denied by the in-function JWT guard ──────
-- When PostgREST sets SET LOCAL ROLE authenticated but the JWT does not carry
-- a role claim (both request.jwt.claim.role and request.jwt.claims are absent
-- or empty), the function resolves v_role to '' which is not in
-- ('authenticated', 'service_role'), and the function raises 42501.
-- This prevents a caller that holds the Postgres authenticated role but lacks
-- a valid JWT from reading fleet data.
set local role authenticated;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims',     '', true);

do $$
declare
  v_count  int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_count
      from public.fleet_get_availability_calendar(null, null, null, null, null);
    raise exception
      'FAIL 4: authenticated role with empty JWT claims succeeded — '
      'the in-function JWT role guard must block empty-claim callers';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 4: unexpected SQLSTATE % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 4: empty-JWT context should be blocked with SQLSTATE 42501';
  end if;

  raise notice 'PASS 4: empty JWT role context blocked by in-function guard (42501)';
end;
$$;

reset role;

-- ── 5. authenticated + valid JWT can call the function ────────────────────
-- A caller whose JWT carries role = 'authenticated' must be able to execute
-- the function.  Since the function is SECURITY INVOKER, the authenticated
-- role's SELECT grant on entities / entity_versions (and the RLS
-- authenticated_read policy) governs what rows are visible.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_asset_id constant uuid := 'ca1e0000-0000-0000-0003-000000000001';
  v_count    int;
  v_name     text;
  v_avail    bool;
begin
  -- Must not raise an exception
  begin
    select count(*) into v_count
      from public.fleet_get_availability_calendar(null, null, null, null, null);
  exception
    when others then
      raise exception 'FAIL 5a: authenticated call to fleet_get_availability_calendar failed: % "%"',
        sqlstate, sqlerrm;
  end;

  -- The fixture asset must appear in the results (it has a branch assignment)
  select name, is_available
    into v_name, v_avail
    from public.fleet_get_availability_calendar(null, null, null, null, null)
   where entity_id = v_asset_id;

  if v_name is null then
    raise exception
      'FAIL 5b: authenticated caller did not see fixture asset — '
      'the SECURITY INVOKER chain or the authenticated_read RLS policy may be broken '
      '(expected entity_id = %)', v_asset_id;
  end if;

  if not v_avail then
    raise exception
      'FAIL 5c: fixture asset should be available (operational_status = ''available'', '
      'no overlapping contract line); got is_available = false';
  end if;

  raise notice 'PASS 5: authenticated caller can execute function; fixture asset visible and available';
end;
$$;

reset role;

-- ── 6. service_role can call the function ────────────────────────────────
-- service_role is granted execute and bypasses RLS; all assets are visible.
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

do $$
declare
  v_asset_id constant uuid := 'ca1e0000-0000-0000-0003-000000000001';
  v_count    int;
  v_name     text;
begin
  begin
    select count(*) into v_count
      from public.fleet_get_availability_calendar(null, null, null, null, null);
  exception
    when others then
      raise exception 'FAIL 6a: service_role call to fleet_get_availability_calendar failed: % "%"',
        sqlstate, sqlerrm;
  end;

  select name into v_name
    from public.fleet_get_availability_calendar(null, null, null, null, null)
   where entity_id = v_asset_id;

  if v_name is null then
    raise exception
      'FAIL 6b: service_role caller did not see fixture asset (entity_id = %)',
      v_asset_id;
  end if;

  raise notice 'PASS 6: service_role caller can execute function; fixture asset visible';
end;
$$;

reset role;

-- ── 7. anon cannot directly read rental_current_assets ───────────────────
-- Because fleet_get_availability_calendar is SECURITY INVOKER, the function
-- body runs with the caller's role.  anon has had its SELECT revoked from the
-- underlying tables (migration 20260607131500_lock_down_anon_read_access.sql).
-- This test confirms that the REVOKE is effective on the view, ensuring that
-- even if the function's GRANT were accidentally extended to anon in future the
-- security_invoker chain would still block data access at the table/view layer.
set local role anon;

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_dummy from public.rental_current_assets;
    raise exception
      'FAIL 7: anon read rental_current_assets succeeded — '
      'REVOKE from anon is not effective; the security_invoker chain is broken';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 7: unexpected SQLSTATE % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 7: anon should be denied SELECT on rental_current_assets';
  end if;

  raise notice 'PASS 7: anon denied direct SELECT on rental_current_assets (security_invoker chain intact)';
end;
$$;

reset role;

rollback;
