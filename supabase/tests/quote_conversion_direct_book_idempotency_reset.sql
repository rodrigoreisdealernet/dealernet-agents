begin;

-- Reset-path validation for 20260610190000_quote_conversion_direct_book_idempotency.sql.
--
-- Confirms that after a full `supabase db reset`:
--   1. The rental_convert_quote_to_reservation function exists with the
--      expected signature and correct permission grants.
--   2. A quoted order can be converted to a reservation.
--   3. Re-calling conversion on an already-converted order is idempotent:
--      it returns success=true and the same reservation id with no conflicts.
--   4. The audit snapshot trail is preserved on the converted order and the
--      resulting reservation contract (conversion_actor_id, converted_at,
--      quote_snapshot, originating_quote_order_id, reservation_contract_id).

do $$
declare
  v_func_exists bool;
  v_func_public_exec bool;
  v_func_revoke_anon bool;
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
  v_order uuid;
  v_order_line uuid;

  v_first_success bool;
  v_first_reservation_id uuid;
  v_first_conflicts jsonb;
  v_first_message text;

  v_retry_success bool;
  v_retry_reservation_id uuid;
  v_retry_conflicts jsonb;

  v_order_actor text;
  v_order_source_id uuid;
  v_order_converted_at timestamptz;
  v_order_quote_snapshot jsonb;
  v_order_reservation_contract_id uuid;

  v_contract_order_id uuid;
  v_contract_quote_snapshot jsonb;
  v_contract_converted_at timestamptz;
  v_contract_status text;

  v_contract_line_count bigint;
  v_contract_line_snapshot jsonb;
begin
  -- -------------------------------------------------------------------------
  -- 1. Schema-level checks: function exists, permissions are correct.
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
    raise exception 'Expected PUBLIC role to have no execute privilege on rental_convert_quote_to_reservation';
  end if;

  -- The migration explicitly revokes execute from anon.
  select not has_function_privilege('anon', 'public.rental_convert_quote_to_reservation(uuid)', 'execute')
    into v_func_revoke_anon;

  if not v_func_revoke_anon then
    raise exception 'Expected anon role to have no execute privilege on rental_convert_quote_to_reservation';
  end if;

  -- The migration grants execute to authenticated and service_role.
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
    raise exception 'Expected authenticated execution path for rental_convert_quote_to_reservation';
  end if;

  raise notice 'Schema-level checks passed';

  -- -------------------------------------------------------------------------
  -- 2. Seed minimal test data for the conversion scenario.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id into v_branch
  from rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'reset-test-branch-qc-001',
    p_data => jsonb_build_object('name', 'Reset Test Branch', 'branch_code', 'BR-RT')
  );

  select entity_id into v_customer
  from rental_upsert_entity_current_state(
    p_entity_type => 'customer',
    p_source_record_id => 'reset-test-customer-qc-001',
    p_data => jsonb_build_object('name', 'Reset Test Customer')
  );

  select entity_id into v_billing_account
  from rental_upsert_entity_current_state(
    p_entity_type => 'billing_account',
    p_source_record_id => 'reset-test-billing-qc-001',
    p_data => jsonb_build_object('name', 'Reset Test Billing')
  );

  select entity_id into v_job_site
  from rental_upsert_entity_current_state(
    p_entity_type => 'job_site',
    p_source_record_id => 'reset-test-job-site-qc-001',
    p_data => jsonb_build_object('name', 'Reset Test Job Site')
  );

  select entity_id into v_asset_category
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_source_record_id => 'reset-test-category-qc-001',
    p_data => jsonb_build_object('name', 'Reset Test Excavators')
  );

  select entity_id into v_asset
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'reset-test-asset-qc-001',
    p_data => jsonb_build_object(
      'name', 'Reset Test Excavator',
      'ownership_type', 'owned',
      'operational_status', 'available'
    )
  );

  perform rental_upsert_relationship('branch_has_asset', v_branch, v_asset);
  perform rental_upsert_relationship('asset_category_has_asset', v_asset_category, v_asset);

  -- Create a quoted order for canonical quote->reservation conversion.
  select entity_id into v_order
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'reset-test-order-qc-001',
    p_data => jsonb_build_object(
      'order_number', 'RO-RESET-QC-001',
      'status', 'quoted',
      'rental_type', 'external',
      'branch_id', v_branch,
      'customer_id', v_customer,
      'billing_account_id', v_billing_account,
      'job_site_id', v_job_site,
      'pricing_snapshot', jsonb_build_object(
        'subtotal_minor', 50000,
        'tax_minor', 4000,
        'total_minor', 54000
      )
    )
  );

  select entity_id into v_order_line
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'reset-test-order-line-qc-001',
    p_data => jsonb_build_object(
      'order_id', v_order,
      'status', 'pending',
      'category_id', v_asset_category,
      'quantity', 1,
      'planned_start', (now()::date + interval '10 day')::date,
      'planned_end', (now()::date + interval '12 day')::date,
      'job_site_id', v_job_site,
      'rate_type', 'daily',
      'rate_amount_minor', 50000
    )
  );

  raise notice 'Seed data created';

  -- -------------------------------------------------------------------------
  -- 3. First conversion: draft → reservation.
  -- -------------------------------------------------------------------------
  select success, reservation_id, conflicts, message
    into v_first_success, v_first_reservation_id, v_first_conflicts, v_first_message
  from rental_convert_quote_to_reservation(v_order);

  if not v_first_success then
    raise exception 'Expected quoted order conversion to succeed; message: %', v_first_message;
  end if;

  if v_first_reservation_id is null then
    raise exception 'Expected conversion to return a reservation contract id';
  end if;

  if coalesce(jsonb_array_length(v_first_conflicts), 0) <> 0 then
    raise exception 'Expected first conversion to return no conflicts, got %', v_first_conflicts;
  end if;

  raise notice 'First conversion succeeded';

  -- -------------------------------------------------------------------------
  -- 4. Idempotency: calling conversion again returns the same reservation id.
  -- -------------------------------------------------------------------------
  select success, reservation_id, conflicts
    into v_retry_success, v_retry_reservation_id, v_retry_conflicts
  from rental_convert_quote_to_reservation(v_order);

  if not v_retry_success then
    raise exception 'Expected repeated quoted-order conversion to be idempotently successful';
  end if;

  if v_retry_reservation_id <> v_first_reservation_id then
    raise exception 'Expected repeated conversion to return original reservation id %, got %',
      v_first_reservation_id, v_retry_reservation_id;
  end if;

  if coalesce(jsonb_array_length(v_retry_conflicts), 0) <> 0 then
    raise exception 'Expected repeated conversion to return no conflicts, got %', v_retry_conflicts;
  end if;

  raise notice 'Idempotency check passed';

  -- -------------------------------------------------------------------------
  -- 5. Audit trail on the converted order.
  -- -------------------------------------------------------------------------
  select
    rental_order.data->>'conversion_actor_id',
    nullif(rental_order.data->>'conversion_source_order_id', '')::uuid,
    nullif(rental_order.data->>'converted_at', '')::timestamptz,
    rental_order.data->'quote_snapshot',
    nullif(rental_order.data->>'reservation_contract_id', '')::uuid
    into
      v_order_actor,
      v_order_source_id,
      v_order_converted_at,
      v_order_quote_snapshot,
      v_order_reservation_contract_id
  from v_rental_order_current rental_order
  where rental_order.entity_id = v_order;

  if coalesce(v_order_actor, '') = '' then
    raise exception 'Expected converted order to persist conversion_actor_id';
  end if;

  if v_order_actor <> 'service_role' then
    raise exception 'Expected conversion_actor_id ''service_role'' in service-role context, got %', v_order_actor;
  end if;

  if v_order_source_id <> v_order then
    raise exception 'Expected converted order to persist conversion_source_order_id %, got %',
      v_order, v_order_source_id;
  end if;

  if v_order_converted_at is null then
    raise exception 'Expected converted order to persist converted_at timestamp';
  end if;

  if coalesce(jsonb_typeof(v_order_quote_snapshot), 'null') <> 'object' then
    raise exception 'Expected converted order to persist quote_snapshot jsonb object, got %',
      coalesce(jsonb_typeof(v_order_quote_snapshot), 'null');
  end if;

  if v_order_reservation_contract_id <> v_first_reservation_id then
    raise exception 'Expected converted order reservation_contract_id %, got %',
      v_first_reservation_id, v_order_reservation_contract_id;
  end if;

  raise notice 'Converted order audit trail checks passed';

  -- -------------------------------------------------------------------------
  -- 6. Audit trail on the reservation contract.
  -- -------------------------------------------------------------------------
  select
    nullif(rental_contract.data->>'originating_quote_order_id', '')::uuid,
    rental_contract.data->'quote_snapshot',
    nullif(rental_contract.data->>'converted_at', '')::timestamptz,
    rental_contract.status
    into
      v_contract_order_id,
      v_contract_quote_snapshot,
      v_contract_converted_at,
      v_contract_status
  from v_rental_contract_current rental_contract
  where rental_contract.entity_id = v_first_reservation_id;

  if v_contract_order_id <> v_order then
    raise exception 'Expected reservation contract originating_quote_order_id %, got %',
      v_order, v_contract_order_id;
  end if;

  if coalesce(jsonb_typeof(v_contract_quote_snapshot), 'null') <> 'object' then
    raise exception 'Expected reservation contract to persist quote_snapshot jsonb object, got %',
      coalesce(jsonb_typeof(v_contract_quote_snapshot), 'null');
  end if;

  if v_contract_converted_at is null then
    raise exception 'Expected reservation contract to persist converted_at timestamp';
  end if;

  if v_contract_status <> 'pending_execution' then
    raise exception 'Expected reservation contract status pending_execution, got %', v_contract_status;
  end if;

  raise notice 'Reservation contract audit trail checks passed';

  -- -------------------------------------------------------------------------
  -- 7. Contract lines: at least one line was created from the order line,
  --    with a quote_line_snapshot capturing the original order line data.
  -- -------------------------------------------------------------------------
  select count(*)
    into v_contract_line_count
  from v_rental_contract_line_current contract_line
  where contract_line.contract_id = v_first_reservation_id::text;

  if v_contract_line_count < 1 then
    raise exception 'Expected at least one contract line under reservation contract, found %', v_contract_line_count;
  end if;

  select contract_line.data->'quote_line_snapshot'
    into v_contract_line_snapshot
  from v_rental_contract_line_current contract_line
  where contract_line.contract_id = v_first_reservation_id::text
  limit 1;

  if coalesce(jsonb_typeof(v_contract_line_snapshot), 'null') <> 'object' then
    raise exception 'Expected contract line to persist quote_line_snapshot jsonb object, got %',
      coalesce(jsonb_typeof(v_contract_line_snapshot), 'null');
  end if;

  raise notice 'Contract lines audit trail checks passed';

  raise notice 'All quote/direct-book conversion reset-path checks passed';
end;
$$;

rollback;
