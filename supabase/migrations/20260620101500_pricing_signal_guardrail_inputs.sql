-- Deterministic pricing-signal snapshot + guardrail inputs for Dynamic Pricing & Yield Optimizer.
--
-- Produces a bounded category×branch×term surface with:
--   - utilization, booking pace, quote outcomes, current rate cards,
--     seasonality context, and availability pressure signals
--   - explicit source-gap and stale-input markers
--   - stable recommendation-scope fingerprint/dedupe key per scoped slice

create or replace view public.v_pricing_signal_guardrail_inputs
with (security_invoker = true) as
with params as (
  select
    -- Booking pace uses the same two-week window as quotes_14d for consistency.
    14.0::numeric as booking_pace_window_days,
    0.75::numeric as min_rate_multiplier,
    1.35::numeric as max_rate_multiplier,
    1.25::numeric as competitor_conflict_threshold_multiplier,
    0.15::numeric as inventory_tight_availability_ratio,
    0.40::numeric as inventory_tight_shortage_per_quote,
    250::int as max_scope_rows
),
scoped_quotes as (
  select
    order_line.entity_id as line_entity_id,
    order_entity.created_at as order_created_at,
    coalesce(nullif(order_line.branch_id, '')::uuid, nullif(rental_order.data->>'branch_id', '')::uuid) as branch_id,
    nullif(order_line.category_id, '')::uuid as asset_category_id,
    greatest(
      coalesce(order_line.planned_end - order_line.planned_start, 0),
      1
    )::int as rental_days,
    case
      when greatest(coalesce(order_line.planned_end - order_line.planned_start, 0), 1) >= 28 then 'long_term'
      when greatest(coalesce(order_line.planned_end - order_line.planned_start, 0), 1) >= 7 then 'mid_term'
      else 'short_term'
    end as term_bucket,
    rental_order.status as order_status,
    order_line.data as line_data,
    coalesce(availability.is_available, false) as is_available,
    coalesce(availability.shortage_quantity, 0) as shortage_quantity,
    order_line.planned_start,
    order_line.planned_end
  from public.v_rental_order_line_current order_line
  join public.v_rental_order_current rental_order
    on rental_order.entity_id::text = order_line.order_id
  join public.entities order_entity
    on order_entity.id = rental_order.entity_id
  left join public.rental_quote_line_availability_current availability
    on availability.line_entity_id = order_line.entity_id
  where order_line.category_id is not null
    and coalesce(order_line.branch_id, rental_order.data->>'branch_id') is not null
    and rental_order.status in ('draft', 'quoted', 'approved', 'converted', 'cancelled')
),
outcome_rollup as (
  select
    q.branch_id,
    q.asset_category_id,
    q.term_bucket,
    count(*) filter (
      where q.order_status in ('approved', 'converted')
        and q.order_created_at >= now() - interval '90 days'
    ) as won_quotes_90d,
    count(*) filter (
      where q.order_status = 'cancelled'
        and q.order_created_at >= now() - interval '90 days'
    ) as lost_quotes_90d,
    count(*) filter (
      where q.order_created_at >= now() - interval '30 days'
    ) as quotes_30d,
    count(*) filter (
      where q.order_created_at >= now() - interval '14 days'
    ) as quotes_14d,
    max(q.order_created_at) as last_quote_observed_at
  from scoped_quotes q
  group by q.branch_id, q.asset_category_id, q.term_bucket
),
availability_rollup as (
  select
    q.branch_id,
    q.asset_category_id,
    q.term_bucket,
    count(*) as quote_lines_observed,
    count(*) filter (where q.is_available) as available_lines,
    sum(greatest(q.shortage_quantity, 0))::numeric as shortage_qty,
    max(q.order_created_at) as last_inventory_observed_at
  from scoped_quotes q
  group by q.branch_id, q.asset_category_id, q.term_bucket
),
competitor_rollup as (
  select
    q.branch_id,
    q.asset_category_id,
    q.term_bucket,
    count(*) filter (
      where nullif(coalesce(
        q.line_data->>'competitor_daily_rate',
        q.line_data->>'competitor_rate',
        q.line_data->>'market_daily_rate'
      ), '') is not null
    ) as competitor_points,
    min((nullif(coalesce(
      q.line_data->>'competitor_daily_rate',
      q.line_data->>'competitor_rate',
      q.line_data->>'market_daily_rate'
    ), ''))::numeric) as competitor_min_daily,
    max((nullif(coalesce(
      q.line_data->>'competitor_daily_rate',
      q.line_data->>'competitor_rate',
      q.line_data->>'market_daily_rate'
    ), ''))::numeric) as competitor_max_daily,
    max(q.order_created_at) filter (
      where nullif(coalesce(
        q.line_data->>'competitor_daily_rate',
        q.line_data->>'competitor_rate',
        q.line_data->>'market_daily_rate'
      ), '') is not null
    ) as last_competitor_observed_at
  from scoped_quotes q
  group by q.branch_id, q.asset_category_id, q.term_bucket
),
seasonality_rollup as (
  select
    q.branch_id,
    q.asset_category_id,
    q.term_bucket,
    count(*) filter (
      where date_trunc('month', q.order_created_at) = date_trunc('month', now())
    )::numeric as month_quote_count,
    avg(month_counts.month_quote_count)::numeric as avg_monthly_quotes
  from scoped_quotes q
  left join lateral (
    select
      date_trunc('month', q2.order_created_at) as quote_month,
      count(*)::numeric as month_quote_count
    from scoped_quotes q2
    where q2.branch_id = q.branch_id
      and q2.asset_category_id = q.asset_category_id
      and q2.term_bucket = q.term_bucket
      and q2.order_created_at >= now() - interval '365 days'
    group by 1
  ) as month_counts on true
  group by q.branch_id, q.asset_category_id, q.term_bucket
),
rate_rollup as (
  select
    rp.branch_id,
    rp.category_id as asset_category_id,
    avg(rp.daily_rate) filter (where rp.daily_rate is not null and rp.daily_rate > 0) as avg_daily_rate,
    avg(rp.weekly_rate) filter (where rp.weekly_rate is not null and rp.weekly_rate > 0) as avg_weekly_rate,
    avg(rp.monthly_rate) filter (where rp.monthly_rate is not null and rp.monthly_rate > 0) as avg_monthly_rate,
    count(*) as active_rate_cards
  from public.inventory_rate_plans rp
  where rp.is_active
    and current_date >= rp.effective_from
    and (rp.effective_to is null or current_date <= rp.effective_to)
    and rp.branch_id is not null
    and rp.category_id is not null
  group by rp.branch_id, rp.category_id
),
utilization_rollup as (
  select
    a.branch_id,
    a.asset_category_id,
    a.total_assets,
    a.available_assets,
    a.unavailable_assets,
    case
      when a.total_assets > 0
        then round((a.unavailable_assets::numeric / a.total_assets::numeric) * 100.0, 4)
      else null
    end as utilization_pct,
    case
      when a.total_assets > 0 then now()
      else null
    end as utilization_updated_at
  from public.rental_asset_availability_current a
),
scope_union as (
  select distinct branch_id, asset_category_id, term_bucket from scoped_quotes
  union
  select distinct branch_id, category_id as asset_category_id, 'short_term'::text as term_bucket
  from public.inventory_rate_plans
  where is_active
    and current_date >= effective_from
    and (effective_to is null or current_date <= effective_to)
    and branch_id is not null
    and category_id is not null
),
scope_ranked as (
  select
    su.branch_id,
    su.asset_category_id,
    su.term_bucket,
    coalesce(o.quotes_30d, 0) as quote_volume_30d,
    row_number() over (
      order by coalesce(o.quotes_30d, 0) desc, su.branch_id, su.asset_category_id, su.term_bucket
    ) as scope_rank
  from scope_union su
  left join outcome_rollup o
    on o.branch_id = su.branch_id
   and o.asset_category_id = su.asset_category_id
   and o.term_bucket = su.term_bucket
)
select
  sr.branch_id,
  sr.asset_category_id,
  sr.term_bucket,
  coalesce(u.utilization_pct, 0) as utilization_pct,
  round(coalesce(o.quotes_14d, 0)::numeric / p.booking_pace_window_days, 4) as booking_pace_quotes_per_day,
  coalesce(o.won_quotes_90d, 0) as won_quotes_90d,
  coalesce(o.lost_quotes_90d, 0) as lost_quotes_90d,
  case
    when coalesce(o.won_quotes_90d, 0) + coalesce(o.lost_quotes_90d, 0) > 0 then
      round(
        (coalesce(o.won_quotes_90d, 0)::numeric
         / (coalesce(o.won_quotes_90d, 0) + coalesce(o.lost_quotes_90d, 0))::numeric),
        4
      )
    else null
  end as quote_win_rate,
  coalesce(r.avg_daily_rate, 0) as avg_daily_rate,
  coalesce(r.avg_weekly_rate, 0) as avg_weekly_rate,
  coalesce(r.avg_monthly_rate, 0) as avg_monthly_rate,
  coalesce(r.active_rate_cards, 0) as active_rate_cards,
  case
    when coalesce(s.avg_monthly_quotes, 0) > 0 then
      round(coalesce(s.month_quote_count, 0) / s.avg_monthly_quotes, 4)
    else null
  end as seasonality_index,
  case
    when coalesce(u.total_assets, 0) > 0 then
      round(coalesce(u.available_assets, 0)::numeric / u.total_assets::numeric, 4)
    else null
  end as availability_ratio,
  case
    when coalesce(a.quote_lines_observed, 0) > 0 then
      round(coalesce(a.shortage_qty, 0)::numeric / a.quote_lines_observed::numeric, 4)
    else null
  end as availability_shortage_per_quote,
  jsonb_build_object(
    'target_utilization_pct', least(95.0, greatest(50.0, round(coalesce(u.utilization_pct, 0) + 5.0, 2))),
    'max_step_up_pct', case
      when coalesce(o.won_quotes_90d, 0) + coalesce(o.lost_quotes_90d, 0) = 0 then 4.0
      when (coalesce(o.won_quotes_90d, 0)::numeric / nullif((coalesce(o.won_quotes_90d, 0) + coalesce(o.lost_quotes_90d, 0))::numeric, 0)) < 0.35 then 3.0
      else 8.0
    end,
    'max_step_down_pct', case
      when coalesce(u.utilization_pct, 0) < 40 then 12.0
      when coalesce(u.utilization_pct, 0) < 60 then 8.0
      else 5.0
    end,
    'min_daily_rate_minor', greatest(0, floor(coalesce(r.avg_daily_rate, 0) * p.min_rate_multiplier * 100))::bigint,
    'max_daily_rate_minor', ceil(coalesce(r.avg_daily_rate, 0) * p.max_rate_multiplier * 100)::bigint,
    'hold_if_inventory_tight', (
      coalesce(a.quote_lines_observed, 0) > 0
      and (
        coalesce(u.total_assets, 0) = 0
        or coalesce(u.available_assets, 0)::numeric / nullif(u.total_assets::numeric, 0) < p.inventory_tight_availability_ratio
        or coalesce(a.shortage_qty, 0)::numeric / nullif(a.quote_lines_observed::numeric, 0) > p.inventory_tight_shortage_per_quote
      )
    )
  ) as guardrail_inputs,
  to_jsonb(array_remove(array[
    case
      when coalesce(o.won_quotes_90d, 0) + coalesce(o.lost_quotes_90d, 0) = 0
        then 'quote_outcome_missing'
      else null
    end,
    case
      when coalesce(u.total_assets, 0) = 0 then 'utilization_missing'
      else null
    end,
    case
      when coalesce(c.competitor_points, 0) = 0 then 'competitor_missing'
      when coalesce(c.competitor_points, 0) > 1
        and coalesce(c.competitor_min_daily, 0) > 0
        and coalesce(c.competitor_max_daily, 0) > c.competitor_min_daily * p.competitor_conflict_threshold_multiplier
        then 'competitor_conflicted'
      else null
    end,
    case
      when coalesce(a.quote_lines_observed, 0) = 0 then 'inventory_missing'
      else null
    end
  ], null)) as source_gap_markers,
  to_jsonb(array_remove(array[
    case
      when o.last_quote_observed_at is null
        or o.last_quote_observed_at < now() - interval '30 days'
        then 'quote_outcome_stale'
      else null
    end,
    case
      when u.utilization_updated_at is null
        or u.utilization_updated_at < now() - interval '30 days'
        then 'utilization_stale'
      else null
    end,
    case
      when a.last_inventory_observed_at is null
        or a.last_inventory_observed_at < now() - interval '14 days'
        then 'inventory_stale'
      else null
    end,
    case
      when c.last_competitor_observed_at is null
        or c.last_competitor_observed_at < now() - interval '30 days'
        then 'competitor_stale'
      else null
    end
  ], null)) as stale_input_markers,
  scope_key.scope_fingerprint as recommendation_scope_fingerprint,
  scope_key.scope_fingerprint as recommendation_scope_dedupe_key
from scope_ranked sr
cross join params p
left join outcome_rollup o
  on o.branch_id = sr.branch_id
 and o.asset_category_id = sr.asset_category_id
 and o.term_bucket = sr.term_bucket
left join availability_rollup a
  on a.branch_id = sr.branch_id
 and a.asset_category_id = sr.asset_category_id
 and a.term_bucket = sr.term_bucket
left join competitor_rollup c
  on c.branch_id = sr.branch_id
 and c.asset_category_id = sr.asset_category_id
 and c.term_bucket = sr.term_bucket
left join seasonality_rollup s
  on s.branch_id = sr.branch_id
 and s.asset_category_id = sr.asset_category_id
 and s.term_bucket = sr.term_bucket
left join rate_rollup r
  on r.branch_id = sr.branch_id
 and r.asset_category_id = sr.asset_category_id
left join utilization_rollup u
  on u.branch_id = sr.branch_id
 and u.asset_category_id = sr.asset_category_id
cross join lateral (
  -- Weekly bucketing keeps dedupe stable across repeated daily runs while still
  -- rotating scope fingerprints often enough to allow fresh weekly proposals.
  -- `now()` is intentional: the fingerprint is deterministic for any given
  -- scope within a week, then rolls over at the next weekly planning window.
  select md5(
    format(
      'pricing-scope|%s|%s|%s|%s',
      coalesce(sr.branch_id::text, 'none'),
      coalesce(sr.asset_category_id::text, 'none'),
      sr.term_bucket,
      to_char(date_trunc('week', now())::date, 'YYYY-MM-DD')
    )
  ) as scope_fingerprint
) as scope_key
where sr.scope_rank <= p.max_scope_rows;

revoke all on table public.v_pricing_signal_guardrail_inputs from anon;
grant select on table public.v_pricing_signal_guardrail_inputs to authenticated, service_role;
