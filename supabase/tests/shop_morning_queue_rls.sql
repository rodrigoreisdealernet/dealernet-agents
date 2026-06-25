-- Behavioral RLS tests for v_shop_morning_queue_scope and pm_work_orders.
-- Covers: migration 20260614200000 (view definition) and
--         migration 20260614210000 (pm_work_orders RLS + grants).
--
-- Verifies:
--   1. Structural: v_shop_morning_queue_scope has security_invoker = true.
--   2. Structural: pm_work_orders has RLS enabled and correct grants;
--      authenticated must NOT have SELECT on the view (service_role-only);
--      service_role must have SELECT on the view.
--   3. Behavioral: service_role INSERT/UPDATE/DELETE on pm_work_orders succeeds.
--   4. Behavioral: authenticated same-tenant read (direct pm_work_orders table):
--      alpha claim sees only its own row.
--   5. Behavioral: authenticated cross-tenant read (direct pm_work_orders table):
--      beta claim sees only its own row; alpha row absent.
--   6. Behavioral: authenticated cannot access v_shop_morning_queue_scope for any
--      branch (pm_due, work_order_priority/parts_blocker, not_available_unit) —
--      positive proof of access denial for all three branches.
--   7. Behavioral: service_role reads all three view branches; cross-tenant
--      tenant_id tags confirmed for app-level filtering by Temporal workflow.

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
  where n.nspname = 'public' and c.relname = 'v_shop_morning_queue_scope';

  if not v_has_invoker then
    raise exception
      'FAIL 1: v_shop_morning_queue_scope must declare security_invoker = true';
  end if;

  raise notice 'PASS 1: v_shop_morning_queue_scope has security_invoker = true';
end;
$$;

-- ── 2. Structural: pm_work_orders RLS + grants; view access boundaries ────

do $$
declare
  v_has_rls bool;
begin
  select c.relrowsecurity
    into v_has_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'pm_work_orders';

  if not found or not coalesce(v_has_rls, false) then
    raise exception 'FAIL 2a: RLS must be enabled on public.pm_work_orders';
  end if;

  -- authenticated: SELECT but not INSERT / UPDATE / DELETE on pm_work_orders.
  if not has_table_privilege('authenticated', 'public.pm_work_orders', 'SELECT') then
    raise exception 'FAIL 2b: authenticated must have SELECT on public.pm_work_orders';
  end if;
  if has_table_privilege('authenticated', 'public.pm_work_orders', 'INSERT') then
    raise exception
      'FAIL 2c: authenticated must NOT have INSERT on public.pm_work_orders '
      '(service-role-only write boundary)';
  end if;
  if has_table_privilege('authenticated', 'public.pm_work_orders', 'UPDATE') then
    raise exception
      'FAIL 2d: authenticated must NOT have UPDATE on public.pm_work_orders';
  end if;

  -- service_role: full DML on pm_work_orders.
  if not has_table_privilege('service_role', 'public.pm_work_orders', 'INSERT') then
    raise exception 'FAIL 2e: service_role must have INSERT on public.pm_work_orders';
  end if;
  if not has_table_privilege('service_role', 'public.pm_work_orders', 'UPDATE') then
    raise exception 'FAIL 2f: service_role must have UPDATE on public.pm_work_orders';
  end if;
  if not has_table_privilege('service_role', 'public.pm_work_orders', 'DELETE') then
    raise exception 'FAIL 2g: service_role must have DELETE on public.pm_work_orders';
  end if;

  -- authenticated must NOT have SELECT on the view.
  -- The view is service_role-only; the frontend reads ops_findings_view instead.
  if has_table_privilege('authenticated', 'public.v_shop_morning_queue_scope', 'SELECT') then
    raise exception
      'FAIL 2h: authenticated must NOT have SELECT on public.v_shop_morning_queue_scope '
      '(service_role-only; all three branches of entity data would bypass DB-level '
      'tenant isolation if exposed to authenticated)';
  end if;

  -- service_role must have SELECT on the view.
  if not has_table_privilege('service_role', 'public.v_shop_morning_queue_scope', 'SELECT') then
    raise exception 'FAIL 2i: service_role must have SELECT on public.v_shop_morning_queue_scope';
  end if;

  raise notice 'PASS 2: pm_work_orders RLS + grants correct; view is service_role-only';
end;
$$;

-- ── Seed: two tenants with one open pm_work_order each + entity fixtures ──
-- Runs as superuser (schema owner) so no RLS interference at seed time.

do $$
declare
  v_asset_id  constant uuid := 'f1110000-0000-0000-0001-000000000001';
  v_maint_id  constant uuid := 'f1110000-0000-0000-0002-000000000001';
begin
  -- Two tenant rows for JWT-claims matching.
  insert into public.tenants (tenant_key, name)
  values
    ('smq-test-alpha', 'SMQ Test Alpha'),
    ('smq-test-beta',  'SMQ Test Beta')
  on conflict (tenant_key) do nothing;

  -- pm_work_orders: one open row per tenant.
  -- The reason text is used below as a fingerprint-in-context check.
  insert into public.pm_work_orders (
    tenant_id, trigger_type, maintenance_type, status, fingerprint, reason
  ) values
    ('smq-test-alpha', 'meter',         'preventive', 'open', 'smq-alpha-001',
     'Hydraulic oil interval exceeded'),
    ('smq-test-beta',  'time_interval', 'preventive', 'open', 'smq-beta-001',
     'Annual service due')
  on conflict (tenant_id, fingerprint) do nothing;

  -- Entity-backed: maintenance_record with status = 'open' tagged to alpha.
  insert into public.entities (id, entity_type, source_record_id)
  values (v_maint_id, 'maintenance_record', 'smq-rls-maint-001')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values (
    v_maint_id, 1, true,
    '{"status":"open","maintenance_type":"corrective","tenant_id":"smq-test-alpha"}'::jsonb,
    now()
  ) on conflict (entity_id, version_number) do nothing;

  -- Entity-backed: asset with operational_status = 'in_maintenance' tagged to alpha.
  insert into public.entities (id, entity_type, source_record_id)
  values (v_asset_id, 'asset', 'smq-rls-asset-001')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values (
    v_asset_id, 1, true,
    '{"operational_status":"in_maintenance","name":"SMQ Test Crane","tenant_id":"smq-test-alpha"}'::jsonb,
    now()
  ) on conflict (entity_id, version_number) do nothing;
end;
$$;

-- ── 3. Behavioral: service_role write path ────────────────────────────────

set local role service_role;

do $$
declare
  v_id    uuid;
  v_count int;
begin
  -- INSERT succeeds.
  insert into public.pm_work_orders (
    tenant_id, trigger_type, maintenance_type, status, fingerprint
  ) values (
    'smq-test-alpha', 'rental_count', 'preventive', 'open', 'smq-svc-write-001'
  ) returning id into v_id;

  -- UPDATE succeeds.
  update public.pm_work_orders
     set reason = 'service-role updated'
   where id = v_id;

  select count(*) into v_count
    from public.pm_work_orders
   where fingerprint = 'smq-svc-write-001';
  if v_count <> 1 then
    raise exception 'FAIL 3a: service_role INSERT + UPDATE; expected 1 row, got %', v_count;
  end if;

  -- DELETE succeeds.
  delete from public.pm_work_orders where id = v_id;

  select count(*) into v_count
    from public.pm_work_orders
   where fingerprint = 'smq-svc-write-001';
  if v_count <> 0 then
    raise exception 'FAIL 3b: service_role DELETE did not remove row; got %', v_count;
  end if;

  raise notice 'PASS 3: service_role INSERT / UPDATE / DELETE on pm_work_orders succeeded';
end;
$$;

reset role;

-- ── 4. Behavioral: authenticated same-tenant read (direct pm_work_orders table) ─
-- Claim: smq-test-alpha. Two open pm_work_orders were seeded (alpha + beta).
-- RLS must expose only the alpha row through the table's tenant-scoped policy.

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"smq-test-alpha"}}',
  true
);

do $$
declare
  v_direct_count int;
begin
  -- Direct table: alpha claim must see exactly 1 open pm_work_orders row.
  select count(*) into v_direct_count
    from public.pm_work_orders
   where status = 'open';

  if v_direct_count <> 1 then
    raise exception
      'FAIL 4a: alpha claim expected exactly 1 open pm_work_orders row; got %',
      v_direct_count;
  end if;

  -- Alpha row must be visible.
  if not exists (
    select 1 from public.pm_work_orders
    where tenant_id = 'smq-test-alpha' and status = 'open'
  ) then
    raise exception 'FAIL 4b: alpha pm_work_orders row not visible under RLS';
  end if;

  -- Beta row must be absent (RLS tenant_id filter).
  if exists (
    select 1 from public.pm_work_orders
    where tenant_id = 'smq-test-beta' and status = 'open'
  ) then
    raise exception
      'FAIL 4c: beta pm_work_orders row must not be visible to alpha claim';
  end if;

  raise notice 'PASS 4: alpha claim sees only its own pm_work_orders row; beta row absent';
end;
$$;

-- ── 5. Behavioral: cross-tenant — beta claim cannot see alpha pm_due rows ─

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"smq-test-beta"}}',
  true
);

do $$
declare
  v_direct_count int;
begin
  -- Direct table: beta claim must see exactly 1 open pm_work_orders row (its own).
  select count(*) into v_direct_count
    from public.pm_work_orders
   where status = 'open';

  if v_direct_count <> 1 then
    raise exception
      'FAIL 5a: beta claim expected exactly 1 open pm_work_orders row; got %',
      v_direct_count;
  end if;

  -- Alpha row must be invisible to beta claim.
  if exists (
    select 1 from public.pm_work_orders
    where tenant_id = 'smq-test-alpha' and status = 'open'
  ) then
    raise exception
      'FAIL 5b: alpha pm_work_orders row must not be visible to beta claim';
  end if;

  -- Beta's own row must be visible.
  if not exists (
    select 1 from public.pm_work_orders
    where tenant_id = 'smq-test-beta' and status = 'open'
  ) then
    raise exception 'FAIL 5c: beta pm_work_orders row must be visible to beta claim';
  end if;

  raise notice 'PASS 5: cross-tenant pm_work_orders isolation holds; alpha row absent for beta claim';
end;
$$;

reset role;

-- ── 6. Behavioral: authenticated cannot access v_shop_morning_queue_scope ──
-- The view is service_role-only. Any authenticated caller — regardless of tenant
-- claim — must receive permission denied for all three branches.
-- This is the primary access-control proof for the entity-backed branches
-- (work_order_priority / parts_blocker / not_available_unit) whose underlying
-- tables carry broad USING (true) policies: those tables are intentionally NOT
-- exposed through this view to authenticated users.

set local role authenticated;
-- Use field_operator role — any authenticated role should be denied access;
-- field_operator confirms the denial is not role-specific.
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"role":"field_operator","tenant":"smq-test-alpha"}}',
  true
);

do $$
declare
  v_count int;
begin
  -- Attempt full view read (covers all three branches in one query).
  begin
    select count(*) into v_count
      from public.v_shop_morning_queue_scope;
    -- Reaching here means authenticated was granted SELECT — the grant removal failed.
    raise exception
      'FAIL 6: authenticated must not have SELECT on v_shop_morning_queue_scope '
      '(expected permission denied, but got % rows — check the view grant)',
      v_count;
  exception
    when insufficient_privilege then
      raise notice
        'PASS 6: authenticated correctly denied access to v_shop_morning_queue_scope '
        '(all three branches — pm_due, work_order_priority/parts_blocker, '
        'not_available_unit — are inaccessible to authenticated callers)';
  end;
end;
$$;

reset role;

-- ── 7. Behavioral: service_role reads all three view branches ─────────────
-- Confirms each branch of v_shop_morning_queue_scope is populated from seed data
-- and that tenant_id tags are present so the Temporal workflow can filter by
-- tenant at the application layer.

set local role service_role;

do $$
declare
  v_pm_count    int;
  v_maint_count int;
  v_asset_count int;
begin
  -- Branch 1: pm_due (from pm_work_orders).
  select count(*) into v_pm_count
    from public.v_shop_morning_queue_scope
   where item_type = 'pm_due';

  if v_pm_count < 1 then
    raise exception
      'FAIL 7a: service_role expected >=1 pm_due rows in view; got %', v_pm_count;
  end if;

  -- Branch 2: work_order_priority / parts_blocker (from maintenance_record entities).
  select count(*) into v_maint_count
    from public.v_shop_morning_queue_scope
   where item_type in ('work_order_priority', 'parts_blocker');

  if v_maint_count < 1 then
    raise exception
      'FAIL 7b: service_role expected >=1 work_order_priority/parts_blocker rows; got %',
      v_maint_count;
  end if;

  -- Branch 3: not_available_unit (from asset entities with in_maintenance status).
  select count(*) into v_asset_count
    from public.v_shop_morning_queue_scope
   where item_type = 'not_available_unit';

  if v_asset_count < 1 then
    raise exception
      'FAIL 7c: service_role expected >=1 not_available_unit rows; got %', v_asset_count;
  end if;

  -- Cross-tenant: tenant_id tags present in all pm_due rows for app-level filtering.
  -- service_role sees all tenants; the Temporal workflow applies tenant_id = ? filter.
  if not exists (
    select 1 from public.v_shop_morning_queue_scope
    where item_type = 'pm_due' and tenant_id = 'smq-test-alpha'
  ) then
    raise exception 'FAIL 7d: alpha pm_due tenant_id tag missing from view';
  end if;

  if not exists (
    select 1 from public.v_shop_morning_queue_scope
    where item_type = 'pm_due' and tenant_id = 'smq-test-beta'
  ) then
    raise exception 'FAIL 7e: beta pm_due tenant_id tag missing from view';
  end if;

  -- Entity-backed rows carry tenant_id from ev.data for app-level filtering.
  if not exists (
    select 1 from public.v_shop_morning_queue_scope
    where item_type in ('work_order_priority', 'parts_blocker')
      and tenant_id = 'smq-test-alpha'
  ) then
    raise exception
      'FAIL 7f: alpha maintenance_record tenant_id tag missing from entity-backed branch';
  end if;

  if not exists (
    select 1 from public.v_shop_morning_queue_scope
    where item_type = 'not_available_unit'
      and tenant_id = 'smq-test-alpha'
  ) then
    raise exception
      'FAIL 7g: alpha asset tenant_id tag missing from not_available_unit branch';
  end if;

  raise notice
    'PASS 7: service_role reads all three view branches; '
    'tenant_id tags present for app-level filtering';
end;
$$;

reset role;

rollback;
