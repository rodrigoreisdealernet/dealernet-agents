-- Enterprise org hierarchy reset-path seed assertions
-- Verifies that after `supabase db reset` the enterprise org hierarchy
-- migration + seed.sql applied cleanly and the company → region → branch
-- structure, per-scope config, org_scope_closure, and views are all intact.

begin;

do $$
declare
  v_company_id           uuid;
  v_company_count        bigint;
  v_region_count         bigint;
  v_branch_descendants   bigint;
  v_gulf_hierarchy_rows  bigint;
  v_currency             text;
  v_timezone             text;
  v_locale               text;
  v_tax_region           text;
  v_config_rows          bigint;
  v_hier_rows            bigint;
begin

  -- -------------------------------------------------------------------------
  -- 1. Seed must include exactly 1 demo company and 2 demo regions
  -- -------------------------------------------------------------------------
  select count(*) into v_company_count
  from entities
  where entity_type = 'company'
    and source_record_id like 'demo-baseline-company-%';

  if v_company_count <> 1 then
    raise exception 'Expected 1 demo-baseline company after reset, found %', v_company_count;
  end if;

  select count(*) into v_region_count
  from entities
  where entity_type = 'region'
    and source_record_id like 'demo-baseline-region-%';

  if v_region_count <> 2 then
    raise exception 'Expected 2 demo-baseline regions after reset, found %', v_region_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Company appears in rental_current_companies convenience view
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from rental_current_companies
    where source_record_id = 'demo-baseline-company-001'
  ) then
    raise exception 'Expected demo-baseline-company-001 in rental_current_companies';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Regions appear in rental_current_regions convenience view
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from rental_current_regions
    where source_record_id = 'demo-baseline-region-gulf-coast'
  ) then
    raise exception 'Expected demo-baseline-region-gulf-coast in rental_current_regions';
  end if;

  if not exists (
    select 1 from rental_current_regions
    where source_record_id = 'demo-baseline-region-north-texas'
  ) then
    raise exception 'Expected demo-baseline-region-north-texas in rental_current_regions';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Company closure table has 2 branch descendants at depth=2
  -- -------------------------------------------------------------------------
  select count(*) into v_branch_descendants
  from org_scope_closure osc
  join entities ancestor
    on ancestor.id = osc.ancestor_id
   and ancestor.source_record_id = 'demo-baseline-company-001'
  join entities descendant
    on descendant.id = osc.descendant_id
   and descendant.entity_type = 'branch'
  where osc.depth = 2;

  if v_branch_descendants <> 2 then
    raise exception 'Expected company closure to include 2 branch descendants at depth=2, found %', v_branch_descendants;
  end if;

  -- -------------------------------------------------------------------------
  -- 5. v_org_scope_hierarchy exposes company → region → branch rows
  -- -------------------------------------------------------------------------
  select id into v_company_id
  from entities
  where source_record_id = 'demo-baseline-company-001';

  select count(*) into v_gulf_hierarchy_rows
  from v_org_scope_hierarchy
  where ancestor_id = v_company_id;

  -- subtree: gulf-coast, north-texas, houston-central, dallas-north-yard (depth >= 1)
  if v_gulf_hierarchy_rows < 4 then
    raise exception
      'Expected at least 4 hierarchy rows for demo company in v_org_scope_hierarchy, found %',
      v_gulf_hierarchy_rows;
  end if;

  -- -------------------------------------------------------------------------
  -- 6. v_org_scope_config exposes the seeded company config values
  -- -------------------------------------------------------------------------
  select count(*) into v_config_rows
  from v_org_scope_config
  where scope_id = v_company_id
    and default_currency_code = 'USD'
    and timezone = 'America/Chicago'
    and locale_code = 'en-US';

  if v_config_rows <> 1 then
    raise exception
      'Expected 1 v_org_scope_config row for demo company with USD/Chicago/en-US, found %',
      v_config_rows;
  end if;

  -- -------------------------------------------------------------------------
  -- 7. org_scope_effective_config resolves inherited values for a demo branch
  -- -------------------------------------------------------------------------
  select default_currency_code, timezone, locale_code, tax_region_code
    into v_currency, v_timezone, v_locale, v_tax_region
  from org_scope_effective_config(
    (select id from entities where source_record_id = 'demo-baseline-branch-north')
  )
  limit 1;

  if v_currency <> 'USD' then
    raise exception 'Expected demo-baseline-branch-north to resolve default_currency_code=USD, got %', v_currency;
  end if;

  if v_timezone <> 'America/Chicago' then
    raise exception 'Expected demo-baseline-branch-north to resolve timezone=America/Chicago, got %', v_timezone;
  end if;

  if v_locale <> 'en-US' then
    raise exception 'Expected demo-baseline-branch-north to resolve locale_code=en-US, got %', v_locale;
  end if;

  if v_tax_region <> 'US-TX' then
    raise exception 'Expected demo-baseline-branch-north to resolve tax_region_code=US-TX, got %', v_tax_region;
  end if;

end;
$$;

rollback;
