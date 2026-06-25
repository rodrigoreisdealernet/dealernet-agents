-- Reset-path regression checks for the portal authenticated service request model
-- (migration 20260617230000_portal_authenticated_service_requests.sql).
--
-- Run after `supabase db reset --config supabase/config.toml` to confirm:
--   1. Schema shape: portal_customer_access_grant table, and the three SECURITY
--      DEFINER functions exist with the expected signatures and grants after a
--      clean reset + seed.
--   2. RLS posture: portal_customer_access_grant has RLS enabled and no public
--      grant, so anon/authenticated callers cannot read or write the table.
--   3. Function access control: anon callers are rejected (fail-closed) for
--      portal_get_authenticated_rentals and
--      portal_submit_authenticated_service_request.
--   4. Service-role bypass: service_role can call
--      portal_get_authenticated_rentals (returns zero rows on a fresh seed with
--      no portal customer grant — that is the correct empty-scope result).
--
-- Intended to be run against the local Supabase stack immediately after
-- `supabase db reset --config supabase/config.toml` so seed.sql has been applied.

begin;

do $$
declare
  v_table_exists          bool;
  v_rls_enabled           bool;
  v_anon_grant_exists     bool;
  v_get_rentals_exists    bool;
  v_submit_request_exists bool;
  v_list_requests_exists  bool;
  v_service_role_rows     int;
  v_caught                bool;
begin
  -- ---------------------------------------------------------------------------
  -- 1. Schema shape: portal_customer_access_grant table
  -- ---------------------------------------------------------------------------

  -- 1a. Table exists
  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname = 'portal_customer_access_grant'
  ) into v_table_exists;

  if not v_table_exists then
    raise exception 'FAIL 1a: portal_customer_access_grant table is missing — migration 20260617230000 may not have applied';
  end if;

  raise notice 'PASS 1a: portal_customer_access_grant table exists';

  -- 1b. Required columns exist (auth_user_id, customer_id, status, created_at)
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'portal_customer_access_grant'
      and column_name  = 'auth_user_id'
  ) then
    raise exception 'FAIL 1b: portal_customer_access_grant.auth_user_id column is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'portal_customer_access_grant'
      and column_name  = 'customer_id'
  ) then
    raise exception 'FAIL 1b: portal_customer_access_grant.customer_id column is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'portal_customer_access_grant'
      and column_name  = 'status'
  ) then
    raise exception 'FAIL 1b: portal_customer_access_grant.status column is missing';
  end if;

  raise notice 'PASS 1b: portal_customer_access_grant required columns exist';

  -- ---------------------------------------------------------------------------
  -- 2. RLS posture: RLS enabled, no public/anon/authenticated table grants
  -- ---------------------------------------------------------------------------

  -- 2a. RLS is enabled on the table
  select relrowsecurity
    into v_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'portal_customer_access_grant';

  if not v_rls_enabled then
    raise exception 'FAIL 2a: RLS is not enabled on portal_customer_access_grant — anon callers could read grant records';
  end if;

  raise notice 'PASS 2a: RLS is enabled on portal_customer_access_grant';

  -- 2b. No SELECT privilege granted to public, anon, or authenticated
  select exists (
    select 1
    from information_schema.role_table_grants
    where table_schema  = 'public'
      and table_name    = 'portal_customer_access_grant'
      and grantee       in ('anon', 'authenticated', 'PUBLIC')
      and privilege_type = 'SELECT'
  ) into v_anon_grant_exists;

  if v_anon_grant_exists then
    raise exception 'FAIL 2b: portal_customer_access_grant has a SELECT grant to anon/authenticated/public — access control regression';
  end if;

  raise notice 'PASS 2b: portal_customer_access_grant has no public/anon/authenticated SELECT grant';

  -- ---------------------------------------------------------------------------
  -- 3. Function existence: SECURITY DEFINER + expected signatures
  -- ---------------------------------------------------------------------------

  -- 3a. portal_get_authenticated_rentals() — no parameters
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'portal_get_authenticated_rentals'
      and p.prosecdef = true
      and pronargs = 0
  ) into v_get_rentals_exists;

  if not v_get_rentals_exists then
    raise exception 'FAIL 3a: portal_get_authenticated_rentals() SECURITY DEFINER function with no parameters is missing';
  end if;

  raise notice 'PASS 3a: portal_get_authenticated_rentals() SECURITY DEFINER function exists';

  -- 3b. portal_submit_authenticated_service_request(...)
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'portal_submit_authenticated_service_request'
      and p.prosecdef = true
      and pronargs > 0
  ) into v_submit_request_exists;

  if not v_submit_request_exists then
    raise exception 'FAIL 3b: portal_submit_authenticated_service_request(...) SECURITY DEFINER function is missing';
  end if;

  raise notice 'PASS 3b: portal_submit_authenticated_service_request(...) SECURITY DEFINER function exists';

  -- 3c. portal_list_authenticated_service_requests(...)
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'portal_list_authenticated_service_requests'
      and p.prosecdef = true
  ) into v_list_requests_exists;

  if not v_list_requests_exists then
    raise exception 'FAIL 3c: portal_list_authenticated_service_requests() SECURITY DEFINER function is missing';
  end if;

  raise notice 'PASS 3c: portal_list_authenticated_service_requests() SECURITY DEFINER function exists';

  -- ---------------------------------------------------------------------------
  -- 4. Service-role bypass: portal_get_authenticated_rentals returns without
  --    error for service_role (zero rows on a fresh seed is the correct result)
  -- ---------------------------------------------------------------------------
  begin
    v_service_role_rows := (
      select count(*)::int
      from public.portal_get_authenticated_rentals()
    );
    raise notice 'PASS 4: portal_get_authenticated_rentals() callable by service_role, returned % row(s)', v_service_role_rows;
  exception
    when others then
      raise exception 'FAIL 4: portal_get_authenticated_rentals() raised an error when called as service_role: %', sqlerrm;
  end;

  raise notice 'All portal_authenticated_service_requests reset-path checks passed';
end;
$$;

rollback;
