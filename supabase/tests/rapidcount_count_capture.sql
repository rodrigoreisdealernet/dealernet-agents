-- RapidCount count capture assertions.
-- Validates: capture line recording, idempotency, field-operator start permission,
-- and capture-state enforcement.

begin;

do $$
declare
  v_branch_id            uuid;
  v_count_task_id        uuid;
  v_started_ev_id        uuid;
  v_started_vnum         int;
  v_line_id              uuid;
  v_line_id_replay       uuid;
  v_captured_at          timestamptz;
  v_captured_at_replay   timestamptz;
  v_current_status       text;
  v_line_count           bigint;
  v_scan_value           text;
  v_scan_method          text;
  v_quantity             int;
  v_queue_count          bigint;
  v_access_blocked       boolean := false;
  v_invalid_blocked      boolean := false;
begin
  -- -------------------------------------------------------------------------
  -- Setup: create a branch and a planned count task.
  -- -------------------------------------------------------------------------

  insert into public.entities (entity_type, source_record_id)
  values ('branch', 'rapidcount-capture-branch-north')
  returning id into v_branch_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_branch_id,
    1,
    jsonb_build_object('name', 'North Yard', 'status', 'active')
  );

  -- Use service_role to create the count task (bypasses RLS app-role check).
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select count_task_id into v_count_task_id
  from public.rapidcount_create_count_task(
    p_name            => 'North Yard Cycle Count',
    p_branch_id       => v_branch_id,
    p_assignee_name   => 'Casey Counter',
    p_due_date        => current_date + 3,
    p_count_type      => 'cycle_count',
    p_location_name   => 'Aisles A-C',
    p_schedule_type   => 'ad_hoc',
    p_recurrence_pattern => null,
    p_description     => 'Count high-turn accessories'
  );

  if v_count_task_id is null then
    raise exception 'rapidcount_create_count_task returned null count_task_id';
  end if;

  -- -------------------------------------------------------------------------
  -- Test: field_operator without matching assignee is denied start.
  -- -------------------------------------------------------------------------

  set local role authenticated;
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '22222222-2222-2222-2222-222222222222',
      'email', 'other@example.com',
      'app_metadata', jsonb_build_object('role', 'field_operator', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'Other Operator')
    )::text,
    true
  );

  begin
    perform public.rapidcount_start_count_task(v_count_task_id);
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected 42501 from non-assignee start, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected non-assignee field_operator to be denied rapidcount_start_count_task';
  end if;

  -- -------------------------------------------------------------------------
  -- Test: read_only role is denied start.
  -- -------------------------------------------------------------------------

  v_access_blocked := false;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '33333333-3333-3333-3333-333333333333',
      'email', 'readonly@example.com',
      'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'Read Only')
    )::text,
    true
  );

  begin
    perform public.rapidcount_start_count_task(v_count_task_id);
  exception
    when sqlstate '42501' then
      v_access_blocked := true;
    when others then
      raise exception 'Expected 42501 from read_only start, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_access_blocked then
    raise exception 'Expected read_only to be denied rapidcount_start_count_task';
  end if;

  -- -------------------------------------------------------------------------
  -- Test: assignee field_operator can start the task (planned → in_progress).
  -- -------------------------------------------------------------------------

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', '11111111-1111-1111-1111-111111111111',
      'email', 'casey@example.com',
      'app_metadata', jsonb_build_object('role', 'field_operator', 'tenant', 'default'),
      'user_metadata', jsonb_build_object('display_name', 'Casey Counter')
    )::text,
    true
  );

  select count_task_id, entity_version_id, version_number
    into v_count_task_id, v_started_ev_id, v_started_vnum
  from public.rapidcount_start_count_task(v_count_task_id);

  if v_started_ev_id is null then
    raise exception 'rapidcount_start_count_task returned null entity_version_id';
  end if;

  select lower(data ->> 'status')
    into v_current_status
  from public.entity_versions
  where entity_id = v_count_task_id and is_current
  limit 1;

  if v_current_status <> 'in_progress' then
    raise exception 'Expected status in_progress after start, got %', v_current_status;
  end if;

  -- -------------------------------------------------------------------------
  -- Test: idempotent re-start returns current version without error.
  -- -------------------------------------------------------------------------

  select count_task_id, entity_version_id, version_number
    into v_count_task_id, v_started_ev_id, v_started_vnum
  from public.rapidcount_start_count_task(v_count_task_id);

  if v_started_ev_id is null then
    raise exception 'Idempotent re-start returned null entity_version_id';
  end if;

  select lower(data ->> 'status')
    into v_current_status
  from public.entity_versions
  where entity_id = v_count_task_id and is_current
  limit 1;

  if v_current_status <> 'in_progress' then
    raise exception 'Expected status in_progress after idempotent re-start, got %', v_current_status;
  end if;

  -- -------------------------------------------------------------------------
  -- Test: capture a count line (barcode).
  -- -------------------------------------------------------------------------

  select line_id, captured_at
    into v_line_id, v_captured_at
  from public.rapidcount_capture_count_line(
    p_count_task_id   => v_count_task_id,
    p_idempotency_key => 'idem-test-001',
    p_scan_value      => 'PART-12345',
    p_scan_method     => 'barcode',
    p_quantity        => 3,
    p_item_description => 'Widget A'
  );

  if v_line_id is null then
    raise exception 'rapidcount_capture_count_line returned null line_id';
  end if;

  -- Verify the view surface.
  select scan_value, scan_method, quantity
    into v_scan_value, v_scan_method, v_quantity
  from public.rapidcount_count_lines_current
  where idempotency_key = 'idem-test-001';

  if v_scan_value <> 'PART-12345' then
    raise exception 'Expected scan_value PART-12345, got %', v_scan_value;
  end if;

  if v_scan_method <> 'barcode' then
    raise exception 'Expected scan_method barcode, got %', v_scan_method;
  end if;

  if v_quantity <> 3 then
    raise exception 'Expected quantity 3, got %', v_quantity;
  end if;

  -- -------------------------------------------------------------------------
  -- Test: idempotent replay returns same line_id without inserting a duplicate.
  -- -------------------------------------------------------------------------

  select line_id, captured_at
    into v_line_id_replay, v_captured_at_replay
  from public.rapidcount_capture_count_line(
    p_count_task_id   => v_count_task_id,
    p_idempotency_key => 'idem-test-001',
    p_scan_value      => 'PART-12345',
    p_scan_method     => 'barcode',
    p_quantity        => 3,
    p_item_description => 'Widget A'
  );

  if v_line_id_replay <> v_line_id then
    raise exception 'Idempotent replay returned different line_id: % vs %', v_line_id, v_line_id_replay;
  end if;

  select count(*) into v_line_count
  from public.rapidcount_count_lines_current
  where count_task_id = v_count_task_id
    and idempotency_key = 'idem-test-001';

  if v_line_count <> 1 then
    raise exception 'Expected 1 capture line after idempotent replay, got %', v_line_count;
  end if;

  -- -------------------------------------------------------------------------
  -- Test: capture a manual entry.
  -- -------------------------------------------------------------------------

  select line_id into v_line_id
  from public.rapidcount_capture_count_line(
    p_count_task_id   => v_count_task_id,
    p_idempotency_key => 'idem-test-002',
    p_scan_value      => 'ITEM-MANUAL-001',
    p_scan_method     => 'manual',
    p_quantity        => 1,
    p_item_description => null
  );

  if v_line_id is null then
    raise exception 'Manual capture returned null line_id';
  end if;

  select count(*) into v_line_count
  from public.rapidcount_count_lines_current
  where count_task_id = v_count_task_id;

  if v_line_count <> 2 then
    raise exception 'Expected 2 capture lines total, got %', v_line_count;
  end if;

  -- -------------------------------------------------------------------------
  -- Test: invalid scan_method is rejected.
  -- -------------------------------------------------------------------------

  begin
    perform public.rapidcount_capture_count_line(
      p_count_task_id   => v_count_task_id,
      p_idempotency_key => 'idem-test-bad',
      p_scan_value      => 'X',
      p_scan_method     => 'laser_pistol',
      p_quantity        => 1
    );
  exception
    when sqlstate '22023' then
      v_invalid_blocked := true;
    when others then
      raise exception 'Expected 22023 for bad scan_method, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_invalid_blocked then
    raise exception 'Expected invalid scan_method to be rejected';
  end if;

  -- -------------------------------------------------------------------------
  -- Test: missing idempotency_key is rejected.
  -- -------------------------------------------------------------------------

  v_invalid_blocked := false;
  begin
    perform public.rapidcount_capture_count_line(
      p_count_task_id   => v_count_task_id,
      p_idempotency_key => '',
      p_scan_value      => 'X',
      p_scan_method     => 'barcode',
      p_quantity        => 1
    );
  exception
    when sqlstate '22023' then
      v_invalid_blocked := true;
    when others then
      raise exception 'Expected 22023 for empty idempotency_key, got % "%"', sqlstate, sqlerrm;
  end;

  if not v_invalid_blocked then
    raise exception 'Expected empty idempotency_key to be rejected';
  end if;

  -- -------------------------------------------------------------------------
  -- Test: offline queue table exists and accepts staged entries.
  -- -------------------------------------------------------------------------

  insert into public.rapidcount_offline_queue (
    count_task_id,
    idempotency_key,
    scan_value,
    scan_method,
    quantity,
    item_description,
    actor_id,
    actor_name,
    staged_at,
    replay_status
  )
  values (
    v_count_task_id,
    'offline-idem-001',
    'PART-OFFLINE-001',
    'barcode',
    2,
    'Staged offline item',
    '11111111-1111-1111-1111-111111111111'::uuid,
    'Casey Counter',
    now(),
    'pending'
  );

  select count(*) into v_queue_count
  from public.rapidcount_offline_queue
  where idempotency_key = 'offline-idem-001';

  if v_queue_count <> 1 then
    raise exception 'Expected 1 staged offline entry, got %', v_queue_count;
  end if;

  -- Update replay status to replayed.
  update public.rapidcount_offline_queue
  set replay_status = 'replayed',
      replayed_at   = now()
  where idempotency_key = 'offline-idem-001';

  select replay_status into v_current_status
  from public.rapidcount_offline_queue
  where idempotency_key = 'offline-idem-001';

  if v_current_status <> 'replayed' then
    raise exception 'Expected replay_status replayed, got %', v_current_status;
  end if;

  raise notice 'All RapidCount count capture assertions passed.';
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- RLS isolation: offline queue ownership enforcement.
-- Override auth.uid() to read `sub` from request.jwt.claims, matching the
-- GoTrue/PostgREST production pattern.  This CREATE OR REPLACE is inside the
-- surrounding BEGIN...ROLLBACK transaction, so it is fully rolled back at the
-- end of this file and cannot leak into other test runs.
-- ---------------------------------------------------------------------------

create or replace function auth.uid()
returns uuid
language sql
security invoker
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
      ''
    ),
    ''
  )::uuid;
$$;

do $$
declare
  v_user_a      uuid := '44444444-4444-4444-4444-444444444444'::uuid;
  v_user_b      uuid := '55555555-5555-5555-5555-555555555555'::uuid;
  v_task_id     uuid;
  v_count       bigint;
  v_status      text;
  v_blocked     boolean := false;
begin

  -- -------------------------------------------------------------------------
  -- Seed: service_role inserts one offline-queue entry owned by user A.
  -- -------------------------------------------------------------------------

  set local role service_role;
  perform set_config('request.jwt.claims', '{}', true);

  -- We need a real count_task_id for the FK; re-use the entity created above.
  select e.id into v_task_id
  from public.entities e
  where e.entity_type = 'count_task'
  limit 1;

  if v_task_id is null then
    raise exception 'RLS setup: could not find a count_task entity';
  end if;

  insert into public.rapidcount_offline_queue (
    count_task_id,
    idempotency_key,
    scan_value,
    scan_method,
    quantity,
    actor_id,
    actor_name,
    staged_at,
    replay_status
  )
  values (
    v_task_id,
    'rls-idem-user-a',
    'PART-RLS-A',
    'barcode',
    1,
    v_user_a,
    'User A',
    now(),
    'pending'
  );

  -- -------------------------------------------------------------------------
  -- Test RLS-1: user B (authenticated) cannot see user A's entry.
  -- -------------------------------------------------------------------------

  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',          v_user_b::text,
      'role',         'authenticated',
      'app_metadata', jsonb_build_object('role', 'field_operator', 'tenant', 'default')
    )::text,
    true
  );

  select count(*) into v_count
  from public.rapidcount_offline_queue;

  if v_count <> 0 then
    raise exception
      'RLS-1 failed: user B should see 0 offline-queue rows, got %', v_count;
  end if;

  raise notice 'RLS-1 (user B cannot read user A rows): passed';

  -- -------------------------------------------------------------------------
  -- Test RLS-2: user B cannot insert a row claiming to be user A (WITH CHECK).
  -- -------------------------------------------------------------------------

  v_blocked := false;
  begin
    insert into public.rapidcount_offline_queue (
      count_task_id,
      idempotency_key,
      scan_value,
      scan_method,
      quantity,
      actor_id,
      actor_name,
      staged_at,
      replay_status
    )
    values (
      v_task_id,
      'rls-idem-spoof',
      'PART-SPOOF',
      'manual',
      1,
      v_user_a,
      'User B spoofing A',
      now(),
      'pending'
    );
    -- Insert succeeded — WITH CHECK policy did not fire; v_blocked stays false.
  exception
    -- check_violation  → RLS WITH CHECK blocked the row (expected path).
    -- insufficient_privilege → authenticated role lacks INSERT grant entirely;
    --   both mean the spoofed write was rejected, which is the correct outcome.
    when check_violation or insufficient_privilege then
      v_blocked := true;
    when others then
      raise exception 'RLS-2: unexpected exception % "%"', sqlstate, sqlerrm;
  end;

  if not v_blocked then
    raise exception 'RLS-2 failed: spoofed actor_id insert was not blocked by WITH CHECK policy';
  end if;

  raise notice 'RLS-2 (user B cannot insert with spoofed actor_id): passed';

  -- -------------------------------------------------------------------------
  -- Test RLS-3: user B cannot update user A's row.
  --   UPDATE with no USING-matching rows is a silent no-op; verify the row
  --   is unchanged to confirm RLS blocked the update.
  -- -------------------------------------------------------------------------

  update public.rapidcount_offline_queue
  set replay_status = 'failed'
  where idempotency_key = 'rls-idem-user-a';

  -- Switch to service_role to inspect the actual row value without RLS filter.
  set local role service_role;
  perform set_config('request.jwt.claims', '{}', true);

  select replay_status into v_status
  from public.rapidcount_offline_queue
  where idempotency_key = 'rls-idem-user-a';

  if v_status <> 'pending' then
    raise exception
      'RLS-3 failed: user B should not have updated the row (status is now "%")', v_status;
  end if;

  raise notice 'RLS-3 (user B cannot update user A row): passed';

  -- -------------------------------------------------------------------------
  -- Test RLS-4: user A can read and update their own row.
  -- -------------------------------------------------------------------------

  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',          v_user_a::text,
      'role',         'authenticated',
      'app_metadata', jsonb_build_object('role', 'field_operator', 'tenant', 'default')
    )::text,
    true
  );

  select count(*) into v_count
  from public.rapidcount_offline_queue;

  if v_count <> 1 then
    raise exception 'RLS-4 failed: user A should see 1 row (own), got %', v_count;
  end if;

  update public.rapidcount_offline_queue
  set replay_status = 'replayed',
      replayed_at   = now()
  where idempotency_key = 'rls-idem-user-a';

  set local role service_role;
  perform set_config('request.jwt.claims', '{}', true);

  select replay_status into v_status
  from public.rapidcount_offline_queue
  where idempotency_key = 'rls-idem-user-a';

  if v_status <> 'replayed' then
    raise exception 'RLS-4 failed: user A own-row update did not persist (status "%")', v_status;
  end if;

  raise notice 'RLS-4 (user A can read and update own row): passed';

  raise notice 'All RLS isolation assertions for rapidcount_offline_queue passed.';
end;
$$;

rollback;
