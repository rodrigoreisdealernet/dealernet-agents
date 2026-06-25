-- Reset-path grant/security-invoker behavioral tests for
-- supabase/migrations/20260616052000_home_dashboard_kpis_grant.sql
--
-- Assertions:
--   1. Catalog grant chain: authenticated and service_role hold SELECT on both
--      v_home_dashboard_kpis and ops_finding_kpis; anon does not.
--   2. Effective catalog: both views declare security_invoker = true.
--   3. anon is denied SELECT on v_home_dashboard_kpis (insufficient_privilege).
--   4. authenticated + valid JWT can SELECT v_home_dashboard_kpis without error.
--   5. service_role can SELECT v_home_dashboard_kpis without error.
--   6. anon is denied SELECT on ops_finding_kpis (insufficient_privilege).
--   7. authenticated + valid JWT can SELECT ops_finding_kpis without error.
--   8. service_role can SELECT ops_finding_kpis without error.
--
-- Pattern: SET LOCAL ROLE + set_config('request.jwt.claims', ...) simulate the
-- PostgREST JWT contexts used in production without persisting any data.

begin;

-- ── 1. Catalog grant chain ────────────────────────────────────────────────────
do $$
declare
  v_relopts text;
begin
  -- v_home_dashboard_kpis: authenticated
  if not has_table_privilege('authenticated', 'public.v_home_dashboard_kpis', 'SELECT') then
    raise exception
      'FAIL 1a: authenticated must hold SELECT on public.v_home_dashboard_kpis — '
      'migration 20260616052000_home_dashboard_kpis_grant.sql may not have applied';
  end if;

  -- v_home_dashboard_kpis: service_role
  if not has_table_privilege('service_role', 'public.v_home_dashboard_kpis', 'SELECT') then
    raise exception
      'FAIL 1b: service_role must hold SELECT on public.v_home_dashboard_kpis';
  end if;

  -- v_home_dashboard_kpis: anon denied
  if has_table_privilege('anon', 'public.v_home_dashboard_kpis', 'SELECT') then
    raise exception
      'FAIL 1c: anon must not hold SELECT on public.v_home_dashboard_kpis — '
      'revoke all ... from anon in the grant migration may not have applied';
  end if;

  -- ops_finding_kpis: authenticated
  if not has_table_privilege('authenticated', 'public.ops_finding_kpis', 'SELECT') then
    raise exception
      'FAIL 1d: authenticated must hold SELECT on public.ops_finding_kpis — '
      'migration 20260616052000_home_dashboard_kpis_grant.sql may not have applied';
  end if;

  -- ops_finding_kpis: service_role
  if not has_table_privilege('service_role', 'public.ops_finding_kpis', 'SELECT') then
    raise exception
      'FAIL 1e: service_role must hold SELECT on public.ops_finding_kpis';
  end if;

  -- ops_finding_kpis: anon denied
  if has_table_privilege('anon', 'public.ops_finding_kpis', 'SELECT') then
    raise exception
      'FAIL 1f: anon must not hold SELECT on public.ops_finding_kpis — '
      'revoke all ... from anon in the grant migration may not have applied';
  end if;

  raise notice 'PASS 1: catalog grant chain correct for v_home_dashboard_kpis and ops_finding_kpis';
end;
$$;

-- ── 2. Both views must declare security_invoker = true ────────────────────────
do $$
declare
  v_relopts text;
begin
  select c.reloptions::text
    into v_relopts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'v_home_dashboard_kpis';

  if coalesce(v_relopts, '') not like '%security_invoker=true%' then
    raise exception
      'FAIL 2a: v_home_dashboard_kpis must declare security_invoker = true '
      '(expected to be set by migration 20260607183000_set_security_invoker_on_exposed_views.sql); '
      'current reloptions: %', coalesce(v_relopts, '(null)');
  end if;

  select c.reloptions::text
    into v_relopts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'ops_finding_kpis';

  if coalesce(v_relopts, '') not like '%security_invoker=true%' then
    raise exception
      'FAIL 2b: ops_finding_kpis must declare security_invoker = true '
      '(expected from WITH (security_invoker = true) in 20260607170000_ops_factory_persistence.sql); '
      'current reloptions: %', coalesce(v_relopts, '(null)');
  end if;

  raise notice 'PASS 2: security_invoker = true on both v_home_dashboard_kpis and ops_finding_kpis';
end;
$$;

-- ── 3. anon denied SELECT on v_home_dashboard_kpis ───────────────────────────
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_home_dashboard_kpis;
    raise exception
      'FAIL 3: anon SELECT on v_home_dashboard_kpis succeeded — '
      'revoke in 20260616052000_home_dashboard_kpis_grant.sql must not have applied';
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 3: unexpected SQLSTATE % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 3: anon should receive 42501 for v_home_dashboard_kpis';
  end if;

  raise notice 'PASS 3: anon denied SELECT on v_home_dashboard_kpis (42501)';
end;
$$;

reset role;

-- ── 4. authenticated + valid JWT can SELECT v_home_dashboard_kpis ─────────────
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row_count int;
begin
  begin
    select count(*) into v_row_count from public.v_home_dashboard_kpis;
  exception
    when others then
      raise exception
        'FAIL 4: authenticated SELECT on v_home_dashboard_kpis raised % "%"',
        sqlstate, sqlerrm;
  end;

  raise notice 'PASS 4: authenticated can SELECT v_home_dashboard_kpis (% row(s))', v_row_count;
end;
$$;

reset role;

-- ── 5. service_role can SELECT v_home_dashboard_kpis ─────────────────────────
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_row_count int;
begin
  begin
    select count(*) into v_row_count from public.v_home_dashboard_kpis;
  exception
    when others then
      raise exception
        'FAIL 5: service_role SELECT on v_home_dashboard_kpis raised % "%"',
        sqlstate, sqlerrm;
  end;

  raise notice 'PASS 5: service_role can SELECT v_home_dashboard_kpis (% row(s))', v_row_count;
end;
$$;

reset role;

-- ── 6. anon denied SELECT on ops_finding_kpis ────────────────────────────────
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_dummy from public.ops_finding_kpis;
    raise exception
      'FAIL 6: anon SELECT on ops_finding_kpis succeeded — '
      'revoke in 20260616052000_home_dashboard_kpis_grant.sql must not have applied';
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 6: unexpected SQLSTATE % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 6: anon should receive 42501 for ops_finding_kpis';
  end if;

  raise notice 'PASS 6: anon denied SELECT on ops_finding_kpis (42501)';
end;
$$;

reset role;

-- ── 7. authenticated + valid JWT can SELECT ops_finding_kpis ─────────────────
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row_count int;
begin
  begin
    select count(*) into v_row_count from public.ops_finding_kpis;
  exception
    when others then
      raise exception
        'FAIL 7: authenticated SELECT on ops_finding_kpis raised % "%"',
        sqlstate, sqlerrm;
  end;

  raise notice 'PASS 7: authenticated can SELECT ops_finding_kpis (% row(s))', v_row_count;
end;
$$;

reset role;

-- ── 8. service_role can SELECT ops_finding_kpis ──────────────────────────────
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_row_count int;
begin
  begin
    select count(*) into v_row_count from public.ops_finding_kpis;
  exception
    when others then
      raise exception
        'FAIL 8: service_role SELECT on ops_finding_kpis raised % "%"',
        sqlstate, sqlerrm;
  end;

  raise notice 'PASS 8: service_role can SELECT ops_finding_kpis (% row(s))', v_row_count;
end;
$$;

reset role;

rollback;
