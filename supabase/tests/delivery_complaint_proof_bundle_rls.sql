-- Behavioral SQL access-contract tests for the delivery complaint proof bundle
-- (migration 20260617130000_delivery_complaint_proof_bundle.sql).
--
-- Assertions:
--   1. Structural checks: RLS enabled on delivery_complaint_cases;
--      v_complaint_case_review_bundle declares security_invoker = true.
--   2. Grant chain: authenticated has SELECT (no INSERT/DELETE) on table;
--      service_role has ALL; anon has nothing on table or view; authenticated
--      and service_role have EXECUTE on both RPCs; anon has no EXECUTE on
--      either RPC.
--   3. anon denied SELECT on table and view (no grant).
--   4. read_only authenticated: zero rows from table and view (RLS silent deny);
--      upsert_complaint_case and get_complaint_case raise role-check exception.
--   5. field_operator authenticated: zero rows from table (RLS silent deny);
--      both RPCs raise role-check exception.
--   6. branch_manager authenticated: sees seeded rows from table and view;
--      upsert_complaint_case succeeds (idempotent update on open thread);
--      get_complaint_case succeeds and returns evidence bundle.
--   7. admin authenticated: sees seeded rows from table and view.
--
-- Pattern: single transaction; SET LOCAL ROLE + set_config('request.jwt.claims')
-- simulate PostgREST JWT contexts without persisting any data.

begin;

-- Mirror the auth.jwt() → request.jwt.claims bridge used by production PostgREST.
-- Wrapped in a guard so it degrades gracefully on a real Supabase stack where
-- supabase_auth_admin owns auth.jwt().
do $guard$
begin
  execute $f$
    create or replace function auth.jwt() returns jsonb language sql as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $$
  $f$;
exception
  when insufficient_privilege then null;
end;
$guard$;

-- ── 1. Structural checks ─────────────────────────────────────────────────────

do $$
declare
  v_has_rls     bool;
  v_has_invoker bool;
begin
  select c.relrowsecurity
    into v_has_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'delivery_complaint_cases';

  if not found or not coalesce(v_has_rls, false) then
    raise exception 'FAIL 1a: RLS must be enabled on public.delivery_complaint_cases';
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'v_complaint_case_review_bundle';

  if not v_has_invoker then
    raise exception
      'FAIL 1b: v_complaint_case_review_bundle must declare security_invoker = true '
      '(without it the view owner bypasses base-table RLS)';
  end if;

  raise notice 'PASS 1: RLS enabled on delivery_complaint_cases; '
               'v_complaint_case_review_bundle declares security_invoker = true';
end;
$$;

-- ── 2. Grant chain ───────────────────────────────────────────────────────────

do $$
begin
  -- Table: authenticated SELECT only (writes go through SECURITY DEFINER RPCs)
  if not has_table_privilege('authenticated', 'public.delivery_complaint_cases', 'SELECT') then
    raise exception 'FAIL 2a: authenticated must have SELECT on delivery_complaint_cases';
  end if;
  if has_table_privilege('authenticated', 'public.delivery_complaint_cases', 'INSERT') then
    raise exception 'FAIL 2b: authenticated must not have direct INSERT on delivery_complaint_cases';
  end if;
  if has_table_privilege('authenticated', 'public.delivery_complaint_cases', 'DELETE') then
    raise exception 'FAIL 2c: authenticated must not have DELETE on delivery_complaint_cases';
  end if;

  -- service_role: full access
  if not has_table_privilege('service_role', 'public.delivery_complaint_cases', 'SELECT') then
    raise exception 'FAIL 2d: service_role must have SELECT on delivery_complaint_cases';
  end if;
  if not has_table_privilege('service_role', 'public.delivery_complaint_cases', 'INSERT') then
    raise exception 'FAIL 2e: service_role must have INSERT on delivery_complaint_cases';
  end if;

  -- anon: no table access
  if has_table_privilege('anon', 'public.delivery_complaint_cases', 'SELECT') then
    raise exception 'FAIL 2f: anon must not have SELECT on delivery_complaint_cases';
  end if;

  -- View: authenticated and service_role SELECT; anon denied
  if not has_table_privilege('authenticated', 'public.v_complaint_case_review_bundle', 'SELECT') then
    raise exception 'FAIL 2g: authenticated must have SELECT on v_complaint_case_review_bundle';
  end if;
  if has_table_privilege('anon', 'public.v_complaint_case_review_bundle', 'SELECT') then
    raise exception 'FAIL 2h: anon must not have SELECT on v_complaint_case_review_bundle';
  end if;

  -- upsert_complaint_case(uuid,text,text,jsonb,text,text,text): authenticated yes; anon no
  if not has_function_privilege(
      'authenticated',
      'public.upsert_complaint_case(uuid,text,text,jsonb,text,text,text)',
      'EXECUTE') then
    raise exception 'FAIL 2i: authenticated must have EXECUTE on upsert_complaint_case';
  end if;
  if has_function_privilege(
      'anon',
      'public.upsert_complaint_case(uuid,text,text,jsonb,text,text,text)',
      'EXECUTE') then
    raise exception 'FAIL 2j: anon must not have EXECUTE on upsert_complaint_case';
  end if;

  -- get_complaint_case(uuid): authenticated and service_role yes; anon no
  if not has_function_privilege('authenticated', 'public.get_complaint_case(uuid)', 'EXECUTE') then
    raise exception 'FAIL 2k: authenticated must have EXECUTE on get_complaint_case(uuid)';
  end if;
  if not has_function_privilege('service_role', 'public.get_complaint_case(uuid)', 'EXECUTE') then
    raise exception 'FAIL 2l: service_role must have EXECUTE on get_complaint_case(uuid)';
  end if;
  if has_function_privilege('anon', 'public.get_complaint_case(uuid)', 'EXECUTE') then
    raise exception 'FAIL 2m: anon must not have EXECUTE on get_complaint_case(uuid)';
  end if;

  raise notice 'PASS 2: grant chain verified for table, view, and both RPCs';
end;
$$;

-- ── Fixture: route + stop + complaint case seeded as superuser ───────────────
-- Seeded here (not via the RPC) so later sections test RPC and direct-read paths
-- independently.

do $$
declare
  v_route_id uuid;
  v_stop_id  uuid;
  v_case_id  uuid;
begin
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (gen_random_uuid(), current_date, 'in_progress')
  returning id into v_route_id;

  insert into public.route_stops (route_id, sequence_order, stop_type, address, customer_name)
  values (v_route_id, 1, 'delivery', '99 Complaint Ave', 'RLS Test Customer')
  returning id into v_stop_id;

  insert into public.delivery_complaint_cases (stop_id, complaint_type, evidence_status)
  values (v_stop_id, 'late_delivery', 'packaged')
  returning id into v_case_id;

  create temporary table complaint_rls_state (key text primary key, value text)
    on commit drop;
  execute 'grant select on complaint_rls_state to anon, authenticated';
  insert into complaint_rls_state values
    ('stop_id',  v_stop_id::text),
    ('case_id',  v_case_id::text),
    ('route_id', v_route_id::text);
end;
$$;

-- ── 3. anon denied SELECT on table and view ──────────────────────────────────

set local role anon;

do $$
declare
  v_caught bool;
begin
  -- 3a. Table
  v_caught := false;
  begin
    perform 1 from public.delivery_complaint_cases limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 3a: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 3a: anon must be denied SELECT on delivery_complaint_cases';
  end if;

  -- 3b. View
  v_caught := false;
  begin
    perform 1 from public.v_complaint_case_review_bundle limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 3b: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 3b: anon must be denied SELECT on v_complaint_case_review_bundle';
  end if;

  raise notice 'PASS 3: anon denied SELECT on table and view';
end;
$$;

reset role;

-- ── 4. read_only authenticated: RLS silent deny + RPCs raise role-check ──────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-dcc000000001","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_count   int;
  v_caught  bool;
  v_stop_id uuid;
  v_case_id uuid;
begin
  select value::uuid into v_stop_id from complaint_rls_state where key = 'stop_id';
  select value::uuid into v_case_id from complaint_rls_state where key = 'case_id';

  -- 4a. Direct table SELECT returns 0 rows: RLS USING clause is false for read_only
  select count(*) into v_count from public.delivery_complaint_cases;
  if v_count <> 0 then
    raise exception
      'FAIL 4a: read_only authenticated must see 0 rows from delivery_complaint_cases '
      '(RLS silent deny); got %', v_count;
  end if;

  -- 4b. View SELECT returns 0 rows: security_invoker propagates RLS into the view
  select count(*) into v_count from public.v_complaint_case_review_bundle;
  if v_count <> 0 then
    raise exception
      'FAIL 4b: read_only authenticated must see 0 rows from v_complaint_case_review_bundle '
      '(security_invoker + RLS); got %', v_count;
  end if;

  raise notice 'PASS 4a+4b: read_only authenticated sees 0 rows from table and view';

  -- 4c. upsert_complaint_case denied by in-function role check
  v_caught := false;
  begin
    perform public.upsert_complaint_case(
      p_stop_id        => v_stop_id,
      p_complaint_type => 'late_delivery'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%requires%' or sqlerrm ilike '%branch_manager%'
          or sqlerrm ilike '%admin%' then
        v_caught := true;
      else
        raise exception 'FAIL 4c: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4c: read_only authenticated not denied upsert_complaint_case';
  end if;

  -- 4d. get_complaint_case denied by in-function role check
  v_caught := false;
  begin
    perform public.get_complaint_case(v_case_id);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%requires%' or sqlerrm ilike '%branch_manager%'
          or sqlerrm ilike '%admin%' then
        v_caught := true;
      else
        raise exception 'FAIL 4d: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4d: read_only authenticated not denied get_complaint_case';
  end if;

  raise notice 'PASS 4c+4d: read_only authenticated denied upsert_complaint_case and get_complaint_case';
end;
$$;

reset role;

-- ── 5. field_operator authenticated: RLS silent deny + RPCs denied ───────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-dcc000000002","app_metadata":{"role":"field_operator"}}',
  true
);

do $$
declare
  v_count   int;
  v_caught  bool;
  v_stop_id uuid;
  v_case_id uuid;
begin
  select value::uuid into v_stop_id from complaint_rls_state where key = 'stop_id';
  select value::uuid into v_case_id from complaint_rls_state where key = 'case_id';

  -- 5a. Direct table SELECT returns 0 rows
  select count(*) into v_count from public.delivery_complaint_cases;
  if v_count <> 0 then
    raise exception
      'FAIL 5a: field_operator authenticated must see 0 rows from delivery_complaint_cases '
      '(RLS silent deny); got %', v_count;
  end if;

  -- 5b. upsert_complaint_case denied
  v_caught := false;
  begin
    perform public.upsert_complaint_case(
      p_stop_id        => v_stop_id,
      p_complaint_type => 'late_delivery'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%requires%' or sqlerrm ilike '%branch_manager%'
          or sqlerrm ilike '%admin%' then
        v_caught := true;
      else
        raise exception 'FAIL 5b: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5b: field_operator authenticated not denied upsert_complaint_case';
  end if;

  -- 5c. get_complaint_case denied
  v_caught := false;
  begin
    perform public.get_complaint_case(v_case_id);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%requires%' or sqlerrm ilike '%branch_manager%'
          or sqlerrm ilike '%admin%' then
        v_caught := true;
      else
        raise exception 'FAIL 5c: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5c: field_operator authenticated not denied get_complaint_case';
  end if;

  raise notice 'PASS 5: field_operator authenticated sees 0 rows; both RPCs denied';
end;
$$;

reset role;

-- ── 6. branch_manager authenticated: table/view read and both RPCs allowed ───

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-dcc000000003","app_metadata":{"role":"branch_manager"}}',
  true
);

do $$
declare
  v_count     int;
  v_case_id   uuid;
  v_stop_id   uuid;
  v_upserted  uuid;
  v_result    json;
begin
  select value::uuid into v_case_id from complaint_rls_state where key = 'case_id';
  select value::uuid into v_stop_id from complaint_rls_state where key = 'stop_id';

  -- 6a. Direct table SELECT returns seeded row
  select count(*) into v_count
    from public.delivery_complaint_cases
   where id = v_case_id;
  if v_count <> 1 then
    raise exception
      'FAIL 6a: branch_manager must see seeded row in delivery_complaint_cases; count=%',
      v_count;
  end if;

  -- 6b. View SELECT returns seeded row
  select count(*) into v_count
    from public.v_complaint_case_review_bundle
   where case_id = v_case_id;
  if v_count <> 1 then
    raise exception
      'FAIL 6b: branch_manager must see seeded case in v_complaint_case_review_bundle; count=%',
      v_count;
  end if;

  -- 6c. upsert_complaint_case succeeds; same open thread returns same case_id
  begin
    v_upserted := public.upsert_complaint_case(
      p_stop_id         => v_stop_id,
      p_complaint_type  => 'late_delivery',
      p_evidence_status => 'ambiguous'
    );
  exception when others then
    raise exception
      'FAIL 6c: branch_manager upsert_complaint_case raised unexpected error: % "%"',
      sqlstate, sqlerrm;
  end;
  if v_upserted is null then
    raise exception 'FAIL 6c: upsert_complaint_case returned null for branch_manager';
  end if;
  if v_upserted <> v_case_id then
    raise exception
      'FAIL 6c: idempotent upsert returned different id for same open thread; '
      'expected % got %', v_case_id, v_upserted;
  end if;

  -- 6d. get_complaint_case returns full bundle including requires_human_review
  begin
    v_result := public.get_complaint_case(v_case_id);
  exception when others then
    raise exception
      'FAIL 6d: branch_manager get_complaint_case raised unexpected error: % "%"',
      sqlstate, sqlerrm;
  end;
  if v_result is null then
    raise exception 'FAIL 6d: get_complaint_case returned null for branch_manager';
  end if;
  if coalesce((v_result->>'requires_human_review')::boolean, false) is not true then
    raise exception
      'FAIL 6d: get_complaint_case result must carry requires_human_review = true '
      '(field was null or false)';
  end if;
  if v_result->'stop' is null then
    raise exception 'FAIL 6d: get_complaint_case result must include stop context';
  end if;

  raise notice 'PASS 6: branch_manager allowed table read, view read, upsert, and get RPCs';
end;
$$;

reset role;

-- ── 7. admin authenticated: table and view read allowed ──────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-dcc000000004","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_count   int;
  v_case_id uuid;
begin
  select value::uuid into v_case_id from complaint_rls_state where key = 'case_id';

  select count(*) into v_count
    from public.delivery_complaint_cases
   where id = v_case_id;
  if v_count <> 1 then
    raise exception
      'FAIL 7a: admin must see seeded row in delivery_complaint_cases; count=%', v_count;
  end if;

  select count(*) into v_count
    from public.v_complaint_case_review_bundle
   where case_id = v_case_id;
  if v_count <> 1 then
    raise exception
      'FAIL 7b: admin must see seeded case in v_complaint_case_review_bundle; count=%', v_count;
  end if;

  raise notice 'PASS 7: admin authenticated allowed table and view reads';
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

rollback;
