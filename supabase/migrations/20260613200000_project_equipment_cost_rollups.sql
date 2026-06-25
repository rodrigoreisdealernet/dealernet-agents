-- Project equipment cost rollups + budget variance
-- Closes #1488
--
-- Provides semantic reporting outputs for project/job-site equipment costing so
-- project managers can compare budget vs actual and owned vs external-rental
-- cost treatment in one view.

create or replace view public.v_project_equipment_cost_rollups
with (security_invoker = true) as
with request_context as (
  select
    coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') as request_role,
    public.get_my_tenant()                                                     as request_tenant
),
job_sites as (
  select
    js.id                                                              as job_site_id,
    coalesce(nullif(jsv.data ->> 'name', ''), js.source_record_id)    as project_name,
    coalesce(nullif(jsv.data ->> 'tenant', ''), 'default')            as tenant_key,
    coalesce(
      public.parse_numeric_or_null(jsv.data ->> 'equipment_budget'),
      public.parse_numeric_or_null(jsv.data ->> 'equipment_budget_amount'),
      public.parse_numeric_or_null(jsv.data ->> 'project_equipment_budget'),
      public.parse_numeric_or_null(jsv.data ->> 'budget_amount'),
      public.parse_numeric_or_null(jsv.data ->> 'project_budget'),
      0
    )                                                                  as project_equipment_budget
  from public.entities js
  join public.entity_versions jsv
    on jsv.entity_id = js.id
   and jsv.is_current
  where js.entity_type = 'job_site'
),
contract_lines as (
  select
    line_e.id                                                          as contract_line_id,
    public.parse_uuid_or_null(line_ev.data ->> 'contract_id')          as contract_id,
    public.parse_uuid_or_null(coalesce(nullif(line_ev.data ->> 'job_site_id', ''), contract_ev.data ->> 'job_site_id')) as job_site_id,
    public.parse_uuid_or_null(line_ev.data ->> 'asset_id')             as asset_id,
    lower(coalesce(line_ev.data ->> 'status', 'pending'))              as line_status,
    lower(coalesce(line_ev.data ->> 'rate_type', 'daily'))             as rate_type,
    coalesce(public.parse_numeric_or_null(line_ev.data ->> 'rate_amount'), 0) as rate_amount,
    case
      when coalesce(nullif(line_ev.data ->> 'actual_start', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
        then (line_ev.data ->> 'actual_start')::timestamptz
      when coalesce(nullif(line_ev.data ->> 'planned_start', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
        then (line_ev.data ->> 'planned_start')::timestamptz
      else null
    end                                                                as started_at,
    case
      when coalesce(nullif(line_ev.data ->> 'actual_end', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
        then (line_ev.data ->> 'actual_end')::timestamptz
      when coalesce(nullif(line_ev.data ->> 'planned_end', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
        then (line_ev.data ->> 'planned_end')::timestamptz
      else null
    end                                                                as ended_at,
    upper(coalesce(nullif(contract_ev.data ->> 'reporting_currency_code', ''), 'USD')) as reporting_currency_code,
    coalesce(public.parse_numeric_or_null(contract_ev.data ->> 'fx_rate_applied'), 1) as fx_rate_applied,
    coalesce(nullif(contract_ev.data ->> 'tenant', ''), coalesce(nullif(line_ev.data ->> 'tenant', ''), 'default')) as tenant_key
  from public.entities line_e
  join public.entity_versions line_ev
    on line_ev.entity_id = line_e.id
   and line_ev.is_current
  left join public.entity_versions contract_ev
    on contract_ev.entity_id = public.parse_uuid_or_null(line_ev.data ->> 'contract_id')
   and contract_ev.is_current
  where line_e.entity_type = 'rental_contract_line'
),
line_costs as (
  select
    cl.job_site_id,
    cl.contract_line_id,
    cl.line_status,
    cl.reporting_currency_code,
    cl.tenant_key,
    cl.started_at,
    cl.ended_at,
    lower(coalesce(asset_ev.data ->> 'ownership_type', 'owned'))      as ownership_type,
    case
      when cl.started_at is null then 0::numeric
      when cl.line_status in ('cancelled', 'void') then 0::numeric
      when cl.rate_type = 'fixed' then cl.rate_amount
      when cl.rate_type = 'weekly' then cl.rate_amount * greatest(1, ceil(greatest(extract(epoch from (coalesce(cl.ended_at, now()) - cl.started_at)) / 86400.0, 0) / 7.0))
      when cl.rate_type = 'monthly' then cl.rate_amount * greatest(1, ceil(greatest(extract(epoch from (coalesce(cl.ended_at, now()) - cl.started_at)) / 86400.0, 0) / 30.0))
      else cl.rate_amount * greatest(1, ceil(greatest(extract(epoch from (coalesce(cl.ended_at, now()) - cl.started_at)) / 86400.0, 0)))
    end * coalesce(cl.fx_rate_applied, 1)                               as actual_cost_reporting
  from contract_lines cl
  left join public.entity_versions asset_ev
    on asset_ev.entity_id = cl.asset_id
   and asset_ev.is_current
  where cl.job_site_id is not null
),
project_rollup as (
  select
    lc.job_site_id,
    sum(
      case
        when lc.line_status in ('checked_out', 'returned', 'on_rent', 'off_rent')
          then lc.actual_cost_reporting
        else 0
      end
    )                                                                   as actual_equipment_cost,
    sum(
      case
        when lc.line_status in ('checked_out', 'returned', 'on_rent', 'off_rent')
         and coalesce(lc.ownership_type, 'owned') = 'owned'
          then lc.actual_cost_reporting
        else 0
      end
    )                                                                   as owned_equipment_cost,
    sum(
      case
        when lc.line_status in ('checked_out', 'returned', 'on_rent', 'off_rent')
         and coalesce(lc.ownership_type, 'owned') <> 'owned'
          then lc.actual_cost_reporting
        else 0
      end
    )                                                                   as external_rental_equipment_cost,
    count(*) filter (where lc.line_status in ('checked_out', 'on_rent'))::bigint as on_rent_line_count,
    count(*) filter (where lc.line_status in ('returned', 'off_rent'))::bigint    as off_rent_line_count,
    count(*)::bigint                                                     as allocation_line_count,
    max(greatest(coalesce(lc.started_at, '-infinity'::timestamptz), coalesce(lc.ended_at, '-infinity'::timestamptz))) as latest_lifecycle_at,
    case
      when count(distinct lc.reporting_currency_code) = 1 then min(lc.reporting_currency_code)
      when count(*) = 0 then 'USD'
      else 'MIXED'
    end                                                                  as reporting_currency_code
  from line_costs lc
  group by lc.job_site_id
)
select
  js.job_site_id,
  js.project_name,
  js.project_equipment_budget,
  coalesce(pr.actual_equipment_cost, 0)                                 as actual_equipment_cost,
  js.project_equipment_budget - coalesce(pr.actual_equipment_cost, 0)   as budget_variance,
  coalesce(pr.owned_equipment_cost, 0)                                  as owned_equipment_cost,
  coalesce(pr.external_rental_equipment_cost, 0)                        as external_rental_equipment_cost,
  coalesce(pr.on_rent_line_count, 0)                                    as on_rent_line_count,
  coalesce(pr.off_rent_line_count, 0)                                   as off_rent_line_count,
  coalesce(pr.allocation_line_count, 0)                                 as allocation_line_count,
  pr.latest_lifecycle_at,
  coalesce(pr.reporting_currency_code, 'USD')                           as reporting_currency_code,
  'actual_equipment_cost: rental_contract_line status/lifecycle (checked_out|returned) using rate_amount × elapsed units; '
    || 'owned vs external_rental split from asset ownership_type; '
    || 'budget_variance = project_equipment_budget - actual_equipment_cost' as formula_reference
from job_sites js
left join project_rollup pr
  on pr.job_site_id = js.job_site_id
cross join request_context req
where req.request_role = 'service_role'
   or js.tenant_key = coalesce(nullif(req.request_tenant, ''), 'default');

revoke all on public.v_project_equipment_cost_rollups from public, anon;
grant select on public.v_project_equipment_cost_rollups to authenticated, service_role;
