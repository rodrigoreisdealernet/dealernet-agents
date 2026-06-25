-- Reset-path assertions for project equipment cost rollups + budget variance
-- (migration 20260613200000_project_equipment_cost_rollups.sql).
--
-- Runs against a fully rebuilt schema + seed dataset after `supabase db reset`.
-- Confirms the rebuilt database still exposes:
--   - seeded job-site rollup rows
--   - operator-visible budget/actual/variance values
--   - owned-vs-external cost split and lifecycle line counts

begin;

do $$
declare
  v_seeded_job_site_rows bigint;
  v_owned_asset_id       uuid;
  v_leased_asset_id      uuid;
  v_job_site_id          uuid := gen_random_uuid();
  v_contract_id          uuid := gen_random_uuid();
  v_line_owned_id        uuid := gen_random_uuid();
  v_line_leased_id       uuid := gen_random_uuid();
  v_row                  record;
begin
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"service_role","sub":"00000000-0000-0000-0000-00000000c801","app_metadata":{"role":"admin","tenant":"default"}}',
    true
  );

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_project_equipment_cost_rollups'
  ) then
    raise exception 'FAIL 1: v_project_equipment_cost_rollups missing after reset';
  end if;

  select count(*)
  into v_seeded_job_site_rows
  from public.v_project_equipment_cost_rollups v
  join public.entities e on e.id = v.job_site_id
  where e.entity_type = 'job_site'
    and e.source_record_id like 'demo-baseline-job-site-primary-%';

  if v_seeded_job_site_rows < 1 then
    raise exception 'FAIL 2: expected seeded job-site rollup rows after reset, got %', v_seeded_job_site_rows;
  end if;

  select id
  into v_owned_asset_id
  from public.entities
  where entity_type = 'asset'
    and source_record_id = 'demo-baseline-asset-001';

  if v_owned_asset_id is null then
    raise exception 'FAIL 3: missing seeded owned asset demo-baseline-asset-001';
  end if;

  select id
  into v_leased_asset_id
  from public.entities
  where entity_type = 'asset'
    and source_record_id = 'demo-baseline-asset-031';

  if v_leased_asset_id is null then
    raise exception 'FAIL 4: missing seeded leased asset demo-baseline-asset-031';
  end if;

  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_job_site_id, 'job_site', 'project-rollup-reset-job-site'),
    (v_contract_id, 'rental_contract', 'project-rollup-reset-contract'),
    (v_line_owned_id, 'rental_contract_line', 'project-rollup-reset-line-owned'),
    (v_line_leased_id, 'rental_contract_line', 'project-rollup-reset-line-leased')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_job_site_id,
      1,
      true,
      '{"name":"Project Rollup Reset Site","tenant":"default","equipment_budget":15000}'::jsonb,
      now()
    ),
    (
      v_contract_id,
      1,
      true,
      jsonb_build_object(
        'name', 'Project Rollup Reset Contract',
        'tenant', 'default',
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
      v_line_leased_id,
      1,
      true,
      jsonb_build_object(
        'contract_id', v_contract_id::text,
        'job_site_id', v_job_site_id::text,
        'asset_id', v_leased_asset_id::text,
        'status', 'returned',
        'rate_type', 'weekly',
        'rate_amount', 700,
        'actual_start', to_char(now() - interval '8 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'actual_end', to_char(now() - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  select *
  into v_row
  from public.v_project_equipment_cost_rollups
  where project_name = 'Project Rollup Reset Site';

  if not found then
    raise exception 'FAIL 5: expected Project Rollup Reset Site row after reset';
  end if;
  if v_row.project_equipment_budget <> 15000 then
    raise exception 'FAIL 5a: project_equipment_budget expected 15000, got %', v_row.project_equipment_budget;
  end if;
  if v_row.actual_equipment_cost <> 1700 then
    raise exception 'FAIL 5b: actual_equipment_cost expected 1700, got %', v_row.actual_equipment_cost;
  end if;
  if v_row.budget_variance <> 13300 then
    raise exception 'FAIL 5c: budget_variance expected 13300, got %', v_row.budget_variance;
  end if;
  if v_row.owned_equipment_cost <> 1000 then
    raise exception 'FAIL 5d: owned_equipment_cost expected 1000, got %', v_row.owned_equipment_cost;
  end if;
  if v_row.external_rental_equipment_cost <> 700 then
    raise exception 'FAIL 5e: external_rental_equipment_cost expected 700, got %', v_row.external_rental_equipment_cost;
  end if;
  if v_row.on_rent_line_count <> 1 then
    raise exception 'FAIL 5f: on_rent_line_count expected 1, got %', v_row.on_rent_line_count;
  end if;
  if v_row.off_rent_line_count <> 1 then
    raise exception 'FAIL 5g: off_rent_line_count expected 1, got %', v_row.off_rent_line_count;
  end if;
  if v_row.allocation_line_count <> 2 then
    raise exception 'FAIL 5h: allocation_line_count expected 2, got %', v_row.allocation_line_count;
  end if;
end;
$$;

rollback;
