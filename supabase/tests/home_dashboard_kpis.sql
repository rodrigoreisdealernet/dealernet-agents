-- Assertions for supabase/migrations/20260606152000_home_dashboard_kpis.sql
-- Run after `supabase db reset --config supabase/config.toml` to confirm the
-- v_home_dashboard_kpis view exists and returns the expected column set.

begin;

do $$
declare
  v_col_count   int;
  v_row_count   int;
  v_as_of       timestamptz;
  v_assets_on_rent          bigint;
  v_fleet_utilization_pct   numeric;
  v_overdue_returns_count   bigint;
  v_open_maintenance_count  bigint;
  v_period_revenue          numeric;
  v_prior_period_revenue    numeric;
  v_available_assets        bigint;
  v_unavailable_assets      bigint;
  v_total_assets            bigint;
begin
  -- 1. View exists and exposes exactly the 10 expected columns
  select count(*)
    into v_col_count
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'v_home_dashboard_kpis'
     and column_name  in (
       'as_of',
       'assets_on_rent',
       'fleet_utilization_pct',
       'overdue_returns_count',
       'open_maintenance_count',
       'period_revenue',
       'prior_period_revenue',
       'available_assets',
       'unavailable_assets',
       'total_assets'
     );

  if v_col_count <> 10 then
    raise exception
      'v_home_dashboard_kpis must expose 10 columns; found %', v_col_count;
  end if;

  -- 2. View returns exactly one row (it is a cross-join aggregate snapshot)
  select count(*) into v_row_count from v_home_dashboard_kpis;

  if v_row_count <> 1 then
    raise exception
      'v_home_dashboard_kpis must return exactly 1 row; found %', v_row_count;
  end if;

  -- 3. All numeric columns are non-null and >= 0 (coalesce guards in the view)
  select
    as_of,
    assets_on_rent,
    fleet_utilization_pct,
    overdue_returns_count,
    open_maintenance_count,
    period_revenue,
    prior_period_revenue,
    available_assets,
    unavailable_assets,
    total_assets
  into
    v_as_of,
    v_assets_on_rent,
    v_fleet_utilization_pct,
    v_overdue_returns_count,
    v_open_maintenance_count,
    v_period_revenue,
    v_prior_period_revenue,
    v_available_assets,
    v_unavailable_assets,
    v_total_assets
  from v_home_dashboard_kpis;

  if v_as_of is null then
    raise exception 'v_home_dashboard_kpis.as_of must not be null';
  end if;

  if v_assets_on_rent is null or v_assets_on_rent < 0 then
    raise exception 'v_home_dashboard_kpis.assets_on_rent must be >= 0; got %', v_assets_on_rent;
  end if;

  if v_fleet_utilization_pct is null or v_fleet_utilization_pct < 0 then
    raise exception 'v_home_dashboard_kpis.fleet_utilization_pct must be >= 0; got %', v_fleet_utilization_pct;
  end if;

  if v_overdue_returns_count is null or v_overdue_returns_count < 0 then
    raise exception 'v_home_dashboard_kpis.overdue_returns_count must be >= 0; got %', v_overdue_returns_count;
  end if;

  if v_open_maintenance_count is null or v_open_maintenance_count < 0 then
    raise exception 'v_home_dashboard_kpis.open_maintenance_count must be >= 0; got %', v_open_maintenance_count;
  end if;

  if v_period_revenue is null or v_period_revenue < 0 then
    raise exception 'v_home_dashboard_kpis.period_revenue must be >= 0; got %', v_period_revenue;
  end if;

  if v_prior_period_revenue is null or v_prior_period_revenue < 0 then
    raise exception 'v_home_dashboard_kpis.prior_period_revenue must be >= 0; got %', v_prior_period_revenue;
  end if;

  if v_available_assets is null or v_available_assets < 0 then
    raise exception 'v_home_dashboard_kpis.available_assets must be >= 0; got %', v_available_assets;
  end if;

  if v_unavailable_assets is null or v_unavailable_assets < 0 then
    raise exception 'v_home_dashboard_kpis.unavailable_assets must be >= 0; got %', v_unavailable_assets;
  end if;

  if v_total_assets is null or v_total_assets < 0 then
    raise exception 'v_home_dashboard_kpis.total_assets must be >= 0; got %', v_total_assets;
  end if;

  -- 4. fleet_utilization_pct is 0 when there are no assets (divide-by-zero guard)
  if v_total_assets = 0 and v_fleet_utilization_pct <> 0 then
    raise exception
      'fleet_utilization_pct must be 0 when total_assets = 0; got %', v_fleet_utilization_pct;
  end if;

  raise notice 'v_home_dashboard_kpis migration assertions passed';
end;
$$;

rollback;
