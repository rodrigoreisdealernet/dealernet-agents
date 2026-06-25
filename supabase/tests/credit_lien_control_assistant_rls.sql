-- Behavioral RLS tests for 20260617230000_credit_lien_control_assistant.sql
--
-- Covers all three tenant-scoped tables:
--   credit_application, lien_deadline_obligation, lien_waiver_obligation
--
-- For each table verifies:
--   1. Table structure: RLS enabled, correct privilege grants.
--   2. service_role write path: INSERT / UPDATE / DELETE succeeds.
--   3. Same-tenant authenticated read: only scoped rows visible.
--   4. Cross-tenant read: filtered to 0 rows.
--   5. Cross-tenant INSERT denied for authenticated caller.
--   6. Authenticated INSERT with wrong tenant claim denied.

begin;

-- ── Structural checks ────────────────────────────────────────────────────────

do $$
declare
  v_table text;
  v_tables constant text[] := array[
    'credit_application',
    'lien_deadline_obligation',
    'lien_waiver_obligation'
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

    -- authenticated: SELECT, INSERT, UPDATE (but not DELETE — service_role only).
    if not has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT') then
      raise exception 'Expected authenticated SELECT on public.%', v_table;
    end if;
    if not has_table_privilege('authenticated', format('public.%I', v_table), 'INSERT') then
      raise exception 'Expected authenticated INSERT on public.%', v_table;
    end if;
    if not has_table_privilege('authenticated', format('public.%I', v_table), 'UPDATE') then
      raise exception 'Expected authenticated UPDATE on public.%', v_table;
    end if;
    if has_table_privilege('authenticated', format('public.%I', v_table), 'DELETE') then
      raise exception 'Did not expect authenticated DELETE on public.%', v_table;
    end if;

    -- anon must have no access.
    if has_table_privilege('anon', format('public.%I', v_table), 'SELECT') then
      raise exception 'Did not expect anon SELECT on public.%', v_table;
    end if;

    -- service_role must have full DML.
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

-- ── Seed tenants as superuser ────────────────────────────────────────────────

do $$
begin
  insert into public.tenants (tenant_key, name)
  values ('clc-test-a', 'CLC Test A'),
         ('clc-test-b', 'CLC Test B');
end;
$$;

-- ── service_role write path — credit_application ─────────────────────────────

set local role service_role;

do $$
declare
  v_tenant_a   uuid;
  v_tenant_b   uuid;
  v_app_a      uuid;
  v_app_b      uuid;
  v_count      int;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'clc-test-a';
  select id into v_tenant_b from public.tenants where tenant_key = 'clc-test-b';

  insert into public.credit_application (tenant_id, customer_name, requested_credit_limit, current_credit_limit)
  values (v_tenant_a, 'Acme Corp A', 50000, 10000)
  returning id into v_app_a;

  insert into public.credit_application (tenant_id, customer_name, requested_credit_limit, current_credit_limit)
  values (v_tenant_b, 'Acme Corp B', 75000, 25000)
  returning id into v_app_b;

  select count(*) into v_count from public.credit_application;
  if v_count <> 2 then
    raise exception 'service_role INSERT credit_application: expected 2, found %', v_count;
  end if;

  update public.credit_application set status = 'approved' where id = v_app_a;

  select count(*) into v_count
  from public.credit_application where id = v_app_a and status = 'approved';
  if v_count <> 1 then
    raise exception 'service_role UPDATE credit_application: status not updated';
  end if;

  delete from public.credit_application where id = v_app_b;

  select count(*) into v_count from public.credit_application;
  if v_count <> 1 then
    raise exception 'service_role DELETE credit_application: expected 1 after delete, found %', v_count;
  end if;

  raise notice 'credit_application service_role write path passed';
end;
$$;

reset role;

-- ── service_role write path — lien_deadline_obligation ───────────────────────

set local role service_role;

do $$
declare
  v_tenant_a   uuid;
  v_tenant_b   uuid;
  v_ld_a       uuid;
  v_ld_b       uuid;
  v_count      int;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'clc-test-a';
  select id into v_tenant_b from public.tenants where tenant_key = 'clc-test-b';

  insert into public.lien_deadline_obligation
    (tenant_id, customer_name, project_name, state, first_furnishing_date)
  values (v_tenant_a, 'Customer A', 'Project A', 'CA', current_date - 20)
  returning id into v_ld_a;

  insert into public.lien_deadline_obligation
    (tenant_id, customer_name, project_name, state, first_furnishing_date)
  values (v_tenant_b, 'Customer B', 'Project B', 'TX', current_date - 10)
  returning id into v_ld_b;

  select count(*) into v_count from public.lien_deadline_obligation;
  if v_count <> 2 then
    raise exception 'service_role INSERT lien_deadline_obligation: expected 2, found %', v_count;
  end if;

  update public.lien_deadline_obligation
     set notice_sent = true, notice_sent_at = now()
   where id = v_ld_a;

  select count(*) into v_count
  from public.lien_deadline_obligation where id = v_ld_a and notice_sent = true;
  if v_count <> 1 then
    raise exception 'service_role UPDATE lien_deadline_obligation: notice_sent not set';
  end if;

  delete from public.lien_deadline_obligation where id = v_ld_b;

  select count(*) into v_count from public.lien_deadline_obligation;
  if v_count <> 1 then
    raise exception 'service_role DELETE lien_deadline_obligation: expected 1 after delete, found %', v_count;
  end if;

  raise notice 'lien_deadline_obligation service_role write path passed';
end;
$$;

reset role;

-- ── service_role write path — lien_waiver_obligation ─────────────────────────

set local role service_role;

do $$
declare
  v_tenant_a   uuid;
  v_tenant_b   uuid;
  v_lw_a       uuid;
  v_lw_b       uuid;
  v_count      int;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'clc-test-a';
  select id into v_tenant_b from public.tenants where tenant_key = 'clc-test-b';

  insert into public.lien_waiver_obligation
    (tenant_id, customer_name, waiver_type, payment_amount)
  values (v_tenant_a, 'Customer A', 'conditional_partial', 15000)
  returning id into v_lw_a;

  insert into public.lien_waiver_obligation
    (tenant_id, customer_name, waiver_type, payment_amount)
  values (v_tenant_b, 'Customer B', 'unconditional_final', 30000)
  returning id into v_lw_b;

  select count(*) into v_count from public.lien_waiver_obligation;
  if v_count <> 2 then
    raise exception 'service_role INSERT lien_waiver_obligation: expected 2, found %', v_count;
  end if;

  update public.lien_waiver_obligation
     set waiver_status = 'received'
   where id = v_lw_a;

  select count(*) into v_count
  from public.lien_waiver_obligation where id = v_lw_a and waiver_status = 'received';
  if v_count <> 1 then
    raise exception 'service_role UPDATE lien_waiver_obligation: waiver_status not updated';
  end if;

  delete from public.lien_waiver_obligation where id = v_lw_b;

  select count(*) into v_count from public.lien_waiver_obligation;
  if v_count <> 1 then
    raise exception 'service_role DELETE lien_waiver_obligation: expected 1 after delete, found %', v_count;
  end if;

  raise notice 'lien_waiver_obligation service_role write path passed';
end;
$$;

reset role;

-- ── Same-tenant authenticated reads ─────────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"clc-test-a"}}',
  true
);

do $$
declare
  v_tenant_a uuid;
  v_count    int;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'clc-test-a';

  -- credit_application: must see exactly the 1 tenant-a row
  select count(*) into v_count from public.credit_application;
  if v_count <> 1 then
    raise exception 'credit_application same-tenant read: expected 1, found %', v_count;
  end if;
  if exists (select 1 from public.credit_application where tenant_id <> v_tenant_a) then
    raise exception 'credit_application same-tenant read: cross-tenant row visible for clc-test-a';
  end if;

  -- lien_deadline_obligation: must see exactly the 1 tenant-a row
  select count(*) into v_count from public.lien_deadline_obligation;
  if v_count <> 1 then
    raise exception 'lien_deadline_obligation same-tenant read: expected 1, found %', v_count;
  end if;
  if exists (select 1 from public.lien_deadline_obligation where tenant_id <> v_tenant_a) then
    raise exception 'lien_deadline_obligation same-tenant read: cross-tenant row visible for clc-test-a';
  end if;

  -- lien_waiver_obligation: must see exactly the 1 tenant-a row
  select count(*) into v_count from public.lien_waiver_obligation;
  if v_count <> 1 then
    raise exception 'lien_waiver_obligation same-tenant read: expected 1, found %', v_count;
  end if;
  if exists (select 1 from public.lien_waiver_obligation where tenant_id <> v_tenant_a) then
    raise exception 'lien_waiver_obligation same-tenant read: cross-tenant row visible for clc-test-a';
  end if;

  raise notice 'Same-tenant authenticated reads passed for all three tables';
end;
$$;

-- ── Cross-tenant read returns 0 rows ─────────────────────────────────────────

-- Switch to tenant-b; its rows were deleted by service_role above.
select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"clc-test-b"}}',
  true
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.credit_application;
  if v_count <> 0 then
    raise exception
      'credit_application cross-tenant read: expected 0 for clc-test-b, found %', v_count;
  end if;

  select count(*) into v_count from public.lien_deadline_obligation;
  if v_count <> 0 then
    raise exception
      'lien_deadline_obligation cross-tenant read: expected 0 for clc-test-b, found %', v_count;
  end if;

  select count(*) into v_count from public.lien_waiver_obligation;
  if v_count <> 0 then
    raise exception
      'lien_waiver_obligation cross-tenant read: expected 0 for clc-test-b, found %', v_count;
  end if;

  -- Tenant-a rows must be invisible to tenant-b claim.
  if exists (
    select 1 from public.credit_application a
    join public.tenants t on t.id = a.tenant_id
    where t.tenant_key = 'clc-test-a'
  ) then
    raise exception
      'credit_application: tenant-a row visible to tenant-b claim';
  end if;

  raise notice 'Cross-tenant read isolation passed for all three tables';
end;
$$;

-- ── Cross-tenant INSERT denied (authenticated with wrong tenant claim) ────────

-- Caller is clc-test-b but tries to insert a row for clc-test-a.
do $$
declare
  v_tenant_a uuid;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'clc-test-a';

  -- credit_application: insert for tenant-a while claiming tenant-b must be denied.
  begin
    insert into public.credit_application (tenant_id, customer_name, requested_credit_limit, current_credit_limit)
    values (v_tenant_a, 'Attacker', 99999, 0);
    raise exception
      'Expected cross-tenant INSERT into credit_application to be denied but it succeeded';
  exception
    when insufficient_privilege then null;
    when sqlstate '42501'       then null;
    when check_violation        then null;
    when sqlstate '23514'       then null;
  end;

  -- lien_deadline_obligation: same test.
  begin
    insert into public.lien_deadline_obligation
      (tenant_id, customer_name, project_name, state, first_furnishing_date)
    values (v_tenant_a, 'Attacker', 'Evil Project', 'CA', current_date);
    raise exception
      'Expected cross-tenant INSERT into lien_deadline_obligation to be denied but it succeeded';
  exception
    when insufficient_privilege then null;
    when sqlstate '42501'       then null;
    when check_violation        then null;
    when sqlstate '23514'       then null;
  end;

  -- lien_waiver_obligation: same test.
  begin
    insert into public.lien_waiver_obligation
      (tenant_id, customer_name, waiver_type, payment_amount)
    values (v_tenant_a, 'Attacker', 'conditional_partial', 0);
    raise exception
      'Expected cross-tenant INSERT into lien_waiver_obligation to be denied but it succeeded';
  exception
    when insufficient_privilege then null;
    when sqlstate '42501'       then null;
    when check_violation        then null;
    when sqlstate '23514'       then null;
  end;

  raise notice 'Cross-tenant INSERT denial passed for all three tables';
end;
$$;

reset role;

rollback;
