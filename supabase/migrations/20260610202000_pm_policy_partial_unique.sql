-- PM policies: fix unique constraint to allow disabled rows to be replaced
-- Created: 2026-06-10
-- Purpose: Replace the unconditional UNIQUE (entity_id, trigger_type) with a
--          partial unique index that only applies to ENABLED policies. This lets
--          a new enabled row be inserted even when a disabled row for the same
--          entity+trigger_type already exists (e.g. policy was disabled and
--          needs to be replaced with a fresh enabled one).
-- Issue: #434
--
-- Rollback plan:
--   If this migration needs to be reversed, drop the partial index and
--   restore the original unconditional unique constraint:
--
--   DROP INDEX IF EXISTS uq_pm_policy_entity_trigger_enabled;
--   ALTER TABLE preventative_maintenance_policies
--       ADD CONSTRAINT uq_pm_policy_entity_trigger UNIQUE (entity_id, trigger_type);
--
--   Note: the rollback will fail if any disabled rows share an (entity_id,
--   trigger_type) pair that was inserted after this migration ran.  In that
--   case, delete the duplicate disabled rows first before re-adding the
--   unconditional constraint.

-- Drop the previous unconditional unique constraint from the creation migration.
-- A disabled row should not block insertion of a replacement enabled row.
ALTER TABLE preventative_maintenance_policies
    DROP CONSTRAINT IF EXISTS uq_pm_policy_entity_trigger;

-- Enforce uniqueness only among ENABLED rows: at most one enabled policy per
-- (entity_id, trigger_type).  Disabled rows are unconstrained and can coexist
-- with any number of other disabled rows for the same pair.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_policy_entity_trigger_enabled
    ON preventative_maintenance_policies (entity_id, trigger_type)
    WHERE enabled = true;
