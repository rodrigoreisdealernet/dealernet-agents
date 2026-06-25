-- ---------------------------------------------------------------------------
-- CRM demo payment-issue customer
--
-- Adds "Summit Arc Steel Services" as a demo customer with an active payment
-- issue flag so the experience test
-- "payment-issue escalation keeps customer issue context visible after reload"
-- has at least one customer row showing the "Payment Issue" badge and the
-- "Open Issue" escalation button.
--
-- The original baseline migration (20260613220000) skips seeding when any
-- customer entity already exists.  This migration is additive and idempotent:
-- it inserts the payment-issue customer only when that specific source_record_id
-- is absent, so it is safe to run against both fresh and already-seeded
-- environments.
--
-- Rollback: DELETE FROM entities WHERE source_record_id = 'crm-demo-summit-arc-steel';
-- ---------------------------------------------------------------------------

do $$
declare
  v_cust_id      uuid;
  v_ft_balance   uuid;
  v_ft_avg_days  uuid;
  v_ft_flag      uuid;
begin
  -- Skip if this demo record already exists (idempotent guard).
  if exists (
    select 1 from public.entities
    where entity_type = 'customer'
      and source_record_id = 'crm-demo-summit-arc-steel'
  ) then
    return;
  end if;

  insert into public.entities (entity_type, source_record_id)
  values ('customer', 'crm-demo-summit-arc-steel')
  returning id into v_cust_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_cust_id, 1,
    jsonb_build_object(
      'name',                     'Summit Arc Steel Services',
      'customer_type',            'national',
      'tier',                     'gold',
      'industry',                 'steel_fabrication',
      'hq_address',               '7200 Steel Mill Rd, Pittsburgh PA 15201',
      'preferred_payment_method', 'net_30'
    )
  );

  select id into v_ft_balance  from public.fact_types where key = 'customer_balance';
  select id into v_ft_avg_days from public.fact_types where key = 'customer_avg_days_to_pay';
  select id into v_ft_flag     from public.fact_types where key = 'customer_payment_issue_flag';

  if v_ft_balance is not null then
    insert into public.entity_facts (entity_id, fact_type_id, value, source_id)
    values (v_cust_id, v_ft_balance, 87400, 'crm-demo-summit-arc-steel');
  end if;

  if v_ft_avg_days is not null then
    insert into public.entity_facts (entity_id, fact_type_id, value, source_id)
    values (v_cust_id, v_ft_avg_days, 62, 'crm-demo-summit-arc-steel');
  end if;

  if v_ft_flag is not null then
    insert into public.entity_facts (entity_id, fact_type_id, value, source_id)
    values (v_cust_id, v_ft_flag, 1, 'crm-demo-summit-arc-steel');
  end if;

end;
$$;
