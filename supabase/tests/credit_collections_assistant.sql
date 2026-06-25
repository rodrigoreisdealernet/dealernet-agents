-- Reset-path assertions for 20260614221500_credit_collections_assistant.sql
--
-- Verifies that the migration applied cleanly after a full supabase db reset:
--   1. ops_output_schema_registry contains the credit_proposal_v1 schema entry.
--   2. ops_agent_config for the credit-analyst carries the AR collections
--      system prompt, user-prompt template, and the three required thresholds.

begin;

do $$
declare
  v_count         int;
  v_system_prompt text;
  v_thresholds    jsonb;
begin
  -- ── ops_output_schema_registry ────────────────────────────────────────────

  select count(*)
    into v_count
  from public.ops_output_schema_registry
  where schema_key = 'credit_proposal_v1';

  if v_count <> 1 then
    raise exception
      'Expected exactly 1 ops_output_schema_registry row with schema_key=credit_proposal_v1, found %',
      v_count;
  end if;

  -- The registered schema must cover the four required fields.
  select count(*)
    into v_count
  from public.ops_output_schema_registry,
       jsonb_array_elements_text(schema_json -> 'required') as req
  where schema_key = 'credit_proposal_v1'
    and req in ('account_id', 'risk_level', 'proposed_action', 'rationale');

  if v_count <> 4 then
    raise exception
      'credit_proposal_v1 schema must list account_id, risk_level, proposed_action, rationale as required; only % found',
      v_count;
  end if;

  raise notice 'ops_output_schema_registry credit_proposal_v1 checks passed';

  -- ── ops_agent_config ──────────────────────────────────────────────────────

  select count(*)
    into v_count
  from public.ops_agent_config
  where agent_key = 'credit-analyst';

  if v_count <> 1 then
    raise exception
      'Expected exactly 1 ops_agent_config row for agent_key=credit-analyst, found %',
      v_count;
  end if;

  -- System prompt must reference the AR collections role.
  select system_prompt
    into v_system_prompt
  from public.ops_agent_config
  where agent_key = 'credit-analyst';

  if v_system_prompt not ilike '%AR collections%' then
    raise exception
      'ops_agent_config system_prompt for credit-analyst must reference AR collections; got: %',
      left(v_system_prompt, 120);
  end if;

  -- The three AR-collections thresholds must be present.
  select thresholds
    into v_thresholds
  from public.ops_agent_config
  where agent_key = 'credit-analyst';

  if (v_thresholds ->> 'notice_of_intent_days') is null then
    raise exception
      'ops_agent_config thresholds for credit-analyst must include notice_of_intent_days';
  end if;

  if (v_thresholds ->> 'lien_preparation_days') is null then
    raise exception
      'ops_agent_config thresholds for credit-analyst must include lien_preparation_days';
  end if;

  if (v_thresholds ->> 'payment_history_stale_after_days') is null then
    raise exception
      'ops_agent_config thresholds for credit-analyst must include payment_history_stale_after_days';
  end if;

  raise notice 'ops_agent_config credit-analyst AR collections checks passed';
end;
$$;

rollback;
