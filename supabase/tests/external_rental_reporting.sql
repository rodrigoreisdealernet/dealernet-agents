begin;

select set_config('request.jwt.claims', '{"role":"service_role","app_metadata":{"role":"admin","tenant":"alpha"}}', true);
set local role service_role;

do $$
declare
  v_branch_id uuid;
  v_owned_asset_id uuid;
  v_rerent_asset_id uuid;
  v_contract_owned_id uuid;
  v_contract_rerent_id uuid;
  v_order_line_owned_id uuid;
  v_order_line_rerent_id uuid;
  v_contract_line_owned_id uuid;
  v_contract_line_rerent_id uuid;
  v_invoice_owned_id uuid;
  v_invoice_rerent_id uuid;
  v_calendar_fact_type_id uuid;
begin
  select id
    into v_calendar_fact_type_id
  from public.fact_types
  where key = 'asset_calendar_minutes';

  if v_calendar_fact_type_id is null then
    raise exception 'Expected fact_type asset_calendar_minutes to exist';
  end if;

  select entity_id into v_branch_id
  from public.create_entity_with_version(
    p_entity_type => 'branch',
    p_source_record_id => 'test-external-rental-branch',
    p_data => jsonb_build_object('name', 'Houston Central', 'tenant', 'alpha')
  );

  select entity_id into v_owned_asset_id
  from public.create_entity_with_version(
    p_entity_type => 'asset',
    p_source_record_id => 'test-external-rental-owned-asset',
    p_data => jsonb_build_object(
      'name', 'Owned Boom Lift',
      'ownership_type', 'owned',
      'calendar_minutes', 43200,
      'tenant', 'alpha'
    )
  );

  select entity_id into v_rerent_asset_id
  from public.create_entity_with_version(
    p_entity_type => 'asset',
    p_source_record_id => 'test-external-rental-rerent-asset',
    p_data => jsonb_build_object(
      'name', 'Vendor Telehandler',
      'ownership_type', 'external_rental',
      'calendar_minutes', 28800,
      'tenant', 'alpha'
    )
  );

  insert into public.entity_facts (entity_id, fact_type_id, value, source_id)
  values
    (v_owned_asset_id, v_calendar_fact_type_id, 43200, 'test-external-rental-owned-calendar'),
    (v_rerent_asset_id, v_calendar_fact_type_id, 28800, 'test-external-rental-rerent-calendar')
  on conflict (entity_id, fact_type_id, dimension_id)
  do update
    set value = excluded.value,
        source_id = excluded.source_id,
        updated_at = now();

  select entity_id into v_order_line_owned_id
  from public.create_entity_with_version(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'test-external-rental-order-line-owned',
    p_data => jsonb_build_object('tenant', 'alpha')
  );

  select entity_id into v_order_line_rerent_id
  from public.create_entity_with_version(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'test-external-rental-order-line-rerent',
    p_data => jsonb_build_object('tenant', 'alpha')
  );

  select entity_id into v_contract_owned_id
  from public.create_entity_with_version(
    p_entity_type => 'rental_contract',
    p_source_record_id => 'test-external-rental-contract-owned',
    p_data => jsonb_build_object(
      'contract_number', 'RC-OWNED-001',
      'rental_type', 'external',
      'branch_id', v_branch_id,
      'tenant', 'alpha',
      'transaction_currency_code', 'USD',
      'reporting_currency_code', 'USD',
      'fx_rate_applied', 1
    )
  );

  select entity_id into v_contract_rerent_id
  from public.create_entity_with_version(
    p_entity_type => 'rental_contract',
    p_source_record_id => 'test-external-rental-contract-rerent',
    p_data => jsonb_build_object(
      'contract_number', 'RC-RERENT-001',
      'rental_type', 'external',
      'branch_id', v_branch_id,
      'tenant', 'alpha',
      'transaction_currency_code', 'USD',
      'reporting_currency_code', 'USD',
      'fx_rate_applied', 1
    )
  );

  select entity_id into v_contract_line_owned_id
  from public.create_entity_with_version(
    p_entity_type => 'rental_contract_line',
    p_source_record_id => 'test-external-rental-contract-line-owned',
    p_data => jsonb_build_object(
      'contract_id', v_contract_owned_id,
      'order_line_id', v_order_line_owned_id,
      'asset_id', v_owned_asset_id,
      'fulfillment_branch_id', v_branch_id,
      'status', 'checked_out',
      'rental_type', 'external',
      'rate_type', 'daily',
      'rate_amount', 250,
      'actual_start', '2026-06-01',
      'actual_end', '2026-06-04',
      'tenant', 'alpha'
    )
  );

  select entity_id into v_contract_line_rerent_id
  from public.create_entity_with_version(
    p_entity_type => 'rental_contract_line',
    p_source_record_id => 'test-external-rental-contract-line-rerent',
    p_data => jsonb_build_object(
      'contract_id', v_contract_rerent_id,
      'order_line_id', v_order_line_rerent_id,
      'asset_id', v_rerent_asset_id,
      'fulfillment_branch_id', v_branch_id,
      'status', 'checked_out',
      'rental_type', 'external',
      'rate_type', 'daily',
      'rate_amount', 300,
      'actual_start', '2026-06-01',
      'actual_end', '2026-06-04',
      'tenant', 'alpha'
    )
  );

  select entity_id into v_invoice_owned_id
  from public.create_entity_with_version(
    p_entity_type => 'invoice',
    p_source_record_id => 'test-external-rental-invoice-owned',
    p_data => jsonb_build_object(
      'invoice_number', 'INV-OWNED-001',
      'invoice_date', '2026-06-02',
      'contract_id', v_contract_owned_id,
      'tenant', 'alpha',
      'transaction_currency_code', 'USD',
      'reporting_currency_code', 'USD',
      'fx_rate_applied', 1,
      'total', 740
    )
  );

  select entity_id into v_invoice_rerent_id
  from public.create_entity_with_version(
    p_entity_type => 'invoice',
    p_source_record_id => 'test-external-rental-invoice-rerent',
    p_data => jsonb_build_object(
      'invoice_number', 'INV-RERENT-001',
      'invoice_date', '2026-06-05',
      'contract_id', v_contract_rerent_id,
      'tenant', 'alpha',
      'transaction_currency_code', 'USD',
      'reporting_currency_code', 'USD',
      'fx_rate_applied', 1,
      'total', 1308
    )
  );

  perform public.create_entity_with_version(
    p_entity_type => 'invoice_line',
    p_source_record_id => 'test-external-rental-invoice-line-owned',
    p_data => jsonb_build_object(
      'invoice_id', v_invoice_owned_id,
      'contract_id', v_contract_owned_id,
      'line_item_id', v_contract_line_owned_id,
      'amount', 740,
      'tenant', 'alpha'
    )
  );

  perform public.create_entity_with_version(
    p_entity_type => 'invoice_line',
    p_source_record_id => 'test-external-rental-invoice-line-rerent',
    p_data => jsonb_build_object(
      'invoice_id', v_invoice_rerent_id,
      'contract_id', v_contract_rerent_id,
      'line_item_id', v_contract_line_rerent_id,
      'amount', 1308,
      'tenant', 'alpha'
    )
  );

  insert into public.rerent_unit_status_log (
    order_line_id, status_key, audience, changed_by, vendor_ref, tenant, changed_at
  ) values (
    v_order_line_rerent_id, 'on_rent', 'internal', 'sql-test', 'PO-44521', 'alpha', '2026-06-04T12:00:00Z'
  );
end;
$$;

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role","app_metadata":{"role":"admin","tenant":"alpha"}}', true);

do $$
declare
  v_contract_line_owned_id uuid;
  v_contract_line_rerent_id uuid;
  v_branch_id uuid;
  v_owned_row record;
  v_rerent_row record;
begin
  select id into v_contract_line_owned_id
  from public.entities
  where source_record_id = 'test-external-rental-contract-line-owned';

  select id into v_contract_line_rerent_id
  from public.entities
  where source_record_id = 'test-external-rental-contract-line-rerent';

  select id into v_branch_id
  from public.entities
  where source_record_id = 'test-external-rental-branch';

  select *
    into v_owned_row
  from public.v_external_rental_reporting_lines
  where contract_line_id = v_contract_line_owned_id;

  if v_owned_row.fulfillment_model <> 'owned_fleet_external_rental' then
    raise exception 'Expected owned line to classify as owned_fleet_external_rental, got %', v_owned_row.fulfillment_model;
  end if;

  if v_owned_row.customer_revenue_reporting_amount <> 740 then
    raise exception 'Expected owned line revenue 740, got %', v_owned_row.customer_revenue_reporting_amount;
  end if;

  if v_owned_row.utilization_uplift_pct <> 10.00 then
    raise exception 'Expected owned line utilization uplift 10.00, got %', v_owned_row.utilization_uplift_pct;
  end if;

  select *
    into v_rerent_row
  from public.v_external_rental_reporting_lines
  where contract_line_id = v_contract_line_rerent_id;

  if v_rerent_row.fulfillment_model <> 'third_party_rerental' then
    raise exception 'Expected rerent line to classify as third_party_rerental, got %', v_rerent_row.fulfillment_model;
  end if;

  if v_rerent_row.vendor_obligation_reporting_amount <> 900 then
    raise exception 'Expected rerent obligation 900, got %', v_rerent_row.vendor_obligation_reporting_amount;
  end if;

  if v_rerent_row.gross_margin_reporting_amount <> 408 then
    raise exception 'Expected rerent margin 408, got %', v_rerent_row.gross_margin_reporting_amount;
  end if;

  if v_rerent_row.vendor_ref <> 'PO-44521' then
    raise exception 'Expected rerent vendor_ref PO-44521, got %', v_rerent_row.vendor_ref;
  end if;

  if (select count(*) from public.v_external_rental_reporting_lines where branch_id = v_branch_id) <> 2 then
    raise exception 'Expected exactly 2 reporting rows for test branch';
  end if;
end;
$$;

do $$
declare
  v_contract_line_owned_id uuid;
  v_contract_line_rerent_id uuid;
  v_same_tenant_count int;
  v_cross_tenant_count int;
  v_owned_model text;
begin
  if not has_table_privilege('authenticated', 'public.v_external_rental_reporting_lines', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on public.v_external_rental_reporting_lines';
  end if;

  select id into v_contract_line_owned_id
  from public.entities
  where source_record_id = 'test-external-rental-contract-line-owned';

  select id into v_contract_line_rerent_id
  from public.entities
  where source_record_id = 'test-external-rental-contract-line-rerent';

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000c001","app_metadata":{"role":"read_only","tenant":"alpha"}}',
    true
  );

  select count(*)
    into v_same_tenant_count
  from public.v_external_rental_reporting_lines
  where contract_line_id in (v_contract_line_owned_id, v_contract_line_rerent_id);

  if v_same_tenant_count <> 2 then
    raise exception 'Expected authenticated tenant alpha to read 2 reporting rows, got %', v_same_tenant_count;
  end if;

  select fulfillment_model
    into v_owned_model
  from public.v_external_rental_reporting_lines
  where contract_line_id = v_contract_line_owned_id;

  if v_owned_model <> 'owned_fleet_external_rental' then
    raise exception 'Expected authenticated tenant alpha to read owned_fleet_external_rental, got %', v_owned_model;
  end if;

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000c002","app_metadata":{"role":"read_only","tenant":"beta"}}',
    true
  );

  select count(*)
    into v_cross_tenant_count
  from public.v_external_rental_reporting_lines
  where contract_line_id in (v_contract_line_owned_id, v_contract_line_rerent_id);

  if v_cross_tenant_count <> 0 then
    raise exception 'Expected authenticated tenant beta to read 0 alpha reporting rows, got %', v_cross_tenant_count;
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

rollback;
