-- PM: Correct uq_tsp_entity_source index and fix trigger UUID cast
-- Created: 2026-06-10
-- Purpose: Two regressions were introduced by 20260610123000:
--
--   1. The partial unique index uq_tsp_entity_source on (entity_id, source_id)
--      is too narrow: it prevents inserting two different fact types for the
--      same entity when both use the same source_id.  The analytics-views test
--      (and any workflow that records both asset_meter_reading and asset_downtime
--      for the same asset from the same source batch) would fail with
--      "duplicate key value violates unique constraint uq_tsp_entity_source".
--      Fix: replace with uq_tsp_entity_fact_source on
--           (entity_id, fact_type_id, source_id) so deduplication is scoped
--           to a single fact type per source event.
--
--   2. The _emit_asset_rental_completion trigger function casts
--      NEW.data->>'asset_id' directly to uuid without guarding against
--      non-UUID strings (e.g. "asset-auth-field" used in API-contract tests).
--      That threw "invalid input syntax for type uuid" and caused the RPC
--      call to fail with HTTP 400.
--      Fix: wrap the cast in a PL/pgSQL nested exception block so the trigger
--           silently skips rows whose asset_id is not a valid UUID.
--
-- Rollback plan (run in order if this migration must be reversed):
--   DROP INDEX IF EXISTS uq_tsp_entity_fact_source;
--   CREATE UNIQUE INDEX uq_tsp_entity_source
--       ON time_series_points (entity_id, source_id)
--       WHERE source_id IS NOT NULL;
--   -- Then re-deploy the previous version of _emit_asset_rental_completion()
--   -- from migration 20260610123000_pm_rental_completion_trigger.sql.
-- Issue: #434

-- ---------------------------------------------------------------------------
-- 1. Replace the too-narrow (entity_id, source_id) index with the correct
--    three-column (entity_id, fact_type_id, source_id) index.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS uq_tsp_entity_source;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tsp_entity_fact_source
    ON time_series_points (entity_id, fact_type_id, source_id)
    WHERE source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Replace the trigger function with a version that handles non-UUID
--    asset_id values gracefully.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _emit_asset_rental_completion()
RETURNS trigger AS $$
DECLARE
    v_entity_type   text;
    v_asset_id      uuid;
    v_fact_type_id  uuid;
BEGIN
    -- Only handle rental_contract_line entities
    SELECT entity_type INTO v_entity_type
    FROM public.entities
    WHERE id = NEW.entity_id;

    IF v_entity_type IS DISTINCT FROM 'rental_contract_line' THEN
        RETURN NEW;
    END IF;

    -- Only fire when transitioning to 'returned'
    IF (NEW.data ->> 'status') IS DISTINCT FROM 'returned' THEN
        RETURN NEW;
    END IF;

    -- Resolve the asset_id from the contract line data.
    -- Use a nested exception block to skip rows where asset_id is not a
    -- valid UUID (e.g. test fixtures that pass plain strings).
    BEGIN
        v_asset_id := (NEW.data ->> 'asset_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN NEW;
    END;

    IF v_asset_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Resolve the fact type; skip silently if the migration has not run yet
    SELECT id INTO v_fact_type_id
    FROM public.fact_types
    WHERE key = 'asset_rental_completion';

    IF v_fact_type_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Insert TSP row.  source_id = contract_line entity_id is the cross-path
    -- deduplication key shared by both this trigger and the Python activity.
    -- The three-column index (entity_id, fact_type_id, source_id) ensures
    -- exactly one row per return event regardless of which path fires first.
    INSERT INTO public.time_series_points (
        entity_id,
        fact_type_id,
        observed_at,
        data_payload,
        source_id
    ) VALUES (
        v_asset_id,
        v_fact_type_id,
        now(),
        jsonb_build_object('count', 1),
        NEW.entity_id::text
    )
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
