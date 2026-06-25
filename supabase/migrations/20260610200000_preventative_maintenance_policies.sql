-- Preventative maintenance trigger policies
-- Created: 2026-06-10
-- Purpose: store PM policies per asset or category, materialize due/pre-due state
-- Issue: #434 (child of #433)

-- ---------------------------------------------------------------------------
-- 1. Fact type: asset_rental_completion
--    Appended each time a contract line for an asset is returned/closed.
--    The evaluator counts TSP rows of this type to drive rental-count triggers.
-- ---------------------------------------------------------------------------

INSERT INTO fact_types (key, label, description, unit)
VALUES (
    'asset_rental_completion',
    'Asset Rental Completion',
    'Recorded each time a rental contract line for an asset is returned/closed',
    'count'
)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Table: preventative_maintenance_policies
--    One row per policy per entity (asset or category).
--    Category-level rows act as defaults; an asset-level row for the same
--    trigger_type overrides the category default for that asset.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS preventative_maintenance_policies (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The asset or category entity this policy applies to
    entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,

    -- Distinguishes asset-level (override) from category-level (default) policies
    entity_scope        text NOT NULL CHECK (entity_scope IN ('asset', 'category')),

    -- Trigger family
    trigger_type        text NOT NULL CHECK (trigger_type IN ('meter', 'rental_count', 'time_interval')),

    -- Threshold value for meter / rental_count triggers (e.g. 500 hours, 10 rentals)
    threshold           numeric,

    -- Period in days for time_interval triggers
    interval_days       integer,

    -- Days before threshold / due-date to surface as pre_due
    lead_window_days    integer NOT NULL DEFAULT 0,

    -- Enables or disables this policy without deleting it
    enabled             boolean NOT NULL DEFAULT true,

    -- Free-text label for the UI (e.g. "500-hour oil change")
    label               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    -- At most one active policy per entity + trigger type combination.
    -- A disabled row does not block a replacement enabled row.
    CONSTRAINT uq_pm_policy_entity_trigger
        UNIQUE (entity_id, trigger_type)
);

CREATE OR REPLACE FUNCTION _pm_policy_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pm_policy_updated_at_trg ON preventative_maintenance_policies;

CREATE TRIGGER pm_policy_updated_at_trg
BEFORE UPDATE ON preventative_maintenance_policies
FOR EACH ROW EXECUTE FUNCTION _pm_policy_updated_at();

CREATE INDEX IF NOT EXISTS idx_pm_policies_entity_id
    ON preventative_maintenance_policies (entity_id);

CREATE INDEX IF NOT EXISTS idx_pm_policies_enabled
    ON preventative_maintenance_policies (enabled)
    WHERE enabled = true;

-- ---------------------------------------------------------------------------
-- 3. View: v_asset_rental_completion_count
--    Counts completed rentals per asset from time_series_points.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_asset_rental_completion_count AS
SELECT
    tsp.entity_id                           AS asset_id,
    count(*)::bigint                        AS rental_completion_count,
    max(tsp.observed_at)                    AS last_completion_at
FROM time_series_points tsp
JOIN fact_types ft ON ft.id = tsp.fact_type_id
WHERE ft.key = 'asset_rental_completion'
GROUP BY tsp.entity_id;

-- ---------------------------------------------------------------------------
-- 4. View: v_pm_policy_effective
--    Resolves the effective policy for every asset by merging category defaults
--    with asset-level overrides.  An asset-level row wins over a category row
--    for the same trigger_type.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_pm_policy_effective AS
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
-- 5. View: v_pm_due_assets
--    Surface due / pre_due PM status per asset per policy.
--    Consumers (UI, evaluator) read this to show maintenance-due indicators.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_pm_due_assets AS
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
