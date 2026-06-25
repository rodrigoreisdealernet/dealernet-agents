-- Enterprise multi-currency support
-- Adds shared FX-rate storage and reporting views that preserve per-document
-- transaction currency while enabling reporting-currency rollups.

create table if not exists fx_rates (
  id uuid primary key default gen_random_uuid(),
  base_currency_code text not null,
  quote_currency_code text not null,
  rate numeric(18,8) not null,
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fx_rates_base_code_format check (base_currency_code ~ '^[A-Z]{3}$'),
  constraint chk_fx_rates_quote_code_format check (quote_currency_code ~ '^[A-Z]{3}$'),
  constraint chk_fx_rates_positive_rate check (rate > 0)
);

create trigger trg_fx_rates_updated_at
  before update on fx_rates
  for each row execute function update_updated_at();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'uq_fx_rates_pair_effective_at'
      and conrelid = 'fx_rates'::regclass
  ) then
    alter table fx_rates
      add constraint uq_fx_rates_pair_effective_at
      unique (base_currency_code, quote_currency_code, effective_at);
  end if;
end;
$$;

create index if not exists idx_fx_rates_pair_effective_desc
  on fx_rates (base_currency_code, quote_currency_code, effective_at desc);

revoke all on table public.fx_rates from public, anon;
grant select on table public.fx_rates to authenticated;
grant select, insert, update, delete on table public.fx_rates to service_role;

alter table public.fx_rates enable row level security;

drop policy if exists fx_rates_authenticated_read on public.fx_rates;
create policy fx_rates_authenticated_read
  on public.fx_rates
  for select
  to authenticated
  using (true);

drop policy if exists fx_rates_service_role_all on public.fx_rates;
create policy fx_rates_service_role_all
  on public.fx_rates
  for all
  to service_role
  using (true)
  with check (true);

create or replace view v_commercial_document_currency_snapshots
with (security_invoker = true) as
select
  e.id as entity_id,
  e.entity_type,
  coalesce(
    nullif(ev.data ->> 'invoice_number', ''),
    nullif(ev.data ->> 'contract_number', ''),
    nullif(ev.data ->> 'order_number', ''),
    e.id::text
  ) as document_number,
  coalesce(ev.data ->> 'status', '') as document_status,
  upper(coalesce(nullif(ev.data ->> 'transaction_currency_code', ''), 'USD')) as transaction_currency_code,
  upper(coalesce(nullif(ev.data ->> 'reporting_currency_code', ''), nullif(ev.data ->> 'transaction_currency_code', ''), 'USD')) as reporting_currency_code,
  case
    when coalesce(ev.data ->> 'fx_rate_applied', '') ~ '^-?[0-9]+(\\.[0-9]+)?$' then (ev.data ->> 'fx_rate_applied')::numeric
    else null
  end as fx_rate_applied,
  case
    when coalesce(ev.data ->> 'fx_rate_effective_at', '') <> '' then (ev.data ->> 'fx_rate_effective_at')::timestamptz
    else null
  end as fx_rate_effective_at,
  ev.valid_from,
  ev.created_at as version_created_at,
  ev.data as document_data
from entities e
join entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
where e.entity_type in ('rental_order', 'rental_contract', 'invoice');

revoke all on table public.v_commercial_document_currency_snapshots from public, anon;
grant select on table public.v_commercial_document_currency_snapshots to authenticated, service_role;

create or replace view v_invoice_currency_rollups
with (security_invoker = true) as
with invoice_docs as (
  select *
  from v_commercial_document_currency_snapshots
  where entity_type = 'invoice'
), parsed as (
  select
    entity_id as invoice_id,
    document_number as invoice_number,
    document_status as invoice_status,
    transaction_currency_code,
    reporting_currency_code,
    fx_rate_applied,
    fx_rate_effective_at,
    case
      when coalesce(document_data ->> 'total', '') ~ '^-?[0-9]+(\\.[0-9]+)?$' then (document_data ->> 'total')::numeric
      else 0::numeric
    end as transaction_total
  from invoice_docs
), enriched as (
  select
    p.*,
    fx.rate as fx_rate_lookup
  from parsed p
  left join lateral (
    select fr.rate
    from fx_rates fr
    where fr.base_currency_code = p.transaction_currency_code
      and fr.quote_currency_code = p.reporting_currency_code
      and fr.effective_at <= coalesce(p.fx_rate_effective_at, now())
    order by fr.effective_at desc
    limit 1
  ) fx on true
)
select
  invoice_id,
  invoice_number,
  invoice_status,
  transaction_currency_code,
  reporting_currency_code,
  transaction_total as transaction_total_amount,
  case
    when reporting_currency_code = transaction_currency_code then 1::numeric
    when fx_rate_applied is not null then fx_rate_applied
    else fx_rate_lookup
  end as fx_rate_used,
  fx_rate_effective_at,
  case
    when reporting_currency_code = transaction_currency_code then 'identity'
    when fx_rate_applied is not null then 'snapshot'
    when fx_rate_lookup is not null then 'lookup'
    else 'missing'
  end as fx_rate_source,
  round(
    transaction_total * coalesce(
      case
        when reporting_currency_code = transaction_currency_code then 1::numeric
        when fx_rate_applied is not null then fx_rate_applied
        else fx_rate_lookup
      end,
      0::numeric
    ),
    2
  ) as reporting_total_amount
from enriched;

revoke all on table public.v_invoice_currency_rollups from public, anon;
grant select on table public.v_invoice_currency_rollups to authenticated, service_role;

create or replace view v_invoice_reporting_currency_rollups
with (security_invoker = true) as
select
  reporting_currency_code,
  count(*) as invoice_count,
  round(sum(transaction_total_amount), 2) as transaction_total_amount,
  round(sum(reporting_total_amount), 2) as reporting_total_amount
from v_invoice_currency_rollups
group by reporting_currency_code;

revoke all on table public.v_invoice_reporting_currency_rollups from public, anon;
grant select on table public.v_invoice_reporting_currency_rollups to authenticated, service_role;
