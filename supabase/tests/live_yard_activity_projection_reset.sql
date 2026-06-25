begin;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

-- Reset-path guard for 20260613150000_live_yard_activity_projection.sql.
--
-- Confirms that after a full `supabase db reset --config supabase/config.toml`
-- (migrations + seed):
--   1. All four live-yard lanes remain populated for operators.
--   2. Board rows still expose operational context fields needed by the route
--      (order/contract/asset context, schedule timing, lane status flags).
--   3. The realtime feed timestamp advances when canonical yard lifecycle data
--      is refreshed.

do $$
declare
  v_count bigint;
  v_before timestamptz;
  v_after timestamptz;
  v_order_id uuid;
  v_source_record_id text;
  v_branch_id text;
  v_customer_id text;
  v_job_site_id text;
  v_order_number text;
begin
  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where lane_key = 'going_out';

  if v_count <= 0 then
    raise exception 'Expected non-empty going_out lane after reset, found %', v_count;
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where lane_key = 'coming_in';

  if v_count <= 0 then
    raise exception 'Expected non-empty coming_in lane after reset, found %', v_count;
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where lane_key = 'needs_review';

  if v_count <= 0 then
    raise exception 'Expected non-empty needs_review lane after reset, found %', v_count;
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where lane_key = 'maintenance';

  if v_count <= 0 then
    raise exception 'Expected non-empty maintenance lane after reset, found %', v_count;
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where lane_key = 'going_out'
    and order_number is not null
    and scheduled_start_at is not null
    and scheduled_end_at is not null
    and activity_status in ('pending', 'checked_out', 'approved', 'pending_execution');

  if v_count <= 0 then
    raise exception 'Expected going_out rows with order context + schedule timing after reset';
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where lane_key = 'coming_in'
    and contract_number is not null
    and asset_name is not null
    and scheduled_end_at is not null
    and is_overdue is not null;

  if v_count <= 0 then
    raise exception 'Expected coming_in rows with contract/asset context after reset';
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where lane_key = 'needs_review'
    and asset_name is not null
    and is_needs_review is true
    and status_detail is not null;

  if v_count <= 0 then
    raise exception 'Expected needs_review rows with review context after reset';
  end if;

  select count(*)
    into v_count
  from public.v_live_yard_activity_current
  where lane_key = 'maintenance'
    and maintenance_record_id is not null
    and maintenance_status is not null
    and asset_name is not null
    and status_detail is not null;

  if v_count <= 0 then
    raise exception 'Expected maintenance rows with maintenance-feed context after reset';
  end if;

  select updated_at
    into v_before
  from public.live_yard_projection_feed
  where feed_key = 'live_yard_activity';

  if v_before is null then
    raise exception 'Expected live_yard_projection_feed row after reset';
  end if;

  select ly.order_id, e.source_record_id, ly.branch_id::text, ly.customer_id::text, ly.job_site_id::text, ly.order_number
    into v_order_id, v_source_record_id, v_branch_id, v_customer_id, v_job_site_id, v_order_number
  from public.v_live_yard_activity_current ly
  join public.entities e
    on e.id = ly.order_id
  where ly.lane_key = 'going_out'
    and ly.order_id is not null
    and ly.order_number is not null
    and ly.branch_id is not null
    and ly.customer_id is not null
  order by ly.sort_at desc nulls last
  limit 1;

  if v_order_id is null then
    raise exception 'Expected an approved order fixture for live-yard feed refresh probe after reset';
  end if;

  -- Ensure clock_timestamp() can advance beyond v_before even on fast CI runners.
  perform pg_sleep(0.05);

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_entity_id => v_order_id,
    p_source_record_id => v_source_record_id,
    p_data => jsonb_strip_nulls(jsonb_build_object(
      'status', 'approved',
      'order_number', v_order_number,
      'branch_id', v_branch_id,
      'customer_id', v_customer_id,
      'job_site_id', v_job_site_id,
      '__test_probe_timestamp', clock_timestamp()::text
    ))
  );

  select updated_at
    into v_after
  from public.live_yard_projection_feed
  where feed_key = 'live_yard_activity';

  if v_after is null or v_after <= v_before then
    raise exception 'Expected live yard projection feed timestamp to advance after reset (% <= %)', v_after, v_before;
  end if;

  raise notice 'Live yard projection reset assertions passed';
end;
$$;

rollback;
