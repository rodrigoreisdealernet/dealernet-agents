-- Behavioral checks for 20260613150000_live_yard_activity_projection.sql.
--
-- Assertions:
--   1. Structural: projection view/feed table grants, security_invoker, and
--      realtime publication membership exist.
--   2. Service-role callers see normalized rows in all four lanes.
--   3. Overdue and needs-review flags are derived deterministically.
--   4. Authenticated tenant-scoped callers only see their tenant's rows.
--   5. Feed timestamp advances when relevant source data changes.

begin;

do $$
declare
  v_branch_a uuid;
  v_branch_b uuid;
  v_category_id uuid;
  v_customer_a uuid;
  v_customer_b uuid;
  v_job_site_a uuid;
  v_asset_review uuid;
  v_asset_release uuid;
  v_asset_return uuid;
  v_asset_maintenance uuid;
  v_order_a uuid;
  v_order_b uuid;
  v_contract_pending uuid;
  v_contract_return uuid;
  v_maintenance_id uuid;
  v_opened_maintenance_id uuid;
  v_count int;
  v_relopts text;
  v_before timestamptz;
  v_after timestamptz;
  v_caught boolean;
  v_error_message text;
  v_rows text[];
  v_field_operator_claims text := '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000f127","app_metadata":{"role":"field_operator","tenant":"tenant-a"}}';
  v_branch_manager_claims text := '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000a127","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}';
begin
  if not has_table_privilege('authenticated', 'public.v_live_yard_activity_current', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on public.v_live_yard_activity_current';
  end if;

  if has_table_privilege('anon', 'public.v_live_yard_activity_current', 'SELECT') then
    raise exception 'anon should not have SELECT on public.v_live_yard_activity_current';
  end if;

  if not has_table_privilege('authenticated', 'public.live_yard_projection_feed', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on public.live_yard_projection_feed';
  end if;

  if has_table_privilege('authenticated', 'public.rental_current_customers', 'SELECT') then
    raise exception 'authenticated should not have direct SELECT on public.rental_current_customers';
  end if;

  if has_table_privilege('authenticated', 'public.rental_current_job_sites', 'SELECT') then
    raise exception 'authenticated should not have direct SELECT on public.rental_current_job_sites';
  end if;

  select c.reloptions::text
    into v_relopts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'v_live_yard_activity_current';

  if coalesce(v_relopts, '') not like '%security_invoker=true%' then
    raise exception 'v_live_yard_activity_current must declare security_invoker = true';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'live_yard_projection_feed'
  ) then
    raise exception 'Expected live_yard_projection_feed to be in publication supabase_realtime';
  end if;

  raise notice 'PASS 1: structure + grants verified';

  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select entity_id into v_branch_a
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'yard-branch-a',
    p_data => jsonb_build_object('name', 'North Yard', 'tenant', 'tenant-a')
  );

  select entity_id into v_branch_b
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'yard-branch-b',
    p_data => jsonb_build_object('name', 'South Yard', 'tenant', 'tenant-b')
  );

  select entity_id into v_category_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_source_record_id => 'yard-category-1',
    p_data => jsonb_build_object('name', 'Excavators', 'tenant', 'tenant-a')
  );

  select entity_id into v_customer_a
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'customer',
    p_source_record_id => 'yard-customer-a',
    p_data => jsonb_build_object('name', 'Acme Demo', 'tenant', 'tenant-a')
  );

  select entity_id into v_customer_b
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'customer',
    p_source_record_id => 'yard-customer-b',
    p_data => jsonb_build_object('name', 'Beta Demo', 'tenant', 'tenant-b')
  );

  select entity_id into v_job_site_a
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'job_site',
    p_source_record_id => 'yard-job-site-a',
    p_data => jsonb_build_object('name', 'Airport Expansion', 'tenant', 'tenant-a')
  );

  select entity_id into v_asset_review
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'yard-asset-review',
    p_data => jsonb_build_object(
      'name', 'Review Asset',
      'tenant', 'tenant-a',
      'ownership_type', 'owned',
      'operational_status', 'inspection_hold'
    )
  );
  perform public.rental_upsert_relationship('branch_has_asset', v_branch_a, v_asset_review);
  perform public.rental_upsert_relationship('asset_category_has_asset', v_category_id, v_asset_review);

  select entity_id into v_asset_release
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'yard-asset-release',
    p_data => jsonb_build_object(
      'name', 'Release Asset',
      'tenant', 'tenant-a',
      'ownership_type', 'owned',
      'operational_status', 'on_inspection_hold'
    )
  );
  perform public.rental_upsert_relationship('branch_has_asset', v_branch_a, v_asset_release);
  perform public.rental_upsert_relationship('asset_category_has_asset', v_category_id, v_asset_release);

  select entity_id into v_asset_return
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'yard-asset-return',
    p_data => jsonb_build_object(
      'name', 'Return Asset',
      'tenant', 'tenant-a',
      'ownership_type', 'owned',
      'operational_status', 'available'
    )
  );
  perform public.rental_upsert_relationship('branch_has_asset', v_branch_a, v_asset_return);
  perform public.rental_upsert_relationship('asset_category_has_asset', v_category_id, v_asset_return);

  select entity_id into v_asset_maintenance
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'yard-asset-maintenance',
    p_data => jsonb_build_object(
      'name', 'Maintenance Asset',
      'tenant', 'tenant-a',
      'ownership_type', 'owned',
      'operational_status', 'maintenance'
    )
  );
  perform public.rental_upsert_relationship('branch_has_asset', v_branch_a, v_asset_maintenance);
  perform public.rental_upsert_relationship('asset_category_has_asset', v_category_id, v_asset_maintenance);

  select entity_id into v_order_a
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'yard-order-a',
    p_data => jsonb_build_object(
      'name', 'North Yard Approved Order',
      'tenant', 'tenant-a',
      'status', 'approved',
      'order_number', 'RO-YARD-001',
      'branch_id', v_branch_a,
      'customer_id', v_customer_a,
      'job_site_id', v_job_site_a
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'yard-order-line-a',
    p_data => jsonb_build_object(
      'tenant', 'tenant-a',
      'order_id', v_order_a::text,
      'status', 'pending',
      'branch_id', v_branch_a,
      'category_id', v_category_id,
      'job_site_id', v_job_site_a,
      'quantity', 2,
      'planned_start', (now() - interval '1 day')::text,
      'planned_end', (now() + interval '2 days')::text
    )
  );

  select entity_id into v_contract_pending
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract',
    p_source_record_id => 'yard-contract-pending',
    p_data => jsonb_build_object(
      'name', 'Pending Reservation Contract',
      'tenant', 'tenant-a',
      'status', 'pending_execution',
      'contract_number', 'RC-YARD-001',
      'order_id', v_order_a::text,
      'customer_id', v_customer_a,
      'job_site_id', v_job_site_a
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract_line',
    p_source_record_id => 'yard-contract-line-pending',
    p_data => jsonb_build_object(
      'tenant', 'tenant-a',
      'contract_id', v_contract_pending::text,
      'status', 'pending',
      'fulfillment_branch_id', v_branch_a,
      'category_id', v_category_id,
      'job_site_id', v_job_site_a,
      'quantity', 1,
      'planned_start', (now() - interval '2 hours')::text,
      'planned_end', (now() + interval '3 days')::text
    )
  );

  select entity_id into v_contract_return
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract',
    p_source_record_id => 'yard-contract-return',
    p_data => jsonb_build_object(
      'name', 'Active Return Contract',
      'tenant', 'tenant-a',
      'status', 'active',
      'contract_number', 'RC-YARD-002',
      'customer_id', v_customer_a,
      'job_site_id', v_job_site_a
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract_line',
    p_source_record_id => 'yard-contract-line-return',
    p_data => jsonb_build_object(
      'tenant', 'tenant-a',
      'contract_id', v_contract_return::text,
      'asset_id', v_asset_return::text,
      'status', 'checked_out',
      'fulfillment_branch_id', v_branch_a,
      'category_id', v_category_id,
      'job_site_id', v_job_site_a,
      'quantity', 1,
      'planned_start', (now() - interval '4 days')::text,
      'planned_end', (now() - interval '6 hours')::text,
      'actual_start', (now() - interval '4 days')::text
    )
  );

  select entity_id into v_maintenance_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'maintenance_record',
    p_source_record_id => 'yard-maint-001',
    p_data => jsonb_build_object(
      'tenant', 'tenant-a',
      'status', 'open',
      'maintenance_type', 'corrective',
      'availability_impact', 'hard_down',
      'opened_at', (now() - interval '2 days')::text,
      'expected_return_at', (now() - interval '3 hours')::text
    )
  );
  perform public.rental_upsert_relationship('asset_has_maintenance_record', v_asset_maintenance, v_maintenance_id);

  select entity_id into v_order_b
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'yard-order-b',
    p_data => jsonb_build_object(
      'name', 'South Yard Approved Order',
      'tenant', 'tenant-b',
      'status', 'approved',
      'order_number', 'RO-YARD-999',
      'branch_id', v_branch_b,
      'customer_id', v_customer_b
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'yard-order-line-b',
    p_data => jsonb_build_object(
      'tenant', 'tenant-b',
      'order_id', v_order_b::text,
      'status', 'pending',
      'branch_id', v_branch_b,
      'category_id', v_category_id,
      'quantity', 1,
      'planned_start', (now() + interval '1 day')::text,
      'planned_end', (now() + interval '2 days')::text
    )
  );

  select array_agg(
           format(
            '%s|%s|%s|%s|%s|%s|%s|%s',
             lane_key,
             source_entity_type,
             coalesce(order_number, ''),
             coalesce(contract_number, ''),
             coalesce(asset_name, ''),
             coalesce(maintenance_record_id::text, ''),
             is_overdue::text,
             is_needs_review::text
           )
           order by lane_sort_order, source_entity_type, coalesce(order_number, contract_number, asset_name, maintenance_record_id::text)
         )
    into v_rows
  from public.v_live_yard_activity_current;

  if array_length(v_rows, 1) <> 7 then
    raise exception 'Expected 7 service_role projection rows (6 tenant-a + 1 tenant-b), got %', array_length(v_rows, 1);
  end if;

  if not v_rows @> array[
    'going_out|rental_contract_line|RO-YARD-001|RC-YARD-001|||true|false',
    'going_out|rental_order_line|RO-YARD-001||||true|false',
    'coming_in|rental_contract_line||RC-YARD-002|Return Asset||true|false',
    'needs_review|asset|||Release Asset||false|true',
    'needs_review|asset|||Review Asset||false|true',
    'maintenance|maintenance_record|||Maintenance Asset|' || v_maintenance_id::text || '|true|false',
    'going_out|rental_order_line|RO-YARD-999||||false|false'
  ] then
    raise exception 'Unexpected lane projection rows: %', array_to_string(v_rows, E'\n');
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where branch_id = location_id
    and branch_name = location_name;

  if v_count <> 7 then
    raise exception 'Expected all projection rows to be branch/location scoped';
  end if;

  raise notice 'PASS 2: service_role sees all four lanes with normalized branch scope';

  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000a127","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}',
    true
  );

  select count(*)
    into v_count
  from public.v_live_yard_activity_current;

  if v_count <> 6 then
    raise exception 'Authenticated tenant-a should see 6 projection rows, got %', v_count;
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where branch_name = 'South Yard';

  if v_count <> 0 then
    raise exception 'Authenticated tenant-a should not see tenant-b rows';
  end if;

  raise notice 'PASS 3: authenticated tenant scoping verified';

  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', v_field_operator_claims, true);

  perform public.rental_apply_live_yard_action(
    p_source_entity_type => 'asset',
    p_source_entity_id => v_asset_release,
    p_action => 'mark_available',
    p_expected_lane_key => 'needs_review',
    p_expected_activity_status => 'inspection_hold'
  );

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where source_entity_type = 'asset'
    and source_entity_id = v_asset_release;

  if v_count <> 0 then
    raise exception 'Release Asset should leave the board after mark_available, got % rows', v_count;
  end if;

  select count(*)
    into v_count
  from public.rental_current_assets
  where entity_id = v_asset_release
    and operational_status = 'available';

  if v_count <> 1 then
    raise exception 'Release Asset should transition to available via live yard action';
  end if;

  if current_setting('request.jwt.claim.role', true) <> 'authenticated' then
    raise exception 'Live yard action should restore authenticated role claims after mark_available';
  end if;

  if coalesce(current_setting('request.jwt.claims', true), '')::jsonb <> v_field_operator_claims::jsonb then
    raise exception 'Live yard action should restore authenticated JWT claims after mark_available';
  end if;

  raise notice 'PASS 4: field_operator can explicitly resolve review-hold assets';

  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', v_branch_manager_claims, true);

  select maintenance_record_id
    into v_opened_maintenance_id
  from public.rental_apply_live_yard_action(
    p_source_entity_type => 'asset',
    p_source_entity_id => v_asset_review,
    p_action => 'open_maintenance',
    p_expected_lane_key => 'needs_review',
    p_expected_activity_status => 'inspection_hold'
  );

  if v_opened_maintenance_id is null then
    raise exception 'Expected open_maintenance to return a maintenance_record_id';
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where source_entity_type = 'asset'
    and source_entity_id = v_asset_review;

  if v_count <> 0 then
    raise exception 'Review Asset should leave Needs Review after open_maintenance';
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where source_entity_type = 'maintenance_record'
    and source_entity_id = v_opened_maintenance_id
    and lane_key = 'maintenance';

  if v_count <> 1 then
    raise exception 'Expected a maintenance lane row for the newly opened work order';
  end if;

  select count(*)
    into v_count
  from public.rental_current_assets
  where entity_id = v_asset_review
    and operational_status = 'in_maintenance';

  if v_count <> 1 then
    raise exception 'Review Asset should transition to in_maintenance';
  end if;

  if current_setting('request.jwt.claim.role', true) <> 'authenticated' then
    raise exception 'Live yard action should restore authenticated role claims after open_maintenance';
  end if;

  if coalesce(current_setting('request.jwt.claims', true), '')::jsonb <> v_branch_manager_claims::jsonb then
    raise exception 'Live yard action should restore authenticated JWT claims after open_maintenance';
  end if;

  v_caught := false;
  v_error_message := null;
  begin
    perform public.rental_apply_live_yard_action(
      p_source_entity_type => 'asset',
      p_source_entity_id => v_asset_review,
      p_action => 'open_maintenance',
      p_expected_lane_key => 'needs_review',
      p_expected_activity_status => 'inspection_hold'
    );
  exception
    when others then
      v_caught := true;
      v_error_message := sqlerrm;
  end;

  if not v_caught or v_error_message not ilike '%stale or already changed%' then
    raise exception 'Expected stale live yard transition failure, got caught=% message=%', v_caught, v_error_message;
  end if;

  if current_setting('request.jwt.claim.role', true) <> 'authenticated' then
    raise exception 'Live yard action should restore authenticated role claims after stale transition rejection';
  end if;

  if coalesce(current_setting('request.jwt.claims', true), '')::jsonb <> v_branch_manager_claims::jsonb then
    raise exception 'Live yard action should restore authenticated JWT claims after stale transition rejection';
  end if;

  perform public.rental_apply_live_yard_action(
    p_source_entity_type => 'maintenance_record',
    p_source_entity_id => v_opened_maintenance_id,
    p_action => 'complete_maintenance',
    p_expected_lane_key => 'maintenance',
    p_expected_activity_status => 'open'
  );

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where source_entity_type = 'maintenance_record'
    and source_entity_id = v_opened_maintenance_id;

  if v_count <> 0 then
    raise exception 'Completed maintenance work order should leave the board';
  end if;

  select count(*)
    into v_count
  from public.rental_current_assets
  where entity_id = v_asset_review
    and operational_status = 'available';

  if v_count <> 1 then
    raise exception 'Review Asset should return to available after complete_maintenance';
  end if;

  if current_setting('request.jwt.claim.role', true) <> 'authenticated' then
    raise exception 'Live yard action should restore authenticated role claims after complete_maintenance';
  end if;

  if coalesce(current_setting('request.jwt.claims', true), '')::jsonb <> v_branch_manager_claims::jsonb then
    raise exception 'Live yard action should restore authenticated JWT claims after complete_maintenance';
  end if;

  raise notice 'PASS 5: live yard inline actions write canonically and reject stale transitions';

  execute 'reset role';
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select updated_at into v_before
  from public.live_yard_projection_feed
  where feed_key = 'live_yard_activity';

  perform pg_sleep(0.05);

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_entity_id => v_order_a,
    p_source_record_id => 'yard-order-a',
    p_data => jsonb_build_object(
      'name', 'North Yard Approved Order',
      'tenant', 'tenant-a',
      'status', 'approved',
      'order_number', 'RO-YARD-001',
      'branch_id', v_branch_a,
      'customer_id', v_customer_a,
      'job_site_id', v_job_site_a,
      'last_yard_refresh_probe', clock_timestamp()::text
    )
  );

  select updated_at into v_after
  from public.live_yard_projection_feed
  where feed_key = 'live_yard_activity';

  if v_after is null or v_before is null or v_after <= v_before then
    raise exception 'Expected live yard projection feed timestamp to advance (% <= %)', v_after, v_before;
  end if;

  raise notice 'PASS 6: projection feed refreshes on canonical lifecycle updates';

  execute 'reset role';
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  v_caught := false;
  begin
    perform 1 from public.v_live_yard_activity_current;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'Unexpected anon view-read failure: % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'anon unexpectedly read public.v_live_yard_activity_current';
  end if;

  raise notice 'PASS 7: anon denied from projection surface';

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

rollback;
