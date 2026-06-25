-- Behavioral checks for 20260620101500_pricing_signal_guardrail_inputs.sql
--
-- Covers:
--  1) Category×branch×term aggregation of utilization/booking pace/quote outcomes/rate cards/seasonality/availability
--  2) Guardrail input assembly
--  3) Source-gap + stale-input markers for missing/conflicted evidence
--  4) Stable recommendation-scope fingerprint / dedupe key behavior

begin;

do $$
declare
  v_branch_a uuid;
  v_branch_b uuid;
  v_category_a uuid;
  v_asset_a1 uuid;
  v_asset_a2 uuid;
  v_order_approved uuid;
  v_order_cancelled uuid;
  v_row_count int;
  v_win_rate_tolerance numeric := 0.0001;
  v_won int;
  v_lost int;
  v_win_rate numeric;
  v_guardrail jsonb;
  v_source_gaps jsonb;
  v_stale_gaps jsonb;
  v_fingerprint_a text;
  v_fingerprint_b text;
  v_dedupe_key text;
  v_hold_inventory boolean;
  v_has_competitor_conflict boolean;
  v_missing_scope_has_quote_gap boolean;
  v_missing_scope_has_inventory_gap boolean;
  v_missing_scope_has_competitor_gap boolean;
  v_missing_scope_has_utilization_gap boolean;
begin
  if not has_table_privilege('authenticated', 'public.v_pricing_signal_guardrail_inputs', 'SELECT') then
    raise exception 'Expected authenticated SELECT on v_pricing_signal_guardrail_inputs';
  end if;

  if has_table_privilege('anon', 'public.v_pricing_signal_guardrail_inputs', 'SELECT') then
    raise exception 'Did not expect anon SELECT on v_pricing_signal_guardrail_inputs';
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id into v_branch_a
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'pricing-snapshot-branch-a',
    p_data => jsonb_build_object('name', 'Pricing Branch A')
  );

  select entity_id into v_branch_b
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'pricing-snapshot-branch-b',
    p_data => jsonb_build_object('name', 'Pricing Branch B')
  );

  select entity_id into v_category_a
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_source_record_id => 'pricing-snapshot-category-a',
    p_data => jsonb_build_object('name', 'Pricing Category A')
  );

  select entity_id into v_asset_a1
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'pricing-snapshot-asset-a1',
    p_data => jsonb_build_object('name', 'Pricing Asset A1', 'operational_status', 'available')
  );

  select entity_id into v_asset_a2
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'pricing-snapshot-asset-a2',
    p_data => jsonb_build_object('name', 'Pricing Asset A2', 'operational_status', 'on_rent')
  );

  perform public.rental_upsert_relationship('branch_has_asset', v_branch_a, v_asset_a1);
  perform public.rental_upsert_relationship('branch_has_asset', v_branch_a, v_asset_a2);
  perform public.rental_upsert_relationship('asset_category_has_asset', v_category_a, v_asset_a1);
  perform public.rental_upsert_relationship('asset_category_has_asset', v_category_a, v_asset_a2);

  insert into public.inventory_rate_plans (
    name,
    effective_from,
    daily_rate,
    weekly_rate,
    monthly_rate,
    branch_id,
    category_id,
    is_active
  )
  values
    -- Branch A baseline rate card (daily/weekly/monthly) for the primary scoped assertions.
    ('Pricing Branch A - Category A', current_date - 15, 120, 700, 2400, v_branch_a, v_category_a, true),
    -- Branch B baseline rate card only (no quote/utilization evidence) to force explicit gap markers.
    ('Pricing Branch B - Category A', current_date - 15, 130, 760, 2500, v_branch_b, v_category_a, true);

  select entity_id into v_order_approved
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'pricing-snapshot-order-approved',
    p_data => jsonb_build_object(
      'status', 'approved',
      'order_number', 'PRC-APPROVED-001',
      'branch_id', v_branch_a
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'pricing-snapshot-order-line-approved',
    p_data => jsonb_build_object(
      'order_id', v_order_approved,
      'status', 'draft',
      'category_id', v_category_a,
      'branch_id', v_branch_a,
      'quantity', 1,
      'planned_start', current_date + 2,
      'planned_end', current_date + 4,
      'competitor_daily_rate', 100
    )
  );

  select entity_id into v_order_cancelled
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'pricing-snapshot-order-cancelled',
    p_data => jsonb_build_object(
      'status', 'cancelled',
      'order_number', 'PRC-CANCELLED-001',
      'branch_id', v_branch_a
    )
  );

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'pricing-snapshot-order-line-cancelled',
    p_data => jsonb_build_object(
      'order_id', v_order_cancelled,
      'status', 'draft',
      'category_id', v_category_a,
      'branch_id', v_branch_a,
      'quantity', 1,
      'planned_start', current_date + 3,
      'planned_end', current_date + 5,
      'competitor_daily_rate', 140
    )
  );

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"app_metadata":{"role":"admin"}}', true);

  select count(*) into v_row_count
  from public.v_pricing_signal_guardrail_inputs
  where branch_id = v_branch_a
    and asset_category_id = v_category_a
    and term_bucket = 'short_term';

  if v_row_count <> 1 then
    raise exception 'Expected one short_term snapshot row for branch/category A, found %', v_row_count;
  end if;

  select
    won_quotes_90d,
    lost_quotes_90d,
    quote_win_rate,
    guardrail_inputs,
    source_gap_markers,
    stale_input_markers,
    recommendation_scope_fingerprint,
    recommendation_scope_dedupe_key
  into
    v_won,
    v_lost,
    v_win_rate,
    v_guardrail,
    v_source_gaps,
    v_stale_gaps,
    v_fingerprint_a,
    v_dedupe_key
  from public.v_pricing_signal_guardrail_inputs
  where branch_id = v_branch_a
    and asset_category_id = v_category_a
    and term_bucket = 'short_term';

  if v_won <> 1 or v_lost <> 1 then
    raise exception 'Expected won/lost rollup 1/1 for branch/category A, got %/%', v_won, v_lost;
  end if;

  if v_win_rate is null or abs(v_win_rate - 0.5000) > v_win_rate_tolerance then -- 1 won / 1 lost => 50% rendered at 4 decimal places.
    raise exception 'Expected quote_win_rate = 0.5000, got %', coalesce(v_win_rate::text, '<null>');
  end if;

  if v_guardrail is null
     or not (v_guardrail ? 'target_utilization_pct')
     or not (v_guardrail ? 'max_step_up_pct')
     or not (v_guardrail ? 'max_step_down_pct')
     or not (v_guardrail ? 'min_daily_rate_minor')
     or not (v_guardrail ? 'max_daily_rate_minor')
     or not (v_guardrail ? 'hold_if_inventory_tight') then
    raise exception 'Guardrail inputs missing expected keys: %', coalesce(v_guardrail::text, '<null>');
  end if;

  v_hold_inventory := (v_guardrail->>'hold_if_inventory_tight')::boolean;
  if v_hold_inventory is null then
    raise exception 'Expected hold_if_inventory_tight to be a boolean guardrail input';
  end if;

  v_has_competitor_conflict := exists (
    select 1
    from jsonb_array_elements(coalesce(v_source_gaps, '[]'::jsonb)) as item
    where item = to_jsonb('competitor_conflicted'::text)
  );
  if not v_has_competitor_conflict then
    raise exception 'Expected competitor_conflicted source-gap marker for branch/category A scope';
  end if;

  if v_fingerprint_a is null or v_fingerprint_a = '' then
    raise exception 'Expected non-empty recommendation_scope_fingerprint';
  end if;

  if v_dedupe_key is distinct from v_fingerprint_a then
    raise exception 'Expected recommendation_scope_dedupe_key to match fingerprint (% vs %)',
      coalesce(v_dedupe_key, '<null>'),
      coalesce(v_fingerprint_a, '<null>');
  end if;

  -- Fingerprint must be stable between repeated reads of the same scope.
  select recommendation_scope_fingerprint
  into v_fingerprint_b
  from public.v_pricing_signal_guardrail_inputs
  where branch_id = v_branch_a
    and asset_category_id = v_category_a
    and term_bucket = 'short_term';

  if v_fingerprint_b is distinct from v_fingerprint_a then
    raise exception 'Expected stable fingerprint across reads, got % then %',
      coalesce(v_fingerprint_a, '<null>'),
      coalesce(v_fingerprint_b, '<null>');
  end if;

  -- Branch/category B has only an active rate card, so missing source evidence must be explicit.
  select
    source_gap_markers,
    stale_input_markers
  into v_source_gaps, v_stale_gaps
  from public.v_pricing_signal_guardrail_inputs
  where branch_id = v_branch_b
    and asset_category_id = v_category_a
    and term_bucket = 'short_term';

  if v_source_gaps is null then
    raise exception 'Expected source_gap_markers for branch/category B scope';
  end if;

  v_missing_scope_has_quote_gap := exists (
    select 1
    from jsonb_array_elements(v_source_gaps) as item
    where item = to_jsonb('quote_outcome_missing'::text)
  );
  v_missing_scope_has_inventory_gap := exists (
    select 1
    from jsonb_array_elements(v_source_gaps) as item
    where item = to_jsonb('inventory_missing'::text)
  );
  v_missing_scope_has_competitor_gap := exists (
    select 1
    from jsonb_array_elements(v_source_gaps) as item
    where item = to_jsonb('competitor_missing'::text)
  );
  v_missing_scope_has_utilization_gap := exists (
    select 1
    from jsonb_array_elements(v_source_gaps) as item
    where item = to_jsonb('utilization_missing'::text)
  );

  if not v_missing_scope_has_quote_gap
     or not v_missing_scope_has_inventory_gap
     or not v_missing_scope_has_competitor_gap
     or not v_missing_scope_has_utilization_gap then
    raise exception 'Expected explicit missing source markers for branch/category B scope; got %', v_source_gaps;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_stale_gaps, '[]'::jsonb)) as item
    where item = to_jsonb('quote_outcome_stale'::text)
  ) then
    raise exception 'Expected quote_outcome_stale marker for missing-evidence scope';
  end if;

  raise notice 'PASS pricing signal snapshot aggregation + guardrails + gap markers + fingerprint stability';
end;
$$;

rollback;
