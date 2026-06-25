-- Smoke tests for Ops Factory persistence migration (20260607170000).

begin;

do $$
declare
  v_count int;
  v_has_view bool;
  v_has_rls bool;
begin
  -- Tables exist
  select count(*)
    into v_count
  from information_schema.tables
  where table_schema = 'public'
    and table_name in (
      'tenants',
      'ops_agent_config',
      'ops_output_schema_registry',
      'finding',
      'ops_workflow_run',
      'invoice_adjustment_draft'
    );

  if v_count <> 6 then
    raise exception 'Expected 6 Ops Factory tables, found %', v_count;
  end if;

  -- tenant_id column exists on all required tables
  select count(*)
    into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('ops_agent_config', 'finding', 'ops_workflow_run', 'invoice_adjustment_draft')
    and column_name = 'tenant_id';

  if v_count <> 4 then
    raise exception 'Expected tenant_id on 4 Ops Factory tables, found %', v_count;
  end if;

  -- Dedup unique constraint exists for finding(tenant_id, fingerprint)
  select count(*)
    into v_count
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'finding'
    and c.contype = 'u'
    and pg_get_constraintdef(c.oid) ilike '%(tenant_id, fingerprint)%';

  if v_count <> 1 then
    raise exception 'Expected unique dedup constraint on finding(tenant_id, fingerprint), found %', v_count;
  end if;

  -- Views exist
  select count(*)
    into v_count
  from information_schema.views
  where table_schema = 'public'
    and table_name in (
      'ops_findings_view',
      'ops_finding_kpis',
      'ops_agent_status_view',
      'ops_audit_trail_view',
      'ops_agent_config_current'
    );

  if v_count <> 5 then
    raise exception 'Expected 5 Ops Factory views, found %', v_count;
  end if;

  -- Views are marked security_invoker
  select bool_and(
    exists (
      select 1
      from unnest(coalesce(c.reloptions, '{}'::text[])) as opt
      where opt = 'security_invoker=true'
    )
  )
    into v_has_view
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'v'
    and c.relname in (
      'ops_findings_view',
      'ops_finding_kpis',
      'ops_agent_status_view',
      'ops_audit_trail_view',
      'ops_agent_config_current'
    );

  if not coalesce(v_has_view, false) then
    raise exception 'Expected Ops Factory views to be created with security_invoker=true';
  end if;

  -- RLS enabled on tenant-scoped Ops tables
  select bool_and(c.relrowsecurity)
    into v_has_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'tenants',
      'ops_agent_config',
      'ops_output_schema_registry',
      'finding',
      'ops_workflow_run',
      'invoice_adjustment_draft'
    );

  if not coalesce(v_has_rls, false) then
    raise exception 'Expected RLS enabled on all Ops Factory tables';
  end if;

  -- Authenticated can read but not delete Ops rows directly; service_role has full access.
  if not has_table_privilege('authenticated', 'public.finding', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on public.finding';
  end if;
  if not has_table_privilege('authenticated', 'public.finding', 'INSERT') then
    raise exception 'Expected authenticated INSERT grant on public.finding';
  end if;
  if has_table_privilege('authenticated', 'public.finding', 'DELETE') then
    raise exception 'Did not expect authenticated DELETE grant on public.finding';
  end if;
  if not has_table_privilege('service_role', 'public.finding', 'INSERT, UPDATE, DELETE') then
    raise exception 'Expected service_role full DML grants on public.finding';
  end if;

  raise notice 'ops_factory_schema checks passed';
end;
$$;

-- Behavioral RLS checks: same-tenant reads/writes allowed, cross-tenant writes denied.
do $$
declare
  v_tenant_a uuid;
  v_tenant_b uuid;
  v_agent_entity_a uuid;
  v_agent_entity_b uuid;
begin
  insert into public.tenants (tenant_key, name)
  values ('ops-test-a', 'Ops Test A')
  returning id into v_tenant_a;

  insert into public.tenants (tenant_key, name)
  values ('ops-test-b', 'Ops Test B')
  returning id into v_tenant_b;

  insert into public.finding (
    tenant_id,
    agent_key,
    finding_type,
    severity,
    fingerprint
  ) values (
    v_tenant_a,
    'ops-audit-agent',
    'billing_mismatch',
    'high',
    'seed-a'
  );

  insert into public.finding (
    tenant_id,
    agent_key,
    finding_type,
    severity,
    fingerprint
  ) values (
    v_tenant_b,
    'ops-audit-agent',
    'billing_mismatch',
    'high',
    'seed-b'
  );

  insert into public.entities (entity_type, source_record_id)
  values ('agent_config', format('ops-test-agent-config:%s:%s', v_tenant_a, 'revrec-analyst'))
  on conflict (entity_type, source_record_id) do update
    set source_record_id = excluded.source_record_id
  returning id into v_agent_entity_a;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_agent_entity_a,
    1,
    jsonb_build_object(
      'tenant_id', v_tenant_a,
      'agent_key', 'revrec-analyst',
      'enabled', true,
      'model', jsonb_build_object('provider', 'azure_openai'),
      'system_prompt', 'tenant a',
      'user_prompt_template', 'tenant a',
      'tools', '["rental_data"]'::jsonb,
      'output_schema_key', 'ops_test_schema_v1',
      'thresholds', '{}'::jsonb,
      'bounds', '{}'::jsonb,
      'schedule', '{}'::jsonb,
      'auto_apply', false
    )
  )
  on conflict (entity_id, version_number) do update
    set data = excluded.data,
        is_current = true,
        valid_to = null;

  insert into public.entities (entity_type, source_record_id)
  values ('agent_config', format('ops-test-agent-config:%s:%s', v_tenant_b, 'revrec-analyst'))
  on conflict (entity_type, source_record_id) do update
    set source_record_id = excluded.source_record_id
  returning id into v_agent_entity_b;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_agent_entity_b,
    1,
    jsonb_build_object(
      'tenant_id', v_tenant_b,
      'agent_key', 'revrec-analyst',
      'enabled', true,
      'model', jsonb_build_object('provider', 'azure_openai'),
      'system_prompt', 'tenant b',
      'user_prompt_template', 'tenant b',
      'tools', '["rental_data"]'::jsonb,
      'output_schema_key', 'ops_test_schema_v1',
      'thresholds', '{}'::jsonb,
      'bounds', '{}'::jsonb,
      'schedule', '{}'::jsonb,
      'auto_apply', false
    )
  )
  on conflict (entity_id, version_number) do update
    set data = excluded.data,
        is_current = true,
        valid_to = null;

  insert into public.ops_output_schema_registry (schema_key, schema_json, description)
  values (
    'ops_test_schema_v1',
    '{"type":"object","required":["contract_id"]}'::jsonb,
    'Ops test schema'
  )
  on conflict (schema_key) do update
    set schema_json = excluded.schema_json,
        description = excluded.description;

  insert into public.ops_workflow_run (run_id, tenant_id, workflow_key, status, counts)
  values
    ('ops-test-run-a', v_tenant_a, 'revrec-analyst', 'succeeded', '{"findings_produced":1}'::jsonb),
    ('ops-test-run-b', v_tenant_b, 'revrec-analyst', 'failed', '{"findings_produced":1}'::jsonb)
  on conflict (run_id) do update
    set tenant_id = excluded.tenant_id,
        workflow_key = excluded.workflow_key,
        status = excluded.status,
        counts = excluded.counts;

  insert into public.finding (
    tenant_id,
    agent_key,
    run_id,
    finding_type,
    severity,
    status,
    fingerprint,
    delta
  ) values
    (v_tenant_a, 'revrec-analyst', 'ops-test-run-a', 'billing_mismatch', 'high', 'pending_approval', 'ops-pending-a', 1000),
    (v_tenant_b, 'revrec-analyst', 'ops-test-run-b', 'billing_mismatch', 'high', 'pending_approval', 'ops-pending-b', 2000)
  on conflict (tenant_id, fingerprint) do update
    set agent_key = excluded.agent_key,
        run_id = excluded.run_id,
        status = excluded.status,
        delta = excluded.delta;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"ops-test-a"}}',
  true
);

do $$
declare
  v_tenant_a uuid;
  v_tenant_b uuid;
  v_visible_count int;
  v_cfg_count int;
  v_status_count int;
  v_pending_findings int;
  v_identified_delta numeric;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'ops-test-a';
  select id into v_tenant_b from public.tenants where tenant_key = 'ops-test-b';

  select count(*)
    into v_visible_count
  from public.finding;
  if v_visible_count <> 2 then
    raise exception 'Expected authenticated tenant-scoped read to return 2 rows, found %', v_visible_count;
  end if;
  if exists (
    select 1
    from public.finding f
    where f.tenant_id <> v_tenant_a
  ) then
    raise exception 'Expected authenticated tenant-scoped read to exclude tenant-b findings';
  end if;

  select count(*)
    into v_cfg_count
  from public.ops_agent_config_current c;
  if v_cfg_count <> 1 then
    raise exception 'Expected tenant-scoped config view to return 1 row, found %', v_cfg_count;
  end if;

  if exists (
    select 1
    from public.ops_agent_config_current c
    where c.tenant_id <> v_tenant_a
  ) then
    raise exception 'Expected ops_agent_config_current to filter out tenant-b rows for tenant-a claim';
  end if;

  select count(*), coalesce(max(s.pending_findings), 0)
    into v_status_count, v_pending_findings
  from public.ops_agent_status_view s
  where s.agent_key = 'revrec-analyst';
  if v_status_count <> 1 then
    raise exception 'Expected tenant-scoped status view to return 1 row, found %', v_status_count;
  end if;
  if v_pending_findings <> 1 then
    raise exception 'Expected tenant-a pending findings count of 1, found %', v_pending_findings;
  end if;

  -- Behavioral check: identified_delta aggregates only same-tenant findings.
  -- Tenant B has a revrec-analyst finding with delta=2000; it must not contribute.
  select coalesce(s.identified_delta, 0)
    into v_identified_delta
  from public.ops_agent_status_view s
  where s.agent_key = 'revrec-analyst';
  if v_identified_delta <> 1000 then
    raise exception
      'Expected identified_delta 1000 (tenant-a only), found % — cross-tenant delta must be excluded',
      v_identified_delta;
  end if;

  insert into public.finding (
    tenant_id,
    agent_key,
    finding_type,
    severity,
    fingerprint
  ) values (
    v_tenant_a,
    'ops-audit-agent',
    'rate_leak',
    'medium',
    'same-tenant-write'
  );

  begin
    insert into public.finding (
      tenant_id,
      agent_key,
      finding_type,
      severity,
      fingerprint
    ) values (
      v_tenant_b,
      'ops-audit-agent',
      'rate_leak',
      'medium',
      'cross-tenant-write'
    );
  exception
    -- 42501 = insufficient_privilege (includes policy/privilege write denials).
    when sqlstate '42501' then
      null;
  end;

  if exists (select 1 from public.finding where fingerprint = 'cross-tenant-write') then
    raise exception 'Expected cross-tenant write to be denied for authenticated admin claim';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"read_only","tenant":"ops-test-a"}}',
  true
);

do $$
declare
  v_tenant_a uuid;
  v_registry_count int;
begin
  select id into v_tenant_a from public.tenants where tenant_key = 'ops-test-a';

  begin
    insert into public.finding (
      tenant_id,
      agent_key,
      finding_type,
      severity,
      fingerprint
    ) values (
      v_tenant_a,
      'ops-audit-agent',
      'rate_leak',
      'low',
      'unauthorized-write'
    );
  exception
    -- 42501 = insufficient_privilege (includes policy/privilege write denials).
    when sqlstate '42501' then
      null;
  end;

  if exists (select 1 from public.finding where fingerprint = 'unauthorized-write') then
    raise exception 'Expected read_only write to be denied';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"read_only","tenant":"ops-test-a"}}',
  true
);

do $$
declare
  v_registry_count int;
begin
  select count(*)
    into v_registry_count
  from public.ops_output_schema_registry
  where schema_key = 'ops_test_schema_v1';

  if v_registry_count <> 1 then
    raise exception 'Expected read_only role to read registered schema row, found %', v_registry_count;
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"guest","tenant":"ops-test-a"}}',
  true
);

do $$
declare
  v_registry_count int;
begin
  select count(*)
    into v_registry_count
  from public.ops_output_schema_registry;

  if v_registry_count <> 0 then
    raise exception 'Expected disallowed app role to read 0 schema rows, found %', v_registry_count;
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"ops-test-a"}}',
  true
);

do $$
begin
  begin
    insert into public.ops_output_schema_registry (schema_key, schema_json)
    values ('ops-test-auth-insert', '{"type":"object"}'::jsonb);
  exception
    when sqlstate '42501' then
      null;
  end;

  if exists (
    select 1
    from public.ops_output_schema_registry
    where schema_key = 'ops-test-auth-insert'
  ) then
    raise exception 'Expected authenticated insert into ops_output_schema_registry to be denied';
  end if;

  begin
    update public.ops_output_schema_registry
      set description = 'mutated by authenticated'
    where schema_key = 'ops_test_schema_v1';
  exception
    when sqlstate '42501' then
      null;
  end;

  if exists (
    select 1
    from public.ops_output_schema_registry
    where schema_key = 'ops_test_schema_v1'
      and description = 'mutated by authenticated'
  ) then
    raise exception 'Expected authenticated update on ops_output_schema_registry to be denied';
  end if;
end;
$$;

reset role;

rollback;
