-- PM views: add security_invoker = true
-- Created: 2026-06-10
-- Purpose: Correct the three PM views added in 20260610000000 to honour
--          base-table RLS by setting security_invoker = true.  All views in
--          this schema use security_invoker so that the query runs as the
--          calling role rather than the view owner, ensuring tenant-scoped
--          RLS policies on the underlying tables are enforced at query time.
-- Issue: #434

-- ---------------------------------------------------------------------------
-- v_asset_rental_completion_count
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_asset_rental_completion_count
WITH (security_invoker = true)
AS
SELECT
    tsp.entity_id                           AS asset_id,
    count(*)::bigint                        AS rental_completion_count,
    max(tsp.observed_at)                    AS last_completion_at
FROM time_series_points tsp
JOIN fact_types ft ON ft.id = tsp.fact_type_id
WHERE ft.key = 'asset_rental_completion'
GROUP BY tsp.entity_id;

-- ---------------------------------------------------------------------------
-- v_pm_policy_effective
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_pm_policy_effective
WITH (security_invoker = true)
AS
-- Asset-level policies (highest precedence)
SELECT
    pmp.id                                                  AS policy_id,
    e_asset.id                                              AS asset_id,
    pmp.entity_id                                           AS source_entity_id,
    pmp.entity_scope,
    pmp.trigger_type,
    pmp.threshold,
    pmp.interval_days,
    pmp.lead_window_days,
    pmp.enabled,
    pmp.label
FROM preventative_maintenance_policies pmp
JOIN entities e_asset
    ON e_asset.id = pmp.entity_id
   AND e_asset.entity_type = 'asset'
WHERE pmp.entity_scope = 'asset'
  AND pmp.enabled = true

UNION ALL

-- Category-level policies applied to all assets in that category,
-- unless the asset already has its own policy for the same trigger_type.
SELECT
    pmp.id                                                  AS policy_id,
    e_asset.id                                              AS asset_id,
    pmp.entity_id                                           AS source_entity_id,
    pmp.entity_scope,
    pmp.trigger_type,
    pmp.threshold,
    pmp.interval_days,
    pmp.lead_window_days,
    pmp.enabled,
    pmp.label
FROM preventative_maintenance_policies pmp
JOIN entities e_cat
    ON e_cat.id = pmp.entity_id
   AND e_cat.entity_type = 'asset_category'
JOIN entity_versions ev_asset
    ON ev_asset.is_current = true
   AND (ev_asset.data ->> 'category_id')::uuid = e_cat.id
JOIN entities e_asset
    ON e_asset.id = ev_asset.entity_id
   AND e_asset.entity_type = 'asset'
-- Exclude assets that have their own asset-level policy for this trigger_type
WHERE pmp.entity_scope = 'category'
  AND pmp.enabled = true
  AND NOT EXISTS (
      SELECT 1
      FROM preventative_maintenance_policies override
      WHERE override.entity_id  = e_asset.id
        AND override.trigger_type = pmp.trigger_type
        AND override.entity_scope = 'asset'
        AND override.enabled = true
  );

-- ---------------------------------------------------------------------------
-- v_pm_due_assets
-- ---------------------------------------------------------------------------

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
        WHERE ft.key       = 'asset_downtime'
          AND tsp.entity_id = ppe.asset_id
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
                         WHERE ft2.key = 'asset_downtime' AND tsp2.entity_id = ppe.asset_id
                     ),
                     (SELECT e.created_at FROM entities e WHERE e.id = ppe.asset_id)
                 ))) / 86400.0 >= ppe.interval_days
             )                                                               THEN true
        ELSE false
    END                                                     AS is_due,

    -- Pre-due flag (within lead window but not yet at threshold)
    CASE
        WHEN ppe.trigger_type = 'meter' AND alm.reading_value IS NOT NULL
             AND alm.reading_value < ppe.threshold
             AND alm.reading_value >= (ppe.threshold - ppe.lead_window_days)  THEN true
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
                         WHERE ft2.key = 'asset_downtime' AND tsp2.entity_id = ppe.asset_id
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
                         WHERE ft2.key = 'asset_downtime' AND tsp2.entity_id = ppe.asset_id
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
