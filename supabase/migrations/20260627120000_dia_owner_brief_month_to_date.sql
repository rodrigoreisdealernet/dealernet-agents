-- DIA — Morning Brief do Dono: muda o conceito de "dia anterior" para MÊS ATUAL
-- (month-to-date) e conecta de fato os setores Peças e AT/Oficina. (issue #46/#43)
-- Created: 2026-06-27
--
-- POR QUÊ:
--   O brief originalmente agregava apenas o DIA ANTERIOR (now()::date - 1). Com o
--   volume semeado distribuído ao longo de meses, a tela ficava quase vazia. O
--   conceito do painel passa a ser o MÊS CORRENTE acumulado (do 1º dia do mês até
--   agora), mostrando o volume real do negócio. Floor Plan continua "as of now"
--   (estoque atual), pois não é métrica de período.
--
-- ALÉM DA JANELA, CORRIGE 3 DEFEITOS DO SETOR PEÇAS (a view original nunca o
-- populava, mesmo com seed):
--   1) entity_type lido era 'parts_sale' — o tipo real é 'part_sale' (singular).
--   2) a data filtrada era 'sold_at' — part_sale grava 'sale_date'.
--   3) o valor lia data->>'total'/'revenue' — total NÃO é persistido (é derivado);
--      passa a calcular quantity*unit_price - coalesce(discount,0) e exclui vendas
--      'cancelada'.
--   AT/Oficina passa a somar 'revenue' das OS abertas NO MÊS (status<>'cancelada').
--
-- Mantém EXATAMENTE o mesmo shape de colunas das duas views (o frontend e os
-- testes de contrato dependem dele). security_invoker=true preservado.
-- O helper dia_owner_brief_at_risk_days() (= 83) permanece inalterado.

-- ---------------------------------------------------------------------------
-- 1. v_dia_owner_brief_by_brand — uma linha por marca, ACUMULADO DO MÊS.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_owner_brief_by_brand
with (security_invoker = true) as
with input_patterns as (
  select -- Aceita data pura (YYYY-MM-DD) e timestamp ISO com offset +HH, +HH:MM ou +HHMM
-- (Postgres to_char(...,'OF') emite '+00' para UTC, sem minutos).
'^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}(:?\d{2})?)?)?$'::text as iso_date_or_timestamp,
         '^-?\d+(\.\d+)?$'::text as numeric_str
),
month_window as (
  select date_trunc('month', now())::date                          as start_d,
         (date_trunc('month', now()) + interval '1 month')::date    as end_d
),
at_risk as (
  select public.dia_owner_brief_at_risk_days() as days
),
-- Veículos vendidos NO MÊS, com a mesma derivação de data de v_dia_sales_summary.
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
  cross join month_window mw
  where vc.status = 'vendido'
    and coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ ip.iso_date_or_timestamp
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) >= mw.start_d
    and coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ ip.iso_date_or_timestamp
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) < mw.end_d
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
-- Vendas de peça NO MÊS (entity_type 'part_sale'; exclui 'cancelada').
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
  cross join month_window mw
  where rces.entity_type = 'part_sale'
    and coalesce(nullif(rces.data ->> 'status', ''), 'registrada') <> 'cancelada'
    and case
      when coalesce(rces.data ->> 'sale_date', '') ~ ip.iso_date_or_timestamp
        then nullif(rces.data ->> 'sale_date', '')::date
      else null
    end >= mw.start_d
    and case
      when coalesce(rces.data ->> 'sale_date', '') ~ ip.iso_date_or_timestamp
        then nullif(rces.data ->> 'sale_date', '')::date
      else null
    end < mw.end_d
),
-- Ordens de serviço (AT/Oficina) abertas NO MÊS (exclui 'cancelada').
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
  cross join month_window mw
  where rces.entity_type = 'service_order'
    and coalesce(nullif(rces.data ->> 'status', ''), 'aberta') <> 'cancelada'
    and case
      when coalesce(rces.data ->> 'opened_at', '') ~ ip.iso_date_or_timestamp
        then nullif(rces.data ->> 'opened_at', '')::date
      else null
    end >= mw.start_d
    and case
      when coalesce(rces.data ->> 'opened_at', '') ~ ip.iso_date_or_timestamp
        then nullif(rces.data ->> 'opened_at', '')::date
      else null
    end < mw.end_d
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
--    ACUMULADO DO MÊS. Peças/AT seguem NULL aqui (sem atribuição por loja).
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_owner_brief_by_store
with (security_invoker = true) as
with input_patterns as (
  select -- Aceita data pura (YYYY-MM-DD) e timestamp ISO com offset +HH, +HH:MM ou +HHMM
-- (Postgres to_char(...,'OF') emite '+00' para UTC, sem minutos).
'^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}(:?\d{2})?)?)?$'::text as iso_date_or_timestamp
),
month_window as (
  select date_trunc('month', now())::date                          as start_d,
         (date_trunc('month', now()) + interval '1 month')::date    as end_d
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
  cross join month_window mw
  where vc.status = 'vendido'
    and coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ ip.iso_date_or_timestamp
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) >= mw.start_d
    and coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ ip.iso_date_or_timestamp
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) < mw.end_d
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
