-- Enterprise org hierarchy smoke test
-- Verifies: entity types, relationship types, closure table, org_scope_id
-- propagation, per-scope config resolution, backfill behaviour, and
-- cross-tenant isolation (anon and authenticated cross-tenant regression).

begin;

do $$
declare
  v_company_id  uuid;
  v_region_gulf uuid;
  v_region_ntx  uuid;
  v_branch_a    uuid;
  v_branch_b    uuid;
  v_asset_id    uuid;
  v_scope_id    uuid;
  v_row_count   bigint;
  v_currency    text;
  v_timezone    text;
  v_tax_region  text;
  v_locale      text;
  v_caught      boolean;
  -- assertion 15 variables
  v_company_tx  uuid;
  v_company_ty  uuid;
begin

  -- Allow write RPCs to run in this test context (service_role claim).
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- -------------------------------------------------------------------------
  -- 1. company and region types are in the entity-type catalog
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from rental_entity_type_catalog where entity_type = 'company'
  ) then
    raise exception 'company not found in rental_entity_type_catalog';
  end if;

  if not exists (
    select 1 from rental_entity_type_catalog where entity_type = 'region'
  ) then
    raise exception 'region not found in rental_entity_type_catalog';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. company_has_region and region_has_branch are in the relationship catalog
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from rental_relationship_type_catalog
    where relationship_type = 'company_has_region'
      and parent_entity_type = 'company'
      and child_entity_type  = 'region'
  ) then
    raise exception 'company_has_region not found in rental_relationship_type_catalog';
  end if;

  if not exists (
    select 1 from rental_relationship_type_catalog
    where relationship_type = 'region_has_branch'
      and parent_entity_type = 'region'
      and child_entity_type  = 'branch'
  ) then
    raise exception 'region_has_branch not found in rental_relationship_type_catalog';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Create company with per-scope config
  -- -------------------------------------------------------------------------
  select entity_id into v_company_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'company',
    p_source_record_id => 'test-org-company-apex',
    p_data => jsonb_build_object(
      'name',                 'Apex Equipment Co.',
      'default_currency_code','USD',
      'locale_code',          'en-US',
      'timezone',             'America/Chicago'
    )
  );

  -- company should be its own scope
  select org_scope_id into v_scope_id from entities where id = v_company_id;
  if v_scope_id is distinct from v_company_id then
    raise exception 'Company org_scope_id should equal its own id; got %', v_scope_id;
  end if;

  -- company should have self-row in closure at depth 0
  if not exists (
    select 1 from org_scope_closure
    where ancestor_id = v_company_id and descendant_id = v_company_id and depth = 0
  ) then
    raise exception 'Company missing self-row in org_scope_closure';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Create two regions
  -- -------------------------------------------------------------------------
  select entity_id into v_region_gulf
  from rental_upsert_entity_current_state(
    p_entity_type      => 'region',
    p_source_record_id => 'test-org-region-gulf',
    p_data => jsonb_build_object(
      'name',           'Gulf Region',
      'tax_region_code','US-TX'
    )
  );

  select entity_id into v_region_ntx
  from rental_upsert_entity_current_state(
    p_entity_type      => 'region',
    p_source_record_id => 'test-org-region-ntx',
    p_data => jsonb_build_object('name', 'North TX Region')
  );

  -- regions should be their own scope
  select org_scope_id into v_scope_id from entities where id = v_region_gulf;
  if v_scope_id is distinct from v_region_gulf then
    raise exception 'Region org_scope_id should equal its own id; got %', v_scope_id;
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Create two branches
  -- -------------------------------------------------------------------------
  select entity_id into v_branch_a
  from rental_upsert_entity_current_state(
    p_entity_type      => 'branch',
    p_source_record_id => 'test-org-branch-a',
    p_data => jsonb_build_object(
      'name',        'Test Branch A',
      'branch_code', 'TBA'
    )
  );

  select entity_id into v_branch_b
  from rental_upsert_entity_current_state(
    p_entity_type      => 'branch',
    p_source_record_id => 'test-org-branch-b',
    p_data => jsonb_build_object(
      'name',        'Test Branch B',
      'branch_code', 'TBB',
      'timezone',    'America/Dallas'
    )
  );

  -- branches should be their own scope
  select org_scope_id into v_scope_id from entities where id = v_branch_a;
  if v_scope_id is distinct from v_branch_a then
    raise exception 'Branch org_scope_id should equal its own id; got %', v_scope_id;
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Wire up the hierarchy: company → gulf → branch_a
  --                           company → ntx  → branch_b
  -- -------------------------------------------------------------------------
  perform rental_upsert_relationship('company_has_region', v_company_id, v_region_gulf);
  perform rental_upsert_relationship('company_has_region', v_company_id, v_region_ntx);
  perform rental_upsert_relationship('region_has_branch',  v_region_gulf, v_branch_a);
  perform rental_upsert_relationship('region_has_branch',  v_region_ntx,  v_branch_b);

  -- company → region (depth 1)
  if not exists (
    select 1 from org_scope_closure
    where ancestor_id = v_company_id and descendant_id = v_region_gulf and depth = 1
  ) then
    raise exception 'Expected company→region_gulf closure row at depth=1';
  end if;

  -- company → branch (depth 2)
  if not exists (
    select 1 from org_scope_closure
    where ancestor_id = v_company_id and descendant_id = v_branch_a and depth = 2
  ) then
    raise exception 'Expected company→branch_a closure row at depth=2';
  end if;

  -- region → branch (depth 1)
  if not exists (
    select 1 from org_scope_closure
    where ancestor_id = v_region_gulf and descendant_id = v_branch_a and depth = 1
  ) then
    raise exception 'Expected region_gulf→branch_a closure row at depth=1';
  end if;

  -- branches from different regions should NOT share a closure row
  if exists (
    select 1 from org_scope_closure
    where ancestor_id = v_branch_a and descendant_id = v_branch_b
  ) then
    raise exception 'branch_a should not be an ancestor of branch_b';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. v_org_scope_hierarchy exposes all rows for the company
  -- -------------------------------------------------------------------------
  select count(*) into v_row_count
  from v_org_scope_hierarchy
  where ancestor_id = v_company_id;

  -- company subtree: company(self), gulf, ntx, branch_a, branch_b = 5 rows
  if v_row_count < 5 then
    raise exception 'Expected at least 5 hierarchy rows for company, got %', v_row_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 8. v_org_scope_config exposes scope config values
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from v_org_scope_config
    where scope_id = v_company_id and default_currency_code = 'USD'
  ) then
    raise exception 'Expected company config to show default_currency_code=USD';
  end if;

  -- -------------------------------------------------------------------------
  -- 9. org_scope_effective_config resolves inherited values for branch_a
  --    (branch has no currency override → inherits from company)
  -- -------------------------------------------------------------------------
  select default_currency_code, timezone, tax_region_code, locale_code
    into v_currency, v_timezone, v_tax_region, v_locale
  from org_scope_effective_config(v_branch_a)
  limit 1;

  if v_currency <> 'USD' then
    raise exception 'Expected branch_a to inherit default_currency_code=USD, got %', v_currency;
  end if;

  if v_timezone <> 'America/Chicago' then
    raise exception 'Expected branch_a to inherit timezone=America/Chicago, got %', v_timezone;
  end if;

  if v_tax_region <> 'US-TX' then
    raise exception 'Expected branch_a to inherit tax_region_code=US-TX from region, got %', v_tax_region;
  end if;

  if v_locale <> 'en-US' then
    raise exception 'Expected branch_a to inherit locale_code=en-US, got %', v_locale;
  end if;

  -- branch_b has its own timezone override
  select timezone into v_timezone
  from org_scope_effective_config(v_branch_b)
  limit 1;

  if v_timezone <> 'America/Dallas' then
    raise exception 'Expected branch_b own timezone=America/Dallas, got %', v_timezone;
  end if;

  -- -------------------------------------------------------------------------
  -- 10. Create an asset under branch_a; verify org_scope_id propagation
  -- -------------------------------------------------------------------------
  select entity_id into v_asset_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'test-org-asset-x1',
    p_data => jsonb_build_object('name', 'Test Excavator X1')
  );

  perform rental_upsert_relationship('branch_has_asset', v_branch_a, v_asset_id);

  select org_scope_id into v_scope_id from entities where id = v_asset_id;
  if v_scope_id is distinct from v_branch_a then
    raise exception 'Asset org_scope_id should equal branch_a; got %', v_scope_id;
  end if;

  -- -------------------------------------------------------------------------
  -- 11. rental_current_companies / rental_current_regions convenience views
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from rental_current_companies where source_record_id = 'test-org-company-apex'
  ) then
    raise exception 'Expected company to appear in rental_current_companies';
  end if;

  if not exists (
    select 1 from rental_current_regions where source_record_id = 'test-org-region-gulf'
  ) then
    raise exception 'Expected region to appear in rental_current_regions';
  end if;

  -- -------------------------------------------------------------------------
  -- 12. Invalid relationship type must still be rejected by the catalog guard
  -- -------------------------------------------------------------------------
  v_caught := false;
  begin
    perform rental_upsert_relationship('company_has_region', v_branch_a, v_region_gulf);
  exception
    when sqlstate '22023' then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected company_has_region with branch parent to be rejected';
  end if;

  -- -------------------------------------------------------------------------
  -- 13. anon must have no SELECT privilege on org_scope_closure
  -- -------------------------------------------------------------------------
  if has_table_privilege('anon', 'public.org_scope_closure', 'SELECT') then
    raise exception 'anon must not hold SELECT on org_scope_closure';
  end if;

  -- No anon-targeting RLS policy should exist on this table
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'org_scope_closure'
      and roles      && array['anon']::name[]
  ) then
    raise exception 'No anon-targeting RLS policy should exist on org_scope_closure';
  end if;

  -- -------------------------------------------------------------------------
  -- 14. authenticated read policy on org_scope_closure gates on both
  --     ops_claim_app_role (app-role check) and get_my_tenant (tenant boundary).
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'org_scope_closure'
      and policyname = 'org_scope_closure_authenticated_read'
      and qual ilike '%ops_claim_app_role%'
  ) then
    raise exception 'org_scope_closure authenticated_read policy must gate on ops_claim_app_role';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'org_scope_closure'
      and policyname = 'org_scope_closure_authenticated_read'
      and qual ilike '%get_my_tenant%'
  ) then
    raise exception 'org_scope_closure authenticated_read policy must gate on get_my_tenant for tenant boundary';
  end if;

  -- Override auth.jwt() to read from request.jwt.claims so get_my_role() and
  -- get_my_tenant() resolve correctly during role-based tests below.
  -- The bare-Postgres auth stub returns {} unconditionally; this mirrors the
  -- pattern in crm_customer_profile.sql and real PostgREST behavior.
  -- Note: inner dollar-quote uses $jwtbody$ to avoid conflicting with the
  -- outer dollar-dollar delimiter of this DO block.
  execute $func$
    create or replace function auth.jwt() returns jsonb language sql as $jwtbody$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $jwtbody$
  $func$;

  -- Switch to the authenticated database role and clear the JWT app_role claim to
  -- simulate an authenticated caller who holds no recognized app_role.
  -- RLS USING(ops_claim_app_role() in (...)) must block all rows.
  -- The inner DECLARE block creates a nested variable scope; is_local=true on
  -- set_config ensures the JWT override reverts when the outer transaction rolls back.
  declare
    v_rls_count bigint;
  begin
    perform set_config(
      'request.jwt.claims',
      '{"sub":"test-no-app-role","role":"authenticated"}',
      true  -- is_local: reverts at end of transaction
    );
    execute 'set local role authenticated';

    select count(*) into v_rls_count from public.org_scope_closure;

    execute 'reset role';
    -- Clear the JWT claims override so subsequent code sees no stale claim.
    perform set_config('request.jwt.claims', '', true);

    if v_rls_count <> 0 then
      raise exception
        'authenticated caller with no app_role must read 0 rows from org_scope_closure, got %',
        v_rls_count;
    end if;
  end;

  -- -------------------------------------------------------------------------
  -- 15. Cross-tenant isolation: user from tenant-x cannot read closure rows or
  --     hierarchy/config view rows belonging to tenant-y's company.
  -- -------------------------------------------------------------------------

  -- Create two companies in distinct tenants (service_role context, BYPASSRLS).
  select entity_id into v_company_tx
  from create_entity_with_version(
    'company',
    jsonb_build_object('name', 'Company Tenant X', 'tenant', 'tenant-x')
  );
  select entity_id into v_company_ty
  from create_entity_with_version(
    'company',
    jsonb_build_object('name', 'Company Tenant Y', 'tenant', 'tenant-y')
  );

  -- Verify the closure self-rows were created by the trigger.
  if not exists (
    select 1 from public.org_scope_closure
    where ancestor_id = v_company_tx and descendant_id = v_company_tx
  ) then
    raise exception 'Self-row missing for company_tx in org_scope_closure';
  end if;

  if not exists (
    select 1 from public.org_scope_closure
    where ancestor_id = v_company_ty and descendant_id = v_company_ty
  ) then
    raise exception 'Self-row missing for company_ty in org_scope_closure';
  end if;

  -- Switch to authenticated with tenant='tenant-x' and app_role='admin'.
  -- Should see company_tx rows but NOT company_ty rows.
  declare
    v_tx_visible bigint;
    v_ty_visible bigint;
    v_config_ty  bigint;
    v_hier_ty    bigint;
  begin
    perform set_config(
      'request.jwt.claims',
      '{"role":"authenticated","app_metadata":{"role":"admin","tenant":"tenant-x"}}',
      true
    );
    execute 'set local role authenticated';

    -- org_scope_closure: tenant-x company rows must be visible.
    select count(*) into v_tx_visible
    from public.org_scope_closure
    where ancestor_id = v_company_tx;

    -- org_scope_closure: tenant-y company rows must NOT be visible.
    select count(*) into v_ty_visible
    from public.org_scope_closure
    where ancestor_id = v_company_ty;

    -- v_org_scope_config: tenant-y company must NOT appear.
    select count(*) into v_config_ty
    from public.v_org_scope_config
    where scope_id = v_company_ty;

    -- v_org_scope_hierarchy: tenant-y company must NOT appear.
    select count(*) into v_hier_ty
    from public.v_org_scope_hierarchy
    where ancestor_id = v_company_ty;

    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);

    if v_tx_visible = 0 then
      raise exception
        'tenant-x user must see their own company closure rows (got 0)';
    end if;

    if v_ty_visible <> 0 then
      raise exception
        'tenant-x user must not read tenant-y closure rows; got % row(s)',
        v_ty_visible;
    end if;

    if v_config_ty <> 0 then
      raise exception
        'tenant-x user must not see tenant-y rows in v_org_scope_config; got % row(s)',
        v_config_ty;
    end if;

    if v_hier_ty <> 0 then
      raise exception
        'tenant-x user must not see tenant-y rows in v_org_scope_hierarchy; got % row(s)',
        v_hier_ty;
    end if;
  end;

end;
$$;

rollback;
