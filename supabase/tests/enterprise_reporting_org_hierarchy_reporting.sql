-- Smoke test for 20260609153000_enterprise_reporting_org_hierarchy.sql
-- Verifies: v_org_scope_dimension, v_enterprise_financial_reporting_lines, and
-- v_enterprise_financial_reporting_rollups exist with the expected columns,
-- respond to SELECT under service_role, and are inaccessible to anon.

begin;

do $$
declare
  v_col_count   bigint;
  v_caught      boolean;
  v_company_id  uuid;
  v_region_id   uuid;
  v_branch_id   uuid;
begin
  -- Allow write RPCs to run in this test context (service_role claim).
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- -------------------------------------------------------------------------
  -- 1. v_org_scope_dimension exists with expected columns
  -- -------------------------------------------------------------------------
  select count(*) into v_col_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'v_org_scope_dimension'
    and column_name  in ('scope_id', 'scope_type', 'scope_name', 'default_currency_code');

  if v_col_count < 4 then
    raise exception
      'v_org_scope_dimension is missing expected columns; found % of 4', v_col_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. v_enterprise_financial_reporting_lines exists with expected columns
  -- -------------------------------------------------------------------------
  select count(*) into v_col_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'v_enterprise_financial_reporting_lines'
    and column_name  in (
      'source_entity_id',
      'document_number',
      'branch_scope_id',
      'region_scope_id',
      'company_scope_id',
      'transaction_currency_code',
      'reporting_currency_code',
      'transaction_total_amount',
      'reporting_total_amount',
      'fx_rate_used',
      'fx_rate_source'
    );

  if v_col_count < 11 then
    raise exception
      'v_enterprise_financial_reporting_lines is missing expected columns; found % of 11', v_col_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 3. v_enterprise_financial_reporting_rollups exists with expected columns
  -- -------------------------------------------------------------------------
  select count(*) into v_col_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'v_enterprise_financial_reporting_rollups'
    and column_name  in (
      'scope_type',
      'scope_id',
      'scope_name',
      'document_count',
      'transaction_total_amount',
      'reporting_total_amount'
    );

  if v_col_count < 6 then
    raise exception
      'v_enterprise_financial_reporting_rollups is missing expected columns; found % of 6', v_col_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 4. All three views are selectable under service_role (no error on empty set)
  -- -------------------------------------------------------------------------
  perform * from public.v_org_scope_dimension limit 0;
  perform * from public.v_enterprise_financial_reporting_lines limit 0;
  perform * from public.v_enterprise_financial_reporting_rollups limit 0;

  -- -------------------------------------------------------------------------
  -- 5. anon must hold no SELECT privilege on any of the three views
  -- -------------------------------------------------------------------------
  if has_table_privilege('anon', 'public.v_org_scope_dimension', 'SELECT') then
    raise exception 'anon must not hold SELECT on v_org_scope_dimension';
  end if;

  if has_table_privilege('anon', 'public.v_enterprise_financial_reporting_lines', 'SELECT') then
    raise exception 'anon must not hold SELECT on v_enterprise_financial_reporting_lines';
  end if;

  if has_table_privilege('anon', 'public.v_enterprise_financial_reporting_rollups', 'SELECT') then
    raise exception 'anon must not hold SELECT on v_enterprise_financial_reporting_rollups';
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Create a minimal company→region→branch hierarchy; verify the
  --    v_org_scope_dimension view surfaces them.
  -- -------------------------------------------------------------------------
  select entity_id into v_company_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'company',
    p_source_record_id => 'test-reporting-company-001',
    p_data => jsonb_build_object(
      'name',                  'Reporting Smoke Co.',
      'default_currency_code', 'USD'
    )
  );

  select entity_id into v_region_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'region',
    p_source_record_id => 'test-reporting-region-001',
    p_data => jsonb_build_object('name', 'Smoke Region')
  );

  select entity_id into v_branch_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'branch',
    p_source_record_id => 'test-reporting-branch-001',
    p_data => jsonb_build_object('name', 'Smoke Branch', 'branch_code', 'SMK')
  );

  perform rental_upsert_relationship('company_has_region', v_company_id, v_region_id);
  perform rental_upsert_relationship('region_has_branch',  v_region_id,  v_branch_id);

  if not exists (
    select 1 from public.v_org_scope_dimension
    where scope_id = v_company_id and scope_type = 'company'
  ) then
    raise exception 'v_org_scope_dimension should expose the test company';
  end if;

  if not exists (
    select 1 from public.v_org_scope_dimension
    where scope_id = v_branch_id and scope_type = 'branch'
  ) then
    raise exception 'v_org_scope_dimension should expose the test branch';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. v_enterprise_financial_reporting_lines and rollups are selectable after
  --    the hierarchy is wired (no runtime error even with zero documents).
  -- -------------------------------------------------------------------------
  perform * from public.v_enterprise_financial_reporting_lines
  where company_scope_id = v_company_id;

  perform * from public.v_enterprise_financial_reporting_rollups
  where scope_id = v_company_id;

  raise notice 'Enterprise reporting org-hierarchy smoke test passed';
end;
$$;

rollback;
