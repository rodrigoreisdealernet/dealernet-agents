-- Behavioral RLS access-contract checks for rerent_unit_status_log and
-- v_rerent_unit_current_status
-- (migration 20260613140000_rerent_unit_shared_status.sql).
--
-- Asserts the GRANT → RLS → security_invoker chain behaves correctly for
-- all role/tenant combinations:
--   authenticated + admin          — same-tenant reads; vendor_ref visible; INSERT allowed
--   authenticated + branch_manager — same-tenant reads; vendor_ref visible; INSERT allowed
--   authenticated + field_operator — same-tenant reads; vendor_ref masked;  INSERT allowed
--   authenticated + read_only      — same-tenant reads; vendor_ref masked;  INSERT denied
--   authenticated + cross-tenant   — rows filtered to 0; INSERT denied
--   service_role                   — RLS bypassed; can INSERT any tenant; sees all rows
--
-- These assertions would fail if:
--   * security_invoker is missing on the view (owner bypasses base-table RLS)
--   * the anon REVOKE is missing or ineffective
--   * rerent_status_log_tenant_select policy leaks cross-tenant rows
--   * rerent_status_log_operator_insert policy allows read_only or cross-tenant writes
--   * the CASE expression masking vendor_ref in the view is removed or broken
--
-- Pattern: single BEGIN/ROLLBACK block with SET LOCAL ROLE + set_config() to
-- simulate PostgREST JWT contexts without persisting data.

begin;

-- ── Fixture setup (superuser context) ─────────────────────────────────────
-- Two log entries in separate tenants (alpha / beta) so cross-tenant isolation
-- and vendor_ref masking can be asserted without conflicting with prod data.
do $$
declare
  v_line_alpha constant uuid := 'ee1e0000-0000-0000-0001-000000000001';
  v_line_beta  constant uuid := 'ee1e0000-0000-0000-0001-000000000002';
begin
  insert into public.rerent_unit_status_log
    (order_line_id, status_key, audience, changed_by, vendor_ref, tenant, changed_at)
  values
    (v_line_alpha, 'on_rent',    'internal', 'rls-fixture', 'PO-ALPHA-001', 'alpha', now() - interval '1 hour'),
    (v_line_beta,  'dispatched', 'internal', 'rls-fixture', 'PO-BETA-001',  'beta',  now() - interval '1 hour');
end;
$$;

-- ── 1. v_rerent_unit_current_status declares security_invoker = true ──────
-- Without security_invoker the view body executes as its owner (typically a
-- superuser), bypassing base-table RLS for any calling role.
do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'v_rerent_unit_current_status';

  if not v_has_invoker then
    raise exception
      'FAIL 1: v_rerent_unit_current_status must declare security_invoker = true '
      '(without it the view owner bypasses base-table RLS)';
  end if;

  raise notice 'PASS 1: v_rerent_unit_current_status has security_invoker = true';
end;
$$;

-- ── 2. Grant structure: authenticated has SELECT + INSERT; anon excluded ──
do $$
begin
  -- Base table: authenticated SELECT + INSERT
  if not has_table_privilege('authenticated', 'public.rerent_unit_status_log', 'SELECT') then
    raise exception
      'FAIL 2a: authenticated does not have SELECT on rerent_unit_status_log';
  end if;

  if not has_table_privilege('authenticated', 'public.rerent_unit_status_log', 'INSERT') then
    raise exception
      'FAIL 2b: authenticated does not have INSERT on rerent_unit_status_log';
  end if;

  if not has_table_privilege('service_role', 'public.rerent_unit_status_log', 'INSERT') then
    raise exception
      'FAIL 2c: service_role does not have INSERT on rerent_unit_status_log';
  end if;

  if has_table_privilege('anon', 'public.rerent_unit_status_log', 'SELECT') then
    raise exception
      'FAIL 2d: anon must not have SELECT on rerent_unit_status_log — REVOKE is not effective';
  end if;

  -- View: authenticated and service_role must have SELECT; anon must not
  if not has_table_privilege('authenticated', 'public.v_rerent_unit_current_status', 'SELECT') then
    raise exception
      'FAIL 2e: authenticated does not have SELECT on v_rerent_unit_current_status';
  end if;

  if not has_table_privilege('service_role', 'public.v_rerent_unit_current_status', 'SELECT') then
    raise exception
      'FAIL 2f: service_role does not have SELECT on v_rerent_unit_current_status';
  end if;

  if has_table_privilege('anon', 'public.v_rerent_unit_current_status', 'SELECT') then
    raise exception
      'FAIL 2g: anon must not have SELECT on v_rerent_unit_current_status — REVOKE is not effective';
  end if;

  raise notice
    'PASS 2: grant structure correct (authenticated SELECT+INSERT on log; authenticated+service_role SELECT on view; anon excluded)';
end;
$$;

-- ── 3. Same-tenant admin reads own rows; cross-tenant rows are filtered ───
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"admin","tenant":"alpha"}}',
  true
);

do $$
declare
  v_line_alpha constant uuid := 'ee1e0000-0000-0000-0001-000000000001';
  v_count      int;
begin
  select count(*) into v_count
    from public.rerent_unit_status_log
   where order_line_id = v_line_alpha;

  if v_count <> 1 then
    raise exception
      'FAIL 3a: alpha-tenant admin should see 1 log row for alpha line; got %', v_count;
  end if;

  select count(*) into v_count
    from public.rerent_unit_status_log
   where tenant = 'beta';

  if v_count <> 0 then
    raise exception
      'FAIL 3b: alpha-tenant admin should see 0 beta-tenant rows; got %', v_count;
  end if;

  raise notice 'PASS 3: same-tenant admin reads own rows; cross-tenant rows filtered (RLS SELECT policy)';
end;
$$;

reset role;

-- ── 4. Cross-tenant user sees no rows from other tenants ──────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"bb000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"admin","tenant":"beta"}}',
  true
);

do $$
declare
  v_line_alpha constant uuid := 'ee1e0000-0000-0000-0001-000000000001';
  v_count      int;
begin
  select count(*) into v_count
    from public.rerent_unit_status_log
   where order_line_id = v_line_alpha;

  if v_count <> 0 then
    raise exception
      'FAIL 4: beta-tenant admin must see 0 alpha-tenant rows; got %', v_count;
  end if;

  raise notice 'PASS 4: cross-tenant user cannot read rows from another tenant';
end;
$$;

reset role;

-- ── 5. vendor_ref visible to admin via v_rerent_unit_current_status ───────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"admin","tenant":"alpha"}}',
  true
);

do $$
declare
  v_line_alpha constant uuid := 'ee1e0000-0000-0000-0001-000000000001';
  v_vendor_ref text;
begin
  select vendor_ref into v_vendor_ref
    from public.v_rerent_unit_current_status
   where order_line_id = v_line_alpha;

  if v_vendor_ref is null then
    raise exception
      'FAIL 5: admin should see vendor_ref in v_rerent_unit_current_status; got NULL';
  end if;

  raise notice 'PASS 5: admin sees vendor_ref = % via v_rerent_unit_current_status', v_vendor_ref;
end;
$$;

reset role;

-- ── 6. vendor_ref visible to branch_manager ───────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000002","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"alpha"}}',
  true
);

do $$
declare
  v_line_alpha constant uuid := 'ee1e0000-0000-0000-0001-000000000001';
  v_vendor_ref text;
begin
  select vendor_ref into v_vendor_ref
    from public.v_rerent_unit_current_status
   where order_line_id = v_line_alpha;

  if v_vendor_ref is null then
    raise exception
      'FAIL 6: branch_manager should see vendor_ref in v_rerent_unit_current_status; got NULL';
  end if;

  raise notice 'PASS 6: branch_manager sees vendor_ref = % via v_rerent_unit_current_status', v_vendor_ref;
end;
$$;

reset role;

-- ── 7. vendor_ref masked to NULL for field_operator ───────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000003","role":"authenticated","app_metadata":{"role":"field_operator","tenant":"alpha"}}',
  true
);

do $$
declare
  v_line_alpha constant uuid := 'ee1e0000-0000-0000-0001-000000000001';
  v_vendor_ref text;
  v_count      int;
begin
  select count(*) into v_count
    from public.v_rerent_unit_current_status
   where order_line_id = v_line_alpha;

  if v_count <> 1 then
    raise exception
      'FAIL 7a: field_operator should see 1 current-status row for alpha line; got %', v_count;
  end if;

  select vendor_ref into v_vendor_ref
    from public.v_rerent_unit_current_status
   where order_line_id = v_line_alpha;

  if v_vendor_ref is not null then
    raise exception
      'FAIL 7b: vendor_ref must be NULL for field_operator; got ''%''', v_vendor_ref;
  end if;

  raise notice 'PASS 7: field_operator sees row; vendor_ref masked (NULL)';
end;
$$;

reset role;

-- ── 8. vendor_ref masked to NULL for read_only ────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000004","role":"authenticated","app_metadata":{"role":"read_only","tenant":"alpha"}}',
  true
);

do $$
declare
  v_line_alpha constant uuid := 'ee1e0000-0000-0000-0001-000000000001';
  v_vendor_ref text;
begin
  select vendor_ref into v_vendor_ref
    from public.v_rerent_unit_current_status
   where order_line_id = v_line_alpha;

  if v_vendor_ref is not null then
    raise exception
      'FAIL 8: vendor_ref must be NULL for read_only caller; got ''%''', v_vendor_ref;
  end if;

  raise notice 'PASS 8: read_only caller sees row; vendor_ref masked (NULL)';
end;
$$;

reset role;

-- ── 9. admin can INSERT for own tenant ────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"admin","tenant":"alpha"}}',
  true
);

do $$
declare
  v_new_line constant uuid := 'ee1e0000-0000-0000-0002-000000000001';
begin
  begin
    insert into public.rerent_unit_status_log
      (order_line_id, status_key, audience, changed_by, tenant)
    values
      (v_new_line, 'requested', 'internal', 'rls-test-admin', 'alpha');
  exception
    when others then
      raise exception
        'FAIL 9: admin INSERT for own tenant should succeed; got % "%"', sqlstate, sqlerrm;
  end;

  raise notice 'PASS 9: admin can INSERT for own tenant';
end;
$$;

reset role;

-- ── 10. branch_manager can INSERT for own tenant ──────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000002","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"alpha"}}',
  true
);

do $$
declare
  v_new_line constant uuid := 'ee1e0000-0000-0000-0002-000000000002';
begin
  begin
    insert into public.rerent_unit_status_log
      (order_line_id, status_key, audience, changed_by, tenant)
    values
      (v_new_line, 'awarded', 'internal', 'rls-test-manager', 'alpha');
  exception
    when others then
      raise exception
        'FAIL 10: branch_manager INSERT for own tenant should succeed; got % "%"', sqlstate, sqlerrm;
  end;

  raise notice 'PASS 10: branch_manager can INSERT for own tenant';
end;
$$;

reset role;

-- ── 11. field_operator can INSERT for own tenant ──────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000003","role":"authenticated","app_metadata":{"role":"field_operator","tenant":"alpha"}}',
  true
);

do $$
declare
  v_new_line constant uuid := 'ee1e0000-0000-0000-0002-000000000003';
begin
  begin
    insert into public.rerent_unit_status_log
      (order_line_id, status_key, audience, changed_by, tenant)
    values
      (v_new_line, 'dispatched', 'internal', 'rls-test-operator', 'alpha');
  exception
    when others then
      raise exception
        'FAIL 11: field_operator INSERT for own tenant should succeed; got % "%"', sqlstate, sqlerrm;
  end;

  raise notice 'PASS 11: field_operator can INSERT for own tenant';
end;
$$;

reset role;

-- ── 12. read_only INSERT is denied ────────────────────────────────────────
-- The operator_insert policy requires get_my_role() IN (admin, branch_manager,
-- field_operator); read_only fails the WITH CHECK and raises 42501.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000004","role":"authenticated","app_metadata":{"role":"read_only","tenant":"alpha"}}',
  true
);

do $$
declare
  v_new_line constant uuid := 'ee1e0000-0000-0000-0002-000000000004';
  v_caught   bool;
begin
  v_caught := false;
  begin
    insert into public.rerent_unit_status_log
      (order_line_id, status_key, audience, changed_by, tenant)
    values
      (v_new_line, 'requested', 'internal', 'rls-test-readonly', 'alpha');
    raise exception
      'FAIL 12: read_only INSERT should be denied; succeeded instead';
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%row-level security%' or sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 12: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception
      'FAIL 12: read_only INSERT should raise insufficient_privilege (42501)';
  end if;

  raise notice 'PASS 12: read_only INSERT correctly denied (42501)';
end;
$$;

reset role;

-- ── 13. Cross-tenant INSERT is denied ────────────────────────────────────
-- The operator_insert WITH CHECK requires tenant = get_my_tenant(); an alpha
-- caller writing tenant = 'beta' fails the check.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"admin","tenant":"alpha"}}',
  true
);

do $$
declare
  v_new_line constant uuid := 'ee1e0000-0000-0000-0002-000000000005';
  v_caught   bool;
begin
  v_caught := false;
  begin
    insert into public.rerent_unit_status_log
      (order_line_id, status_key, audience, changed_by, tenant)
    values
      (v_new_line, 'requested', 'internal', 'rls-test-cross', 'beta');
    raise exception
      'FAIL 13: cross-tenant INSERT (alpha user → beta row) should be denied; succeeded instead';
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%row-level security%' or sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 13: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception
      'FAIL 13: cross-tenant INSERT should raise insufficient_privilege (42501)';
  end if;

  raise notice 'PASS 13: cross-tenant INSERT correctly denied (42501)';
end;
$$;

reset role;

-- ── 14. service_role can INSERT for any tenant (RLS bypass policy) ────────
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

do $$
declare
  v_new_line constant uuid := 'ee1e0000-0000-0000-0002-000000000006';
begin
  begin
    insert into public.rerent_unit_status_log
      (order_line_id, status_key, audience, changed_by, tenant)
    values
      (v_new_line, 'returned', 'internal', 'service-role-test', 'gamma');
  exception
    when others then
      raise exception
        'FAIL 14: service_role INSERT for any tenant should succeed; got % "%"', sqlstate, sqlerrm;
  end;

  raise notice 'PASS 14: service_role can INSERT for any tenant (RLS bypass)';
end;
$$;

reset role;

-- ── 15. service_role can SELECT across all tenants ────────────────────────
-- The service_role policy (for all ... using (true)) bypasses the
-- tenant-scoped SELECT policy; the role must see rows from both fixture tenants.
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

do $$
declare
  v_alpha_count int;
  v_beta_count  int;
begin
  select count(*) into v_alpha_count
    from public.rerent_unit_status_log
   where tenant = 'alpha';

  select count(*) into v_beta_count
    from public.rerent_unit_status_log
   where tenant = 'beta';

  if v_alpha_count < 1 then
    raise exception
      'FAIL 15a: service_role should see alpha-tenant rows; got count=%', v_alpha_count;
  end if;

  if v_beta_count < 1 then
    raise exception
      'FAIL 15b: service_role should see beta-tenant rows; got count=%', v_beta_count;
  end if;

  raise notice 'PASS 15: service_role sees all tenant rows (alpha=%, beta=%)', v_alpha_count, v_beta_count;
end;
$$;

reset role;

rollback;
