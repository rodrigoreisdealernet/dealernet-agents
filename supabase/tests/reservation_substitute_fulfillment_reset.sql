begin;

do $$
declare
  v_branch_primary uuid;
  v_branch_alternative uuid;
  v_customer uuid;
  v_billing_account uuid;
  v_job_site uuid;
  v_asset_category uuid;
  v_asset uuid;
  v_order uuid;
  v_line uuid;
  v_first_success bool;
  v_first_conflicts jsonb;
  v_second_success bool;
  v_second_reservation uuid;
  v_contract_line_branch uuid;
  v_order_status text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id into v_branch_primary
  from rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'substitute-branch-primary-001',
    p_data => jsonb_build_object('name', 'Primary Branch', 'branch_code', 'PRIM')
  );

  select entity_id into v_branch_alternative
  from rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'substitute-branch-alt-001',
    p_data => jsonb_build_object('name', 'Alternative Branch', 'branch_code', 'ALT')
  );

  select entity_id into v_customer
  from rental_upsert_entity_current_state(
    p_entity_type => 'customer',
    p_source_record_id => 'substitute-customer-001',
    p_data => jsonb_build_object('name', 'Substitute Customer')
  );

  select entity_id into v_billing_account
  from rental_upsert_entity_current_state(
    p_entity_type => 'billing_account',
    p_source_record_id => 'substitute-billing-001',
    p_data => jsonb_build_object('name', 'Substitute Billing')
  );

  select entity_id into v_job_site
  from rental_upsert_entity_current_state(
    p_entity_type => 'job_site',
    p_source_record_id => 'substitute-job-site-001',
    p_data => jsonb_build_object('name', 'Substitute Site')
  );

  select entity_id into v_asset_category
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_source_record_id => 'substitute-category-001',
    p_data => jsonb_build_object('name', 'Substitute Forklift')
  );

  select entity_id into v_asset
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'substitute-asset-001',
    p_data => jsonb_build_object(
      'name', 'Substitute Asset',
      'ownership_type', 'owned',
      'operational_status', 'available'
    )
  );

  perform rental_upsert_relationship('branch_has_asset', v_branch_alternative, v_asset);
  perform rental_upsert_relationship('asset_category_has_asset', v_asset_category, v_asset);

  select entity_id into v_order
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'substitute-order-001',
    p_data => jsonb_build_object(
      'order_number', 'RO-SUB-001',
      'status', 'quoted',
      'rental_type', 'external',
      'branch_id', v_branch_primary,
      'customer_id', v_customer,
      'billing_account_id', v_billing_account,
      'job_site_id', v_job_site
    )
  );

  select entity_id into v_line
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'substitute-order-line-001',
    p_data => jsonb_build_object(
      'order_id', v_order,
      'status', 'pending',
      'category_id', v_asset_category,
      'quantity', 1,
      'planned_start', (now()::date + interval '10 day')::date,
      'planned_end', (now()::date + interval '11 day')::date,
      'job_site_id', v_job_site,
      'rate_type', 'daily'
    )
  );

  select success, conflicts
    into v_first_success, v_first_conflicts
  from rental_convert_quote_to_reservation(v_order);

  if v_first_success then
    raise exception 'Expected first conversion attempt to fail for unavailable primary branch inventory';
  end if;

  if coalesce(jsonb_array_length(v_first_conflicts), 0) = 0 then
    raise exception 'Expected conversion conflicts to include substitute recommendations';
  end if;

  perform rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_entity_id => v_line,
    p_data => (
      select order_line.data || jsonb_build_object(
        'status', 'pending',
        'branch_id', v_branch_alternative,
        'fulfillment_source', 'internal_substitute',
        'shortage_route', 'same_category_other_location',
        'substitute_recommendation', jsonb_build_object(
          'selected_branch_id', v_branch_alternative,
          'selected_asset_category_id', v_asset_category,
          'fit_type', 'same_category_other_location',
          'selected_by_role', 'service_role'
        )
      )
      from v_rental_order_line_current order_line
      where order_line.entity_id = v_line
    )
  );

  select success, reservation_id
    into v_second_success, v_second_reservation
  from rental_convert_quote_to_reservation(v_order);

  if not v_second_success then
    raise exception 'Expected conversion to succeed after accepting substitute branch recommendation';
  end if;

  if v_second_reservation is null then
    raise exception 'Expected reservation id after successful substitute conversion';
  end if;

  select nullif(contract_line.data->>'fulfillment_branch_id', '')::uuid
    into v_contract_line_branch
  from v_rental_contract_line_current contract_line
  where nullif(contract_line.contract_id, '')::uuid = v_second_reservation
  order by contract_line.entity_id
  limit 1;

  if v_contract_line_branch <> v_branch_alternative then
    raise exception 'Expected reservation contract line fulfillment_branch_id % but found %', v_branch_alternative, v_contract_line_branch;
  end if;

  select rental_order.status
    into v_order_status
  from v_rental_order_current rental_order
  where rental_order.entity_id = v_order;

  if v_order_status <> 'converted' then
    raise exception 'Expected order status converted after substitute conversion, got %', v_order_status;
  end if;

  raise notice 'Substitute fulfillment conversion reset checks passed';
end;
$$;

reset role;

set local role authenticated;

do $$
declare
  v_order_id uuid;
  v_order_line_rows integer;
  v_quote_line_rows integer;
  v_conversion_success bool;
  v_conversion_conflicts jsonb;
  v_conversion_message text;
begin
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', 'default')
    )::text,
    true
  );

  select rental_order.entity_id
    into v_order_id
  from public.v_rental_order_current rental_order
  where rental_order.order_number = 'RO-SUB-001';

  if v_order_id is null then
    raise exception 'Expected authenticated role fixture lookup for RO-SUB-001';
  end if;

  select count(*)
    into v_order_line_rows
  from public.v_rental_order_line_current
  where nullif(order_id, '')::uuid = v_order_id;

  if v_order_line_rows = 0 then
    raise exception 'Expected authenticated role to read v_rental_order_line_current';
  end if;

  select count(*)
    into v_quote_line_rows
  from public.rental_quote_line_availability_current
  where order_id = v_order_id;

  if v_quote_line_rows = 0 then
    raise exception 'Expected authenticated role to read rental_quote_line_availability_current';
  end if;

  select success, conflicts, message
    into v_conversion_success, v_conversion_conflicts, v_conversion_message
  from public.rental_convert_quote_to_reservation(gen_random_uuid());

  if v_conversion_success then
    raise exception 'Expected authenticated conversion for unknown order to return success=false';
  end if;

  if coalesce(jsonb_array_length(v_conversion_conflicts), 0) <> 0 then
    raise exception 'Expected authenticated conversion for unknown order to return empty conflicts';
  end if;

  if v_conversion_message is distinct from 'Order not found.' then
    raise exception 'Expected authenticated conversion for unknown order to return "Order not found.", got %', v_conversion_message;
  end if;
end;
$$;

reset role;

set local role anon;

do $$
declare
  v_caught bool := false;
  v_dummy int;
begin
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'anon')::text,
    true
  );

  begin
    select count(*) into v_dummy from public.v_rental_order_line_current;
    raise exception 'Expected insufficient_privilege for anon on v_rental_order_line_current but query succeeded';
  exception
    when insufficient_privilege then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on v_rental_order_line_current';
  end if;

  v_caught := false;
  begin
    select count(*) into v_dummy from public.rental_quote_line_availability_current;
    raise exception 'Expected insufficient_privilege for anon on rental_quote_line_availability_current but query succeeded';
  exception
    when insufficient_privilege then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on rental_quote_line_availability_current';
  end if;

  v_caught := false;
  begin
    perform 1
    from public.rental_convert_quote_to_reservation(gen_random_uuid());
    raise exception 'Expected insufficient_privilege for anon on rental_convert_quote_to_reservation but execute succeeded';
  exception
    when insufficient_privilege then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on rental_convert_quote_to_reservation';
  end if;
end;
$$;

reset role;

rollback;
