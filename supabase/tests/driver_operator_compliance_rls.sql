-- Behavioral RLS tests for 20260619020000_driver_operator_compliance_views.sql
--
-- Covers all four compliance tables and their four exception views:
--   driver_qualification_records  → v_driver_qualification_exceptions
--   hos_exception_log             → v_hos_exceptions_current
--   operator_cert_records         → v_operator_cert_exceptions
--   personnel_training_records    → v_training_compliance_exceptions
--
-- For each table/view the suite asserts:
--   1. Structural: RLS enabled and privilege grants are correct.
--   2. security_invoker = true on every view.
--   3. service_role write path: INSERT / UPDATE / DELETE succeeds.
--   4. authenticated (admin, tenant-a): reads through views; only tenant-a rows visible.
--   5. authenticated (admin, tenant-b): cross-tenant isolation; sees only tenant-b rows.
--   6. authenticated INSERT denied (SELECT-only grant on base tables).
--   7. anon denied SELECT on every view.
--
-- Pattern: all assertions run inside one transaction; a ROLLBACK at the end
-- leaves the database unmodified.  SET LOCAL ROLE + set_config('request.jwt.claims')
-- simulate the PostgREST JWT context used in production.

begin;

-- ── 1. Structural checks ──────────────────────────────────────────────────────

do $$
declare
  v_table text;
  v_tables constant text[] := array[
    'driver_qualification_records',
    'hos_exception_log',
    'operator_cert_records',
    'personnel_training_records'
  ];
begin
  foreach v_table in array v_tables loop
    -- RLS must be enabled.
    if not (
      select c.relrowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = v_table
    ) then
      raise exception 'Expected RLS enabled on public.%', v_table;
    end if;

    -- authenticated: SELECT only (no INSERT/UPDATE/DELETE).
    if not has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT') then
      raise exception 'Expected authenticated SELECT on public.%', v_table;
    end if;
    if has_table_privilege('authenticated', format('public.%I', v_table), 'INSERT') then
      raise exception 'Did not expect authenticated INSERT on public.%', v_table;
    end if;
    if has_table_privilege('authenticated', format('public.%I', v_table), 'UPDATE') then
      raise exception 'Did not expect authenticated UPDATE on public.%', v_table;
    end if;
    if has_table_privilege('authenticated', format('public.%I', v_table), 'DELETE') then
      raise exception 'Did not expect authenticated DELETE on public.%', v_table;
    end if;

    -- anon must have no access at all.
    if has_table_privilege('anon', format('public.%I', v_table), 'SELECT') then
      raise exception 'Did not expect anon SELECT on public.%', v_table;
    end if;

    -- service_role must have full DML.
    if not has_table_privilege('service_role', format('public.%I', v_table), 'SELECT') then
      raise exception 'Expected service_role SELECT on public.%', v_table;
    end if;
    if not has_table_privilege('service_role', format('public.%I', v_table), 'INSERT') then
      raise exception 'Expected service_role INSERT on public.%', v_table;
    end if;
    if not has_table_privilege('service_role', format('public.%I', v_table), 'UPDATE') then
      raise exception 'Expected service_role UPDATE on public.%', v_table;
    end if;
    if not has_table_privilege('service_role', format('public.%I', v_table), 'DELETE') then
      raise exception 'Expected service_role DELETE on public.%', v_table;
    end if;

    raise notice 'Structural checks passed for public.%', v_table;
  end loop;
end;
$$;

-- ── 2. security_invoker = true on all four views ──────────────────────────────

do $$
declare
  v_view text;
  v_views constant text[] := array[
    'v_driver_qualification_exceptions',
    'v_hos_exceptions_current',
    'v_operator_cert_exceptions',
    'v_training_compliance_exceptions'
  ];
  v_has_invoker bool;
begin
  foreach v_view in array v_views loop
    select coalesce('security_invoker=true' = any(c.reloptions), false)
      into v_has_invoker
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_view;

    if not v_has_invoker then
      raise exception
        'FAIL: public.% must declare security_invoker = true '
        '(without it the view owner bypasses base-table RLS)', v_view;
    end if;

    -- anon must be denied SELECT on the view.
    if has_table_privilege('anon', format('public.%I', v_view), 'SELECT') then
      raise exception 'Did not expect anon SELECT privilege on public.%', v_view;
    end if;

    -- authenticated and service_role must have SELECT.
    if not has_table_privilege('authenticated', format('public.%I', v_view), 'SELECT') then
      raise exception 'Expected authenticated SELECT on public.%', v_view;
    end if;
    if not has_table_privilege('service_role', format('public.%I', v_view), 'SELECT') then
      raise exception 'Expected service_role SELECT on public.%', v_view;
    end if;

    raise notice 'View checks passed for public.%', v_view;
  end loop;
end;
$$;

-- ── Seed tenants as superuser ─────────────────────────────────────────────────

do $$
begin
  insert into public.tenants (tenant_key, name)
  values ('crq-test-a', 'CRQ Test A'),
         ('crq-test-b', 'CRQ Test B');
end;
$$;

-- ── 3. service_role write path ────────────────────────────────────────────────

set local role service_role;

do $$
declare
  v_tenant_a  uuid;
  v_tenant_b  uuid;
  v_id_a      uuid;
  v_id_b      uuid;
  v_count     int;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'crq-test-a';
  select id into v_tenant_b from public.tenants where tenant_key = 'crq-test-b';

  -- driver_qualification_records ------------------------------------------
  insert into public.driver_qualification_records
    (tenant_id, person_id, person_name, qualification_type, status, expiry_date)
  values (v_tenant_a, gen_random_uuid(), 'Driver A', 'CDL Class A', 'expired', current_date - 1)
  returning id into v_id_a;

  insert into public.driver_qualification_records
    (tenant_id, person_id, person_name, qualification_type, status, expiry_date)
  values (v_tenant_b, gen_random_uuid(), 'Driver B', 'CDL Class B', 'expired', current_date - 1)
  returning id into v_id_b;

  select count(*) into v_count from public.driver_qualification_records;
  if v_count <> 2 then
    raise exception 'service_role INSERT driver_qualification_records: expected 2, found %', v_count;
  end if;

  update public.driver_qualification_records set status = 'suspended' where id = v_id_a;
  select count(*) into v_count
    from public.driver_qualification_records where id = v_id_a and status = 'suspended';
  if v_count <> 1 then
    raise exception 'service_role UPDATE driver_qualification_records: status not updated';
  end if;

  delete from public.driver_qualification_records where id = v_id_b;
  select count(*) into v_count from public.driver_qualification_records;
  if v_count <> 1 then
    raise exception 'service_role DELETE driver_qualification_records: expected 1 after delete, found %', v_count;
  end if;

  -- Restore status for view read tests.
  update public.driver_qualification_records set status = 'expired' where id = v_id_a;

  -- Re-seed tenant-b row so the view read tests have something to isolate.
  insert into public.driver_qualification_records
    (tenant_id, person_id, person_name, qualification_type, status, expiry_date)
  values (v_tenant_b, gen_random_uuid(), 'Driver B', 'CDL Class B', 'expired', current_date - 1);

  raise notice 'driver_qualification_records service_role write path passed';

  -- hos_exception_log -------------------------------------------------------
  insert into public.hos_exception_log
    (tenant_id, person_id, person_name, violation_type, severity)
  values (v_tenant_a, gen_random_uuid(), 'Driver A', '11-hour rule', 'warning')
  returning id into v_id_a;

  insert into public.hos_exception_log
    (tenant_id, person_id, person_name, violation_type, severity)
  values (v_tenant_b, gen_random_uuid(), 'Driver B', '14-hour rule', 'critical')
  returning id into v_id_b;

  select count(*) into v_count from public.hos_exception_log;
  if v_count <> 2 then
    raise exception 'service_role INSERT hos_exception_log: expected 2, found %', v_count;
  end if;

  update public.hos_exception_log set severity = 'critical' where id = v_id_a;
  select count(*) into v_count
    from public.hos_exception_log where id = v_id_a and severity = 'critical';
  if v_count <> 1 then
    raise exception 'service_role UPDATE hos_exception_log: severity not updated';
  end if;

  delete from public.hos_exception_log where id = v_id_b;
  -- Re-seed tenant-b row for isolation tests.
  insert into public.hos_exception_log
    (tenant_id, person_id, person_name, violation_type, severity)
  values (v_tenant_b, gen_random_uuid(), 'Driver B', '14-hour rule', 'critical');

  raise notice 'hos_exception_log service_role write path passed';

  -- operator_cert_records ---------------------------------------------------
  insert into public.operator_cert_records
    (tenant_id, person_id, person_name, certification_type, status, expiry_date)
  values (v_tenant_a, gen_random_uuid(), 'Operator A', 'Forklift', 'expired', current_date - 1)
  returning id into v_id_a;

  insert into public.operator_cert_records
    (tenant_id, person_id, person_name, certification_type, status, expiry_date)
  values (v_tenant_b, gen_random_uuid(), 'Operator B', 'Aerial Work Platform', 'expired', current_date - 1)
  returning id into v_id_b;

  select count(*) into v_count from public.operator_cert_records;
  if v_count <> 2 then
    raise exception 'service_role INSERT operator_cert_records: expected 2, found %', v_count;
  end if;

  update public.operator_cert_records set status = 'suspended' where id = v_id_a;
  select count(*) into v_count
    from public.operator_cert_records where id = v_id_a and status = 'suspended';
  if v_count <> 1 then
    raise exception 'service_role UPDATE operator_cert_records: status not updated';
  end if;

  delete from public.operator_cert_records where id = v_id_b;
  -- Re-seed tenant-b row; restore tenant-a status so the view filter matches.
  update public.operator_cert_records set status = 'expired' where id = v_id_a;
  insert into public.operator_cert_records
    (tenant_id, person_id, person_name, certification_type, status, expiry_date)
  values (v_tenant_b, gen_random_uuid(), 'Operator B', 'Aerial Work Platform', 'expired', current_date - 1);

  raise notice 'operator_cert_records service_role write path passed';

  -- personnel_training_records ----------------------------------------------
  insert into public.personnel_training_records
    (tenant_id, person_id, person_name, training_type, status, due_date)
  values (v_tenant_a, gen_random_uuid(), 'Employee A', 'HazMat Awareness', 'overdue', current_date - 5)
  returning id into v_id_a;

  insert into public.personnel_training_records
    (tenant_id, person_id, person_name, training_type, status, due_date)
  values (v_tenant_b, gen_random_uuid(), 'Employee B', 'Forklift Safety', 'overdue', current_date - 5)
  returning id into v_id_b;

  select count(*) into v_count from public.personnel_training_records;
  if v_count <> 2 then
    raise exception 'service_role INSERT personnel_training_records: expected 2, found %', v_count;
  end if;

  update public.personnel_training_records set status = 'scheduled' where id = v_id_a;
  select count(*) into v_count
    from public.personnel_training_records where id = v_id_a and status = 'scheduled';
  if v_count <> 1 then
    raise exception 'service_role UPDATE personnel_training_records: status not updated';
  end if;

  delete from public.personnel_training_records where id = v_id_b;
  -- Restore tenant-a to 'overdue' so the view filter catches it; re-seed tenant-b.
  update public.personnel_training_records set status = 'overdue' where id = v_id_a;
  insert into public.personnel_training_records
    (tenant_id, person_id, person_name, training_type, status, due_date)
  values (v_tenant_b, gen_random_uuid(), 'Employee B', 'Forklift Safety', 'overdue', current_date - 5);

  raise notice 'personnel_training_records service_role write path passed';
end;
$$;

reset role;

-- ── 4. authenticated (admin, tenant-a): tenant-scoped reads through views ─────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"crq-test-a"}}',
  true
);

do $$
declare
  v_tenant_a uuid;
  v_count    int;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'crq-test-a';

  -- v_driver_qualification_exceptions: must see exactly the 1 tenant-a row.
  select count(*) into v_count from public.v_driver_qualification_exceptions;
  if v_count <> 1 then
    raise exception
      'v_driver_qualification_exceptions tenant-a read: expected 1, found %', v_count;
  end if;

  -- v_hos_exceptions_current: must see exactly the 1 tenant-a row.
  select count(*) into v_count from public.v_hos_exceptions_current;
  if v_count <> 1 then
    raise exception
      'v_hos_exceptions_current tenant-a read: expected 1, found %', v_count;
  end if;

  -- v_operator_cert_exceptions: must see exactly the 1 tenant-a row.
  select count(*) into v_count from public.v_operator_cert_exceptions;
  if v_count <> 1 then
    raise exception
      'v_operator_cert_exceptions tenant-a read: expected 1, found %', v_count;
  end if;

  -- v_training_compliance_exceptions: must see exactly the 1 tenant-a row.
  select count(*) into v_count from public.v_training_compliance_exceptions;
  if v_count <> 1 then
    raise exception
      'v_training_compliance_exceptions tenant-a read: expected 1, found %', v_count;
  end if;

  raise notice 'authenticated (tenant-a admin) view reads passed — all four views return exactly 1 row';
end;
$$;

-- ── 4b. branch_manager claim-path: policies allow both admin and branch_manager ─

select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"branch_manager","tenant":"crq-test-a"}}',
  true
);

do $$
declare
  v_count int;
begin
  -- branch_manager with tenant-a claims must see exactly the 1 tenant-a row through each view.
  select count(*) into v_count from public.v_driver_qualification_exceptions;
  if v_count <> 1 then
    raise exception
      'v_driver_qualification_exceptions branch_manager read: expected 1, found %', v_count;
  end if;

  select count(*) into v_count from public.v_hos_exceptions_current;
  if v_count <> 1 then
    raise exception
      'v_hos_exceptions_current branch_manager read: expected 1, found %', v_count;
  end if;

  select count(*) into v_count from public.v_operator_cert_exceptions;
  if v_count <> 1 then
    raise exception
      'v_operator_cert_exceptions branch_manager read: expected 1, found %', v_count;
  end if;

  select count(*) into v_count from public.v_training_compliance_exceptions;
  if v_count <> 1 then
    raise exception
      'v_training_compliance_exceptions branch_manager read: expected 1, found %', v_count;
  end if;

  raise notice 'authenticated (tenant-a branch_manager) view reads passed — all four views return exactly 1 row';
end;
$$;

-- ── 5. Cross-tenant read isolation: tenant-b claims must not see tenant-a rows ─

select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"crq-test-b"}}',
  true
);

do $$
declare
  v_tenant_a uuid;
  v_count    int;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'crq-test-a';

  -- v_driver_qualification_exceptions: tenant-b must not see tenant-a rows.
  select count(*) into v_count from public.v_driver_qualification_exceptions;
  if v_count <> 1 then
    raise exception
      'v_driver_qualification_exceptions cross-tenant: expected 1 (tenant-b row), found %', v_count;
  end if;
  if exists (
    select 1
      from public.driver_qualification_records r
      join public.v_driver_qualification_exceptions v
        on v.person_name = r.person_name
     where r.tenant_id = v_tenant_a
  ) then
    raise exception
      'v_driver_qualification_exceptions: tenant-a row visible to tenant-b claim';
  end if;

  -- v_hos_exceptions_current: count + identity + no tenant-a row visible.
  select count(*) into v_count from public.v_hos_exceptions_current;
  if v_count <> 1 then
    raise exception
      'v_hos_exceptions_current cross-tenant: expected 1 (tenant-b row), found %', v_count;
  end if;
  if not exists (
    select 1 from public.v_hos_exceptions_current where person_name = 'Driver B'
  ) then
    raise exception
      'v_hos_exceptions_current cross-tenant: expected tenant-b row (Driver B) to be visible';
  end if;
  if exists (
    select 1
      from public.hos_exception_log r
      join public.v_hos_exceptions_current v on v.person_name = r.person_name
     where r.tenant_id = v_tenant_a
  ) then
    raise exception
      'v_hos_exceptions_current: tenant-a row visible to tenant-b claim';
  end if;

  -- v_operator_cert_exceptions: count + identity + no tenant-a row visible.
  select count(*) into v_count from public.v_operator_cert_exceptions;
  if v_count <> 1 then
    raise exception
      'v_operator_cert_exceptions cross-tenant: expected 1 (tenant-b row), found %', v_count;
  end if;
  if not exists (
    select 1 from public.v_operator_cert_exceptions where person_name = 'Operator B'
  ) then
    raise exception
      'v_operator_cert_exceptions cross-tenant: expected tenant-b row (Operator B) to be visible';
  end if;
  if exists (
    select 1
      from public.operator_cert_records r
      join public.v_operator_cert_exceptions v on v.person_name = r.person_name
     where r.tenant_id = v_tenant_a
  ) then
    raise exception
      'v_operator_cert_exceptions: tenant-a row visible to tenant-b claim';
  end if;

  -- v_training_compliance_exceptions: count + identity + no tenant-a row visible.
  select count(*) into v_count from public.v_training_compliance_exceptions;
  if v_count <> 1 then
    raise exception
      'v_training_compliance_exceptions cross-tenant: expected 1 (tenant-b row), found %', v_count;
  end if;
  if not exists (
    select 1 from public.v_training_compliance_exceptions where person_name = 'Employee B'
  ) then
    raise exception
      'v_training_compliance_exceptions cross-tenant: expected tenant-b row (Employee B) to be visible';
  end if;
  if exists (
    select 1
      from public.personnel_training_records r
      join public.v_training_compliance_exceptions v on v.person_name = r.person_name
     where r.tenant_id = v_tenant_a
  ) then
    raise exception
      'v_training_compliance_exceptions: tenant-a row visible to tenant-b claim';
  end if;

  raise notice 'Cross-tenant read isolation passed — tenant-b sees only its own rows through all four views';
end;
$$;

-- ── 6. authenticated INSERT denied (tables are SELECT-only for this role) ──────

do $$
declare
  v_tenant_a uuid;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'crq-test-a';

  -- driver_qualification_records
  begin
    insert into public.driver_qualification_records
      (tenant_id, person_id, person_name, qualification_type, status)
    values (v_tenant_a, gen_random_uuid(), 'Attacker', 'CDL Class X', 'active');
    raise exception
      'Expected authenticated INSERT into driver_qualification_records to be denied but it succeeded';
  exception
    when insufficient_privilege then null;
    when sqlstate '42501'       then null;
  end;

  -- hos_exception_log
  begin
    insert into public.hos_exception_log
      (tenant_id, person_id, person_name, violation_type, severity)
    values (v_tenant_a, gen_random_uuid(), 'Attacker', 'fake rule', 'warning');
    raise exception
      'Expected authenticated INSERT into hos_exception_log to be denied but it succeeded';
  exception
    when insufficient_privilege then null;
    when sqlstate '42501'       then null;
  end;

  -- operator_cert_records
  begin
    insert into public.operator_cert_records
      (tenant_id, person_id, person_name, certification_type, status)
    values (v_tenant_a, gen_random_uuid(), 'Attacker', 'Fake Cert', 'active');
    raise exception
      'Expected authenticated INSERT into operator_cert_records to be denied but it succeeded';
  exception
    when insufficient_privilege then null;
    when sqlstate '42501'       then null;
  end;

  -- personnel_training_records
  begin
    insert into public.personnel_training_records
      (tenant_id, person_id, person_name, training_type, status)
    values (v_tenant_a, gen_random_uuid(), 'Attacker', 'Fake Module', 'pending');
    raise exception
      'Expected authenticated INSERT into personnel_training_records to be denied but it succeeded';
  exception
    when insufficient_privilege then null;
    when sqlstate '42501'       then null;
  end;

  raise notice 'authenticated INSERT denial passed for all four tables';
end;
$$;

reset role;

-- ── 7. anon denied SELECT on all four views ───────────────────────────────────

set local role anon;

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  -- v_driver_qualification_exceptions
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_driver_qualification_exceptions;
    raise exception
      'anon read v_driver_qualification_exceptions succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'anon should be denied SELECT on v_driver_qualification_exceptions';
  end if;

  -- v_hos_exceptions_current
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_hos_exceptions_current;
    raise exception
      'anon read v_hos_exceptions_current succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'anon should be denied SELECT on v_hos_exceptions_current';
  end if;

  -- v_operator_cert_exceptions
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_operator_cert_exceptions;
    raise exception
      'anon read v_operator_cert_exceptions succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'anon should be denied SELECT on v_operator_cert_exceptions';
  end if;

  -- v_training_compliance_exceptions
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_training_compliance_exceptions;
    raise exception
      'anon read v_training_compliance_exceptions succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'anon should be denied SELECT on v_training_compliance_exceptions';
  end if;

  raise notice 'anon denied SELECT on all four compliance views (REVOKE effective)';
end;
$$;

reset role;

rollback;
