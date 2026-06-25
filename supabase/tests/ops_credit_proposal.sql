-- Behavioral RLS tests for credit_change_proposal (20260609000000).
--
-- Verifies:
--   1. service_role INSERT/UPDATE/DELETE succeeds (the workflow write path).
--   2. Same-tenant reads for authenticated return only scoped rows.
--   3. Cross-tenant reads are filtered out for authenticated.
--   4. authenticated INSERT is denied (service-role-only write boundary).

begin;

-- ── Structural checks ────────────────────────────────────────────────────────

do $$
declare
  v_has_rls bool;
begin
  -- Table exists with RLS enabled.
  select c.relrowsecurity
    into v_has_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'credit_change_proposal';

  if not found or not coalesce(v_has_rls, false) then
    raise exception 'Expected RLS enabled on public.credit_change_proposal';
  end if;

  -- authenticated has SELECT but NOT INSERT or UPDATE.
  if not has_table_privilege('authenticated', 'public.credit_change_proposal', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on public.credit_change_proposal';
  end if;
  if has_table_privilege('authenticated', 'public.credit_change_proposal', 'INSERT') then
    raise exception 'Did not expect authenticated INSERT grant on public.credit_change_proposal (service-role-only write)';
  end if;
  if has_table_privilege('authenticated', 'public.credit_change_proposal', 'UPDATE') then
    raise exception 'Did not expect authenticated UPDATE grant on public.credit_change_proposal (service-role-only write)';
  end if;

  -- service_role has full DML.
  if not has_table_privilege('service_role', 'public.credit_change_proposal', 'INSERT') then
    raise exception 'Expected service_role INSERT grant on public.credit_change_proposal';
  end if;
  if not has_table_privilege('service_role', 'public.credit_change_proposal', 'UPDATE') then
    raise exception 'Expected service_role UPDATE grant on public.credit_change_proposal';
  end if;
  if not has_table_privilege('service_role', 'public.credit_change_proposal', 'DELETE') then
    raise exception 'Expected service_role DELETE grant on public.credit_change_proposal';
  end if;

  raise notice 'credit_change_proposal structural checks passed';
end;
$$;

-- ── Seed tenants + findings as superuser (schema owner) ─────────────────────

do $$
declare
  v_tenant_a   uuid;
  v_tenant_b   uuid;
  v_finding_a  uuid;
  v_finding_b  uuid;
begin
  insert into public.tenants (tenant_key, name)
  values ('ccp-test-a', 'CCP Test A')
  returning id into v_tenant_a;

  insert into public.tenants (tenant_key, name)
  values ('ccp-test-b', 'CCP Test B')
  returning id into v_tenant_b;

  insert into public.finding (
    tenant_id, agent_key, finding_type, severity, fingerprint
  ) values (
    v_tenant_a, 'credit-analyst', 'credit_risk', 'high', 'ccp-seed-a'
  ) returning id into v_finding_a;

  insert into public.finding (
    tenant_id, agent_key, finding_type, severity, fingerprint
  ) values (
    v_tenant_b, 'credit-analyst', 'credit_risk', 'high', 'ccp-seed-b'
  ) returning id into v_finding_b;
end;
$$;

-- ── Behavioral: service_role write path ──────────────────────────────────────
-- The temporal worker runs as service_role. Exercise INSERT → UPDATE → DELETE
-- to prove the full grant→policy chain is wired correctly (structural
-- has_table_privilege() checks alone are insufficient).

set local role service_role;

do $$
declare
  v_tenant_a    uuid;
  v_tenant_b    uuid;
  v_finding_a   uuid;
  v_finding_b   uuid;
  v_proposal_a  uuid;
  v_proposal_b  uuid;
  v_count       int;
  v_payload     jsonb;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'ccp-test-a';
  select id into v_tenant_b from public.tenants where tenant_key = 'ccp-test-b';
  select id into v_finding_a from public.finding where fingerprint = 'ccp-seed-a';
  select id into v_finding_b from public.finding where fingerprint = 'ccp-seed-b';

  -- INSERT: workflow inserts a proposal for each tenant.
  insert into public.credit_change_proposal (
    tenant_id, finding_id, proposed_action, payload
  ) values (
    v_tenant_a, v_finding_a, 'set_credit_limit', '{"credit_limit":5000}'::jsonb
  ) returning id into v_proposal_a;

  insert into public.credit_change_proposal (
    tenant_id, finding_id, proposed_action
  ) values (
    v_tenant_b, v_finding_b, 'place_hold'
  ) returning id into v_proposal_b;

  select count(*) into v_count from public.credit_change_proposal;
  if v_count <> 2 then
    raise exception 'service_role INSERT: expected 2 proposals, found %', v_count;
  end if;

  -- UPDATE: workflow enriches the proposal with approver metadata.
  update public.credit_change_proposal
     set approver = '{"user":"workflow-bot","ts":"2026-06-09T00:00:00Z"}'::jsonb
   where id = v_proposal_a;

  select payload into v_payload
  from public.credit_change_proposal
  where id = v_proposal_a;
  if v_payload is distinct from '{"credit_limit":5000}'::jsonb then
    raise exception 'service_role UPDATE: payload unexpectedly changed, got %', v_payload;
  end if;

  -- DELETE: workflow can retract a rejected proposal.
  delete from public.credit_change_proposal where id = v_proposal_b;

  select count(*) into v_count from public.credit_change_proposal;
  if v_count <> 1 then
    raise exception 'service_role DELETE: expected 1 proposal after delete, found %', v_count;
  end if;

  raise notice 'credit_change_proposal service_role write path (INSERT/UPDATE/DELETE) passed';
end;
$$;

reset role;

-- ── Behavioral: same-tenant read ─────────────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"ccp-test-a"}}',
  true
);

do $$
declare
  v_tenant_a uuid;
  v_count    int;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'ccp-test-a';

  -- Authenticated tenant-a admin must see exactly the 1 tenant-a proposal.
  select count(*) into v_count from public.credit_change_proposal;
  if v_count <> 1 then
    raise exception
      'Expected 1 credit_change_proposal row for tenant-a, found %', v_count;
  end if;

  -- Must not expose tenant-b rows.
  if exists (
    select 1 from public.credit_change_proposal where tenant_id <> v_tenant_a
  ) then
    raise exception
      'Expected cross-tenant credit_change_proposal rows to be excluded for tenant-a claim';
  end if;

  raise notice 'credit_change_proposal same-tenant read check passed';
end;
$$;

-- ── Behavioral: authenticated write denied ───────────────────────────────────

do $$
declare
  v_tenant_a  uuid;
  v_finding_a uuid;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'ccp-test-a';
  select id into v_finding_a from public.finding where fingerprint = 'ccp-seed-a';

  begin
    insert into public.credit_change_proposal (
      tenant_id, finding_id, proposed_action
    ) values (
      v_tenant_a, v_finding_a, 'no_change'
    );
    -- If we reach here the insert succeeded — that is a security violation.
    raise exception
      'Expected authenticated INSERT into credit_change_proposal to be denied, but it succeeded';
  exception
    when insufficient_privilege then null; -- expected
    when sqlstate '42501'       then null; -- expected
  end;

  if exists (
    select 1 from public.credit_change_proposal where proposed_action = 'no_change'
  ) then
    raise exception
      'Expected authenticated INSERT into credit_change_proposal to be denied, but row exists';
  end if;

  raise notice 'credit_change_proposal authenticated write denial check passed';
end;
$$;

-- ── Behavioral: cross-tenant read returns 0 rows ────────────────────────────

select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"ccp-test-b"}}',
  true
);

do $$
declare
  v_count int;
begin
  -- Tenant-b's proposal was retracted (deleted) by service_role above.
  -- Authenticated tenant-b claim must see 0 rows.
  select count(*) into v_count from public.credit_change_proposal;
  if v_count <> 0 then
    raise exception
      'Expected 0 credit_change_proposal rows for tenant-b after deletion, found %', v_count;
  end if;

  -- Tenant-a's remaining proposal must also be invisible to the tenant-b claim.
  if exists (
    select 1
    from public.credit_change_proposal p
    join public.finding f on f.id = p.finding_id
    where f.fingerprint = 'ccp-seed-a'
  ) then
    raise exception
      'Expected tenant-a proposal to be invisible to tenant-b claim';
  end if;

  raise notice 'credit_change_proposal cross-tenant isolation check passed';
end;
$$;

reset role;

rollback;
