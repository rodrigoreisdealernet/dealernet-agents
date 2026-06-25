-- Behavioral authorization tests for staff_save_quote_order RPC
-- (20260611000000_quote_builder_order_rpc.sql).
--
-- Assertions:
--   0.  RPC exists in public schema
--   0b. Grant check: authenticated has EXECUTE; anon/public do not
--   1.  anon role is denied execute
--   2.  authenticated with no app-role claim is denied (42501)
--   3.  authenticated with read_only app-role is denied (42501)
--   4.  authenticated with field_operator app-role is denied (42501)
--   5.  authenticated with admin app-role can create a new draft order with lines
--   6.  admin save persists rental_order entity + rental_order_line entities
--   7.  authenticated with branch_manager app-role can create a draft order
--   8.  re-save (update) path: existing order_id is accepted; order_number preserved
--   9.  soft-cancel: lines in p_cancel_line_ids become status='cancelled';
--      unselected lines from the same order are NOT affected
--  10.  stale cancel ID (non-existent UUID) does not abort the save
--  10b. cancel-type guard: passing a rental_order UUID (wrong entity type)
--      in p_cancel_line_ids does not change the order's status

begin;

-- ── 0. Structural: RPC exists ────────────────────────────────────────────────

do $$
declare
  v_count int;
begin
  select count(*)
    into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'staff_save_quote_order';

  if v_count < 1 then
    raise exception 'staff_save_quote_order RPC not found in public schema';
  end if;

  raise notice 'PASS 0: staff_save_quote_order RPC exists';
end;
$$;

-- ── 0b. Grant check ───────────────────────────────────────────────────────────

do $$
begin
  if not has_function_privilege(
    'authenticated',
    'public.staff_save_quote_order(uuid,text,text,text,date,text,text,text,jsonb,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Expected authenticated EXECUTE grant on staff_save_quote_order';
  end if;

  if has_function_privilege(
    'anon',
    'public.staff_save_quote_order(uuid,text,text,text,date,text,text,text,jsonb,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'anon should NOT have EXECUTE on staff_save_quote_order';
  end if;

  raise notice 'PASS 0b: grant checks passed (authenticated=allowed, anon=denied)';
end;
$$;

-- ── 1. anon role denied at execute ───────────────────────────────────────────

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_save_quote_order();
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' or sqlerrm ilike '%permission denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 1: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 1: anon should be denied staff_save_quote_order';
  end if;

  raise notice 'PASS 1: anon denied staff_save_quote_order';
end;
$$;

reset role;

-- ── 2. authenticated with no app-role claim is denied ────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001"}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_save_quote_order();
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 2: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 2: authenticated with no app-role should be denied staff_save_quote_order';
  end if;

  raise notice 'PASS 2: authenticated (no app-role) denied staff_save_quote_order';
end;
$$;

reset role;

-- ── 3. read_only app-role is denied ──────────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_save_quote_order();
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 3: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 3: read_only role should be denied staff_save_quote_order';
  end if;

  raise notice 'PASS 3: read_only denied staff_save_quote_order';
end;
$$;

reset role;

-- ── 4. field_operator app-role is denied ─────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"role":"field_operator"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_save_quote_order();
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 4: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 4: field_operator role should be denied staff_save_quote_order';
  end if;

  raise notice 'PASS 4: field_operator denied staff_save_quote_order';
end;
$$;

reset role;

-- ── 5-6. admin creates draft order; rental_order + rental_order_line persisted ─

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_order_id     uuid;
  v_order_number text;
  v_saved_lines  jsonb;
  v_order_status text;
  v_line_count   int;
begin
  select r.order_id, r.order_number, r.saved_lines
    into v_order_id, v_order_number, v_saved_lines
  from public.staff_save_quote_order(
    p_order_id           => null,
    p_expiration_date    => current_date + 30,
    p_display_rate_mode  => 'rate',
    p_internal_notes     => 'admin test internal note',
    p_external_notes     => 'admin test external note',
    p_lines              => '[
      {"line_id":null,"category_id":"cccccccc-0000-0000-0000-000000000001","asset_id":null,"branch_id":null,"start_date":"2026-07-01","end_date":"2026-07-10","quantity":2,"daily_rate":150.00,"rate_type":"daily","name":"Excavator"},
      {"line_id":null,"category_id":"cccccccc-0000-0000-0000-000000000002","asset_id":null,"branch_id":null,"start_date":"2026-07-01","end_date":"2026-07-10","quantity":1,"daily_rate":80.00,"rate_type":"daily","name":"Compactor"}
    ]'::jsonb,
    p_cancel_line_ids    => '[]'::jsonb
  ) as r;

  if v_order_id is null then
    raise exception 'FAIL 5: admin save returned null order_id';
  end if;
  if v_order_number not like 'Q-%' then
    raise exception 'FAIL 5: expected order_number like Q-*, got %', v_order_number;
  end if;
  if jsonb_array_length(v_saved_lines) <> 2 then
    raise exception 'FAIL 5: expected 2 saved_lines, got %', jsonb_array_length(v_saved_lines);
  end if;

  raise notice 'PASS 5: admin staff_save_quote_order returned order_id=% order_number=%', v_order_id, v_order_number;

  -- Verify rental_order entity persisted with status='draft'.
  select ev.data->>'status'
    into v_order_status
  from entities e
  join entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = v_order_id
    and e.entity_type = 'rental_order';

  if not found or v_order_status <> 'draft' then
    raise exception 'FAIL 6: expected rental_order entity status=draft, got %',
      coalesce(v_order_status, '<not found>');
  end if;

  -- Verify two rental_order_line entities persisted with order_id and status='draft'.
  select count(*)
    into v_line_count
  from entities e
  join entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.entity_type = 'rental_order_line'
    and ev.data->>'order_id' = v_order_id::text
    and ev.data->>'status' = 'draft';

  if v_line_count <> 2 then
    raise exception 'FAIL 6: expected 2 rental_order_line entities for the order, found %', v_line_count;
  end if;

  raise notice 'PASS 6: rental_order + 2 rental_order_line entities persisted correctly';
end;
$$;

reset role;

-- ── 7. branch_manager can create a draft order ───────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000003","app_metadata":{"role":"branch_manager"}}',
  true
);

do $$
declare
  v_order_id    uuid;
  v_saved_lines jsonb;
begin
  select r.order_id, r.saved_lines
    into v_order_id, v_saved_lines
  from public.staff_save_quote_order(
    p_lines => '[
      {"line_id":null,"category_id":"cccccccc-0000-0000-0000-000000000001","asset_id":null,"branch_id":null,"start_date":"2026-08-01","end_date":"2026-08-05","quantity":1,"daily_rate":200.00,"rate_type":"daily","name":"Crane"}
    ]'::jsonb
  ) as r;

  if v_order_id is null then
    raise exception 'FAIL 7: branch_manager save returned null order_id';
  end if;
  if jsonb_array_length(v_saved_lines) <> 1 then
    raise exception 'FAIL 7: expected 1 saved_line, got %', jsonb_array_length(v_saved_lines);
  end if;

  raise notice 'PASS 7: branch_manager staff_save_quote_order succeeded, order_id=%', v_order_id;
end;
$$;

reset role;

-- ── 8. Re-save (update) preserves order_number ───────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_order_id_1     uuid;
  v_order_number_1 text;
  v_order_id_2     uuid;
  v_order_number_2 text;
begin
  -- First save: create a new order.
  select r.order_id, r.order_number
    into v_order_id_1, v_order_number_1
  from public.staff_save_quote_order(
    p_internal_notes => 'update test – first save'
  ) as r;

  -- Second save: pass the returned order_id to update the same order.
  select r.order_id, r.order_number
    into v_order_id_2, v_order_number_2
  from public.staff_save_quote_order(
    p_order_id       => v_order_id_1,
    p_internal_notes => 'update test – second save'
  ) as r;

  if v_order_id_1 <> v_order_id_2 then
    raise exception 'FAIL 8: re-save returned different order_id (% vs %)', v_order_id_1, v_order_id_2;
  end if;
  if v_order_number_1 <> v_order_number_2 then
    raise exception 'FAIL 8: re-save changed order_number (% → %)', v_order_number_1, v_order_number_2;
  end if;

  raise notice 'PASS 8: re-save preserved order_id=% and order_number=%', v_order_id_1, v_order_number_1;
end;
$$;

reset role;

-- ── 9. Soft-cancel: targeted line becomes 'cancelled'; untouched line stays 'draft' ─

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_order_id    uuid;
  v_saved_lines jsonb;
  v_line_id_a   uuid;
  v_line_id_b   uuid;
  v_status_a    text;
  v_status_b    text;
begin
  -- Create an order with two lines.
  select r.order_id, r.saved_lines
    into v_order_id, v_saved_lines
  from public.staff_save_quote_order(
    p_lines => '[
      {"line_id":null,"category_id":"cccccccc-0000-0000-0000-000000000001","asset_id":null,"branch_id":null,"start_date":"2026-09-01","end_date":"2026-09-03","quantity":1,"daily_rate":100.00,"rate_type":"daily","name":"Line A"},
      {"line_id":null,"category_id":"cccccccc-0000-0000-0000-000000000002","asset_id":null,"branch_id":null,"start_date":"2026-09-01","end_date":"2026-09-03","quantity":1,"daily_rate":120.00,"rate_type":"daily","name":"Line B"}
    ]'::jsonb
  ) as r;

  v_line_id_a := (v_saved_lines->0->>'line_id')::uuid;
  v_line_id_b := (v_saved_lines->1->>'line_id')::uuid;

  -- Re-save: cancel only line A.
  perform public.staff_save_quote_order(
    p_order_id        => v_order_id,
    p_lines           => '[]'::jsonb,
    p_cancel_line_ids => jsonb_build_array(v_line_id_a::text)
  );

  -- Line A must now have status='cancelled'.
  select ev.data->>'status'
    into v_status_a
  from entities e
  join entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = v_line_id_a
    and e.entity_type = 'rental_order_line';

  if v_status_a <> 'cancelled' then
    raise exception 'FAIL 9: expected line A status=cancelled, got %',
      coalesce(v_status_a, '<not found>');
  end if;

  -- Line B must still be 'draft' (not touched by the cancel).
  select ev.data->>'status'
    into v_status_b
  from entities e
  join entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = v_line_id_b
    and e.entity_type = 'rental_order_line';

  if v_status_b <> 'draft' then
    raise exception 'FAIL 9: expected line B status=draft (untouched), got %',
      coalesce(v_status_b, '<not found>');
  end if;

  raise notice 'PASS 9: line A cancelled; line B unchanged (draft)';
end;
$$;

reset role;

-- ── 10. Stale cancel ID does not abort the save ───────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_order_id    uuid;
  v_stale_id    uuid := gen_random_uuid();
  v_saved_lines jsonb;
begin
  select r.order_id, r.saved_lines
    into v_order_id, v_saved_lines
  from public.staff_save_quote_order(
    p_lines => '[
      {"line_id":null,"category_id":"cccccccc-0000-0000-0000-000000000001","asset_id":null,"branch_id":null,"start_date":"2026-10-01","end_date":"2026-10-02","quantity":1,"daily_rate":50.00,"rate_type":"daily","name":"Stale test"}
    ]'::jsonb,
    p_cancel_line_ids => jsonb_build_array(v_stale_id::text)
  ) as r;

  if v_order_id is null then
    raise exception 'FAIL 10: stale cancel ID caused save to return null order_id';
  end if;
  if jsonb_array_length(v_saved_lines) <> 1 then
    raise exception 'FAIL 10: expected 1 saved_line after stale-cancel-id save, got %',
      jsonb_array_length(v_saved_lines);
  end if;

  raise notice 'PASS 10: stale cancel ID silently ignored; save completed successfully';
end;
$$;

reset role;

-- ── 10b. Cancel-type guard: passing a rental_order UUID does not affect the order ─
-- The cancel loop only matches entities with entity_type = 'rental_order_line'.
-- Passing a rental_order entity UUID in p_cancel_line_ids must not change the
-- order's status — confirming that unrelated entity types cannot be silently updated.

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_order_id    uuid;
  v_saved_lines jsonb;
  v_status_after text;
begin
  -- Create an order to use its UUID as the "wrong type" cancel target.
  select r.order_id, r.saved_lines
    into v_order_id, v_saved_lines
  from public.staff_save_quote_order(
    p_internal_notes => 'cancel-type guard seed'
  ) as r;

  -- Now call the RPC again passing the rental_order UUID as a cancel line ID.
  perform public.staff_save_quote_order(
    p_cancel_line_ids => jsonb_build_array(v_order_id::text)
  );

  -- The original order entity must still have status='draft' — it was not
  -- touched by the cancel path because its entity_type is 'rental_order', not
  -- 'rental_order_line'.
  select ev.data->>'status'
    into v_status_after
  from entities e
  join entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = v_order_id
    and e.entity_type = 'rental_order';

  if v_status_after <> 'draft' then
    raise exception
      'FAIL 10b: expected rental_order to remain draft after wrong-type cancel; got %',
      coalesce(v_status_after, '<not found>');
  end if;

  raise notice 'PASS 10b: rental_order UUID in p_cancel_line_ids did not alter order status';
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

rollback;
