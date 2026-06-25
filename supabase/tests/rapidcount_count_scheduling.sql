begin;

do $$
declare
  v_branch_id uuid;
  v_primary_task_id uuid;
  v_secondary_task_id uuid;
  v_invalid_transition_blocked boolean := false;
  v_access_blocked boolean := false;
  v_current_status text;
  v_due_date date;
  v_schedule_type text;
  v_recurrence_pattern text;
  v_overdue bool;
  v_branch_name text;
  v_total_tasks bigint;
  v_completed_tasks bigint;
  v_overdue_tasks bigint;
  v_in_progress_tasks bigint;
  v_approved_tasks bigint;
  v_audit_events bigint;
  v_first_event_type text;
  v_first_status text;
  v_latest_previous_status text;
  v_latest_status text;
  v_latest_actor_name text;
begin
  insert into public.entities (entity_type, source_record_id)
  values ('branch', 'rapidcount-branch-north')
  returning id into v_branch_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_branch_id,
    1,
    jsonb_build_object('name', 'North Yard', 'status', 'active')
  );

  set local role authenticated;
  perform set_config(
    'request.jwt.claim.role',
    'authenticated',
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '11111111-1111-1111-1111-111111111111',
      'email', 'manager@example.com',
      'app_metadata', jsonb_build_object('tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'North Manager')
    )::text,
    true
  );

  begin
    perform public.rapidcount_create_count_task(
      p_name => 'Denied Missing Role Count',
      p_branch_id => v_branch_id,
      p_assignee_name => 'Casey Counter',
      p_due_date => current_date + 3,
      p_count_type => 'cycle_count',
      p_location_name => 'Aisles A-C',
      p_schedule_type => 'ad_hoc',
      p_recurrence_pattern => null,
      p_description => 'Should be denied without app role'
    );
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected missing app role create denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected missing app role to be denied for rapidcount_create_count_task';
  end if;

  v_access_blocked := false;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '11111111-1111-1111-1111-111111111111',
      'email', 'readonly@example.com',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'Read Only User')
    )::text,
    true
  );

  begin
    perform public.rapidcount_create_count_task(
      p_name => 'Denied Read Only Count',
      p_branch_id => v_branch_id,
      p_assignee_name => 'Casey Counter',
      p_due_date => current_date + 4,
      p_count_type => 'cycle_count',
      p_location_name => 'Aisles A-C',
      p_schedule_type => 'ad_hoc',
      p_recurrence_pattern => null,
      p_description => 'Should be denied for read_only'
    );
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected read_only create denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected read_only role to be denied for rapidcount_create_count_task';
  end if;

  reset role;
  set local role anon;
  perform set_config(
    'request.jwt.claim.role',
    'anon',
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'anon'
    )::text,
    true
  );

  v_access_blocked := false;
  begin
    perform public.rapidcount_create_count_task(
      p_name => 'Denied Anon Count',
      p_branch_id => v_branch_id,
      p_assignee_name => 'Casey Counter',
      p_due_date => current_date + 5,
      p_count_type => 'cycle_count',
      p_location_name => 'Aisles A-C',
      p_schedule_type => 'ad_hoc',
      p_recurrence_pattern => null,
      p_description => 'Should be denied for anon'
    );
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected anon create denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected anon role to be denied for rapidcount_create_count_task';
  end if;

  reset role;
  set local role authenticated;
  perform set_config(
    'request.jwt.claim.role',
    'authenticated',
    true
  );
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

  select count_task_id
    into v_primary_task_id
  from public.rapidcount_create_count_task(
    p_name => 'North Yard Weekly Cycle Count',
    p_branch_id => v_branch_id,
    p_assignee_name => 'Casey Counter',
    p_due_date => current_date + 2,
    p_count_type => 'cycle_count',
    p_location_name => 'Aisles A-C',
    p_schedule_type => 'recurring',
    p_recurrence_pattern => 'weekly:mon',
    p_description => 'Count high-turn accessories'
  );

  if v_primary_task_id is null then
    raise exception 'Expected primary RapidCount task to be created';
  end if;

  select count_task_id
    into v_secondary_task_id
  from public.rapidcount_create_count_task(
    p_name => 'North Yard Spot Check',
    p_branch_id => v_branch_id,
    p_assignee_name => 'Jordan Yard Lead',
    p_due_date => current_date - 1,
    p_count_type => 'spot_check',
    p_location_name => 'Fence line',
    p_schedule_type => 'ad_hoc',
    p_recurrence_pattern => null,
    p_description => 'Investigate mismatch from last transfer'
  );

  if v_secondary_task_id is null then
    raise exception 'Expected overdue RapidCount task to be created';
  end if;

  v_access_blocked := false;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '11111111-1111-1111-1111-111111111111',
      'email', 'manager@example.com',
      'app_metadata', jsonb_build_object('tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'North Manager')
    )::text,
    true
  );

  begin
    perform public.rapidcount_transition_count_task(v_primary_task_id, 'in_progress', 'Should fail without app role');
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected missing app role transition denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected missing app role to be denied for rapidcount_transition_count_task';
  end if;

  v_access_blocked := false;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '11111111-1111-1111-1111-111111111111',
      'email', 'readonly@example.com',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'Read Only User')
    )::text,
    true
  );

  begin
    perform public.rapidcount_transition_count_task(v_primary_task_id, 'in_progress', 'Should fail for read_only');
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected read_only transition denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected read_only role to be denied for rapidcount_transition_count_task';
  end if;

  reset role;
  set local role anon;
  perform set_config(
    'request.jwt.claim.role',
    'anon',
    true
  );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'anon'
    )::text,
    true
  );

  v_access_blocked := false;
  begin
    perform public.rapidcount_transition_count_task(v_primary_task_id, 'in_progress', 'Should fail for anon');
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected anon transition denial with 42501, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected anon role to be denied for rapidcount_transition_count_task';
  end if;

  reset role;
  set local role authenticated;
  perform set_config(
    'request.jwt.claim.role',
    'authenticated',
    true
  );
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

  perform public.rapidcount_transition_count_task(v_primary_task_id, 'in_progress', 'Started weekly count');
  perform public.rapidcount_transition_count_task(v_primary_task_id, 'submitted', 'Submitted branch count');
  perform public.rapidcount_transition_count_task(v_primary_task_id, 'approved', 'Approved by manager');

  begin
    perform public.rapidcount_transition_count_task(v_primary_task_id, 'planned', 'Should fail');
  exception
    when others then
      if position('already completed' in sqlerrm) > 0 then
        v_invalid_transition_blocked := true;
      else
        raise;
      end if;
  end;

  if not v_invalid_transition_blocked then
    raise exception 'Expected approved RapidCount task to reject reopening transition';
  end if;

  reset role;

  select
    status,
    due_date,
    schedule_type,
    recurrence_pattern,
    is_overdue,
    branch_name
    into v_current_status, v_due_date, v_schedule_type, v_recurrence_pattern, v_overdue, v_branch_name
  from public.rapidcount_count_tasks_current
  where count_task_id = v_primary_task_id;

  if v_current_status <> 'approved' then
    raise exception 'Expected primary task status approved, found %', v_current_status;
  end if;

  if v_due_date <> current_date + 2 then
    raise exception 'Expected primary task due date % but found %', current_date + 2, v_due_date;
  end if;

  if v_schedule_type <> 'recurring' then
    raise exception 'Expected recurring schedule_type, found %', v_schedule_type;
  end if;

  if v_recurrence_pattern <> 'weekly:mon' then
    raise exception 'Expected recurrence pattern weekly:mon, found %', v_recurrence_pattern;
  end if;

  if v_overdue then
    raise exception 'Primary task should not be overdue after creation';
  end if;

  if v_branch_name <> 'North Yard' then
    raise exception 'Expected branch name North Yard, found %', v_branch_name;
  end if;

  select is_overdue
    into v_overdue
  from public.rapidcount_count_tasks_current
  where count_task_id = v_secondary_task_id;

  if not coalesce(v_overdue, false) then
    raise exception 'Expected secondary task to be marked overdue';
  end if;

  select
    total_tasks,
    completed_tasks,
    overdue_tasks,
    in_progress_tasks,
    approved_tasks
    into v_total_tasks, v_completed_tasks, v_overdue_tasks, v_in_progress_tasks, v_approved_tasks
  from public.rapidcount_count_branch_progress
  where branch_id = v_branch_id;

  if v_total_tasks <> 2 then
    raise exception 'Expected 2 branch RapidCount tasks, found %', v_total_tasks;
  end if;

  if v_completed_tasks <> 1 then
    raise exception 'Expected 1 completed branch RapidCount task, found %', v_completed_tasks;
  end if;

  if v_overdue_tasks <> 1 then
    raise exception 'Expected 1 overdue branch RapidCount task, found %', v_overdue_tasks;
  end if;

  if v_in_progress_tasks <> 0 then
    raise exception 'Expected 0 in-progress branch RapidCount tasks after approval, found %', v_in_progress_tasks;
  end if;

  if v_approved_tasks <> 1 then
    raise exception 'Expected 1 approved branch RapidCount task, found %', v_approved_tasks;
  end if;

  select count(*)
    into v_audit_events
  from public.rapidcount_count_task_audit_history
  where count_task_id = v_primary_task_id;

  if v_audit_events <> 4 then
    raise exception 'Expected 4 audit events for primary task, found %', v_audit_events;
  end if;

  select event_type, status
    into v_first_event_type, v_first_status
  from public.rapidcount_count_task_audit_history
  where count_task_id = v_primary_task_id
  order by version_number asc, observed_at asc
  limit 1;

  if v_first_event_type <> 'created' or v_first_status <> 'planned' then
    raise exception 'Expected first audit event to be created/planned, found %/%', v_first_event_type, v_first_status;
  end if;

  select previous_status, status, actor_name
    into v_latest_previous_status, v_latest_status, v_latest_actor_name
  from public.rapidcount_count_task_audit_history
  where count_task_id = v_primary_task_id
  order by version_number desc, observed_at desc
  limit 1;

  if v_latest_previous_status <> 'submitted' or v_latest_status <> 'approved' then
    raise exception 'Expected latest audit transition submitted->approved, found %->%', v_latest_previous_status, v_latest_status;
  end if;

  if v_latest_actor_name <> 'North Manager' then
    raise exception 'Expected audit actor North Manager, found %', v_latest_actor_name;
  end if;
end;
$$;

rollback;
