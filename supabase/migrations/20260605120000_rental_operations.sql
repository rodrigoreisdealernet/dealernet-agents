-- Rental operations: fact type seeds + helper views
-- Created: 2026-06-05
-- Purpose: seed domain fact_types and surface analytics views for the equipment rental domain
-- Spec: docs/specs/equipment-rental-domain-model.md

-- ---------------------------------------------------------------------------
-- 1. Seed rental fact types
-- ---------------------------------------------------------------------------

INSERT INTO fact_types (key, label, description, unit)
VALUES
    ('asset_meter_reading',    'Asset Meter Reading',       'Cumulative usage measurement (hours, miles, etc.)',       'hours'),
    ('asset_downtime',         'Asset Downtime',            'Duration asset was unavailable due to maintenance',       'minutes'),
    ('branch_on_rent_count',   'Branch On-Rent Count',      'Number of assets currently on rent at a branch',          'count'),
    ('branch_utilization_rate','Branch Utilization Rate',   'Proportion of branch fleet currently on rent',            'percent'),
    ('invoice_total',          'Invoice Total',             'Total invoiced amount including tax',                     'USD'),
    ('rental_revenue',         'Rental Revenue',            'Revenue from a rental line item for a billing period',    'USD')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. View: current asset state
--    Returns the most-recent entity_version data row for every asset entity.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_current_assets AS
SELECT
    e.id                                          AS asset_id,
    e.source_record_id,
    ev.id                                         AS version_id,
    ev.data                                       AS state,
    ev.data ->> 'status'                          AS status,
    ev.data ->> 'serial_number'                   AS serial_number,
    ev.data ->> 'category_id'                     AS category_id,
    ev.data ->> 'name'                            AS name,
    ev.valid_from,
    e.created_at
FROM entities e
JOIN entity_versions ev
    ON ev.entity_id = e.id
   AND ev.is_current = true
WHERE e.entity_type = 'asset';

-- ---------------------------------------------------------------------------
-- 3. View: asset downtime history
--    Reads time_series_points for the asset_downtime fact type.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_asset_downtime_history AS
SELECT
    tsp.entity_id                                 AS asset_id,
    tsp.observed_at                               AS downtime_recorded_at,
    (tsp.data_payload ->> 'downtime_minutes')::numeric AS downtime_minutes,
    tsp.data_payload ->> 'maintenance_record_id'  AS maintenance_record_id,
    tsp.metadata
FROM time_series_points tsp
JOIN fact_types ft ON ft.id = tsp.fact_type_id
WHERE ft.key = 'asset_downtime';

-- ---------------------------------------------------------------------------
-- 4. View: branch utilization summary
--    Shows on-rent count KPIs stored in entity_facts.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_branch_utilization AS
SELECT
    e.id                                          AS branch_id,
    e.source_record_id,
    ev.data ->> 'name'                            AS branch_name,
    on_rent.value                                 AS on_rent_count,
    util.value                                    AS utilization_rate_pct,
    on_rent.updated_at                            AS last_updated
FROM entities e
JOIN entity_versions ev
    ON ev.entity_id = e.id
   AND ev.is_current = true
LEFT JOIN entity_facts on_rent
    ON on_rent.entity_id = e.id
   AND on_rent.fact_type_id = (SELECT id FROM fact_types WHERE key = 'branch_on_rent_count')
LEFT JOIN entity_facts util
    ON util.entity_id = e.id
   AND util.fact_type_id = (SELECT id FROM fact_types WHERE key = 'branch_utilization_rate')
WHERE e.entity_type = 'branch';

-- ---------------------------------------------------------------------------
-- 5. View: asset meter readings (latest reading per asset)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_asset_latest_meter AS
SELECT DISTINCT ON (tsp.entity_id)
    tsp.entity_id                                         AS asset_id,
    tsp.observed_at                                       AS reading_at,
    (tsp.data_payload ->> 'reading_value')::numeric       AS reading_value,
    tsp.data_payload ->> 'reading_unit'                   AS reading_unit
FROM time_series_points tsp
JOIN fact_types ft ON ft.id = tsp.fact_type_id
WHERE ft.key = 'asset_meter_reading'
ORDER BY tsp.entity_id, tsp.observed_at DESC;
