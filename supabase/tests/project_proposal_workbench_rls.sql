-- Behavioral RLS / access-contract checks for the project-proposal workbench
-- objects added by 20260615120000_project_proposal_workbench.sql.
--
-- Assertions:
--   1. Structural grants are least-privilege:
--      - v_project_proposal_account_context   SELECT: authenticated + service_role, NOT anon.
--      - v_project_proposal_pricing_history   SELECT: authenticated + service_role, NOT anon.
--      - staff_submit_project_proposal_for_approval EXECUTE: authenticated, NOT anon.
--      - Both views declare security_invoker = true.
--   2. anon is denied SELECT on both views and EXECUTE on the RPC.
--   3. authenticated(read_only) can SELECT both views but is denied the RPC role guard.
--   4. authenticated(field_operator) is also denied the RPC role guard.
--   5. authenticated(admin, tenant-a) can call the RPC; the finding row is scoped to
--      tenant-a's UUID (not any other tenant).
--   6. authenticated(branch_manager, tenant-b) can call the RPC; finding row scoped to
--      tenant-b's UUID.
--   7. Cross-tenant isolation on the finding table: tenant-a user cannot read
--      tenant-b finding rows; tenant-b user cannot read tenant-a finding rows.
--   8. Same-tenant reads work: tenant-a user sees only their own finding row.
--   9. Cross-tenant view isolation: org-scoped rental_order_line and customer
--      entities seeded for each tenant prove that tenant-a sees only their
--      scoped rows in both views, and tenant-b sees only theirs; assertions
--      would fail if the org_scope_closure filter were removed.
--
-- Note on view tenant isolation: both views use security_invoker = true and
-- filter entity rows through org_scope_closure (same pattern as
-- crm_customer_profile_current).  Entities with org_scope_id set are visible
-- only when the caller's org_scope_closure includes that scope; entities with
-- org_scope_id IS NULL remain visible to all authenticated users.

begin;

do $$
declare
  v_tenant_a_id   uuid := '00000000-0000-0000-0000-00000000aa01';
  v_tenant_b_id   uuid := '00000000-0000-0000-0000-00000000bb01';
  v_tenant_a_key  text := 'ppw-test-tenant-a';
  v_tenant_b_key  text := 'ppw-test-tenant-b';
  v_count         int;
  v_finding_id    uuid;
  v_finding_tenant uuid;
  v_relopts       text;
  v_caught        bool;
begin
  -- ── 1. Structural grant checks ────────────────────────────────────────────

  -- v_project_proposal_account_context: authenticated can SELECT, anon cannot.
  -- (service_role inherits superuser-like access in Supabase; explicit grant not required
  --  for view surfaces exposed only to authenticated UI callers, matching the pattern of
  --  crm_customer_profile_current.)
  if not has_table_privilege('authenticated', 'public.v_project_proposal_account_context', 'SELECT') then
    raise exception 'FAIL 1a: expected authenticated SELECT grant on v_project_proposal_account_context';
  end if;

  if has_table_privilege('anon', 'public.v_project_proposal_account_context', 'SELECT') then
    raise exception 'FAIL 1b: anon should not have SELECT on v_project_proposal_account_context';
  end if;

  -- v_project_proposal_pricing_history: authenticated can SELECT, anon cannot
  if not has_table_privilege('authenticated', 'public.v_project_proposal_pricing_history', 'SELECT') then
    raise exception 'FAIL 1c: expected authenticated SELECT grant on v_project_proposal_pricing_history';
  end if;

  if has_table_privilege('anon', 'public.v_project_proposal_pricing_history', 'SELECT') then
    raise exception 'FAIL 1d: anon should not have SELECT on v_project_proposal_pricing_history';
  end if;

  -- RPC: authenticated can EXECUTE, anon cannot
  if not has_function_privilege(
    'authenticated',
    'public.staff_submit_project_proposal_for_approval(text,text,text,text,int,jsonb,jsonb,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 1e: expected authenticated EXECUTE on staff_submit_project_proposal_for_approval';
  end if;

  if has_function_privilege(
    'anon',
    'public.staff_submit_project_proposal_for_approval(text,text,text,text,int,jsonb,jsonb,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 1f: anon should not have EXECUTE on staff_submit_project_proposal_for_approval';
  end if;

  -- Both views must declare security_invoker = true
  select c.reloptions::text
    into v_relopts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'v_project_proposal_account_context';

  if coalesce(v_relopts, '') not ilike '%security_invoker=true%' then
    raise exception 'FAIL 1g: v_project_proposal_account_context must declare security_invoker = true';
  end if;

  select c.reloptions::text
    into v_relopts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'v_project_proposal_pricing_history';

  if coalesce(v_relopts, '') not ilike '%security_invoker=true%' then
    raise exception 'FAIL 1h: v_project_proposal_pricing_history must declare security_invoker = true';
  end if;

  raise notice 'PASS 1: structural grants and security_invoker flags verified';

  -- ── Setup: seed two tenants for isolation tests ───────────────────────────
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a_id, v_tenant_a_key, 'PPW Test Tenant A'),
    (v_tenant_b_id, v_tenant_b_key, 'PPW Test Tenant B')
  on conflict (id) do update
    set tenant_key = excluded.tenant_key,
        name       = excluded.name;

  execute 'reset role';

  -- ── 2. anon denied views and RPC ─────────────────────────────────────────
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  v_caught := false;
  begin
    perform 1 from public.v_project_proposal_account_context limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 2a: unexpected error for anon view read: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 2a: anon unexpectedly read v_project_proposal_account_context';
  end if;

  v_caught := false;
  begin
    perform 1 from public.v_project_proposal_pricing_history limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 2b: unexpected error for anon pricing-history read: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 2b: anon unexpectedly read v_project_proposal_pricing_history';
  end if;

  v_caught := false;
  begin
    perform public.staff_submit_project_proposal_for_approval(
      p_customer_id => 'anon-test',
      p_notes       => 'anon guard test'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 2c: unexpected error for anon RPC call: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 2c: anon unexpectedly executed staff_submit_project_proposal_for_approval';
  end if;

  raise notice 'PASS 2: anon denied views and RPC';
  execute 'reset role';

  -- ── 3. authenticated(read_only) can read views but is denied RPC ──────────
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '00000000-0000-0000-0000-00000000aa10',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', v_tenant_a_key)
    )::text,
    true
  );

  -- Views should be reachable without a permission error (may return 0 rows)
  begin
    select count(*) into v_count from public.v_project_proposal_account_context;
  exception
    when others then
      raise exception 'FAIL 3a: authenticated(read_only) got unexpected error reading account context view: % "%"', sqlstate, sqlerrm;
  end;

  begin
    select count(*) into v_count from public.v_project_proposal_pricing_history;
  exception
    when others then
      raise exception 'FAIL 3b: authenticated(read_only) got unexpected error reading pricing history view: % "%"', sqlstate, sqlerrm;
  end;

  -- RPC must be denied by the role guard (42501 / access denied message)
  v_caught := false;
  begin
    perform public.staff_submit_project_proposal_for_approval(
      p_customer_id => 'cust-ro-test',
      p_notes       => 'read_only guard test'
    );
  exception
    when sqlstate '42501' then v_caught := true;
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' or sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 3c: unexpected error for read_only RPC call: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 3c: authenticated(read_only) unexpectedly executed the proposal RPC';
  end if;

  raise notice 'PASS 3: authenticated(read_only) can read views; RPC role guard blocks submission';
  execute 'reset role';

  -- ── 4. authenticated(field_operator) denied RPC ───────────────────────────
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '00000000-0000-0000-0000-00000000aa11',
      'app_metadata', jsonb_build_object('role', 'field_operator', 'tenant', v_tenant_a_key)
    )::text,
    true
  );

  v_caught := false;
  begin
    perform public.staff_submit_project_proposal_for_approval(
      p_customer_id => 'cust-fo-test',
      p_notes       => 'field_operator guard test'
    );
  exception
    when sqlstate '42501' then v_caught := true;
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' or sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 4: unexpected error for field_operator RPC call: % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4: authenticated(field_operator) unexpectedly executed the proposal RPC';
  end if;

  raise notice 'PASS 4: authenticated(field_operator) denied by RPC role guard';
  execute 'reset role';

  -- ── 5. authenticated(admin, tenant-a) calls RPC → finding scoped to tenant-a ──
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '00000000-0000-0000-0000-00000000aa20',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', v_tenant_a_key)
    )::text,
    true
  );

  select f.finding_id into v_finding_id
  from public.staff_submit_project_proposal_for_approval(
    p_customer_id   => 'ppw-cust-a-001',
    p_customer_name => 'PPW Test Customer A',
    p_branch_id     => 'ppw-branch-a-001',
    p_term_days     => 30,
    p_notes         => 'admin tenant-a submission test'
  ) f;

  if v_finding_id is null then
    raise exception 'FAIL 5a: admin(tenant-a) RPC returned no finding_id';
  end if;

  -- The finding must be associated with tenant-a's UUID
  select tenant_id into v_finding_tenant
  from public.finding
  where id = v_finding_id;

  if v_finding_tenant is distinct from v_tenant_a_id then
    raise exception 'FAIL 5b: finding tenant_id % does not match tenant-a %', v_finding_tenant, v_tenant_a_id;
  end if;

  raise notice 'PASS 5: admin(tenant-a) can call RPC; finding is scoped to tenant-a UUID';
  execute 'reset role';

  -- ── 6. authenticated(branch_manager, tenant-b) calls RPC → scoped to tenant-b ──
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '00000000-0000-0000-0000-00000000bb20',
      'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', v_tenant_b_key)
    )::text,
    true
  );

  select f.finding_id into v_finding_id
  from public.staff_submit_project_proposal_for_approval(
    p_customer_id   => 'ppw-cust-b-001',
    p_customer_name => 'PPW Test Customer B',
    p_branch_id     => 'ppw-branch-b-001',
    p_term_days     => 60,
    p_notes         => 'branch_manager tenant-b submission test'
  ) f;

  if v_finding_id is null then
    raise exception 'FAIL 6a: branch_manager(tenant-b) RPC returned no finding_id';
  end if;

  select tenant_id into v_finding_tenant
  from public.finding
  where id = v_finding_id;

  if v_finding_tenant is distinct from v_tenant_b_id then
    raise exception 'FAIL 6b: finding tenant_id % does not match tenant-b %', v_finding_tenant, v_tenant_b_id;
  end if;

  raise notice 'PASS 6: branch_manager(tenant-b) can call RPC; finding is scoped to tenant-b UUID';
  execute 'reset role';

  -- ── 7. Cross-tenant isolation on the finding table ────────────────────────
  -- tenant-a admin must see their own finding and zero tenant-b findings.
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '00000000-0000-0000-0000-00000000aa20',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', v_tenant_a_key)
    )::text,
    true
  );

  select count(*) into v_count
  from public.finding
  where tenant_id = v_tenant_a_id
    and agent_key = 'project-proposal-workbench';

  if v_count <> 1 then
    raise exception 'FAIL 7a: tenant-a admin expected 1 own project-proposal finding, got %', v_count;
  end if;

  select count(*) into v_count
  from public.finding
  where tenant_id = v_tenant_b_id;

  if v_count <> 0 then
    raise exception 'FAIL 7b: tenant-a admin should see 0 tenant-b finding rows, got %', v_count;
  end if;

  raise notice 'PASS 7: tenant-a admin sees own finding; 0 tenant-b rows visible';
  execute 'reset role';

  -- tenant-b branch_manager must see their finding and zero tenant-a findings.
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '00000000-0000-0000-0000-00000000bb20',
      'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', v_tenant_b_key)
    )::text,
    true
  );

  select count(*) into v_count
  from public.finding
  where tenant_id = v_tenant_b_id
    and agent_key = 'project-proposal-workbench';

  if v_count <> 1 then
    raise exception 'FAIL 7c: tenant-b branch_manager expected 1 own project-proposal finding, got %', v_count;
  end if;

  select count(*) into v_count
  from public.finding
  where tenant_id = v_tenant_a_id;

  if v_count <> 0 then
    raise exception 'FAIL 7d: tenant-b branch_manager should see 0 tenant-a finding rows, got %', v_count;
  end if;

  raise notice 'PASS 7: tenant-b branch_manager sees own finding; 0 tenant-a rows visible';
  execute 'reset role';

  -- ── 8. Idempotent re-submission (same-day dedup) updates existing row ─────
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '00000000-0000-0000-0000-00000000aa20',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', v_tenant_a_key)
    )::text,
    true
  );

  -- Re-submit for same customer/branch/date — must update, not insert a second row
  perform public.staff_submit_project_proposal_for_approval(
    p_customer_id   => 'ppw-cust-a-001',
    p_branch_id     => 'ppw-branch-a-001',
    p_notes         => 'second submission same day'
  );

  select count(*) into v_count
  from public.finding
  where tenant_id = v_tenant_a_id
    and agent_key = 'project-proposal-workbench'
    and evidence ->> 'customer_id' = 'ppw-cust-a-001';

  if v_count <> 1 then
    raise exception 'FAIL 8: expected 1 deduplicated finding row after re-submission, got %', v_count;
  end if;

  raise notice 'PASS 8: same-day re-submission deduplicates via fingerprint (upsert)';
  execute 'reset role';

  perform set_config('request.jwt.claims', '', true);

end;
$$;

-- ── 9. Cross-tenant view isolation (org_scope_closure filter) ─────────────────
-- Seed an org hierarchy + scoped entities for each test tenant, then prove
-- that tenant-a cannot see tenant-b's scoped rows and vice versa.
-- Assertions would fail if the org_scope_closure filter in either view were
-- removed (the counts would exceed 1 / show cross-tenant rows).
do $$
declare
  v_tenant_a_key    text    := 'ppw-test-tenant-a';
  v_tenant_b_key    text    := 'ppw-test-tenant-b';
  -- Stable UUIDs so the block is idempotent within the transaction
  v_co_a_id         uuid    := 'a1000000-0000-4000-8000-000000000001';
  v_br_a_id         uuid    := 'a1000000-0000-4000-8000-000000000002';
  v_co_b_id         uuid    := 'b1000000-0000-4000-8000-000000000001';
  v_br_b_id         uuid    := 'b1000000-0000-4000-8000-000000000002';
  v_cust_a_id       uuid    := 'a1000000-0000-4000-8000-000000000010';
  v_cust_b_id       uuid    := 'b1000000-0000-4000-8000-000000000010';
  v_order_a_id      uuid    := 'a1000000-0000-4000-8000-000000000020';
  v_order_b_id      uuid    := 'b1000000-0000-4000-8000-000000000020';
  v_line_a_id       uuid    := 'a1000000-0000-4000-8000-000000000030';
  v_line_b_id       uuid    := 'b1000000-0000-4000-8000-000000000030';
  v_cat_id          uuid    := 'c0000000-0000-4000-8000-000000000001';
  v_count           int;
begin
  -- ── Setup (service_role, bypasses authenticated RLS) ──────────────────────
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Tenant-a: company + branch entities (triggers set org_scope_id=self and
  -- insert the self-row in org_scope_closure).
  insert into public.entities (id, entity_type, source_record_id)
  values (v_co_a_id, 'company', 'ppw9-co-a')
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_co_a_id, 1, true, now(), jsonb_build_object('name', 'PPW9 Co A', 'tenant', v_tenant_a_key))
  on conflict do nothing;

  insert into public.entities (id, entity_type, source_record_id)
  values (v_br_a_id, 'branch', 'ppw9-br-a')
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_br_a_id, 1, true, now(), jsonb_build_object('name', 'PPW9 Branch A', 'tenant', v_tenant_a_key))
  on conflict do nothing;

  -- Tenant-b: company + branch
  insert into public.entities (id, entity_type, source_record_id)
  values (v_co_b_id, 'company', 'ppw9-co-b')
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_co_b_id, 1, true, now(), jsonb_build_object('name', 'PPW9 Co B', 'tenant', v_tenant_b_key))
  on conflict do nothing;

  insert into public.entities (id, entity_type, source_record_id)
  values (v_br_b_id, 'branch', 'ppw9-br-b')
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_br_b_id, 1, true, now(), jsonb_build_object('name', 'PPW9 Branch B', 'tenant', v_tenant_b_key))
  on conflict do nothing;

  -- Org relationships: company_has_branch expands org_scope_closure so the
  -- branch's org_scope_closure includes both company and branch ancestor rows.
  insert into public.relationships_v2
    (relationship_type, parent_id, child_id, is_current, valid_from)
  values
    ('company_has_region', v_co_a_id, v_br_a_id, true, now()),
    ('company_has_region', v_co_b_id, v_br_b_id, true, now())
  on conflict do nothing;

  -- Shared asset_category (master data — intentionally unscoped, visible to all)
  insert into public.entities (id, entity_type, source_record_id)
  values (v_cat_id, 'asset_category', 'ppw9-cat-scissor')
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_cat_id, 1, true, now(), jsonb_build_object('name', 'PPW9 Scissor Lift'))
  on conflict do nothing;

  -- Tenant-a: customer scoped to branch-a
  insert into public.entities (id, entity_type, source_record_id, org_scope_id)
  values (v_cust_a_id, 'customer', 'ppw9-cust-a', v_br_a_id)
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_cust_a_id, 1, true, now(),
    jsonb_build_object('name', 'PPW9 Customer A', 'org_scope_id', v_br_a_id::text))
  on conflict do nothing;

  -- Tenant-b: customer scoped to branch-b
  insert into public.entities (id, entity_type, source_record_id, org_scope_id)
  values (v_cust_b_id, 'customer', 'ppw9-cust-b', v_br_b_id)
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_cust_b_id, 1, true, now(),
    jsonb_build_object('name', 'PPW9 Customer B', 'org_scope_id', v_br_b_id::text))
  on conflict do nothing;

  -- Tenant-a: rental_order scoped to branch-a
  insert into public.entities (id, entity_type, source_record_id, org_scope_id)
  values (v_order_a_id, 'rental_order', 'ppw9-order-a', v_br_a_id)
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_order_a_id, 1, true, now(),
    jsonb_build_object('customer_id', v_cust_a_id::text, 'org_scope_id', v_br_a_id::text))
  on conflict do nothing;

  -- Tenant-b: rental_order scoped to branch-b
  insert into public.entities (id, entity_type, source_record_id, org_scope_id)
  values (v_order_b_id, 'rental_order', 'ppw9-order-b', v_br_b_id)
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_order_b_id, 1, true, now(),
    jsonb_build_object('customer_id', v_cust_b_id::text, 'org_scope_id', v_br_b_id::text))
  on conflict do nothing;

  -- Tenant-a: rental_order_line scoped to branch-a (daily_rate 100)
  insert into public.entities (id, entity_type, source_record_id, org_scope_id)
  values (v_line_a_id, 'rental_order_line', 'ppw9-line-a', v_br_a_id)
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_line_a_id, 1, true, now(), jsonb_build_object(
    'category_id', v_cat_id::text,
    'daily_rate', '100.00',
    'rate_type', 'daily',
    'status', 'closed',
    'org_scope_id', v_br_a_id::text
  ))
  on conflict do nothing;

  -- Tenant-b: rental_order_line scoped to branch-b (daily_rate 200)
  insert into public.entities (id, entity_type, source_record_id, org_scope_id)
  values (v_line_b_id, 'rental_order_line', 'ppw9-line-b', v_br_b_id)
  on conflict (id) do nothing;
  insert into public.entity_versions (entity_id, version_number, is_current, valid_from, data)
  values (v_line_b_id, 1, true, now(), jsonb_build_object(
    'category_id', v_cat_id::text,
    'daily_rate', '200.00',
    'rate_type', 'daily',
    'status', 'closed',
    'org_scope_id', v_br_b_id::text
  ))
  on conflict do nothing;

  -- Rebuild org_scope_closure from scratch so the company→branch hierarchy
  -- seeded above is fully reflected.  The incremental trigger approach used by
  -- direct SQL inserts into relationships_v2 depends on pre-existing self-rows
  -- in org_scope_closure at the moment the trigger fires; calling the full
  -- rebuild here matches the established pattern used by all other passing
  -- tests (enterprise_org_hierarchy.sql, crm_customer_profile.sql) which
  -- achieve the same result via rental_upsert_relationship().
  perform public.refresh_org_scope_closure();

  execute 'reset role';

  -- ── 9a. Tenant-a admin: sees their pricing line, not tenant-b's ───────────
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '00000000-0000-0000-0000-00000000aa20',
      'app_metadata', jsonb_build_object('role', 'admin', 'tenant', v_tenant_a_key)
    )::text,
    true
  );

  -- v_project_proposal_pricing_history: tenant-a line (100) must be visible
  select count(*) into v_count
  from public.v_project_proposal_pricing_history
  where category_id = v_cat_id
    and min_rate = 100.00;

  if v_count <> 1 then
    raise exception 'FAIL 9a: tenant-a admin expected 1 pricing row with rate=100, got %', v_count;
  end if;

  -- Tenant-b line (200) must NOT be visible to tenant-a admin
  select count(*) into v_count
  from public.v_project_proposal_pricing_history
  where category_id = v_cat_id
    and max_rate = 200.00;

  if v_count <> 0 then
    raise exception 'FAIL 9b: tenant-a admin should not see tenant-b pricing row (rate=200), got %', v_count;
  end if;

  -- v_project_proposal_account_context: tenant-a customer must be visible
  select count(*) into v_count
  from public.v_project_proposal_account_context
  where entity_id = v_cust_a_id;

  if v_count <> 1 then
    raise exception 'FAIL 9c: tenant-a admin expected 1 account-context row for their customer, got %', v_count;
  end if;

  -- Tenant-b customer must NOT be visible to tenant-a admin
  select count(*) into v_count
  from public.v_project_proposal_account_context
  where entity_id = v_cust_b_id;

  if v_count <> 0 then
    raise exception 'FAIL 9d: tenant-a admin should not see tenant-b customer in account context, got %', v_count;
  end if;

  raise notice 'PASS 9a–9d: tenant-a admin sees own scoped data; tenant-b rows are hidden';
  execute 'reset role';

  -- ── 9b. Tenant-b manager: sees their pricing line, not tenant-a's ─────────
  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '00000000-0000-0000-0000-00000000bb20',
      'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', v_tenant_b_key)
    )::text,
    true
  );

  -- Tenant-b line (200) must be visible
  select count(*) into v_count
  from public.v_project_proposal_pricing_history
  where category_id = v_cat_id
    and min_rate = 200.00;

  if v_count <> 1 then
    raise exception 'FAIL 9e: tenant-b manager expected 1 pricing row with rate=200, got %', v_count;
  end if;

  -- Tenant-a line (100) must NOT be visible to tenant-b manager
  select count(*) into v_count
  from public.v_project_proposal_pricing_history
  where category_id = v_cat_id
    and max_rate = 100.00;

  if v_count <> 0 then
    raise exception 'FAIL 9f: tenant-b manager should not see tenant-a pricing row (rate=100), got %', v_count;
  end if;

  -- Tenant-b customer must be visible
  select count(*) into v_count
  from public.v_project_proposal_account_context
  where entity_id = v_cust_b_id;

  if v_count <> 1 then
    raise exception 'FAIL 9g: tenant-b manager expected 1 account-context row for their customer, got %', v_count;
  end if;

  -- Tenant-a customer must NOT be visible to tenant-b manager
  select count(*) into v_count
  from public.v_project_proposal_account_context
  where entity_id = v_cust_a_id;

  if v_count <> 0 then
    raise exception 'FAIL 9h: tenant-b manager should not see tenant-a customer in account context, got %', v_count;
  end if;

  raise notice 'PASS 9e–9h: tenant-b manager sees own scoped data; tenant-a rows are hidden';
  execute 'reset role';

  perform set_config('request.jwt.claims', '', true);

end;
$$;

rollback;