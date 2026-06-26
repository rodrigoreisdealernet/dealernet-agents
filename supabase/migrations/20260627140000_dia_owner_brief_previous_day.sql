-- DIA — Morning Brief do Dono: reverte a janela de MÊS CORRENTE (MTD) de volta
-- para o DIA ANTERIOR (now()::date - 1), preservando integralmente as correções
-- de Peças e AT/Oficina introduzidas no MTD. (issue #91)
-- Created: 2026-06-27
--
-- POR QUÊ:
--   O brief originalmente agregava apenas o DIA ANTERIOR (now()::date - 1) — a
--   mensagem matinal de "como fechou ontem" (issue #43). Foi migrado para MTD na
--   migration 20260627120000 porque o seed histórico (distribuído ao longo de
--   meses) deixava a tela vazia. A issue #85 passou a semear transações datadas
--   de ontem, eliminando o motivo do MTD. A decisão de produto (issue #91) é
--   reverter SOMENTE a janela temporal para o dia anterior, mantendo intactas as
--   correções de Peças/AT que vieram junto no MTD.
--
-- O QUE MUDA vs. 20260627120000_dia_owner_brief_month_to_date.sql:
--   APENAS a janela temporal. O CTE `month_window` (start_d = 1º dia do mês,
--   end_d = 1º dia do próximo mês) é substituído por `day_window` com um único
--   valor `prev_day = now()::date - 1`. Cada setor de período (Novos/Usados,
--   Peças, AT) passa a comparar sua data com IGUALDADE a prev_day, em vez do
--   intervalo [start_d, end_d).
--
-- O QUE NÃO MUDA (preservado byte-a-byte em intenção):
--   - Correções de Peças: entity_type 'part_sale' (singular), filtra 'sale_date',
--     valor = quantity*unit_price - coalesce(discount,0), exclui 'cancelada'.
--   - Correção de AT/Oficina: soma 'revenue' das OS (mesmo campo de data
--     'opened_at'), exclui 'cancelada'.
--   - Floor Plan continua "as of now" (estoque atual), SEM filtro de período.
--   - Mesmo shape de colunas das duas views (frontend + testes de contrato).
--   - security_invoker=true preservado; grants a authenticated/service_role.
--   - O helper dia_owner_brief_at_risk_days() (= 83) permanece INALTERADO.

-- ---------------------------------------------------------------------------
-- 1. v_dia_owner_brief_by_brand — uma linha por marca, DIA ANTERIOR.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_owner_brief_by_brand
with (security_invoker = true) as
with input_patterns as (
  select -- Aceita data pura (YYYY-MM-DD) e timestamp ISO com offset +HH, +HH:MM ou +HHMM
-- (Postgres to_char(...,'OF') emite '+00' para UTC, sem minutos).
'^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}(:?\d{2})?)?)?$'::text as iso_date_or_timestamp,
         '^-?\d+(\.\d+)?$'::text as numeric_str
),
day_window as (
  select (now()::date - 1) as prev_day
),
at_risk as (
  select public.dia_owner_brief_at_risk_days() as days
),
-- Veículos vendidos NO DIA ANTERIOR, com a mesma derivação de data de v_dia_sales_summary.
sold as (
  select
    coalesce(nullif(btrim(vc.brand), ''), 'Sem marca') as brand_key,
    nullif(btrim(vc.store), '')                        as store,
    vc.condition,
    vc.sale_price,
    vc.cost
  from public.v_dia_vehicle_current vc
  left join public.rental_current_entity_state rces
    on rces.entity_id = vc.entity_id
   and rces.entity_type = 'vehicle'
  cross join input_patterns ip
  cross join day_window dw
  where vc.status = 'vendido'
    and coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ ip.iso_date_or_timestamp
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) = dw.prev_day
),
-- Veículos em estoque (floor plan) — NÃO filtrado por data (estoque "as of now").
in_stock as (
  select
    coalesce(nullif(btrim(vc.brand), ''), 'Sem marca') as brand_key,
    nullif(btrim(vc.store), '')                        as store,
    vc.floor_plan_cost,
    vc.days_in_stock
  from public.v_dia_vehicle_current vc
  where vc.status = 'em_estoque'
),
-- Vendas de peça NO DIA ANTERIOR (entity_type 'part_sale'; exclui 'cancelada').
-- Valor = quantity*unit_price - coalesce(discount,0) (total não é persistido).
parts AS (
  select
    sum(
      coalesce(
        case when coalesce(rces.data ->> 'quantity', '')   ~ ip.numeric_str then (rces.data ->> 'quantity')::numeric   else 0 end
        * case when coalesce(rces.data ->> 'unit_price', '') ~ ip.numeric_str then (rces.data ->> 'unit_price')::numeric else 0 end
        - case when coalesce(rces.data ->> 'discount', '')   ~ ip.numeric_str then (rces.data ->> 'discount')::numeric   else 0 end,
        0
      )
    )::numeric(18,2) as pecas_value,
    -- Sem base de custo confiável por venda no agregado → margem NULL (UI: "—").
    null::numeric(18,2)  as pecas_margin
  from public.rental_current_entity_state rces
  cross join input_patterns ip
  cross join day_window dw
  where rces.entity_type = 'part_sale'
    and coalesce(nullif(rces.data ->> 'status', ''), 'registrada') <> 'cancelada'
    and case
      when coalesce(rces.data ->> 'sale_date', '') ~ ip.iso_date_or_timestamp
        then nullif(rces.data ->> 'sale_date', '')::date
      else null
    end = dw.prev_day
),
-- Ordens de serviço (AT/Oficina) abertas NO DIA ANTERIOR (exclui 'cancelada').
service AS (
  select
    sum(
      case
        when coalesce(rces.data ->> 'revenue', '') ~ ip.numeric_str then (rces.data ->> 'revenue')::numeric
        else 0::numeric
      end
    )::numeric(18,2) as at_value,
    null::numeric(18,2)  as at_margin
  from public.rental_current_entity_state rces
  cross join input_patterns ip
  cross join day_window dw
  where rces.entity_type = 'service_order'
    and coalesce(nullif(rces.data ->> 'status', ''), 'aberta') <> 'cancelada'
    and case
      when coalesce(rces.data ->> 'opened_at', '') ~ ip.iso_date_or_timestamp
        then nullif(rces.data ->> 'opened_at', '')::date
      else null
    end = dw.prev_day
),
brand_keys as (
  select distinct brand_key from (
    select brand_key from sold
    union all
    select brand_key from in_stock
  ) u
),
sold_agg as (
  select
    brand_key,
    count(*) filter (where condition = 'novo')                                   as novos_units,
    sum(sale_price) filter (where condition = 'novo')                            as novos_value,
    sum(sale_price - cost) filter (where condition = 'novo')                     as novos_margin,
    count(*) filter (where condition = 'usado')                                  as usados_units,
    sum(sale_price) filter (where condition = 'usado')                           as usados_value,
    sum(sale_price - cost) filter (where condition = 'usado')                    as usados_margin
  from sold
  group by brand_key
),
stock_agg as (
  select
    i.brand_key,
    count(*)                                                                     as fp_units,
    sum(i.floor_plan_cost)                                                       as fp_value,
    count(*) filter (where i.days_in_stock >= (select days from at_risk))        as fp_units_at_risk,
    sum(i.floor_plan_cost) filter (where i.days_in_stock >= (select days from at_risk)) as fp_value_at_risk
  from in_stock i
  group by i.brand_key
)
select
  bk.brand_key                                                                   as brand_name,
  null::uuid                                                                     as brand_id,
  (
    select count(distinct st) from (
      select store as st from sold     where brand_key = bk.brand_key and store is not null
      union
      select store as st from in_stock where brand_key = bk.brand_key and store is not null
    ) s
  )::int                                                                         as store_count,
  sa.novos_units,
  sa.novos_value::numeric(18,2)                                                  as novos_value,
  sa.novos_margin::numeric(18,2)                                                 as novos_margin,
  sa.usados_units,
  sa.usados_value::numeric(18,2)                                                 as usados_value,
  sa.usados_margin::numeric(18,2)                                                as usados_margin,
  -- Peças / AT são group-wide (sem atribuição por marca no seed) → expostos
  -- identicamente por linha; a UI soma uma vez via o total do grupo.
  p.pecas_value,
  p.pecas_margin,
  s.at_value,
  s.at_margin,
  coalesce(stk.fp_units, 0)                                                      as fp_units,
  stk.fp_value::numeric(18,2)                                                    as fp_value,
  coalesce(stk.fp_units_at_risk, 0)                                              as fp_units_at_risk,
  coalesce(stk.fp_value_at_risk, 0)::numeric(18,2)                               as fp_value_at_risk,
  -- resultado POR MARCA = só os setores atribuíveis à marca (Novos + Usados),
  -- igual a by_store. Peças/AT são group-wide (não atribuíveis por marca) e
  -- entram apenas no Grupo Total da UI (somados UMA vez, não por marca).
  (coalesce(sa.novos_value, 0) + coalesce(sa.usados_value, 0))::numeric(18,2)    as resultado
from brand_keys bk
left join sold_agg  sa  on sa.brand_key  = bk.brand_key
left join stock_agg stk on stk.brand_key = bk.brand_key
cross join parts p
cross join service s;

grant select on table public.v_dia_owner_brief_by_brand to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. v_dia_owner_brief_by_store — mesmo shape, uma linha por (marca, loja),
--    DIA ANTERIOR. Peças/AT seguem NULL aqui (sem atribuição por loja).
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_owner_brief_by_store
with (security_invoker = true) as
with input_patterns as (
  select -- Aceita data pura (YYYY-MM-DD) e timestamp ISO com offset +HH, +HH:MM ou +HHMM
-- (Postgres to_char(...,'OF') emite '+00' para UTC, sem minutos).
'^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}(:?\d{2})?)?)?$'::text as iso_date_or_timestamp
),
day_window as (
  select (now()::date - 1) as prev_day
),
at_risk as (
  select public.dia_owner_brief_at_risk_days() as days
),
sold as (
  select
    coalesce(nullif(btrim(vc.brand), ''), 'Sem marca') as brand_key,
    coalesce(nullif(btrim(vc.store), ''), 'Sem loja')  as store_key,
    vc.condition,
    vc.sale_price,
    vc.cost
  from public.v_dia_vehicle_current vc
  left join public.rental_current_entity_state rces
    on rces.entity_id = vc.entity_id
   and rces.entity_type = 'vehicle'
  cross join input_patterns ip
  cross join day_window dw
  where vc.status = 'vendido'
    and coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ ip.iso_date_or_timestamp
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) = dw.prev_day
),
in_stock as (
  select
    coalesce(nullif(btrim(vc.brand), ''), 'Sem marca') as brand_key,
    coalesce(nullif(btrim(vc.store), ''), 'Sem loja')  as store_key,
    vc.floor_plan_cost,
    vc.days_in_stock
  from public.v_dia_vehicle_current vc
  where vc.status = 'em_estoque'
),
keys as (
  select distinct brand_key, store_key from (
    select brand_key, store_key from sold
    union all
    select brand_key, store_key from in_stock
  ) u
),
sold_agg as (
  select
    brand_key, store_key,
    count(*) filter (where condition = 'novo')                as novos_units,
    sum(sale_price) filter (where condition = 'novo')         as novos_value,
    sum(sale_price - cost) filter (where condition = 'novo')  as novos_margin,
    count(*) filter (where condition = 'usado')               as usados_units,
    sum(sale_price) filter (where condition = 'usado')        as usados_value,
    sum(sale_price - cost) filter (where condition = 'usado') as usados_margin
  from sold
  group by brand_key, store_key
),
stock_agg as (
  select
    brand_key, store_key,
    count(*)                                                               as fp_units,
    sum(floor_plan_cost)                                                   as fp_value,
    count(*) filter (where days_in_stock >= (select days from at_risk))    as fp_units_at_risk,
    sum(floor_plan_cost) filter (where days_in_stock >= (select days from at_risk)) as fp_value_at_risk
  from in_stock
  group by brand_key, store_key
)
select
  k.brand_key                                          as brand_name,
  null::uuid                                           as brand_id,
  k.store_key                                          as store_name,
  sa.novos_units,
  sa.novos_value::numeric(18,2)                        as novos_value,
  sa.novos_margin::numeric(18,2)                       as novos_margin,
  sa.usados_units,
  sa.usados_value::numeric(18,2)                       as usados_value,
  sa.usados_margin::numeric(18,2)                      as usados_margin,
  null::numeric(18,2)                                  as pecas_value,
  null::numeric(18,2)                                  as pecas_margin,
  null::numeric(18,2)                                  as at_value,
  null::numeric(18,2)                                  as at_margin,
  coalesce(stk.fp_units, 0)                            as fp_units,
  stk.fp_value::numeric(18,2)                          as fp_value,
  coalesce(stk.fp_units_at_risk, 0)                    as fp_units_at_risk,
  coalesce(stk.fp_value_at_risk, 0)::numeric(18,2)     as fp_value_at_risk,
  (coalesce(sa.novos_value, 0) + coalesce(sa.usados_value, 0))::numeric(18,2) as resultado
from keys k
left join sold_agg  sa  on sa.brand_key = k.brand_key and sa.store_key = k.store_key
left join stock_agg stk on stk.brand_key = k.brand_key and stk.store_key = k.store_key;

grant select on table public.v_dia_owner_brief_by_store to authenticated, service_role;
