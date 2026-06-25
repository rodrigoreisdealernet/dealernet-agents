-- RLS / security-invoker behavioral tests for the dispatch live ops views
-- (migration 20260609120000_dispatch_live_ops_views.sql).
--
-- These assertions would fail if:
--   * security_invoker is not set on a view (owner would bypass base-table RLS)
--   * the anon REVOKE is missing or ineffective
--   * the authenticated GRANT is missing or ineffective
--   * the v_current_assets JOIN breaks the security_invoker chain
--
-- Pattern: multiple DO blocks within one transaction.  SET LOCAL ROLE +
-- set_config('request.jwt.claims', ...) simulate the PostgREST JWT contexts
-- used in production without persisting any data.

begin;

-- ── Fixture setup (superuser / service_role context) ──────────────────────
-- One asset entity and one checked-out contract line referencing it so every
-- view query has a concrete row to return.
do $$
declare
  v_asset_id constant uuid := 'deadbeef-0000-0000-0001-000000000001';
  v_line_id  constant uuid := 'deadbeef-0000-0000-0002-000000000001';
begin
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_asset_id, 'asset',                'dispatch-rls-test-asset'),
    (v_line_id,  'rental_contract_line', 'dispatch-rls-test-line')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_asset_id, 1, true,
      '{"status":"available","name":"RLS Test Excavator","serial_number":"RLS-001"}'::jsonb,
      now()
    ),
    (
      v_line_id, 1, true,
      jsonb_build_object(
        'status',       'checked_out',
        'contract_id',  gen_random_uuid()::text,
        'asset_id',     v_asset_id::text,
        'actual_start', (now() - interval '1 hour')::text,
        'confirm_load', jsonb_build_object(
          'assigned_driver', 'rls-driver-001',
          'assigned_truck',  'rls-truck-001',
          'departure_at',    (now() - interval '1 hour')::text
        )
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;
end;
$$;

-- ── 1. Both dispatch views and their v_current_assets dependency must ──────
--       declare security_invoker = true
-- Without security_invoker the view executes as its owner (typically a
-- superuser) which bypasses base-table RLS entirely, allowing the view to
-- expose rows that a restricted role would not be allowed to read directly.
do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_dispatch_route_live';

  if not v_has_invoker then
    raise exception
      'FAIL 1a: v_dispatch_route_live must declare security_invoker = true '
      '(without it the view owner bypasses base-table RLS)';
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_transport_efficiency_summary';

  if not v_has_invoker then
    raise exception
      'FAIL 1b: v_transport_efficiency_summary must declare security_invoker = true';
  end if;

  -- v_current_assets is joined inside v_dispatch_route_live.  It must also be
  -- security_invoker so asset data cannot cross the authenticated/anon claim
  -- boundary through the join.
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_current_assets';

  if not v_has_invoker then
    raise exception
      'FAIL 1c: v_current_assets must declare security_invoker = true '
      '(dispatch view joins it; a non-invoker dependency breaks the RLS chain)';
  end if;

  raise notice 'PASS 1: security_invoker = true on both dispatch views and v_current_assets';
end;
$$;

-- ── 2. anon must be denied SELECT on both views ───────────────────────────
-- REVOKE ALL … FROM anon was applied in the migration; confirm it is effective.
set local role anon;

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  -- 2a. v_dispatch_route_live
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_dispatch_route_live;
    raise exception
      'FAIL 2a: anon read v_dispatch_route_live succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2a: anon should be denied SELECT on v_dispatch_route_live';
  end if;

  -- 2b. v_transport_efficiency_summary
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_transport_efficiency_summary;
    raise exception
      'FAIL 2b: anon read v_transport_efficiency_summary succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2b: anon should be denied SELECT on v_transport_efficiency_summary';
  end if;

  raise notice 'PASS 2: anon denied SELECT on both dispatch views (REVOKE effective)';
end;
$$;

reset role;

-- ── 3 & 4. authenticated can SELECT and sees fixture data ─────────────────
-- Simulates a PostgREST API call with a read_only JWT.  The set_config call
-- mirrors how production PostgREST populates the JWT claims GUC; in this test
-- harness auth.jwt() returns the stub value but the role-level grant/deny is
-- exercised correctly via SET LOCAL ROLE.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_line_id    constant uuid   := 'deadbeef-0000-0000-0002-000000000001';
  v_count      int;
  v_status     text;
  v_asset_name text;
  v_active     bigint;
begin
  -- 3a. v_dispatch_route_live is readable and returns the fixture row
  select count(*) into v_count
    from public.v_dispatch_route_live
   where line_id = v_line_id;

  if v_count <> 1 then
    raise exception
      'FAIL 3a: authenticated must see fixture row in v_dispatch_route_live; count=%',
      v_count;
  end if;

  -- 3b. route_status is correctly derived as ''in_transit'' (has departure_at)
  select route_status into v_status
    from public.v_dispatch_route_live
   where line_id = v_line_id;

  if v_status <> 'in_transit' then
    raise exception
      'FAIL 3b: route_status should be ''in_transit'' for fixture row; got ''%''',
      v_status;
  end if;

  -- 4. v_current_assets dependency — asset_name must be populated through the
  --    LEFT JOIN on v_current_assets (itself security_invoker).  A NULL here
  --    would indicate the security_invoker chain is broken or the join fails.
  select asset_name into v_asset_name
    from public.v_dispatch_route_live
   where line_id = v_line_id;

  if v_asset_name is null then
    raise exception
      'FAIL 4: asset_name must be non-NULL through the v_current_assets JOIN '
      '(security_invoker chain); got NULL';
  end if;

  -- 3c. v_transport_efficiency_summary is readable and counts active routes
  select active_routes into v_active
    from public.v_transport_efficiency_summary;

  if v_active is null or v_active < 1 then
    raise exception
      'FAIL 3c: v_transport_efficiency_summary.active_routes must be >= 1 '
      'after fixture insert; got %',
      v_active;
  end if;

  raise notice
    'PASS 3+4: authenticated reads dispatch views; asset data visible through '
    'security_invoker chain (v_current_assets)';
end;
$$;

reset role;

rollback;
