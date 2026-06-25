begin;

do $$
declare
  v_fx_seed_rows int;
  v_baseline_invoices int;
  v_ops_invoices int;
  v_baseline_currency_codes int;
  v_ops_currency_codes int;
  v_baseline_non_usd_reporting int;
  v_ops_non_usd_reporting int;
  v_baseline_missing_fx_rates int;
  v_ops_missing_fx_rates int;
  v_baseline_invoice_snapshots int;
  v_ops_invoice_snapshots int;
  v_invoice_002_reporting_total numeric;
  v_invoice_003_reporting_total numeric;
  v_baseline_rollup_tx numeric;
  v_baseline_rollup_reporting numeric;
  v_company_count int;
  v_region_count int;
  v_company_branch_descendants int;
  v_invoice_reporting_lines int;
  v_scoped_invoice_lines int;
  v_company_tx_currency_count int;
  v_detail_reporting_total numeric;
  v_company_rollup_reporting numeric;
  v_region_rollup_reporting numeric;
  v_branch_rollup_reporting numeric;
begin
  select count(*)
    into v_fx_seed_rows
  from fx_rates
  where quote_currency_code = 'USD'
    and effective_at = '2026-01-01T00:00:00Z'::timestamptz
    and base_currency_code in ('USD', 'CAD', 'EUR', 'GBP');

  if v_fx_seed_rows <> 4 then
    raise exception 'Expected seeded FX snapshot rows for USD/CAD/EUR/GBP, found %', v_fx_seed_rows;
  end if;

  select count(*)
    into v_baseline_invoices
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id like 'demo-baseline-invoice-%';

  if v_baseline_invoices <> 8 then
    raise exception 'Expected 8 demo-baseline invoice rollups, found %', v_baseline_invoices;
  end if;

  select count(*)
    into v_ops_invoices
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id like 'demo-ops-invoice-%';

  if v_ops_invoices <> 8 then
    raise exception 'Expected 8 demo-ops invoice rollups, found %', v_ops_invoices;
  end if;

  select count(distinct r.transaction_currency_code)
    into v_baseline_currency_codes
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id like 'demo-baseline-invoice-%';

  select count(distinct r.transaction_currency_code)
    into v_ops_currency_codes
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id like 'demo-ops-invoice-%';

  if v_baseline_currency_codes <> 3 then
    raise exception 'Expected demo-baseline invoices across USD/CAD/EUR, found % distinct transaction currencies', v_baseline_currency_codes;
  end if;

  if v_ops_currency_codes <> 3 then
    raise exception 'Expected demo-ops invoices across USD/CAD/EUR, found % distinct transaction currencies', v_ops_currency_codes;
  end if;

  select count(*)
    into v_baseline_non_usd_reporting
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id like 'demo-baseline-invoice-%'
    and r.reporting_currency_code <> 'USD';

  select count(*)
    into v_ops_non_usd_reporting
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id like 'demo-ops-invoice-%'
    and r.reporting_currency_code <> 'USD';

  if v_baseline_non_usd_reporting <> 0 then
    raise exception 'Expected demo-baseline invoices to report in USD, found % non-USD rows', v_baseline_non_usd_reporting;
  end if;

  if v_ops_non_usd_reporting <> 0 then
    raise exception 'Expected demo-ops invoices to report in USD, found % non-USD rows', v_ops_non_usd_reporting;
  end if;

  select count(*)
    into v_baseline_missing_fx_rates
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id like 'demo-baseline-invoice-%'
    and r.transaction_currency_code <> 'USD'
    and r.fx_rate_source = 'missing';

  select count(*)
    into v_ops_missing_fx_rates
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id like 'demo-ops-invoice-%'
    and r.transaction_currency_code <> 'USD'
    and r.fx_rate_source = 'missing';

  if v_baseline_missing_fx_rates <> 0 then
    raise exception 'Expected non-USD demo-baseline invoices to have resolvable FX rates, found % missing rows', v_baseline_missing_fx_rates;
  end if;

  if v_ops_missing_fx_rates <> 0 then
    raise exception 'Expected non-USD demo-ops invoices to have resolvable FX rates, found % missing rows', v_ops_missing_fx_rates;
  end if;

  select count(*)
    into v_baseline_invoice_snapshots
  from v_commercial_document_currency_snapshots s
  join entities e
    on e.id = s.entity_id
  where s.entity_type = 'invoice'
    and e.source_record_id like 'demo-baseline-invoice-%';

  select count(*)
    into v_ops_invoice_snapshots
  from v_commercial_document_currency_snapshots s
  join entities e
    on e.id = s.entity_id
  where s.entity_type = 'invoice'
    and e.source_record_id like 'demo-ops-invoice-%';

  if v_baseline_invoice_snapshots <> 8 then
    raise exception 'Expected 8 demo-baseline invoice currency snapshots, found %', v_baseline_invoice_snapshots;
  end if;

  if v_ops_invoice_snapshots <> 8 then
    raise exception 'Expected 8 demo-ops invoice currency snapshots, found %', v_ops_invoice_snapshots;
  end if;

  select r.reporting_total_amount
    into v_invoice_002_reporting_total
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id = 'demo-baseline-invoice-002';

  if v_invoice_002_reporting_total <> 4075.92 then
    raise exception 'Expected demo-baseline-invoice-002 reporting_total_amount = 4075.92, got %', v_invoice_002_reporting_total;
  end if;

  select r.reporting_total_amount
    into v_invoice_003_reporting_total
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id = 'demo-baseline-invoice-003';

  if v_invoice_003_reporting_total <> 4473.36 then
    raise exception 'Expected demo-baseline-invoice-003 reporting_total_amount = 4473.36, got %', v_invoice_003_reporting_total;
  end if;

  select round(sum(r.transaction_total_amount), 2), round(sum(r.reporting_total_amount), 2)
    into v_baseline_rollup_tx, v_baseline_rollup_reporting
  from v_invoice_currency_rollups r
  join entities e
    on e.id = r.invoice_id
  where e.source_record_id like 'demo-baseline-invoice-%';

  if v_baseline_rollup_tx <> 31104.00 then
    raise exception 'Expected demo-baseline transaction rollup total = 31104.00, got %', v_baseline_rollup_tx;
  end if;

  if v_baseline_rollup_reporting <> 28396.44 then
    raise exception 'Expected demo-baseline reporting rollup total = 28396.44, got %', v_baseline_rollup_reporting;
  end if;

  select count(*)
    into v_company_count
  from entities
  where entity_type = 'company'
    and source_record_id like 'demo-baseline-company-%';

  select count(*)
    into v_region_count
  from entities
  where entity_type = 'region'
    and source_record_id like 'demo-baseline-region-%';

  if v_company_count <> 1 then
    raise exception 'Expected 1 demo-baseline company, found %', v_company_count;
  end if;

  if v_region_count <> 2 then
    raise exception 'Expected 2 demo-baseline regions, found %', v_region_count;
  end if;

  select count(*)
    into v_company_branch_descendants
  from org_scope_closure osc
  join entities ancestor
    on ancestor.id = osc.ancestor_id
  join entities descendant
    on descendant.id = osc.descendant_id
  where ancestor.source_record_id = 'demo-baseline-company-001'
    and descendant.entity_type = 'branch'
    and osc.depth = 2;

  if v_company_branch_descendants <> 2 then
    raise exception 'Expected company closure to include 2 branch descendants, found %', v_company_branch_descendants;
  end if;

  select count(*),
         count(*) filter (
           where company_scope_id is not null
             and region_scope_id is not null
             and branch_scope_id is not null
         )
    into v_invoice_reporting_lines, v_scoped_invoice_lines
  from v_enterprise_financial_reporting_lines
  where source_entity_type = 'invoice';

  if v_invoice_reporting_lines <> 16 then
    raise exception 'Expected 16 invoice reporting lines across baseline + ops demos, found %', v_invoice_reporting_lines;
  end if;

  if v_scoped_invoice_lines <> 16 then
    raise exception 'Expected all invoice reporting lines to resolve company/region/branch scopes, found % scoped rows', v_scoped_invoice_lines;
  end if;

  perform 1
  from v_enterprise_financial_reporting_lines
  where source_record_id = 'demo-baseline-invoice-002'
    and company_scope_name = 'Dealernet Industrial Rentals'
    and region_scope_name = 'Gulf Coast'
    and branch_scope_name = 'Houston Central'
    and transaction_currency_code = 'CAD'
    and reporting_currency_code = 'USD';

  if not found then
    raise exception 'Expected demo-baseline-invoice-002 to preserve company/region/branch scope and mixed-currency metadata';
  end if;

  select round(sum(reporting_total_amount), 2)
    into v_detail_reporting_total
  from v_enterprise_financial_reporting_lines
  where source_entity_type = 'invoice';

  select round(sum(reporting_total_amount), 2)
    into v_company_rollup_reporting
  from v_enterprise_financial_reporting_rollups
  where scope_type = 'company'
    and source_entity_type = 'invoice';

  select round(sum(reporting_total_amount), 2)
    into v_region_rollup_reporting
  from v_enterprise_financial_reporting_rollups
  where scope_type = 'region'
    and source_entity_type = 'invoice';

  select round(sum(reporting_total_amount), 2)
    into v_branch_rollup_reporting
  from v_enterprise_financial_reporting_rollups
  where scope_type = 'branch'
    and source_entity_type = 'invoice';

  if v_company_rollup_reporting <> v_detail_reporting_total then
    raise exception 'Expected company rollups to equal invoice detail reporting total %, got %', v_detail_reporting_total, v_company_rollup_reporting;
  end if;

  if v_region_rollup_reporting <> v_detail_reporting_total then
    raise exception 'Expected region rollups to equal invoice detail reporting total %, got %', v_detail_reporting_total, v_region_rollup_reporting;
  end if;

  if v_branch_rollup_reporting <> v_detail_reporting_total then
    raise exception 'Expected branch rollups to equal invoice detail reporting total %, got %', v_detail_reporting_total, v_branch_rollup_reporting;
  end if;

  select count(distinct transaction_currency_code)
    into v_company_tx_currency_count
  from v_enterprise_financial_reporting_rollups
  where scope_type = 'company'
    and scope_name = 'Dealernet Industrial Rentals'
    and source_entity_type = 'invoice';

  if v_company_tx_currency_count <> 3 then
    raise exception 'Expected company rollups to preserve 3 transaction currencies, found %', v_company_tx_currency_count;
  end if;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000201","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_reporting_rows bigint;
  v_rollup_rows bigint;
  v_scope_rows bigint;
  v_caught bool;
begin
  select count(*)
    into v_reporting_rows
  from v_enterprise_financial_reporting_lines
  where source_entity_type = 'invoice';

  if v_reporting_rows <> 16 then
    raise exception 'Expected authenticated read on v_enterprise_financial_reporting_lines to return 16 invoice rows, found %', v_reporting_rows;
  end if;

  select count(*)
    into v_rollup_rows
  from v_enterprise_financial_reporting_rollups
  where scope_type in ('company', 'region', 'branch')
    and source_entity_type = 'invoice';

  if v_rollup_rows <= 0 then
    raise exception 'Expected authenticated read on v_enterprise_financial_reporting_rollups to return seeded invoice rows';
  end if;

  select count(*)
    into v_scope_rows
  from org_scope_closure;

  if v_scope_rows <= 0 then
    raise exception 'Expected authenticated read on org_scope_closure to succeed';
  end if;

  v_caught := false;
  begin
    insert into org_scope_closure (ancestor_id, descendant_id, depth)
    select id, id, 0
    from entities
    where source_record_id = 'demo-baseline-company-001';
    raise exception 'Expected authenticated write to org_scope_closure to be denied';
  exception
    when insufficient_privilege then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected authenticated write to org_scope_closure to be blocked';
  end if;
end;
$$;

reset role;

set local role anon;
select set_config(
  'request.jwt.claims',
  '{"role":"anon"}',
  true
);

do $$
declare
  v_dummy bigint;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_dummy from v_enterprise_financial_reporting_lines;
    raise exception 'Expected anon read on v_enterprise_financial_reporting_lines to be denied';
  exception
    when insufficient_privilege then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected anon read on v_enterprise_financial_reporting_lines to be blocked';
  end if;

  v_caught := false;
  begin
    select count(*) into v_dummy from org_scope_closure;
    raise exception 'Expected anon read on org_scope_closure to be denied';
  exception
    when insufficient_privilege then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected anon read on org_scope_closure to be blocked';
  end if;

  v_caught := false;
  begin
    insert into org_scope_closure (ancestor_id, descendant_id, depth)
    select id, id, 0
    from entities
    where source_record_id = 'demo-baseline-company-001';
    raise exception 'Expected anon write to org_scope_closure to be denied';
  exception
    when insufficient_privilege then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected anon write to org_scope_closure to be blocked';
  end if;
end;
$$;

reset role;

rollback;
