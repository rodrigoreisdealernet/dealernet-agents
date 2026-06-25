-- PM: Rental completion fact emitter + source_id deduplication index
-- Created: 2026-06-10
-- Purpose: Ensure the `asset_rental_completion` time-series fact is written on
--          EVERY contract-line return, whether the line is returned via a direct
--          `rental_upsert_entity_current_state` RPC call (the frontend path) or
--          via the Temporal RentalOrderWorkflow signal path.
--
--          Strategy:
--          1. A partial unique index on time_series_points(entity_id, source_id)
--             lets both paths write idempotently: the first writer wins and
--             subsequent ON CONFLICT DO NOTHING calls are silently ignored.
--          2. A AFTER INSERT trigger on entity_versions fires for every new
--             rental_contract_line version that transitions to `status=returned`
--             and inserts a TSP row using source_id = contract_line_entity_id.
--          3. The Python `pm_record_rental_completion` activity (Temporal path)
--             also supplies source_id = contract_line_id, so both paths share the
--             same deduplication key and exactly one TSP row is written per return.
-- Issue: #434

-- ---------------------------------------------------------------------------
-- 1. Partial unique index on time_series_points(entity_id, source_id)
--    Used by both the DB trigger and the Python activity to deduplicate rows
--    across execution paths.  The index is partial (source_id IS NOT NULL) so
--    it only covers intentionally tagged rows and does not affect pre-existing
--    rows that have NULL source_id.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_tsp_entity_source
    ON time_series_points (entity_id, source_id)
    WHERE source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Trigger function: emit asset_rental_completion fact
--    Fires AFTER INSERT on entity_versions.  Silently skips rows that are not
--    rental_contract_line entities or do not carry status=returned.
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

    -- Resolve the asset_id from the contract line data
    v_asset_id := (NEW.data ->> 'asset_id')::uuid;
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

    -- Insert TSP row.  source_id = contract_line entity_id guarantees that
    -- both this trigger and the Python activity produce the same dedup key so
    -- exactly one row is written per return event regardless of which path fires.
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

-- ---------------------------------------------------------------------------
-- 3. Trigger on entity_versions
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS emit_rental_completion_trg ON entity_versions;

CREATE TRIGGER emit_rental_completion_trg
AFTER INSERT ON entity_versions
FOR EACH ROW EXECUTE FUNCTION _emit_asset_rental_completion();
