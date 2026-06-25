-- Behavioral SQL tests for project equipment cost rollups + budget variance
-- (migration 20260613200000_project_equipment_cost_rollups.sql)

begin;

do $$
declare
  v_job_site_id          uuid := gen_random_uuid();
  v_job_site_empty_id    uuid := gen_random_uuid();
  v_contract_id          uuid := gen_random_uuid();
  v_line_owned_id        uuid := gen_random_uuid();
  v_line_rented_id       uuid := gen_random_uuid();
  v_owned_asset_id       uuid := gen_random_uuid();
  v_rented_asset_id      uuid := gen_random_uuid();
begin
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_job_site_id, 'job_site', 'project-rollup-job-site'),
    (v_job_site_empty_id, 'job_site', 'project-rollup-job-site-empty'),
    (v_contract_id, 'rental_contract', 'project-rollup-contract'),
    (v_line_owned_id, 'rental_contract_line', 'project-rollup-line-owned'),
    (v_line_rented_id, 'rental_contract_line', 'project-rollup-line-rented'),
    (v_owned_asset_id, 'asset', 'project-rollup-asset-owned'),
    (v_rented_asset_id, 'asset', 'project-rollup-asset-rented')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_job_site_id, 1, true, '{"name":"Project Rollup Site","tenant":"project-rollup-test","equipment_budget":150000}'::jsonb, now()),
    (v_job_site_empty_id, 1, true, '{"name":"Project Rollup Empty","tenant":"project-rollup-test","equipment_budget":5000}'::jsonb, now()),
    (v_owned_asset_id, 1, true, '{"name":"Owned Excavator","tenant":"project-rollup-test","ownership_type":"owned"}'::jsonb, now()),
    (v_rented_asset_id, 1, true, '{"name":"Rented Compressor","tenant":"project-rollup-test","ownership_type":"leased"}'::jsonb, now()),
    (
      v_contract_id,
      1,
      true,
      jsonb_build_object(
        'name', 'Project Rollup Contract',
        'tenant', 'project-rollup-test',
        'job_site_id', v_job_site_id::text,
        'reporting_currency_code', 'USD',
        'fx_rate_applied', 1
      ),
      now()
    ),
    (
      v_line_owned_id,
      1,
      true,
      jsonb_build_object(
        'contract_id', v_contract_id::text,
        'job_site_id', v_job_site_id::text,
        'asset_id', v_owned_asset_id::text,
        'status', 'checked_out',
        'rate_type', 'daily',
        'rate_amount', 500,
        'actual_start', to_char(now() - interval '4 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'actual_end', to_char(now() - interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ),
      now()
    ),
    (
      v_line_rented_id,
      1,
      true,
      jsonb_build_object(
        'contract_id', v_contract_id::text,
        'job_site_id', v_job_site_id::text,
        'asset_id', v_rented_asset_id::text,
        'status', 'returned',
        'rate_type', 'weekly',
        'rate_amount', 700,
        'actual_start', to_char(now() - interval '8 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'actual_end', to_char(now() - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_project_equipment_cost_rollups'
  ) then
    raise exception 'FAIL 1: v_project_equipment_cost_rollups not created';
  end if;

  if not (
    select coalesce('security_invoker=true' = any(c.reloptions), false)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_project_equipment_cost_rollups'
  ) then
    raise exception 'FAIL 2: v_project_equipment_cost_rollups missing security_invoker=true';
  end if;
end;
$$;

do $$
declare
  v_row record;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000c701","app_metadata":{"role":"branch_manager","tenant":"project-rollup-test"}}',
    true
  );

  select *
  into v_row
  from public.v_project_equipment_cost_rollups
  where project_name = 'Project Rollup Site';

  if not found then
    raise exception 'FAIL 3: expected Project Rollup Site row';
  end if;

  if v_row.actual_equipment_cost <> 1700 then
    raise exception 'FAIL 3a: actual_equipment_cost expected 1700, got %', v_row.actual_equipment_cost;
  end if;
  if v_row.owned_equipment_cost <> 1000 then
    raise exception 'FAIL 3b: owned_equipment_cost expected 1000, got %', v_row.owned_equipment_cost;
  end if;
  if v_row.external_rental_equipment_cost <> 700 then
    raise exception 'FAIL 3c: external_rental_equipment_cost expected 700, got %', v_row.external_rental_equipment_cost;
  end if;
  if v_row.budget_variance <> 148300 then
    raise exception 'FAIL 3d: budget_variance expected 148300, got %', v_row.budget_variance;
  end if;
  if v_row.on_rent_line_count <> 1 then
    raise exception 'FAIL 3e: on_rent_line_count expected 1, got %', v_row.on_rent_line_count;
  end if;
  if v_row.off_rent_line_count <> 1 then
    raise exception 'FAIL 3f: off_rent_line_count expected 1, got %', v_row.off_rent_line_count;
  end if;
  if v_row.allocation_line_count <> 2 then
    raise exception 'FAIL 3g: allocation_line_count expected 2, got %', v_row.allocation_line_count;
  end if;

  select *
  into v_row
  from public.v_project_equipment_cost_rollups
  where project_name = 'Project Rollup Empty';

  if not found then
    raise exception 'FAIL 4: expected Project Rollup Empty row';
  end if;
  if v_row.actual_equipment_cost <> 0 then
    raise exception 'FAIL 4a: empty project actual_equipment_cost expected 0, got %', v_row.actual_equipment_cost;
  end if;
  if v_row.budget_variance <> 5000 then
    raise exception 'FAIL 4b: empty project budget_variance expected 5000, got %', v_row.budget_variance;
  end if;
end;
$$;

do $$
declare
  v_visible_rows bigint;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000c702","app_metadata":{"role":"branch_manager","tenant":"other-tenant"}}',
    true
  );

  select count(*)
  into v_visible_rows
  from public.v_project_equipment_cost_rollups
  where project_name in ('Project Rollup Site', 'Project Rollup Empty');

  if v_visible_rows <> 0 then
    raise exception 'FAIL 5: expected 0 project-rollup-test rows for other-tenant authenticated claim, got %', v_visible_rows;
  end if;
end;
$$;

do $$
begin
  execute 'set local role anon';

  begin
    perform 1
    from public.v_project_equipment_cost_rollups
    limit 1;
    raise exception 'FAIL 6: expected anon select on v_project_equipment_cost_rollups to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end;
$$;

do $$
declare
  v_service_visible_rows bigint;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"service_role","sub":"00000000-0000-0000-0000-00000000c703","app_metadata":{"role":"admin","tenant":"other-tenant"}}',
    true
  );

  select count(*)
  into v_service_visible_rows
  from public.v_project_equipment_cost_rollups
  where project_name in ('Project Rollup Site', 'Project Rollup Empty');

  if v_service_visible_rows <> 2 then
    raise exception 'FAIL 7: expected service_role to read 2 rollup rows across tenant scope, got %', v_service_visible_rows;
  end if;
end;
$$;

rollback;
