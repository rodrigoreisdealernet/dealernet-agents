-- External-rental revenue + vendor-obligation reporting
-- Closes #1277
--
-- Reuses the canonical contract / invoice / reporting views to distinguish
-- owned-fleet external rentals from third-party re-rental fulfillment without
-- introducing bespoke analytics tables or an AP ledger.

create or replace view public.v_external_rental_reporting_lines
with (security_invoker = true) as
with request_context as (
  select
    coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
      ''
    ) as request_role,
    public.get_my_tenant() as request_tenant
),
contract_lines as (
  select
    line.entity_id as contract_line_id,
    public.parse_uuid_or_null(line.data ->> 'contract_id') as contract_id,
    public.parse_uuid_or_null(line.data ->> 'order_line_id') as order_line_id,
    public.parse_uuid_or_null(line.data ->> 'asset_id') as asset_id,
    public.parse_uuid_or_null(
      coalesce(
        nullif(line.data ->> 'fulfillment_branch_id', ''),
        nullif(line.data ->> 'branch_id', ''),
        nullif(contract.data ->> 'branch_id', '')
      )
    ) as branch_id,
    lower(coalesce(line.data ->> 'status', 'pending')) as contract_line_status,
    lower(coalesce(line.data ->> 'rental_type', contract.data ->> 'rental_type', 'internal')) as rental_type,
    lower(coalesce(line.data ->> 'rate_type', 'daily')) as rate_type,
    coalesce(public.parse_numeric_or_null(line.data ->> 'rate_amount'), 0::numeric) as rate_amount,
    case
      when coalesce(nullif(line.data ->> 'actual_start', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
        then (line.data ->> 'actual_start')::timestamptz
      when coalesce(nullif(line.data ->> 'planned_start', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
        then (line.data ->> 'planned_start')::timestamptz
      else null
    end as started_at,
    case
      when coalesce(nullif(line.data ->> 'actual_end', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
        then (line.data ->> 'actual_end')::timestamptz
      when coalesce(nullif(line.data ->> 'planned_end', ''), '') ~ '^\d{4}-\d{2}-\d{2}'
        then (line.data ->> 'planned_end')::timestamptz
      else null
    end as ended_at,
    upper(coalesce(nullif(contract.data ->> 'reporting_currency_code', ''), 'USD')) as reporting_currency_code,
    coalesce(public.parse_numeric_or_null(contract.data ->> 'fx_rate_applied'), 1::numeric) as contract_fx_rate_applied,
    coalesce(
      nullif(line.data ->> 'tenant', ''),
      nullif(contract.data ->> 'tenant', ''),
      nullif(contract.data ->> 'tenant_key', ''),
      'default'
    ) as tenant_key
  from public.rental_current_entity_state line
  left join public.rental_current_entity_state contract
    on contract.entity_id = public.parse_uuid_or_null(line.data ->> 'contract_id')
   and contract.entity_type = 'rental_contract'
  where line.entity_type = 'rental_contract_line'
),
line_invoice_rollups as (
  select
    public.parse_uuid_or_null(invoice_line.data ->> 'line_item_id') as contract_line_id,
    count(distinct invoice.entity_id) as invoice_count,
    string_agg(
      distinct coalesce(
        nullif(invoice.data ->> 'invoice_number', ''),
        invoice.source_record_id,
        invoice.entity_id::text
      ),
      ', '
      order by coalesce(
        nullif(invoice.data ->> 'invoice_number', ''),
        invoice.source_record_id,
        invoice.entity_id::text
      )
    ) as invoice_reference,
    max(
      coalesce(
        public.parse_date_or_null(invoice.data ->> 'invoice_date'),
        public.parse_date_or_null(invoice.data ->> 'billing_period_end'),
        invoice.created_at::date
      )
    ) as latest_invoice_date,
    round(sum(
      coalesce(public.parse_numeric_or_null(invoice_line.data ->> 'amount'), 0::numeric)
      * coalesce(
        case
          when upper(coalesce(nullif(invoice.data ->> 'reporting_currency_code', ''), 'USD'))
             = upper(coalesce(nullif(invoice.data ->> 'transaction_currency_code', ''), 'USD'))
            then 1::numeric
          else public.parse_numeric_or_null(invoice.data ->> 'fx_rate_applied')
        end,
        1::numeric
      )
    ), 2) as customer_revenue_reporting_amount
  from public.rental_current_entity_state invoice_line
  join public.rental_current_entity_state invoice
    on invoice.entity_id = public.parse_uuid_or_null(invoice_line.data ->> 'invoice_id')
   and invoice.entity_type = 'invoice'
  where invoice_line.entity_type = 'invoice_line'
    and public.parse_uuid_or_null(invoice_line.data ->> 'line_item_id') is not null
  group by public.parse_uuid_or_null(invoice_line.data ->> 'line_item_id')
),
line_usage as (
  select
    cl.*,
    greatest(
      extract(epoch from (coalesce(cl.ended_at, now()) - cl.started_at)) / 60.0,
      0
    )::numeric as elapsed_minutes,
    round(
      case
        when cl.started_at is null then 0::numeric
        when cl.contract_line_status in ('cancelled', 'void') then 0::numeric
        when cl.rate_type = 'fixed' then cl.rate_amount
        when cl.rate_type = 'weekly' then cl.rate_amount * greatest(
          1,
          ceil(greatest(extract(epoch from (coalesce(cl.ended_at, now()) - cl.started_at)) / 86400.0, 0) / 7.0)
        )
        when cl.rate_type = 'monthly' then cl.rate_amount * greatest(
          1,
          ceil(greatest(extract(epoch from (coalesce(cl.ended_at, now()) - cl.started_at)) / 86400.0, 0) / 30.0)
        )
        else cl.rate_amount * greatest(
          1,
          ceil(greatest(extract(epoch from (coalesce(cl.ended_at, now()) - cl.started_at)) / 86400.0, 0))
        )
      end * coalesce(cl.contract_fx_rate_applied, 1::numeric),
      2
    ) as vendor_obligation_reporting_amount
  from contract_lines cl
),
asset_dimensions as (
  select
    assets.entity_id as asset_id,
    assets.name as asset_name,
    lower(coalesce(assets.data ->> 'ownership_type', 'owned')) as ownership_type,
    public.parse_numeric_or_null(assets.data ->> 'calendar_minutes') as calendar_minutes_override
  from public.rental_current_entity_state assets
  where assets.entity_type = 'asset'
),
branch_dimensions as (
  select
    branch.entity_id as branch_id,
    branch.name as branch_name
  from public.rental_current_entity_state branch
  where branch.entity_type = 'branch'
),
asset_calendar_facts as (
  select
    ef.entity_id as asset_id,
    max(ef.value) as calendar_minutes
  from public.entity_facts ef
  join public.fact_types ft
    on ft.id = ef.fact_type_id
  where ft.key = 'asset_calendar_minutes'
  group by ef.entity_id
),
rerent_current as (
  select
    order_line_id,
    status_key,
    status_label,
    vendor_ref,
    changed_at
  from public.v_rerent_unit_current_status
),
classified as (
  select
    usage.contract_line_id,
    usage.contract_id,
    usage.order_line_id,
    usage.asset_id,
    assets.asset_name,
    assets.ownership_type as asset_ownership_type,
    usage.branch_id,
    branches.branch_name,
    usage.contract_line_status,
    usage.rental_type,
    usage.started_at,
    usage.ended_at,
    usage.elapsed_minutes,
    usage.reporting_currency_code,
    usage.tenant_key,
    coalesce(invoices.invoice_count, 0) as invoice_count,
    invoices.invoice_reference,
    coalesce(
      invoices.latest_invoice_date,
      usage.ended_at::date,
      usage.started_at::date
    ) as reporting_date,
    coalesce(invoices.customer_revenue_reporting_amount, 0::numeric) as customer_revenue_reporting_amount,
    usage.vendor_obligation_reporting_amount,
    coalesce(assets.calendar_minutes_override, calendar_facts.calendar_minutes, 0::numeric) as asset_calendar_minutes,
    rerent.status_key as rerent_status_key,
    rerent.status_label as rerent_status_label,
    rerent.vendor_ref,
    rerent.changed_at as vendor_reference_updated_at,
    case
      when rerent.order_line_id is not null
        or coalesce(assets.ownership_type, 'owned') <> 'owned'
        then 'third_party_rerental'
      when usage.rental_type = 'external'
        then 'owned_fleet_external_rental'
      else 'other'
    end as fulfillment_model
  from line_usage usage
  left join line_invoice_rollups invoices
    on invoices.contract_line_id = usage.contract_line_id
  left join asset_dimensions assets
    on assets.asset_id = usage.asset_id
  left join branch_dimensions branches
    on branches.branch_id = usage.branch_id
  left join asset_calendar_facts calendar_facts
    on calendar_facts.asset_id = usage.asset_id
  left join rerent_current rerent
    on rerent.order_line_id = usage.order_line_id
)
select
  contract_line_id as reporting_line_id,
  contract_line_id,
  contract_id,
  order_line_id,
  asset_id,
  asset_name,
  branch_id,
  branch_name,
  reporting_date,
  invoice_count,
  invoice_reference,
  contract_line_status,
  rental_type,
  asset_ownership_type,
  fulfillment_model,
  customer_revenue_reporting_amount,
  case
    when fulfillment_model = 'third_party_rerental'
      then vendor_obligation_reporting_amount
    else 0::numeric
  end as vendor_obligation_reporting_amount,
  round(
    customer_revenue_reporting_amount
    - case
        when fulfillment_model = 'third_party_rerental'
          then vendor_obligation_reporting_amount
        else 0::numeric
      end,
    2
  ) as gross_margin_reporting_amount,
  case
    when fulfillment_model = 'owned_fleet_external_rental'
      then elapsed_minutes
    else 0::numeric
  end as utilization_uplift_minutes,
  coalesce(asset_calendar_minutes, 0::numeric) as asset_calendar_minutes,
  case
    when fulfillment_model = 'owned_fleet_external_rental'
      and coalesce(asset_calendar_minutes, 0::numeric) > 0
      then round((elapsed_minutes / asset_calendar_minutes) * 100.0, 2)
    else 0::numeric
  end as utilization_uplift_pct,
  rerent_status_key,
  rerent_status_label,
  vendor_ref,
  vendor_reference_updated_at,
  case
    when fulfillment_model <> 'third_party_rerental' then 'not_applicable'
    when coalesce(nullif(vendor_ref, ''), '') <> '' then 'captured'
    else 'missing'
  end as obligation_reference_status,
  reporting_currency_code,
  'customer_revenue_reporting_amount from canonical invoice_line amounts in reporting currency; '
    || 'vendor_obligation_reporting_amount accrues rental_contract_line rate_amount × elapsed units for third-party rerent fulfillment; '
    || 'utilization_uplift_pct = external-rental elapsed minutes / asset calendar_minutes for owned assets.' as formula_reference
from classified
cross join request_context req
where fulfillment_model in ('owned_fleet_external_rental', 'third_party_rerental')
  and (
    req.request_role = 'service_role'
    or coalesce(nullif(tenant_key, ''), 'default') = coalesce(nullif(req.request_tenant, ''), 'default')
  );

revoke all on public.v_external_rental_reporting_lines from public, anon;
grant select on public.v_external_rental_reporting_lines to authenticated, service_role;
grant select on public.dim_rerent_unit_status to service_role;
