-- RLS behavioral tests for public.fleet_disposition_handoff_draft
-- (migration 20260620051000_fleet_disposition_handoff_draft.sql).
--
-- These assertions fail if:
--   * authenticated loses tenant-scoped SELECT access
--   * authenticated unexpectedly gains INSERT rights
--   * service_role loses write ability
--   * ops_claim_app_role() or ops_tenant_match(tenant_id) are miswired
--
-- Pattern: single transaction with SET LOCAL ROLE + request.jwt.claims to
-- simulate PostgREST JWT contexts.

begin;

-- ── Fixture setup (superuser context) ───────────────────────────────────────
do $$
declare
  v_tenant_a_id uuid;
  v_tenant_b_id uuid;
  v_finding_a_id uuid;
  v_finding_b_id uuid;
  v_finding_c_id uuid;
begin
  insert into public.tenants (tenant_key, name)
  values
    ('fleet-handoff-rls-tenant-a', 'Fleet Handoff RLS Tenant A'),
    ('fleet-handoff-rls-tenant-b', 'Fleet Handoff RLS Tenant B');

  select id into v_tenant_a_id from public.tenants where tenant_key = 'fleet-handoff-rls-tenant-a';
  select id into v_tenant_b_id from public.tenants where tenant_key = 'fleet-handoff-rls-tenant-b';

  insert into public.finding (
    tenant_id,
    agent_key,
    finding_type,
    severity,
    fingerprint
  ) values (
    v_tenant_a_id,
    'fleet_utilization',
    'fleet_disposition',
    'medium',
    'fleet-handoff-rls-finding-a'
  ) returning id into v_finding_a_id;

  insert into public.finding (
    tenant_id,
    agent_key,
    finding_type,
    severity,
    fingerprint
  ) values (
    v_tenant_b_id,
    'fleet_utilization',
    'fleet_disposition',
    'medium',
    'fleet-handoff-rls-finding-b'
  ) returning id into v_finding_b_id;

  insert into public.finding (
    tenant_id,
    agent_key,
    finding_type,
    severity,
    fingerprint
  ) values (
    v_tenant_a_id,
    'fleet_utilization',
    'fleet_disposition',
    'medium',
    'fleet-handoff-rls-finding-c'
  ) returning id into v_finding_c_id;

  insert into public.fleet_disposition_handoff_draft (
    tenant_id,
    finding_id,
    disposition,
    handoff_path,
    status,
    approver,
    payload
  ) values
    (
      v_tenant_a_id,
      v_finding_a_id,
      'replace',
      'procurement',
      'draft',
      '{"id":"approver-a"}'::jsonb,
      '{"ticket":"PROC-1001"}'::jsonb
    ),
    (
      v_tenant_b_id,
      v_finding_b_id,
      'sell',
      'lifecycle',
      'draft',
      '{"id":"approver-b"}'::jsonb,
      '{"ticket":"LIFE-2001"}'::jsonb
    );
end;
$$;

-- ── 1. Grant structure remains least-privilege ──────────────────────────────
do $$
begin
  if not has_table_privilege('authenticated', 'public.fleet_disposition_handoff_draft', 'SELECT') then
    raise exception 'FAIL 1a: authenticated must have SELECT on public.fleet_disposition_handoff_draft';
  end if;

  if has_table_privilege('authenticated', 'public.fleet_disposition_handoff_draft', 'INSERT') then
    raise exception 'FAIL 1b: authenticated must not have INSERT on public.fleet_disposition_handoff_draft';
  end if;

  if not has_table_privilege('service_role', 'public.fleet_disposition_handoff_draft', 'INSERT') then
    raise exception 'FAIL 1c: service_role must have INSERT on public.fleet_disposition_handoff_draft';
  end if;

  raise notice 'PASS 1: GRANT model is least-privilege (authenticated SELECT-only, service_role write enabled)';
end;
$$;

-- ── 2. Authenticated admin sees only same-tenant rows ───────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated","app_metadata":{"role":"admin","tenant":"fleet-handoff-rls-tenant-a"}}',
  true
);

do $$
declare
  v_tenant_a_id uuid;
  v_total int;
  v_tenant_count int;
begin
  select id into v_tenant_a_id from public.tenants where tenant_key = 'fleet-handoff-rls-tenant-a';

  select count(*) into v_total from public.fleet_disposition_handoff_draft;
  select count(*) into v_tenant_count
  from public.fleet_disposition_handoff_draft
  where tenant_id = v_tenant_a_id;

  if v_tenant_count <> 1 then
    raise exception 'FAIL 2a: authenticated admin should see exactly 1 tenant-a row; got %', v_tenant_count;
  end if;

  if v_total <> v_tenant_count then
    raise exception
      'FAIL 2b: cross-tenant leak detected; total visible rows=% tenant-a rows=%',
      v_total, v_tenant_count;
  end if;

  raise notice 'PASS 2: authenticated admin is tenant-scoped via ops_tenant_match(tenant_id)';
end;
$$;

reset role;

-- ── 3. Authenticated role claim gate blocks unsupported app roles ───────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000a002","role":"authenticated","app_metadata":{"role":"guest","tenant":"fleet-handoff-rls-tenant-a"}}',
  true
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.fleet_disposition_handoff_draft;
  if v_count <> 0 then
    raise exception
      'FAIL 3: unsupported app role should see 0 rows; got % (ops_claim_app_role role gate may be inert)',
      v_count;
  end if;

  raise notice 'PASS 3: unsupported app role is denied by ops_claim_app_role() role gate';
end;
$$;

reset role;

-- ── 4. Authenticated writes are denied ───────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000a003","role":"authenticated","app_metadata":{"role":"admin","tenant":"fleet-handoff-rls-tenant-a"}}',
  true
);

do $$
declare
  v_tenant_a_id uuid;
  v_finding_a_id uuid;
  v_caught bool := false;
begin
  select id into v_tenant_a_id from public.tenants where tenant_key = 'fleet-handoff-rls-tenant-a';
  select id into v_finding_a_id from public.finding where fingerprint = 'fleet-handoff-rls-finding-a';

  begin
    insert into public.fleet_disposition_handoff_draft (
      tenant_id,
      finding_id,
      disposition,
      handoff_path,
      status
    ) values (
      v_tenant_a_id,
      v_finding_a_id,
      'keep',
      'lifecycle',
      'draft'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 4: unexpected SQLSTATE % "%" during authenticated insert', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 4: authenticated INSERT unexpectedly succeeded';
  end if;

  raise notice 'PASS 4: authenticated INSERT denied as expected';
end;
$$;

reset role;

-- ── 5. service_role can write rows (workflow execution path) ────────────────
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_tenant_a_id uuid;
  v_finding_c_id uuid;
  v_new_id uuid;
  v_status text;
begin
  select id into v_tenant_a_id from public.tenants where tenant_key = 'fleet-handoff-rls-tenant-a';
  select id into v_finding_c_id from public.finding where fingerprint = 'fleet-handoff-rls-finding-c';

  insert into public.fleet_disposition_handoff_draft (
    tenant_id,
    finding_id,
    disposition,
    handoff_path,
    status,
    payload
  ) values (
    v_tenant_a_id,
    v_finding_c_id,
    'keep',
    'lifecycle',
    'draft',
    '{"ticket":"LIFE-2002"}'::jsonb
  )
  returning id into v_new_id;

  update public.fleet_disposition_handoff_draft
  set payload = jsonb_set(payload, '{updated_by}', '"service_role"'::jsonb)
  where id = v_new_id;

  select status into v_status
  from public.fleet_disposition_handoff_draft
  where id = v_new_id;

  if v_status <> 'draft' then
    raise exception 'FAIL 5: service_role insert/update validation failed; expected draft status, got %', v_status;
  end if;

  raise notice 'PASS 5: service_role can insert/update rows on fleet_disposition_handoff_draft';
end;
$$;

reset role;

rollback;
