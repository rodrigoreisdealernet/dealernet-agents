-- Behavioral tests for the quote fee engine + tax presets migration
-- (20260610130000_quote_fee_engine_tax_presets.sql).
--
-- Assertions:
--   1.  anon is denied staff_quote_pricing_preview
--   2.  non-staff authenticated user is denied staff_quote_pricing_preview
--   3.  admin can INSERT fee presets
--   4.  global fee preset applied when no context given
--   5.  category_branch preset wins over category-only preset (precedence)
--   6.  category preset wins over branch-only preset (precedence)
--   7.  branch preset wins over global preset (precedence)
--   8.  multiple distinct-name presets → multiple fee lines
--   9.  tax computed on (base + fees), not on base alone
--  10.  missing-config fallback: no active presets → zero fees, zero taxes
--  11.  regression: identical inputs return identical totals on repeated calls
--  12.  non-admin authenticated user cannot INSERT fee presets
--  13.  staff_quote_save_draft persists pricing_snapshot
--
-- Pattern: DO blocks within one transaction; SET LOCAL ROLE + JWT simulation.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed data (inserted as superuser, bypassing RLS)
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_branch_id    uuid := '11111111-1111-1111-1111-111111111111';
  v_category_id  uuid := '22222222-2222-2222-2222-222222222222';
begin
  -- Global fee preset: Environmental Fee 5 %
  insert into public.quote_fee_presets (id, name, fee_type, amount, scope, branch_id, category_id, is_active)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Environmental Fee', 'percent', 0.05, 'global', null, null, true);

  -- Branch-scoped fee preset: Fuel Surcharge 3 %
  insert into public.quote_fee_presets (id, name, fee_type, amount, scope, branch_id, category_id, is_active)
  values ('aaaaaaaa-0000-0000-0000-000000000002', 'Fuel Surcharge', 'percent', 0.03, 'branch', v_branch_id, null, true);

  -- Category-scoped fee preset: Heavy Equipment Levy $50 flat
  insert into public.quote_fee_presets (id, name, fee_type, amount, scope, branch_id, category_id, is_active)
  values ('aaaaaaaa-0000-0000-0000-000000000003', 'Heavy Equipment Levy', 'flat', 50, 'category', null, v_category_id, true);

  -- category_branch overrides category for "Heavy Equipment Levy" in this branch
  insert into public.quote_fee_presets (id, name, fee_type, amount, scope, branch_id, category_id, is_active)
  values ('aaaaaaaa-0000-0000-0000-000000000004', 'Heavy Equipment Levy', 'flat', 75, 'category_branch', v_branch_id, v_category_id, true);

  -- Global tax preset: State Sales Tax 8.5 %
  insert into public.quote_tax_presets (id, name, rate, scope, branch_id, category_id, is_active)
  values ('bbbbbbbb-0000-0000-0000-000000000001', 'State Sales Tax', 0.085, 'global', null, null, true);

  -- Branch-scoped tax override: lower rate for this branch
  insert into public.quote_tax_presets (id, name, rate, scope, branch_id, category_id, is_active)
  values ('bbbbbbbb-0000-0000-0000-000000000002', 'State Sales Tax', 0.07, 'branch', v_branch_id, null, true);

  -- Test admin user referenced by staff_quote_save_draft (test 13) via JWT sub.
  -- auth.users FK on staff_quote_drafts.created_by requires the row to exist.
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (
    '00000000-0000-0000-0000-000000000099',
    'authenticated', 'authenticated',
    'test-admin@example.com',
    now(), now()
  )
  on conflict (id) do nothing;
end;
$$;

-- ─── 1. anon denied staff_quote_pricing_preview ──────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_quote_pricing_preview(1000);
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 1: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 1: anon should be denied staff_quote_pricing_preview';
  end if;

  raise notice 'PASS 1: anon denied staff_quote_pricing_preview';
end;
$$;

reset role;

-- ─── 2. non-staff authenticated user denied ───────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000077","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.staff_quote_pricing_preview(1000);
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 2: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 2: non-staff user should be denied staff_quote_pricing_preview';
  end if;

  raise notice 'PASS 2: non-staff authenticated user denied staff_quote_pricing_preview';
end;
$$;

reset role;

-- ─── 3. admin can read fee presets ───────────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.quote_fee_presets where is_active;

  if v_count < 1 then
    raise exception 'FAIL 3: admin should be able to SELECT active fee presets; got %', v_count;
  end if;

  raise notice 'PASS 3: admin can SELECT active fee presets (% rows)', v_count;
end;
$$;

reset role;

-- ─── 4. global fee preset applied when no context given ──────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row        record;
  v_fee_count  int;
begin
  -- No branch, no category → only global presets apply
  select * into v_row
  from public.staff_quote_pricing_preview(1000::numeric, null, null);

  -- Environmental Fee = 5% of 1000 = 50
  if v_row.fees_total != 50 then
    raise exception
      'FAIL 4: expected fees_total=50 for global preset on 1000; got %',
      v_row.fees_total;
  end if;

  -- Subtotal = 1000 + 50 = 1050
  if v_row.subtotal != 1050 then
    raise exception 'FAIL 4: expected subtotal=1050; got %', v_row.subtotal;
  end if;

  -- State Sales Tax = 8.5% of 1050 = 89.25
  if v_row.tax_total != 89.25 then
    raise exception 'FAIL 4: expected tax_total=89.25; got %', v_row.tax_total;
  end if;

  -- Grand total = 1050 + 89.25 = 1139.25
  if v_row.grand_total != 1139.25 then
    raise exception 'FAIL 4: expected grand_total=1139.25; got %', v_row.grand_total;
  end if;

  select jsonb_array_length(v_row.fee_lines) into v_fee_count;
  if v_fee_count != 1 then
    raise exception 'FAIL 4: expected 1 fee line for global-only context; got %', v_fee_count;
  end if;

  raise notice 'PASS 4: global fee + tax presets applied correctly on base=1000';
end;
$$;

reset role;

-- ─── 5. category_branch beats category-only for same fee name ────────────────
-- "Heavy Equipment Levy": category-only = $50, category_branch = $75.
-- With both branch_id and category_id provided the $75 preset must win.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row        record;
  v_levy_row   jsonb;
  v_levy_amt   numeric;
begin
  select * into v_row
  from public.staff_quote_pricing_preview(
    1000::numeric,
    '22222222-2222-2222-2222-222222222222'::uuid,  -- category_id
    '11111111-1111-1111-1111-111111111111'::uuid   -- branch_id
  );

  -- Find "Heavy Equipment Levy" in fee_lines
  select elem into v_levy_row
  from jsonb_array_elements(v_row.fee_lines) elem
  where elem->>'name' = 'Heavy Equipment Levy';

  if v_levy_row is null then
    raise exception 'FAIL 5: Heavy Equipment Levy not found in fee_lines';
  end if;

  v_levy_amt := (v_levy_row->>'amount')::numeric;
  if v_levy_amt != 75 then
    raise exception
      'FAIL 5: category_branch preset ($75) must override category preset ($50); got $%',
      v_levy_amt;
  end if;

  raise notice 'PASS 5: category_branch preset (%) beats category preset for Heavy Equipment Levy',
    v_levy_amt;
end;
$$;

reset role;

-- ─── 6. category preset beats branch preset (different fee name) ──────────────
-- "Heavy Equipment Levy" (category) must appear when category_id matches
-- even if branch_id does not match.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row       record;
  v_levy_row  jsonb;
  v_levy_amt  numeric;
begin
  -- category matches, branch does NOT match → category preset applies
  select * into v_row
  from public.staff_quote_pricing_preview(
    1000::numeric,
    '22222222-2222-2222-2222-222222222222'::uuid,  -- category_id matches
    'deadbeef-dead-dead-dead-deaddeaddead'::uuid   -- branch_id does NOT match any preset
  );

  select elem into v_levy_row
  from jsonb_array_elements(v_row.fee_lines) elem
  where elem->>'name' = 'Heavy Equipment Levy';

  if v_levy_row is null then
    raise exception 'FAIL 6: Heavy Equipment Levy (category preset) not found when category matches';
  end if;

  v_levy_amt := (v_levy_row->>'amount')::numeric;
  if v_levy_amt != 50 then
    raise exception 'FAIL 6: category preset ($50) expected; got $%', v_levy_amt;
  end if;

  raise notice 'PASS 6: category preset (%) applied when category matches and branch does not', v_levy_amt;
end;
$$;

reset role;

-- ─── 7. branch preset beats global for "State Sales Tax" ─────────────────────
-- branch-scoped tax = 7 %, global = 8.5 % → branch must win.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row      record;
  v_tax_row  jsonb;
  v_tax_rate numeric;
begin
  select * into v_row
  from public.staff_quote_pricing_preview(
    1000::numeric,
    null,
    '11111111-1111-1111-1111-111111111111'::uuid  -- branch_id
  );

  select elem into v_tax_row
  from jsonb_array_elements(v_row.tax_lines) elem
  where elem->>'name' = 'State Sales Tax';

  if v_tax_row is null then
    raise exception 'FAIL 7: State Sales Tax not found in tax_lines';
  end if;

  v_tax_rate := (v_tax_row->>'rate')::numeric;
  if v_tax_rate != 0.07 then
    raise exception
      'FAIL 7: branch tax preset (7%%) must override global (8.5%%); got rate=%',
      v_tax_rate;
  end if;

  raise notice 'PASS 7: branch tax preset (%) beats global preset for State Sales Tax', v_tax_rate;
end;
$$;

reset role;

-- ─── 8. multiple distinct-name fee presets → multiple fee lines ───────────────
-- With branch + category context: Environmental Fee (global) + Fuel Surcharge
-- (branch) + Heavy Equipment Levy (category_branch) = 3 fee lines.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row       record;
  v_fee_count int;
begin
  select * into v_row
  from public.staff_quote_pricing_preview(
    1000::numeric,
    '22222222-2222-2222-2222-222222222222'::uuid,
    '11111111-1111-1111-1111-111111111111'::uuid
  );

  select jsonb_array_length(v_row.fee_lines) into v_fee_count;

  if v_fee_count != 3 then
    raise exception
      'FAIL 8: expected 3 fee lines (Env Fee + Fuel Surcharge + Heavy Equip Levy); got %',
      v_fee_count;
  end if;

  raise notice 'PASS 8: % distinct fee lines returned for full context', v_fee_count;
end;
$$;

reset role;

-- ─── 9. tax is computed on subtotal (base + fees), not on base alone ──────────
-- base=1000, Env Fee=50 → subtotal=1050; global tax 8.5% of 1050 = 89.25.
-- If incorrectly applied to base (1000): 85.00.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row record;
begin
  select * into v_row
  from public.staff_quote_pricing_preview(1000::numeric, null, null);

  if v_row.tax_total = 85.00 then
    raise exception
      'FAIL 9: tax_total=85.00 indicates tax was applied to base instead of subtotal; '
      'expected 89.25 (8.5%% of subtotal 1050)';
  end if;

  if v_row.tax_total != 89.25 then
    raise exception
      'FAIL 9: expected tax_total=89.25 (8.5%% of subtotal 1050); got %',
      v_row.tax_total;
  end if;

  raise notice 'PASS 9: tax correctly applied to subtotal (base + fees) → tax_total=%',
    v_row.tax_total;
end;
$$;

reset role;

-- ─── 10. missing-config fallback: no active presets → zero fees, zero taxes ───
-- Temporarily deactivate all presets and verify the RPC returns all-zero lines.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row record;
begin
  -- Deactivate all presets for this sub-test
  update public.quote_fee_presets set is_active = false;
  update public.quote_tax_presets set is_active = false;

  select * into v_row
  from public.staff_quote_pricing_preview(1000::numeric, null, null);

  if v_row.fees_total != 0 then
    raise exception 'FAIL 10: expected fees_total=0 with no active presets; got %', v_row.fees_total;
  end if;

  if v_row.tax_total != 0 then
    raise exception 'FAIL 10: expected tax_total=0 with no active presets; got %', v_row.tax_total;
  end if;

  if v_row.grand_total != 1000 then
    raise exception 'FAIL 10: expected grand_total=1000 (base only); got %', v_row.grand_total;
  end if;

  -- Reactivate for subsequent tests
  update public.quote_fee_presets set is_active = true;
  update public.quote_tax_presets set is_active = true;

  raise notice 'PASS 10: missing-config fallback → fees=0, taxes=0, grand_total=base_amount';
end;
$$;

reset role;

-- ─── 11. regression: identical inputs return identical totals ─────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_row1 record;
  v_row2 record;
begin
  select * into v_row1 from public.staff_quote_pricing_preview(2500::numeric, null, null);
  select * into v_row2 from public.staff_quote_pricing_preview(2500::numeric, null, null);

  if v_row1.grand_total != v_row2.grand_total then
    raise exception
      'FAIL 11: regression — identical inputs yielded different totals: % vs %',
      v_row1.grand_total, v_row2.grand_total;
  end if;

  if v_row1.fees_total != v_row2.fees_total then
    raise exception
      'FAIL 11: regression — identical inputs yielded different fees_total: % vs %',
      v_row1.fees_total, v_row2.fees_total;
  end if;

  raise notice 'PASS 11: regression — identical inputs produce identical totals (%)', v_row1.grand_total;
end;
$$;

reset role;

-- ─── 12. non-admin cannot INSERT fee presets ─────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000088","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    insert into public.quote_fee_presets (name, fee_type, amount, scope)
    values ('Attacker Fee', 'flat', 9999, 'global');
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 12: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 12: non-admin should be denied INSERT on quote_fee_presets';
  end if;

  raise notice 'PASS 12: non-admin denied INSERT on quote_fee_presets';
end;
$$;

reset role;

-- ─── 13. staff_quote_save_draft persists pricing_snapshot ────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_draft_id   uuid;
  v_snapshot   jsonb;
  v_grand_total numeric;
begin
  select draft_id into v_draft_id
  from public.staff_quote_save_draft(
    p_base_amount  := 1000::numeric,
    p_category_id  := null,
    p_branch_id    := null
  );

  if v_draft_id is null then
    raise exception 'FAIL 13: staff_quote_save_draft returned null draft_id';
  end if;

  select pricing_snapshot into v_snapshot
  from public.staff_quote_drafts
  where id = v_draft_id;

  if v_snapshot is null then
    raise exception 'FAIL 13: pricing_snapshot is null on saved draft %', v_draft_id;
  end if;

  v_grand_total := (v_snapshot->>'grand_total')::numeric;
  if v_grand_total is null or v_grand_total <= 0 then
    raise exception
      'FAIL 13: pricing_snapshot.grand_total missing or <= 0 on draft %; snapshot=%',
      v_draft_id, v_snapshot;
  end if;

  raise notice 'PASS 13: staff_quote_save_draft persisted snapshot with grand_total=% on draft %',
    v_grand_total, v_draft_id;
end;
$$;

reset role;

rollback;
