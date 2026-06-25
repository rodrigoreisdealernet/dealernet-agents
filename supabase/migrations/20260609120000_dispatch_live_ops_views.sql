-- ---------------------------------------------------------------------------
-- Dispatch Live Ops Views
--
-- Provides:
--   v_dispatch_route_live          – live per-route row for the dispatcher
--                                    operations surface (driver, truck, status,
--                                    exception state derived from contract-line
--                                    operational events)
--   v_transport_efficiency_summary – fleet-level empty-miles / load-utilization
--                                    metrics derived from durable operational events
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. v_dispatch_route_live
--    One row per active/recent rental_contract_line.  Route status and
--    exception state are derived from the durable entity_versions payload,
--    so no browser-side calculations are needed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_dispatch_route_live AS
SELECT
    e.id                                                         AS line_id,
    ev.data ->> 'contract_id'                                    AS contract_id,
    ev.data ->> 'asset_id'                                       AS asset_id,
    a.name                                                       AS asset_name,
    a.serial_number                                              AS asset_serial,
    ev.data ->> 'status'                                         AS line_status,
    -- Confirm-load payload (recorded by the field mobile workflow)
    ev.data -> 'confirm_load' ->> 'assigned_driver'              AS assigned_driver,
    ev.data -> 'confirm_load' ->> 'assigned_truck'               AS assigned_truck,
    ev.data -> 'confirm_load' ->> 'departure_at'                 AS departure_at,
    ev.data ->> 'actual_start'                                   AS actual_start,
    ev.data ->> 'actual_end'                                     AS actual_end,
    -- Derived route status ------------------------------------------------
    CASE
        WHEN ev.data ->> 'status' = 'returned'
             THEN 'delivered'
        WHEN ev.data -> 'confirm_load' ->> 'departure_at' IS NOT NULL
             THEN 'in_transit'
        WHEN ev.data ->> 'status' = 'checked_out'
             THEN 'pending_departure'
        ELSE ev.data ->> 'status'
    END                                                          AS route_status,
    -- Derived exception state ---------------------------------------------
    CASE
        WHEN ev.data ->> 'status' = 'checked_out'
             AND ev.data -> 'confirm_load' ->> 'assigned_driver' IS NULL
             THEN 'missing_driver'
        WHEN ev.data ->> 'status' = 'checked_out'
             AND ev.data ->> 'actual_start' IS NOT NULL
             AND (ev.data ->> 'actual_start')::timestamptz < now() - interval '24 hours'
             AND ev.data ->> 'actual_end' IS NULL
             THEN 'overdue'
        ELSE NULL
    END                                                          AS exception_state,
    -- Branch via asset home branch (if recorded on asset entity)
    a.state ->> 'home_branch_id'                                 AS branch_id,
    ev.valid_from                                                AS updated_at
FROM public.entities e
JOIN public.entity_versions ev
    ON ev.entity_id = e.id
   AND ev.is_current = true
LEFT JOIN public.v_current_assets a
    ON a.asset_id::text = ev.data ->> 'asset_id'
WHERE e.entity_type = 'rental_contract_line'
  AND ev.data ->> 'status' IN ('checked_out', 'returned');

ALTER VIEW public.v_dispatch_route_live SET (security_invoker = true);

REVOKE ALL ON TABLE public.v_dispatch_route_live FROM anon;
GRANT SELECT ON TABLE public.v_dispatch_route_live TO authenticated, service_role;

-- v_current_assets is joined inside v_dispatch_route_live.  Because both views
-- are security_invoker the caller's role is checked against every referenced
-- object.  Grant SELECT so authenticated users can traverse the JOIN without
-- privilege errors.
GRANT SELECT ON TABLE public.v_current_assets TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. v_transport_efficiency_summary
--    Fleet-wide transport metrics derived from the same durable event store.
--    "Loaded" = route had a confirmed truck assignment (confirm_load.assigned_truck).
--    "Empty"  = route was dispatched (checked_out/returned) without a truck.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_transport_efficiency_summary AS
SELECT
    COUNT(*)                                                           AS total_routes,
    COUNT(*) FILTER (
        WHERE ev.data -> 'confirm_load' ->> 'assigned_truck' IS NOT NULL
    )                                                                  AS loaded_routes,
    COUNT(*) FILTER (
        WHERE ev.data -> 'confirm_load' ->> 'assigned_truck' IS NULL
    )                                                                  AS empty_routes,
    ROUND(
        100.0
        * COUNT(*) FILTER (
            WHERE ev.data -> 'confirm_load' ->> 'assigned_truck' IS NOT NULL
          )
        / NULLIF(COUNT(*), 0),
        1
    )                                                                  AS load_utilization_pct,
    COUNT(*) FILTER (
        WHERE ev.data ->> 'status' = 'checked_out'
    )                                                                  AS active_routes,
    COUNT(*) FILTER (
        WHERE ev.data ->> 'status' = 'returned'
    )                                                                  AS completed_routes,
    COUNT(*) FILTER (
        WHERE ev.data ->> 'status' = 'checked_out'
          AND ev.data -> 'confirm_load' ->> 'assigned_driver' IS NULL
    )                                                                  AS missing_driver_count,
    COUNT(*) FILTER (
        WHERE ev.data ->> 'status' = 'checked_out'
          AND ev.data ->> 'actual_start' IS NOT NULL
          AND (ev.data ->> 'actual_start')::timestamptz < now() - interval '24 hours'
          AND ev.data ->> 'actual_end' IS NULL
    )                                                                  AS overdue_count
FROM public.entities e
JOIN public.entity_versions ev
    ON ev.entity_id = e.id
   AND ev.is_current = true
WHERE e.entity_type = 'rental_contract_line'
  AND ev.data ->> 'status' IN ('checked_out', 'returned');

ALTER VIEW public.v_transport_efficiency_summary SET (security_invoker = true);

REVOKE ALL ON TABLE public.v_transport_efficiency_summary FROM anon;
GRANT SELECT ON TABLE public.v_transport_efficiency_summary TO authenticated, service_role;
