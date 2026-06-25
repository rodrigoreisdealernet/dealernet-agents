begin;

do $$
declare
  v_order_id uuid;
  v_contract_id uuid;
  v_contract_line_id uuid;
  v_asset_id uuid;
  v_counterparty_id uuid;
  v_invoice_id uuid;
  v_invoice_line_id uuid;

  v_supply_id uuid;
  v_agreement_id uuid;
  v_initial_payable_event_id uuid;
  v_contract_line_version_id uuid;
  v_contract_line_version_number int;

  v_status text;
  v_source_provenance text;
  v_ownership_type text;
  v_return_completed_at timestamptz;

  v_view_contract_id text;
  v_view_invoice_line_id uuid;
  v_view_status text;
  v_view_source text;

  v_count int;
  v_log_count int;
  v_payable_count int;
  c_expected_log_count constant int := 5;
  c_expected_payable_count constant int := 4;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select entity_id into v_order_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'inbound-rerent-order-001',
    p_data => jsonb_build_object(
      'status', 'converted',
      'order_number', 'RO-INBOUND-001',
      'tenant', 'tenant-inbound',
      'rental_type', 'external'
    )
  );

  select entity_id into v_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'inbound-rerent-asset-001',
    p_data => jsonb_build_object(
      'name', 'Inbound Rerented Lift',
      'tenant', 'tenant-inbound',
      'ownership_type', 'external_rental'
    )
  );

  select entity_id into v_contract_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract',
    p_source_record_id => 'inbound-rerent-contract-001',
    p_data => jsonb_build_object(
      'status', 'active',
      'tenant', 'tenant-inbound',
      'contract_number', 'RC-INBOUND-001',
      'order_id', v_order_id::text,
      'rental_type', 'external'
    )
  );

  select entity_id into v_contract_line_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract_line',
    p_source_record_id => 'inbound-rerent-contract-line-001',
    p_data => jsonb_build_object(
      'status', 'checked_out',
      'tenant', 'tenant-inbound',
      'contract_id', v_contract_id::text,
      'asset_id', v_asset_id::text,
      'rate_type', 'daily',
      'rate_amount', 9000,
      'rental_type', 'external'
    )
  );

  insert into public.entities (entity_type, source_record_id)
  values ('vendor', 'inbound-vendor-001')
  returning id into v_counterparty_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_counterparty_id,
    1,
    jsonb_build_object(
      'name', 'Third Party Fleet Co',
      'tenant', 'tenant-inbound'
    )
  );

  insert into public.entities (entity_type, source_record_id)
  values ('invoice', 'inbound-invoice-001')
  returning id into v_invoice_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_invoice_id,
    1,
    jsonb_build_object(
      'invoice_number', 'INV-INBOUND-001',
      'tenant', 'tenant-inbound',
      'status', 'open'
    )
  );

  insert into public.entities (entity_type, source_record_id)
  values ('invoice_line', 'inbound-invoice-line-001')
  returning id into v_invoice_line_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_invoice_line_id,
    1,
    jsonb_build_object(
      'invoice_id', v_invoice_id::text,
      'contract_line_id', v_contract_line_id::text,
      'amount_minor', 27000,
      'tenant', 'tenant-inbound'
    )
  );

  select
    created.supply_id,
    created.agreement_id,
    created.payable_event_id,
    created.contract_line_version_id,
    created.contract_line_version_number
  into
    v_supply_id,
    v_agreement_id,
    v_initial_payable_event_id,
    v_contract_line_version_id,
    v_contract_line_version_number
  from public.rental_create_inbound_rerental_supply(
    p_contract_line_id => v_contract_line_id,
    p_counterparty_id => v_counterparty_id,
    p_agreement_source_record_id => 'AG-INBOUND-001',
    p_agreement_data => jsonb_build_object('agreement_type', 'short_term_rerental'),
    p_source_provenance => 'third_party_owned',
    p_expected_return_at => now() + interval '7 days',
    p_initial_payable_amount_minor => 18000,
    p_currency_code => 'USD',
    p_created_by => 'dispatcher-inbound'
  ) created;

  if v_supply_id is null then
    raise exception 'Expected supply_id from rental_create_inbound_rerental_supply';
  end if;

  if v_agreement_id is null then
    raise exception 'Expected agreement_id from rental_create_inbound_rerental_supply';
  end if;

  if v_initial_payable_event_id is null then
    raise exception 'Expected initial payable_event_id from rental_create_inbound_rerental_supply';
  end if;

  if v_contract_line_version_id is null or v_contract_line_version_number < 2 then
    raise exception 'Expected contract line to receive a new version after inbound rerental creation';
  end if;

  select custody_status, source_provenance, ownership_type
    into v_status, v_source_provenance, v_ownership_type
  from public.inbound_rerental_supply
  where id = v_supply_id;

  if v_status <> 'inbound_requested' then
    raise exception 'Expected initial custody_status inbound_requested, got %', v_status;
  end if;

  if v_source_provenance <> 'third_party_owned' then
    raise exception 'Expected source_provenance third_party_owned, got %', v_source_provenance;
  end if;

  if v_ownership_type <> 'external_rental' then
    raise exception 'Expected ownership_type external_rental, got %', v_ownership_type;
  end if;

  perform public.rental_transition_inbound_rerental_custody(
    p_supply_id => v_supply_id,
    p_to_status => 'inbound_received',
    p_changed_by => 'yard-intake'
  );

  perform public.rental_transition_inbound_rerental_custody(
    p_supply_id => v_supply_id,
    p_to_status => 'deployed_on_contract',
    p_changed_by => 'dispatcher-inbound',
    p_payable_amount_minor => 22000,
    p_currency_code => 'USD'
  );

  perform public.rental_transition_inbound_rerental_custody(
    p_supply_id => v_supply_id,
    p_to_status => 'off_hired_pending_return',
    p_changed_by => 'returns-team',
    p_payable_amount_minor => 5000,
    p_currency_code => 'USD'
  );

  perform public.rental_transition_inbound_rerental_custody(
    p_supply_id => v_supply_id,
    p_to_status => 'returned_to_owner',
    p_changed_by => 'yard-dispatch',
    p_invoice_line_id => v_invoice_line_id,
    p_payable_amount_minor => 1200,
    p_currency_code => 'USD'
  );

  select custody_status, return_completed_at
    into v_status, v_return_completed_at
  from public.inbound_rerental_supply
  where id = v_supply_id;

  if v_status <> 'returned_to_owner' then
    raise exception 'Expected final custody_status returned_to_owner, got %', v_status;
  end if;

  if v_return_completed_at is null then
    raise exception 'Expected return_completed_at to be populated when status is returned_to_owner';
  end if;

  select count(*)
    into v_log_count
  from public.inbound_rerental_custody_log
  where supply_id = v_supply_id;

  if v_log_count <> c_expected_log_count then
    raise exception 'Expected % custody log entries (create + 4 transitions), got %', c_expected_log_count, v_log_count;
  end if;

  select count(*)
    into v_payable_count
  from public.inbound_rerental_payable_event
  where supply_id = v_supply_id;

  if v_payable_count <> c_expected_payable_count then
    raise exception 'Expected % payable events (initial + 3 billed transitions), got %', c_expected_payable_count, v_payable_count;
  end if;

  select
    view_row.contract_id,
    view_row.invoice_line_id,
    view_row.custody_status,
    view_row.source_provenance
  into
    v_view_contract_id,
    v_view_invoice_line_id,
    v_view_status,
    v_view_source
  from public.v_inbound_rerental_supply_current view_row
  where view_row.supply_id = v_supply_id
  limit 1;

  if v_view_contract_id <> v_contract_id::text then
    raise exception 'Expected view contract_id % got %', v_contract_id, v_view_contract_id;
  end if;

  if v_view_invoice_line_id <> v_invoice_line_id then
    raise exception 'Expected view invoice_line_id % got %', v_invoice_line_id, v_view_invoice_line_id;
  end if;

  if v_view_status <> 'returned_to_owner' then
    raise exception 'Expected view custody_status returned_to_owner, got %', v_view_status;
  end if;

  if v_view_source <> 'third_party_owned' then
    raise exception 'Expected view source_provenance third_party_owned, got %', v_view_source;
  end if;

  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000ee01","app_metadata":{"role":"branch_manager","tenant":"tenant-inbound"}}',
    true
  );

  select count(*)
    into v_count
  from public.v_inbound_rerental_supply_current
  where supply_id = v_supply_id;

  if v_count <> 1 then
    raise exception 'Expected authenticated same-tenant caller to read supply row, got %', v_count;
  end if;

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000ee02","app_metadata":{"role":"branch_manager","tenant":"tenant-other"}}',
    true
  );

  select count(*)
    into v_count
  from public.v_inbound_rerental_supply_current
  where supply_id = v_supply_id;

  if v_count <> 0 then
    raise exception 'Expected cross-tenant authenticated caller to see 0 supply rows, got %', v_count;
  end if;
end;
$$;

rollback;
