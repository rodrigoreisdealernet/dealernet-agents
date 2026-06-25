-- CRM customer profile model smoke tests
-- Verifies that the migration applied cleanly and the profile model works
-- end-to-end: entity types, relationship types, fact types, upsert RPC,
-- and the crm_customer_profile_current read-model view.

begin;

do $$
declare
  v_customer_id         uuid;
  v_customer_version_id uuid;
  v_version_number      int;
  v_upsert_data         jsonb;
  v_contact_id          uuid;
  v_note_id             uuid;
  v_doc_id              uuid;
  v_profile_name        text;
  v_profile_balance     numeric;
  v_profile_credit      numeric;
  v_fact_balance_id     uuid;
  v_fact_credit_id      uuid;
  v_v2_version_number   int;
  v_merged_data         jsonb;
  v_contact_count       bigint;
  v_note_count          bigint;
  v_doc_count           bigint;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- ------------------------------------------------------------------
  -- 1. Entity type catalog includes 'document' and 'note'
  -- ------------------------------------------------------------------
  if not exists (
    select 1 from rental_entity_type_catalog where entity_type = 'document'
  ) then
    raise exception 'CRM test failed: entity type "document" not in catalog';
  end if;

  if not exists (
    select 1 from rental_entity_type_catalog where entity_type = 'note'
  ) then
    raise exception 'CRM test failed: entity type "note" not in catalog';
  end if;

  -- ------------------------------------------------------------------
  -- 2. Relationship type catalog includes CRM relationship types
  -- ------------------------------------------------------------------
  if not exists (
    select 1 from rental_relationship_type_catalog
    where relationship_type = 'customer_has_document'
  ) then
    raise exception 'CRM test failed: relationship type "customer_has_document" not in catalog';
  end if;

  if not exists (
    select 1 from rental_relationship_type_catalog
    where relationship_type = 'customer_has_note'
  ) then
    raise exception 'CRM test failed: relationship type "customer_has_note" not in catalog';
  end if;

  -- ------------------------------------------------------------------
  -- 3. Fact types registered for customer numeric rollups
  -- ------------------------------------------------------------------
  if not exists (select 1 from fact_types where key = 'customer_balance') then
    raise exception 'CRM test failed: fact type "customer_balance" not registered';
  end if;

  if not exists (select 1 from fact_types where key = 'customer_credit_limit') then
    raise exception 'CRM test failed: fact type "customer_credit_limit" not registered';
  end if;

  if not exists (select 1 from fact_types where key = 'customer_avg_days_to_pay') then
    raise exception 'CRM test failed: fact type "customer_avg_days_to_pay" not registered';
  end if;

  if not exists (select 1 from fact_types where key = 'customer_payment_issue_flag') then
    raise exception 'CRM test failed: fact type "customer_payment_issue_flag" not registered';
  end if;

  -- ------------------------------------------------------------------
  -- 4. crm_upsert_customer_profile creates a new customer
  -- ------------------------------------------------------------------
  select t.entity_id, t.entity_version_id, t.version_number
    into v_customer_id, v_customer_version_id, v_version_number
  from crm_upsert_customer_profile(
    p_source_record_id => 'crm-smoke-test-customer-1',
    p_data => jsonb_build_object(
      'name',                    'Smoke Test Corp',
      'customer_type',           'national',
      'tier',                    'gold',
      'industry',                'heavy_civil',
      'hq_address',              '1 Test Lane, Smoke City, TX 75000',
      'preferred_payment_method','ach',
      'preferences',             jsonb_build_object('invoice_frequency', 'monthly'),
      'payment_methods',         jsonb_build_array(
        jsonb_build_object(
          'type',           'ach',
          'masked_account', '****4321',
          'provider_ref',   'ach-ref-smoke-001'
        )
      )
    )
  ) as t;

  if v_customer_id is null then
    raise exception 'CRM test failed: crm_upsert_customer_profile returned null entity_id';
  end if;

  if v_version_number <> 1 then
    raise exception 'CRM test failed: expected version_number=1 on create, got %', v_version_number;
  end if;

  -- ------------------------------------------------------------------
  -- 5. Idempotent re-upsert (full replace) creates version 2
  -- ------------------------------------------------------------------
  select t.entity_id, t.version_number
    into v_customer_id, v_v2_version_number
  from crm_upsert_customer_profile(
    p_source_record_id => 'crm-smoke-test-customer-1',
    p_data => jsonb_build_object(
      'name',                    'Smoke Test Corp Updated',
      'customer_type',           'national',
      'tier',                    'platinum',
      'industry',                'heavy_civil',
      'hq_address',              '1 Test Lane, Smoke City, TX 75000',
      'preferred_payment_method','ach'
    )
  ) as t;

  if v_v2_version_number <> 2 then
    raise exception 'CRM test failed: expected version_number=2 on update, got %', v_v2_version_number;
  end if;

  -- ------------------------------------------------------------------
  -- 6. Enrich-only upsert merges data without losing existing keys
  -- ------------------------------------------------------------------
  select t.data
    into v_merged_data
  from crm_upsert_customer_profile(
    p_source_record_id => 'crm-smoke-test-customer-1',
    p_data             => jsonb_build_object('notes_count', 1),
    p_enrich_only      => true
  ) as t;

  -- Existing 'name' key should be preserved after enrich
  if v_merged_data ->> 'name' is null then
    raise exception 'CRM test failed: enrich-only lost existing name field';
  end if;

  -- Incoming key should be present
  if (v_merged_data ->> 'notes_count')::int <> 1 then
    raise exception 'CRM test failed: enrich-only did not add incoming notes_count field';
  end if;

  -- ------------------------------------------------------------------
  -- 7. Duplicate create with same source_record_id does not produce
  --    a second entity row
  -- ------------------------------------------------------------------
  declare
    v_dupe_count bigint;
  begin
    select count(*)
      into v_dupe_count
    from entities
    where entity_type      = 'customer'
      and source_record_id = 'crm-smoke-test-customer-1';

    if v_dupe_count <> 1 then
      raise exception 'CRM test failed: expected 1 customer row, found %', v_dupe_count;
    end if;
  end;

  -- ------------------------------------------------------------------
  -- 8. Contact / note / document child entity relationships
  -- ------------------------------------------------------------------
  -- Contact
  select t.entity_id into v_contact_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'contact',
    p_source_record_id => 'crm-smoke-contact-1',
    p_data             => jsonb_build_object(
      'name',        'Jamie Smoke',
      'role',        'Project Manager',
      'email',       'jamie.smoke@example.com',
      'phone',       '555-999-0001',
      'customer_id', v_customer_id
    )
  ) as t;

  perform rental_upsert_relationship(
    'customer_has_contact', v_customer_id, v_contact_id
  );

  -- Note
  select t.entity_id into v_note_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'note',
    p_source_record_id => 'crm-smoke-note-1',
    p_data             => jsonb_build_object(
      'customer_id', v_customer_id,
      'body',        'Smoke test note body.',
      'note_type',   'internal',
      'created_by',  'smoke-test'
    )
  ) as t;

  perform rental_upsert_relationship(
    'customer_has_note', v_customer_id, v_note_id
  );

  -- Document
  select t.entity_id into v_doc_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'document',
    p_source_record_id => 'crm-smoke-doc-1',
    p_data             => jsonb_build_object(
      'customer_id',   v_customer_id,
      'document_type', 'credit_application',
      'title',         'Test Credit App',
      'storage_ref',   'customers/smoke/credit_app.pdf',
      'mime_type',     'application/pdf',
      'status',        'pending'
    )
  ) as t;

  perform rental_upsert_relationship(
    'customer_has_document', v_customer_id, v_doc_id
  );

  -- Verify relationship counts
  select count(*)
    into v_contact_count
  from relationships_v2
  where parent_id         = v_customer_id
    and relationship_type = 'customer_has_contact'
    and is_current;

  if v_contact_count <> 1 then
    raise exception 'CRM test failed: expected 1 active contact relationship, found %', v_contact_count;
  end if;

  select count(*)
    into v_note_count
  from relationships_v2
  where parent_id         = v_customer_id
    and relationship_type = 'customer_has_note'
    and is_current;

  if v_note_count <> 1 then
    raise exception 'CRM test failed: expected 1 active note relationship, found %', v_note_count;
  end if;

  select count(*)
    into v_doc_count
  from relationships_v2
  where parent_id         = v_customer_id
    and relationship_type = 'customer_has_document'
    and is_current;

  if v_doc_count <> 1 then
    raise exception 'CRM test failed: expected 1 active document relationship, found %', v_doc_count;
  end if;

  -- ------------------------------------------------------------------
  -- 9. Entity facts: insert balance and credit_limit
  -- ------------------------------------------------------------------
  select id into v_fact_balance_id from fact_types where key = 'customer_balance';
  select id into v_fact_credit_id  from fact_types where key = 'customer_credit_limit';

  insert into entity_facts (entity_id, fact_type_id, value, source_id)
  values (v_customer_id, v_fact_balance_id, 15000, 'smoke-test')
  on conflict (entity_id, fact_type_id, dimension_id) do update
    set value = excluded.value, updated_at = now();

  insert into entity_facts (entity_id, fact_type_id, value, source_id)
  values (v_customer_id, v_fact_credit_id, 100000, 'smoke-test')
  on conflict (entity_id, fact_type_id, dimension_id) do update
    set value = excluded.value, updated_at = now();

  -- ------------------------------------------------------------------
  -- 10. crm_customer_profile_current view surfaces the profile + facts
  -- ------------------------------------------------------------------
  select name, balance, credit_limit
    into v_profile_name, v_profile_balance, v_profile_credit
  from crm_customer_profile_current
  where entity_id = v_customer_id;

  if v_profile_name is null then
    raise exception 'CRM test failed: crm_customer_profile_current returned null name';
  end if;

  if v_profile_balance <> 15000 then
    raise exception 'CRM test failed: expected balance=15000, got %', v_profile_balance;
  end if;

  if v_profile_credit <> 100000 then
    raise exception 'CRM test failed: expected credit_limit=100000, got %', v_profile_credit;
  end if;

  raise notice 'CRM customer profile model smoke tests passed';
end;
$$;

-- ── Role-based behavioral tests (11–15) ───────────────────────────────────
-- Pattern: SET LOCAL ROLE + set_config('request.jwt.claims', ...) to simulate
-- the PostgREST JWT contexts used in production.
--
-- auth.jwt() is replaced within this transaction so get_my_role() can resolve
-- app_metadata.role from the claims GUC (mirroring real PostgREST behavior).
-- All DDL and data changes are rolled back at the end of the transaction.
--
-- The outer DO block (tests 1–10) ran with request.jwt.claim.role='service_role'
-- still active in the transaction; clear it before the role-switch tests so the
-- legacy GUC does not short-circuit the modern request.jwt.claims checks.
select set_config('request.jwt.claim.role', '', true);

-- Replace auth.jwt() so it reads from request.jwt.claims — mirrors production
-- GoTrue behavior. Wrapped in a DO block so it degrades gracefully when running
-- against a real Supabase stack (supabase db reset) where auth is owned by
-- supabase_auth_admin and postgres cannot replace the function. In that case
-- GoTrue's auth.jwt() already reads from request.jwt.claims, so no-op is safe.
do $guard$
begin
  execute $f$
    create or replace function auth.jwt() returns jsonb language sql as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $$
  $f$;
exception
  when insufficient_privilege then null;
end;
$guard$;

-- ── 11. authenticated + admin app role can execute crm_upsert_customer_profile ──
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000100","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_entity_id uuid;
  v_version   int;
begin
  select t.entity_id, t.version_number
    into v_entity_id, v_version
  from crm_upsert_customer_profile(
    p_source_record_id => 'crm-role-test-auth-admin',
    p_data             => jsonb_build_object('name', 'Role Test Corp (admin)')
  ) as t;

  if v_entity_id is null then
    raise exception 'FAIL 11: authenticated/admin crm_upsert_customer_profile returned null entity_id';
  end if;

  raise notice 'PASS 11: authenticated/admin role can execute crm_upsert_customer_profile';
end;
$$;

reset role;

-- ── 12. authenticated + read_only app role is denied the RPC (42501) ─────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform crm_upsert_customer_profile(
      p_source_record_id => 'crm-role-test-auth-readonly',
      p_data             => jsonb_build_object('name', 'Role Test Corp (read_only)')
    );
    raise exception 'FAIL 12: authenticated/read_only RPC call succeeded — 42501 guard is missing';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 12: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 12: authenticated/read_only did not raise 42501 for crm_upsert_customer_profile';
  end if;

  raise notice 'PASS 12: authenticated/read_only is denied crm_upsert_customer_profile (42501)';
end;
$$;

reset role;

-- ── 13. anon cannot execute the RPC (not in GRANT EXECUTE) ───────────────
set local role anon;

do $$
declare
  v_caught bool := false;
begin
  begin
    perform crm_upsert_customer_profile(
      p_source_record_id => 'crm-role-test-anon',
      p_data             => jsonb_build_object('name', 'Anon Attempt Corp')
    );
    raise exception 'FAIL 13: anon RPC call succeeded — GRANT EXECUTE to authenticated is too permissive';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 13: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 13: anon did not raise 42501 for crm_upsert_customer_profile';
  end if;

  raise notice 'PASS 13: anon is denied crm_upsert_customer_profile (no GRANT EXECUTE)';
end;
$$;

reset role;

-- ── 14. authenticated can SELECT from crm_customer_profile_current ────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_count int;
  v_last_interaction_type text;
  v_last_interaction_summary text;
begin
  select count(*) into v_count from public.crm_customer_profile_current;

  select last_interaction_type, last_interaction_summary
    into v_last_interaction_type, v_last_interaction_summary
  from public.crm_customer_profile_current
  where source_record_id = 'crm-customer-001';

  if v_last_interaction_type <> 'customer_call_logged' then
    raise exception 'FAIL 14a: expected last_interaction_type=customer_call_logged for crm-customer-001, got %', v_last_interaction_type;
  end if;

  if v_last_interaction_summary <> 'Left voicemail for AP manager regarding overdue balance.' then
    raise exception 'FAIL 14b: expected projected last_interaction_summary for crm-customer-001, got %', v_last_interaction_summary;
  end if;

  -- count >= 0 confirms no permission exception was raised
  raise notice 'PASS 14: authenticated/read_only can SELECT projected profile fields from crm_customer_profile_current (count=%)', v_count;
end;
$$;

reset role;

-- ── 15. anon is denied SELECT from crm_customer_profile_current ──────────
-- The view grants SELECT only to authenticated; the anon grant was removed
-- from the migration because this view surfaces customer financial data.
-- security_invoker = true also blocks anon from reading the base tables.
set local role anon;

do $$
declare
  v_caught bool := false;
  v_dummy  int;
begin
  begin
    select count(*) into v_dummy from public.crm_customer_profile_current;
    raise exception 'FAIL 15: anon SELECT on crm_customer_profile_current succeeded — grant is too permissive';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 15: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 15: anon was not denied SELECT on crm_customer_profile_current';
  end if;

  raise notice 'PASS 15: anon is denied SELECT on crm_customer_profile_current (no GRANT SELECT)';
end;
$$;

reset role;

-- ── 16. Catalogs include durable CRM issue model types ──────────────────────
do $$
begin
  if not exists (
    select 1 from public.rental_entity_type_catalog where entity_type = 'customer_issue'
  ) then
    raise exception 'FAIL 16: entity type "customer_issue" not in catalog';
  end if;

  if not exists (
    select 1 from public.rental_relationship_type_catalog where relationship_type = 'customer_has_issue'
  ) then
    raise exception 'FAIL 16: relationship type "customer_has_issue" not in catalog';
  end if;

  if not exists (
    select 1 from public.rental_relationship_type_catalog where relationship_type = 'billing_account_has_issue'
  ) then
    raise exception 'FAIL 16: relationship type "billing_account_has_issue" not in catalog';
  end if;

  raise notice 'PASS 16: CRM issue entity + relationship catalog entries present';
end;
$$;

-- ── 17. Payment-issue upsert creates durable case + updates profile flag ────
do $$
declare
  v_company_id uuid;
  v_region_id uuid;
  v_branch_id uuid;
  v_customer_id uuid;
  v_billing_account_id uuid;
  v_issue_id uuid;
  v_flag numeric;
  v_issue_count int;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id into v_company_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'company',
    p_source_record_id => 'crm-tenant-a-company',
    p_data => jsonb_build_object('name', 'Tenant A Company', 'tenant', 'tenant-a')
  );

  select entity_id into v_region_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'region',
    p_source_record_id => 'crm-tenant-a-region',
    p_data => jsonb_build_object('name', 'Tenant A Region', 'tenant', 'tenant-a')
  );

  perform public.rental_upsert_relationship('company_has_region', v_company_id, v_region_id);

  select entity_id into v_branch_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'crm-tenant-a-branch',
    p_data => jsonb_build_object('name', 'Tenant A Branch', 'tenant', 'tenant-a')
  );

  perform public.rental_upsert_relationship('region_has_branch', v_region_id, v_branch_id);

  select entity_id into v_customer_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'customer',
    p_source_record_id => 'crm-tenant-a-customer',
    p_data => jsonb_build_object(
      'name', 'Tenant A Customer',
      'org_scope_id', v_branch_id::text,
      'last_interaction_type', 'customer_call_logged',
      'last_interaction_summary', 'Tenant A collections call logged'
    )
  );

  select entity_id into v_billing_account_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'billing_account',
    p_source_record_id => 'crm-tenant-a-billing',
    p_data => jsonb_build_object('name', 'Tenant A Billing', 'customer_id', v_customer_id::text, 'org_scope_id', v_branch_id::text)
  );

  perform public.rental_upsert_relationship('customer_has_billing_account', v_customer_id, v_billing_account_id);

  select issue_entity_id, payment_issue_flag
    into v_issue_id, v_flag
  from public.crm_upsert_payment_issue(
    p_issue_source_record_id => 'pay-risk-tenant-a-001',
    p_customer_id => v_customer_id,
    p_billing_account_id => v_billing_account_id,
    p_issue_type => 'payment_issue',
    p_status => 'open',
    p_severity => 'high',
    p_owner => 'collections@tenant-a',
    p_resolution_notes => null,
    p_linked_records => jsonb_build_array(jsonb_build_object('kind', 'invoice', 'ref', 'INV-TENANT-A-001')),
    p_metadata => jsonb_build_object('trigger', 'invoice_overdue')
  );

  if v_issue_id is null then
    raise exception 'FAIL 17: crm_upsert_payment_issue did not create an issue entity';
  end if;

  if v_flag <> 1 then
    raise exception 'FAIL 17: expected payment_issue_flag=1 for open issue, got %', v_flag;
  end if;

  select count(*)
    into v_issue_count
  from public.crm_customer_issue_current
  where customer_id = v_customer_id
    and issue_entity_id = v_issue_id
    and issue_type = 'payment_issue'
    and status = 'open'
    and severity = 'high';

  if v_issue_count <> 1 then
    raise exception 'FAIL 17: expected 1 open payment issue in crm_customer_issue_current, got %', v_issue_count;
  end if;

  select payment_issue_flag
    into v_flag
  from public.crm_upsert_payment_issue(
    p_issue_source_record_id => 'pay-risk-tenant-a-001',
    p_customer_id => v_customer_id,
    p_billing_account_id => v_billing_account_id,
    p_status => 'resolved',
    p_resolution_notes => 'Paid in full'
  );

  if v_flag <> 0 then
    raise exception 'FAIL 17: expected payment_issue_flag=0 after resolution, got %', v_flag;
  end if;

  raise notice 'PASS 17: payment issue upsert creates durable issues and updates payment flag';
end;
$$;

-- ── 18. Communication timeline orders append-only events newest first ────────
do $$
declare
  v_customer_id uuid;
  v_invoice_id uuid;
  v_email_fact_id uuid;
  v_call_fact_id uuid;
  v_latest_type text;
  v_latest_linked uuid;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select e.id
    into v_customer_id
  from public.entities e
  where e.entity_type = 'customer'
    and e.source_record_id = 'crm-tenant-a-customer';

  select entity_id
    into v_invoice_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'invoice',
    p_source_record_id => 'tenant-a-invoice-001',
    p_data => jsonb_build_object(
      'invoice_number', 'INV-TENANT-A-001',
      'customer_id', v_customer_id::text,
      'org_scope_id', (select org_scope_id::text from public.entities where id = v_customer_id)
    )
  );

  select id into v_email_fact_id from public.fact_types where key = 'customer_email_sent';
  select id into v_call_fact_id from public.fact_types where key = 'customer_call_logged';

  insert into public.time_series_points (entity_id, fact_type_id, observed_at, data_payload, metadata, source_id)
  values
    (
      v_customer_id,
      v_email_fact_id,
      '2026-06-10T01:00:00Z',
      jsonb_build_object('summary', 'Sent payment reminder email'),
      jsonb_build_object('linked_entity_id', v_invoice_id::text, 'linked_entity_type', 'invoice'),
      'crm-test'
    ),
    (
      v_customer_id,
      v_call_fact_id,
      '2026-06-10T02:00:00Z',
      jsonb_build_object('summary', 'Logged collections follow-up call'),
      jsonb_build_object('linked_entity_id', v_invoice_id::text, 'linked_entity_type', 'invoice'),
      'crm-test'
    );

  select interaction_type, linked_entity_id
    into v_latest_type, v_latest_linked
  from public.crm_customer_communication_timeline
  where customer_id = v_customer_id
  order by occurred_at desc
  limit 1;

  if v_latest_type <> 'customer_call_logged' then
    raise exception 'FAIL 18: expected newest interaction_type=customer_call_logged, got %', v_latest_type;
  end if;

  if v_latest_linked is distinct from v_invoice_id then
    raise exception 'FAIL 18: expected linked_entity_id % got %', v_invoice_id, v_latest_linked;
  end if;

  raise notice 'PASS 18: communication timeline projects ordered append-only events with linked records';
end;
$$;

-- ── 19. Tenant scoping: authenticated tenant-a cannot read tenant-b rows ────
do $$
declare
  v_company_id uuid;
  v_region_id uuid;
  v_branch_id uuid;
  v_customer_b_id uuid;
  v_issue_b_id uuid;
  v_visible_count int;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id into v_company_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'company',
    p_source_record_id => 'crm-tenant-b-company',
    p_data => jsonb_build_object('name', 'Tenant B Company', 'tenant', 'tenant-b')
  );

  select entity_id into v_region_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'region',
    p_source_record_id => 'crm-tenant-b-region',
    p_data => jsonb_build_object('name', 'Tenant B Region', 'tenant', 'tenant-b')
  );
  perform public.rental_upsert_relationship('company_has_region', v_company_id, v_region_id);

  select entity_id into v_branch_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'crm-tenant-b-branch',
    p_data => jsonb_build_object('name', 'Tenant B Branch', 'tenant', 'tenant-b')
  );
  perform public.rental_upsert_relationship('region_has_branch', v_region_id, v_branch_id);

  select entity_id into v_customer_b_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'customer',
    p_source_record_id => 'crm-tenant-b-customer',
    p_data => jsonb_build_object(
      'name', 'Tenant B Customer',
      'org_scope_id', v_branch_id::text,
      'last_interaction_type', 'customer_email_sent',
      'last_interaction_summary', 'Tenant B received payment reminder email'
    )
  );

  select issue_entity_id
    into v_issue_b_id
  from public.crm_upsert_payment_issue(
    p_issue_source_record_id => 'pay-risk-tenant-b-001',
    p_customer_id => v_customer_b_id,
    p_status => 'open',
    p_severity => 'medium'
  );

  if v_issue_b_id is null then
    raise exception 'FAIL 19: tenant-b issue setup failed';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.role', '', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated","app_metadata":{"role":"read_only","tenant":"tenant-a"}}',
  true
);

do $$
declare
  v_tenant_a_visible int;
  v_tenant_b_visible int;
  v_tenant_a_profile_visible int;
  v_tenant_b_profile_visible int;
begin
  select count(*)
    into v_tenant_a_visible
  from public.crm_customer_issue_current
  where issue_source_record_id = 'pay-risk-tenant-a-001';

  select count(*)
    into v_tenant_b_visible
  from public.crm_customer_issue_current
  where issue_source_record_id = 'pay-risk-tenant-b-001';

  select count(*)
    into v_tenant_a_profile_visible
  from public.crm_customer_profile_current
  where source_record_id = 'crm-tenant-a-customer'
    and last_interaction_type = 'customer_call_logged'
    and last_interaction_summary = 'Tenant A collections call logged';

  select count(*)
    into v_tenant_b_profile_visible
  from public.crm_customer_profile_current
  where source_record_id = 'crm-tenant-b-customer'
    and last_interaction_type = 'customer_email_sent'
    and last_interaction_summary = 'Tenant B received payment reminder email';

  if v_tenant_a_visible <> 1 then
    raise exception 'FAIL 19: tenant-a should see its own issue row, got %', v_tenant_a_visible;
  end if;

  if v_tenant_b_visible <> 0 then
    raise exception 'FAIL 19: tenant-a should not see tenant-b issue rows, got %', v_tenant_b_visible;
  end if;

  if v_tenant_a_profile_visible <> 1 then
    raise exception 'FAIL 19: tenant-a should see its own projected last_interaction fields, got %', v_tenant_a_profile_visible;
  end if;

  if v_tenant_b_profile_visible <> 0 then
    raise exception 'FAIL 19: tenant-a should not see tenant-b projected last_interaction fields, got %', v_tenant_b_profile_visible;
  end if;

  raise notice 'PASS 19: tenant scoping enforced for issue + profile projections';
end;
$$;

reset role;

-- ── 20. Interaction written via crm_upsert_customer_profile persists to ───────
--        time_series_points and is visible in crm_customer_communication_timeline
-- Proves the new write path introduced by migration 20260617010000:
--   20a) authenticated/admin upserts an interaction — write succeeds
--   20b) authenticated/read_only reads it back through the timeline view
--        (null-org_scope_id entity is now visible after the fix)
--   20c) anon is denied SELECT on the timeline view
do $$
declare
  v_customer_id uuid;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- Create a CRM-only customer with no branch/org context (org_scope_id = null)
  select t.entity_id
    into v_customer_id
  from public.crm_upsert_customer_profile(
    p_source_record_id => 'crm-null-scope-interaction-test',
    p_data => jsonb_build_object('name', 'Null Scope Timeline Corp')
  ) as t;

  if v_customer_id is null then
    raise exception 'FAIL 20: setup — crm_upsert_customer_profile returned null entity_id';
  end if;

  if exists (
    select 1 from public.entities where id = v_customer_id and org_scope_id is not null
  ) then
    raise exception 'FAIL 20: setup — expected null org_scope_id for CRM-only customer';
  end if;

  raise notice 'TEST 20 setup: CRM-only customer % created with null org_scope_id', v_customer_id;
end;
$$;

-- 20a. authenticated/admin writes an email interaction via crm_upsert_customer_profile.
-- The upsert function maps last_interaction_type values to fact_type keys:
--   'email' → 'customer_email_sent'  (tested here)
--   'sms'   → 'customer_sms_sent'
--   other   → 'customer_call_logged'
-- The timeline view surfaces these stored fact_type keys as interaction_type.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000210","role":"authenticated","app_metadata":{"role":"admin","tenant":"demo"}}',
  true
);

do $$
declare
  v_entity_id uuid;
begin
  select t.entity_id into v_entity_id
  from public.crm_upsert_customer_profile(
    p_source_record_id => 'crm-null-scope-interaction-test',
    p_data => jsonb_build_object(
      -- 'email' is the upsert input; the function writes fact_type key
      -- 'customer_email_sent' to time_series_points (tested in 20b).
      'last_interaction_type',    'email',
      'last_interaction_summary', 'Payment reminder sent via email'
    ),
    p_enrich_only => true
  ) as t;

  if v_entity_id is null then
    raise exception 'FAIL 20a: authenticated/admin upsert with interaction returned null entity_id';
  end if;

  raise notice 'PASS 20a: authenticated/admin can persist interaction via crm_upsert_customer_profile';
end;
$$;

reset role;

-- 20b. authenticated/read_only reads the interaction back through crm_customer_communication_timeline.
-- Expects exactly 1 row with the mapped fact_type key 'customer_email_sent' (input was 'email').
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000211","role":"authenticated","app_metadata":{"role":"read_only","tenant":"demo"}}',
  true
);

do $$
declare
  v_customer_id uuid;
  v_row_count   int;
  v_itype       text;
  v_summary     text;
begin
  select entity_id into v_customer_id
  from public.crm_customer_profile_current
  where source_record_id = 'crm-null-scope-interaction-test';

  if v_customer_id is null then
    raise exception 'FAIL 20b: crm_customer_profile_current did not return null-scope customer for authenticated caller';
  end if;

  select count(*) into v_row_count
  from public.crm_customer_communication_timeline
  where customer_id = v_customer_id;

  if v_row_count <> 1 then
    raise exception 'FAIL 20b: expected exactly 1 timeline row for null-scope customer, got %', v_row_count;
  end if;

  -- Fetch the single row directly to avoid min() masking incorrect values.
  select interaction_type, summary
    into v_itype, v_summary
  from public.crm_customer_communication_timeline
  where customer_id = v_customer_id;

  -- 'email' input maps to fact_type key 'customer_email_sent' in the timeline view.
  if v_itype <> 'customer_email_sent' then
    raise exception 'FAIL 20b: expected interaction_type=customer_email_sent (mapped from input "email"), got %', v_itype;
  end if;

  if v_summary <> 'Payment reminder sent via email' then
    raise exception 'FAIL 20b: expected summary="Payment reminder sent via email", got "%"', v_summary;
  end if;

  raise notice 'PASS 20b: authenticated/read_only can read persisted interaction through crm_customer_communication_timeline (1 row, null-scope entity visible)';
end;
$$;

reset role;

-- 20c. anon cannot SELECT from crm_customer_communication_timeline
set local role anon;

do $$
declare
  v_caught bool := false;
begin
  begin
    perform 1 from public.crm_customer_communication_timeline limit 1;
    raise exception 'FAIL 20c: anon SELECT on crm_customer_communication_timeline succeeded — grant is too permissive';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 20c: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 20c: anon was not denied SELECT on crm_customer_communication_timeline';
  end if;

  raise notice 'PASS 20c: anon is denied SELECT on crm_customer_communication_timeline';
end;
$$;

reset role;

-- ── 21. null-org_scope_id visibility bounded to authenticated callers ─────────
-- Explicitly bounds the crm_entity_visible_to_caller null-scope change:
-- service_role and authenticated callers can see null-scope entities;
-- anon is still excluded at the view grant level.
do $$
declare
  v_customer_id uuid;
  v_visible     bool;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select e.id into v_customer_id
  from public.entities e
  where e.entity_type = 'customer'
    and e.source_record_id = 'crm-null-scope-interaction-test';

  v_visible := public.crm_entity_visible_to_caller(v_customer_id);

  if not v_visible then
    raise exception 'FAIL 21a: service_role should see null-scope entity via crm_entity_visible_to_caller, got false';
  end if;

  raise notice 'PASS 21a: service_role sees null-scope entity (crm_entity_visible_to_caller=true)';
end;
$$;

-- 21b. authenticated/read_only: crm_entity_visible_to_caller returns true for null-scope entity
--      and the timeline view reflects the same visibility
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000212","role":"authenticated","app_metadata":{"role":"read_only","tenant":"demo"}}',
  true
);

do $$
declare
  v_customer_id uuid;
  v_visible     bool;
  v_timeline_count int;
begin
  select entity_id into v_customer_id
  from public.crm_customer_profile_current
  where source_record_id = 'crm-null-scope-interaction-test';

  if v_customer_id is null then
    raise exception 'FAIL 21b: null-scope customer not visible in crm_customer_profile_current for authenticated caller';
  end if;

  v_visible := public.crm_entity_visible_to_caller(v_customer_id);

  if not v_visible then
    raise exception 'FAIL 21b: crm_entity_visible_to_caller should return true for null-scope entity as authenticated, got false';
  end if;

  select count(*) into v_timeline_count
  from public.crm_customer_communication_timeline
  where customer_id = v_customer_id;

  if v_timeline_count < 1 then
    raise exception 'FAIL 21b: expected >=1 timeline row for null-scope entity as authenticated, got %', v_timeline_count;
  end if;

  raise notice 'PASS 21b: authenticated/read_only sees null-scope entity (crm_entity_visible_to_caller=true, timeline rows=%)', v_timeline_count;
end;
$$;

reset role;

-- 21c. anon: null-scope visibility change does not widen access beyond authenticated callers
--      The view-level GRANT SELECT (authenticated, service_role only) ensures anon is excluded.
set local role anon;

do $$
declare
  v_caught bool := false;
begin
  begin
    perform 1 from public.crm_customer_communication_timeline limit 1;
    raise exception 'FAIL 21c: anon SELECT on crm_customer_communication_timeline succeeded — null-scope visibility widened beyond intended callers';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 21c: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 21c: anon was not denied access to crm_customer_communication_timeline';
  end if;

  raise notice 'PASS 21c: anon cannot access crm_customer_communication_timeline — null-scope visibility bounded to authenticated callers only';
end;
$$;

reset role;

rollback;
