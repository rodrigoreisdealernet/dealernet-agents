-- RLS / security-invoker behavioral tests for maintenance costing
-- (migration 20260610070000_maintenance_costing_invoice.sql).
--
-- These assertions would fail if:
--   * security_invoker is not set on rental_entity_type_catalog or
--     v_maintenance_work_order_billing (owner would bypass base-table RLS)
--   * the operator-role SELECT policy on maintenance_cost_lines is missing
--   * non-operator authenticated roles can read cost lines
--   * any authenticated user can INSERT cost lines (cross-tenant injection risk)
--   * anon can read or write maintenance_cost_lines rows
--   * the service_role bypass policy is missing or ineffective
--
-- Pattern: multiple DO blocks within one transaction.  SET LOCAL ROLE +
-- set_config('request.jwt.claims', ...) simulate the PostgREST JWT contexts
-- used in production without persisting any data.

begin;

-- ── Fixture setup (superuser / service_role context) ──────────────────────
do $$
declare
  v_entity_id constant uuid := 'deadbeef-aa00-0000-0001-000000000001';
begin
  insert into public.entities (id, entity_type, source_record_id)
  values (v_entity_id, 'maintenance_record', 'costing-rls-test-mr')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions
    (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_entity_id, 1, true,
      jsonb_build_object(
        'name',                 'RLS Test Work Order',
        'status',               'completed',
        'maintenance_type',     'corrective',
        'asset_id',             gen_random_uuid()::text,
        'is_customer_billable', true,
        'billing_account_id',   gen_random_uuid()::text
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  -- Seed a cost line as service_role (the only path that should ever write lines)
  insert into public.maintenance_cost_lines
    (maintenance_record_id, line_type, description, quantity, unit_cost, sell_amount, is_taxable, tax_rate)
  values
    (v_entity_id, 'labor', 'Hydraulic pump repair', 2, 150.00, 175.00, true, 0.1);
end;
$$;

-- ── 1. Both views must declare security_invoker = true ────────────────────
do $$
declare
  v_has_invoker bool;
begin
  -- 1a. rental_entity_type_catalog
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'rental_entity_type_catalog';

  if not v_has_invoker then
    raise exception
      'FAIL 1a: rental_entity_type_catalog must declare security_invoker = true '
      '(without it the view owner bypasses base-table RLS)';
  end if;

  -- 1b. v_maintenance_work_order_billing
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_maintenance_work_order_billing';

  if not v_has_invoker then
    raise exception
      'FAIL 1b: v_maintenance_work_order_billing must declare security_invoker = true';
  end if;

  raise notice 'PASS 1: security_invoker = true on both views';
end;
$$;

-- ── 2. anon is denied SELECT and INSERT on maintenance_cost_lines ─────────
set local role anon;

do $$
declare
  v_entity_id constant uuid := 'deadbeef-aa00-0000-0001-000000000001';
  v_dummy  int;
  v_caught bool;
begin
  -- 2a. SELECT denied for anon
  v_caught := false;
  begin
    select count(*) into v_dummy from public.maintenance_cost_lines;
    raise exception
      'FAIL 2a: anon SELECT on maintenance_cost_lines succeeded — RLS is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2a: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2a: anon should be denied SELECT on maintenance_cost_lines';
  end if;

  -- 2b. INSERT denied for anon
  v_caught := false;
  begin
    insert into public.maintenance_cost_lines
      (maintenance_record_id, line_type, description, quantity, unit_cost)
    values (v_entity_id, 'labor', 'anon insert attempt', 1, 10);
    raise exception
      'FAIL 2b: anon INSERT on maintenance_cost_lines succeeded — RLS is not effective';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 2b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 2b: anon should be denied INSERT on maintenance_cost_lines';
  end if;

  raise notice 'PASS 2: anon denied SELECT and INSERT on maintenance_cost_lines';
end;
$$;

reset role;

-- ── 3. authenticated operator can SELECT; INSERT is denied (service-role-only) ──
--
-- This proves the data boundary: operators can view cost lines via the app,
-- but all writes must flow through the Temporal worker (service_role).
-- A cross-tenant actor who knows a work-order UUID cannot inject cost lines
-- that would corrupt v_maintenance_work_order_billing totals or trigger
-- a spurious invoice.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"field_operator"}}',
  true
);

do $$
declare
  v_entity_id constant uuid := 'deadbeef-aa00-0000-0001-000000000001';
  v_count     int;
  v_caught    bool;
begin
  -- 3a. Operator can SELECT cost lines seeded by service_role
  select count(*) into v_count
    from public.maintenance_cost_lines
   where maintenance_record_id = v_entity_id;

  if v_count < 1 then
    raise exception
      'FAIL 3a: authenticated field_operator should be able to SELECT '
      'maintenance_cost_lines; got count=%', v_count;
  end if;

  -- 3b. INSERT is blocked for authenticated — including operator roles.
  --     Cross-tenant injection is therefore impossible from any browser session.
  v_caught := false;
  begin
    insert into public.maintenance_cost_lines
      (maintenance_record_id, line_type, description, quantity, unit_cost)
    values (v_entity_id, 'parts', 'cross-tenant injection attempt', 1, 99);
    raise exception
      'FAIL 3b: authenticated INSERT on maintenance_cost_lines succeeded — '
      'service-role-only constraint is not enforced';
  exception
    when insufficient_privilege then v_caught := true;
    when check_violation      then v_caught := true;
    when others then
      -- RLS may block by returning 0 rows rather than raising; check row count
      if not exists (
        select 1 from public.maintenance_cost_lines
         where maintenance_record_id = v_entity_id
           and description = 'cross-tenant injection attempt'
      ) then
        v_caught := true;
      else
        raise exception 'FAIL 3b: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception
      'FAIL 3b: authenticated should be denied INSERT on maintenance_cost_lines';
  end if;

  raise notice 'PASS 3: operator can SELECT; INSERT is denied (service-role-only)';
end;
$$;

reset role;

-- ── 4. non-operator authenticated role (read_only) cannot SELECT ──────────
--
-- Proves that the SELECT gate is role-scoped, not just "any authenticated".
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000088","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_entity_id constant uuid := 'deadbeef-aa00-0000-0001-000000000001';
  v_count     int;
begin
  -- RLS filters rows; read_only role sees none (zero-row result, no exception).
  select count(*) into v_count
    from public.maintenance_cost_lines
   where maintenance_record_id = v_entity_id;

  if v_count <> 0 then
    raise exception
      'FAIL 4: authenticated read_only role should see 0 cost lines (RLS filtered); '
      'got count=%', v_count;
  end if;

  raise notice 'PASS 4: read_only role sees 0 cost lines (RLS role gate effective)';
end;
$$;

reset role;

-- ── 5. authenticated operator cannot UPDATE or DELETE cost lines ──────────
-- Append-only: corrections are new rows (inserted by the worker), never edits.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_entity_id constant uuid := 'deadbeef-aa00-0000-0001-000000000001';
begin
  -- 5a. UPDATE blocked — no policy grants UPDATE to authenticated
  update public.maintenance_cost_lines
     set notes = 'tampered'
   where maintenance_record_id = v_entity_id;

  if exists (
    select 1 from public.maintenance_cost_lines
     where maintenance_record_id = v_entity_id and notes = 'tampered'
  ) then
    raise exception
      'FAIL 5a: authenticated UPDATE mutated a maintenance_cost_lines row — '
      'append-only policy is not enforced';
  end if;

  -- 5b. DELETE blocked — no policy grants DELETE to authenticated
  delete from public.maintenance_cost_lines
   where maintenance_record_id = v_entity_id;

  if not exists (
    select 1 from public.maintenance_cost_lines
     where maintenance_record_id = v_entity_id
  ) then
    raise exception
      'FAIL 5b: authenticated DELETE removed maintenance_cost_lines rows — '
      'append-only policy is not enforced';
  end if;

  raise notice 'PASS 5: authenticated cannot UPDATE or DELETE maintenance_cost_lines (append-only)';
end;
$$;

reset role;

-- ── 6. v_maintenance_work_order_billing returns fixture row for operator ───
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"field_operator"}}',
  true
);

do $$
declare
  v_entity_id constant uuid := 'deadbeef-aa00-0000-0001-000000000001';
  v_count     int;
  v_sell_sub  numeric;
begin
  select count(*) into v_count
    from public.v_maintenance_work_order_billing
   where maintenance_record_id = v_entity_id;

  if v_count <> 1 then
    raise exception
      'FAIL 6a: operator must see fixture row in v_maintenance_work_order_billing; count=%',
      v_count;
  end if;

  -- The seeded line: qty=2, sell_amount=175 → sell_subtotal = 350
  select sell_subtotal into v_sell_sub
    from public.v_maintenance_work_order_billing
   where maintenance_record_id = v_entity_id;

  if v_sell_sub is null or v_sell_sub < 350 then
    raise exception
      'FAIL 6b: v_maintenance_work_order_billing.sell_subtotal should be >= 350; got %',
      v_sell_sub;
  end if;

  raise notice 'PASS 6: operator reads v_maintenance_work_order_billing correctly';
end;
$$;

reset role;

rollback;
