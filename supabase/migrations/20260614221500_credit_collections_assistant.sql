-- Repoint the credit-analyst ops lane from credit-limit changes to an assist-only
-- AR collections priority and escalation queue.

insert into public.ops_output_schema_registry (schema_key, schema_json, description)
values (
  'credit_proposal_v1',
  '{
    "type":"object",
    "required":["account_id","risk_level","proposed_action","rationale"],
    "properties":{
      "account_id":{"type":"string"},
      "risk_level":{"type":"string","enum":["low","medium","high","critical"]},
      "proposed_action":{"type":"string","enum":["no_op","routine_follow_up","review_notice_of_intent","review_lien_preparation","manual_portfolio_review"]},
      "current_exposure":{"type":"number"},
      "overdue_amount":{"type":"number"},
      "oldest_overdue_days":{"type":"integer"},
      "escalation_stage":{"type":"string","enum":["routine_follow_up","approaching_formal_escalation","formal_escalation_review","manual_review","no_op"]},
      "stale_inputs":{"type":"array","items":{"type":"string"}},
      "material_signal_key":{"type":"string"},
      "operating_model_tags":{"type":"array","items":{"type":"string"}},
      "evidence":{"type":"array"},
      "confidence":{"type":"number"},
      "rationale":{"type":"string"}
    }
  }'::jsonb,
  'AR collections priority and escalation assistant output schema v1'
)
on conflict (schema_key) do update
  set schema_json = excluded.schema_json,
      description = excluded.description,
      updated_at = now();

update public.ops_agent_config
set
  system_prompt = 'You are an AR collections priority and escalation assistant for an equipment-rental company. Rank overdue billing accounts, recommend the next human-approved collections step, preserve uncertainty when payment or account-history signals are stale, and never send outreach or take legal action automatically.',
  user_prompt_template = 'Review billing account {account_id} for tenant {tenant_id}. Use AR aging, payment history, branch/account notes, and overdue trend evidence to recommend the next collections step. Keep the queue unchanged when no materially new signal exists. Evidence:\n{evidence_json}',
  thresholds = jsonb_strip_nulls(coalesce(thresholds, '{}'::jsonb) || jsonb_build_object(
    'notice_of_intent_days', coalesce(nullif(thresholds ->> 'notice_of_intent_days', '')::int, 60),
    'lien_preparation_days', coalesce(nullif(thresholds ->> 'lien_preparation_days', '')::int, 90),
    'payment_history_stale_after_days', coalesce(nullif(thresholds ->> 'payment_history_stale_after_days', '')::int, 21)
  )),
  updated_at = now()
where agent_key = 'credit-analyst';
