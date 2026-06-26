-- DIA — Fast BI: corrige a camada analítica de PEÇAS (issue #18 follow-up)
-- Created: 2026-06-27
--
-- Problema: v_dia_parts_summary e os CTEs de peças de v_dia_owner_kpis foram
-- escritos DEFENSIVAMENTE (migration 20260625170000) ANTES das entidades reais
-- de peças existirem (#8 part / #10 part_sale). Eles liam:
--   * entity_type 'parts_sale'  (errado — o tipo real é 'part_sale')
--   * campos 'value'/'unit_value'/'quantity' e 'stock_status' do JSON
--     (errado — a peça real usa unit_cost/quantity_in_stock; stock_value e
--      stock_status são DERIVADOS na view canônica v_dia_part_current)
-- Resultado: o dashboard de Peças mostrava tudo zerado mesmo com dados no banco.
--
-- Correção: recriar as duas views lendo das views canônicas já corretas:
--   * v_dia_part_current      (estoque: stock_value, stock_status derivados)
--   * v_dia_part_sale_current (vendas: total derivado, exclui 'cancelada',
--                              sale_date como texto 'YYYY-MM-DD')
-- As vendas de peças do seed são ancoradas no MÊS CORRENTE (conceito #46), então
-- o gráfico de vendas e os KPIs de venda refletem o mês atual.
--
-- Só CREATE OR REPLACE de views (sem mudança de contrato de colunas) — o frontend
-- (PartsBI.tsx) continua igual: inventário = linhas com period_month nulo;
-- vendas = linhas com period_month preenchido.

-- ---------------------------------------------------------------------------
-- 1. v_dia_parts_summary — inventário por stock_status + vendas por mês.
--    UNION ALL de (a) linhas de inventário e (b) linhas de venda, mantendo o
--    mesmo contrato de colunas: stock_status, inventory_value, period_month,
--    units_sold, revenue.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_parts_summary
with (security_invoker = true) as
with inventory_rows as (
  select
    stock_status,
    coalesce(sum(stock_value), 0)::numeric(18,2) as inventory_value,
    null::date                                   as period_month,
    null::numeric                                as units_sold,
    null::numeric(18,2)                          as revenue
  from public.v_dia_part_current
  group by stock_status
),
sales_rows as (
  select
    null::text                                       as stock_status,
    null::numeric(18,2)                              as inventory_value,
    date_trunc('month', nullif(sale_date, '')::date)::date as period_month,
    coalesce(sum(quantity), 0)::numeric              as units_sold,
    coalesce(sum(total), 0)::numeric(18,2)           as revenue
  from public.v_dia_part_sale_current
  where coalesce(sale_date, '') ~ '^\d{4}-\d{2}-\d{2}'
  group by date_trunc('month', nullif(sale_date, '')::date)::date
)
select stock_status, inventory_value, period_month, units_sold, revenue from inventory_rows
union all
select stock_status, inventory_value, period_month, units_sold, revenue from sales_rows;

grant select on table public.v_dia_parts_summary to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. v_dia_owner_kpis — mesma forma de 20260625170000, mas os CTEs de peças
--    passam a ler v_dia_part_current. parts_inventory_value = soma de stock_value;
--    parts_critical_count = peças em estado 'critico' ou 'zerado' (rótulo do KPI
--    "Peças críticas/zeradas"). Os CTEs de veículos e oficina são preservados.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_owner_kpis
with (security_invoker = true) as
with input_patterns as (
  select '^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:\d{2})?)?$'::text as iso_date_or_timestamp
),
sold as (
  select
    vc.cost,
    vc.sale_price,
    coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ (select iso_date_or_timestamp from input_patterns)
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) as sale_date
  from public.v_dia_vehicle_current vc
  left join public.rental_current_entity_state rces
    on rces.entity_id = vc.entity_id
   and rces.entity_type = 'vehicle'
  where vc.status = 'vendido'
),
sales_month as (
  select
    coalesce(count(*), 0)                         as sales_units_month,
    coalesce(sum(sale_price), 0)::numeric(18,2)   as sales_revenue_month,
    coalesce(sum(sale_price - cost), 0)::numeric(18,2) as margin_month
  from sold
  where date_trunc('month', sale_date) = date_trunc('month', now())
),
inventory as (
  select
    coalesce(sum(cost), 0)::numeric(18,2)            as inventory_vehicle_value,
    coalesce(sum(floor_plan_cost), 0)::numeric(18,2) as floor_plan_total,
    coalesce(avg(days_in_stock), 0)::numeric(18,2)   as avg_days_in_stock
  from public.v_dia_vehicle_current
  where status = 'em_estoque'
),
service_orders as (
  select
    lower(coalesce(nullif(rces.data ->> 'status', ''), 'open')) as status,
    case
      when coalesce(rces.data ->> 'revenue', '') ~ '^-?\d+(\.\d+)?$'
        then (rces.data ->> 'revenue')::numeric
      else 0::numeric
    end as revenue,
    case
      when coalesce(rces.data ->> 'opened_at', '') ~ (select iso_date_or_timestamp from input_patterns)
        then nullif(rces.data ->> 'opened_at', '')::date
      else null
    end as opened_at,
    case
      when coalesce(rces.data ->> 'closed_at', '') ~ (select iso_date_or_timestamp from input_patterns)
        then nullif(rces.data ->> 'closed_at', '')::date
      else null
    end as closed_at
  from public.rental_current_entity_state rces
  where rces.entity_type = 'service_order'
),
service_kpis as (
  select
    coalesce(count(*) filter (
      where status not in ('closed', 'completed', 'cancelled', 'entregue', 'finalizado')
    ), 0) as service_orders_open,
    coalesce(sum(revenue) filter (
      where date_trunc('month', coalesce(opened_at, closed_at)) = date_trunc('month', now())
    ), 0)::numeric(18,2) as service_revenue_month,
    coalesce(avg(closed_at - opened_at), 0)::numeric(18,2) as service_avg_turnaround
  from service_orders
),
parts_kpis as (
  select
    coalesce(sum(stock_value), 0)::numeric(18,2) as parts_inventory_value,
    coalesce(count(*) filter (
      where stock_status in ('critico', 'zerado')
    ), 0) as parts_critical_count
  from public.v_dia_part_current
)
select
  now() as as_of,
  sales_month.sales_units_month,
  sales_month.sales_revenue_month,
  sales_month.margin_month,
  service_kpis.service_orders_open,
  service_kpis.service_revenue_month,
  service_kpis.service_avg_turnaround,
  inventory.inventory_vehicle_value,
  inventory.floor_plan_total,
  inventory.avg_days_in_stock,
  parts_kpis.parts_inventory_value,
  parts_kpis.parts_critical_count
from sales_month
cross join inventory
cross join service_kpis
cross join parts_kpis;

grant select on table public.v_dia_owner_kpis to authenticated, service_role;
