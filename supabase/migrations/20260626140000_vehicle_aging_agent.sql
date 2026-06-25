-- Vehicle Stock-Aging Analyst (issue #32): register the output schema only.
-- The agent reuses the existing DIA `vehicle` entity model and the
-- `v_dia_vehicle_current` view; no new tables, entity types, or catalog rows.
-- Config and demo vehicles are seeded in supabase/seed.sql (entity store + base
-- `ops_agent_config`), keeping this migration to the single registry row.

insert into public.ops_output_schema_registry (schema_key, schema_json, description)
values (
  'vehicle_aging_finding_v1',
  '{
    "additionalProperties": false,
    "type": "object",
    "title": "VehicleAgingFindingV1",
    "required": ["vehicle_id", "recommended_action", "rationale"],
    "properties": {
      "vehicle_id": {"type": "string", "title": "Vehicle Id"},
      "finding_type": {"type": "string", "title": "Finding Type", "default": "stock_aging_90d"},
      "severity": {"type": "string", "title": "Severity", "default": "medium"},
      "days_in_stock": {"type": "integer", "title": "Days In Stock", "default": 0},
      "aging_bucket": {"type": "string", "title": "Aging Bucket", "default": "approaching"},
      "recommended_action": {"type": "string", "title": "Recommended Action"},
      "estimated_exposure": {"type": "number", "title": "Estimated Exposure", "default": 0.0},
      "evidence": {"type": "array", "title": "Evidence", "items": {"type": "string"}},
      "confidence": {"type": "number", "title": "Confidence", "default": 0.0},
      "rationale": {"type": "string", "title": "Rationale"}
    }
  }'::jsonb,
  'Vehicle stock-aging analyst finding output schema v1 (stock_aging_90d)'
)
on conflict (schema_key) do update
  set schema_json = excluded.schema_json,
      description = excluded.description,
      updated_at = now();
