-- Parts Inventory Advisor (issue #80): register the output schema only.
-- The agent reuses existing DIA parts inventory and sales views; no new tables,
-- entity types, or catalog rows. Config is seeded in supabase/seed.sql.

insert into public.ops_output_schema_registry (schema_key, schema_json, description)
values (
  'parts_inventory_finding_v1',
  '{
    "additionalProperties": false,
    "properties": {
      "part_id": {"title": "Part Id", "type": "string"},
      "finding_type": {"default": "replenish_now", "title": "Finding Type", "type": "string"},
      "severity": {"default": "medium", "title": "Severity", "type": "string"},
      "recommended_action": {"title": "Recommended Action", "type": "string"},
      "quantity_suggested": {"default": 0, "title": "Quantity Suggested", "type": "integer"},
      "value_at_risk": {"default": 0.0, "title": "Value At Risk", "type": "number"},
      "evidence": {"items": {"type": "string"}, "title": "Evidence", "type": "array"},
      "confidence": {"default": 0.0, "title": "Confidence", "type": "number"},
      "rationale": {"title": "Rationale", "type": "string"}
    },
    "required": ["part_id", "recommended_action", "rationale"],
    "title": "PartsInventoryFindingV1",
    "type": "object"
  }'::jsonb,
  'Parts inventory advisor finding output schema v1 (replenish_now/dead_stock)'
)
on conflict (schema_key) do update
  set schema_json = excluded.schema_json,
      description = excluded.description,
      updated_at = now();
