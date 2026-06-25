-- PM due-indicator view corrections
-- Created: 2026-06-12
-- Purpose: Align v_pm_due_assets with the runtime PM evaluator by:
--          1. scoping time-interval maintenance baselines to
--             metadata->>'source' = 'maintenance'
--          2. suppressing meter-trigger pre-due until a meter-specific lead
--             concept exists in the product model
-- Issue: https://github.com/Volaris-AI/dia/issues/1166

CREATE OR REPLACE VIEW v_pm_due_assets
WITH (security_invoker = true)
AS
SELECT
    ppe.asset_id,
    ppe.policy_id,
    ppe.trigger_type,
    ppe.threshold,
    ppe.interval_days,
    ppe.lead_window_days,
    ppe.label,

    -- Latest meter reading (NULL when no reading available → never due for meter trigger)
    alm.reading_value                                       AS latest_meter_value,
    alm.reading_at                                          AS latest_meter_at,

    -- Rental completion count
    coalesce(arcc.rental_completion_count, 0)               AS rental_completion_count,
    arcc.last_completion_at,

    -- Most recent completed maintenance (for time_interval trigger baseline)
    (
        SELECT max(tsp.observed_at)
        FROM time_series_points tsp
        JOIN fact_types ft ON ft.id = tsp.fact_type_id
        WHERE ft.key = 'asset_downtime'
          AND tsp.entity_id = ppe.asset_id
          AND tsp.metadata ->> 'source' = 'maintenance'
    )                                                       AS last_maintenance_at,

    -- Due flag
    CASE
        WHEN ppe.trigger_type = 'meter' AND alm.reading_value IS NOT NULL
             AND alm.reading_value >= ppe.threshold                         THEN true
        WHEN ppe.trigger_type = 'rental_count'
             AND coalesce(arcc.rental_completion_count, 0) >= ppe.threshold THEN true
        WHEN ppe.trigger_type = 'time_interval'
             AND ppe.interval_days IS NOT NULL
             AND (
                 -- No previous maintenance: use asset creation time
                 extract(epoch from (now() - coalesce(
                     (
                         SELECT max(tsp2.observed_at)
                         FROM time_series_points tsp2
                         JOIN fact_types ft2 ON ft2.id = tsp2.fact_type_id
                         WHERE ft2.key = 'asset_downtime'
                           AND tsp2.entity_id = ppe.asset_id
                           AND tsp2.metadata ->> 'source' = 'maintenance'
                     ),
                     (SELECT e.created_at FROM entities e WHERE e.id = ppe.asset_id)
                 ))) / 86400.0 >= ppe.interval_days
             )                                                               THEN true
        ELSE false
    END                                                     AS is_due,

    -- Pre-due flag (within lead window but not yet at threshold)
    CASE
        WHEN ppe.trigger_type = 'rental_count'
             AND coalesce(arcc.rental_completion_count, 0) < ppe.threshold
             AND coalesce(arcc.rental_completion_count, 0)
                    >= (ppe.threshold - ppe.lead_window_days)                 THEN true
        WHEN ppe.trigger_type = 'time_interval'
             AND ppe.interval_days IS NOT NULL
             AND ppe.lead_window_days > 0
             AND (
                 extract(epoch from (now() - coalesce(
                     (
                         SELECT max(tsp2.observed_at)
                         FROM time_series_points tsp2
                         JOIN fact_types ft2 ON ft2.id = tsp2.fact_type_id
                         WHERE ft2.key = 'asset_downtime'
                           AND tsp2.entity_id = ppe.asset_id
                           AND tsp2.metadata ->> 'source' = 'maintenance'
                     ),
                     (SELECT e.created_at FROM entities e WHERE e.id = ppe.asset_id)
                 ))) / 86400.0 >= (ppe.interval_days - ppe.lead_window_days)
             )
             AND (
                 extract(epoch from (now() - coalesce(
                     (
                         SELECT max(tsp2.observed_at)
                         FROM time_series_points tsp2
                         JOIN fact_types ft2 ON ft2.id = tsp2.fact_type_id
                         WHERE ft2.key = 'asset_downtime'
                           AND tsp2.entity_id = ppe.asset_id
                           AND tsp2.metadata ->> 'source' = 'maintenance'
                     ),
                     (SELECT e.created_at FROM entities e WHERE e.id = ppe.asset_id)
                 ))) / 86400.0 < ppe.interval_days
             )                                                               THEN true
        ELSE false
    END                                                     AS is_pre_due

FROM v_pm_policy_effective ppe
LEFT JOIN v_asset_latest_meter alm
    ON alm.asset_id = ppe.asset_id
LEFT JOIN v_asset_rental_completion_count arcc
    ON arcc.asset_id = ppe.asset_id;
