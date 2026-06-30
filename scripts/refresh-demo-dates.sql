-- refresh-demo-dates.sql — desliza as datas de FLUXO (vendas, vendas de peça e
-- ordens de serviço) para que o registro mais recente caia em "hoje", fazendo o
-- Cockpit Matinal / Morning Brief (que mostram now()::date - 1) terem dados.
--
-- Por que: o seed data as transações em datas fixas próximas da data do seed.
-- Conforme os dias passam, "ontem" sai da janela seedada e o cockpit zera as
-- métricas de fluxo (Resultado/Novos/Usados/Peças/Oficina). Floor Plan e Contas
-- a Receber NÃO são tocados (preservam aging/carência e os findings dos agentes).
--
-- Modelo: os dados ficam em entity_versions.data (is_current), expostos via a
-- view rental_current_entity_state (JOIN entities). Atualizamos a versão atual.
--
-- Idempotente-ish: cada execução recomputa o offset = hoje - max(sold_at) e só
-- desliza para frente (offset > 0). Rode na manhã da demo para máxima frescura.

do $$
declare
  v_offset int;
begin
  select (now()::date - max((ev.data ->> 'sold_at')::date))
    into v_offset
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where ev.is_current
    and e.entity_type = 'vehicle'
    and ev.data ->> 'status' = 'vendido'
    and (ev.data ->> 'sold_at') ~ '^\d{4}-\d{2}-\d{2}';

  if v_offset is null or v_offset <= 0 then
    raise notice 'refresh-demo-dates: nada a deslizar (offset=%).', v_offset;
    return;
  end if;

  -- Veiculos vendidos: sold_at
  update entity_versions ev set data = jsonb_set(ev.data, '{sold_at}',
           to_jsonb(((left(ev.data ->> 'sold_at', 10)::date + v_offset)::text)
                    || coalesce(substr(ev.data ->> 'sold_at', 11), '')))
   from entities e
   where e.id = ev.entity_id and ev.is_current
     and e.entity_type = 'vehicle'
     and (ev.data ->> 'sold_at') ~ '^\d{4}-\d{2}-\d{2}';

  -- Vendas de pecas: sale_date
  update entity_versions ev set data = jsonb_set(ev.data, '{sale_date}',
           to_jsonb(((left(ev.data ->> 'sale_date', 10)::date + v_offset)::text)
                    || coalesce(substr(ev.data ->> 'sale_date', 11), '')))
   from entities e
   where e.id = ev.entity_id and ev.is_current
     and e.entity_type = 'part_sale'
     and (ev.data ->> 'sale_date') ~ '^\d{4}-\d{2}-\d{2}';

  -- Ordens de servico: opened_at e closed_at (preservando o sufixo de horario)
  update entity_versions ev set data = jsonb_set(ev.data, '{opened_at}',
           to_jsonb(((left(ev.data ->> 'opened_at', 10)::date + v_offset)::text)
                    || coalesce(substr(ev.data ->> 'opened_at', 11), '')))
   from entities e
   where e.id = ev.entity_id and ev.is_current
     and e.entity_type = 'service_order'
     and (ev.data ->> 'opened_at') ~ '^\d{4}-\d{2}-\d{2}';

  update entity_versions ev set data = jsonb_set(ev.data, '{closed_at}',
           to_jsonb(((left(ev.data ->> 'closed_at', 10)::date + v_offset)::text)
                    || coalesce(substr(ev.data ->> 'closed_at', 11), '')))
   from entities e
   where e.id = ev.entity_id and ev.is_current
     and e.entity_type = 'service_order'
     and (ev.data ->> 'closed_at') ~ '^\d{4}-\d{2}-\d{2}';

  raise notice 'refresh-demo-dates: datas de fluxo deslizadas +% dias (max -> hoje).', v_offset;
end $$;
