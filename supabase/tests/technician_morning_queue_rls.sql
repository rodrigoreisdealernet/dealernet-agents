-- Behavioral RLS / access-control tests for v_technician_morning_queue_scope
-- (migration 20260619010000_technician_morning_queue.sql).
--
-- Verifies:
--   1. Structural: v_technician_morning_queue_scope has security_invoker = true.
--   2. Structural: anon must NOT have SELECT on the view;
--      authenticated must NOT have SELECT on the view;
--      service_role must have SELECT on the view.
--   3. Behavioral: anon role is denied access (permission denied).
--   4. Behavioral: authenticated (field_operator claim) is denied access.
--   5. Behavioral: service_role reads all four view branches —
--      returned_unit, pm_work, active_repair, rent_ready_check —
--      and tenant_id tags are present for app-level filtering.
--   6. Behavioral: maintenance_record with a malformed data->>'asset_id' and
--      no relationship produces NULL asset_id rather than aborting the query
--      (proves the null-safe cast in the active_repair / rent_ready_check branch).
--
-- Pattern: SET LOCAL ROLE + set_config('request.jwt.claims', ...) simulate
-- PostgREST JWT contexts without persisting any data.

begin;

-- ── 1. Structural: security_invoker on the view ───────────────────────────

do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'v_technician_morning_queue_scope';

  if not v_has_invoker then
    raise exception
      'FAIL 1: v_technician_morning_queue_scope must declare security_invoker = true';
  end if;

  raise notice 'PASS 1: v_technician_morning_queue_scope has security_invoker = true';
end;
$$;

-- ── 2. Structural: grant boundaries ──────────────────────────────────────

do $$
begin
  -- anon must NOT have SELECT on the view.
  if has_table_privilege('anon', 'public.v_technician_morning_queue_scope', 'SELECT') then
    raise exception
      'FAIL 2a: anon must NOT have SELECT on public.v_technician_morning_queue_scope';
  end if;

  -- authenticated must NOT have SELECT on the view.
  if has_table_privilege('authenticated', 'public.v_technician_morning_queue_scope', 'SELECT') then
    raise exception
      'FAIL 2b: authenticated must NOT have SELECT on public.v_technician_morning_queue_scope '
      '(service_role-only; authenticated callers read ops_findings_view instead)';
  end if;

  -- service_role must have SELECT on the view.
  if not has_table_privilege('service_role', 'public.v_technician_morning_queue_scope', 'SELECT') then
    raise exception
      'FAIL 2c: service_role must have SELECT on public.v_technician_morning_queue_scope';
  end if;

  raise notice
    'PASS 2: grant boundaries correct — anon/authenticated denied; service_role granted SELECT';
end;
$$;

-- ── Seed: fixtures for all four view branches + malformed-UUID row ─────────
-- Runs as superuser (schema owner) so no RLS interference at seed time.

do $$
declare
  -- returned_unit branch (tech t1): asset with operational_status = 'returned'
  v_asset_returned   constant uuid := 'a1230000-0000-0000-0001-000000000001';
  -- maintenance_record linked via relationship to an asset (active_repair / rent_ready_check)
  v_asset_linked     constant uuid := 'a1230000-0000-0000-0002-000000000001';
  v_maint_with_rel   constant uuid := 'a1230000-0000-0000-0003-000000000001';
  -- maintenance_record with asset_id only in JSON data (no relationship)
  v_maint_json_only  constant uuid := 'a1230000-0000-0000-0004-000000000001';
  -- maintenance_record with malformed asset_id in JSON (tests null-safe cast)
  v_maint_malformed  constant uuid := 'a1230000-0000-0000-0005-000000000001';
begin
  -- Tenants used by this test suite.
  insert into public.tenants (tenant_key, name)
  values
    ('tmq-test-alpha', 'TMQ Test Alpha'),
    ('tmq-test-beta',  'TMQ Test Beta')
  on conflict (tenant_key) do nothing;

  -- ── returned_unit: asset entity with operational_status = 'returned' ──
  insert into public.entities (id, entity_type, source_record_id)
  values (v_asset_returned, 'asset', 'tmq-rls-asset-returned')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values (
    v_asset_returned, 1, true,
    '{"operational_status":"returned","name":"TMQ Returned Crane","tenant_id":"tmq-test-alpha"}'::jsonb,
    now()
  ) on conflict (entity_id, version_number) do nothing;

  -- ── pm_work: one open PM work order per tenant ─────────────────────────
  insert into public.pm_work_orders (
    tenant_id, trigger_type, maintenance_type, status, fingerprint, reason
  ) values
    ('tmq-test-alpha', 'meter',         'preventive', 'open', 'tmq-alpha-pm-001',
     'Hydraulic oil interval exceeded'),
    ('tmq-test-beta',  'time_interval', 'preventive', 'open', 'tmq-beta-pm-001',
     'Annual service due')
  on conflict (tenant_id, fingerprint) do nothing;

  -- ── active_repair: maintenance_record linked via relationship ──────────
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_asset_linked,   'asset',              'tmq-rls-asset-linked'),
    (v_maint_with_rel, 'maintenance_record', 'tmq-rls-maint-rel')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_asset_linked, 1, true,
      '{"operational_status":"in_maintenance","name":"TMQ Linked Asset","tenant_id":"tmq-test-alpha"}'::jsonb,
      now()
    ),
    (
      v_maint_with_rel, 1, true,
      '{"status":"open","parts_blocked":false,"tenant_id":"tmq-test-alpha"}'::jsonb,
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  insert into public.relationships_v2
    (id, relationship_type, parent_id, child_id, is_current)
  values
    (gen_random_uuid(), 'asset_has_maintenance_record', v_asset_linked, v_maint_with_rel, true)
  on conflict do nothing;

  -- ── rent_ready_check: maintenance_record with asset_id in JSON only ────
  insert into public.entities (id, entity_type, source_record_id)
  values (v_maint_json_only, 'maintenance_record', 'tmq-rls-maint-json')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values (
    v_maint_json_only, 1, true,
    jsonb_build_object(
      'status',      'completed',
      'asset_id',    v_asset_linked::text,
      'tenant_id',   'tmq-test-alpha'
    ),
    now()
  ) on conflict (entity_id, version_number) do nothing;

  -- ── malformed asset_id: must produce NULL, not abort ───────────────────
  insert into public.entities (id, entity_type, source_record_id)
  values (v_maint_malformed, 'maintenance_record', 'tmq-rls-maint-malformed')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values (
    v_maint_malformed, 1, true,
    '{"status":"open","asset_id":"not-a-valid-uuid","tenant_id":"tmq-test-alpha"}'::jsonb,
    now()
  ) on conflict (entity_id, version_number) do nothing;
end;
$$;

-- ── 3. Behavioral: anon is denied access to the view ─────────────────────

set local role anon;

do $$
declare
  v_count int;
begin
  begin
    select count(*) into v_count
      from public.v_technician_morning_queue_scope;
    raise exception
      'FAIL 3: anon must not have SELECT on v_technician_morning_queue_scope '
      '(expected permission denied, but got % rows)',
      v_count;
  exception
    when insufficient_privilege then
      raise notice 'PASS 3: anon correctly denied access to v_technician_morning_queue_scope';
  end;
end;
$$;

reset role;

-- ── 4. Behavioral: authenticated (any role) is denied access ─────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"role":"field_operator","tenant":"tmq-test-alpha"}}',
  true
);

do $$
declare
  v_count int;
begin
  begin
    select count(*) into v_count
      from public.v_technician_morning_queue_scope;
    raise exception
      'FAIL 4: authenticated must not have SELECT on v_technician_morning_queue_scope '
      '(expected permission denied, but got % rows — check the view grant)',
      v_count;
  exception
    when insufficient_privilege then
      raise notice
        'PASS 4: authenticated correctly denied access to v_technician_morning_queue_scope '
        '(all four branches — returned_unit, pm_work, active_repair, rent_ready_check — '
        'are inaccessible to authenticated callers)';
  end;
end;
$$;

reset role;

-- ── 5. Behavioral: service_role reads all four view branches ──────────────
-- Confirms each branch is populated from seed data and tenant_id tags are
-- present so the Temporal workflow can filter at the application layer.

set local role service_role;

do $$
declare
  v_returned_count    int;
  v_pm_count          int;
  v_repair_count      int;
  v_rent_ready_count  int;
begin
  -- Branch 1: returned_unit
  select count(*) into v_returned_count
    from public.v_technician_morning_queue_scope
   where item_type = 'returned_unit';

  if v_returned_count < 1 then
    raise exception
      'FAIL 5a: service_role expected >=1 returned_unit rows; got %', v_returned_count;
  end if;

  -- Branch 2: pm_work
  select count(*) into v_pm_count
    from public.v_technician_morning_queue_scope
   where item_type = 'pm_work';

  if v_pm_count < 1 then
    raise exception
      'FAIL 5b: service_role expected >=1 pm_work rows; got %', v_pm_count;
  end if;

  -- Branch 3: active_repair
  select count(*) into v_repair_count
    from public.v_technician_morning_queue_scope
   where item_type = 'active_repair';

  if v_repair_count < 1 then
    raise exception
      'FAIL 5c: service_role expected >=1 active_repair rows; got %', v_repair_count;
  end if;

  -- Branch 4: rent_ready_check
  select count(*) into v_rent_ready_count
    from public.v_technician_morning_queue_scope
   where item_type = 'rent_ready_check';

  if v_rent_ready_count < 1 then
    raise exception
      'FAIL 5d: service_role expected >=1 rent_ready_check rows; got %', v_rent_ready_count;
  end if;

  -- tenant_id tags present in pm_work rows for both seeded tenants.
  if not exists (
    select 1 from public.v_technician_morning_queue_scope
    where item_type = 'pm_work' and tenant_id = 'tmq-test-alpha'
  ) then
    raise exception 'FAIL 5e: alpha pm_work tenant_id tag missing from view';
  end if;

  if not exists (
    select 1 from public.v_technician_morning_queue_scope
    where item_type = 'pm_work' and tenant_id = 'tmq-test-beta'
  ) then
    raise exception 'FAIL 5f: beta pm_work tenant_id tag missing from view';
  end if;

  -- tenant_id tag present in returned_unit (from entity_versions.data).
  if not exists (
    select 1 from public.v_technician_morning_queue_scope
    where item_type = 'returned_unit' and tenant_id = 'tmq-test-alpha'
  ) then
    raise exception 'FAIL 5g: alpha returned_unit tenant_id tag missing from view';
  end if;

  raise notice
    'PASS 5: service_role reads all four view branches; tenant_id tags present for app-level filtering';
end;
$$;

reset role;

-- ── 6. Behavioral: malformed asset_id in JSON data produces NULL ──────────
-- The maintenance_record with data->>'asset_id' = 'not-a-valid-uuid' and no
-- relationship must appear in the view with asset_id = NULL, not cause an error.
-- This proves the null-safe cast added to the active_repair / rent_ready_check
-- branch is effective.

set local role service_role;

do $$
declare
  v_malformed_id  constant uuid := 'a1230000-0000-0000-0005-000000000001';
  v_asset_id_val  uuid;
  v_found         bool := false;
begin
  select asset_id, true
    into v_asset_id_val, v_found
    from public.v_technician_morning_queue_scope
   where item_source_id = v_malformed_id
   limit 1;

  if not v_found then
    raise exception
      'FAIL 6a: maintenance_record with malformed asset_id did not appear in view at all '
      '(expected a row with asset_id = NULL)';
  end if;

  if v_asset_id_val is not null then
    raise exception
      'FAIL 6b: expected asset_id = NULL for malformed JSON value; got %',
      v_asset_id_val;
  end if;

  raise notice
    'PASS 6: malformed data->asset_id yields NULL asset_id; view query did not abort';
end;
$$;

reset role;

rollback;
