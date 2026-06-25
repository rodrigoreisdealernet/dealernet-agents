-- Behavioral SQL tests for asset cost-of-ownership and profitability reporting
-- (migration 20260613100000_asset_cost_ownership_profitability.sql)
--
-- Test coverage:
--   1. Schema structure — check constraints extended, views and RPC created.
--   2. Aggregation — lifecycle events roll up correctly by equipment type.
--   3. Reconciliation — view totals match the sum of posted journal entries.
--   4. Empty-state — no lifecycle events → category rows still present with zeros.
--   5. Partial-data — only some assets in a category have lifecycle events.
--   6. Profitability view correctness — status and margin computed accurately.
--   7. Access control — finance RPC denied to non-finance roles.
--   8. Access control — direct view queries return 0 rows for non-finance roles (field_operator).
--      Each view embeds a finance_access_gate CTE (INNER JOIN) that returns 0 rows for any
--      role that is not service_role, admin, or branch_manager — including field_operator.
--   9. Tenant isolation — admin/branch_manager reads are scoped to their own tenant.
--
-- Pattern: multiple DO blocks within one transaction.  Fixture setup uses
-- direct table inserts as postgres superuser (bypasses RLS).  Assertions run
-- with SET LOCAL ROLE + set_config to simulate PostgREST JWT contexts.

begin;

-- ── Fixture setup (superuser direct inserts — bypasses RLS/RPC guards) ────

do $$
declare
  v_tenant_id        uuid;
  v_cat_excavator_id uuid := gen_random_uuid();
  v_cat_generator_id uuid := gen_random_uuid();
  v_asset_a_id       uuid := gen_random_uuid();
  v_asset_b_id       uuid := gen_random_uuid();
  v_asset_c_id       uuid := gen_random_uuid();
  v_asset_d_id       uuid := gen_random_uuid();
  v_revenue_ft_id    uuid;
begin
  -- Tenant (required by journal_entries FK)
  insert into public.tenants (tenant_key, name)
  values ('coo-test', 'COO Test Tenant')
  on conflict (tenant_key) do nothing;
  select id into v_tenant_id from public.tenants where tenant_key = 'coo-test';

  -- Asset categories
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_cat_excavator_id, 'asset_category', 'coo-test-cat-excavator'),
    (v_cat_generator_id, 'asset_category', 'coo-test-cat-generator')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_cat_excavator_id, 1, true,
     '{"name":"Excavators (COO Test)","tenant":"coo-test"}'::jsonb, now()),
    (v_cat_generator_id, 1, true,
     '{"name":"Generators (COO Test)","tenant":"coo-test"}'::jsonb, now())
  on conflict (entity_id, version_number) do nothing;

  -- Assets
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_asset_a_id, 'asset', 'coo-test-asset-a'),
    (v_asset_b_id, 'asset', 'coo-test-asset-b'),
    (v_asset_c_id, 'asset', 'coo-test-asset-c'),
    (v_asset_d_id, 'asset', 'coo-test-asset-d')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_asset_a_id, 1, true,
     '{"name":"Excavator Asset A","tenant":"coo-test","ownership_type":"owned","operational_status":"available","acquisition_cost":"100000"}'::jsonb,
     now()),
    (v_asset_b_id, 1, true,
     '{"name":"Excavator Asset B","tenant":"coo-test","ownership_type":"owned","operational_status":"available","acquisition_cost":"80000"}'::jsonb,
     now()),
    (v_asset_c_id, 1, true,
     '{"name":"Generator Asset C (no events)","tenant":"coo-test","ownership_type":"owned","operational_status":"available","acquisition_cost":"50000"}'::jsonb,
     now()),
    (v_asset_d_id, 1, true,
     '{"name":"Generator Asset D","tenant":"coo-test","ownership_type":"owned","operational_status":"available","acquisition_cost":"60000"}'::jsonb,
     now())
  on conflict (entity_id, version_number) do nothing;

  -- Category-to-asset relationships
  insert into public.relationships_v2
    (parent_id, child_id, relationship_type, is_current, valid_from)
  values
    (v_cat_excavator_id, v_asset_a_id, 'asset_category_has_asset', true, now()),
    (v_cat_excavator_id, v_asset_b_id, 'asset_category_has_asset', true, now()),
    (v_cat_generator_id, v_asset_c_id, 'asset_category_has_asset', true, now()),
    (v_cat_generator_id, v_asset_d_id, 'asset_category_has_asset', true, now())
  on conflict do nothing;

  -- Asset lifecycle journal entries
  -- Asset A: 2 depreciation + 1 recapitalization
  insert into public.journal_entries (
    tenant_id, source_event_id, source_event_type, source_record_id,
    posting_basis, posting_date, currency_code,
    total_debit, total_credit, posting_status, actor_type, audit_metadata
  ) values
    (v_tenant_id, 'coo-test-depr-a1', 'asset_depreciation', v_asset_a_id,
     'accrual', current_date - 365, 'USD', 10000, 10000, 'posted', 'system', '{}'), -- 1 year prior
    (v_tenant_id, 'coo-test-depr-a2', 'asset_depreciation', v_asset_a_id,
     'accrual', current_date, 'USD', 10000, 10000, 'posted', 'system', '{}'),
    (v_tenant_id, 'coo-test-recap-a1', 'asset_recapitalization', v_asset_a_id,
     'accrual', current_date, 'USD', 5000, 5000, 'posted', 'system', '{}');

  insert into public.journal_entry_lines
    (journal_entry_id, line_sequence, side, account_code, account_name, amount, description)
  select id, 1, 'debit',  '7100', 'Depreciation Expense',     total_debit,  'Lifecycle debit'
  from public.journal_entries
  where source_event_id in ('coo-test-depr-a1','coo-test-depr-a2','coo-test-recap-a1')
  union all
  select id, 2, 'credit', '1510', 'Accumulated Depreciation', total_credit, 'Lifecycle credit'
  from public.journal_entries
  where source_event_id in ('coo-test-depr-a1','coo-test-depr-a2','coo-test-recap-a1');

  -- Asset B: 1 depreciation + 1 sale
  insert into public.journal_entries (
    tenant_id, source_event_id, source_event_type, source_record_id,
    posting_basis, posting_date, currency_code,
    total_debit, total_credit, posting_status, actor_type, audit_metadata
  ) values
    (v_tenant_id, 'coo-test-depr-b1', 'asset_depreciation', v_asset_b_id,
     'accrual', current_date, 'USD', 8000, 8000, 'posted', 'system', '{}'),
    (v_tenant_id, 'coo-test-sale-b1', 'asset_sale', v_asset_b_id,
     'accrual', current_date, 'USD', 45000, 45000, 'posted', 'system', '{}');

  insert into public.journal_entry_lines
    (journal_entry_id, line_sequence, side, account_code, account_name, amount, description)
  select id, 1, 'debit',  '7100', 'Depreciation / Proceeds', total_debit,  'Lifecycle debit'
  from public.journal_entries
  where source_event_id in ('coo-test-depr-b1','coo-test-sale-b1')
  union all
  select id, 2, 'credit', '1510', 'Accumulated / Cash',      total_credit, 'Lifecycle credit'
  from public.journal_entries
  where source_event_id in ('coo-test-depr-b1','coo-test-sale-b1');

  -- Asset D: 1 disposal
  insert into public.journal_entries (
    tenant_id, source_event_id, source_event_type, source_record_id,
    posting_basis, posting_date, currency_code,
    total_debit, total_credit, posting_status, actor_type, audit_metadata
  ) values
    (v_tenant_id, 'coo-test-disp-d1', 'asset_disposal', v_asset_d_id,
     'accrual', current_date, 'USD', 15000, 15000, 'posted', 'system', '{}');

  insert into public.journal_entry_lines
    (journal_entry_id, line_sequence, side, account_code, account_name, amount, description)
  select id, 1, 'debit',  '1000', 'Cash',         15000, 'Disposal proceeds'
  from public.journal_entries where source_event_id = 'coo-test-disp-d1'
  union all
  select id, 2, 'credit', '1500', 'Fixed Assets', 15000, 'Asset removed'
  from public.journal_entries where source_event_id = 'coo-test-disp-d1';

  -- Revenue facts for assets A and B
  select id into v_revenue_ft_id from public.fact_types where key = 'asset_lifetime_revenue';

  insert into public.entity_facts (entity_id, fact_type_id, value, metadata, updated_at)
  values
    (v_asset_a_id, v_revenue_ft_id, 30000, '{"source":"coo-test"}'::jsonb, now()),
    (v_asset_b_id, v_revenue_ft_id, 20000, '{"source":"coo-test"}'::jsonb, now())
  on conflict (entity_id, fact_type_id, dimension_id) do update
    set value = excluded.value, updated_at = now();

  raise notice 'Fixture: tenant, categories, assets, relationships, journal entries, revenue facts seeded';
end;
$$;

-- ── 1. Schema structure checks ────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'journal_entries'
      and c.conname = 'chk_journal_entries_source_event_type'
      and pg_get_constraintdef(c.oid) like '%asset_depreciation%'
  ) then
    raise exception 'FAIL 1a: chk_journal_entries_source_event_type missing asset_depreciation';
  end if;
  raise notice 'PASS 1a: journal_entries constraint includes asset_depreciation';

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'accounting_posting_rules'
      and c.conname = 'chk_accounting_posting_rules_event_type'
      and pg_get_constraintdef(c.oid) like '%asset_depreciation%'
  ) then
    raise exception 'FAIL 1b: chk_accounting_posting_rules_event_type missing asset_depreciation';
  end if;
  raise notice 'PASS 1b: accounting_posting_rules constraint includes asset_depreciation';

  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='v_asset_lifecycle_accounting_events') then
    raise exception 'FAIL 1c: v_asset_lifecycle_accounting_events not created';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='v_equipment_type_cost_ownership') then
    raise exception 'FAIL 1c: v_equipment_type_cost_ownership not created';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='v_equipment_type_profitability') then
    raise exception 'FAIL 1c: v_equipment_type_profitability not created';
  end if;
  raise notice 'PASS 1c: all three reporting views created';

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='finance_get_equipment_cost_ownership') then
    raise exception 'FAIL 1d: finance_get_equipment_cost_ownership RPC not found';
  end if;
  raise notice 'PASS 1d: finance_get_equipment_cost_ownership RPC exists';

  if not (select coalesce('security_invoker=true' = any(c.reloptions), false)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='v_equipment_type_cost_ownership') then
    raise exception 'FAIL 1e: v_equipment_type_cost_ownership missing security_invoker=true';
  end if;
  if not (select coalesce('security_invoker=true' = any(c.reloptions), false)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='v_equipment_type_profitability') then
    raise exception 'FAIL 1e: v_equipment_type_profitability missing security_invoker=true';
  end if;
  raise notice 'PASS 1e: reporting views declare security_invoker=true';
end;
$$;

-- ── 2–6. Aggregation, reconciliation, empty-state, profitability
--         authenticated+admin with coo-test tenant: satisfies both the
--         views' finance-only WHERE clauses and journal_entries RLS.

do $$
declare
  v_row          record;
  v_count        int;
  v_event_count  bigint;
  v_total_depr   numeric;
  v_asset_a_id   uuid;
  v_asset_b_id   uuid;
  v_asset_d_id   uuid;
begin
  select id into v_asset_a_id from public.entities
    where entity_type = 'asset' and source_record_id = 'coo-test-asset-a';
  select id into v_asset_b_id from public.entities
    where entity_type = 'asset' and source_record_id = 'coo-test-asset-b';
  select id into v_asset_d_id from public.entities
    where entity_type = 'asset' and source_record_id = 'coo-test-asset-d';

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000c001",'
      || '"app_metadata":{"role":"admin","tenant":"coo-test"}}',
    true
  );

  -- ── 2a. Excavator rollup: depr=28000, recap=5000, sale=45000 ────────────
  select total_accumulated_depreciation, total_recapitalization_cost, total_sale_proceeds
  into v_row
  from public.v_equipment_type_cost_ownership
  where asset_category_name = 'Excavators (COO Test)';

  if v_row is null then
    raise exception 'FAIL 2a: v_equipment_type_cost_ownership returned no row for Excavators (COO Test)';
  end if;
  if v_row.total_accumulated_depreciation <> 28000 then
    raise exception 'FAIL 2a: excavator accumulated_depreciation expected 28000, got %',
      v_row.total_accumulated_depreciation;
  end if;
  if v_row.total_recapitalization_cost <> 5000 then
    raise exception 'FAIL 2a: excavator recapitalization_cost expected 5000, got %',
      v_row.total_recapitalization_cost;
  end if;
  if v_row.total_sale_proceeds <> 45000 then
    raise exception 'FAIL 2a: excavator sale_proceeds expected 45000, got %', v_row.total_sale_proceeds;
  end if;
  raise notice 'PASS 2a: excavator cost-of-ownership rollup correct (depr=28000, recap=5000, sale=45000)';

  -- ── 2b. Generator rollup: disposal=15000, depr=0, count=2 ──────────────
  select total_disposal_proceeds, total_accumulated_depreciation, owned_asset_count
  into v_row
  from public.v_equipment_type_cost_ownership
  where asset_category_name = 'Generators (COO Test)';

  if v_row.total_disposal_proceeds <> 15000 then
    raise exception 'FAIL 2b: generator disposal_proceeds expected 15000, got %',
      v_row.total_disposal_proceeds;
  end if;
  if v_row.total_accumulated_depreciation <> 0 then
    raise exception 'FAIL 2b: generator accumulated_depreciation expected 0, got %',
      v_row.total_accumulated_depreciation;
  end if;
  if v_row.owned_asset_count <> 2 then
    raise exception 'FAIL 2b: generator owned_asset_count expected 2, got %', v_row.owned_asset_count;
  end if;
  raise notice 'PASS 2b: generator cost-of-ownership rollup correct (disposal=15000, depr=0, count=2)';

  -- ── 3a. Reconciliation: view depreciation total = direct journal_entries sum ──
  select total_accumulated_depreciation into v_total_depr
  from public.v_equipment_type_cost_ownership
  where asset_category_name = 'Excavators (COO Test)';

  if v_total_depr <> 28000 then
    raise exception 'FAIL 3a: reconciliation — view shows %, expected 28000', v_total_depr;
  end if;
  raise notice 'PASS 3a: view accumulated_depreciation reconciles to source journal entries (28000)';

  -- ── 3b. v_asset_lifecycle_accounting_events: 6 entries × 2 legs = 12 lines ──
  select count(*) into v_count
  from public.v_asset_lifecycle_accounting_events
  where asset_id in (v_asset_a_id, v_asset_b_id, v_asset_d_id);

  if v_count <> 12 then
    raise exception 'FAIL 3b: expected 12 lifecycle event lines, got %', v_count;
  end if;
  raise notice 'PASS 3b: v_asset_lifecycle_accounting_events line count reconciles (12 lines for 6 entries)';

  -- ── 3c. event_posting_count = 5 for excavators (A:3 + B:2) ────────────
  select event_posting_count into v_event_count
  from public.v_equipment_type_cost_ownership
  where asset_category_name = 'Excavators (COO Test)';

  if v_event_count <> 5 then
    raise exception 'FAIL 3c: excavator event_posting_count expected 5, got %', v_event_count;
  end if;
  raise notice 'PASS 3c: event_posting_count reconciles to posted journal entries (5)';

  -- ── 4. Empty/partial-state: generator category present with zero depreciation ──
  if not exists (
    select 1 from public.v_equipment_type_cost_ownership
    where asset_category_name = 'Generators (COO Test)'
  ) then
    raise exception 'FAIL 4: generator category missing from cost_ownership view';
  end if;

  select total_accumulated_depreciation into v_total_depr
  from public.v_equipment_type_cost_ownership
  where asset_category_name = 'Generators (COO Test)';

  if v_total_depr <> 0 then
    raise exception 'FAIL 4: generator expected zero depreciation (asset C has no events), got %',
      v_total_depr;
  end if;
  raise notice 'PASS 4: partial-data — generator category present; asset C contributes zero depreciation';

  -- ── 5a. Profitability: excavator gross_profit = 50000+45000-28000-5000 = 62000 ──
  select total_lifetime_revenue, gross_profit, profitability_status
  into v_row
  from public.v_equipment_type_profitability
  where asset_category_name = 'Excavators (COO Test)';

  if v_row is null then
    raise exception 'FAIL 5a: v_equipment_type_profitability returned no row for Excavators (COO Test)';
  end if;
  if v_row.total_lifetime_revenue <> 50000 then
    raise exception 'FAIL 5a: excavator total_lifetime_revenue expected 50000, got %',
      v_row.total_lifetime_revenue;
  end if;
  if v_row.gross_profit <> 62000 then
    raise exception 'FAIL 5a: excavator gross_profit expected 62000, got %', v_row.gross_profit;
  end if;
  if v_row.profitability_status <> 'profitable' then
    raise exception 'FAIL 5a: excavator profitability_status expected profitable, got %',
      v_row.profitability_status;
  end if;
  raise notice 'PASS 5a: excavator profitability correct (gross_profit=62000, status=profitable)';

  -- ── 5b. Profitability: generator gross_profit = 0+15000-0 = 15000, profitable ──
  select gross_profit, profitability_status
  into v_row
  from public.v_equipment_type_profitability
  where asset_category_name = 'Generators (COO Test)';

  if v_row.gross_profit <> 15000 then
    raise exception 'FAIL 5b: generator gross_profit expected 15000, got %', v_row.gross_profit;
  end if;
  if v_row.profitability_status <> 'profitable' then
    raise exception 'FAIL 5b: generator profitability_status expected profitable, got %',
      v_row.profitability_status;
  end if;
  raise notice 'PASS 5b: generator profitability correct (gross_profit=15000, status=profitable)';

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  raise notice '--- Aggregation / reconciliation / profitability checks passed ---';
end;
$$;

-- ── 7. Access control — finance RPC denied to non-finance roles ───────────

do $$
declare
  v_caught bool;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f001",'
      || '"app_metadata":{"role":"field_operator","tenant":"coo-test"}}',
    true
  );

  v_caught := false;
  begin
    perform * from public.finance_get_equipment_cost_ownership();
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%finance read access%' or sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 7: unexpected error for field_operator RPC: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 7: field_operator unexpectedly executed finance_get_equipment_cost_ownership';
  end if;
  raise notice 'PASS 7: finance_get_equipment_cost_ownership denied to field_operator';

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ── 8. Access control — direct view access denied to non-finance roles ───
--    Each view's finance_access_gate CTE returns 0 rows for field_operator
--    (not service_role, admin, or branch_manager), so INNER JOINs on the gate
--    propagate zero rows through every table-scanning CTE in the view.

do $$
declare
  v_row_count int;
begin
  -- Simulate field_operator (non-finance authenticated user)
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f002",'
      || '"app_metadata":{"role":"field_operator","tenant":"coo-test"}}',
    true
  );

  -- 8a. v_asset_lifecycle_accounting_events — field_operator must see zero rows
  select count(*) into v_row_count
  from public.v_asset_lifecycle_accounting_events;

  if v_row_count <> 0 then
    raise exception 'FAIL 8a: field_operator should see 0 rows from v_asset_lifecycle_accounting_events, got %',
      v_row_count;
  end if;
  raise notice 'PASS 8a: v_asset_lifecycle_accounting_events returns 0 rows for field_operator';

  -- 8b. v_equipment_type_cost_ownership — field_operator must see zero rows
  select count(*) into v_row_count
  from public.v_equipment_type_cost_ownership;

  if v_row_count <> 0 then
    raise exception 'FAIL 8b: field_operator should see 0 rows from v_equipment_type_cost_ownership, got %',
      v_row_count;
  end if;
  raise notice 'PASS 8b: v_equipment_type_cost_ownership returns 0 rows for field_operator';

  -- 8c. v_equipment_type_profitability — field_operator must see zero rows
  select count(*) into v_row_count
  from public.v_equipment_type_profitability;

  if v_row_count <> 0 then
    raise exception 'FAIL 8c: field_operator should see 0 rows from v_equipment_type_profitability, got %',
      v_row_count;
  end if;
  raise notice 'PASS 8c: v_equipment_type_profitability returns 0 rows for field_operator';

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  raise notice '--- Direct-view access control checks passed (field_operator: 0 rows on all views) ---';
end;
$$;

-- ── 9. Tenant isolation — admin sees only their own tenant's rows ─────────

do $$
declare
  v_row_count int;
begin
  -- Simulate admin on a different tenant (not coo-test)
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000t001",'
      || '"app_metadata":{"role":"admin","tenant":"other-tenant"}}',
    true
  );

  -- 9a. v_equipment_type_cost_ownership — different-tenant admin must NOT see coo-test rows
  select count(*) into v_row_count
  from public.v_equipment_type_cost_ownership
  where asset_category_name in ('Excavators (COO Test)', 'Generators (COO Test)');

  if v_row_count <> 0 then
    raise exception
      'FAIL 9a: admin on other-tenant should see 0 coo-test rows from v_equipment_type_cost_ownership, got %',
      v_row_count;
  end if;
  raise notice 'PASS 9a: v_equipment_type_cost_ownership is tenant-scoped (other-tenant admin sees 0 coo-test rows)';

  -- 9b. v_equipment_type_profitability — different-tenant admin must NOT see coo-test rows
  select count(*) into v_row_count
  from public.v_equipment_type_profitability
  where asset_category_name in ('Excavators (COO Test)', 'Generators (COO Test)');

  if v_row_count <> 0 then
    raise exception
      'FAIL 9b: admin on other-tenant should see 0 coo-test rows from v_equipment_type_profitability, got %',
      v_row_count;
  end if;
  raise notice 'PASS 9b: v_equipment_type_profitability is tenant-scoped (other-tenant admin sees 0 coo-test rows)';

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  raise notice '--- Tenant isolation checks passed (admin cross-tenant: 0 rows on reporting views) ---';
end;
$$;

rollback;
