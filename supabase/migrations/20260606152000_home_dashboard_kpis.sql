-- Home operations dashboard KPIs
-- Created: 2026-06-06
-- Purpose: provide one-row operational KPI snapshot for the home dashboard

create or replace view v_home_dashboard_kpis as
with input_patterns as (
  -- Accepts YYYY-MM-DD date strings and ISO timestamp strings (with optional timezone)
  select '^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:\d{2})?)?$'::text as iso_date_or_timestamp
),
asset_totals as (
  select
    count(*) as total_assets,
    count(*) filter (where coalesce(operational_status, '') = 'on_rent') as assets_on_rent,
    count(*) filter (where coalesce(operational_status, '') = 'available') as available_assets,
    count(*) filter (where coalesce(operational_status, '') <> 'available') as unavailable_assets
  from rental_current_assets
),
overdue_returns as (
  select
    count(*) as overdue_returns_count
  from v_rental_contract_line_current
  where status = 'checked_out'
    and coalesce(data ->> 'planned_end', '') ~ (select iso_date_or_timestamp from input_patterns)
    and nullif(data ->> 'planned_end', '')::timestamptz < now()
),
maintenance_open as (
  select
    count(*) as open_maintenance_count
  from rental_current_entity_state
  where entity_type = 'maintenance_record'
    and lower(coalesce(data ->> 'status', 'open')) not in ('closed', 'completed', 'cancelled')
),
invoice_totals as (
  select
    coalesce(
      case
        when coalesce(data ->> 'invoice_date', '') ~ (select iso_date_or_timestamp from input_patterns)
          then nullif(data ->> 'invoice_date', '')::timestamptz
        else null
      end,
      case
        when coalesce(data ->> 'issued_at', '') ~ (select iso_date_or_timestamp from input_patterns)
          then nullif(data ->> 'issued_at', '')::timestamptz
        else null
      end,
      entity_versions.created_at
    ) as invoice_at,
    case
      when coalesce(data ->> 'total', '') ~ '^-?\d+(\.\d+)?$' then (data ->> 'total')::numeric
      else 0::numeric
    end as total_amount
  from entities
  join entity_versions
    on entity_versions.entity_id = entities.id
   and entity_versions.is_current
  where entities.entity_type = 'invoice'
),
revenue as (
  select
    coalesce(sum(total_amount) filter (
      where date_trunc('month', invoice_at) = date_trunc('month', now())
    ), 0)::numeric(18,2) as period_revenue,
    coalesce(sum(total_amount) filter (
      where date_trunc('month', invoice_at) = date_trunc('month', now() - interval '1 month')
    ), 0)::numeric(18,2) as prior_period_revenue
  from invoice_totals
)
select
  now() as as_of,
  asset_totals.assets_on_rent,
  case
    when asset_totals.total_assets = 0 then 0::numeric(5,2)
    else round((asset_totals.assets_on_rent::numeric / asset_totals.total_assets::numeric) * 100, 2)
  end as fleet_utilization_pct,
  overdue_returns.overdue_returns_count,
  maintenance_open.open_maintenance_count,
  revenue.period_revenue,
  revenue.prior_period_revenue,
  asset_totals.available_assets,
  asset_totals.unavailable_assets,
  asset_totals.total_assets
from asset_totals
cross join overdue_returns
cross join maintenance_open
cross join revenue;
