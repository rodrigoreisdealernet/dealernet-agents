begin;

do $$
declare
  v_branch_id uuid;
  v_asset_id uuid;
  v_stock_item_id uuid;
  v_access_test_task_id uuid;
  v_recount_task_id uuid;
  v_reject_task_id uuid;
  v_approve_task_id uuid;
  v_status text;
  v_access_blocked boolean := false;
  v_variance_rows bigint;
  v_reason_blocked boolean := false;
  v_stock_net_quantity numeric;
  v_reconciliation_events bigint;
  v_audit_note text;
  v_asset_status text;
  v_asset_version_before int;
  v_asset_version_after int;
begin
  insert into public.entities (entity_type, source_record_id)
  values ('branch', 'rapidcount-variance-branch')
  returning id into v_branch_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_branch_id,
    1,
    jsonb_build_object('name', 'Variance North Yard', 'status', 'active')
  );

  insert into public.entities (entity_type, source_record_id)
  values ('asset', 'rapidcount-asset-001')
  returning id into v_asset_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_asset_id,
    1,
    jsonb_build_object(
      'name', 'Serialized Loader 1',
      'inventory_kind', 'serialized',
      'operational_status', 'available'
    )
  );

  insert into public.relationships_v2 (relationship_type, parent_id, child_id)
  values ('branch_has_asset', v_branch_id, v_asset_id);

  insert into public.entities (entity_type, source_record_id)
  values ('stock_item', 'rapidcount-stock-001')
  returning id into v_stock_item_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_stock_item_id,
    1,
    jsonb_build_object(
      'name', 'Hydraulic Filters',
      'inventory_kind', 'bulk',
      'operational_status', 'available'
    )
  );

  insert into public.relationships_v2 (relationship_type, parent_id, child_id)
  values ('branch_has_stock_item', v_branch_id, v_stock_item_id);

  insert into public.time_series_points (entity_id, fact_type_id, observed_at, data_payload)
  select
    v_stock_item_id,
    ft.id,
    now(),
    jsonb_build_object('quantity', 10, 'unit', 'units')
  from public.fact_types ft
  where ft.key = 'stock_opening_balance';

  if has_function_privilege(
    'anon',
    'public.rapidcount_submit_count_session(uuid, jsonb, text)',
    'execute'
  ) then
    raise exception 'Expected anon execute to be revoked for rapidcount_submit_count_session';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.rapidcount_submit_count_session(uuid, jsonb, text)',
    'execute'
  ) then
    raise exception 'Expected authenticated execute grant for rapidcount_submit_count_session';
  end if;

  if has_function_privilege(
    'anon',
    'public.rapidcount_review_count_variances(uuid, text, text)',
    'execute'
  ) then
    raise exception 'Expected anon execute to be revoked for rapidcount_review_count_variances';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.rapidcount_review_count_variances(uuid, text, text)',
    'execute'
  ) then
    raise exception 'Expected authenticated execute grant for rapidcount_review_count_variances';
  end if;

  if has_table_privilege('anon', 'public.rapidcount_count_task_variances_current', 'select') then
    raise exception 'Expected anon select to be revoked for rapidcount_count_task_variances_current';
  end if;

  if not has_table_privilege('authenticated', 'public.rapidcount_count_task_variances_current', 'select') then
    raise exception 'Expected authenticated select grant for rapidcount_count_task_variances_current';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '11111111-1111-1111-1111-111111111111',
      'email', 'manager@example.com',
      'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'North Manager')
    )::text,
    true
  );

  select count_task_id into v_access_test_task_id
  from public.rapidcount_create_count_task(
    p_name => 'Variance Access Control Task',
    p_branch_id => v_branch_id,
    p_assignee_name => 'Morgan Auditor',
    p_due_date => current_date + 1,
    p_count_type => 'cycle_count',
    p_location_name => 'Access Yard',
    p_schedule_type => 'ad_hoc',
    p_recurrence_pattern => null,
    p_description => 'Task for role access verification'
  );

  perform public.rapidcount_transition_count_task(
    p_count_task_id => v_access_test_task_id,
    p_status => 'in_progress',
    p_note => 'Started for access-control verification'
  );

  reset role;
  set local role anon;
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'anon')::text,
    true
  );

  begin
    perform public.rapidcount_submit_count_session(
      p_count_task_id => v_access_test_task_id,
      p_captured_counts => jsonb_build_array(
        jsonb_build_object('inventory_id', v_asset_id, 'counted_quantity', 0),
        jsonb_build_object('inventory_id', v_stock_item_id, 'counted_quantity', 8)
      ),
      p_note => 'Should be denied for anon'
    );
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected anon submit denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected anon role to be denied for rapidcount_submit_count_session';
  end if;

  v_access_blocked := false;
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '22222222-2222-2222-2222-222222222222',
      'email', 'readonly@example.com',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'Read Only User')
    )::text,
    true
  );

  begin
    perform public.rapidcount_submit_count_session(
      p_count_task_id => v_access_test_task_id,
      p_captured_counts => jsonb_build_array(
        jsonb_build_object('inventory_id', v_asset_id, 'counted_quantity', 0),
        jsonb_build_object('inventory_id', v_stock_item_id, 'counted_quantity', 8)
      ),
      p_note => 'Should be denied for read_only'
    );
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected read_only submit denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected read_only role to be denied for rapidcount_submit_count_session';
  end if;

  v_access_blocked := false;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '33333333-3333-3333-3333-333333333333',
      'email', 'operator@example.com',
      'app_metadata', jsonb_build_object('role', 'field_operator', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'Field Operator')
    )::text,
    true
  );

  begin
    perform public.rapidcount_submit_count_session(
      p_count_task_id => v_access_test_task_id,
      p_captured_counts => jsonb_build_array(
        jsonb_build_object('inventory_id', v_asset_id, 'counted_quantity', 0),
        jsonb_build_object('inventory_id', v_stock_item_id, 'counted_quantity', 8)
      ),
      p_note => 'Should be denied for field_operator'
    );
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected field_operator submit denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected field_operator role to be denied for rapidcount_submit_count_session';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '11111111-1111-1111-1111-111111111111',
      'email', 'manager@example.com',
      'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'North Manager')
    )::text,
    true
  );

  perform public.rapidcount_submit_count_session(
    p_count_task_id => v_access_test_task_id,
    p_captured_counts => jsonb_build_array(
      jsonb_build_object('inventory_id', v_asset_id, 'counted_quantity', 0),
      jsonb_build_object('inventory_id', v_stock_item_id, 'counted_quantity', 8)
    ),
    p_note => 'Submitted by branch manager for access-control verification'
  );

  v_access_blocked := false;
  reset role;
  set local role anon;
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'anon')::text,
    true
  );

  begin
    perform public.rapidcount_review_count_variances(
      p_count_task_id => v_access_test_task_id,
      p_decision => 'recount',
      p_reason => 'Should be denied for anon'
    );
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected anon review denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected anon role to be denied for rapidcount_review_count_variances';
  end if;

  v_access_blocked := false;
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '22222222-2222-2222-2222-222222222222',
      'email', 'readonly@example.com',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'Read Only User')
    )::text,
    true
  );

  begin
    perform public.rapidcount_review_count_variances(
      p_count_task_id => v_access_test_task_id,
      p_decision => 'recount',
      p_reason => 'Should be denied for read_only'
    );
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected read_only review denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected read_only role to be denied for rapidcount_review_count_variances';
  end if;

  v_access_blocked := false;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '33333333-3333-3333-3333-333333333333',
      'email', 'operator@example.com',
      'app_metadata', jsonb_build_object('role', 'field_operator', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'Field Operator')
    )::text,
    true
  );

  begin
    perform public.rapidcount_review_count_variances(
      p_count_task_id => v_access_test_task_id,
      p_decision => 'recount',
      p_reason => 'Should be denied for field_operator'
    );
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected field_operator review denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected field_operator role to be denied for rapidcount_review_count_variances';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '11111111-1111-1111-1111-111111111111',
      'email', 'manager@example.com',
      'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'North Manager')
    )::text,
    true
  );

  perform public.rapidcount_review_count_variances(
    p_count_task_id => v_access_test_task_id,
    p_decision => 'recount',
    p_reason => 'Allowed branch-manager review for access-control verification'
  );

  select status
    into v_status
  from public.rapidcount_count_tasks_current
  where count_task_id = v_access_test_task_id;

  if v_status <> 'in_progress' then
    raise exception 'Expected access control task to remain in_progress after manager recount review, found %', v_status;
  end if;

  perform public.rapidcount_transition_count_task(
    p_count_task_id => v_access_test_task_id,
    p_status => 'submitted',
    p_note => 'Re-submitted after recount access-control verification'
  );

  select count_task_id into v_recount_task_id
  from public.rapidcount_create_count_task(
    p_name => 'Variance Recount Task',
    p_branch_id => v_branch_id,
    p_assignee_name => 'Casey Counter',
    p_due_date => current_date + 1,
    p_count_type => 'cycle_count',
    p_location_name => 'Aisles A-C',
    p_schedule_type => 'ad_hoc',
    p_recurrence_pattern => null,
    p_description => 'Task for re-count decision'
  );

  perform public.rapidcount_submit_count_session(
    p_count_task_id => v_recount_task_id,
    p_captured_counts => jsonb_build_array(
      jsonb_build_object('inventory_id', v_asset_id, 'counted_quantity', 0),
      jsonb_build_object('inventory_id', v_stock_item_id, 'counted_quantity', 8)
    ),
    p_note => 'Submitted with variance for recount path'
  );

  perform public.rapidcount_review_count_variances(
    p_count_task_id => v_recount_task_id,
    p_decision => 'recount',
    p_reason => 'Mismatch requires recount before approval'
  );

  select status
    into v_status
  from public.rapidcount_count_tasks_current
  where count_task_id = v_recount_task_id;

  if v_status <> 'in_progress' then
    raise exception 'Expected recount decision to set task in_progress, found %', v_status;
  end if;

  begin
    perform public.rapidcount_review_count_variances(
      p_count_task_id => v_recount_task_id,
      p_decision => 'approve',
      p_reason => ''
    );
  exception
    when sqlstate '22023' then
      if position('reason is required' in lower(sqlerrm)) > 0 then
        v_reason_blocked := true;
      else
        raise;
      end if;
  end;

  if not v_reason_blocked then
    raise exception 'Expected review approval without reason to be blocked';
  end if;

  select count_task_id into v_reject_task_id
  from public.rapidcount_create_count_task(
    p_name => 'Variance Reject Task',
    p_branch_id => v_branch_id,
    p_assignee_name => 'Jordan Yard Lead',
    p_due_date => current_date + 1,
    p_count_type => 'spot_check',
    p_location_name => 'Fence line',
    p_schedule_type => 'ad_hoc',
    p_recurrence_pattern => null,
    p_description => 'Task for reject decision'
  );

  perform public.rapidcount_submit_count_session(
    p_count_task_id => v_reject_task_id,
    p_captured_counts => jsonb_build_array(
      jsonb_build_object('inventory_id', v_asset_id, 'counted_quantity', 0),
      jsonb_build_object('inventory_id', v_stock_item_id, 'counted_quantity', 8)
    ),
    p_note => 'Submitted with variance for reject path'
  );

  perform public.rapidcount_review_count_variances(
    p_count_task_id => v_reject_task_id,
    p_decision => 'reject',
    p_reason => 'Variance evidence is invalid and rejected'
  );

  select status
    into v_status
  from public.rapidcount_count_tasks_current
  where count_task_id = v_reject_task_id;

  if v_status <> 'closed' then
    raise exception 'Expected reject decision to set task closed, found %', v_status;
  end if;

  select count_task_id into v_approve_task_id
  from public.rapidcount_create_count_task(
    p_name => 'Variance Approve Task',
    p_branch_id => v_branch_id,
    p_assignee_name => 'Alex Reviewer',
    p_due_date => current_date + 1,
    p_count_type => 'cycle_count',
    p_location_name => 'Aisles A-C',
    p_schedule_type => 'ad_hoc',
    p_recurrence_pattern => null,
    p_description => 'Task for approve/reconciliation decision'
  );

  perform public.rapidcount_submit_count_session(
    p_count_task_id => v_approve_task_id,
    p_captured_counts => jsonb_build_array(
      jsonb_build_object('inventory_id', v_asset_id, 'counted_quantity', 0),
      jsonb_build_object('inventory_id', v_stock_item_id, 'counted_quantity', 8)
    ),
    p_note => 'Submitted with variance for approve path'
  );

  select count(*)
    into v_variance_rows
  from public.rapidcount_count_task_variances_current
  where count_task_id = v_approve_task_id
    and has_variance;

  if v_variance_rows <> 2 then
    raise exception 'Expected 2 variance rows (serialized + non-serialized), found %', v_variance_rows;
  end if;

  select entity_versions.version_number, entity_versions.data ->> 'operational_status'
    into v_asset_version_before, v_asset_status
  from public.entity_versions
  where entity_id = v_asset_id
    and is_current;

  if v_asset_status <> 'available' then
    raise exception 'Expected serialized asset to start available before approval, found %', v_asset_status;
  end if;

  perform public.rapidcount_review_count_variances(
    p_count_task_id => v_approve_task_id,
    p_decision => 'approve',
    p_reason => 'Approved after branch manager variance review'
  );

  select status
    into v_status
  from public.rapidcount_count_tasks_current
  where count_task_id = v_approve_task_id;

  if v_status <> 'approved' then
    raise exception 'Expected approve decision to set task approved, found %', v_status;
  end if;

  select coalesce(sum(coalesce(nullif(tsp.data_payload ->> 'quantity', '')::numeric, 0::numeric)), 0::numeric)
    into v_stock_net_quantity
  from public.time_series_points tsp
  join public.fact_types ft on ft.id = tsp.fact_type_id
  where tsp.entity_id = v_stock_item_id
    and ft.key in ('stock_opening_balance', 'stock_quantity_adjustment');

  if v_stock_net_quantity <> 8 then
    raise exception 'Expected stock quantity to reconcile to 8 after approval, found %', v_stock_net_quantity;
  end if;

  select entity_versions.version_number, entity_versions.data ->> 'operational_status'
    into v_asset_version_after, v_asset_status
  from public.entity_versions
  where entity_id = v_asset_id
    and is_current;

  if v_asset_version_after <> v_asset_version_before + 1 then
    raise exception 'Expected serialized asset version to increment by exactly one on approval (% -> %)', v_asset_version_before, v_asset_version_after;
  end if;

  if v_asset_status <> 'missing' then
    raise exception 'Expected serialized asset operational_status to reconcile to missing, found %', v_asset_status;
  end if;

  select count(*)
    into v_reconciliation_events
  from public.time_series_points tsp
  join public.fact_types ft on ft.id = tsp.fact_type_id
  where ft.key = 'rapidcount_inventory_reconciliation_adjustment'
    and tsp.entity_id in (v_asset_id, v_stock_item_id)
    and tsp.data_payload ->> 'count_task_id' = v_approve_task_id::text;

  if v_reconciliation_events <> 2 then
    raise exception 'Expected 2 reconciliation adjustment events, found %', v_reconciliation_events;
  end if;

  select note
    into v_audit_note
  from public.rapidcount_count_task_audit_history
  where count_task_id = v_approve_task_id
  order by version_number desc, observed_at desc
  limit 1;

  if v_audit_note is null or position('Variance review: approve' in v_audit_note) = 0 then
    raise exception 'Expected latest audit note to include variance review approval details, found %', v_audit_note;
  end if;

  reset role;
end;
$$;

rollback;
