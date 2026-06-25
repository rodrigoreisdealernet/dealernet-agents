-- CRM auto-population from transactional records: smoke tests
-- Validates the crm_enrich_from_transactional_record RPC and the enriched
-- crm_customer_profile_current view introduced in
-- 20260611020000_crm_auto_populate_from_transactional.sql.
--
-- Test coverage:
--  1.  Function exists with the correct signature
--  1b. Function privileges: authenticated/service_role=EXECUTE, anon=denied
--  2.  Quote enrichment creates a new CRM customer profile (match_method='created')
--  3.  Reprocessing the same quote is idempotent (no duplicate entity)
--  4.  Second quote with the same email enriches the existing profile (match_method='email')
--  5.  Order enrichment with explicit customer_id matches correctly (match_method='customer_id')
--  6.  Billing account ID resolves to parent customer (match_method='billing_account_id')
--  7.  Phone-based match finds existing customer via contact (match_method='phone')
--  8.  High-trust fields are NOT overwritten by transactional data
--  9.  Billing event updates entity_facts only (no new entity version written)
-- 10.  crm_customer_profile_current exposes enriched fields and primary contact
-- 11.  Tenant scoping: customer with org_scope_id is not visible across tenants
-- 12.  Authenticated same-tenant enrichment succeeds
-- 13.  Authenticated cross-tenant enrichment is rejected (42501)
-- 14.  New customer created by authenticated caller is tenant-scoped (not globally visible)

begin;

-- ── Shared setup ─────────────────────────────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- ── 1. Function signature present ──────────────────────────────────────────
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'crm_enrich_from_transactional_record'
  ) then
    raise exception 'FAIL 1: crm_enrich_from_transactional_record function not found';
  end if;

  raise notice 'PASS 1: crm_enrich_from_transactional_record function exists';
end;
$$;

-- ── 1b. Function privilege assertions ────────────────────────────────────────
-- Verifies that REVOKE ALL ... FROM public removes default PUBLIC execute access
-- and that only authenticated and service_role have EXECUTE.
do $$
declare
  v_sig text :=
    'public.crm_enrich_from_transactional_record(text,text,uuid,uuid,text,text,jsonb,jsonb,jsonb)';
begin
  if has_function_privilege('authenticated', v_sig, 'EXECUTE') is not true then
    raise exception 'FAIL 1b: authenticated should have EXECUTE on crm_enrich_from_transactional_record';
  end if;

  if has_function_privilege('service_role', v_sig, 'EXECUTE') is not true then
    raise exception 'FAIL 1b: service_role should have EXECUTE on crm_enrich_from_transactional_record';
  end if;

  if has_function_privilege('anon', v_sig, 'EXECUTE') then
    raise exception 'FAIL 1b: anon should NOT have EXECUTE on crm_enrich_from_transactional_record';
  end if;

  raise notice 'PASS 1b: privilege check — authenticated/service_role=allowed, anon=denied';
end;
$$;

-- ── 2. Quote enrichment creates new customer profile ─────────────────────────
do $$
declare
  v_customer_id    uuid;
  v_match_method   text;
  v_enriched       boolean;
  v_version        int;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select t.customer_entity_id, t.match_method, t.enriched, t.version_number
    into v_customer_id, v_match_method, v_enriched, v_version
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'quote',
    p_source_record_id => 'txn-smoke-quote-001',
    p_contact_email    => 'smoke.customer@example.com',
    p_contact_phone    => '+15550001111',
    p_enrichment_data  => jsonb_build_object(
      'name',          'Smoke Transactional Corp',
      'customer_type', 'commercial',
      'industry',      'construction'
    ),
    p_contact_data     => jsonb_build_object(
      'name',  'Alex Smoke',
      'email', 'smoke.customer@example.com',
      'phone', '+15550001111'
    )
  ) as t;

  if v_customer_id is null then
    raise exception 'FAIL 2: quote enrichment returned null customer_entity_id';
  end if;

  if v_match_method <> 'created' then
    raise exception 'FAIL 2: expected match_method=created, got %', v_match_method;
  end if;

  if not v_enriched then
    raise exception 'FAIL 2: expected enriched=true for new customer';
  end if;

  if v_version is null or v_version < 1 then
    raise exception 'FAIL 2: expected version_number >= 1, got %', v_version;
  end if;

  raise notice 'PASS 2: quote enrichment created new customer %, version %',
    v_customer_id, v_version;
end;
$$;

-- ── 3. Reprocessing the same quote is idempotent ──────────────────────────────
do $$
declare
  v_customer_id_a  uuid;
  v_customer_id_b  uuid;
  v_entity_count   bigint;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- First call (already done in test 2 — this simulates a second identical call).
  select t.customer_entity_id
    into v_customer_id_a
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'quote',
    p_source_record_id => 'txn-smoke-quote-001',
    p_contact_email    => 'smoke.customer@example.com',
    p_enrichment_data  => jsonb_build_object(
      'name', 'Smoke Transactional Corp',
      'industry', 'construction'
    )
  ) as t;

  -- Second call with same identifiers.
  select t.customer_entity_id
    into v_customer_id_b
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'quote',
    p_source_record_id => 'txn-smoke-quote-001',
    p_contact_email    => 'smoke.customer@example.com',
    p_enrichment_data  => jsonb_build_object(
      'name', 'Smoke Transactional Corp',
      'industry', 'construction'
    )
  ) as t;

  if v_customer_id_a is distinct from v_customer_id_b then
    raise exception
      'FAIL 3: idempotency broken – two calls returned different entity IDs: % vs %',
      v_customer_id_a, v_customer_id_b;
  end if;

  -- Verify only one customer entity with the email-derived source_record_id.
  select count(*)
    into v_entity_count
  from public.entities
  where entity_type      = 'customer'
    and source_record_id = 'enrich:email:smoke.customer@example.com';

  if v_entity_count <> 1 then
    raise exception
      'FAIL 3: expected exactly 1 customer entity, found %', v_entity_count;
  end if;

  raise notice 'PASS 3: idempotency verified – same customer entity returned for repeat call';
end;
$$;

-- ── 4. Second quote with same email enriches existing profile ─────────────────
do $$
declare
  v_customer_id    uuid;
  v_match_method   text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select t.customer_entity_id, t.match_method
    into v_customer_id, v_match_method
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'quote',
    p_source_record_id => 'txn-smoke-quote-002',
    p_contact_email    => 'smoke.customer@example.com',
    p_enrichment_data  => jsonb_build_object('tier', 'silver')
  ) as t;

  if v_customer_id is null then
    raise exception 'FAIL 4: second quote enrichment returned null customer_entity_id';
  end if;

  if v_match_method <> 'email' then
    raise exception 'FAIL 4: expected match_method=email, got %', v_match_method;
  end if;

  raise notice 'PASS 4: second quote matched existing customer by email, match_method=%',
    v_match_method;
end;
$$;

-- ── 5. Order with explicit customer_id matches correctly ─────────────────────
do $$
declare
  v_target_id       uuid;
  v_result_id       uuid;
  v_match_method    text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- Look up the customer created in test 2.
  select e.id
    into v_target_id
  from public.entities e
  where e.entity_type      = 'customer'
    and e.source_record_id = 'enrich:email:smoke.customer@example.com';

  if v_target_id is null then
    raise exception 'FAIL 5: prerequisite customer not found';
  end if;

  select t.customer_entity_id, t.match_method
    into v_result_id, v_match_method
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'order',
    p_source_record_id => 'txn-smoke-order-001',
    p_customer_id      => v_target_id,
    p_enrichment_data  => jsonb_build_object('hq_address', '99 Smoke Ave, Dallas TX')
  ) as t;

  if v_result_id is distinct from v_target_id then
    raise exception
      'FAIL 5: order enrichment returned wrong customer % (expected %)',
      v_result_id, v_target_id;
  end if;

  if v_match_method <> 'customer_id' then
    raise exception 'FAIL 5: expected match_method=customer_id, got %', v_match_method;
  end if;

  raise notice 'PASS 5: order with customer_id matched correctly, method=%', v_match_method;
end;
$$;

-- ── 6. Billing account ID resolves to parent customer ────────────────────────
do $$
declare
  v_target_id      uuid;
  v_ba_id          uuid;
  v_result_id      uuid;
  v_match_method   text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select e.id
    into v_target_id
  from public.entities e
  where e.entity_type      = 'customer'
    and e.source_record_id = 'enrich:email:smoke.customer@example.com';

  -- Create a billing account entity and link it to the customer.
  select upserted.entity_id
    into v_ba_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'billing_account',
    p_source_record_id => 'txn-smoke-billing-acct-001',
    p_data             => jsonb_build_object(
      'name',        'Smoke Corp Billing',
      'currency',    'USD'
    )
  ) as upserted;

  perform public.rental_upsert_relationship(
    'customer_has_billing_account', v_target_id, v_ba_id
  );

  select t.customer_entity_id, t.match_method
    into v_result_id, v_match_method
  from public.crm_enrich_from_transactional_record(
    p_source_type        => 'contract',
    p_source_record_id   => 'txn-smoke-contract-001',
    p_billing_account_id => v_ba_id,
    p_enrichment_data    => jsonb_build_object('industry', 'heavy_civil')
  ) as t;

  if v_result_id is distinct from v_target_id then
    raise exception
      'FAIL 6: billing_account_id match returned wrong customer % (expected %)',
      v_result_id, v_target_id;
  end if;

  if v_match_method <> 'billing_account_id' then
    raise exception 'FAIL 6: expected match_method=billing_account_id, got %', v_match_method;
  end if;

  raise notice 'PASS 6: billing_account_id resolved to customer %, method=%',
    v_result_id, v_match_method;
end;
$$;

-- ── 7. Phone-based match finds existing customer via contact ──────────────────
do $$
declare
  v_target_id      uuid;
  v_result_id      uuid;
  v_match_method   text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select e.id
    into v_target_id
  from public.entities e
  where e.entity_type      = 'customer'
    and e.source_record_id = 'enrich:email:smoke.customer@example.com';

  -- A new quote arrives with only phone (same phone number registered in test 2).
  select t.customer_entity_id, t.match_method
    into v_result_id, v_match_method
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'quote',
    p_source_record_id => 'txn-smoke-quote-phone-001',
    p_contact_phone    => '+15550001111',
    p_enrichment_data  => jsonb_build_object('preferred_payment_method', 'check')
  ) as t;

  if v_result_id is distinct from v_target_id then
    raise exception
      'FAIL 7: phone match returned wrong customer % (expected %)',
      v_result_id, v_target_id;
  end if;

  if v_match_method <> 'phone' then
    raise exception 'FAIL 7: expected match_method=phone, got %', v_match_method;
  end if;

  raise notice 'PASS 7: phone match found existing customer, method=%', v_match_method;
end;
$$;

-- ── 8. High-trust fields not overwritten by transactional data ────────────────
do $$
declare
  v_target_id        uuid;
  v_name_before      text;
  v_industry_before  text;
  v_name_after       text;
  v_industry_after   text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select e.id
    into v_target_id
  from public.entities e
  where e.entity_type      = 'customer'
    and e.source_record_id = 'enrich:email:smoke.customer@example.com';

  -- Read current profile values (set from test 2).
  select ev.data->>'name', ev.data->>'industry'
    into v_name_before, v_industry_before
  from public.entity_versions ev
  where ev.entity_id = v_target_id
    and ev.is_current;

  -- Attempt to overwrite existing high-trust fields via transactional enrichment.
  perform public.crm_enrich_from_transactional_record(
    p_source_type      => 'order',
    p_source_record_id => 'txn-smoke-order-overwrite-attempt',
    p_customer_id      => v_target_id,
    p_enrichment_data  => jsonb_build_object(
      'name',     'SHOULD NOT OVERWRITE',
      'industry', 'SHOULD NOT OVERWRITE'
    )
  );

  select ev.data->>'name', ev.data->>'industry'
    into v_name_after, v_industry_after
  from public.entity_versions ev
  where ev.entity_id = v_target_id
    and ev.is_current;

  if v_name_after <> v_name_before then
    raise exception
      'FAIL 8: name was overwritten by transactional data (before: %, after: %)',
      v_name_before, v_name_after;
  end if;

  if v_industry_after <> v_industry_before then
    raise exception
      'FAIL 8: industry was overwritten by transactional data (before: %, after: %)',
      v_industry_before, v_industry_after;
  end if;

  raise notice 'PASS 8: high-trust fields preserved (name=%, industry=%)',
    v_name_after, v_industry_after;
end;
$$;

-- ── 9. Billing event updates facts only (no new entity version) ───────────────
do $$
declare
  v_target_id       uuid;
  v_version_before  int;
  v_version_after   int;
  v_balance_fact    numeric;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select e.id
    into v_target_id
  from public.entities e
  where e.entity_type      = 'customer'
    and e.source_record_id = 'enrich:email:smoke.customer@example.com';

  select ev.version_number
    into v_version_before
  from public.entity_versions ev
  where ev.entity_id = v_target_id
    and ev.is_current;

  perform public.crm_enrich_from_transactional_record(
    p_source_type      => 'billing_event',
    p_source_record_id => 'txn-smoke-billing-evt-001',
    p_customer_id      => v_target_id,
    p_billing_facts    => jsonb_build_object(
      'balance',       1250.50,
      'credit_limit',  5000.00
    )
  );

  select ev.version_number
    into v_version_after
  from public.entity_versions ev
  where ev.entity_id = v_target_id
    and ev.is_current;

  if v_version_after <> v_version_before then
    raise exception
      'FAIL 9: billing_event wrote a new entity version (before: %, after: %)',
      v_version_before, v_version_after;
  end if;

  -- Verify the balance fact was written.
  select ef.value
    into v_balance_fact
  from public.entity_facts ef
  join public.fact_types ft on ft.id = ef.fact_type_id
  where ef.entity_id = v_target_id
    and ft.key       = 'customer_balance';

  if v_balance_fact is distinct from 1250.50 then
    raise exception
      'FAIL 9: expected balance fact 1250.50, got %', v_balance_fact;
  end if;

  raise notice
    'PASS 9: billing_event updated facts only (version unchanged=%, balance=%)',
    v_version_after, v_balance_fact;
end;
$$;

-- ── 10. crm_customer_profile_current exposes enriched fields ──────────────────
do $$
declare
  v_target_id             uuid;
  v_last_enriched         text;
  v_last_source_type      text;
  v_first_transactional   text;
  v_source_count          int;
  v_contact_email_col     text;
  v_balance               numeric;
  v_credit_limit          numeric;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select e.id
    into v_target_id
  from public.entities e
  where e.entity_type      = 'customer'
    and e.source_record_id = 'enrich:email:smoke.customer@example.com';

  select
    p.last_enriched_at,
    p.last_enrichment_source_type,
    p.first_transactional_at,
    p.transactional_source_count,
    p.primary_contact_email,
    p.balance,
    p.credit_limit
  into
    v_last_enriched,
    v_last_source_type,
    v_first_transactional,
    v_source_count,
    v_contact_email_col,
    v_balance,
    v_credit_limit
  from public.crm_customer_profile_current p
  where p.entity_id = v_target_id;

  if v_last_enriched is null then
    raise exception 'FAIL 10: crm_customer_profile_current.last_enriched_at is null';
  end if;

  if v_last_source_type is null then
    raise exception 'FAIL 10: crm_customer_profile_current.last_enrichment_source_type is null';
  end if;

  if v_first_transactional is null then
    raise exception 'FAIL 10: crm_customer_profile_current.first_transactional_at is null';
  end if;

  if v_source_count is null or v_source_count < 1 then
    raise exception
      'FAIL 10: crm_customer_profile_current.transactional_source_count invalid (%)',
      v_source_count;
  end if;

  if v_contact_email_col is null then
    raise exception 'FAIL 10: crm_customer_profile_current.primary_contact_email is null';
  end if;

  if v_balance is distinct from 1250.50 then
    raise exception 'FAIL 10: expected balance=1250.50, got %', v_balance;
  end if;

  if v_credit_limit is distinct from 5000.00 then
    raise exception 'FAIL 10: expected credit_limit=5000.00, got %', v_credit_limit;
  end if;

  raise notice
    'PASS 10: crm_customer_profile_current shows enriched fields (source=%, count=%, email=%)',
    v_last_source_type, v_source_count, v_contact_email_col;
end;
$$;

-- ── 11. Tenant scoping: cross-tenant visibility blocked ───────────────────────

-- Setup tenant-b customer via service_role.
do $$
declare
  v_company_b_id  uuid;
  v_region_b_id   uuid;
  v_branch_b_id   uuid;
  v_customer_b_id uuid;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id into v_company_b_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'company',
    p_source_record_id => 'txn-smoke-tenant-b-company',
    p_data             => jsonb_build_object('name', 'Tenant B Corp', 'tenant', 'tenant-b')
  );

  select entity_id into v_region_b_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'region',
    p_source_record_id => 'txn-smoke-tenant-b-region',
    p_data             => jsonb_build_object('name', 'Tenant B Region', 'tenant', 'tenant-b')
  );
  perform public.rental_upsert_relationship('company_has_region', v_company_b_id, v_region_b_id);

  select entity_id into v_branch_b_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'branch',
    p_source_record_id => 'txn-smoke-tenant-b-branch',
    p_data             => jsonb_build_object('name', 'Tenant B Branch', 'tenant', 'tenant-b')
  );
  perform public.rental_upsert_relationship('region_has_branch', v_region_b_id, v_branch_b_id);

  -- Create tenant-b customer with org_scope_id linked to its branch.
  select t.customer_entity_id
    into v_customer_b_id
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'order',
    p_source_record_id => 'txn-smoke-tenant-b-order-001',
    p_enrichment_data  => jsonb_build_object(
      'name',        'Tenant B Customer',
      'org_scope_id', v_branch_b_id::text
    )
  ) as t;

  if v_customer_b_id is null then
    raise exception 'FAIL 11: tenant-b customer creation failed';
  end if;

  raise notice 'PASS 11 setup: tenant-b customer created with branch scope';
end;
$$;

-- Verify tenant-a authenticated user cannot see tenant-b customer.
set local role authenticated;
select set_config('request.jwt.claim.role', '', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000201","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}',
  true
);

do $$
declare
  v_tenant_a_count int;
  v_tenant_b_count int;
begin
  select count(*)
    into v_tenant_a_count
  from public.crm_customer_profile_current
  where source_record_id = 'enrich:email:smoke.customer@example.com';

  select count(*)
    into v_tenant_b_count
  from public.crm_customer_profile_current
  where source_record_id like 'enrich:order:txn-smoke-tenant-b-%';

  -- Tenant-a user may see the unscoped customer created in test 2 (no org_scope_id set).
  -- Tenant-b customer with a branch org_scope_id should NOT be visible to tenant-a.
  if v_tenant_b_count > 0 then
    raise exception
      'FAIL 11: tenant-a user sees % tenant-b customer row(s) — cross-tenant leak',
      v_tenant_b_count;
  end if;

  raise notice 'PASS 11: tenant scoping blocks tenant-b customer from tenant-a view (tenant_b_count=%)',
    v_tenant_b_count;
end;
$$;

reset role;

-- ── 12-14. Authenticated scope enforcement ────────────────────────────────────

-- Setup: create tenant-a org hierarchy and a scoped customer via service_role.
do $$
declare
  v_company_a_id  uuid;
  v_region_a_id   uuid;
  v_branch_a_id   uuid;
  v_customer_a_id uuid;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id into v_company_a_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'company',
    p_source_record_id => 'txn-smoke-tenant-a-company',
    p_data             => jsonb_build_object('name', 'Tenant A Corp', 'tenant', 'tenant-a')
  );

  select entity_id into v_region_a_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'region',
    p_source_record_id => 'txn-smoke-tenant-a-region',
    p_data             => jsonb_build_object('name', 'Tenant A Region', 'tenant', 'tenant-a')
  );
  perform public.rental_upsert_relationship('company_has_region', v_company_a_id, v_region_a_id);

  select entity_id into v_branch_a_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'branch',
    p_source_record_id => 'txn-smoke-tenant-a-branch',
    p_data             => jsonb_build_object('name', 'Tenant A Branch', 'tenant', 'tenant-a')
  );
  perform public.rental_upsert_relationship('region_has_branch', v_region_a_id, v_branch_a_id);

  -- Create a scoped customer for tenant-a.
  select t.customer_entity_id into v_customer_a_id
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'order',
    p_source_record_id => 'txn-smoke-tenant-a-customer-setup',
    p_enrichment_data  => jsonb_build_object(
      'name',        'Tenant A Customer',
      'org_scope_id', v_company_a_id::text
    )
  ) as t;

  if v_customer_a_id is null then
    raise exception 'FAIL 12-14 setup: tenant-a customer creation failed';
  end if;

  raise notice 'PASS 12-14 setup: tenant-a org hierarchy and customer created';
end;
$$;

-- ── 12. Same-tenant authenticated enrichment succeeds ────────────────────────
do $$
declare
  v_customer_a_id  uuid;
  v_result_id      uuid;
  v_match_method   text;
begin
  -- Simulate authenticated tenant-a caller.
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}',
    true
  );

  select e.id into v_customer_a_id
  from public.entities e
  where e.entity_type      = 'customer'
    and e.source_record_id = 'enrich:order:txn-smoke-tenant-a-customer-setup';

  if v_customer_a_id is null then
    raise exception 'FAIL 12: prerequisite tenant-a customer not found';
  end if;

  select t.customer_entity_id, t.match_method
    into v_result_id, v_match_method
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'quote',
    p_source_record_id => 'txn-smoke-auth-enrich-012',
    p_customer_id      => v_customer_a_id,
    p_enrichment_data  => jsonb_build_object('preferred_payment_method', 'ach')
  ) as t;

  if v_result_id is distinct from v_customer_a_id then
    raise exception
      'FAIL 12: same-tenant enrichment returned wrong customer (expected %, got %)',
      v_customer_a_id, v_result_id;
  end if;

  -- Restore service_role for subsequent tests.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '', true);

  raise notice 'PASS 12: same-tenant authenticated enrichment succeeded (match=%)', v_match_method;
end;
$$;

-- ── 13. Cross-tenant authenticated enrichment is rejected ─────────────────────
do $$
declare
  v_customer_b_id  uuid;
  v_caught         boolean := false;
begin
  -- Simulate authenticated tenant-a caller.
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}',
    true
  );

  -- Look up tenant-b customer (scoped to tenant-b, invisible to tenant-a).
  select e.id into v_customer_b_id
  from public.entities e
  where e.entity_type      = 'customer'
    and e.source_record_id = 'enrich:order:txn-smoke-tenant-b-order-001';

  if v_customer_b_id is null then
    raise exception 'FAIL 13: prerequisite tenant-b customer not found';
  end if;

  begin
    perform public.crm_enrich_from_transactional_record(
      p_source_type      => 'order',
      p_source_record_id => 'txn-smoke-cross-tenant-013',
      p_customer_id      => v_customer_b_id,
      p_enrichment_data  => jsonb_build_object('name', 'Should Not Reach')
    );
  exception when sqlstate '42501' then
    v_caught := true;
  end;

  -- Restore service_role for subsequent tests.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '', true);

  if not v_caught then
    raise exception
      'FAIL 13: cross-tenant enrichment via customer_id should have raised 42501';
  end if;

  raise notice 'PASS 13: cross-tenant enrichment correctly rejected with 42501';
end;
$$;

-- ── 14. New customer created by authenticated caller is tenant-scoped ──────────
do $$
declare
  v_company_a_id   uuid;
  v_new_customer_id uuid;
  v_entity_scope_id uuid;
begin
  -- Simulate authenticated tenant-a caller.
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"tenant-a"}}',
    true
  );

  select t.customer_entity_id into v_new_customer_id
  from public.crm_enrich_from_transactional_record(
    p_source_type      => 'quote',
    p_source_record_id => 'txn-smoke-auth-new-customer-014',
    p_contact_email    => 'auth-created-014@example.com',
    p_enrichment_data  => jsonb_build_object('name', 'Auth Created Customer 014')
  ) as t;

  if v_new_customer_id is null then
    raise exception 'FAIL 14: authenticated new-customer creation returned null';
  end if;

  -- Restore service_role before querying entities directly.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '', true);

  -- Look up tenant-a company id.
  select e.id into v_company_a_id
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.entity_type = 'company'
    and ev.data ->> 'tenant' = 'tenant-a';

  -- The new customer's org_scope_id must be set (not null) and resolvable to tenant-a.
  select e.org_scope_id into v_entity_scope_id
  from public.entities e
  where e.id = v_new_customer_id;

  if v_entity_scope_id is null then
    raise exception
      'FAIL 14: new customer % has null org_scope_id — globally visible to all tenants',
      v_new_customer_id;
  end if;

  -- Verify the scope is within tenant-a's closure (ancestor is tenant-a company).
  if not exists (
    select 1
    from public.org_scope_closure osc
    where osc.ancestor_id  = v_company_a_id
      and osc.descendant_id = v_entity_scope_id
  ) then
    raise exception
      'FAIL 14: new customer org_scope_id % is not within tenant-a company scope',
      v_entity_scope_id;
  end if;

  raise notice 'PASS 14: authenticated new customer % is scoped to tenant-a (scope=%)',
    v_new_customer_id, v_entity_scope_id;
end;
$$;

-- Verify tenant-b cannot see the customer created in test 14.
set local role authenticated;
select set_config('request.jwt.claim.role', '', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000202","role":"authenticated","app_metadata":{"role":"branch_manager","tenant":"tenant-b"}}',
  true
);

do $$
declare
  v_visible_to_b int;
begin
  select count(*) into v_visible_to_b
  from public.crm_customer_profile_current
  where source_record_id = 'enrich:email:auth-created-014@example.com';

  if v_visible_to_b > 0 then
    raise exception
      'FAIL 14b: tenant-b can see % row(s) of tenant-a-created customer — cross-tenant leak',
      v_visible_to_b;
  end if;

  raise notice 'PASS 14b: tenant-a-created customer is not visible to tenant-b (count=%)',
    v_visible_to_b;
end;
$$;

reset role;

rollback;
