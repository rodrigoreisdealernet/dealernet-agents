-- Reset-path assertions for 20260613100000_asset_cost_ownership_profitability.sql
--
-- Confirms that after a full `supabase db reset --config supabase/config.toml`
-- (migrations + seed):
--   1. All three reporting views and the finance RPC are present.
--   2. The extended check constraints accept asset lifecycle event types.
--   3. After inserting minimal fixture data, v_equipment_type_cost_ownership
--      returns equipment-type rows with asset_category_name, depreciation
--      rollup, and formula_reference (source lineage) after a fresh reset.
--   4. v_equipment_type_profitability returns rows with profitability_status
--      and rollup context once lifecycle journal entries are posted.
--   5. The security-invoker gate remains enforced: a non-finance role
--      (field_operator) sees 0 rows from both views.

begin;

do $$
declare
  v_tenant_id     uuid;
  v_cat_id        uuid := gen_random_uuid();
  v_asset_id      uuid := gen_random_uuid();
  v_count         bigint;
  v_category_name text;
  v_total_depr    numeric;
  v_prof_status   text;
  v_formula_ref   text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;

  -- -------------------------------------------------------------------------
  -- 1. Schema objects present after a clean reset
  -- -------------------------------------------------------------------------

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and c.relname = 'v_equipment_type_cost_ownership'
  ) then
    raise exception 'Reset-path check failed: public.v_equipment_type_cost_ownership view missing';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and c.relname = 'v_equipment_type_profitability'
  ) then
    raise exception 'Reset-path check failed: public.v_equipment_type_profitability view missing';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and c.relname = 'v_asset_lifecycle_accounting_events'
  ) then
    raise exception 'Reset-path check failed: public.v_asset_lifecycle_accounting_events view missing';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finance_get_equipment_cost_ownership'
  ) then
    raise exception 'Reset-path check failed: public.finance_get_equipment_cost_ownership RPC missing';
  end if;

  raise notice 'PASS 1: all schema objects present after reset';

  -- -------------------------------------------------------------------------
  -- 2. Extended check constraints accept asset lifecycle event types
  -- -------------------------------------------------------------------------

  begin
    insert into public.journal_entries (
      tenant_id, source_event_id, source_event_type, source_record_id,
      posting_basis, posting_date, currency_code,
      total_debit, total_credit, posting_status, actor_type, audit_metadata
    )
    select
      t.id,
      'coo-reset-probe-' || t.id::text,
      'asset_depreciation',
      null,
      'accrual', current_date, 'USD', 1, 1, 'posted', 'system', '{}'
    from public.tenants t
    limit 1;

    delete from public.journal_entries
    where source_event_id like 'coo-reset-probe-%';
  exception when others then
    raise exception
      'Reset-path check failed: asset_depreciation rejected by journal_entries constraint: %',
      sqlerrm;
  end;

  raise notice 'PASS 2: extended check constraints accept asset lifecycle event types';

  -- -------------------------------------------------------------------------
  -- 3. Fixture: tenant + asset category + asset + journal entries
  -- -------------------------------------------------------------------------

  insert into public.tenants (tenant_key, name)
  values ('coo-reset-test', 'COO Reset Test Tenant')
  on conflict (tenant_key) do nothing;
  select id into v_tenant_id from public.tenants where tenant_key = 'coo-reset-test';

  -- Asset category entity
  insert into public.entities (id, entity_type, source_record_id)
  values (v_cat_id, 'asset_category', 'coo-reset-cat-excavator')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values (
    v_cat_id, 1, true,
    '{"name":"Excavators (COO Reset)","tenant":"coo-reset-test"}'::jsonb,
    now()
  )
  on conflict (entity_id, version_number) do nothing;

  -- Asset entity
  insert into public.entities (id, entity_type, source_record_id)
  values (v_asset_id, 'asset', 'coo-reset-asset-a')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values (
    v_asset_id, 1, true,
    '{"name":"Excavator Reset A","tenant":"coo-reset-test","ownership_type":"owned","operational_status":"available","acquisition_cost":"80000"}'::jsonb,
    now()
  )
  on conflict (entity_id, version_number) do nothing;

  -- Link asset to category (asset_category_has_asset)
  insert into public.relationships_v2 (parent_id, child_id, relationship_type, is_current, valid_from)
  values (v_cat_id, v_asset_id, 'asset_category_has_asset', true, now())
  on conflict do nothing;

  -- Asset lifecycle journal entries: depreciation + sale
  insert into public.journal_entries (
    tenant_id, source_event_id, source_event_type, source_record_id,
    posting_basis, posting_date, currency_code,
    total_debit, total_credit, posting_status, actor_type, audit_metadata
  ) values
    (v_tenant_id, 'coo-reset-depr-a1', 'asset_depreciation', v_asset_id,
     'accrual', current_date - 180, 'USD', 8000, 8000, 'posted', 'system', '{}'),
    (v_tenant_id, 'coo-reset-sale-a1', 'asset_sale', v_asset_id,
     'accrual', current_date - 30, 'USD', 60000, 60000, 'posted', 'system', '{}')
  on conflict do nothing;

  raise notice 'PASS 3: fixture data inserted (tenant, category, asset, journal entries)';

  -- -------------------------------------------------------------------------
  -- 4. v_equipment_type_cost_ownership returns category row with rollup context
  -- -------------------------------------------------------------------------

  select count(*) into v_count
  from public.v_equipment_type_cost_ownership
  where asset_category_name = 'Excavators (COO Reset)';

  if v_count <> 1 then
    raise exception
      'Reset-path check failed: expected 1 row in v_equipment_type_cost_ownership for test category, got %',
      v_count;
  end if;

  select
    asset_category_name,
    total_accumulated_depreciation,
    formula_reference
  into v_category_name, v_total_depr, v_formula_ref
  from public.v_equipment_type_cost_ownership
  where asset_category_name = 'Excavators (COO Reset)';

  if coalesce(v_category_name, '') = '' then
    raise exception
      'Reset-path check failed: v_equipment_type_cost_ownership asset_category_name is empty';
  end if;

  if coalesce(v_total_depr, 0) <= 0 then
    raise exception
      'Reset-path check failed: total_accumulated_depreciation should be > 0, got %',
      v_total_depr;
  end if;

  if coalesce(v_formula_ref, '') = '' then
    raise exception
      'Reset-path check failed: formula_reference is missing from v_equipment_type_cost_ownership';
  end if;

  raise notice 'PASS 4: v_equipment_type_cost_ownership returns category row with rollup and lineage';

  -- -------------------------------------------------------------------------
  -- 5. v_equipment_type_profitability returns row with profitability_status
  -- -------------------------------------------------------------------------

  select count(*) into v_count
  from public.v_equipment_type_profitability
  where asset_category_name = 'Excavators (COO Reset)';

  if v_count <> 1 then
    raise exception
      'Reset-path check failed: expected 1 row in v_equipment_type_profitability for test category, got %',
      v_count;
  end if;

  select profitability_status, formula_reference
  into v_prof_status, v_formula_ref
  from public.v_equipment_type_profitability
  where asset_category_name = 'Excavators (COO Reset)';

  if v_prof_status is null
     or v_prof_status not in ('profitable', 'breakeven', 'unprofitable', 'insufficient_data')
  then
    raise exception
      'Reset-path check failed: profitability_status is invalid or missing: %',
      v_prof_status;
  end if;

  if coalesce(v_formula_ref, '') = '' then
    raise exception
      'Reset-path check failed: formula_reference is missing from v_equipment_type_profitability';
  end if;

  raise notice 'PASS 5: v_equipment_type_profitability returns category row with profitability_status and rollup context';

  -- -------------------------------------------------------------------------
  -- 6. Non-finance role sees 0 rows (security-invoker gate enforced after reset)
  -- -------------------------------------------------------------------------

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-caa700000001",'
      || '"app_metadata":{"role":"field_operator","tenant":"coo-reset-test"}}',
    true
  );

  select count(*) into v_count
  from public.v_equipment_type_cost_ownership
  where asset_category_name = 'Excavators (COO Reset)';

  if v_count <> 0 then
    raise exception
      'Reset-path check failed: field_operator should see 0 rows from v_equipment_type_cost_ownership after reset, got %',
      v_count;
  end if;

  select count(*) into v_count
  from public.v_equipment_type_profitability
  where asset_category_name = 'Excavators (COO Reset)';

  if v_count <> 0 then
    raise exception
      'Reset-path check failed: field_operator should see 0 rows from v_equipment_type_profitability after reset, got %',
      v_count;
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  raise notice 'PASS 6: non-finance role sees 0 rows — security-invoker gate enforced after reset';

  raise notice 'ALL RESET-PATH CHECKS PASSED';
end;
$$;

rollback;
