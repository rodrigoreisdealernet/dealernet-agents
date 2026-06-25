-- Reset-path regression checks for procurement requisitions + approval routing
-- (migration 20260612193000_procurement_requisition_approval_routing.sql).
set search_path = public, extensions;

begin;

do $$
declare
  v_fn_submit_exists boolean;
  v_fn_decision_exists boolean;
  v_fn_po_exists boolean;
  v_low_req uuid;
  v_high_req uuid;
  v_rejected_req uuid;
  v_auth_req uuid;
  v_readonly_req uuid;
  v_status text;
  v_po_eligible boolean;
  v_required_approvals integer;
  v_po_count integer;
  v_audit_count integer;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', 'reset-path-user', true);

  -- Keep this exact identity-argument signature check in sync with the
  -- migration when function parameter names/types change.
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'procurement_submit_requisition'
      and p.prosecdef = true
      and pg_catalog.pg_get_function_identity_arguments(p.oid)
          = 'p_requisition_type text, p_branch_id text, p_cost_center text, p_total_amount numeric, p_requested_items jsonb, p_notes text'
  ) into v_fn_submit_exists;

  if not v_fn_submit_exists then
    raise exception 'FAIL 1a: procurement_submit_requisition(...) missing or not SECURITY DEFINER';
  end if;

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'procurement_record_approval_decision'
      and p.prosecdef = true
      and pg_catalog.pg_get_function_identity_arguments(p.oid)
          = 'p_requisition_id uuid, p_step_order integer, p_decision text, p_comment text'
  ) into v_fn_decision_exists;

  if not v_fn_decision_exists then
    raise exception 'FAIL 1b: procurement_record_approval_decision(...) missing or not SECURITY DEFINER';
  end if;

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'procurement_get_po_eligible_requisitions'
      and p.prosecdef = true
      and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_branch_id text'
  ) into v_fn_po_exists;

  if not v_fn_po_exists then
    raise exception 'FAIL 1c: procurement_get_po_eligible_requisitions(text) missing or not SECURITY DEFINER';
  end if;

  raise notice 'PASS 1: procurement routing functions exist';

  -- 2. Requesters can create requisitions for all scoped requisition types.
  select requisition_id, required_approvals
    into v_low_req, v_required_approvals
  from public.procurement_submit_requisition(
    p_requisition_type => 'equipment',
    p_branch_id => 'branch-001',
    p_cost_center => 'CC-EQ-01',
    p_total_amount => 2400,
    p_requested_items => jsonb_build_array(jsonb_build_object('sku', 'EQ-100', 'qty', 1)),
    p_notes => 'Equipment requisition reset test'
  );

  if v_low_req is null or v_required_approvals <> 1 then
    raise exception 'FAIL 2a: equipment requisition did not route to expected single-step approval';
  end if;

  select requisition_id, required_approvals
    into v_high_req, v_required_approvals
  from public.procurement_submit_requisition(
    p_requisition_type => 'parts',
    p_branch_id => 'branch-001',
    p_cost_center => 'CC-PT-01',
    p_total_amount => 15000,
    p_requested_items => jsonb_build_array(jsonb_build_object('sku', 'PT-200', 'qty', 4)),
    p_notes => 'High-value parts requisition reset test'
  );

  if v_high_req is null or v_required_approvals <> 2 then
    raise exception 'FAIL 2b: high-value parts requisition did not route to expected two-step approval';
  end if;

  select requisition_id
    into v_rejected_req
  from public.procurement_submit_requisition(
    p_requisition_type => 'merchandise',
    p_branch_id => 'branch-001',
    p_cost_center => 'CC-ME-01',
    p_total_amount => 1200,
    p_requested_items => jsonb_build_array(jsonb_build_object('sku', 'ME-300', 'qty', 3)),
    p_notes => 'Merchandise rejection path reset test'
  );

  if v_rejected_req is null then
    raise exception 'FAIL 2c: merchandise requisition was not created';
  end if;

  if not exists (
    select 1
    from public.entity_versions ev
    where ev.entity_id = v_low_req
      and ev.is_current = true
      and ev.data ->> 'branch_id' = 'branch-001'
      and ev.data ->> 'cost_center' = 'CC-EQ-01'
  ) then
    raise exception 'FAIL 2d: branch/cost context not persisted on requisition';
  end if;

  raise notice 'PASS 2: requisitions created for equipment/parts/merchandise with branch/cost context';

  -- 3. Authenticated callers can only decide steps matching their app role.
  select requisition_id
    into v_auth_req
  from public.procurement_submit_requisition(
    p_requisition_type => 'parts',
    p_branch_id => 'branch-001',
    p_cost_center => 'CC-AUTH-01',
    p_total_amount => 7000,
    p_requested_items => jsonb_build_array(jsonb_build_object('sku', 'PT-201', 'qty', 2)),
    p_notes => 'Auth role enforcement reset test'
  );

  execute 'set local role authenticated';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', 'manager-user',
      'app_metadata', jsonb_build_object('role', 'branch_manager')
    )::text,
    true
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', 'manager-user', true);

  perform public.procurement_record_approval_decision(v_auth_req, 1, 'approve', 'manager auth approved');

  begin
    perform public.procurement_record_approval_decision(v_auth_req, 2, 'approve', 'manager should not approve admin step');
    raise exception 'FAIL 3a: non-matching authenticated app role should be denied';
  exception
    when sqlstate '42501' then
      null;
  end;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', 'readonly-user',
      'app_metadata', jsonb_build_object('role', 'read_only')
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', 'readonly-user', true);

  execute 'reset role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', 'reset-path-user', true);
  select requisition_id
    into v_readonly_req
  from public.procurement_submit_requisition(
    p_requisition_type => 'equipment',
    p_branch_id => 'branch-001',
    p_cost_center => 'CC-RO-01',
    p_total_amount => 1800,
    p_requested_items => jsonb_build_array(jsonb_build_object('sku', 'EQ-101', 'qty', 1)),
    p_notes => 'Read-only denial auth test'
  );

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', 'readonly-user',
      'app_metadata', jsonb_build_object('role', 'read_only')
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', 'readonly-user', true);

  begin
    perform public.procurement_record_approval_decision(v_readonly_req, 1, 'approve', 'readonly should fail');
    raise exception 'FAIL 3b: read_only app role should not approve branch_manager step';
  exception
    when sqlstate '42501' then
      null;
  end;

  begin
    perform 1
    from public.procurement_approval_step_templates
    limit 1;
    raise exception 'FAIL 3c: authenticated direct read on procurement_approval_step_templates should be denied';
  exception
    when sqlstate '42501' then
      null;
  end;

  begin
    perform 1
    from public.procurement_requisition_approvals
    where requisition_id = v_auth_req
    limit 1;
    raise exception 'FAIL 3d: authenticated direct read on procurement_requisition_approvals should be denied';
  exception
    when sqlstate '42501' then
      null;
  end;

  begin
    perform 1
    from public.procurement_requisition_approval_audit
    where requisition_id = v_auth_req
    limit 1;
    raise exception 'FAIL 3e: authenticated direct read on procurement_requisition_approval_audit should be denied';
  exception
    when sqlstate '42501' then
      null;
  end;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', 'admin-user',
      'app_metadata', jsonb_build_object('role', 'admin')
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', 'admin-user', true);
  perform public.procurement_record_approval_decision(v_auth_req, 2, 'approve', 'admin auth approved');

  execute 'reset role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', 'reset-path-user', true);

  select
    ev.data ->> 'status',
    coalesce((ev.data ->> 'po_eligible')::boolean, false)
    into v_status, v_po_eligible
  from public.entity_versions ev
  where ev.entity_id = v_auth_req
    and ev.is_current = true;

  if v_status <> 'approved' or v_po_eligible is distinct from true then
    raise exception 'FAIL 3f: matching authenticated app roles should complete approval';
  end if;

  raise notice 'PASS 3: authenticated approvals enforce app-role matching and block direct table reads';

  -- 4. Configurable approval routing + explicit approve/reject outcomes.
  perform public.procurement_record_approval_decision(v_low_req, 1, 'approve', 'branch manager approved equipment request');

  select
    ev.data ->> 'status',
    coalesce((ev.data ->> 'po_eligible')::boolean, false)
    into v_status, v_po_eligible
  from public.entity_versions ev
  where ev.entity_id = v_low_req
    and ev.is_current = true;

  if v_status <> 'approved' or v_po_eligible is distinct from true then
    raise exception 'FAIL 4a: single-step requisition should be approved and PO-eligible';
  end if;

  perform public.procurement_record_approval_decision(v_high_req, 1, 'approve', 'branch manager approved high-value request');

  select
    ev.data ->> 'status',
    coalesce((ev.data ->> 'po_eligible')::boolean, false)
    into v_status, v_po_eligible
  from public.entity_versions ev
  where ev.entity_id = v_high_req
    and ev.is_current = true;

  if v_status <> 'pending_approval' or v_po_eligible is distinct from false then
    raise exception 'FAIL 4b: high-value requisition should stay pending after step 1 approval';
  end if;

  perform public.procurement_record_approval_decision(v_high_req, 2, 'approve', 'admin approved high-value request');

  select
    ev.data ->> 'status',
    coalesce((ev.data ->> 'po_eligible')::boolean, false)
    into v_status, v_po_eligible
  from public.entity_versions ev
  where ev.entity_id = v_high_req
    and ev.is_current = true;

  if v_status <> 'approved' or v_po_eligible is distinct from true then
    raise exception 'FAIL 4c: high-value requisition should be approved only after step 2';
  end if;

  perform public.procurement_record_approval_decision(v_rejected_req, 1, 'reject', 'rejected due to budget freeze');

  select
    ev.data ->> 'status',
    coalesce((ev.data ->> 'po_eligible')::boolean, false)
    into v_status, v_po_eligible
  from public.entity_versions ev
  where ev.entity_id = v_rejected_req
    and ev.is_current = true;

  if v_status <> 'rejected' or v_po_eligible is distinct from false then
    raise exception 'FAIL 4d: rejected requisition should not be PO-eligible';
  end if;

  select count(*)
    into v_audit_count
  from public.procurement_requisition_approval_audit
  where requisition_id = v_high_req;

  if v_audit_count <> 2 then
    raise exception 'FAIL 4e: expected two approval audit events for high-value requisition, found %', v_audit_count;
  end if;

  raise notice 'PASS 4: approval routing enforces limits and records explicit decision outcomes';

  -- 5. Approved requisitions are eligible for PO generation via dedicated read path.
  select count(*)
    into v_po_count
  from public.procurement_get_po_eligible_requisitions('branch-001')
  where requisition_id in (v_low_req, v_high_req);

  if v_po_count <> 2 then
    raise exception 'FAIL 5a: expected two approved PO-eligible requisitions, found %', v_po_count;
  end if;

  if exists (
    select 1
    from public.procurement_get_po_eligible_requisitions('branch-001')
    where requisition_id = v_rejected_req
  ) then
    raise exception 'FAIL 5b: rejected requisition appeared in PO-eligible view';
  end if;

  raise notice 'PASS 5: PO eligibility requires approved status and preserves audit trail';
  raise notice 'All procurement requisition + approval routing reset-path checks passed';
end;
$$;

rollback;
