-- Vehicle Stock-Aging Analyst v2 — anticipatory inventory analysis.
-- Registers the richer `vehicle_aging_finding_v2` output schema. The legacy
-- `vehicle_aging_finding_v1` row is left in place for historical findings; the
-- agent config (supabase/seed.sql) repoints `output_schema_key` to v2.
--
-- The v2 finding drops the 90-day `aging_bucket` artifact and adds a `signals[]`
-- list (the set of anticipatory signals that fired), with `finding_type`
-- defaulting to `floor_plan_band_escalation`. Severity/type/exposure remain
-- deterministic (computed by temporal/src/agents/vehicle_inventory_signals.py);
-- the LLM only fills recommended_action / rationale / confidence / evidence.

insert into public.ops_output_schema_registry (schema_key, schema_json, description)
values (
  'vehicle_aging_finding_v2',
  '{
    "additionalProperties": false,
    "type": "object",
    "title": "VehicleAgingFindingV2",
    "required": ["vehicle_id", "recommended_action", "rationale"],
    "properties": {
      "vehicle_id": {"type": "string", "title": "Vehicle Id"},
      "finding_type": {"type": "string", "title": "Finding Type", "default": "floor_plan_band_escalation"},
      "severity": {"type": "string", "title": "Severity", "default": "medium"},
      "days_in_stock": {"type": "integer", "title": "Days In Stock", "default": 0},
      "signals": {"type": "array", "title": "Signals", "items": {"type": "string"}},
      "recommended_action": {"type": "string", "title": "Recommended Action"},
      "estimated_exposure": {"type": "number", "title": "Estimated Exposure", "default": 0.0},
      "evidence": {"type": "array", "title": "Evidence", "items": {"type": "string"}},
      "confidence": {"type": "number", "title": "Confidence", "default": 0.0},
      "rationale": {"type": "string", "title": "Rationale"}
    }
  }'::jsonb,
  'Vehicle anticipatory inventory analyst finding output schema v2 (floor plan, margin, carryover)'
)
on conflict (schema_key) do update
  set schema_json = excluded.schema_json,
      description = excluded.description,
      updated_at = now();
