begin;

-- Validate CRM interaction timeline + payment-issue projection behavior after a
-- full reset + seed rebuild.

do $$
declare
  v_customer_id uuid;
  v_interaction_fact_type_id uuid;
  v_payment_issue_fact_type_id uuid;
  v_timeline_event_id uuid;
  v_timeline_customer_id uuid;
  v_timeline_interaction_type text;
  v_timeline_summary text;
  v_timeline_linked_entity_id uuid;
  v_issue_entity_id uuid;
  v_payment_issue_flag numeric;
  v_issue_count int;
  v_fact_value numeric;
  v_issue_source_record_id text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_issue_source_record_id := 'reset-pay-issue-' || gen_random_uuid();

  select e.id
    into v_customer_id
  from public.entities e
  where e.entity_type = 'customer'
  order by e.created_at, e.id
  limit 1;

  if v_customer_id is null then
    raise exception 'Expected at least one seeded customer after reset';
  end if;

  select ft.id
    into v_interaction_fact_type_id
  from public.fact_types ft
  where ft.key = 'customer_call_logged'
  limit 1;

  if v_interaction_fact_type_id is null then
    raise exception 'Expected fact type customer_call_logged after reset';
  end if;

  select ft.id
    into v_payment_issue_fact_type_id
  from public.fact_types ft
  where ft.key = 'customer_payment_issue_flag'
  limit 1;

  if v_payment_issue_fact_type_id is null then
    raise exception 'Expected fact type customer_payment_issue_flag after reset';
  end if;

  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    metadata
  ) values (
    v_customer_id,
    v_interaction_fact_type_id,
    now() - interval '1 minute',
    jsonb_build_object('summary', 'Reset-path validation call'),
    jsonb_build_object(
      'linked_entity_id', v_customer_id,
      'linked_entity_type', 'customer'
    )
  )
  returning id into v_timeline_event_id;

  select
    t.customer_id,
    t.interaction_type,
    t.summary,
    t.linked_entity_id
    into
      v_timeline_customer_id,
      v_timeline_interaction_type,
      v_timeline_summary,
      v_timeline_linked_entity_id
  from public.crm_customer_communication_timeline t
  where t.timeline_event_id = v_timeline_event_id;

  if v_timeline_customer_id is distinct from v_customer_id then
    raise exception
      'Expected timeline projection customer % for inserted event %, got %',
      v_customer_id,
      v_timeline_event_id,
      v_timeline_customer_id;
  end if;

  if v_timeline_interaction_type is distinct from 'customer_call_logged' then
    raise exception
      'Expected interaction_type customer_call_logged, got %',
      coalesce(v_timeline_interaction_type, 'NULL');
  end if;

  if v_timeline_summary is distinct from 'Reset-path validation call' then
    raise exception
      'Expected projected summary from payload, got %',
      coalesce(v_timeline_summary, 'NULL');
  end if;

  if v_timeline_linked_entity_id is distinct from v_customer_id then
    raise exception
      'Expected linked_entity_id % in timeline projection, got %',
      v_customer_id,
      v_timeline_linked_entity_id;
  end if;

  select issue_entity_id, payment_issue_flag
    into v_issue_entity_id, v_payment_issue_flag
  from public.crm_upsert_payment_issue(
    p_issue_source_record_id => v_issue_source_record_id,
    p_customer_id => v_customer_id,
    p_issue_type => 'payment_issue',
    p_status => 'open',
    p_severity => 'high',
    p_owner => 'reset-validation'
  );

  if v_issue_entity_id is null then
    raise exception 'Expected crm_upsert_payment_issue to create an issue entity';
  end if;

  if v_payment_issue_flag is distinct from 1 then
    raise exception 'Expected payment_issue_flag=1 after opening issue, got %', v_payment_issue_flag;
  end if;

  select count(*)
    into v_issue_count
  from public.crm_customer_issue_current
  where issue_entity_id = v_issue_entity_id
    and customer_id = v_customer_id
    and status = 'open';

  if v_issue_count <> 1 then
    raise exception
      'Expected exactly one open projected issue row, got %',
      v_issue_count;
  end if;

  select payment_issue_flag
    into v_payment_issue_flag
  from public.crm_upsert_payment_issue(
    p_issue_source_record_id => v_issue_source_record_id,
    p_customer_id => v_customer_id,
    p_status => 'resolved',
    p_resolution_notes => 'Resolved during reset-path validation'
  );

  if v_payment_issue_flag is distinct from 0 then
    raise exception 'Expected payment_issue_flag=0 after resolving issue, got %', v_payment_issue_flag;
  end if;

  select count(*)
    into v_issue_count
  from public.crm_customer_issue_current
  where issue_entity_id = v_issue_entity_id
    and customer_id = v_customer_id
    and status = 'resolved';

  if v_issue_count <> 1 then
    raise exception
      'Expected exactly one resolved projected issue row, got %',
      v_issue_count;
  end if;

  select ef.value
    into v_fact_value
  from public.entity_facts ef
  where ef.entity_id = v_customer_id
    and ef.fact_type_id = v_payment_issue_fact_type_id;

  if v_fact_value is distinct from 0 then
    raise exception
      'Expected customer_payment_issue_flag fact value 0 after resolution, got %',
      coalesce(v_fact_value::text, 'NULL');
  end if;

  raise notice 'CRM interaction timeline + payment issue reset assertions passed';
end;
$$;

rollback;
