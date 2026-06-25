-- Reset-path assertions for 20260614160000_project_equipment_hire_workflow.sql
--
-- Confirms that after a full `supabase db reset --config supabase/config.toml`
-- (migrations + seed):
--   1. Project-equipment lifecycle schema objects are present.
--   2. On-hire/off-hire lifecycle transitions still work through
--      project_equipment_transition().
--   3. Asset current-state data preserves branch/project assignment context after
--      transitions.
--   4. Operator-facing current-state reads from
--      v_project_equipment_lifecycle_current remain coherent, with vendor_ref
--      masked for field_operator callers.
begin;

DO $$
declare
  v_branch_id                  constant uuid := 'bc000001-0000-0000-0000-000000000001';
  v_project_id                 constant uuid := 'bc000001-0000-0000-0000-000000000010';
  v_asset_id                   constant uuid := 'bc000001-0000-0000-0000-000000000020';
  v_previous_status            text;
  v_new_status                 text;
  v_current_status             text;
  v_current_off_hired_at       timestamptz;
  v_asset_branch_id            text;
  v_asset_project_id           text;
  v_asset_assignment_status    text;
  v_operator_row_count         bigint;
  v_operator_vendor_ref        text;
  v_operator_status            text;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ---------------------------------------------------------------------------
  -- 1. Workflow objects must exist after reset
  -- ---------------------------------------------------------------------------
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dim_project_equipment_status'
  ) then
    raise exception 'Reset-path check failed: dim_project_equipment_status table missing';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dim_project_equipment_valid_transitions'
  ) then
    raise exception 'Reset-path check failed: dim_project_equipment_valid_transitions table missing';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'project_equipment_lifecycle_log'
  ) then
    raise exception 'Reset-path check failed: project_equipment_lifecycle_log table missing';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and c.relname = 'v_project_equipment_lifecycle_current'
  ) then
    raise exception 'Reset-path check failed: v_project_equipment_lifecycle_current view missing';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'project_equipment_transition'
  ) then
    raise exception 'Reset-path check failed: project_equipment_transition RPC missing';
  end if;

  raise notice 'PASS 1: workflow schema objects present after reset';

  -- ---------------------------------------------------------------------------
  -- 2. Fixture data + lifecycle transitions on_order -> on_hire -> off_hire
  -- ---------------------------------------------------------------------------
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_branch_id,  'branch',  'hire-reset-branch-a'),
    (v_project_id, 'project', 'hire-reset-project-a'),
    (v_asset_id,   'asset',   'hire-reset-asset-a')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_branch_id,
      1,
      true,
      jsonb_build_object(
        'name', 'Reset Branch A',
        'tenant', 'hire-reset-test',
        'branch_code', 'RESET-A'
      ),
      now()
    ),
    (
      v_project_id,
      1,
      true,
      jsonb_build_object(
        'name', 'Reset Project A',
        'tenant', 'hire-reset-test',
        'branch_id', v_branch_id::text,
        'status', 'active'
      ),
      now()
    ),
    (
      v_asset_id,
      1,
      true,
      jsonb_build_object(
        'name', 'Reset Asset A',
        'tenant', 'hire-reset-test',
        'branch_id', v_branch_id::text,
        'ownership_type', 'external_rental'
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  perform public.project_equipment_transition(
    p_project_id    => v_project_id,
    p_asset_id      => v_asset_id,
    p_target_status => 'on_order',
    p_changed_by    => 'reset-test'
  );

  perform public.project_equipment_transition(
    p_project_id    => v_project_id,
    p_asset_id      => v_asset_id,
    p_target_status => 'on_hire',
    p_changed_by    => 'reset-test',
    p_vendor_ref    => 'HIRE-RESET-001'
  );

  select t.previous_status, t.new_status
  into v_previous_status, v_new_status
  from public.project_equipment_transition(
    p_project_id    => v_project_id,
    p_asset_id      => v_asset_id,
    p_target_status => 'off_hire',
    p_changed_by    => 'reset-test'
  ) t;

  if v_previous_status is distinct from 'on_hire' then
    raise exception
      'Reset-path check failed: expected previous_status on off_hire transition to be on_hire, got %',
      v_previous_status;
  end if;

  if v_new_status is distinct from 'off_hire' then
    raise exception
      'Reset-path check failed: expected new_status on off_hire transition to be off_hire, got %',
      v_new_status;
  end if;

  raise notice 'PASS 2: on_order -> on_hire -> off_hire transitions succeed after reset';

  -- ---------------------------------------------------------------------------
  -- 3. Current-state assignment context remains coherent
  -- ---------------------------------------------------------------------------
  select r.data ->> 'branch_id', r.data ->> 'project_id', r.data ->> 'project_assignment_status'
  into v_asset_branch_id, v_asset_project_id, v_asset_assignment_status
  from public.rental_current_entity_state r
  where r.entity_id = v_asset_id
    and r.entity_type = 'asset';

  if v_asset_branch_id is distinct from v_branch_id::text then
    raise exception
      'Reset-path check failed: asset branch_id should persist as %, got %',
      v_branch_id,
      v_asset_branch_id;
  end if;

  if v_asset_project_id is distinct from v_project_id::text then
    raise exception
      'Reset-path check failed: asset project_id should persist as %, got %',
      v_project_id,
      v_asset_project_id;
  end if;

  if v_asset_assignment_status is distinct from 'off_hire' then
    raise exception
      'Reset-path check failed: asset project_assignment_status should be off_hire, got %',
      v_asset_assignment_status;
  end if;

  raise notice 'PASS 3: branch/project assignment context persisted in rental_current_entity_state';

  -- ---------------------------------------------------------------------------
  -- 4. Operator-facing current-state reads remain coherent after reset
  -- ---------------------------------------------------------------------------
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000d001","app_metadata":{"role":"branch_manager","tenant":"hire-reset-test"}}',
    true
  );

  select status_key, off_hired_at
  into v_current_status, v_current_off_hired_at
  from public.v_project_equipment_lifecycle_current
  where project_id = v_project_id
    and asset_id = v_asset_id;

  if v_current_status is distinct from 'off_hire' then
    raise exception
      'Reset-path check failed: branch_manager current status expected off_hire, got %',
      v_current_status;
  end if;

  if v_current_off_hired_at is null then
    raise exception
      'Reset-path check failed: off_hired_at should be populated for off_hire current-state row';
  end if;

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000d002","app_metadata":{"role":"field_operator","tenant":"hire-reset-test"}}',
    true
  );

  select count(*), max(vendor_ref), max(status_key)
  into v_operator_row_count, v_operator_vendor_ref, v_operator_status
  from public.v_project_equipment_lifecycle_current
  where project_id = v_project_id
    and asset_id = v_asset_id;

  if v_operator_row_count <> 1 then
    raise exception
      'Reset-path check failed: field_operator expected exactly 1 current-state row, got %',
      v_operator_row_count;
  end if;

  if v_operator_vendor_ref is not null then
    raise exception
      'Reset-path check failed: field_operator should see vendor_ref masked as NULL, got %',
      v_operator_vendor_ref;
  end if;

  if v_operator_status is distinct from 'off_hire' then
    raise exception
      'Reset-path check failed: field_operator current status expected off_hire, got %',
      v_operator_status;
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '{}', true);

  raise notice 'PASS 4: operator-facing current-state reads are coherent after reset';
  raise notice 'ALL PROJECT-EQUIPMENT HIRE WORKFLOW RESET CHECKS PASSED';
end;
$$;

rollback;
