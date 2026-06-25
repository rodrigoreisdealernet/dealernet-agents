-- Reset-path guard for 20260612180500_rapidcount_count_scheduling.sql.
--
-- Asserts that after a full `supabase db reset --config supabase/config.toml`
-- (migrations + seed.sql) the RapidCount count scheduling migration applies
-- cleanly and all objects are wired correctly.
--
-- Specifically validates:
--   1. Migration version 20260612180500 is present in
--      supabase_migrations.schema_migrations after reset.
--   2. The `rapidcount_count_task_audit_event` fact type exists in
--      public.fact_types.
--   3. The partial unique index
--      uq_relationships_current_branch_has_count_task exists on
--      public.relationships_v2.
--   4. All three read views (rapidcount_count_tasks_current,
--      rapidcount_count_branch_progress, rapidcount_count_task_audit_history)
--      are queryable after reset.
--   5. All three RPCs (rapidcount_create_count_task,
--      rapidcount_transition_count_task,
--      rapidcount_append_count_task_audit_event) are present and
--      SECURITY DEFINER.
--   6. A functional end-to-end smoke test: create → planned → in_progress
--      transition → audit-history round-trip confirms the objects are wired
--      correctly in the rebuilt schema.
--
-- Structure: Guards 1–5 (structural) run before the service_role context is
-- set because supabase_migrations.schema_migrations is only accessible to the
-- postgres superuser.  Guard 6 (functional) runs after the service_role
-- context is set so RPC auth checks pass.
set search_path = public, extensions;

begin;

-- ── Guards 1–5: structural checks (run as postgres superuser) ────────────────
do $$
declare
  v_fact_type_exists    boolean;
  v_index_exists        boolean;
  v_view_tasks          boolean;
  v_view_progress       boolean;
  v_view_audit          boolean;
  v_fn_create_exists    boolean;
  v_fn_transition_exists boolean;
  v_fn_audit_exists     boolean;
begin

  -- -------------------------------------------------------------------------
  -- Guard 1: migration version is present after reset.
  -- -------------------------------------------------------------------------

  if not exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260612180500'
  ) then
    raise exception
      'FAIL 1: migration 20260612180500_rapidcount_count_scheduling not found in schema_migrations after reset';
  end if;

  raise notice 'Guard 1 (migration version present): passed';

  -- -------------------------------------------------------------------------
  -- Guard 2: audit fact type exists.
  -- -------------------------------------------------------------------------

  select exists (
    select 1
    from public.fact_types
    where key = 'rapidcount_count_task_audit_event'
  ) into v_fact_type_exists;

  if not v_fact_type_exists then
    raise exception 'FAIL 2: fact type rapidcount_count_task_audit_event missing after reset';
  end if;

  raise notice 'Guard 2 (fact type exists): passed';

  -- -------------------------------------------------------------------------
  -- Guard 3: partial unique index on relationships_v2 exists.
  -- -------------------------------------------------------------------------

  select exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename  = 'relationships_v2'
      and indexname  = 'uq_relationships_current_branch_has_count_task'
  ) into v_index_exists;

  if not v_index_exists then
    raise exception
      'FAIL 3: partial unique index uq_relationships_current_branch_has_count_task missing after reset';
  end if;

  raise notice 'Guard 3 (partial unique index exists): passed';

  -- -------------------------------------------------------------------------
  -- Guard 4: all three read views are present.
  -- -------------------------------------------------------------------------

  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'rapidcount_count_tasks_current'
      and c.relkind in ('v', 'm')
  ) into v_view_tasks;

  if not v_view_tasks then
    raise exception 'FAIL 4a: view rapidcount_count_tasks_current missing after reset';
  end if;

  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'rapidcount_count_branch_progress'
      and c.relkind in ('v', 'm')
  ) into v_view_progress;

  if not v_view_progress then
    raise exception 'FAIL 4b: view rapidcount_count_branch_progress missing after reset';
  end if;

  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'rapidcount_count_task_audit_history'
      and c.relkind in ('v', 'm')
  ) into v_view_audit;

  if not v_view_audit then
    raise exception 'FAIL 4c: view rapidcount_count_task_audit_history missing after reset';
  end if;

  raise notice 'Guard 4 (all three read views present): passed';

  -- -------------------------------------------------------------------------
  -- Guard 5: RPCs are present and SECURITY DEFINER.
  -- -------------------------------------------------------------------------

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rapidcount_create_count_task'
      and p.prosecdef = true
  ) into v_fn_create_exists;

  if not v_fn_create_exists then
    raise exception 'FAIL 5a: rapidcount_create_count_task missing or not SECURITY DEFINER after reset';
  end if;

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rapidcount_transition_count_task'
      and p.prosecdef = true
  ) into v_fn_transition_exists;

  if not v_fn_transition_exists then
    raise exception 'FAIL 5b: rapidcount_transition_count_task missing or not SECURITY DEFINER after reset';
  end if;

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rapidcount_append_count_task_audit_event'
      and p.prosecdef = true
  ) into v_fn_audit_exists;

  if not v_fn_audit_exists then
    raise exception 'FAIL 5c: rapidcount_append_count_task_audit_event missing or not SECURITY DEFINER after reset';
  end if;

  raise notice 'Guard 5 (RPCs exist + SECURITY DEFINER): passed';
end;
$$;

-- ── Set service_role context for functional smoke test ────────────────────────
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

-- ── Guard 6: functional smoke test ───────────────────────────────────────────
do $$
declare
  v_branch_id       uuid;
  v_count_task_id   uuid;
  v_ev_id           uuid;
  v_current_status  text;
  v_audit_count     bigint;
  v_latest_event    text;
begin

  -- -------------------------------------------------------------------------
  -- Guard 6: functional smoke test (create → planned → in_progress transition
  --          → audit-history round-trip) using the rebuilt schema.
  -- -------------------------------------------------------------------------

  -- Create a branch entity.
  insert into public.entities (entity_type, source_record_id)
  values ('branch', 'sched-reset-guard-branch-001')
  returning id into v_branch_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_branch_id,
    1,
    jsonb_build_object('name', 'Reset Guard Branch', 'status', 'active')
  );

  -- Create an ad-hoc count task via the scheduling RPC.
  select count_task_id, entity_version_id
    into v_count_task_id, v_ev_id
  from public.rapidcount_create_count_task(
    p_name               => 'Reset Guard Ad-Hoc Count',
    p_branch_id          => v_branch_id,
    p_assignee_name      => 'Smoke Operator',
    p_due_date           => current_date + 7,
    p_count_type         => 'cycle_count',
    p_location_name      => 'Aisle A',
    p_schedule_type      => 'ad_hoc',
    p_recurrence_pattern => null,
    p_description        => 'Reset-path smoke test for scheduling'
  );

  if v_count_task_id is null then
    raise exception 'FAIL 6a: rapidcount_create_count_task returned null count_task_id after reset';
  end if;

  -- Verify initial status in the current-tasks view.
  select status
    into v_current_status
  from public.rapidcount_count_tasks_current
  where count_task_id = v_count_task_id;

  if v_current_status <> 'planned' then
    raise exception 'FAIL 6b: Expected status planned after create, got % after reset', v_current_status;
  end if;

  -- Transition the task to in_progress.
  select count_task_id, entity_version_id
    into v_count_task_id, v_ev_id
  from public.rapidcount_transition_count_task(
    p_count_task_id => v_count_task_id,
    p_status        => 'in_progress',
    p_note          => 'Reset-path transition smoke'
  );

  if v_ev_id is null then
    raise exception 'FAIL 6c: rapidcount_transition_count_task returned null entity_version_id after reset';
  end if;

  -- Confirm the view reflects the new status.
  select status
    into v_current_status
  from public.rapidcount_count_tasks_current
  where count_task_id = v_count_task_id;

  if v_current_status <> 'in_progress' then
    raise exception 'FAIL 6d: Expected status in_progress after transition, got % after reset', v_current_status;
  end if;

  -- Verify audit history captured both events (created + status_changed).
  select count(*)
    into v_audit_count
  from public.rapidcount_count_task_audit_history
  where count_task_id = v_count_task_id;

  if v_audit_count < 2 then
    raise exception 'FAIL 6e: Expected at least 2 audit events after create + transition, got % after reset', v_audit_count;
  end if;

  -- Latest audit event should reflect the transition.
  select event_type
    into v_latest_event
  from public.rapidcount_count_task_audit_history
  where count_task_id = v_count_task_id
  order by observed_at desc
  limit 1;

  if v_latest_event <> 'status_changed' then
    raise exception 'FAIL 6f: Expected latest audit event_type status_changed, got % after reset', v_latest_event;
  end if;

  raise notice 'Guard 6 (functional smoke test): passed';
  raise notice 'All rapidcount_count_scheduling reset-path guards passed.';
end;
$$;

rollback;
