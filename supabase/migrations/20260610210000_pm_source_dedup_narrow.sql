-- PM: Narrow source-dedup index to PM-only fact types
-- Created: 2026-06-10
-- Purpose: Replace the overly broad uq_tsp_entity_fact_source index on
--          (entity_id, fact_type_id, source_id) with fact-type-specific
--          partial unique indexes that cover only the two PM-emitted facts:
--          asset_rental_completion and asset_downtime.
--
--          The broad index blocked existing analytics flows that legitimately
--          write multiple observations for the same entity/fact/source tuple
--          (e.g. multiple meter readings tagged with the same batch source_id).
--
--          The replacement indexes enforce uniqueness per-fact-type so:
--          - asset_rental_completion: one TSP row per (asset, contract_line)
--          - asset_downtime:          one TSP row per (asset, maintenance_record)
--          - all other fact types:    no source_id uniqueness enforced
--
-- Rollback plan (run in order):
--   DROP INDEX IF EXISTS uq_tsp_rc_source;
--   DROP INDEX IF EXISTS uq_tsp_downtime_source;
--   CREATE UNIQUE INDEX uq_tsp_entity_fact_source
--       ON time_series_points (entity_id, fact_type_id, source_id)
--       WHERE source_id IS NOT NULL;
-- Issue: #434

-- ---------------------------------------------------------------------------
-- 1. Drop the overly broad three-column index.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS uq_tsp_entity_fact_source;

-- ---------------------------------------------------------------------------
-- 2. Create fact-type-specific partial unique indexes.
--    Uses dynamic SQL because the WHERE predicate must reference a UUID that
--    is resolved at migration time from the fact_types catalogue.
--    Both fact types must already exist (inserted by 20260610130000 and
--    20260605120000 respectively) before this migration runs.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_rc_id   uuid;
    v_down_id uuid;
BEGIN
    SELECT id INTO v_rc_id
    FROM public.fact_types
    WHERE key = 'asset_rental_completion';

    SELECT id INTO v_down_id
    FROM public.fact_types
    WHERE key = 'asset_downtime';

    -- Index for asset_rental_completion: one TSP row per (asset, contract_line).
    -- Both the DB trigger (_emit_asset_rental_completion) and the Python activity
    -- pm_record_rental_completion supply source_id = contract_line_id, so the
    -- first writer wins and the second path silently skips via ON CONFLICT DO NOTHING.
    IF v_rc_id IS NOT NULL THEN
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS uq_tsp_rc_source
             ON public.time_series_points (entity_id, source_id)
             WHERE fact_type_id = %L AND source_id IS NOT NULL',
            v_rc_id
        );
    END IF;

    -- Index for asset_downtime: one TSP row per (asset, maintenance_record).
    -- Only the Python activity record_asset_downtime writes these rows, so the
    -- index primarily guards against Temporal activity retries.
    IF v_down_id IS NOT NULL THEN
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS uq_tsp_downtime_source
             ON public.time_series_points (entity_id, source_id)
             WHERE fact_type_id = %L AND source_id IS NOT NULL',
            v_down_id
        );
    END IF;
END;
$$;
