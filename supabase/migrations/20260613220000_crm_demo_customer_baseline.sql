-- ---------------------------------------------------------------------------
-- CRM demo customer baseline
--
-- Seeds a small set of demo customer profiles into the deployed environment
-- when no customer entities are present.  The migration is a no-op on any
-- environment that already has customer data (local dev after seed.sql,
-- staging, or production).
--
-- Why this is a migration (not seed.sql only):
--   seed.sql is applied only on `supabase db reset` (local dev).  The deployed
--   Supabase cloud environment receives schema changes via `supabase db push`
--   (migrations only), so without demo rows the CRM experience tests cannot
--   exercise the list→detail→reload journey.
--
-- Rollback: DELETE FROM entities WHERE source_record_id LIKE 'crm-demo-%';
-- ---------------------------------------------------------------------------

do $$
declare
  v_cust_1        uuid;
  v_cust_2        uuid;
  v_cust_3        uuid;
  v_ft_balance    uuid;
  v_ft_avg_days   uuid;
begin
  -- Skip entirely when any customer already exists (idempotent guard).
  if exists (select 1 from public.entities where entity_type = 'customer' limit 1) then
    return;
  end if;

  -- ── Insert three demo customers ──────────────────────────────────────────

  insert into public.entities (entity_type, source_record_id)
  values ('customer', 'crm-demo-acme-industrial')
  returning id into v_cust_1;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_cust_1, 1,
    jsonb_build_object(
      'name',                     'Acme Industrial LLC',
      'customer_type',            'national',
      'tier',                     'gold',
      'industry',                 'heavy_civil',
      'hq_address',               '4200 Industrial Blvd, Houston TX 77001',
      'preferred_payment_method', 'ACH'
    )
  );

  insert into public.entities (entity_type, source_record_id)
  values ('customer', 'crm-demo-metro-equipment')
  returning id into v_cust_2;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_cust_2, 1,
    jsonb_build_object(
      'name',                     'Metro Equipment Services',
      'customer_type',            'local',
      'tier',                     'silver',
      'industry',                 'equipment_rental',
      'hq_address',               '810 Commerce St, Dallas TX 75201',
      'preferred_payment_method', 'check'
    )
  );

  insert into public.entities (entity_type, source_record_id)
  values ('customer', 'crm-demo-coastal-construction')
  returning id into v_cust_3;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_cust_3, 1,
    jsonb_build_object(
      'name',                     'Coastal Construction Co',
      'customer_type',            'local',
      'tier',                     'standard',
      'industry',                 'construction',
      'hq_address',               '1500 Gulf Fwy, Galveston TX 77550',
      'preferred_payment_method', 'credit_card'
    )
  );

  -- ── Resolve fact type ids ────────────────────────────────────────────────

  select id into v_ft_balance  from public.fact_types where key = 'customer_balance';
  select id into v_ft_avg_days from public.fact_types where key = 'customer_avg_days_to_pay';

  -- ── Insert financial facts ───────────────────────────────────────────────

  if v_ft_balance is not null then
    insert into public.entity_facts (entity_id, fact_type_id, value, source_id)
    values
      (v_cust_1, v_ft_balance, 42800, 'crm-demo-acme-industrial'),
      (v_cust_2, v_ft_balance, 18500, 'crm-demo-metro-equipment'),
      (v_cust_3, v_ft_balance,  9200, 'crm-demo-coastal-construction');
  end if;

  if v_ft_avg_days is not null then
    insert into public.entity_facts (entity_id, fact_type_id, value, source_id)
    values
      (v_cust_1, v_ft_avg_days, 28, 'crm-demo-acme-industrial'),
      (v_cust_2, v_ft_avg_days, 45, 'crm-demo-metro-equipment'),
      (v_cust_3, v_ft_avg_days, 14, 'crm-demo-coastal-construction');
  end if;

end;
$$;
