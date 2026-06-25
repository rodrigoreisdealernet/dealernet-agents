begin;

do $$
declare
  v_branch_north uuid;
  v_branch_south uuid;
  v_customer uuid;
  v_billing_account uuid;
  v_contact uuid;
  v_job_site uuid;
  v_asset_category uuid;
  v_asset_a uuid;
  v_asset_b uuid;
  v_asset_work uuid;
  v_maintenance uuid;
  v_inspection uuid;
  v_branch_id uuid;
  v_category_id uuid;
  v_ownership_type text;
  v_operational_status text;
  v_version_number int;
  v_current_branch_relationships bigint;
  v_available_assets bigint;
  v_unavailable_assets bigint;
  v_due_assets bigint;
  v_overdue_assets bigint;
  v_total_assets bigint;
  v_customer_relationships bigint;
  v_entity_type_count bigint;
  v_relationship_type_count bigint;
  v_asset_work_relationships bigint;
  v_maintenance_due_at timestamptz;
  v_maintenance_due_status text;
  v_order_for_conversion uuid;
  v_order_line_for_conversion uuid;
  v_direct_book_order uuid;
  v_direct_book_line uuid;
  v_conversion_success bool;
  v_conversion_reservation_id uuid;
  v_conversion_conflicts jsonb;
  v_conversion_message text;
  v_direct_book_success bool;
  v_direct_book_reservation_id uuid;
  v_direct_book_conflicts jsonb;
  v_direct_book_retry_success bool;
  v_direct_book_retry_reservation_id uuid;
  v_direct_book_retry_conflicts jsonb;
  v_order_conversion_actor text;
  v_order_conversion_source_id uuid;
  v_order_converted_at timestamptz;
  v_contract_originating_order_id uuid;
  v_contract_quote_snapshot jsonb;
  v_contract_converted_at timestamptz;
  v_quote_requested_quantity int;
  v_quote_available_quantity bigint;
  v_quote_is_available bool;
  v_quote_shortage_reason text;
  v_quote_alternatives jsonb;
  v_table text;
  v_has_select_privilege bool;
  v_has_insert_privilege bool;
  v_has_update_privilege bool;
  v_has_delete_privilege bool;
  v_rls_enabled_count int;
  v_anon_read_policy_count int;
  v_anon_write_policy_count int;
  v_service_role_write_policy_count int;
  v_authenticated_write_policy_count int;
  v_expected_rental_table_count int;
  v_create_entity_guard_def text;
  v_upsert_entity_guard_def text;
  v_upsert_relationship_guard_def text;
  v_expected_modern_claim_pattern constant text := 'request.jwt.claims';
  v_legacy_empty_role_hole_pattern constant text := 'v_request_role in ('''', ''service_role'')';
  v_rental_tables constant text[] := array[
    'entities',
    'entity_versions',
    'relationships_v2',
    'fact_types',
    'entity_facts',
    'time_series_points',
    'dim_rental_order_status',
    'dim_rental_contract_status',
    'dim_rental_line_status',
    'dim_asset_availability_status',
    'dim_rental_rate_type',
    'dim_rental_type'
  ];
begin
  v_expected_rental_table_count := coalesce(array_length(v_rental_tables, 1), 0);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select pg_get_functiondef('public.create_entity_with_version(text, jsonb, text)'::regprocedure)
    into v_create_entity_guard_def;
  select pg_get_functiondef('public.rental_upsert_entity_current_state(text, jsonb, uuid, text)'::regprocedure)
    into v_upsert_entity_guard_def;
  select pg_get_functiondef('public.rental_upsert_relationship(text, uuid, uuid, jsonb, timestamptz)'::regprocedure)
    into v_upsert_relationship_guard_def;

  -- Substring guards are intentional here: we assert the migration-chain function
  -- text includes the modern-claims lookup token and excludes the historical empty
  -- role allowance token, regardless of whitespace/layout changes.
  if position(v_expected_modern_claim_pattern in v_create_entity_guard_def) = 0
     or position(v_expected_modern_claim_pattern in v_upsert_entity_guard_def) = 0
     or position(v_expected_modern_claim_pattern in v_upsert_relationship_guard_def) = 0 then
    raise exception 'Expected hardened write RPC guards to read request.jwt.claims for modern PostgREST payloads';
  end if;

  if position(v_legacy_empty_role_hole_pattern in v_create_entity_guard_def) > 0
     or position(v_legacy_empty_role_hole_pattern in v_upsert_entity_guard_def) > 0
     or position(v_legacy_empty_role_hole_pattern in v_upsert_relationship_guard_def) > 0 then
    raise exception 'Detected empty-role allowance in write RPC guards; expected this hole to remain closed';
  end if;

  select count(*)
    into v_entity_type_count
  from rental_entity_type_catalog
  where entity_type in ('maintenance_record', 'inspection');

  if v_entity_type_count <> 2 then
    raise exception 'Expected 2 entity types (maintenance_record and inspection) in catalog, found % entries', v_entity_type_count;
  end if;

  select count(*)
    into v_relationship_type_count
  from rental_relationship_type_catalog
  where (relationship_type, parent_entity_type, child_entity_type) in (
    ('asset_has_maintenance_record', 'asset', 'maintenance_record'),
    ('asset_has_inspection', 'asset', 'inspection')
  );

  if v_relationship_type_count <> 2 then
    raise exception 'Expected 2 relationship types in catalog (asset_has_maintenance_record, asset_has_inspection), found % entries', v_relationship_type_count;
  end if;

  select entity_id
    into v_branch_north
  from rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'branch-north',
    p_data => jsonb_build_object(
      'name', 'North Branch',
      'branch_code', 'BR-N'
    )
  );

  select entity_id
    into v_branch_south
  from rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'branch-south',
    p_data => jsonb_build_object(
      'name', 'South Branch',
      'branch_code', 'BR-S'
    )
  );

  select entity_id
    into v_customer
  from rental_upsert_entity_current_state(
    p_entity_type => 'customer',
    p_source_record_id => 'customer-acme',
    p_data => jsonb_build_object('name', 'Acme Construction')
  );

  select entity_id
    into v_billing_account
  from rental_upsert_entity_current_state(
    p_entity_type => 'billing_account',
    p_source_record_id => 'billing-acme-main',
    p_data => jsonb_build_object('name', 'Acme Main Billing')
  );

  select entity_id
    into v_contact
  from rental_upsert_entity_current_state(
    p_entity_type => 'contact',
    p_source_record_id => 'contact-jane-doe',
    p_data => jsonb_build_object('name', 'Jane Doe')
  );

  select entity_id
    into v_job_site
  from rental_upsert_entity_current_state(
    p_entity_type => 'job_site',
    p_source_record_id => 'job-site-riverfront',
    p_data => jsonb_build_object('name', 'Riverfront Expansion')
  );

  select entity_id
    into v_asset_category
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_source_record_id => 'asset-category-excavators',
    p_data => jsonb_build_object('name', 'Excavators')
  );

  perform rental_upsert_relationship('customer_has_billing_account', v_customer, v_billing_account);
  perform rental_upsert_relationship('customer_has_contact', v_customer, v_contact);
  perform rental_upsert_relationship('customer_has_job_site', v_customer, v_job_site);

  select count(*)
    into v_customer_relationships
  from rental_current_relationships
  where parent_id = v_customer;

  if v_customer_relationships <> 3 then
    raise exception 'Expected 3 current customer relationships, found %', v_customer_relationships;
  end if;

  select entity_id
    into v_asset_a
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'asset-ex-001',
    p_data => jsonb_build_object(
      'name', 'Excavator A',
      'ownership_type', 'owned',
      'operational_status', 'available',
      'maintenance_due_at', now() + interval '3 days'
    )
  );

  perform rental_upsert_relationship('branch_has_asset', v_branch_north, v_asset_a);
  perform rental_upsert_relationship('asset_category_has_asset', v_asset_category, v_asset_a);

  select
    current_branch_id,
    current_asset_category_id,
    ownership_type,
    operational_status
    into v_branch_id, v_category_id, v_ownership_type, v_operational_status
  from rental_current_assets
  where entity_id = v_asset_a;

  if v_branch_id <> v_branch_north then
    raise exception 'Asset A current branch mismatch: expected %, got %', v_branch_north, v_branch_id;
  end if;

  if v_category_id <> v_asset_category then
    raise exception 'Asset A current category mismatch: expected %, got %', v_asset_category, v_category_id;
  end if;

  if v_ownership_type <> 'owned' then
    raise exception 'Asset A ownership type mismatch: expected owned, got %', v_ownership_type;
  end if;

  if v_operational_status <> 'available' then
    raise exception 'Asset A operational status mismatch: expected available, got %', v_operational_status;
  end if;

  select maintenance_due_at, maintenance_due_status
    into v_maintenance_due_at, v_maintenance_due_status
  from rental_current_assets
  where entity_id = v_asset_a;

  if v_maintenance_due_at is null then
    raise exception 'Expected maintenance_due_at to be set for Asset A, got null';
  end if;

  if v_maintenance_due_status <> 'due' then
    raise exception 'Expected maintenance_due_status ''due'' for Asset A (due in 3 days, within 14-day window), got %', v_maintenance_due_status;
  end if;

  select version_number
    into v_version_number
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_entity_id => v_asset_a,
    p_data => jsonb_build_object(
      'name', 'Excavator A',
      'ownership_type', 'owned',
      'operational_status', 'maintenance',
      'maintenance_due_at', now() + interval '3 days'
    )
  );

  if v_version_number <> 2 then
    raise exception 'Expected Asset A maintenance update to create version 2, got %', v_version_number;
  end if;

  select
    operational_status,
    version_number
    into v_operational_status, v_version_number
  from rental_current_assets
  where entity_id = v_asset_a;

  if v_operational_status <> 'maintenance' then
    raise exception 'Expected Asset A current status maintenance after update, got %', v_operational_status;
  end if;

  if v_version_number <> 2 then
    raise exception 'Expected Asset A current version number 2 after update, got %', v_version_number;
  end if;

  perform rental_upsert_relationship('branch_has_asset', v_branch_south, v_asset_a);

  select count(*)
    into v_current_branch_relationships
  from relationships_v2
  where relationship_type = 'branch_has_asset'
    and child_id = v_asset_a
    and is_current;

  if v_current_branch_relationships <> 1 then
    raise exception 'Expected exactly one current branch assignment for Asset A, found %', v_current_branch_relationships;
  end if;

  select version_number
    into v_version_number
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_entity_id => v_asset_a,
    p_data => jsonb_build_object(
      'name', 'Excavator A',
      'ownership_type', 'owned',
      'operational_status', 'available',
      'maintenance_due_at', now() + interval '3 days'
    )
  );

  if v_version_number <> 3 then
    raise exception 'Expected Asset A availability update to create version 3, got %', v_version_number;
  end if;

  select
    current_branch_id,
    operational_status
    into v_branch_id, v_operational_status
  from rental_current_assets
  where entity_id = v_asset_a;

  if v_branch_id <> v_branch_south then
    raise exception 'Asset A branch reassignment mismatch: expected %, got %', v_branch_south, v_branch_id;
  end if;

  if v_operational_status <> 'available' then
    raise exception 'Asset A should return to available status, got %', v_operational_status;
  end if;

  select entity_id
    into v_asset_b
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'asset-ex-002',
    p_data => jsonb_build_object(
      'name', 'Excavator B',
      'ownership_type', 'leased',
      'operational_status', 'maintenance',
      'maintenance_due_at', now() - interval '1 day'
    )
  );

  perform rental_upsert_relationship('branch_has_asset', v_branch_south, v_asset_b);
  perform rental_upsert_relationship('asset_category_has_asset', v_asset_category, v_asset_b);

  select
    total_assets,
    available_assets,
    unavailable_assets,
    maintenance_due_assets,
    maintenance_overdue_assets
    into v_total_assets, v_available_assets, v_unavailable_assets, v_due_assets, v_overdue_assets
  from rental_asset_availability(v_branch_south, v_asset_category);

  if v_total_assets <> 2 then
    raise exception 'Expected 2 south-branch excavators in availability view, found %', v_total_assets;
  end if;

  if v_available_assets <> 1 then
    raise exception 'Expected 1 available south-branch excavator, found %', v_available_assets;
  end if;

  if v_unavailable_assets <> 1 then
    raise exception 'Expected 1 unavailable south-branch excavator, found %', v_unavailable_assets;
  end if;

  if v_due_assets <> 1 then
    raise exception 'Expected 1 maintenance-due south-branch excavator, found %', v_due_assets;
  end if;

  if v_overdue_assets <> 1 then
    raise exception 'Expected 1 maintenance-overdue south-branch excavator, found %', v_overdue_assets;
  end if;

  select entity_id
    into v_order_for_conversion
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'test-quote-overbook-001',
    p_data => jsonb_build_object(
      'name', 'Test Quote Overbook',
      'order_number', 'RO-TEST-001',
      'status', 'quoted',
      'rental_type', 'external',
      'branch_id', v_branch_south,
      'job_site_id', v_job_site
    )
  );

  select entity_id
    into v_order_line_for_conversion
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'test-quote-overbook-line-001',
    p_data => jsonb_build_object(
      'order_id', v_order_for_conversion,
      'status', 'pending',
      'category_id', v_asset_category,
      'quantity', 2,
      'planned_start', (now()::date - interval '1 day')::date,
      'planned_end', (now()::date + interval '2 day')::date,
      'job_site_id', v_job_site,
      'rate_type', 'weekly'
    )
  );

  select
    requested_quantity,
    available_quantity,
    is_available,
    shortage_reason,
    alternatives
    into v_quote_requested_quantity, v_quote_available_quantity, v_quote_is_available, v_quote_shortage_reason, v_quote_alternatives
  from rental_quote_availability(
    p_asset_category_id => v_asset_category,
    p_branch_id => v_branch_south,
    p_quantity => 2,
    p_start_date => (now()::date - interval '1 day')::date,
    p_end_date => (now()::date + interval '2 day')::date
  );

  if v_quote_is_available then
    raise exception 'Expected quote availability to flag shortage for overbook scenario';
  end if;

  if v_quote_requested_quantity <> 2 then
    raise exception 'Expected requested quantity echo of 2, got %', v_quote_requested_quantity;
  end if;

  if v_quote_shortage_reason is null then
    raise exception 'Expected shortage reason for overbook scenario, got null';
  end if;

  if jsonb_typeof(v_quote_alternatives) <> 'array' then
    raise exception 'Expected alternatives payload to be a JSON array, got %', coalesce(jsonb_typeof(v_quote_alternatives), 'null');
  end if;

  if coalesce(jsonb_array_length(v_quote_alternatives), 0) > 0 then
    if coalesce((v_quote_alternatives->0->>'recommendation_rank')::int, 0) <> 1 then
      raise exception 'Expected first alternative recommendation_rank=1, got %',
        coalesce(v_quote_alternatives->0->>'recommendation_rank', 'null');
    end if;

    if coalesce(v_quote_alternatives->0->>'recommendation_reason_code', '') = '' then
      raise exception 'Expected first alternative recommendation_reason_code to be populated';
    end if;

    if coalesce(v_quote_alternatives->0->>'transfer_cost_band', '') = '' then
      raise exception 'Expected first alternative transfer_cost_band to be populated';
    end if;

    if coalesce(v_quote_alternatives->0->>'availability_model', '') <> 'rental_asset_availability_current' then
      raise exception 'Expected alternatives to cite canonical availability model, got %',
        coalesce(v_quote_alternatives->0->>'availability_model', 'null');
    end if;
  end if;

  select
    success,
    reservation_id,
    conflicts,
    message
    into v_conversion_success, v_conversion_reservation_id, v_conversion_conflicts, v_conversion_message
  from rental_convert_quote_to_reservation(v_order_for_conversion);

  if v_conversion_success then
    raise exception 'Expected conversion to fail for overbooked quote';
  end if;

  if coalesce(jsonb_array_length(v_conversion_conflicts), 0) = 0 then
    raise exception 'Expected conversion conflicts payload when overbooked';
  end if;

  if position('blocked' in lower(coalesce(v_conversion_message, ''))) = 0 then
    raise exception 'Expected conversion message to explain blocking conflict, got %', v_conversion_message;
  end if;

  select entity_id
    into v_direct_book_order
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'test-direct-book-order-001',
    p_data => jsonb_build_object(
      'order_number', 'RO-DIRECT-001',
      'status', 'quoted',
      'rental_type', 'external',
      'branch_id', v_branch_south,
      'customer_id', v_customer,
      'billing_account_id', v_billing_account,
      'job_site_id', v_job_site,
      'pricing_snapshot', jsonb_build_object(
        'subtotal_minor', 32500,
        'tax_minor', 2600,
        'total_minor', 35100
      )
    )
  );

  select entity_id
    into v_direct_book_line
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'test-direct-book-line-001',
    p_data => jsonb_build_object(
      'order_id', v_direct_book_order,
      'status', 'pending',
      'category_id', v_asset_category,
      'quantity', 1,
      'planned_start', (now()::date + interval '7 day')::date,
      'planned_end', (now()::date + interval '9 day')::date,
      'job_site_id', v_job_site,
      'rate_type', 'daily',
      'rate_amount_minor', 32500
    )
  );

  select success, reservation_id, conflicts
    into v_direct_book_success, v_direct_book_reservation_id, v_direct_book_conflicts
  from rental_convert_quote_to_reservation(v_direct_book_order);

  if not v_direct_book_success then
    raise exception 'Expected quoted-order conversion to succeed';
  end if;

  if v_direct_book_reservation_id is null then
    raise exception 'Expected direct-book conversion to return reservation id';
  end if;

  if coalesce(jsonb_array_length(v_direct_book_conflicts), 0) <> 0 then
    raise exception 'Expected successful direct-book conversion to return no conflicts, got %', v_direct_book_conflicts;
  end if;

  select success, reservation_id, conflicts
    into v_direct_book_retry_success, v_direct_book_retry_reservation_id, v_direct_book_retry_conflicts
  from rental_convert_quote_to_reservation(v_direct_book_order);

  if not v_direct_book_retry_success then
    raise exception 'Expected repeated quoted-order conversion to be idempotently successful';
  end if;

  if v_direct_book_retry_reservation_id <> v_direct_book_reservation_id then
    raise exception 'Expected repeated conversion to return original reservation id %, got %', v_direct_book_reservation_id, v_direct_book_retry_reservation_id;
  end if;

  if coalesce(jsonb_array_length(v_direct_book_retry_conflicts), 0) <> 0 then
    raise exception 'Expected repeated conversion to return no conflicts, got %', v_direct_book_retry_conflicts;
  end if;

  select
    rental_order.data->>'conversion_actor_id',
    nullif(rental_order.data->>'conversion_source_order_id', '')::uuid,
    nullif(rental_order.data->>'converted_at', '')::timestamptz
    into v_order_conversion_actor, v_order_conversion_source_id, v_order_converted_at
  from v_rental_order_current rental_order
  where rental_order.entity_id = v_direct_book_order;

  if coalesce(v_order_conversion_actor, '') = '' then
    raise exception 'Expected converted order to persist conversion actor id';
  end if;

  if v_order_conversion_actor <> 'service_role' then
    raise exception 'Expected converted order actor id service_role in service-role fixture, got %', v_order_conversion_actor;
  end if;

  if v_order_conversion_source_id <> v_direct_book_order then
    raise exception 'Expected converted order to persist source order id %, got %', v_direct_book_order, v_order_conversion_source_id;
  end if;

  if v_order_converted_at is null then
    raise exception 'Expected converted order to persist converted_at timestamp';
  end if;

  select
    nullif(rental_contract.data->>'originating_quote_order_id', '')::uuid,
    rental_contract.data->'quote_snapshot',
    nullif(rental_contract.data->>'converted_at', '')::timestamptz
    into v_contract_originating_order_id, v_contract_quote_snapshot, v_contract_converted_at
  from v_rental_contract_current rental_contract
  where rental_contract.entity_id = v_direct_book_reservation_id;

  if v_contract_originating_order_id <> v_direct_book_order then
    raise exception 'Expected reservation contract to persist originating quote order id %, got %', v_direct_book_order, v_contract_originating_order_id;
  end if;

  if coalesce(jsonb_typeof(v_contract_quote_snapshot), 'null') <> 'object' then
    raise exception 'Expected reservation contract quote snapshot object, got %', coalesce(jsonb_typeof(v_contract_quote_snapshot), 'null');
  end if;

  if v_contract_converted_at is null then
    raise exception 'Expected reservation contract to persist converted_at timestamp';
  end if;

  select entity_id
    into v_asset_work
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'asset-work-001',
    p_data => jsonb_build_object('name', 'Excavator Work Item Asset')
  );

  select entity_id
    into v_maintenance
  from rental_upsert_entity_current_state(
    p_entity_type => 'maintenance_record',
    p_source_record_id => 'maint-work-001',
    p_data => jsonb_build_object('status', 'open', 'maintenance_type', 'preventive')
  );

  select entity_id
    into v_inspection
  from rental_upsert_entity_current_state(
    p_entity_type => 'inspection',
    p_source_record_id => 'insp-work-001',
    p_data => jsonb_build_object('status', 'complete', 'outcome', 'pass')
  );

  perform rental_upsert_relationship('asset_has_maintenance_record', v_asset_work, v_maintenance);
  perform rental_upsert_relationship('asset_has_inspection', v_asset_work, v_inspection);

  select count(*)
    into v_asset_work_relationships
  from rental_current_relationships
  where parent_id = v_asset_work
    and relationship_type in ('asset_has_maintenance_record', 'asset_has_inspection');

  if v_asset_work_relationships <> 2 then
    raise exception 'Expected 2 current maintenance/inspection relationships for work asset, found %', v_asset_work_relationships;
  end if;

  select count(*)
    into v_rls_enabled_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any(v_rental_tables)
    and c.relkind = 'r'
    and c.relrowsecurity;

  if v_rls_enabled_count <> v_expected_rental_table_count then
    raise exception 'Expected RLS enabled on % rental tables, found %', v_expected_rental_table_count, v_rls_enabled_count;
  end if;

  select count(distinct tablename)
    into v_anon_read_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = any(v_rental_tables)
    and cmd = 'SELECT'
    and roles @> array['anon']::name[];

  if v_anon_read_policy_count <> 0 then
    raise exception 'Expected no anon SELECT policies on rental tables, found %', v_anon_read_policy_count;
  end if;

  select count(distinct tablename)
    into v_anon_write_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = any(v_rental_tables)
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and roles @> array['anon']::name[];

  if v_anon_write_policy_count <> 0 then
    raise exception 'Expected no anon write policies on rental tables, found % tables', v_anon_write_policy_count;
  end if;

  select count(distinct tablename)
    into v_service_role_write_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = any(v_rental_tables)
    and cmd = 'ALL'
    and roles = array['service_role']::name[];

  if v_service_role_write_policy_count <> v_expected_rental_table_count then
    raise exception 'Expected service_role write policy on % rental tables, found %', v_expected_rental_table_count, v_service_role_write_policy_count;
  end if;

  -- Authenticated users now have ROLE-GATED write policies (introduced in
  -- 20260607120000_user_roles_profiles.sql): admin/branch_manager may write and
  -- field_operator may insert, all gated by the app_role JWT claim via
  -- get_my_role(). This supersedes the earlier "authenticated is read-only" model.
  select count(distinct tablename)
    into v_authenticated_write_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = any(v_rental_tables)
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and roles @> array['authenticated']::name[];

  -- The role-based write path applies to the core entity tables (a subset of all
  -- rental tables), so assert presence rather than an exact per-table count.
  -- Behavioral role-gating (only admin/branch_manager/field_operator may write) is
  -- verified by the API access-control suite (#232) with real per-role JWTs.
  if v_authenticated_write_policy_count = 0 then
    raise exception 'Expected role-gated authenticated write policies on rental tables, found none';
  end if;

  foreach v_table in array v_rental_tables loop
    -- Critical invariant: anon has no read or write access on gated rental tables.
    v_has_select_privilege := has_table_privilege('anon', format('public.%I', v_table), 'SELECT');
    v_has_insert_privilege := has_table_privilege('anon', format('public.%I', v_table), 'INSERT');
    v_has_update_privilege := has_table_privilege('anon', format('public.%I', v_table), 'UPDATE');
    v_has_delete_privilege := has_table_privilege('anon', format('public.%I', v_table), 'DELETE');

    if v_has_select_privilege
       or v_has_insert_privilege
       or v_has_update_privilege
       or v_has_delete_privilege then
      raise exception
        'Expected anon role to have no data privileges on %, found SELECT=% INSERT=% UPDATE=% DELETE=%',
        v_table,
        v_has_select_privilege,
        v_has_insert_privilege,
        v_has_update_privilege,
        v_has_delete_privilege;
    end if;
    -- NOTE: `authenticated` may now hold INSERT/UPDATE grants; the actual write is
    -- gated at the RLS layer by role (get_my_role()), so we intentionally no longer
    -- assert the absence of authenticated mutation privileges here.
  end loop;
end;
$$;

set local role authenticated;

do $$
declare
  v_order_id uuid;
  v_branch_id uuid;
  v_category_id uuid;
  v_order_line_rows int;
  v_quote_line_rows int;
  v_quote_is_available bool;
  v_conversion_success bool;
  v_conversion_conflicts jsonb;
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

  select
    rental_order.entity_id,
    nullif(rental_order.data->>'branch_id', '')::uuid
    into v_order_id, v_branch_id
  from public.v_rental_order_current rental_order
  where rental_order.order_number = 'RO-TEST-001';

  select
    nullif(order_line.category_id, '')::uuid
    into v_category_id
  from public.v_rental_order_line_current order_line
  where order_line.order_id = v_order_id::text
  order by order_line.entity_id
  limit 1;

  if v_order_id is null or v_branch_id is null or v_category_id is null then
    raise exception 'Expected fixture entities for role-behavior assertions';
  end if;

  select count(*)
    into v_order_line_rows
  from public.v_rental_order_line_current
  where order_id = v_order_id::text;

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

  select is_available
    into v_quote_is_available
  from public.rental_quote_availability(
    p_asset_category_id => v_category_id,
    p_branch_id => v_branch_id,
    p_quantity => 2,
    p_start_date => (now()::date - interval '1 day')::date,
    p_end_date => (now()::date + interval '2 day')::date
  );

  if v_quote_is_available then
    raise exception 'Expected authenticated quote availability RPC to detect overbooked fixture';
  end if;

  select success, conflicts
    into v_conversion_success, v_conversion_conflicts
  from public.rental_convert_quote_to_reservation(v_order_id);

  if v_conversion_success then
    raise exception 'Expected authenticated conversion RPC to block overbooked fixture';
  end if;

  if coalesce(jsonb_array_length(v_conversion_conflicts), 0) = 0 then
    raise exception 'Expected authenticated conversion RPC to return conflicts payload';
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
    raise exception 'anon should not read v_rental_order_line_current';
  exception
    when insufficient_privilege then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on v_rental_order_line_current';
  end if;

  v_caught := false;
  begin
    select count(*) into v_dummy from public.rental_quote_line_availability_current;
    raise exception 'anon should not read rental_quote_line_availability_current';
  exception
    when insufficient_privilege then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on rental_quote_line_availability_current';
  end if;

  v_caught := false;
  begin
    perform 1
    from public.rental_quote_availability(
      p_asset_category_id => gen_random_uuid(),
      p_branch_id => gen_random_uuid(),
      p_quantity => 1,
      p_start_date => now()::date,
      p_end_date => (now()::date + interval '1 day')::date
    );
    raise exception 'anon should not execute rental_quote_availability';
  exception
    when insufficient_privilege then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on rental_quote_availability';
  end if;

  v_caught := false;
  begin
    perform 1
    from public.rental_convert_quote_to_reservation(gen_random_uuid());
    raise exception 'anon should not execute rental_convert_quote_to_reservation';
  exception
    when insufficient_privilege then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected insufficient_privilege for anon on rental_convert_quote_to_reservation';
  end if;
end;
$$;

reset role;

do $$
declare
  v_asset_due uuid;
  v_asset_pre_due uuid;
  v_asset_meter uuid;
  v_due_policy uuid;
  v_pre_due_policy uuid;
  v_meter_policy uuid;
  v_downtime_fact_type_id uuid;
  v_meter_fact_type_id uuid;
  v_now timestamptz := now();
  v_due_maintenance_at timestamptz := now() - interval '120 days';
  v_due_inspection_at timestamptz := now() - interval '5 days';
  v_pre_due_maintenance_at timestamptz := now() - interval '82 days';
  v_pre_due_inspection_at timestamptz := now() - interval '2 days';
  v_last_maintenance_at timestamptz;
  v_is_due boolean;
  v_is_pre_due boolean;
begin
  select id into v_downtime_fact_type_id
  from fact_types
  where key = 'asset_downtime';

  select id into v_meter_fact_type_id
  from fact_types
  where key = 'asset_meter_reading';

  assert v_downtime_fact_type_id is not null,
    'FAIL: asset_downtime fact type must exist for PM due-assets view tests';
  assert v_meter_fact_type_id is not null,
    'FAIL: asset_meter_reading fact type must exist for PM due-assets view tests';

  -- 120 days ensures the asset is firmly due against a 90-day interval even if a
  -- newer inspection row exists; 82 days lands inside the 75-89 day pre-due band.
  insert into entities (entity_type, source_record_id)
  values ('asset', 'pm-due-view-due')
  returning id into v_asset_due;

  insert into entities (entity_type, source_record_id)
  values ('asset', 'pm-due-view-pre-due')
  returning id into v_asset_pre_due;

  insert into entities (entity_type, source_record_id)
  values ('asset', 'pm-due-view-meter')
  returning id into v_asset_meter;

  insert into preventative_maintenance_policies (
    entity_id,
    entity_scope,
    trigger_type,
    interval_days,
    lead_window_days,
    enabled,
    label
  ) values (
    v_asset_due,
    'asset',
    'time_interval',
    90,
    15,
    true,
    '90-day PM due regression'
  )
  returning id into v_due_policy;

  insert into preventative_maintenance_policies (
    entity_id,
    entity_scope,
    trigger_type,
    interval_days,
    lead_window_days,
    enabled,
    label
  ) values (
    v_asset_pre_due,
    'asset',
    'time_interval',
    90,
    15,
    true,
    '90-day PM pre-due regression'
  )
  returning id into v_pre_due_policy;

  insert into preventative_maintenance_policies (
    entity_id,
    entity_scope,
    trigger_type,
    threshold,
    lead_window_days,
    enabled,
    label
  ) values (
    v_asset_meter,
    'asset',
    'meter',
    500,
    50,
    true,
    '500-hour PM meter regression'
  )
  returning id into v_meter_policy;

  insert into time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id,
    metadata
  ) values
    (v_asset_due, v_downtime_fact_type_id, v_due_maintenance_at, '{}'::jsonb, 'pm-due-maintenance', '{"source":"maintenance"}'::jsonb),
    (v_asset_due, v_downtime_fact_type_id, v_due_inspection_at, '{}'::jsonb, 'pm-due-inspection', '{"source":"inspection"}'::jsonb),
    (v_asset_pre_due, v_downtime_fact_type_id, v_pre_due_maintenance_at, '{}'::jsonb, 'pm-pre-due-maintenance', '{"source":"maintenance"}'::jsonb),
    (v_asset_pre_due, v_downtime_fact_type_id, v_pre_due_inspection_at, '{}'::jsonb, 'pm-pre-due-inspection', '{"source":"inspection"}'::jsonb),
    (
      v_asset_meter,
      v_meter_fact_type_id,
      v_now,
      jsonb_build_object('reading_value', 475, 'reading_unit', 'hours'),
      'pm-meter-reading',
      '{}'::jsonb
    );

  select last_maintenance_at, is_due, is_pre_due
    into v_last_maintenance_at, v_is_due, v_is_pre_due
  from v_pm_due_assets
  where policy_id = v_due_policy;

  assert v_last_maintenance_at = v_due_maintenance_at,
    'FAIL: v_pm_due_assets.last_maintenance_at must ignore inspection downtime for due assets';
  assert v_is_due = true,
    'FAIL: time-interval due asset should remain due when only inspection downtime is recent';
  assert v_is_pre_due = false,
    'FAIL: due time-interval asset must not also be pre-due';

  select last_maintenance_at, is_due, is_pre_due
    into v_last_maintenance_at, v_is_due, v_is_pre_due
  from v_pm_due_assets
  where policy_id = v_pre_due_policy;

  assert v_last_maintenance_at = v_pre_due_maintenance_at,
    'FAIL: v_pm_due_assets.last_maintenance_at must ignore inspection downtime for pre-due assets';
  assert v_is_due = false,
    'FAIL: pre-due time-interval asset must not be marked due';
  assert v_is_pre_due = true,
    'FAIL: time-interval asset should stay pre-due when only inspection downtime is recent';

  select is_due, is_pre_due
    into v_is_due, v_is_pre_due
  from v_pm_due_assets
  where policy_id = v_meter_policy;

  assert v_is_due = false,
    'FAIL: meter-trigger asset below threshold must not be due';
  assert v_is_pre_due = false,
    'FAIL: meter-trigger asset must suppress pre-due until a meter lead concept exists';
end;
$$;

rollback;
