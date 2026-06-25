begin;

-- Reset-path validation for 20260615191000_quote_conversion_require_quote_gate.sql.
--
-- Confirms that after a full `supabase db reset`:
--   1. The rental_convert_quote_to_reservation function exists with the
--      expected signature and correct permission grants.
--   2. PUBLIC and anon roles are denied execute (revoke all … from public).
--   3. authenticated and service_role are granted execute.
--   4. A draft-status order is blocked at the status gate (success=false,
--      reason=order_not_ready_for_conversion).
--   5. A quoted-status order converts to a reservation successfully.
--   6. An approved-status order converts to a reservation successfully.
--   7. Re-calling conversion on an already-converted order is idempotent:
--      it returns success=true and the same reservation id with no conflicts.

do $$
declare
  v_func_exists bool;
  v_func_public_exec bool;
  v_func_grant_auth bool;
  v_func_grant_service bool;
  v_anon_exec_denied bool := false;
  v_authenticated_exec_allowed bool := false;
  v_missing_order_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;

  v_branch uuid;
  v_customer uuid;
  v_billing_account uuid;
  v_job_site uuid;
  v_asset_category uuid;
  v_asset uuid;

  v_approved_category uuid;
  v_approved_asset uuid;
  v_approved_asset2 uuid;

  v_draft_order uuid;

  v_quoted_order uuid;
  v_quoted_success bool;
  v_quoted_reservation_id uuid;
  v_quoted_conflicts jsonb;
  v_quoted_message text;

  v_approved_order uuid;
  v_approved_success bool;
  v_approved_reservation_id uuid;
  v_approved_message text;

  v_retry_success bool;
  v_retry_reservation_id uuid;
  v_retry_conflicts jsonb;

  v_draft_success bool;
  v_draft_conflicts jsonb;
  v_draft_message text;
  v_draft_reason text;
begin
  -- -------------------------------------------------------------------------
  -- 1. Schema-level checks: function exists, ACL is correctly enforced.
  -- -------------------------------------------------------------------------
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rental_convert_quote_to_reservation'
  ) into v_func_exists;

  if not v_func_exists then
    raise exception 'Expected public.rental_convert_quote_to_reservation to exist after reset';
  end if;

  -- revoke all … from public means grantee=0 (PUBLIC) must have no execute.
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where n.nspname = 'public'
      and p.proname = 'rental_convert_quote_to_reservation'
      and p.pronargs = 1
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ) into v_func_public_exec;

  if v_func_public_exec then
    raise exception 'Expected PUBLIC role to have no execute privilege on rental_convert_quote_to_reservation after revoke all';
  end if;

  -- anon must not have execute.
  if has_function_privilege('anon', 'public.rental_convert_quote_to_reservation(uuid)', 'execute') then
    raise exception 'Expected anon role to have no execute privilege on rental_convert_quote_to_reservation';
  end if;

  -- authenticated and service_role must have execute.
  select has_function_privilege('authenticated', 'public.rental_convert_quote_to_reservation(uuid)', 'execute')
    into v_func_grant_auth;
  if not v_func_grant_auth then
    raise exception 'Expected authenticated role to have execute privilege on rental_convert_quote_to_reservation';
  end if;

  select has_function_privilege('service_role', 'public.rental_convert_quote_to_reservation(uuid)', 'execute')
    into v_func_grant_service;
  if not v_func_grant_service then
    raise exception 'Expected service_role to have execute privilege on rental_convert_quote_to_reservation';
  end if;

  -- anon execution must be denied at runtime.
  begin
    execute 'set local role anon';
    perform 1
    from public.rental_convert_quote_to_reservation(v_missing_order_id);
  exception
    when insufficient_privilege then
      v_anon_exec_denied := true;
  end;
  execute 'reset role';

  if not v_anon_exec_denied then
    raise exception 'Expected anon execution of rental_convert_quote_to_reservation to fail with insufficient_privilege';
  end if;

  -- authenticated execution must reach the function body (unknown order raises 22023).
  begin
    execute 'set local role authenticated';
    perform 1
    from public.rental_convert_quote_to_reservation(v_missing_order_id);
  exception
    when sqlstate '22023' then
      v_authenticated_exec_allowed := true;
  end;
  execute 'reset role';

  if not v_authenticated_exec_allowed then
    raise exception 'Expected authenticated execution path to reach rental_convert_quote_to_reservation function body';
  end if;

  raise notice 'ACL checks passed';

  -- -------------------------------------------------------------------------
  -- 2. Seed shared minimal test data.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id into v_branch
  from rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'qg-reset-branch-001',
    p_data => jsonb_build_object('name', 'Quote Gate Test Branch', 'branch_code', 'QG-BR')
  );

  select entity_id into v_customer
  from rental_upsert_entity_current_state(
    p_entity_type => 'customer',
    p_source_record_id => 'qg-reset-customer-001',
    p_data => jsonb_build_object('name', 'Quote Gate Test Customer')
  );

  select entity_id into v_billing_account
  from rental_upsert_entity_current_state(
    p_entity_type => 'billing_account',
    p_source_record_id => 'qg-reset-billing-001',
    p_data => jsonb_build_object('name', 'Quote Gate Test Billing')
  );

  select entity_id into v_job_site
  from rental_upsert_entity_current_state(
    p_entity_type => 'job_site',
    p_source_record_id => 'qg-reset-job-site-001',
    p_data => jsonb_build_object('name', 'Quote Gate Test Site')
  );

  select entity_id into v_asset_category
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_source_record_id => 'qg-reset-category-001',
    p_data => jsonb_build_object('name', 'Quote Gate Test Excavators')
  );

  select entity_id into v_asset
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'qg-reset-asset-001',
    p_data => jsonb_build_object(
      'name', 'Quote Gate Test Excavator',
      'ownership_type', 'owned',
      'operational_status', 'available'
    )
  );

  perform rental_upsert_relationship('branch_has_asset', v_branch, v_asset);
  perform rental_upsert_relationship('asset_category_has_asset', v_asset_category, v_asset);

  -- Dedicated category + asset for the approved-order test so the availability
  -- check for that order does not count the order's own approved-commitment
  -- against the single shared asset (the availability policy subtracts all
  -- approved-order commitments from the pool, including the order under
  -- conversion, so a pool of 1 with 1 approved commitment = 0 net available).
  -- Two assets are seeded: the approved order commits 1, net available = 1 ≥ 1.
  select entity_id into v_approved_category
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_source_record_id => 'qg-reset-category-approved-001',
    p_data => jsonb_build_object('name', 'Quote Gate Test Excavators (Approved)')
  );

  select entity_id into v_approved_asset
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'qg-reset-asset-approved-001',
    p_data => jsonb_build_object(
      'name', 'Quote Gate Test Excavator (Approved) A',
      'ownership_type', 'owned',
      'operational_status', 'available'
    )
  );

  select entity_id into v_approved_asset2
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'qg-reset-asset-approved-002',
    p_data => jsonb_build_object(
      'name', 'Quote Gate Test Excavator (Approved) B',
      'ownership_type', 'owned',
      'operational_status', 'available'
    )
  );

  perform rental_upsert_relationship('branch_has_asset', v_branch, v_approved_asset);
  perform rental_upsert_relationship('asset_category_has_asset', v_approved_category, v_approved_asset);
  perform rental_upsert_relationship('branch_has_asset', v_branch, v_approved_asset2);
  perform rental_upsert_relationship('asset_category_has_asset', v_approved_category, v_approved_asset2);

  raise notice 'Shared seed data created';

  -- -------------------------------------------------------------------------
  -- 3. Draft-order gate: conversion must be rejected.
  -- -------------------------------------------------------------------------
  select entity_id into v_draft_order
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'qg-reset-order-draft-001',
    p_data => jsonb_build_object(
      'order_number', 'RO-QG-DRAFT-001',
      'status', 'draft',
      'rental_type', 'external',
      'branch_id', v_branch,
      'customer_id', v_customer,
      'billing_account_id', v_billing_account,
      'job_site_id', v_job_site
    )
  );

  perform rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'qg-reset-order-line-draft-001',
    p_data => jsonb_build_object(
      'order_id', v_draft_order,
      'status', 'pending',
      'category_id', v_asset_category,
      'quantity', 1,
      'planned_start', (now()::date + interval '5 day')::date,
      'planned_end', (now()::date + interval '7 day')::date,
      'job_site_id', v_job_site,
      'rate_type', 'daily',
      'rate_amount_minor', 30000
    )
  );

  select success, conflicts, message
    into v_draft_success, v_draft_conflicts, v_draft_message
  from rental_convert_quote_to_reservation(v_draft_order);

  if v_draft_success then
    raise exception 'Expected draft-order conversion to be rejected by the quote gate, but success=true';
  end if;

  if coalesce(jsonb_array_length(v_draft_conflicts), 0) = 0 then
    raise exception 'Expected draft-order gate rejection to include a conflicts entry, got empty array';
  end if;

  v_draft_reason := v_draft_conflicts->0->>'reason';
  if v_draft_reason is distinct from 'order_not_ready_for_conversion' then
    raise exception 'Expected conflicts[0].reason=order_not_ready_for_conversion, got %', v_draft_reason;
  end if;

  if v_draft_message is distinct from 'Order must be quoted or approved before conversion.' then
    raise exception 'Expected gate rejection message "Order must be quoted or approved before conversion.", got %', v_draft_message;
  end if;

  raise notice 'Draft-order gate check passed';

  -- -------------------------------------------------------------------------
  -- 4. Quoted-order conversion must succeed.
  -- -------------------------------------------------------------------------
  select entity_id into v_quoted_order
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'qg-reset-order-quoted-001',
    p_data => jsonb_build_object(
      'order_number', 'RO-QG-QUOTED-001',
      'status', 'quoted',
      'rental_type', 'external',
      'branch_id', v_branch,
      'customer_id', v_customer,
      'billing_account_id', v_billing_account,
      'job_site_id', v_job_site,
      'pricing_snapshot', jsonb_build_object(
        'subtotal_minor', 60000,
        'tax_minor', 5000,
        'total_minor', 65000
      )
    )
  );

  perform rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'qg-reset-order-line-quoted-001',
    p_data => jsonb_build_object(
      'order_id', v_quoted_order,
      'status', 'pending',
      'category_id', v_asset_category,
      'quantity', 1,
      'planned_start', (now()::date + interval '10 day')::date,
      'planned_end', (now()::date + interval '12 day')::date,
      'job_site_id', v_job_site,
      'rate_type', 'daily',
      'rate_amount_minor', 60000
    )
  );

  select success, reservation_id, conflicts, message
    into v_quoted_success, v_quoted_reservation_id, v_quoted_conflicts, v_quoted_message
  from rental_convert_quote_to_reservation(v_quoted_order);

  if not v_quoted_success then
    raise exception 'Expected quoted-order conversion to succeed; message: %', v_quoted_message;
  end if;

  if v_quoted_reservation_id is null then
    raise exception 'Expected quoted-order conversion to return a reservation contract id';
  end if;

  if coalesce(jsonb_array_length(v_quoted_conflicts), 0) <> 0 then
    raise exception 'Expected quoted-order conversion to return no conflicts, got %', v_quoted_conflicts;
  end if;

  raise notice 'Quoted-order conversion passed';

  -- -------------------------------------------------------------------------
  -- 5. Idempotency: re-converting the quoted order returns the same id.
  -- -------------------------------------------------------------------------
  select success, reservation_id, conflicts
    into v_retry_success, v_retry_reservation_id, v_retry_conflicts
  from rental_convert_quote_to_reservation(v_quoted_order);

  if not v_retry_success then
    raise exception 'Expected repeated quoted-order conversion to be idempotently successful';
  end if;

  if v_retry_reservation_id <> v_quoted_reservation_id then
    raise exception 'Expected repeated conversion to return original reservation id %, got %',
      v_quoted_reservation_id, v_retry_reservation_id;
  end if;

  if coalesce(jsonb_array_length(v_retry_conflicts), 0) <> 0 then
    raise exception 'Expected repeated conversion to return no conflicts, got %', v_retry_conflicts;
  end if;

  raise notice 'Idempotency check passed';

  -- -------------------------------------------------------------------------
  -- 6. Approved-order conversion must also succeed.
  -- -------------------------------------------------------------------------
  select entity_id into v_approved_order
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'qg-reset-order-approved-001',
    p_data => jsonb_build_object(
      'order_number', 'RO-QG-APPROVED-001',
      'status', 'approved',
      'rental_type', 'external',
      'branch_id', v_branch,
      'customer_id', v_customer,
      'billing_account_id', v_billing_account,
      'job_site_id', v_job_site,
      'pricing_snapshot', jsonb_build_object(
        'subtotal_minor', 70000,
        'tax_minor', 6000,
        'total_minor', 76000
      )
    )
  );

  perform rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'qg-reset-order-line-approved-001',
    p_data => jsonb_build_object(
      'order_id', v_approved_order,
      'status', 'pending',
      'category_id', v_approved_category,
      'quantity', 1,
      'planned_start', (now()::date + interval '20 day')::date,
      'planned_end', (now()::date + interval '22 day')::date,
      'job_site_id', v_job_site,
      'rate_type', 'daily',
      'rate_amount_minor', 70000
    )
  );

  select success, reservation_id, message
    into v_approved_success, v_approved_reservation_id, v_approved_message
  from rental_convert_quote_to_reservation(v_approved_order);

  if not v_approved_success then
    raise exception 'Expected approved-order conversion to succeed; message: %', v_approved_message;
  end if;

  if v_approved_reservation_id is null then
    raise exception 'Expected approved-order conversion to return a reservation contract id';
  end if;

  raise notice 'Approved-order conversion passed';

  raise notice 'All quote-gate reset-path checks passed';
end;
$$;

rollback;
