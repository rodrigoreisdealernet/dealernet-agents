begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

-- Reset-path coverage for 20251210000000_rental_order_contract.sql.
--
-- Confirms that after a full `supabase db reset`:
--   1. The migration's dimension tables are seeded with representative rows.
--   2. The rental-domain fact_types exist with the expected units.
--   3. The current-state views surface the latest order/contract/contract-line
--      versions for a representative order-to-contract handoff scenario.

do $$
declare
  v_count bigint;
  v_is_terminal bool;
  v_blocks_checkout bool;
  v_unit text;
begin
  select count(*)
    into v_count
  from public.dim_rental_order_status
  where key = any(array['draft', 'quoted', 'approved', 'converted', 'cancelled', 'expired']);

  if v_count <> 6 then
    raise exception 'Expected 6 rental order status seeds, found %', v_count;
  end if;

  select is_terminal
    into v_is_terminal
  from public.dim_rental_order_status
  where key = 'converted';

  if coalesce(v_is_terminal, false) is not true then
    raise exception 'Expected dim_rental_order_status.converted to be terminal';
  end if;

  select count(*)
    into v_count
  from public.dim_rental_contract_status
  where key = any(array['pending_execution', 'active', 'closed', 'cancelled']);

  if v_count <> 4 then
    raise exception 'Expected 4 rental contract status seeds, found %', v_count;
  end if;

  select is_terminal
    into v_is_terminal
  from public.dim_rental_contract_status
  where key = 'closed';

  if coalesce(v_is_terminal, false) is not true then
    raise exception 'Expected dim_rental_contract_status.closed to be terminal';
  end if;

  select count(*)
    into v_count
  from public.dim_rental_line_status
  where key = any(array['pending', 'checked_out', 'returned', 'cancelled']);

  if v_count <> 4 then
    raise exception 'Expected 4 rental line status seeds, found %', v_count;
  end if;

  select count(*)
    into v_count
  from public.dim_asset_availability_status
  where key = any(array[
    'available',
    'on_transfer',
    'in_maintenance',
    'on_inspection_hold',
    'retired',
    'lost',
    'conflicting_assignment'
  ]);

  if v_count <> 7 then
    raise exception 'Expected 7 asset availability status seeds, found %', v_count;
  end if;

  select blocks_checkout
    into v_blocks_checkout
  from public.dim_asset_availability_status
  where key = 'available';

  if coalesce(v_blocks_checkout, true) is not false then
    raise exception 'Expected available assets not to block checkout';
  end if;

  select blocks_checkout
    into v_blocks_checkout
  from public.dim_asset_availability_status
  where key = 'conflicting_assignment';

  if coalesce(v_blocks_checkout, false) is not true then
    raise exception 'Expected conflicting_assignment assets to block checkout';
  end if;

  select count(*)
    into v_count
  from public.dim_rental_rate_type
  where key = any(array['daily', 'weekly', 'monthly', 'fixed']);

  if v_count <> 4 then
    raise exception 'Expected 4 rental rate type seeds, found %', v_count;
  end if;

  select count(*)
    into v_count
  from public.dim_rental_type
  where key = any(array['internal', 'external']);

  if v_count <> 2 then
    raise exception 'Expected 2 rental type seeds, found %', v_count;
  end if;

  select count(*)
    into v_count
  from public.fact_types
  where key = any(array[
    'rental_order_count',
    'rental_contract_count',
    'rental_line_duration_days',
    'rental_line_rate_amount'
  ]);

  if v_count <> 4 then
    raise exception 'Expected 4 rental-domain fact type seeds, found %', v_count;
  end if;

  select unit
    into v_unit
  from public.fact_types
  where key = 'rental_line_rate_amount';

  if v_unit <> 'minor_currency' then
    raise exception 'Expected rental_line_rate_amount unit minor_currency, got %', v_unit;
  end if;

  raise notice 'Dimension and fact-type seed checks passed';
end;
$$;

do $$
declare
  v_asset_category uuid;
  v_asset uuid;
  v_order uuid;
  v_contract uuid;
  v_contract_line uuid;
  v_version_count bigint;
  v_row_count bigint;
  v_order_status text;
  v_order_number text;
  v_order_rental_type text;
  v_order_requester_id text;
  v_order_created_by text;
  v_contract_status text;
  v_contract_number text;
  v_contract_order_id text;
  v_contract_rental_type text;
  v_line_status text;
  v_line_contract_id text;
  v_line_asset_id text;
  v_line_category_id text;
  v_line_rental_type text;
  v_line_rate_type text;
  v_line_rate_amount numeric;
  v_line_actual_start text;
begin
  select entity_id
    into v_asset_category
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_source_record_id => 'reset-order-contract-category-001',
    p_data => jsonb_build_object('name', 'Reset Order/Contract Category')
  );

  select entity_id
    into v_asset
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'reset-order-contract-asset-001',
    p_data => jsonb_build_object(
      'name', 'Reset Order/Contract Asset',
      'ownership_type', 'owned',
      'operational_status', 'available'
    )
  );

  select entity_id
    into v_order
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'reset-order-contract-order-001',
    p_data => jsonb_build_object(
      'status', 'draft',
      'order_number', 'RO-RESET-001',
      'rental_type', 'external',
      'requester_id', 'requester-reset-001',
      'created_by', 'dispatcher-a'
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'reset-order-contract-order-001',
    p_data => jsonb_build_object(
      'status', 'converted',
      'order_number', 'RO-RESET-001',
      'rental_type', 'external',
      'requester_id', 'requester-reset-001',
      'created_by', 'dispatcher-a',
      'reservation_contract_id', null,
      'converted_at', '2026-01-15T08:30:00Z'
    )
  );

  select entity_id
    into v_contract
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract',
    p_source_record_id => 'reset-order-contract-contract-001',
    p_data => jsonb_build_object(
      'status', 'pending_execution',
      'contract_number', 'RC-RESET-001',
      'order_id', v_order,
      'rental_type', 'external',
      'converted_at', '2026-01-15T08:31:00Z'
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract',
    p_source_record_id => 'reset-order-contract-contract-001',
    p_data => jsonb_build_object(
      'status', 'active',
      'contract_number', 'RC-RESET-001',
      'order_id', v_order,
      'rental_type', 'external',
      'converted_at', '2026-01-15T08:31:00Z'
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'reset-order-contract-order-001',
    p_data => jsonb_build_object(
      'status', 'converted',
      'order_number', 'RO-RESET-001',
      'rental_type', 'external',
      'requester_id', 'requester-reset-001',
      'created_by', 'dispatcher-a',
      'reservation_contract_id', v_contract,
      'converted_at', '2026-01-15T08:30:00Z'
    )
  );

  select entity_id
    into v_contract_line
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract_line',
    p_source_record_id => 'reset-order-contract-line-001',
    p_data => jsonb_build_object(
      'status', 'pending',
      'contract_id', v_contract,
      'asset_id', v_asset,
      'category_id', v_asset_category,
      'rental_type', 'external',
      'rate_type', 'weekly',
      'rate_amount', 125000
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract_line',
    p_source_record_id => 'reset-order-contract-line-001',
    p_data => jsonb_build_object(
      'status', 'checked_out',
      'contract_id', v_contract,
      'asset_id', v_asset,
      'category_id', v_asset_category,
      'rental_type', 'external',
      'rate_type', 'weekly',
      'rate_amount', 125000,
      'actual_start', '2026-01-16',
      'actual_end', null
    )
  );

  select count(*)
    into v_version_count
  from public.entity_versions
  where entity_id = v_order;

  if v_version_count < 2 then
    raise exception 'Expected rental_order fixture to create multiple versions, found %', v_version_count;
  end if;

  select count(*)
    into v_version_count
  from public.entity_versions
  where entity_id = v_contract;

  if v_version_count < 2 then
    raise exception 'Expected rental_contract fixture to create multiple versions, found %', v_version_count;
  end if;

  select count(*)
    into v_version_count
  from public.entity_versions
  where entity_id = v_contract_line;

  if v_version_count < 2 then
    raise exception 'Expected rental_contract_line fixture to create multiple versions, found %', v_version_count;
  end if;

  execute 'reset role';

  select count(*)
    into v_row_count
  from public.v_rental_order_current
  where entity_id = v_order;

  if v_row_count <> 1 then
    raise exception 'Expected exactly 1 current order row, found %', v_row_count;
  end if;

  select
    status,
    order_number,
    rental_type,
    requester_id,
    created_by
    into
      v_order_status,
      v_order_number,
      v_order_rental_type,
      v_order_requester_id,
      v_order_created_by
  from public.v_rental_order_current
  where entity_id = v_order;

  if v_order_status <> 'converted' then
    raise exception 'Expected current order status converted, got %', v_order_status;
  end if;

  if v_order_number <> 'RO-RESET-001' then
    raise exception 'Expected order_number RO-RESET-001, got %', v_order_number;
  end if;

  if v_order_rental_type <> 'external' then
    raise exception 'Expected order rental_type external, got %', v_order_rental_type;
  end if;

  if v_order_requester_id <> 'requester-reset-001' then
    raise exception 'Expected requester_id requester-reset-001, got %', v_order_requester_id;
  end if;

  if v_order_created_by <> 'dispatcher-a' then
    raise exception 'Expected created_by dispatcher-a, got %', v_order_created_by;
  end if;

  select count(*)
    into v_row_count
  from public.v_rental_contract_current
  where entity_id = v_contract;

  if v_row_count <> 1 then
    raise exception 'Expected exactly 1 current contract row, found %', v_row_count;
  end if;

  select
    status,
    contract_number,
    order_id,
    rental_type
    into
      v_contract_status,
      v_contract_number,
      v_contract_order_id,
      v_contract_rental_type
  from public.v_rental_contract_current
  where entity_id = v_contract;

  if v_contract_status <> 'active' then
    raise exception 'Expected current contract status active, got %', v_contract_status;
  end if;

  if v_contract_number <> 'RC-RESET-001' then
    raise exception 'Expected contract_number RC-RESET-001, got %', v_contract_number;
  end if;

  if v_contract_order_id <> v_order::text then
    raise exception 'Expected contract order_id % got %', v_order, v_contract_order_id;
  end if;

  if v_contract_rental_type <> 'external' then
    raise exception 'Expected contract rental_type external, got %', v_contract_rental_type;
  end if;

  select count(*)
    into v_row_count
  from public.v_rental_contract_line_current
  where entity_id = v_contract_line;

  if v_row_count <> 1 then
    raise exception 'Expected exactly 1 current contract-line row, found %', v_row_count;
  end if;

  select
    status,
    contract_id,
    asset_id,
    category_id,
    rental_type,
    rate_type,
    rate_amount,
    actual_start
    into
      v_line_status,
      v_line_contract_id,
      v_line_asset_id,
      v_line_category_id,
      v_line_rental_type,
      v_line_rate_type,
      v_line_rate_amount,
      v_line_actual_start
  from public.v_rental_contract_line_current
  where entity_id = v_contract_line;

  if v_line_status <> 'checked_out' then
    raise exception 'Expected current contract-line status checked_out, got %', v_line_status;
  end if;

  if v_line_contract_id <> v_contract::text then
    raise exception 'Expected contract-line contract_id % got %', v_contract, v_line_contract_id;
  end if;

  if v_line_asset_id <> v_asset::text then
    raise exception 'Expected contract-line asset_id % got %', v_asset, v_line_asset_id;
  end if;

  if v_line_category_id <> v_asset_category::text then
    raise exception 'Expected contract-line category_id % got %', v_asset_category, v_line_category_id;
  end if;

  if v_line_rental_type <> 'external' then
    raise exception 'Expected contract-line rental_type external, got %', v_line_rental_type;
  end if;

  if v_line_rate_type <> 'weekly' then
    raise exception 'Expected contract-line rate_type weekly, got %', v_line_rate_type;
  end if;

  if v_line_rate_amount <> 125000 then
    raise exception 'Expected contract-line rate_amount 125000, got %', v_line_rate_amount;
  end if;

  if v_line_actual_start <> '2026-01-16' then
    raise exception 'Expected contract-line actual_start 2026-01-16, got %', v_line_actual_start;
  end if;

  raise notice 'Current-state view handoff checks passed';
end;
$$;

rollback;
