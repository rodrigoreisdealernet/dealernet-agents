-- Collections Prioritizer (issue #82): register the output schema only.
-- Config and demo finance entities are seeded in supabase/seed.sql.

insert into public.ops_output_schema_registry (schema_key, schema_json, description)
values (
  'collections_finding_v1',
  '{"additionalProperties":false,"properties":{"customer_id":{"title":"Customer Id","type":"string"},"finding_type":{"default":"collections_priority","title":"Finding Type","type":"string"},"severity":{"default":"medium","title":"Severity","type":"string"},"recommended_action":{"title":"Recommended Action","type":"string"},"total_exposure":{"default":0.0,"title":"Total Exposure","type":"number"},"days_overdue":{"default":0,"title":"Days Overdue","type":"integer"},"next_step_note":{"default":"","title":"Next Step Note","type":"string"},"evidence":{"items":{"type":"string"},"title":"Evidence","type":"array"},"confidence":{"default":0.0,"title":"Confidence","type":"number"},"rationale":{"title":"Rationale","type":"string"}},"required":["customer_id","recommended_action","rationale"],"title":"CollectionsFindingV1","type":"object"}'::jsonb,
  'Collections prioritizer finding output schema v1 (collections_priority)'
)
on conflict (schema_key) do update
  set schema_json = excluded.schema_json,
      description = excluded.description,
      updated_at = now();
