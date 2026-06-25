begin;

do $$
declare
  v_tenant_a_id uuid;
  v_tenant_b_id uuid;
  v_config_id uuid;
  v_run_id uuid;
  v_config_row public.accounting_export_config;
  v_run_row public.accounting_export_runs;
  v_count bigint;
  v_caught boolean;
begin
  -- ---------------------------------------------------------------------------
  -- Seed tenants
  -- ---------------------------------------------------------------------------
  insert into public.tenants (tenant_key, name)
  values
    ('export-config-tenant-a', 'Export Config Tenant A'),
    ('export-config-tenant-b', 'Export Config Tenant B');

  select id into v_tenant_a_id from public.tenants where tenant_key = 'export-config-tenant-a';
  select id into v_tenant_b_id from public.tenants where tenant_key = 'export-config-tenant-b';

  -- ---------------------------------------------------------------------------
  -- accounting_upsert_export_config RPC (service_role)
  -- ---------------------------------------------------------------------------

  execute 'set local role service_role';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  -- Insert first config for tenant A (xero)
  select * into v_config_row from public.accounting_upsert_export_config(
    p_tenant_id     => v_tenant_a_id,
    p_export_mode   => 'xero',
    p_format_version => 'xero_csv_v1',
    p_account_code_map => '{"4000-RENT": "200"}'::jsonb,
    p_tax_code_map  => '{}'::jsonb,
    p_created_by    => 'admin@wynne-rental.dev'
  );

  if v_config_row.export_mode <> 'xero' then
    raise exception 'Expected export_mode=xero, got %', v_config_row.export_mode;
  end if;
  if v_config_row.format_version <> 'xero_csv_v1' then
    raise exception 'Expected format_version=xero_csv_v1, got %', v_config_row.format_version;
  end if;
  if not v_config_row.enabled then
    raise exception 'Expected newly inserted config to be enabled';
  end if;
  v_config_id := v_config_row.id;

  -- Upsert again (sage) — previous xero config should be disabled
  select * into v_config_row from public.accounting_upsert_export_config(
    p_tenant_id     => v_tenant_a_id,
    p_export_mode   => 'sage',
    p_format_version => 'sage_intacct_gl_csv_v1',
    p_created_by    => 'admin@wynne-rental.dev'
  );

  if v_config_row.export_mode <> 'sage' then
    raise exception 'Expected export_mode=sage after re-upsert, got %', v_config_row.export_mode;
  end if;

  -- Old xero config should now be disabled
  select count(*) into v_count
  from public.accounting_export_config
  where tenant_id = v_tenant_a_id and enabled = true;
  if v_count <> 1 then
    raise exception 'Expected exactly 1 active export config after re-upsert, got %', v_count;
  end if;

  select count(*) into v_count
  from public.accounting_export_config
  where tenant_id = v_tenant_a_id and enabled = false;
  if v_count <> 1 then
    raise exception 'Expected 1 disabled (old) export config, got %', v_count;
  end if;

  -- export_only mode
  select * into v_config_row from public.accounting_upsert_export_config(
    p_tenant_id     => v_tenant_a_id,
    p_export_mode   => 'export_only',
    p_format_version => 'export_only_v1',
    p_notes         => 'For accountant hand-off'
  );
  if v_config_row.export_mode <> 'export_only' then
    raise exception 'Expected export_mode=export_only, got %', v_config_row.export_mode;
  end if;
  if v_config_row.notes <> 'For accountant hand-off' then
    raise exception 'Expected notes to be set, got %', v_config_row.notes;
  end if;

  -- ---------------------------------------------------------------------------
  -- accounting_record_export_run RPC (service_role)
  -- ---------------------------------------------------------------------------

  -- Get active config id for tenant A
  select id into v_config_id
  from public.accounting_export_config
  where tenant_id = v_tenant_a_id and enabled = true;

  select * into v_run_row from public.accounting_record_export_run(
    p_tenant_id       => v_tenant_a_id,
    p_export_config_id => v_config_id,
    p_export_mode     => 'export_only',
    p_format_version  => 'export_only_v1',
    p_period_start    => '2026-06-01',
    p_period_end      => '2026-06-30',
    p_basis           => 'accrual',
    p_triggered_by    => 'admin@wynne-rental.dev',
    p_row_count       => 42,
    p_artifact_status => 'complete'
  );

  if v_run_row.row_count <> 42 then
    raise exception 'Expected row_count=42, got %', v_run_row.row_count;
  end if;
  if v_run_row.artifact_status <> 'complete' then
    raise exception 'Expected artifact_status=complete, got %', v_run_row.artifact_status;
  end if;
  if v_run_row.period_start <> '2026-06-01'::date then
    raise exception 'Expected period_start=2026-06-01, got %', v_run_row.period_start;
  end if;

  -- Record an empty run
  select * into v_run_row from public.accounting_record_export_run(
    p_tenant_id       => v_tenant_a_id,
    p_export_config_id => v_config_id,
    p_export_mode     => 'export_only',
    p_format_version  => 'export_only_v1',
    p_period_start    => '2026-05-01',
    p_period_end      => '2026-05-31',
    p_basis           => 'all',
    p_triggered_by    => 'manager@wynne-rental.dev',
    p_row_count       => 0,
    p_artifact_status => 'empty'
  );
  if v_run_row.artifact_status <> 'empty' then
    raise exception 'Expected artifact_status=empty, got %', v_run_row.artifact_status;
  end if;

  -- Two runs recorded for tenant A
  select count(*) into v_count
  from public.accounting_export_runs
  where tenant_id = v_tenant_a_id;
  if v_count <> 2 then
    raise exception 'Expected 2 export runs for tenant A, got %', v_count;
  end if;

  -- ---------------------------------------------------------------------------
  -- RLS: tenant isolation for accounting_export_config
  -- ---------------------------------------------------------------------------

  -- Seed a config for tenant B
  perform public.accounting_upsert_export_config(
    p_tenant_id     => v_tenant_b_id,
    p_export_mode   => 'xero',
    p_format_version => 'xero_csv_v1'
  );

  -- admin from tenant A should see only their config
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'admin',
        'tenant', 'export-config-tenant-a'
      )
    )::text,
    true
  );

  select count(*) into v_count
  from public.accounting_export_config
  where enabled = true;
  if v_count <> 1 then
    raise exception 'Expected tenant A admin to see only 1 active config (their own), got %', v_count;
  end if;

  -- branch_manager can read config
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'branch_manager',
        'tenant', 'export-config-tenant-a'
      )
    )::text,
    true
  );

  select count(*) into v_count
  from public.accounting_export_config
  where enabled = true;
  if v_count <> 1 then
    raise exception 'Expected branch_manager to see 1 active config, got %', v_count;
  end if;

  -- read_only role cannot see export config
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'read_only',
        'tenant', 'export-config-tenant-a'
      )
    )::text,
    true
  );

  select count(*) into v_count
  from public.accounting_export_config;
  if v_count <> 0 then
    raise exception 'Expected read_only role to see 0 export config rows, got %', v_count;
  end if;

  -- anon cannot see export config
  execute 'set local role anon';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  v_caught := false;
  begin
    select count(*) into v_count
    from public.accounting_export_config;
  exception
    when insufficient_privilege then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon SELECT on accounting_export_config';
  end if;

  -- ---------------------------------------------------------------------------
  -- RLS: tenant isolation for accounting_export_runs
  -- ---------------------------------------------------------------------------

  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'admin',
        'tenant', 'export-config-tenant-a'
      )
    )::text,
    true
  );

  -- Tenant A admin sees only their own runs
  select count(*) into v_count
  from public.accounting_export_runs;
  if v_count <> 2 then
    raise exception 'Expected tenant A admin to see 2 export runs (theirs), got %', v_count;
  end if;

  -- Tenant B has no runs yet — their admin sees zero
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'admin',
        'tenant', 'export-config-tenant-b'
      )
    )::text,
    true
  );

  select count(*) into v_count
  from public.accounting_export_runs;
  if v_count <> 0 then
    raise exception 'Expected tenant B to see 0 export runs, got %', v_count;
  end if;

  -- ---------------------------------------------------------------------------
  -- Write-denial checks: authenticated admin CANNOT directly insert/update
  -- (all config writes must go through the service-role RPC)
  -- ---------------------------------------------------------------------------

  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'admin',
        'tenant', 'export-config-tenant-a'
      )
    )::text,
    true
  );

  -- Direct INSERT by authenticated admin must be denied (no insert grant)
  v_caught := false;
  begin
    insert into public.accounting_export_config (
      tenant_id, export_mode, format_version
    ) values (
      v_tenant_a_id, 'xero', 'xero_csv_v1'
    );
  exception
    when insufficient_privilege then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected insufficient_privilege for direct authenticated INSERT on accounting_export_config';
  end if;

  -- Direct UPDATE by authenticated admin must be denied (no update grant)
  v_caught := false;
  begin
    update public.accounting_export_config
      set notes = 'tamper'
    where tenant_id = v_tenant_a_id;
  exception
    when insufficient_privilege then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected insufficient_privilege for direct authenticated UPDATE on accounting_export_config';
  end if;

  -- Verify the service-role RPC write path still works after role reset
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  select * into v_config_row from public.accounting_upsert_export_config(
    p_tenant_id      => v_tenant_a_id,
    p_export_mode    => 'xero',
    p_format_version => 'xero_csv_v1',
    p_created_by     => 'admin@wynne-rental.dev'
  );
  if v_config_row.export_mode <> 'xero' then
    raise exception 'Expected RPC upsert to succeed as service_role, got export_mode=%', v_config_row.export_mode;
  end if;

  -- ---------------------------------------------------------------------------
  -- Constraint checks
  -- ---------------------------------------------------------------------------

  execute 'set local role service_role';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  -- Invalid export_mode rejected
  v_caught := false;
  begin
    insert into public.accounting_export_config (
      tenant_id, export_mode, format_version
    ) values (
      v_tenant_a_id, 'quickbooks', 'qbo_v1'
    );
  exception
    when check_violation then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected check_violation for invalid export_mode "quickbooks"';
  end if;

  -- Invalid format_version rejected
  v_caught := false;
  begin
    insert into public.accounting_export_config (
      tenant_id, export_mode, format_version
    ) values (
      v_tenant_a_id, 'xero', 'xero_unknown_v999'
    );
  exception
    when check_violation then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected check_violation for invalid format_version "xero_unknown_v999"';
  end if;

  -- Period end before start rejected in export_runs
  v_caught := false;
  begin
    insert into public.accounting_export_runs (
      tenant_id, export_mode, format_version, period_start, period_end,
      basis, triggered_by, row_count, artifact_status
    ) values (
      v_tenant_a_id, 'export_only', 'export_only_v1',
      '2026-06-30', '2026-06-01',
      'all', 'admin@wynne-rental.dev', 0, 'empty'
    );
  exception
    when check_violation then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected check_violation for period_end < period_start';
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;

rollback;
