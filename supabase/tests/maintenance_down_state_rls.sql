-- RLS / security-invoker behavioral tests for the maintenance down-state views
-- (migration 20260610000000_maintenance_down_state.sql).
--
-- These assertions would fail if:
--   * security_invoker is not set on a view (owner would bypass base-table RLS)
--   * the anon REVOKE is missing or ineffective for rental_current_assets /
--     rental_asset_availability_current
--   * the authenticated GRANT is missing or ineffective for v_asset_active_down_state
--   * down_severity / down_reason columns are not populated for a down asset
--
-- Pattern: SET LOCAL ROLE + set_config('request.jwt.claims', ...) simulate the
-- PostgREST JWT contexts used in production without persisting any data.

begin;

-- ── Fixture setup (superuser / service_role context) ──────────────────────
-- One asset entity, one branch, one asset-category, one maintenance_record
-- entity with hard_down impact, and the relationships wiring them together.
do $$
declare
  v_asset_id       constant uuid := 'defa0000-0000-0000-0001-000000000001';
  v_branch_id      constant uuid := 'defa0000-0000-0000-0002-000000000001';
  v_category_id    constant uuid := 'defa0000-0000-0000-0003-000000000001';
  v_maint_id       constant uuid := 'defa0000-0000-0000-0004-000000000001';
begin
  -- entities
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_asset_id,    'asset',              'maint-rls-test-asset'),
    (v_branch_id,   'branch',             'maint-rls-test-branch'),
    (v_category_id, 'asset_category',     'maint-rls-test-category'),
    (v_maint_id,    'maintenance_record', 'maint-rls-test-maint')
  on conflict (entity_type, source_record_id) do nothing;

  -- entity_versions
  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_asset_id, 1, true,
      '{"name":"RLS Test Crane","operational_status":"available"}'::jsonb,
      now()
    ),
    (
      v_branch_id, 1, true,
      '{"name":"RLS Test Branch"}'::jsonb,
      now()
    ),
    (
      v_category_id, 1, true,
      '{"name":"RLS Test Category"}'::jsonb,
      now()
    ),
    (
      v_maint_id, 1, true,
      jsonb_build_object(
        'availability_impact', 'hard_down',
        'blocking_reason',     'Hydraulic failure — awaiting parts',
        'expected_return_at',  (now() + interval '3 days')::text
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  -- relationships
  insert into public.relationships_v2
    (id, relationship_type, parent_id, child_id, is_current)
  values
    (gen_random_uuid(), 'branch_has_asset',              v_branch_id,   v_asset_id, true),
    (gen_random_uuid(), 'asset_category_has_asset',      v_category_id, v_asset_id, true),
    (gen_random_uuid(), 'asset_has_maintenance_record',  v_asset_id,    v_maint_id, true)
  on conflict do nothing;
end;
$$;

-- ── 1. All three new/modified views must declare security_invoker = true ───
do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_asset_active_down_state';

  if not v_has_invoker then
    raise exception
      'FAIL 1a: v_asset_active_down_state must declare security_invoker = true '
      '(without it the view owner bypasses base-table RLS)';
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'rental_current_assets';

  if not v_has_invoker then
    raise exception
      'FAIL 1b: rental_current_assets must declare security_invoker = true';
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'rental_asset_availability_current';

  if not v_has_invoker then
    raise exception
      'FAIL 1c: rental_asset_availability_current must declare security_invoker = true';
  end if;

  raise notice 'PASS 1: security_invoker = true on all three down-state views';
end;
$$;

-- ── 2. anon must be denied SELECT on all three views ──────────────────────
set local role anon;

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  -- 2a. v_asset_active_down_state
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_asset_active_down_state;
    raise exception
      'FAIL 2a: anon read v_asset_active_down_state succeeded — GRANT should not include anon';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2a: anon should be denied SELECT on v_asset_active_down_state';
  end if;

  -- 2b. rental_current_assets
  v_caught := false;
  begin
    select count(*) into v_dummy from public.rental_current_assets;
    raise exception
      'FAIL 2b: anon read rental_current_assets succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2b: anon should be denied SELECT on rental_current_assets';
  end if;

  -- 2c. rental_asset_availability_current
  v_caught := false;
  begin
    select count(*) into v_dummy from public.rental_asset_availability_current;
    raise exception
      'FAIL 2c: anon read rental_asset_availability_current succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2c: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2c: anon should be denied SELECT on rental_asset_availability_current';
  end if;

  raise notice 'PASS 2: anon denied SELECT on all three down-state views';
end;
$$;

reset role;

-- ── 3. authenticated can read views and sees down-state fixture data ───────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_asset_id    constant uuid := 'defa0000-0000-0000-0001-000000000001';
  v_severity    text;
  v_reason      text;
  v_count       int;
  v_hard_down   bigint;
begin
  -- 3a. v_asset_active_down_state resolves to hard_down for the fixture asset
  select down_severity, down_reason
    into v_severity, v_reason
    from public.v_asset_active_down_state
   where asset_id = v_asset_id;

  if v_severity is distinct from 'hard_down' then
    raise exception
      'FAIL 3a: v_asset_active_down_state.down_severity should be ''hard_down''; got ''%''',
      v_severity;
  end if;

  if v_reason is null then
    raise exception
      'FAIL 3a: v_asset_active_down_state.down_reason must be non-NULL for fixture asset';
  end if;

  -- 3b. rental_current_assets surfaces down_severity for the fixture asset
  select count(*) into v_count
    from public.rental_current_assets
   where entity_id = v_asset_id
     and down_severity = 'hard_down';

  if v_count <> 1 then
    raise exception
      'FAIL 3b: rental_current_assets must expose down_severity=''hard_down'' for fixture; count=%',
      v_count;
  end if;

  -- 3c. rental_asset_availability_current counts hard_down_assets correctly
  select coalesce(sum(hard_down_assets), 0) into v_hard_down
    from public.rental_asset_availability_current;

  if v_hard_down < 1 then
    raise exception
      'FAIL 3c: rental_asset_availability_current.hard_down_assets should be >= 1 '
      'after fixture insert; got %',
      v_hard_down;
  end if;

  raise notice
    'PASS 3: authenticated reads all three down-state views; hard_down fixture visible';
end;
$$;

reset role;

rollback;
