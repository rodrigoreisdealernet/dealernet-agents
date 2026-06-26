-- Service Estimate Authorization Rescue Agent — Phase A data ETL (issue #81).
--
-- The DIA `service_order` mirror view `v_dia_service_order_current` is
-- HEADER-ONLY: it exposes order/customer/status/turnaround but nothing about
-- the workshop estimate (orçamento de OS) lines that are PENDING authorization
-- or were DECLINED. Phase B's rescue agent needs estimate-line granularity, so
-- this additive migration surfaces it via a new `security_invoker` view.
--
-- It is purely additive: it does NOT touch the catalog, the header view
-- `v_dia_service_order_current`, or the `service_order` write RPCs (no new
-- entity_type is introduced — estimates ride on the existing `service_order`
-- payload, see ASSUMPTION A-001/A-002).
--
-- Payload contract (service_order.data -> 'estimates'): a JSONB array of objects
--   {
--     "estimate_id": "<stable id per orçamento>",   -- string
--     "status": "pending" | "authorized" | "declined",
--                 -- ERP AguardandoAutorizacao/Pendente -> pending,
--                 -- Autorizada -> authorized, Cancelada/VendaPerdida -> declined
--     "line_value": <numeric>,                       -- recoverable revenue
--     "lost_sale_reason": "<motivo VendaPerdida>" | null,
--     "description": "<optional>",
--     "opened_at": "<optional ISO timestamp>"
--   }
-- Missing/empty/non-array `estimates` yields zero rows (never an error).

create or replace view public.v_dia_service_estimate_current
with (security_invoker = true) as
select
  os_id,
  entity_version_id,
  version_number,
  source_record_id,
  order_number,
  customer,
  vehicle,
  technician,
  estimate_id,
  estimate_status,
  line_value,
  lost_sale_reason,
  estimate_description,
  recovery_rank,
  valid_from,
  created_at,
  updated_at
from (
  select
    rces.entity_id                                            as os_id,
    rces.entity_version_id,
    rces.version_number,
    rces.source_record_id,
    rces.data ->> 'order_number'                             as order_number,
    rces.data ->> 'customer'                                 as customer,
    rces.data ->> 'vehicle'                                  as vehicle,
    rces.data ->> 'technician'                               as technician,
    est.item ->> 'estimate_id'                               as estimate_id,
    coalesce(nullif(est.item ->> 'status', ''), 'pending')   as estimate_status,
    nullif(est.item ->> 'line_value', '')::numeric           as line_value,
    est.item ->> 'lost_sale_reason'                          as lost_sale_reason,
    est.item ->> 'description'                               as estimate_description,
    case coalesce(nullif(est.item ->> 'status', ''), 'pending')
      when 'declined' then 0
      when 'pending'  then 1
      else 2
    end                                                      as recovery_rank,
    rces.valid_from,
    rces.created_at,
    rces.updated_at
  from public.rental_current_entity_state rces
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(rces.data -> 'estimates') = 'array'
        then rces.data -> 'estimates'
      else '[]'::jsonb
    end
  ) as est(item)
  where rces.entity_type = 'service_order'
    and coalesce((rces.data ->> 'cancelled')::boolean, false) = false
    and coalesce(nullif(rces.data ->> 'status', ''), 'aberta') <> 'cancelada'
) expanded
where estimate_status in ('pending', 'declined')
order by recovery_rank, line_value desc nulls last, estimate_id;

grant select on table public.v_dia_service_estimate_current to authenticated, service_role;
