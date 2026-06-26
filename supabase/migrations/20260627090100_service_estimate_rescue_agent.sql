-- Service Estimate Authorization Rescue Agent (issue #81): register the output
-- schema only. The agent reuses the existing DIA `service_order` entity model
-- and the `v_dia_service_estimate_current` view (Phase A migration
-- 20260627090000_service_estimate_etl.sql); no new tables, entity types, or
-- catalog rows. Config and demo estimates are seeded in supabase/seed.sql
-- (entity store + base `ops_agent_config`), keeping this migration to the single
-- registry row.

insert into public.ops_output_schema_registry (schema_key, schema_json, description)
values (
  'service_estimate_finding_v1',
  '{
    "additionalProperties": false,
    "type": "object",
    "title": "ServiceEstimateFindingV1",
    "required": ["estimate_id", "recommended_action", "rationale"],
    "properties": {
      "estimate_id": {"type": "string", "title": "Estimate Id"},
      "os_id": {"type": "string", "title": "Os Id", "default": ""},
      "finding_type": {"type": "string", "title": "Finding Type", "default": "estimate_rescue"},
      "severity": {"type": "string", "title": "Severity", "default": "medium"},
      "recommended_action": {"type": "string", "title": "Recommended Action"},
      "recoverable_value": {"type": "number", "title": "Recoverable Value", "default": 0.0},
      "evidence": {"type": "array", "title": "Evidence", "items": {"type": "string"}},
      "confidence": {"type": "number", "title": "Confidence", "default": 0.0},
      "rationale": {"type": "string", "title": "Rationale"}
    }
  }'::jsonb,
  'Service estimate authorization rescue finding output schema v1 (estimate_rescue)'
)
on conflict (schema_key) do update
  set schema_json = excluded.schema_json,
      description = excluded.description,
      updated_at = now();
