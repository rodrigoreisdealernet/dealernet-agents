-- Behavioral checks for 20260613212000_project_compliance_readiness_tracking.sql.

begin;

do $$
declare
  v_project_parent uuid;
  v_project_child uuid;
  v_project_other_tenant uuid;
  v_branch_id uuid;
  v_branch_other_tenant_id uuid;
  v_asset_good uuid;
  v_asset_missing uuid;
  v_asset_expired uuid;
  v_asset_other_tenant uuid;

  v_blocked boolean;
  v_blockers jsonb;
  v_source text;
  v_requirements jsonb;
  v_evaluated_at timestamptz;

  v_relationship_id uuid;
  v_audit_id uuid;
  v_action text;
  v_count int;
  v_cross_tenant_count int;
  v_ready_count int;
  v_blocked_count int;

  v_labor_ready jsonb;
  v_labor_missing jsonb;
  v_error_message text;
  v_caught boolean;
begin
  if not has_table_privilege('service_role', 'public.project_assignment_readiness_audit', 'SELECT') then
    raise exception 'Expected service_role SELECT grant on public.project_assignment_readiness_audit';
  end if;

  if not has_table_privilege('authenticated', 'public.v_project_equipment_readiness_current', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on public.v_project_equipment_readiness_current';
  end if;

  if has_table_privilege('anon', 'public.v_project_equipment_readiness_current', 'SELECT') then
    raise exception 'anon should not have SELECT on public.v_project_equipment_readiness_current';
  end if;

  if not has_table_privilege('authenticated', 'public.project_assignment_readiness_audit', 'SELECT') then
    raise exception 'Expected authenticated SELECT grant on public.project_assignment_readiness_audit';
  end if;

  if has_table_privilege('anon', 'public.project_assignment_readiness_audit', 'SELECT') then
    raise exception 'anon should not have SELECT on public.project_assignment_readiness_audit';
  end if;

  if not has_function_privilege('authenticated', 'public.project_assign_asset_with_readiness_check(uuid,uuid,jsonb,boolean,text)', 'EXECUTE') then
    raise exception 'Expected authenticated EXECUTE grant on project_assign_asset_with_readiness_check';
  end if;

  if has_function_privilege('anon', 'public.project_assign_asset_with_readiness_check(uuid,uuid,jsonb,boolean,text)', 'EXECUTE') then
    raise exception 'anon should not have EXECUTE on project_assign_asset_with_readiness_check';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'project_assignment_readiness_audit'
      and c.relrowsecurity
  ) then
    raise exception 'Expected RLS enabled on public.project_assignment_readiness_audit';
  end if;

  raise notice 'PASS 1: grants + RLS verified';

  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select entity_id
  into v_branch_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'project-readiness-branch',
    p_data => jsonb_build_object('name', 'Project Readiness Branch', 'tenant', 'tenant-a')
  );

  select entity_id
  into v_project_parent
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'project',
    p_source_record_id => 'project-readiness-parent',
    p_data => jsonb_build_object(
      'name', 'Airport Expansion Program',
      'tenant', 'tenant-a',
      'required_readiness', jsonb_build_object(
        'equipment_certifications', jsonb_build_array('osha_10'),
        'labor_certifications', jsonb_build_array('operator_level_2'),
        'labor_readiness_flags', jsonb_build_array('fit_for_duty')
      )
    )
  );

  select entity_id
  into v_project_child
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'project',
    p_source_record_id => 'project-readiness-child',
    p_data => jsonb_build_object(
      'name', 'Airport Expansion Phase 2',
      'tenant', 'tenant-a'
    )
  );

  perform public.rental_upsert_relationship('branch_has_project', v_branch_id, v_project_parent);
  perform public.rental_upsert_relationship('branch_has_project', v_branch_id, v_project_child);
  perform public.rental_upsert_relationship('project_inherits_requirements_from_project', v_project_parent, v_project_child);

  select entity_id
  into v_branch_other_tenant_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'project-readiness-branch-tenant-b',
    p_data => jsonb_build_object('name', 'Project Readiness Branch B', 'tenant', 'tenant-b')
  );

  select entity_id
  into v_project_other_tenant
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'project',
    p_source_record_id => 'project-readiness-tenant-b',
    p_data => jsonb_build_object(
      'name', 'Harbor Expansion Program',
      'tenant', 'tenant-b',
      'required_readiness', jsonb_build_object(
        'equipment_certifications', jsonb_build_array('osha_10'),
        'labor_certifications', jsonb_build_array('operator_level_2'),
        'labor_readiness_flags', jsonb_build_array('fit_for_duty')
      )
    )
  );

  perform public.rental_upsert_relationship('branch_has_project', v_branch_other_tenant_id, v_project_other_tenant);

  select entity_id
  into v_asset_good
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'project-readiness-asset-good',
    p_data => jsonb_build_object(
      'name', 'Ready Excavator',
      'tenant', 'tenant-a',
      'certifications', jsonb_build_array(
        jsonb_build_object('key', 'osha_10', 'expires_at', (now() + interval '30 days')::text)
      )
    )
  );

  select entity_id
  into v_asset_missing
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'project-readiness-asset-missing-cert',
    p_data => jsonb_build_object(
      'name', 'Missing Cert Dozer',
      'tenant', 'tenant-a',
      'certifications', '[]'::jsonb
    )
  );

  select entity_id
  into v_asset_expired
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'project-readiness-asset-expired-cert',
    p_data => jsonb_build_object(
      'name', 'Expired Cert Crane',
      'tenant', 'tenant-a',
      'certifications', jsonb_build_array(
        jsonb_build_object('key', 'osha_10', 'expires_at', (now() - interval '2 days')::text)
      )
    )
  );

  perform public.rental_upsert_relationship('branch_has_asset', v_branch_id, v_asset_good);
  perform public.rental_upsert_relationship('branch_has_asset', v_branch_id, v_asset_missing);
  perform public.rental_upsert_relationship('branch_has_asset', v_branch_id, v_asset_expired);

  select entity_id
  into v_asset_other_tenant
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'project-readiness-asset-tenant-b',
    p_data => jsonb_build_object(
      'name', 'Tenant B Crane',
      'tenant', 'tenant-b',
      'certifications', jsonb_build_array(
        jsonb_build_object('key', 'osha_10', 'expires_at', (now() + interval '30 days')::text)
      )
    )
  );

  perform public.rental_upsert_relationship('branch_has_asset', v_branch_other_tenant_id, v_asset_other_tenant);

  v_labor_ready := jsonb_build_object(
    'certifications', jsonb_build_array(
      jsonb_build_object('key', 'operator_level_2', 'expires_at', (now() + interval '15 days')::text)
    ),
    'readiness_flags', jsonb_build_array('fit_for_duty')
  );

  v_labor_missing := jsonb_build_object(
    'certifications', jsonb_build_array(
      jsonb_build_object('key', 'operator_level_1', 'expires_at', (now() + interval '15 days')::text)
    ),
    'readiness_flags', jsonb_build_array('badge_verified')
  );

  raise notice 'PASS 2: seeded tenant-a and tenant-b project hierarchy, requirements, and assets';

  select
    eval.blocked,
    eval.blockers,
    eval.requirement_source,
    eval.requirements,
    eval.evaluated_at
  into v_blocked, v_blockers, v_source, v_requirements, v_evaluated_at
  from public.project_evaluate_assignment_readiness(v_project_child, v_asset_good, v_labor_ready) eval;

  if v_blocked then
    raise exception 'Expected ready asset evaluation to be unblocked, got blockers: %', v_blockers;
  end if;

  if v_source <> 'inherited_project' then
    raise exception 'Expected inherited_project requirement source, got %', coalesce(v_source, '<null>');
  end if;

  if jsonb_typeof(v_requirements -> 'equipment_certifications') <> 'array' then
    raise exception 'Expected inherited requirements payload to include equipment_certifications';
  end if;

  raise notice 'PASS 3: inheritance-based readiness evaluation works';

  select
    assigned.relationship_id,
    assigned.blocked,
    assigned.blockers,
    assigned.audit_id
  into v_relationship_id, v_blocked, v_blockers, v_audit_id
  from public.project_assign_asset_with_readiness_check(
    p_project_id => v_project_child,
    p_asset_id => v_asset_missing,
    p_labor_context => v_labor_ready,
    p_allow_override => false,
    p_actor => 'dispatcher-missing-cert'
  ) assigned;

  if not v_blocked then
    raise exception 'Expected missing-cert assignment to be blocked';
  end if;

  if v_relationship_id is not null then
    raise exception 'Blocked assignment should not create relationship (got %)', v_relationship_id;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_blockers) b
    where b ->> 'code' = 'missing_equipment_certification'
  ) then
    raise exception 'Expected missing_equipment_certification blocker, got %', v_blockers;
  end if;

  select action
  into v_action
  from public.project_assignment_readiness_audit
  where id = v_audit_id;

  if v_action <> 'assignment_blocked' then
    raise exception 'Expected assignment_blocked audit action, got %', coalesce(v_action, '<null>');
  end if;

  raise notice 'PASS 4: missing-cert assignment is blocked with explicit blocker and audit';

  select
    eval.blocked,
    eval.blockers
  into v_blocked, v_blockers
  from public.project_evaluate_assignment_readiness(v_project_child, v_asset_expired, v_labor_ready) eval;

  if not v_blocked then
    raise exception 'Expected expired-cert evaluation to be blocked';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_blockers) b
    where b ->> 'code' = 'expired_equipment_certification'
  ) then
    raise exception 'Expected expired_equipment_certification blocker, got %', v_blockers;
  end if;

  raise notice 'PASS 5: expired-cert blocker surfaced explicitly';

  select
    assigned.relationship_id,
    assigned.blocked,
    assigned.blockers,
    assigned.audit_id
  into v_relationship_id, v_blocked, v_blockers, v_audit_id
  from public.project_assign_asset_with_readiness_check(
    p_project_id => v_project_child,
    p_asset_id => v_asset_good,
    p_labor_context => v_labor_missing,
    p_allow_override => false,
    p_actor => 'dispatcher-missing-labor'
  ) assigned;

  if not v_blocked then
    raise exception 'Expected missing-labor assignment to be blocked';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_blockers) b
    where b ->> 'code' in ('missing_labor_certification', 'missing_labor_readiness_flag')
  ) then
    raise exception 'Expected labor blockers, got %', v_blockers;
  end if;

  raise notice 'PASS 6: labor readiness blockers surfaced explicitly';

  select
    assigned.relationship_id,
    assigned.blocked,
    assigned.blockers,
    assigned.audit_id
  into v_relationship_id, v_blocked, v_blockers, v_audit_id
  from public.project_assign_asset_with_readiness_check(
    p_project_id => v_project_child,
    p_asset_id => v_asset_good,
    p_labor_context => v_labor_ready,
    p_allow_override => false,
    p_actor => 'dispatcher-ready'
  ) assigned;

  if v_blocked then
    raise exception 'Expected ready assignment to pass, got blockers %', v_blockers;
  end if;

  if v_relationship_id is null then
    raise exception 'Expected committed assignment relationship id';
  end if;

  select count(*)
  into v_count
  from public.relationships_v2
  where id = v_relationship_id
    and relationship_type = 'project_has_asset'
    and is_current;

  if v_count <> 1 then
    raise exception 'Expected one current project_has_asset relationship, found %', v_count;
  end if;

  raise notice 'PASS 7: compliant assignment commits relationship';

  select count(*)
  into v_ready_count
  from public.v_project_equipment_readiness_current
  where project_id = v_project_child
    and asset_id = v_asset_good
    and readiness_state = 'ready'
    and blocker_count = 0;

  if v_ready_count <> 1 then
    raise exception 'Expected ready projection row for assigned asset, found %', v_ready_count;
  end if;

  select count(*)
  into v_blocked_count
  from public.project_assignment_readiness_audit
  where project_id = v_project_child
    and action = 'assignment_blocked';

  if v_blocked_count < 2 then
    raise exception 'Expected at least two blocked audit rows, found %', v_blocked_count;
  end if;

  raise notice 'PASS 8: project view projection + audit trail are consistent';

  select
    assigned.relationship_id,
    assigned.blocked,
    assigned.audit_id
  into v_relationship_id, v_blocked, v_audit_id
  from public.project_assign_asset_with_readiness_check(
    p_project_id => v_project_other_tenant,
    p_asset_id => v_asset_other_tenant,
    p_labor_context => v_labor_ready,
    p_allow_override => false,
    p_actor => 'dispatcher-tenant-b'
  ) assigned;

  if v_blocked or v_relationship_id is null then
    raise exception 'Expected tenant-b seed assignment to commit under service_role';
  end if;

  raise notice 'PASS 9: service_role can commit assignment for tenant-b fixtures';

  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';

  v_caught := false;
  begin
    perform 1
    from public.project_assignment_readiness_audit
    where project_id = v_project_child;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      v_error_message := sqlerrm;
      if v_error_message ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'Expected anon audit read deny, got: %', v_error_message;
      end if;
  end;

  if not v_caught then
    raise exception 'Expected anon audit read to fail';
  end if;

  v_caught := false;
  begin
    perform *
    from public.project_assign_asset_with_readiness_check(
      p_project_id => v_project_child,
      p_asset_id => v_asset_good,
      p_labor_context => v_labor_ready,
      p_allow_override => false,
      p_actor => 'anon-attempt'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      v_error_message := sqlerrm;
      if v_error_message ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'Expected anon execute deny, got: %', v_error_message;
      end if;
  end;

  if not v_caught then
    raise exception 'Expected anon execute attempt to fail';
  end if;

  raise notice 'PASS 10: anon read + execute denied';

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000a111","app_metadata":{"role":"read_only","tenant":"tenant-a"}}',
    true
  );

  select count(*)
  into v_count
  from public.project_assignment_readiness_audit
  where project_id = v_project_child;

  if v_count < 1 then
    raise exception 'Expected authenticated(read_only, tenant-a) to read same-tenant audit rows';
  end if;

  select count(*)
  into v_cross_tenant_count
  from public.project_assignment_readiness_audit
  where project_id = v_project_other_tenant;

  if v_cross_tenant_count <> 0 then
    raise exception 'Expected authenticated(read_only, tenant-a) to see 0 tenant-b audit rows, got %', v_cross_tenant_count;
  end if;

  v_caught := false;
  begin
    perform *
    from public.project_assign_asset_with_readiness_check(
      p_project_id => v_project_child,
      p_asset_id => v_asset_good,
      p_labor_context => v_labor_ready,
      p_allow_override => false,
      p_actor => 'read-only-attempt'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected authenticated(read_only) execute attempt to fail';
  end if;

  raise notice 'PASS 11: authenticated read_only is tenant-scoped read-only';

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000a112","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}',
    true
  );

  v_caught := false;
  begin
    perform *
    from public.project_assign_asset_with_readiness_check(
      p_project_id => v_project_other_tenant,
      p_asset_id => v_asset_other_tenant,
      p_labor_context => v_labor_ready,
      p_allow_override => false,
      p_actor => 'tenant-a-manager-cross-tenant-attempt'
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected authenticated(branch_manager, tenant-a) cross-tenant execute to fail';
  end if;

  select
    assigned.relationship_id,
    assigned.blocked
  into v_relationship_id, v_blocked
  from public.project_assign_asset_with_readiness_check(
    p_project_id => v_project_child,
    p_asset_id => v_asset_good,
    p_labor_context => v_labor_ready,
    p_allow_override => true,
    p_actor => 'tenant-a-manager-in-scope'
  ) assigned;

  if v_blocked or v_relationship_id is null then
    raise exception 'Expected authenticated(branch_manager, tenant-a) in-scope assignment to succeed';
  end if;

  raise notice 'PASS 12: authenticated manager is tenant-scoped and can write in-scope';

  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select count(*)
  into v_count
  from public.project_assignment_readiness_audit
  where project_id in (v_project_child, v_project_other_tenant);

  if v_count < 2 then
    raise exception 'Expected service_role to read both tenant audit rows, got %', v_count;
  end if;

  raise notice 'PASS 13: service_role bypasses tenant scope intentionally';
end;
$$;

commit;
