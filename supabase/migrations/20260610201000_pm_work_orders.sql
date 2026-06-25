-- PM work orders table
-- Created: 2026-06-10
-- Purpose: persist idempotent preventive maintenance work orders created by PMEvaluatorWorkflow
-- Issue: #434

-- ---------------------------------------------------------------------------
-- Table: pm_work_orders
--   One row per fingerprint per tenant. The (tenant_id, fingerprint) unique
--   constraint ensures the workflow can safely upsert without creating
--   duplicates even when retried or re-run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pm_work_orders (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        text        NOT NULL,

    -- The asset this work order is for (nullable: ON DELETE SET NULL so the
    -- work order record survives asset deletion for historical visibility)
    asset_id         uuid        REFERENCES entities(id) ON DELETE SET NULL,

    -- The PM policy that triggered this work order (nullable for same reason)
    policy_id        uuid        REFERENCES preventative_maintenance_policies(id) ON DELETE SET NULL,

    trigger_type     text        NOT NULL,
    maintenance_type text        NOT NULL DEFAULT 'preventive',
    status           text        NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('open', 'closed', 'cancelled')),

    -- Idempotency key: stable within a threshold-crossing window.
    -- The workflow deduplicates on this key before inserting.
    fingerprint      text        NOT NULL,

    -- Identifier of the PMEvaluatorWorkflow run that created this record.
    run_id           text,
    reason           text,

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_pm_work_order_fingerprint UNIQUE (tenant_id, fingerprint)
);

-- update_updated_at() is defined in 20251202090000_core_entity_model.sql
CREATE TRIGGER pm_work_orders_updated_at_trg
BEFORE UPDATE ON pm_work_orders
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_pm_work_orders_tenant_status
    ON pm_work_orders (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_pm_work_orders_asset_id
    ON pm_work_orders (asset_id);
