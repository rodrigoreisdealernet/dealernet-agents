-- Reset-path guard for 20260613021000_rapidcount_count_capture.sql.
--
-- Asserts that after a full `supabase db reset --config supabase/config.toml`
-- the renamed RapidCount count-capture migration applies cleanly in its
-- correct position in the migration sequence (20260613021000, immediately
-- after 20260613020000_procurement_receiving_po_match_warranty.sql) with no
-- duplicate-version collision.
--
-- Specifically validates:
--   1. The migration-version uniqueness guard: 20260613021000 and
--      20260613020000 are distinct timestamps so no ordering collision occurs.
--   2. The `rapidcount_count_capture_line` fact type exists after reset.
--   3. The partial unique index enforcing per-task capture-line idempotency
--      exists.
--   4. The `rapidcount_offline_queue` table exists with its required
--      constraints.
--   5. The `rapidcount_count_lines_current` view is queryable after reset.
--   6. The `rapidcount_start_count_task` and `rapidcount_capture_count_line`
--      RPCs are present and executable after reset.
--   7. A functional end-to-end smoke test: create → start → capture → replay
--      round-trip confirms the migration objects are wired correctly in the
--      rebuilt schema.
--
-- Structure: Guards 1-6 (structural) run before the service_role context is
-- set, because supabase_migrations.schema_migrations is only accessible to the
-- postgres superuser (not service_role).  Guard 7 (functional) runs after the
-- service_role context is set so RPC auth checks pass.
set search_path = public, extensions;

begin;

-- ── Guards 1–6: structural checks (run as postgres superuser) ────────────────
do $$
declare
  v_fact_type_exists       boolean;
  v_index_exists           boolean;
  v_table_exists           boolean;
  v_view_exists            boolean;
  v_fn_start_exists        boolean;
  v_fn_capture_exists      boolean;
begin

  -- -------------------------------------------------------------------------
  -- Guard 1: duplicate-version collision check.
  --   The renamed migration sits at 20260613021000; the competing procurement
  --   receiving migration sits at 20260613020000.  Both must exist as separate
  --   supabase_migrations.schema_migrations rows with different version strings.
  -- -------------------------------------------------------------------------

  if not exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260613020000'
  ) then
    raise exception
      'FAIL collision-guard: 20260613020000_procurement_receiving_po_match_warranty migration not found after reset';
  end if;

  if not exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260613021000'
  ) then
    raise exception
      'FAIL collision-guard: 20260613021000_rapidcount_count_capture migration not found after reset — rename may not have been applied';
  end if;

  -- Assert they are two distinct rows (no duplicate primary key).
  select count(distinct version) = count(*) into v_index_exists
  from supabase_migrations.schema_migrations
  where version in ('20260613020000', '20260613021000');

  if not v_index_exists then
    raise exception
      'FAIL collision-guard: duplicate version entry detected for the 20260613020000/20260613021000 migration pair';
  end if;

  raise notice 'Guard 1 (duplicate-version collision check): passed';

  -- -------------------------------------------------------------------------
  -- Guard 2: fact type exists.
  -- -------------------------------------------------------------------------

  select exists (
    select 1
    from public.fact_types
    where key = 'rapidcount_count_capture_line'
  ) into v_fact_type_exists;

  if not v_fact_type_exists then
    raise exception 'FAIL 2: fact type rapidcount_count_capture_line missing after reset';
  end if;

  raise notice 'Guard 2 (fact type exists): passed';

  -- -------------------------------------------------------------------------
  -- Guard 3: partial unique index on time_series_points exists.
  -- -------------------------------------------------------------------------

  select exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename   = 'time_series_points'
      and indexname   = 'uq_tsp_rapidcount_capture_line_source'
  ) into v_index_exists;

  if not v_index_exists then
    raise exception 'FAIL 3: partial unique index uq_tsp_rapidcount_capture_line_source missing after reset';
  end if;

  raise notice 'Guard 3 (idempotency index exists): passed';

  -- -------------------------------------------------------------------------
  -- Guard 4: offline queue table + constraints exist.
  -- -------------------------------------------------------------------------

  select exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name   = 'rapidcount_offline_queue'
  ) into v_table_exists;

  if not v_table_exists then
    raise exception 'FAIL 4a: table public.rapidcount_offline_queue missing after reset';
  end if;

  -- scan_method check constraint.
  if not exists (
    select 1
    from information_schema.check_constraints
    where constraint_schema = 'public'
      and constraint_name   = 'chk_offline_queue_scan_method'
  ) then
    raise exception 'FAIL 4b: chk_offline_queue_scan_method constraint missing after reset';
  end if;

  -- replay_status check constraint.
  if not exists (
    select 1
    from information_schema.check_constraints
    where constraint_schema = 'public'
      and constraint_name   = 'chk_offline_queue_replay_status'
  ) then
    raise exception 'FAIL 4c: chk_offline_queue_replay_status constraint missing after reset';
  end if;

  raise notice 'Guard 4 (offline queue table + constraints): passed';

  -- -------------------------------------------------------------------------
  -- Guard 5: count-lines view is queryable.
  -- -------------------------------------------------------------------------

  select exists (
    select 1
    from information_schema.views
    where table_schema = 'public'
      and table_name   = 'rapidcount_count_lines_current'
  ) into v_view_exists;

  if not v_view_exists then
    raise exception 'FAIL 5a: view public.rapidcount_count_lines_current missing after reset';
  end if;

  -- Must be selectable without error (returns zero rows on a fresh reset; that is fine).
  perform count(*) from public.rapidcount_count_lines_current;

  raise notice 'Guard 5 (count-lines view queryable): passed';

  -- -------------------------------------------------------------------------
  -- Guard 6: RPCs exist with correct signature and SECURITY DEFINER.
  -- -------------------------------------------------------------------------

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rapidcount_start_count_task'
      and p.prosecdef = true
  ) into v_fn_start_exists;

  if not v_fn_start_exists then
    raise exception 'FAIL 6a: rapidcount_start_count_task missing or not SECURITY DEFINER after reset';
  end if;

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rapidcount_capture_count_line'
      and p.prosecdef = true
  ) into v_fn_capture_exists;

  if not v_fn_capture_exists then
    raise exception 'FAIL 6b: rapidcount_capture_count_line missing or not SECURITY DEFINER after reset';
  end if;

  raise notice 'Guard 6 (RPCs exist + SECURITY DEFINER): passed';
end;
$$;

-- ── Set service_role context for functional smoke test ────────────────────────
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

-- ── Guard 7: functional smoke test ───────────────────────────────────────────
do $$
declare
  v_branch_id              uuid;
  v_count_task_id          uuid;
  v_started_ev_id          uuid;
  v_line_id                uuid;
  v_line_id_replay         uuid;
  v_line_count             bigint;
  v_current_status         text;
begin

  -- -------------------------------------------------------------------------
  -- Guard 7: functional smoke test (create → start → capture → idempotent
  --          replay) exercising the full post-reset object graph.
  -- -------------------------------------------------------------------------

  -- Create a branch entity.
  insert into public.entities (entity_type, source_record_id)
  values ('branch', 'reset-guard-branch-001')
  returning id into v_branch_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_branch_id,
    1,
    jsonb_build_object('name', 'Reset Guard Branch', 'status', 'active')
  );

  -- Create a count task via the scheduling RPC (service_role context).
  select count_task_id into v_count_task_id
  from public.rapidcount_create_count_task(
    p_name               => 'Reset Guard Count',
    p_branch_id          => v_branch_id,
    p_assignee_name      => 'Smoke Operator',
    p_due_date           => current_date + 1,
    p_count_type         => 'cycle_count',
    p_location_name      => 'Zone A',
    p_schedule_type      => 'ad_hoc',
    p_recurrence_pattern => null,
    p_description        => 'Reset-path smoke test'
  );

  if v_count_task_id is null then
    raise exception 'FAIL 7a: rapidcount_create_count_task returned null after reset';
  end if;

  -- Start the task.
  select count_task_id, entity_version_id
    into v_count_task_id, v_started_ev_id
  from public.rapidcount_start_count_task(v_count_task_id);

  if v_started_ev_id is null then
    raise exception 'FAIL 7b: rapidcount_start_count_task returned null entity_version_id after reset';
  end if;

  select lower(data ->> 'status')
    into v_current_status
  from public.entity_versions
  where entity_id = v_count_task_id and is_current
  limit 1;

  if v_current_status <> 'in_progress' then
    raise exception 'FAIL 7c: Expected status in_progress after start, got % after reset', v_current_status;
  end if;

  -- Capture a count line.
  select line_id
    into v_line_id
  from public.rapidcount_capture_count_line(
    p_count_task_id    => v_count_task_id,
    p_idempotency_key  => 'reset-guard-idem-001',
    p_scan_value       => 'RESET-PART-001',
    p_scan_method      => 'barcode',
    p_quantity         => 2,
    p_item_description => 'Reset guard item'
  );

  if v_line_id is null then
    raise exception 'FAIL 7d: rapidcount_capture_count_line returned null line_id after reset';
  end if;

  -- Verify the line appears in the view.
  select count(*)
    into v_line_count
  from public.rapidcount_count_lines_current
  where count_task_id = v_count_task_id
    and idempotency_key = 'reset-guard-idem-001';

  if v_line_count <> 1 then
    raise exception 'FAIL 7e: Expected 1 capture line in view after reset, got %', v_line_count;
  end if;

  -- Idempotent replay: same idempotency key must return the same line_id.
  select line_id
    into v_line_id_replay
  from public.rapidcount_capture_count_line(
    p_count_task_id    => v_count_task_id,
    p_idempotency_key  => 'reset-guard-idem-001',
    p_scan_value       => 'RESET-PART-001',
    p_scan_method      => 'barcode',
    p_quantity         => 2,
    p_item_description => 'Reset guard item'
  );

  if v_line_id_replay <> v_line_id then
    raise exception 'FAIL 7f: Idempotent replay returned different line_id after reset: % vs %',
      v_line_id, v_line_id_replay;
  end if;

  -- Duplicate must not have been inserted.
  select count(*)
    into v_line_count
  from public.rapidcount_count_lines_current
  where count_task_id = v_count_task_id
    and idempotency_key = 'reset-guard-idem-001';

  if v_line_count <> 1 then
    raise exception 'FAIL 7g: Expected 1 line after idempotent replay, got % after reset', v_line_count;
  end if;

  raise notice 'Guard 7 (functional smoke test): passed';
  raise notice 'All rapidcount_count_capture reset-path guards passed.';
end;
$$;

rollback;
