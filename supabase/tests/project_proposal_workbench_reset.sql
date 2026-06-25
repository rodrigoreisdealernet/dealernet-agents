-- Reset-path assertions for the project proposal and rate-approval workbench
-- (migration 20260615120000_project_proposal_workbench.sql).
--
-- Runs against a fully rebuilt schema + seed dataset after `supabase db reset`.
-- Confirms that after a full reset the database still exposes:
--   1. Both workbench views exist and are queryable (no orphaned columns or
--      missing dependency objects such as crm_customer_profile_current or
--      parse_uuid_or_null).
--   2. The output-schema registry entry for project_proposal_v1 is seeded.
--   3. The staff_submit_project_proposal_for_approval RPC function exists with
--      the correct signature.
--   4. The assist-only boundary holds: calling the RPC as an admin user creates
--      a finding row with status = 'pending_approval', not auto-approved.
--   5. The role guard is intact: read_only and field_operator callers receive a
--      permission-denied error (SQLSTATE 42501).
--   6. Grant coverage: authenticated role can SELECT both views; anon cannot.

begin;

do $$
declare
  v_view_exists   bool;
  v_func_exists   bool;
  v_schema_count  bigint;
  v_finding_id    uuid;
  v_finding_status text;
  v_tenant_id     uuid;
  v_error_caught  bool;
begin
  -- Run as service_role so we can inspect metadata and manipulate tenants.
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"service_role","sub":"00000000-0000-0000-0000-000000099001","app_metadata":{"role":"admin","tenant":"default"}}',
    true
  );

  -- ── 1. View existence ────────────────────────────────────────────────────

  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_project_proposal_account_context'
  ) into v_view_exists;

  if not v_view_exists then
    raise exception 'FAIL 1a: v_project_proposal_account_context missing after reset';
  end if;

  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_project_proposal_pricing_history'
  ) into v_view_exists;

  if not v_view_exists then
    raise exception 'FAIL 1b: v_project_proposal_pricing_history missing after reset';
  end if;

  raise notice '1. View existence checks passed';

  -- ── 2. Views are queryable (dependency objects intact) ──────────────────

  -- A SELECT * LIMIT 0 confirms all column references resolve cleanly.
  perform * from public.v_project_proposal_account_context limit 0;
  perform * from public.v_project_proposal_pricing_history limit 0;

  raise notice '2. View queryability checks passed';

  -- ── 3. Output schema registry entry seeded ──────────────────────────────

  select count(*)
    into v_schema_count
  from public.ops_output_schema_registry
  where schema_key = 'project_proposal_v1';

  if v_schema_count <> 1 then
    raise exception 'FAIL 3: expected 1 ops_output_schema_registry row for project_proposal_v1, found %', v_schema_count;
  end if;

  raise notice '3. Output schema registry seeding check passed';

  -- ── 4. RPC function exists with correct signature ────────────────────────

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'staff_submit_project_proposal_for_approval'
  ) into v_func_exists;

  if not v_func_exists then
    raise exception 'FAIL 4: staff_submit_project_proposal_for_approval function missing after reset';
  end if;

  raise notice '4. RPC function existence check passed';

  -- ── 5. Grant coverage: authenticated SELECT on views, anon denied ────────

  if not has_table_privilege('authenticated', 'public.v_project_proposal_account_context', 'SELECT') then
    raise exception 'FAIL 5a: authenticated role should have SELECT on v_project_proposal_account_context';
  end if;

  if has_table_privilege('anon', 'public.v_project_proposal_account_context', 'SELECT') then
    raise exception 'FAIL 5b: anon role must not have SELECT on v_project_proposal_account_context';
  end if;

  if not has_table_privilege('authenticated', 'public.v_project_proposal_pricing_history', 'SELECT') then
    raise exception 'FAIL 5c: authenticated role should have SELECT on v_project_proposal_pricing_history';
  end if;

  if has_table_privilege('anon', 'public.v_project_proposal_pricing_history', 'SELECT') then
    raise exception 'FAIL 5d: anon role must not have SELECT on v_project_proposal_pricing_history';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.staff_submit_project_proposal_for_approval(text,text,text,text,int,jsonb,jsonb,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 5e: authenticated role should have EXECUTE on staff_submit_project_proposal_for_approval';
  end if;

  if has_function_privilege(
    'anon',
    'public.staff_submit_project_proposal_for_approval(text,text,text,text,int,jsonb,jsonb,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 5f: anon role must not have EXECUTE on staff_submit_project_proposal_for_approval';
  end if;

  raise notice '5. Grant coverage checks passed';

  -- ── 6. Assist-only boundary: RPC creates pending_approval finding ────────
  --
  -- Seed a minimal tenant so the RPC tenant-resolution path succeeds.
  -- Use a fixed UUID + key to keep the test idempotent on repeated runs.
  insert into public.tenants (id, tenant_key)
  values ('00000000-0000-0000-0000-0099aa000001'::uuid, 'ppw-reset-test-tenant')
  on conflict (tenant_key) do nothing;

  -- Simulate an admin caller with the correct tenant claim.
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-0099aa000099","app_metadata":{"role":"admin","tenant":"ppw-reset-test-tenant"}}',
    true
  );
  set local role authenticated;

  -- Call the RPC as an admin caller. All eight parameters are supplied so the
  -- test exercises the full signature and any failure is unambiguously from
  -- business logic rather than parameter resolution.
  select finding_id, status
    into v_finding_id, v_finding_status
  from public.staff_submit_project_proposal_for_approval(
    p_customer_id    => 'reset-test-customer-001',
    p_customer_name  => 'Reset Test Customer',
    p_branch_id      => 'reset-test-branch-001',
    p_branch_name    => 'Reset Test Branch',
    p_term_days      => 30,
    p_categories     => '[{"name":"Excavator","quantity":2}]'::jsonb,
    p_proposed_rates => '{"daily":450}'::jsonb,
    p_notes          => 'Reset-path validation note'
  );

  if v_finding_id is null then
    raise exception 'FAIL 6a: RPC returned null finding_id for admin caller';
  end if;

  if v_finding_status <> 'pending_approval' then
    raise exception 'FAIL 6b: assist-only boundary violated — expected status pending_approval, got %', v_finding_status;
  end if;

  -- Verify the finding row was persisted and still carries the expected status.
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select f.status
    into v_finding_status
  from public.finding f
  where f.id = v_finding_id;

  if v_finding_status <> 'pending_approval' then
    raise exception 'FAIL 6c: persisted finding status should be pending_approval, got %', v_finding_status;
  end if;

  raise notice '6. Assist-only boundary (pending_approval status) check passed';

  -- ── 7. Role guard: read_only denied ──────────────────────────────────────

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-0099aa000088","app_metadata":{"role":"read_only","tenant":"ppw-reset-test-tenant"}}',
    true
  );
  set local role authenticated;

  v_error_caught := false;
  begin
    perform public.staff_submit_project_proposal_for_approval(
      p_customer_id    => 'read-only-check-customer',
      p_customer_name  => 'Should Not Succeed',
      p_branch_id      => 'read-only-check-branch',
      p_branch_name    => 'Should Not Succeed Branch',
      p_term_days      => 30,
      p_categories     => '[]'::jsonb,
      p_proposed_rates => '{}'::jsonb,
      p_notes          => 'read_only role guard check'
    );
  exception
    when insufficient_privilege then
      v_error_caught := true;
    when others then
      raise exception 'FAIL 7: read_only role guard raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_error_caught then
    raise exception 'FAIL 7: read_only caller should be denied by role guard (SQLSTATE 42501) but no exception was raised';
  end if;

  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);

  raise notice '7. Role guard (read_only denied) check passed';

  -- ── 8. Role guard: field_operator denied ─────────────────────────────────

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-0099aa000077","app_metadata":{"role":"field_operator","tenant":"ppw-reset-test-tenant"}}',
    true
  );
  set local role authenticated;

  v_error_caught := false;
  begin
    perform public.staff_submit_project_proposal_for_approval(
      p_customer_id    => 'field-op-check-customer',
      p_customer_name  => 'Should Not Succeed',
      p_branch_id      => 'field-op-check-branch',
      p_branch_name    => 'Should Not Succeed Branch',
      p_term_days      => 30,
      p_categories     => '[]'::jsonb,
      p_proposed_rates => '{}'::jsonb,
      p_notes          => 'field_operator role guard check'
    );
  exception
    when insufficient_privilege then
      v_error_caught := true;
    when others then
      raise exception 'FAIL 8: field_operator role guard raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_error_caught then
    raise exception 'FAIL 8: field_operator caller should be denied by role guard (SQLSTATE 42501) but no exception was raised';
  end if;

  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);

  raise notice '8. Role guard (field_operator denied) check passed';

  raise notice 'All project proposal workbench reset-path checks passed';
end;
$$;

rollback;
