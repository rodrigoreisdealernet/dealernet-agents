-- Maintenance service-history analytics reset-path assertions
-- Verifies that supabase db reset + seed.sql produces populated analytics views
-- created by migration 20260610100000_maintenance_service_history_analytics.sql,
-- and proves explicit pool-restoration behavior (setting completed_at removes an
-- asset from the active-down-state view).
--
-- Runs after: supabase db reset (which applies migrations + seed.sql)

begin;

-- ── 1. All three analytics views must declare security_invoker = true ────────
do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_asset_service_history';

  if not v_has_invoker then
    raise exception
      'FAIL 1a: v_asset_service_history must declare security_invoker = true';
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_asset_downtime_analytics';

  if not v_has_invoker then
    raise exception
      'FAIL 1b: v_asset_downtime_analytics must declare security_invoker = true';
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_asset_category_downtime_summary';

  if not v_has_invoker then
    raise exception
      'FAIL 1c: v_asset_category_downtime_summary must declare security_invoker = true';
  end if;

  raise notice 'PASS 1: security_invoker = true on all three analytics views';
end;
$$;

-- ── 2. v_asset_service_history must return rows from the demo seed ───────────
do $$
declare
  v_service_history_rows bigint;
  v_maintenance_rows     bigint;
  v_inspection_rows      bigint;
  v_completed_rows       bigint;
begin
  select count(*) into v_service_history_rows from public.v_asset_service_history;

  if v_service_history_rows <= 0 then
    raise exception
      'FAIL 2a: v_asset_service_history must return rows after reset+seed; got %',
      v_service_history_rows;
  end if;

  select count(*) into v_maintenance_rows
    from public.v_asset_service_history
   where service_record_type = 'maintenance';

  if v_maintenance_rows <= 0 then
    raise exception
      'FAIL 2b: v_asset_service_history must include maintenance rows; got %',
      v_maintenance_rows;
  end if;

  select count(*) into v_inspection_rows
    from public.v_asset_service_history
   where service_record_type = 'inspection';

  if v_inspection_rows <= 0 then
    raise exception
      'FAIL 2c: v_asset_service_history must include inspection rows; got %',
      v_inspection_rows;
  end if;

  -- seed.sql seeds maintenance records 7–10 (demo-baseline-maintenance-007 through -010)
  -- with completed_at set; at least some must appear with a non-null completed_at so
  -- the service-history surface has finished cycles to show.
  select count(*) into v_completed_rows
    from public.v_asset_service_history
   where service_record_type = 'maintenance'
     and completed_at is not null;

  if v_completed_rows <= 0 then
    raise exception
      'FAIL 2d: v_asset_service_history must include completed maintenance rows; got %',
      v_completed_rows;
  end if;

  raise notice 'PASS 2: v_asset_service_history rows verified (total=%, maintenance=%, inspections=%, completed=%)',
    v_service_history_rows, v_maintenance_rows, v_inspection_rows, v_completed_rows;
end;
$$;

-- ── 3. v_asset_downtime_analytics must aggregate non-zero downtime ───────────
do $$
declare
  v_rollup_rows    bigint;
  v_total_minutes  numeric;
begin
  select count(*), coalesce(sum(total_downtime_minutes), 0)
    into v_rollup_rows, v_total_minutes
    from public.v_asset_downtime_analytics;

  if v_rollup_rows <= 0 then
    raise exception
      'FAIL 3a: v_asset_downtime_analytics must return rows after reset+seed; got %',
      v_rollup_rows;
  end if;

  if v_total_minutes <= 0 then
    raise exception
      'FAIL 3b: v_asset_downtime_analytics must aggregate non-zero total_downtime_minutes; got %',
      v_total_minutes;
  end if;

  raise notice 'PASS 3: v_asset_downtime_analytics verified (rows=%, total_minutes=%)',
    v_rollup_rows, v_total_minutes;
end;
$$;

-- ── 4. v_asset_category_downtime_summary must aggregate non-zero downtime ────
do $$
declare
  v_category_rows    bigint;
  v_category_minutes numeric;
begin
  select count(*), coalesce(sum(total_downtime_minutes), 0)
    into v_category_rows, v_category_minutes
    from public.v_asset_category_downtime_summary;

  if v_category_rows <= 0 then
    raise exception
      'FAIL 4a: v_asset_category_downtime_summary must return rows after reset+seed; got %',
      v_category_rows;
  end if;

  if v_category_minutes <= 0 then
    raise exception
      'FAIL 4b: v_asset_category_downtime_summary must aggregate non-zero total_downtime_minutes; got %',
      v_category_minutes;
  end if;

  raise notice 'PASS 4: v_asset_category_downtime_summary verified (rows=%, total_minutes=%)',
    v_category_rows, v_category_minutes;
end;
$$;

-- ── 5. Explicit pool restoration: completing a maintenance record removes the
--        asset from v_asset_active_down_state ──────────────────────────────────
--
-- This block uses fixed-prefix UUIDs (a0000001-...) chosen to be visually
-- distinct from gen_random_uuid() values and from any entity inserted by
-- seed.sql, ensuring no collision with real data. All inserts are rolled back
-- at the end of the wrapping transaction so no fixture rows persist.
do $$
declare
  v_asset_id   constant uuid := 'a0000001-0000-0000-0000-000000000001';
  v_branch_id  constant uuid := 'a0000001-0000-0000-0000-000000000002';
  v_cat_id     constant uuid := 'a0000001-0000-0000-0000-000000000003';
  v_maint_id   constant uuid := 'a0000001-0000-0000-0000-000000000004';
  v_in_down    bigint;
begin
  -- ── 5a. Fixture: asset in hard_down state (open maintenance, no completed_at)
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_asset_id,  'asset',              'pool-restore-test-asset'),
    (v_branch_id, 'branch',             'pool-restore-test-branch'),
    (v_cat_id,    'asset_category',     'pool-restore-test-category'),
    (v_maint_id,  'maintenance_record', 'pool-restore-test-maint')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values
    (v_asset_id,  1, true, '{"name":"Pool Restore Test Asset","operational_status":"available"}'::jsonb, now()),
    (v_branch_id, 1, true, '{"name":"Pool Restore Test Branch"}'::jsonb, now()),
    (v_cat_id,    1, true, '{"name":"Pool Restore Test Category"}'::jsonb, now()),
    (v_maint_id,  1, true,
      jsonb_build_object(
        'availability_impact', 'hard_down',
        'blocking_reason',     'Engine failure — awaiting parts',
        'expected_return_at',  (now() + interval '5 days')::text
        -- no completed_at → asset is in the down pool
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  insert into public.relationships_v2
    (id, relationship_type, parent_id, child_id, is_current)
  values
    (gen_random_uuid(), 'branch_has_asset',             v_branch_id, v_asset_id, true),
    (gen_random_uuid(), 'asset_category_has_asset',     v_cat_id,    v_asset_id, true),
    (gen_random_uuid(), 'asset_has_maintenance_record', v_asset_id,  v_maint_id, true)
  on conflict do nothing;

  -- Asset must appear in the active-down-state view (no completed_at = open)
  select count(*) into v_in_down
    from public.v_asset_active_down_state
   where asset_id = v_asset_id
     and down_severity = 'hard_down';

  if v_in_down <> 1 then
    raise exception
      'FAIL 5a: asset must appear in v_asset_active_down_state when maintenance is open; count=%',
      v_in_down;
  end if;

  -- ── 5b. Explicit pool restoration: set completed_at on the maintenance record
  update public.entity_versions
     set data = data || jsonb_build_object('completed_at', now()::text)
   where entity_id = v_maint_id
     and is_current;

  -- Asset must no longer appear in the active-down-state view
  select count(*) into v_in_down
    from public.v_asset_active_down_state
   where asset_id = v_asset_id;

  if v_in_down <> 0 then
    raise exception
      'FAIL 5b: asset must be removed from v_asset_active_down_state after pool restoration (completed_at set); count=%',
      v_in_down;
  end if;

  raise notice 'PASS 5: explicit pool restoration confirmed — asset removed from down-state view when completed_at is set';
end;
$$;

rollback;
