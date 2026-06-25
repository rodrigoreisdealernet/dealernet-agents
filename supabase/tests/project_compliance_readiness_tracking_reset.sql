-- Post-reset smoke-check for project compliance readiness tracking
-- (migration 20260613212000_project_compliance_readiness_tracking.sql).
--
-- Run after `supabase db reset --config supabase/config.toml` to confirm:
--   1. project_assignment_readiness_audit table exists with RLS enabled.
--   2. v_project_equipment_readiness_current view exists and is queryable.
--   3. project_evaluate_assignment_readiness and
--      project_assign_asset_with_readiness_check RPCs exist and are callable.
--   4. Requirement inheritance resolves correctly via the rebuilt schema.
--   5. Missing-cert and expired-cert assignments are both driven through
--      project_assign_asset_with_readiness_check so both blocked paths write audit rows.
--   6. project_assign_asset_with_readiness_check commits a relationship and
--      writes an audit row on a compliant assignment after reset.
--   7. The readiness projection view returns a ready row for the committed
--      assignment and blocked audit rows for the blocked attempts.

begin;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v_project_parent  uuid;
  v_project_child   uuid;
  v_branch_id       uuid;
  v_asset_good      uuid;
  v_asset_missing   uuid;
  v_asset_expired   uuid;

  v_blocked         boolean;
  v_blockers        jsonb;
  v_source          text;
  v_requirements    jsonb;

  v_relationship_id uuid;
  v_audit_id        uuid;
  v_action          text;
  v_count           bigint;

  v_labor_ready     jsonb;
  v_labor_missing   jsonb;

  v_table_exists    bool;
  v_rls_enabled     bool;
  v_view_exists     bool;
  v_fn_eval_exists  bool;
  v_fn_assign_exists bool;
begin
  -- 1. Structural verification: table, RLS, view, and RPCs must be present
  --    after a fresh db reset.

  select exists(
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name   = 'project_assignment_readiness_audit'
  ) into v_table_exists;
  if not v_table_exists then
    raise exception 'project_assignment_readiness_audit table missing after db reset';
  end if;

  select relrowsecurity into v_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname  = 'project_assignment_readiness_audit';
  if not coalesce(v_rls_enabled, false) then
    raise exception 'RLS not enabled on project_assignment_readiness_audit after db reset';
  end if;

  select exists(
    select 1 from information_schema.views
    where table_schema = 'public'
      and table_name   = 'v_project_equipment_readiness_current'
  ) into v_view_exists;
  if not v_view_exists then
    raise exception 'v_project_equipment_readiness_current view missing after db reset';
  end if;

  select exists(
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'project_evaluate_assignment_readiness'
  ) into v_fn_eval_exists;
  if not v_fn_eval_exists then
    raise exception 'project_evaluate_assignment_readiness function missing after db reset';
  end if;

  select exists(
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'project_assign_asset_with_readiness_check'
  ) into v_fn_assign_exists;
  if not v_fn_assign_exists then
    raise exception 'project_assign_asset_with_readiness_check function missing after db reset';
  end if;

  raise notice 'PASS 1: table, RLS, view, and RPCs present after reset';

  -- 2. Seed minimal fixtures for behavioural assertions.

  select entity_id into v_branch_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'branch',
    p_source_record_id => 'reset-readiness-branch',
    p_data             => jsonb_build_object('name', 'Reset Readiness Branch', 'tenant', 'tenant-reset')
  );

  select entity_id into v_project_parent
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'project',
    p_source_record_id => 'reset-readiness-parent',
    p_data             => jsonb_build_object(
      'name',   'Reset Program Parent',
      'tenant', 'tenant-reset',
      'required_readiness', jsonb_build_object(
        'equipment_certifications', jsonb_build_array('osha_10'),
        'labor_certifications',     jsonb_build_array('operator_level_2'),
        'labor_readiness_flags',    jsonb_build_array('fit_for_duty')
      )
    )
  );

  select entity_id into v_project_child
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'project',
    p_source_record_id => 'reset-readiness-child',
    p_data             => jsonb_build_object(
      'name',   'Reset Program Phase 2',
      'tenant', 'tenant-reset'
    )
  );

  perform public.rental_upsert_relationship('branch_has_project', v_branch_id, v_project_parent);
  perform public.rental_upsert_relationship('branch_has_project', v_branch_id, v_project_child);
  perform public.rental_upsert_relationship('project_inherits_requirements_from_project', v_project_parent, v_project_child);

  select entity_id into v_asset_good
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'reset-readiness-asset-good',
    p_data             => jsonb_build_object(
      'name',   'Reset Ready Excavator',
      'tenant', 'tenant-reset',
      'certifications', jsonb_build_array(
        jsonb_build_object('key', 'osha_10', 'expires_at', (now() + interval '30 days')::text)
      )
    )
  );

  select entity_id into v_asset_missing
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'reset-readiness-asset-missing',
    p_data             => jsonb_build_object(
      'name',   'Reset Missing Cert Dozer',
      'tenant', 'tenant-reset',
      'certifications', '[]'::jsonb
    )
  );

  select entity_id into v_asset_expired
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_source_record_id => 'reset-readiness-asset-expired',
    p_data             => jsonb_build_object(
      'name',   'Reset Expired Cert Crane',
      'tenant', 'tenant-reset',
      'certifications', jsonb_build_array(
        jsonb_build_object('key', 'osha_10', 'expires_at', (now() - interval '2 days')::text)
      )
    )
  );

  perform public.rental_upsert_relationship('branch_has_asset', v_branch_id, v_asset_good);
  perform public.rental_upsert_relationship('branch_has_asset', v_branch_id, v_asset_missing);
  perform public.rental_upsert_relationship('branch_has_asset', v_branch_id, v_asset_expired);

  v_labor_ready := jsonb_build_object(
    'certifications',   jsonb_build_array(
      jsonb_build_object('key', 'operator_level_2', 'expires_at', (now() + interval '15 days')::text)
    ),
    'readiness_flags', jsonb_build_array('fit_for_duty')
  );

  v_labor_missing := jsonb_build_object(
    'certifications',   jsonb_build_array(
      jsonb_build_object('key', 'operator_level_1', 'expires_at', (now() + interval '15 days')::text)
    ),
    'readiness_flags', jsonb_build_array('badge_verified')
  );

  raise notice 'PASS 2: seeded project hierarchy, requirements, and assets after reset';

  -- 3. Requirement inheritance: child project inherits requirements from parent.

  select eval.blocked, eval.requirement_source, eval.requirements
  into v_blocked, v_source, v_requirements
  from public.project_evaluate_assignment_readiness(v_project_child, v_asset_good, v_labor_ready) eval;

  if v_blocked then
    raise exception 'Expected ready-asset evaluation to be unblocked after reset';
  end if;

  if v_source <> 'inherited_project' then
    raise exception
      'Expected inherited_project requirement source after reset, got %',
      coalesce(v_source, '<null>');
  end if;

  if jsonb_typeof(v_requirements -> 'equipment_certifications') <> 'array' then
    raise exception 'Expected equipment_certifications array in inherited requirements after reset';
  end if;

  raise notice 'PASS 3: requirement inheritance works after reset';

  -- 4. Missing-cert assignment is blocked with an explicit blocker + audit row.

  select assigned.relationship_id, assigned.blocked, assigned.blockers, assigned.audit_id
  into v_relationship_id, v_blocked, v_blockers, v_audit_id
  from public.project_assign_asset_with_readiness_check(
    p_project_id   => v_project_child,
    p_asset_id     => v_asset_missing,
    p_labor_context => v_labor_ready,
    p_allow_override => false,
    p_actor        => 'reset-dispatcher-missing-cert'
  ) assigned;

  if not v_blocked then
    raise exception 'Expected missing-cert assignment to be blocked after reset';
  end if;

  if v_relationship_id is not null then
    raise exception
      'Blocked assignment must not create a relationship after reset (got %)', v_relationship_id;
  end if;

  if not exists (
    select 1 from jsonb_array_elements(v_blockers) b
    where b ->> 'code' = 'missing_equipment_certification'
  ) then
    raise exception
      'Expected missing_equipment_certification blocker after reset, got %', v_blockers;
  end if;

  select action into v_action
  from public.project_assignment_readiness_audit
  where id = v_audit_id;

  if v_action <> 'assignment_blocked' then
    raise exception
      'Expected assignment_blocked audit action after reset, got %', coalesce(v_action, '<null>');
  end if;

  raise notice 'PASS 4: missing-cert blocker and audit trail work after reset';

  -- 5. Expired-cert assignment is blocked with an explicit blocker and writes an audit row.
  --    Drive this through project_assign_asset_with_readiness_check (not just evaluate)
  --    so that the blocked-audit trail is exercised for a second distinct blocker path.

  select assigned.relationship_id, assigned.blocked, assigned.blockers, assigned.audit_id
  into v_relationship_id, v_blocked, v_blockers, v_audit_id
  from public.project_assign_asset_with_readiness_check(
    p_project_id     => v_project_child,
    p_asset_id       => v_asset_expired,
    p_labor_context  => v_labor_ready,
    p_allow_override => false,
    p_actor          => 'reset-dispatcher-expired-cert'
  ) assigned;

  if not v_blocked then
    raise exception 'Expected expired-cert assignment to be blocked after reset';
  end if;

  if v_relationship_id is not null then
    raise exception
      'Blocked expired-cert assignment must not create a relationship after reset (got %)', v_relationship_id;
  end if;

  if not exists (
    select 1 from jsonb_array_elements(v_blockers) b
    where b ->> 'code' = 'expired_equipment_certification'
  ) then
    raise exception
      'Expected expired_equipment_certification blocker after reset, got %', v_blockers;
  end if;

  select action into v_action
  from public.project_assignment_readiness_audit
  where id = v_audit_id;

  if v_action <> 'assignment_blocked' then
    raise exception
      'Expected assignment_blocked audit action for expired-cert path after reset, got %',
      coalesce(v_action, '<null>');
  end if;

  raise notice 'PASS 5: expired-cert blocker and audit trail work after reset';

  -- 6. Compliant assignment commits a relationship and writes an audit row.

  select assigned.relationship_id, assigned.blocked, assigned.blockers, assigned.audit_id
  into v_relationship_id, v_blocked, v_blockers, v_audit_id
  from public.project_assign_asset_with_readiness_check(
    p_project_id    => v_project_child,
    p_asset_id      => v_asset_good,
    p_labor_context => v_labor_ready,
    p_allow_override => false,
    p_actor         => 'reset-dispatcher-ready'
  ) assigned;

  if v_blocked then
    raise exception
      'Expected compliant assignment to pass after reset, got blockers: %', v_blockers;
  end if;

  if v_relationship_id is null then
    raise exception 'Expected committed assignment relationship id after reset';
  end if;

  select count(*) into v_count
  from public.relationships_v2
  where id = v_relationship_id
    and relationship_type = 'project_has_asset'
    and is_current;

  if v_count <> 1 then
    raise exception
      'Expected one current project_has_asset relationship after reset, found %', v_count;
  end if;

  select action into v_action
  from public.project_assignment_readiness_audit
  where id = v_audit_id;

  if v_action not in ('assignment_committed', 'assignment_override') then
    raise exception
      'Expected assignment_committed/override audit action after reset, got %',
      coalesce(v_action, '<null>');
  end if;

  raise notice 'PASS 6: compliant assignment commits relationship + audit row after reset';

  -- 7. Readiness projection view returns a ready row for the committed asset
  --    and at least one blocked audit row for the blocked attempts.

  select count(*) into v_count
  from public.v_project_equipment_readiness_current
  where project_id     = v_project_child
    and asset_id       = v_asset_good
    and readiness_state = 'ready'
    and blocker_count   = 0;

  if v_count <> 1 then
    raise exception
      'Expected ready projection row for committed asset after reset, found %', v_count;
  end if;

  select count(*) into v_count
  from public.project_assignment_readiness_audit
  where project_id = v_project_child
    and action     = 'assignment_blocked';

  if v_count < 2 then
    raise exception
      'Expected at least two blocked audit rows (missing-cert + expired-cert) after reset, found %', v_count;
  end if;

  raise notice 'PASS 7: readiness projection view and audit trail are coherent after reset';
end;
$$;

rollback;
