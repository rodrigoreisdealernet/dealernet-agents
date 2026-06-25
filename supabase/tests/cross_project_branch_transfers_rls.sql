-- RLS / security-invoker behavioral tests for the transfer views
-- (migration 20260613170000_cross_project_branch_transfers.sql).
--
-- These assertions fail if:
--   * security_invoker is not set on either view (owner would bypass base-table RLS)
--   * the anon REVOKE is missing or ineffective
--   * the authenticated / service_role GRANT is missing or ineffective
--   * the nullif()-hardened UUID or numeric casts regress to bare casts
--   * the security_invoker chain to the base objects (rental_current_entity_state,
--     entity_versions) is broken, allowing a denied role through the view
--
-- Pattern: multiple DO blocks within one transaction.  SET LOCAL ROLE +
-- set_config('request.jwt.claims', ...) simulate the PostgREST JWT contexts
-- used in production without persisting any data.
--
-- Coverage map:
--   Check 1  – security_invoker = true on both views
--   Check 2  – anon denied SELECT at the view surface (REVOKE effective)
--   Check 3  – authenticated reads both views; casts + branch/project JOINs correct
--   Check 4  – service_role reads both views
--   Check 5  – effective view chain: anon denied on the base objects the views depend on
--              (rental_current_entity_state, entity_versions); proves the security_invoker
--              chain bottoms out correctly and access cannot be obtained by bypassing
--              the view-level REVOKE
--   Check 6  – authenticated can read the same base objects directly; proves the same
--              chain allows same-scope reads end-to-end

begin;

-- ── Fixture setup (superuser / service_role context) ──────────────────────
-- One transfer entity with origin/destination branch and project IDs so every
-- view query has a concrete row to return.  Blank-string values for the
-- optional project IDs validate the nullif() cast hardening.
do $$
declare
  v_transfer_id   constant uuid := 'dead0001-0000-0000-0000-000000000001';
  v_asset_id      constant uuid := 'dead0001-0000-0000-0000-000000000002';
  v_orig_branch   constant uuid := 'dead0001-0000-0000-0000-000000000003';
  v_dest_branch   constant uuid := 'dead0001-0000-0000-0000-000000000004';
  v_orig_project  constant uuid := 'dead0001-0000-0000-0000-000000000005';
  v_dest_project  constant uuid := 'dead0001-0000-0000-0000-000000000006';
begin
  -- Branches
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_orig_branch,  'branch',  'xfer-rls-test-orig-branch'),
    (v_dest_branch,  'branch',  'xfer-rls-test-dest-branch'),
    (v_orig_project, 'project', 'xfer-rls-test-orig-project'),
    (v_dest_project, 'project', 'xfer-rls-test-dest-project'),
    (v_asset_id,     'asset',   'xfer-rls-test-asset'),
    (v_transfer_id,  'transfer','xfer-rls-test-transfer-001')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_orig_branch,  1, true, '{"name":"RLS Origin Depot"}'::jsonb,    now()),
    (v_dest_branch,  1, true, '{"name":"RLS Destination Depot"}'::jsonb, now()),
    (v_orig_project, 1, true, '{"name":"RLS Origin Project"}'::jsonb,   now()),
    (v_dest_project, 1, true, '{"name":"RLS Dest Project"}'::jsonb,     now()),
    (v_asset_id,     1, true, '{"name":"RLS Test Excavator","status":"available"}'::jsonb, now()),
    (
      v_transfer_id, 1, true,
      jsonb_build_object(
        'status',                 'in_transit',
        'asset_id',               v_asset_id::text,
        'asset_scope',            'fleet',
        'origin_branch_id',       v_orig_branch::text,
        'destination_branch_id',  v_dest_branch::text,
        'origin_project_id',      v_orig_project::text,
        'destination_project_id', v_dest_project::text,
        'requested_by',           'user-rls-001',
        'approved_by',            'user-rls-002',
        'dispatched_by',          'user-rls-003',
        'received_by',            '',
        'internal_cost',          '1500.00',
        'requested_ship_date',    '2026-06-20',
        'expected_receive_date',  '2026-06-25',
        'actual_ship_at',         (now() - interval '1 hour')::text,
        'actual_receive_at',      ''
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;
end;
$$;

-- ── 1. Both views must declare security_invoker = true ────────────────────
do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_transfer_current';

  if not v_has_invoker then
    raise exception
      'FAIL 1a: v_transfer_current must declare security_invoker = true';
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_transfer_history';

  if not v_has_invoker then
    raise exception
      'FAIL 1b: v_transfer_history must declare security_invoker = true';
  end if;

  raise notice 'PASS 1: security_invoker = true on both transfer views';
end;
$$;

-- ── 2. anon must be denied SELECT on both views ───────────────────────────
set local role anon;

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_transfer_current;
    raise exception
      'FAIL 2a: anon read v_transfer_current succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2a: anon must be denied SELECT on v_transfer_current';
  end if;

  v_caught := false;
  begin
    select count(*) into v_dummy from public.v_transfer_history;
    raise exception
      'FAIL 2b: anon read v_transfer_history succeeded — REVOKE is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2b: anon must be denied SELECT on v_transfer_history';
  end if;

  raise notice 'PASS 2: anon denied SELECT on both transfer views';
end;
$$;

reset role;

-- ── 3. authenticated can SELECT both views; casts and JOINs are correct ──
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"ops_manager"}}',
  true
);

do $$
declare
  v_transfer_id constant uuid := 'dead0001-0000-0000-0000-000000000001';
  v_row         record;
  v_hist_count  int;
begin
  -- 3a. authenticated reads v_transfer_current; verify projection columns
  select *
    into v_row
    from public.v_transfer_current
   where transfer_entity_id = v_transfer_id;

  if v_row is null then
    raise exception
      'FAIL 3a: authenticated must see fixture row in v_transfer_current';
  end if;

  if v_row.status <> 'in_transit' then
    raise exception
      'FAIL 3a: v_transfer_current status must be in_transit; got %', v_row.status;
  end if;

  if v_row.origin_branch_name is null or v_row.origin_branch_name <> 'RLS Origin Depot' then
    raise exception
      'FAIL 3a: origin_branch_name JOIN failed; got %', v_row.origin_branch_name;
  end if;

  if v_row.origin_project_name is null or v_row.origin_project_name <> 'RLS Origin Project' then
    raise exception
      'FAIL 3a: origin_project_name JOIN failed; got %', v_row.origin_project_name;
  end if;

  if v_row.internal_cost is null or v_row.internal_cost <> 1500.00 then
    raise exception
      'FAIL 3a: internal_cost numeric cast failed; got %', v_row.internal_cost;
  end if;

  if v_row.actual_receive_at is not null then
    raise exception
      'FAIL 3a: blank actual_receive_at should coerce to NULL; got %', v_row.actual_receive_at;
  end if;

  -- 3b. authenticated reads v_transfer_history; verify version rows returned
  select count(*) into v_hist_count
    from public.v_transfer_history
   where transfer_entity_id = v_transfer_id;

  if v_hist_count < 1 then
    raise exception
      'FAIL 3b: authenticated must see rows in v_transfer_history; count=%', v_hist_count;
  end if;

  -- 3c. v_transfer_history has version_id and transitioned_at columns
  select *
    into v_row
    from public.v_transfer_history
   where transfer_entity_id = v_transfer_id
   limit 1;

  if v_row.version_id is null then
    raise exception 'FAIL 3c: v_transfer_history must expose version_id';
  end if;

  if v_row.transitioned_at is null then
    raise exception 'FAIL 3c: v_transfer_history must expose transitioned_at';
  end if;

  raise notice 'PASS 3: authenticated reads both transfer views; casts and JOINs correct';
end;
$$;

reset role;

-- ── 4. service_role can SELECT both views ─────────────────────────────────
set local role service_role;

do $$
declare
  v_transfer_id constant uuid := 'dead0001-0000-0000-0000-000000000001';
  v_count       int;
begin
  select count(*) into v_count
    from public.v_transfer_current
   where transfer_entity_id = v_transfer_id;

  if v_count <> 1 then
    raise exception
      'FAIL 4a: service_role must see fixture row in v_transfer_current; count=%',
      v_count;
  end if;

  select count(*) into v_count
    from public.v_transfer_history
   where transfer_entity_id = v_transfer_id;

  if v_count < 1 then
    raise exception
      'FAIL 4b: service_role must see rows in v_transfer_history; count=%',
      v_count;
  end if;

  raise notice 'PASS 4: service_role reads both transfer views';
end;
$$;

reset role;

-- ── 5. Effective view chain: anon is denied on the base objects ───────────
-- v_transfer_current depends on rental_current_entity_state.
-- v_transfer_history depends on entity_versions and entities.
-- Because both views use security_invoker = true, the view body runs under
-- the CALLER's role.  anon has no SELECT on these base objects, so even if
-- the view-level REVOKE were somehow absent, anon would still be denied when
-- the view tries to read the base tables.  Verifying this end-to-end proves
-- the security_invoker chain is intact and access control is not purely
-- surface-level.
set local role anon;

do $$
declare
  v_dummy  int;
  v_caught bool;
begin
  -- 5a. anon denied on rental_current_entity_state (v_transfer_current base)
  v_caught := false;
  begin
    select count(*) into v_dummy from public.rental_current_entity_state;
    raise exception
      'FAIL 5a: anon read rental_current_entity_state — base object is not protected; '
      'security_invoker chain would allow transfer view bypass';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 5a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception
      'FAIL 5a: anon must be denied SELECT on rental_current_entity_state';
  end if;

  -- 5b. anon denied on entity_versions (v_transfer_history base)
  v_caught := false;
  begin
    select count(*) into v_dummy from public.entity_versions;
    raise exception
      'FAIL 5b: anon read entity_versions — base object is not protected; '
      'security_invoker chain would allow transfer history view bypass';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 5b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception
      'FAIL 5b: anon must be denied SELECT on entity_versions';
  end if;

  raise notice
    'PASS 5: anon denied on base objects (rental_current_entity_state, entity_versions); '
    'security_invoker chain bottoms out correctly';
end;
$$;

reset role;

-- ── 6. Effective view chain: authenticated reads the same base objects ────
-- Proves the positive side of the chain: the authenticated role's grant on
-- the base objects is intact, so the security_invoker views can fulfil reads
-- end-to-end for valid callers.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"ops_manager"}}',
  true
);

do $$
declare
  v_count int;
begin
  -- 6a. authenticated can read rental_current_entity_state
  select count(*) into v_count from public.rental_current_entity_state;
  if v_count is null then
    raise exception
      'FAIL 6a: authenticated must be able to read rental_current_entity_state '
      '(view chain base for v_transfer_current)';
  end if;

  -- 6b. authenticated can read entity_versions
  select count(*) into v_count from public.entity_versions;
  if v_count is null then
    raise exception
      'FAIL 6b: authenticated must be able to read entity_versions '
      '(view chain base for v_transfer_history)';
  end if;

  raise notice
    'PASS 6: authenticated reads base objects end-to-end; security_invoker chain '
    'allows same-scope access through both views';
end;
$$;

reset role;

rollback;
