-- Demo-only baseline seed data for UI usability.
--
-- Purpose:
--   Populate a coherent synthetic dataset so every core screen renders useful
--   rows/metrics in shared demo environments.
--
-- Idempotency:
--   This seed first removes prior rows for this baseline namespace
--   (`source_record_id` prefixed with `demo-baseline-`) and then recreates a
--   fixed dataset. Re-running yields the same cardinalities and KPI behavior.

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_now timestamptz := now();

  v_company_id uuid;
  v_region_gulf uuid;
  v_region_north uuid;
  v_branch_north uuid;
  v_branch_south uuid;

  v_customer_ids uuid[] := '{}'::uuid[];
  v_billing_ids uuid[] := '{}'::uuid[];
  v_job_site_ids uuid[] := '{}'::uuid[];

  v_category_ids uuid[] := '{}'::uuid[];

  v_asset_ids uuid[] := '{}'::uuid[];
  v_on_rent_asset_ids uuid[] := '{}'::uuid[];
  v_transfer_asset_ids uuid[] := '{}'::uuid[];
  v_hold_asset_ids uuid[] := '{}'::uuid[];

  v_maintenance_ids uuid[] := '{}'::uuid[];
  v_inspection_ids uuid[] := '{}'::uuid[];

  v_order_ids uuid[] := '{}'::uuid[];
  v_contract_ids uuid[] := '{}'::uuid[];

  v_entity_id uuid;
  v_branch_id uuid;
  v_category_id uuid;
  v_asset_status text;
  v_operational_status text;
  v_maintenance_due_at timestamptz;

  v_fact_branch_on_rent uuid;
  v_fact_branch_utilization uuid;
  v_fact_asset_downtime uuid;
  v_fact_asset_meter uuid;

  i int;
  j int;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Remove previous baseline rows so the seed remains idempotent and reproducible.
  -- Clean up portal scope tokens that reference demo contract entities before deleting those entities.
  DELETE FROM portal_contract_scope_tokens
  WHERE contract_id IN (
    SELECT id FROM entities
    WHERE entity_type = 'rental_contract'
      AND source_record_id LIKE 'demo-baseline-rental-contract-%'
  );

  DELETE FROM entities
  WHERE source_record_id LIKE 'demo-baseline-%';

  -- ---------------------------------------------------------------------------
  -- Enterprise org hierarchy
  -- ---------------------------------------------------------------------------
  SELECT entity_id INTO v_company_id
  FROM rental_upsert_entity_current_state(
    p_entity_type => 'company',
    p_source_record_id => 'demo-baseline-company-001',
    p_data => jsonb_build_object(
      'name', 'Dealernet Industrial Rentals',
      'default_currency_code', 'USD',
      'locale_code', 'en-US',
      'tax_region_code', 'US-TX',
      'timezone', 'America/Chicago',
      'tenant', 'default'
    )
  );

  SELECT entity_id INTO v_region_gulf
  FROM rental_upsert_entity_current_state(
    p_entity_type => 'region',
    p_source_record_id => 'demo-baseline-region-gulf-coast',
    p_data => jsonb_build_object(
      'name', 'Gulf Coast',
      'company_id', v_company_id,
      'default_currency_code', 'USD',
      'locale_code', 'en-US',
      'tax_region_code', 'US-TX',
      'timezone', 'America/Chicago'
    )
  );

  SELECT entity_id INTO v_region_north
  FROM rental_upsert_entity_current_state(
    p_entity_type => 'region',
    p_source_record_id => 'demo-baseline-region-north-texas',
    p_data => jsonb_build_object(
      'name', 'North Texas',
      'company_id', v_company_id,
      'default_currency_code', 'USD',
      'locale_code', 'en-US',
      'tax_region_code', 'US-TX',
      'timezone', 'America/Chicago'
    )
  );

  PERFORM rental_upsert_relationship('company_has_region', v_company_id, v_region_gulf);
  PERFORM rental_upsert_relationship('company_has_region', v_company_id, v_region_north);

  -- ---------------------------------------------------------------------------
  -- Branches
  -- ---------------------------------------------------------------------------
  SELECT entity_id INTO v_branch_north
  FROM rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'demo-baseline-branch-north',
    p_data => jsonb_build_object(
      'name', 'Houston Central',
      'branch_code', 'HOUC',
      'region', 'Gulf Coast',
      'region_id', v_region_gulf,
      'company_id', v_company_id,
      'default_currency_code', 'USD',
      'locale_code', 'en-US',
      'tax_region_code', 'US-TX',
      'timezone', 'America/Chicago',
      'city', 'Houston',
      'state', 'TX'
    )
  );

  SELECT entity_id INTO v_branch_south
  FROM rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'demo-baseline-branch-south',
    p_data => jsonb_build_object(
      'name', 'Dallas North Yard',
      'branch_code', 'DALN',
      'region', 'North Texas',
      'region_id', v_region_north,
      'company_id', v_company_id,
      'default_currency_code', 'USD',
      'locale_code', 'en-US',
      'tax_region_code', 'US-TX',
      'timezone', 'America/Chicago',
      'city', 'Dallas',
      'state', 'TX'
    )
  );

  PERFORM rental_upsert_relationship('region_has_branch', v_region_gulf, v_branch_north);
  PERFORM rental_upsert_relationship('region_has_branch', v_region_north, v_branch_south);

  -- ---------------------------------------------------------------------------
  -- Customers + billing accounts + contacts + job sites
  -- ---------------------------------------------------------------------------
  FOR i IN 1..4 LOOP
    SELECT entity_id INTO v_entity_id
    FROM rental_upsert_entity_current_state(
      p_entity_type => 'customer',
      p_source_record_id => format('demo-baseline-customer-%s', i),
      p_data => jsonb_build_object(
        'name', (ARRAY[
          'Blue Mesa Civil Works',
          'Ironwood Industrial Mechanics',
          'Summit Arc Steel Services',
          'Prairie Line Utility Builders'
        ])[i],
        'customer_type', CASE WHEN i % 2 = 0 THEN 'national' ELSE 'local' END,
        'tier', CASE WHEN i <= 2 THEN 'gold' ELSE 'silver' END,
        'industry', (ARRAY['heavy_civil', 'industrial_maintenance', 'steel_erection', 'pipeline'])[i],
        'hq_address', (ARRAY[
          '100 Demo Parkway, Yard District, TX 75001',
          '245 Service Loop, Mockingbird Park, TX 75002',
          '388 Crane Lane, Sampleton, TX 75003',
          '520 Utility Row, Testview, TX 75004'
        ])[i]
      )
    );
    v_customer_ids := array_append(v_customer_ids, v_entity_id);

    SELECT entity_id INTO v_entity_id
    FROM rental_upsert_entity_current_state(
      p_entity_type => 'billing_account',
      p_source_record_id => format('demo-baseline-billing-%s', i),
      p_data => jsonb_build_object(
        'name', (ARRAY[
          'Blue Mesa Civil - AP',
          'Ironwood Industrial - AP',
          'Summit Arc Steel - AP',
          'Prairie Line Utility - AP'
        ])[i],
        'account_number', format('BA-TX-%s', lpad(i::text, 4, '0')),
        'payment_terms', CASE WHEN i % 2 = 0 THEN 'NET45' ELSE 'NET30' END,
        'credit_limit', (ARRAY[175000, 250000, 140000, 210000])[i],
        'billing_email', (ARRAY[
          'ap.blue-mesa@example.com',
          'ap.ironwood@example.com',
          'ap.summit-arc@example.com',
          'ap.prairie-line@example.com'
        ])[i]
      )
    );
    v_billing_ids := array_append(v_billing_ids, v_entity_id);

    PERFORM rental_upsert_relationship('customer_has_billing_account', v_customer_ids[i], v_billing_ids[i]);

    SELECT entity_id INTO v_entity_id
    FROM rental_upsert_entity_current_state(
      p_entity_type => 'contact',
      p_source_record_id => format('demo-baseline-contact-primary-%s', i),
      p_data => jsonb_build_object(
        'name', (ARRAY[
          'Avery Quinn',
          'Jordan Reese',
          'Morgan Hale',
          'Casey Rowan'
        ])[i],
        'role', 'Project Manager',
        'email', (ARRAY[
          'avery.quinn@example.com',
          'jordan.reese@example.com',
          'morgan.hale@example.com',
          'casey.rowan@example.com'
        ])[i],
        'phone', (ARRAY[
          '713-555-0142',
          '281-555-0188',
          '214-555-0126',
          '972-555-0194'
        ])[i],
        'customer_id', v_customer_ids[i]
      )
    );
    PERFORM rental_upsert_relationship('customer_has_contact', v_customer_ids[i], v_entity_id);

    SELECT entity_id INTO v_entity_id
    FROM rental_upsert_entity_current_state(
      p_entity_type => 'job_site',
      p_source_record_id => format('demo-baseline-job-site-primary-%s', i),
      p_data => jsonb_build_object(
        'name', (ARRAY[
          'Route 77 Corridor Phase B',
          'Harbor Works Turnaround Unit 3',
          'North Channel Bridge Steel Package',
          'Pioneer Ridge Compressor Expansion'
        ])[i],
        'address', (ARRAY[
          '710 Worksite Way, Yard District, TX 75005',
          '840 Fabrication Blvd, Mockingbird Park, TX 75006',
          '905 Lift Access Rd, Sampleton, TX 75007',
          '1120 Compressor Ct, Testview, TX 75008'
        ])[i],
        'customer_id', v_customer_ids[i]
      )
    );
    v_job_site_ids := array_append(v_job_site_ids, v_entity_id);
    PERFORM rental_upsert_relationship('customer_has_job_site', v_customer_ids[i], v_entity_id);

    IF i <= 2 THEN
      SELECT entity_id INTO v_entity_id
      FROM rental_upsert_entity_current_state(
        p_entity_type => 'contact',
        p_source_record_id => format('demo-baseline-contact-secondary-%s', i),
        p_data => jsonb_build_object(
          'name', (ARRAY['Blake Carter', 'Taylor Monroe'])[i],
          'role', 'Accounts Payable',
          'email', (ARRAY[
            'blake.carter@example.com',
            'taylor.monroe@example.com'
          ])[i],
          'phone', (ARRAY['713-555-0221', '281-555-0235'])[i],
          'customer_id', v_customer_ids[i]
        )
      );
      PERFORM rental_upsert_relationship('customer_has_contact', v_customer_ids[i], v_entity_id);

      SELECT entity_id INTO v_entity_id
      FROM rental_upsert_entity_current_state(
        p_entity_type => 'job_site',
        p_source_record_id => format('demo-baseline-job-site-secondary-%s', i),
        p_data => jsonb_build_object(
          'name', (ARRAY[
            'Grand Basin Drainage Package',
            'Lakeview Refinery North Rack'
          ])[i],
          'address', (ARRAY[
            '1300 Demo Basin Rd, Yard District, TX 75009',
            '1425 Rail Spur Ave, Mockingbird Park, TX 75010'
          ])[i],
          'customer_id', v_customer_ids[i]
        )
      );
      v_job_site_ids := array_append(v_job_site_ids, v_entity_id);
      PERFORM rental_upsert_relationship('customer_has_job_site', v_customer_ids[i], v_entity_id);
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- Customer profile enrichments: notes, documents, and fact rollups
  -- ---------------------------------------------------------------------------
  DECLARE
    v_fact_customer_balance         uuid;
    v_fact_customer_credit_limit    uuid;
    v_fact_customer_avg_days        uuid;
    v_fact_customer_payment_issue   uuid;
    v_note_id                       uuid;
    v_doc_id                        uuid;
  BEGIN
    SELECT id INTO v_fact_customer_balance        FROM fact_types WHERE key = 'customer_balance';
    SELECT id INTO v_fact_customer_credit_limit   FROM fact_types WHERE key = 'customer_credit_limit';
    SELECT id INTO v_fact_customer_avg_days       FROM fact_types WHERE key = 'customer_avg_days_to_pay';
    SELECT id INTO v_fact_customer_payment_issue  FROM fact_types WHERE key = 'customer_payment_issue_flag';

    FOR i IN 1..4 LOOP
      -- Facts: balance and credit_limit per customer
      INSERT INTO entity_facts (entity_id, fact_type_id, value, source_id)
      VALUES (
        v_customer_ids[i],
        v_fact_customer_balance,
        (ARRAY[42800, 118500, 9200, 76400])[i],
        format('demo-baseline-customer-%s', i)
      ) ON CONFLICT (entity_id, fact_type_id, dimension_id) DO UPDATE SET
        value      = EXCLUDED.value,
        source_id  = EXCLUDED.source_id,
        updated_at = now();

      INSERT INTO entity_facts (entity_id, fact_type_id, value, source_id)
      VALUES (
        v_customer_ids[i],
        v_fact_customer_credit_limit,
        (ARRAY[175000, 250000, 140000, 210000])[i],
        format('demo-baseline-customer-%s', i)
      ) ON CONFLICT (entity_id, fact_type_id, dimension_id) DO UPDATE SET
        value      = EXCLUDED.value,
        source_id  = EXCLUDED.source_id,
        updated_at = now();

      INSERT INTO entity_facts (entity_id, fact_type_id, value, source_id)
      VALUES (
        v_customer_ids[i],
        v_fact_customer_avg_days,
        (ARRAY[28, 34, 19, 41])[i],
        format('demo-baseline-customer-%s', i)
      ) ON CONFLICT (entity_id, fact_type_id, dimension_id) DO UPDATE SET
        value      = EXCLUDED.value,
        source_id  = EXCLUDED.source_id,
        updated_at = now();

      INSERT INTO entity_facts (entity_id, fact_type_id, value, source_id)
      VALUES (
        v_customer_ids[i],
        v_fact_customer_payment_issue,
        (ARRAY[0, 0, 1, 0])[i],
        format('demo-baseline-customer-%s', i)
      ) ON CONFLICT (entity_id, fact_type_id, dimension_id) DO UPDATE SET
        value      = EXCLUDED.value,
        source_id  = EXCLUDED.source_id,
        updated_at = now();

      -- Notes: one internal note per customer
      SELECT entity_id INTO v_note_id
      FROM rental_upsert_entity_current_state(
        p_entity_type      => 'note',
        p_source_record_id => format('demo-baseline-note-%s', i),
        p_data             => jsonb_build_object(
          'customer_id',  v_customer_ids[i],
          'body',         (ARRAY[
            'Preferred call window 07:00–09:00 CST. Escalate billing disputes to Avery Quinn.',
            'Volume-discount agreement in place for heavy-lift equipment. Verify before quoting.',
            'Payment delays noted on last two invoices. Require PO reference on all new orders.',
            'Multi-site customer; coordinate delivery schedule with Casey Rowan two days ahead.'
          ])[i],
          'note_type',    'internal',
          'created_by',   'seed'
        )
      );
      PERFORM rental_upsert_relationship('customer_has_note', v_customer_ids[i], v_note_id);

      -- Documents: one compliance metadata record per customer
      SELECT entity_id INTO v_doc_id
      FROM rental_upsert_entity_current_state(
        p_entity_type      => 'document',
        p_source_record_id => format('demo-baseline-doc-credit-app-%s', i),
        p_data             => jsonb_build_object(
          'customer_id',      v_customer_ids[i],
          'document_type',    'credit_application',
          'title',            'Credit Application',
          'storage_ref',      format('customers/%s/credit_application.pdf', v_customer_ids[i]),
          'mime_type',        'application/pdf',
          'status',           'approved',
          'reviewed_by',      'seed',
          'expiry_date',      (now() + interval '2 years')::date
        )
      );
      PERFORM rental_upsert_relationship('customer_has_document', v_customer_ids[i], v_doc_id);
    END LOOP;
  END;

  -- ---------------------------------------------------------------------------
  -- Customer issue: seed a payment issue for customer 3 (Summit Arc Steel)
  -- so the CRM escalation surface has a durable issue entity to display.
  -- ---------------------------------------------------------------------------
  DECLARE
  BEGIN
    PERFORM crm_upsert_payment_issue(
      p_issue_source_record_id => 'demo-baseline-payment-issue-3',
      p_customer_id            => v_customer_ids[3],
      p_issue_type             => 'payment_issue',
      p_status                 => 'open',
      p_severity               => 'high',
      p_metadata               => jsonb_build_object(
        'note', 'Payment delays noted on last two invoices. Require PO on new orders.'
      )
    );
  END;

  -- ---------------------------------------------------------------------------
  -- Asset categories
  -- ---------------------------------------------------------------------------
  FOR i IN 1..5 LOOP
    SELECT entity_id INTO v_entity_id
    FROM rental_upsert_entity_current_state(
      p_entity_type => 'asset_category',
      p_source_record_id => format('demo-baseline-category-%s', i),
      p_data => jsonb_build_object(
        'name', (ARRAY['Earthmoving Excavators', 'Boom and Scissor Lifts', 'Power & Climate Control', 'Compaction Rollers', 'Worksite Attachments'])[i],
        'default_rate_type', (ARRAY['daily', 'weekly', 'daily', 'weekly', 'fixed'])[i],
        'default_rate_amount', (ARRAY[595, 1850, 365, 1125, 145])[i],
        'utilization_group', (ARRAY['earthmoving', 'access', 'power', 'siteworks', 'attachments'])[i]
      )
    );
    v_category_ids := array_append(v_category_ids, v_entity_id);
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- Assets (40 total, mixed statuses)
  -- ---------------------------------------------------------------------------
  FOR i IN 1..40 LOOP
    v_branch_id := CASE WHEN i % 2 = 0 THEN v_branch_north ELSE v_branch_south END;
    v_category_id := v_category_ids[((i - 1) % 5) + 1];

    IF i <= 16 THEN
      v_asset_status := 'available';
      v_operational_status := 'available';
    ELSIF i <= 28 THEN
      v_asset_status := 'on_rent';
      v_operational_status := 'on_rent';
    ELSIF i <= 34 THEN
      v_asset_status := 'in_maintenance';
      v_operational_status := 'in_maintenance';
    ELSIF i <= 37 THEN
      v_asset_status := 'on_transfer';
      v_operational_status := 'on_transfer';
    ELSE
      v_asset_status := 'on_inspection_hold';
      v_operational_status := 'on_inspection_hold';
    END IF;

    IF i % 7 = 0 THEN
      v_maintenance_due_at := v_now - interval '2 days';
    ELSIF i % 4 = 0 THEN
      v_maintenance_due_at := v_now + interval '5 days';
    ELSE
      v_maintenance_due_at := v_now + interval '25 days';
    END IF;

    SELECT entity_id INTO v_entity_id
    FROM rental_upsert_entity_current_state(
      p_entity_type => 'asset',
      p_source_record_id => format('demo-baseline-asset-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', CASE ((i - 1) % 5)
          WHEN 0 THEN (ARRAY['CAT 320 Excavator', 'CAT 323 Excavator', 'Komatsu PC210 Excavator', 'John Deere 210 P-Tier Excavator'])[1 + ((i - 1) % 4)]
          WHEN 1 THEN (ARRAY['Genie S-65 Boom Lift', 'JLG 860SJ Boom Lift', 'JLG 1932R Scissor Lift', 'Skyjack SJIII 3219 Scissor Lift'])[1 + ((i - 1) % 4)]
          WHEN 2 THEN (ARRAY['Generac MLG25 Generator', 'Atlas Copco QAS 45 Generator', 'Aggreko 5-Ton Portable AC Unit', 'Doosan G70 Generator'])[1 + ((i - 1) % 4)]
          WHEN 3 THEN (ARRAY['Bomag BW177 D-5 Roller', 'Dynapac CA2500D Roller', 'Wacker Neuson RD27 Roller', 'CAT CS56B Roller'])[1 + ((i - 1) % 4)]
          ELSE (ARRAY['CAT H120 Hammer Attachment', 'Paladin 72in Skid Steer Broom', 'Werk-Brau 48in Trenching Bucket', 'Auger Torque X4500 Earth Drill'])[1 + ((i - 1) % 4)]
        END,
        'identifier', format(
          '%s-%s-%s',
          CASE WHEN v_branch_id = v_branch_north THEN 'HOU' ELSE 'DAL' END,
          (ARRAY['EXC', 'LFT', 'PWR', 'CMP', 'ATT'])[1 + ((i - 1) % 5)],
          lpad(i::text, 3, '0')
        ),
        'make', CASE ((i - 1) % 5)
          WHEN 0 THEN (ARRAY['CAT', 'CAT', 'Komatsu', 'John Deere'])[1 + ((i - 1) % 4)]
          WHEN 1 THEN (ARRAY['Genie', 'JLG', 'JLG', 'Skyjack'])[1 + ((i - 1) % 4)]
          WHEN 2 THEN (ARRAY['Generac', 'Atlas Copco', 'Aggreko', 'Doosan'])[1 + ((i - 1) % 4)]
          WHEN 3 THEN (ARRAY['Bomag', 'Dynapac', 'Wacker Neuson', 'CAT'])[1 + ((i - 1) % 4)]
          ELSE (ARRAY['CAT', 'Paladin', 'Werk-Brau', 'Auger Torque'])[1 + ((i - 1) % 4)]
        END,
        'model', CASE ((i - 1) % 5)
          WHEN 0 THEN (ARRAY['320', '323', 'PC210', '210 P-Tier'])[1 + ((i - 1) % 4)]
          WHEN 1 THEN (ARRAY['S-65', '860SJ', '1932R', 'SJIII 3219'])[1 + ((i - 1) % 4)]
          WHEN 2 THEN (ARRAY['MLG25', 'QAS 45', '5-Ton PACU', 'G70'])[1 + ((i - 1) % 4)]
          WHEN 3 THEN (ARRAY['BW177 D-5', 'CA2500D', 'RD27', 'CS56B'])[1 + ((i - 1) % 4)]
          ELSE (ARRAY['H120', '72in Broom', '48in Trenching Bucket', 'X4500'])[1 + ((i - 1) % 4)]
        END,
        'year', 2017 + (i % 8),
        'serial_number', format('TXR-%s', lpad((42000 + i)::text, 5, '0')),
        'status', v_asset_status,
        'operational_status', v_operational_status,
        'ownership_type', CASE WHEN i <= 30 THEN 'owned' ELSE 'leased' END,
        'asset_category_id', v_category_id,
        'category_id', v_category_id,
        'branch_id', v_branch_id,
        'maintenance_due_at', v_maintenance_due_at,
        'daily_rate', CASE ((i - 1) % 5)
          WHEN 0 THEN (ARRAY[800, 820, 750, 770])[1 + ((i - 1) % 4)]
          WHEN 1 THEN (ARRAY[350, 420, 280, 300])[1 + ((i - 1) % 4)]
          WHEN 2 THEN (ARRAY[250, 290, 220, 260])[1 + ((i - 1) % 4)]
          WHEN 3 THEN (ARRAY[450, 480, 380, 500])[1 + ((i - 1) % 4)]
          ELSE (ARRAY[150, 120, 140, 130])[1 + ((i - 1) % 4)]
        END,
        'weekly_rate', CASE ((i - 1) % 5)
          WHEN 0 THEN (ARRAY[2800, 2900, 2600, 2700])[1 + ((i - 1) % 4)]
          WHEN 1 THEN (ARRAY[1200, 1450, 950, 1050])[1 + ((i - 1) % 4)]
          WHEN 2 THEN (ARRAY[900, 1000, 750, 850])[1 + ((i - 1) % 4)]
          WHEN 3 THEN (ARRAY[1600, 1700, 1350, 1800])[1 + ((i - 1) % 4)]
          ELSE (ARRAY[500, 400, 475, 440])[1 + ((i - 1) % 4)]
        END,
        'monthly_rate', CASE ((i - 1) % 5)
          WHEN 0 THEN (ARRAY[7500, 7800, 7000, 7200])[1 + ((i - 1) % 4)]
          WHEN 1 THEN (ARRAY[3500, 4200, 2800, 3000])[1 + ((i - 1) % 4)]
          WHEN 2 THEN (ARRAY[2800, 3200, 2400, 2900])[1 + ((i - 1) % 4)]
          WHEN 3 THEN (ARRAY[4500, 4800, 3800, 5000])[1 + ((i - 1) % 4)]
          ELSE (ARRAY[1400, 1100, 1300, 1200])[1 + ((i - 1) % 4)]
        END,
        'image_url', CASE ((i - 1) % 5)
          WHEN 0 THEN '/equipment-images/earthmoving.svg'
          WHEN 1 THEN '/equipment-images/boom-scissor-lifts.svg'
          WHEN 2 THEN '/equipment-images/power-climate.svg'
          WHEN 3 THEN '/equipment-images/compaction-rollers.svg'
          ELSE '/equipment-images/worksite-attachments.svg'
        END
      )
    );

    v_asset_ids := array_append(v_asset_ids, v_entity_id);
    PERFORM rental_upsert_relationship('branch_has_asset', v_branch_id, v_entity_id);
    PERFORM rental_upsert_relationship('asset_category_has_asset', v_category_id, v_entity_id);

    IF v_operational_status = 'on_rent' THEN
      v_on_rent_asset_ids := array_append(v_on_rent_asset_ids, v_entity_id);
    ELSIF v_operational_status = 'on_transfer' THEN
      v_transfer_asset_ids := array_append(v_transfer_asset_ids, v_entity_id);
    ELSIF v_operational_status = 'on_inspection_hold' THEN
      v_hold_asset_ids := array_append(v_hold_asset_ids, v_entity_id);
    END IF;
  END LOOP;

  IF coalesce(array_length(v_transfer_asset_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Demo baseline seed expected at least one on_transfer asset for transfer records';
  END IF;

  IF coalesce(array_length(v_on_rent_asset_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Demo baseline seed expected at least one on_rent asset for contract line assignment';
  END IF;

  -- ---------------------------------------------------------------------------
  -- Branch utilization facts (analytics cards)
  -- ---------------------------------------------------------------------------
  SELECT id INTO v_fact_branch_on_rent FROM fact_types WHERE key = 'branch_on_rent_count';
  SELECT id INTO v_fact_branch_utilization FROM fact_types WHERE key = 'branch_utilization_rate';

  INSERT INTO entity_facts (entity_id, fact_type_id, value, metadata)
  VALUES
    (v_branch_north, v_fact_branch_on_rent, 6, jsonb_build_object('seed', 'demo-baseline')),
    (v_branch_north, v_fact_branch_utilization, 30.0, jsonb_build_object('seed', 'demo-baseline')),
    (v_branch_south, v_fact_branch_on_rent, 6, jsonb_build_object('seed', 'demo-baseline')),
    (v_branch_south, v_fact_branch_utilization, 30.0, jsonb_build_object('seed', 'demo-baseline'))
  ON CONFLICT (entity_id, fact_type_id, dimension_id)
  DO UPDATE SET
    value = EXCLUDED.value,
    metadata = EXCLUDED.metadata,
    updated_at = now();

  -- ---------------------------------------------------------------------------
  -- Maintenance records + relationships (drives open maintenance KPI)
  -- ---------------------------------------------------------------------------
  FOR i IN 1..10 LOOP
    SELECT entity_id INTO v_entity_id
    FROM rental_upsert_entity_current_state(
      p_entity_type => 'maintenance_record',
      p_source_record_id => format('demo-baseline-maintenance-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', (ARRAY[
          '250-Hour PM Service',
          'Hydraulic Hose Replacement',
          'Track Tension Adjustment',
          'Annual ANSI Boom Lift Inspection',
          'Generator Load-Bank Test',
          'Brake System Service',
          'Cooling Fan Replacement',
          'Electrical Harness Repair',
          'Cab Glass Replacement',
          'Final QC + Wash Rack Release'
        ])[i],
        'status', (ARRAY['open', 'scheduled', 'in_progress', 'awaiting_parts', 'triage', 'open', 'completed', 'closed', 'cancelled', 'completed'])[i],
        'maintenance_type', CASE WHEN i % 3 = 0 THEN 'corrective' ELSE 'preventive' END,
        'asset_id', v_asset_ids[((i - 1) % array_length(v_asset_ids, 1)) + 1],
        'opened_at', v_now - make_interval(days => (i + 1)),
        -- Seed records 7-10 as completed/closed examples so service-history and downtime rollups have finished cycles to read from.
        'completed_at', CASE WHEN i >= 7 THEN v_now - make_interval(days => (i - 5)) ELSE null END,
        'outcome', CASE
          WHEN i >= 7 AND i % 4 = 0 THEN 'monitor'
          WHEN i >= 7 THEN 'returned_to_service'
          ELSE null
        END,
        'resolution_notes', CASE
          WHEN i >= 7 THEN format('Completed maintenance cycle %s and verified safe return to service.', lpad(i::text, 3, '0'))
          ELSE null
        END,
        'cost_summary', CASE
          WHEN i >= 7 THEN format(
            'Labor $%s · Parts $%s · External $%s · Total $%s',
            120 + (i * 15),
            CASE WHEN i % 3 = 0 THEN 90 + (i * 8) ELSE 35 + (i * 5) END,
            CASE WHEN i % 4 = 0 THEN 60 ELSE 0 END,
            (120 + (i * 15))
              + (CASE WHEN i % 3 = 0 THEN 90 + (i * 8) ELSE 35 + (i * 5) END)
              + (CASE WHEN i % 4 = 0 THEN 60 ELSE 0 END)
          )
          ELSE null
        END,
        'total_cost', CASE
          WHEN i >= 7 THEN
            (120 + (i * 15))
            + (CASE WHEN i % 3 = 0 THEN 90 + (i * 8) ELSE 35 + (i * 5) END)
            + (CASE WHEN i % 4 = 0 THEN 60 ELSE 0 END)
          ELSE null
        END
      )
    );
    v_maintenance_ids := array_append(v_maintenance_ids, v_entity_id);

    PERFORM rental_upsert_relationship(
      'asset_has_maintenance_record',
      v_asset_ids[((i - 1) % array_length(v_asset_ids, 1)) + 1],
      v_entity_id
    );
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- Inspections + relationships
  -- ---------------------------------------------------------------------------
  FOR i IN 1..12 LOOP
    SELECT entity_id INTO v_entity_id
    FROM rental_upsert_entity_current_state(
      p_entity_type => 'inspection',
      p_source_record_id => format('demo-baseline-inspection-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format(
          '%s Inspection %s',
          initcap((ARRAY['checkout', 'return', 'service'])[1 + ((i - 1) % 3)]),
          lpad(i::text, 3, '0')
        ),
        'inspection_type', (ARRAY['checkout', 'return', 'service'])[1 + ((i - 1) % 3)],
        'outcome', CASE WHEN i % 4 = 0 THEN 'fail' ELSE 'pass' END,
        'asset_id', v_asset_ids[((i + 5) % array_length(v_asset_ids, 1)) + 1],
        'inspected_at', v_now - make_interval(days => i)
      )
    );
    v_inspection_ids := array_append(v_inspection_ids, v_entity_id);

    PERFORM rental_upsert_relationship(
      'asset_has_inspection',
      v_asset_ids[((i + 5) % array_length(v_asset_ids, 1)) + 1],
      v_entity_id
    );
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- Transfers
  -- ---------------------------------------------------------------------------
  FOR i IN 1..6 LOOP
    SELECT entity_id INTO v_entity_id
    FROM create_entity_with_version(
      p_entity_type => 'transfer',
      p_source_record_id => format('demo-baseline-transfer-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format('Inter-branch Transfer %s', lpad(i::text, 3, '0')),
        'status', (ARRAY['requested', 'approved', 'in_transit', 'received', 'requested', 'cancelled'])[i],
        'asset_id', v_transfer_asset_ids[1 + ((i - 1) % greatest(array_length(v_transfer_asset_ids, 1), 1))],
        'from_branch_id', CASE WHEN i % 2 = 0 THEN v_branch_north ELSE v_branch_south END,
        'to_branch_id', CASE WHEN i % 2 = 0 THEN v_branch_south ELSE v_branch_north END,
        'requested_at', v_now - make_interval(days => (7 + i))
      )
    );
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- Rental orders + rental order lines
  -- ---------------------------------------------------------------------------
  FOR i IN 1..12 LOOP
    SELECT entity_id INTO v_entity_id
    FROM create_entity_with_version(
      p_entity_type => 'rental_order',
      p_source_record_id => format('demo-baseline-rental-order-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format('Rental Order %s - %s', lpad(i::text, 3, '0'), (ARRAY['Blue Mesa Civil', 'Ironwood Industrial', 'Summit Arc Steel', 'Prairie Line Utility'])[1 + ((i - 1) % 4)]),
        'order_number', format('RO-%s', lpad(i::text, 4, '0')),
        'status', (ARRAY['draft', 'quoted', 'approved', 'approved', 'converted', 'converted', 'converted', 'converted', 'cancelled', 'expired', 'quoted', 'draft'])[i],
        'rental_type', CASE WHEN i % 3 = 0 THEN 'internal' ELSE 'external' END,
        'branch_id', CASE WHEN i % 2 = 0 THEN v_branch_north ELSE v_branch_south END,
        'requester_id', (ARRAY[
          'dispatch-hub-a@example.com',
          'dispatch-hub-b@example.com',
          'inside-sales-hub-a@example.com',
          'inside-sales-hub-b@example.com'
        ])[1 + ((i - 1) % 4)],
        'customer_id', v_customer_ids[1 + ((i - 1) % array_length(v_customer_ids, 1))],
        'billing_account_id', v_billing_ids[1 + ((i - 1) % array_length(v_billing_ids, 1))],
        'job_site_id', v_job_site_ids[1 + ((i - 1) % array_length(v_job_site_ids, 1))],
        'notes', 'Priority dispatch window coordinated with branch yard',
        'transaction_currency_code', (ARRAY['USD', 'CAD', 'EUR'])[1 + ((i - 1) % 3)],
        'reporting_currency_code', 'USD',
        'fx_rate_applied', (ARRAY[1.0, 0.74, 1.09])[1 + ((i - 1) % 3)],
        'fx_rate_effective_at', (v_now - make_interval(days => (i % 7)))::text
      )
    );

    v_order_ids := array_append(v_order_ids, v_entity_id);

    FOR j IN 1..2 LOOP
      SELECT entity_id INTO v_entity_id
      FROM create_entity_with_version(
        p_entity_type => 'rental_order_line',
        p_source_record_id => format('demo-baseline-rental-order-line-%s-%s', lpad(i::text, 3, '0'), j),
        p_data => jsonb_build_object(
          'order_id', v_order_ids[i],
          'line_number', j,
          'status', CASE
            WHEN i >= 5 AND j = 1 THEN 'checked_out'
            WHEN i >= 7 AND j = 2 THEN 'returned'
            ELSE 'pending'
          END,
          'category_id', v_category_ids[1 + ((i + j - 2) % array_length(v_category_ids, 1))],
          'job_site_id', v_job_site_ids[1 + ((i - 1) % array_length(v_job_site_ids, 1))],
          'quantity', 1,
          'rate_type', (ARRAY['daily', 'weekly', 'monthly', 'fixed'])[1 + ((i + j - 2) % 4)],
          'planned_start', v_now::date - make_interval(days => (20 - i)),
          'planned_end', v_now::date + make_interval(days => (5 + j - i))
        )
      );
    END LOOP;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- Contracts + contract lines (checked_out + returned + pending)
  -- ---------------------------------------------------------------------------
  FOR i IN 1..6 LOOP
    SELECT entity_id INTO v_entity_id
    FROM create_entity_with_version(
      p_entity_type => 'rental_contract',
      p_source_record_id => format('demo-baseline-rental-contract-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format('Executed Rental Contract %s', lpad(i::text, 3, '0')),
        'contract_number', format('RC-%s', lpad(i::text, 4, '0')),
        'order_id', v_order_ids[4 + i],
        'status', (ARRAY['pending_execution', 'active', 'active', 'closed', 'closed', 'cancelled'])[i],
        'rental_type', CASE WHEN i % 3 = 0 THEN 'internal' ELSE 'external' END,
        'branch_id', CASE WHEN i % 2 = 0 THEN v_branch_north ELSE v_branch_south END,
        'billing_account_id', v_billing_ids[1 + ((i - 1) % array_length(v_billing_ids, 1))],
        'customer_id', v_customer_ids[1 + ((i - 1) % array_length(v_customer_ids, 1))],
        'job_site_id', v_job_site_ids[1 + ((i - 1) % array_length(v_job_site_ids, 1))],
        'transaction_currency_code', (ARRAY['USD', 'CAD', 'EUR'])[1 + ((i - 1) % 3)],
        'reporting_currency_code', 'USD',
        'fx_rate_applied', (ARRAY[1.0, 0.74, 1.09])[1 + ((i - 1) % 3)],
        'fx_rate_effective_at', (v_now - make_interval(days => (i % 7)))::text
      )
    );

    v_contract_ids := array_append(v_contract_ids, v_entity_id);

    -- Line A
    SELECT entity_id INTO v_entity_id
    FROM create_entity_with_version(
      p_entity_type => 'rental_contract_line',
      p_source_record_id => format('demo-baseline-rental-contract-line-%s-a', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'contract_id', v_contract_ids[i],
        'order_id', v_order_ids[4 + i],
        'asset_id', v_on_rent_asset_ids[1 + ((i - 1) % greatest(array_length(v_on_rent_asset_ids, 1), 1))],
        'category_id', v_category_ids[1 + ((i - 1) % array_length(v_category_ids, 1))],
        'rental_type', 'external',
        'rate_type', 'daily',
        'rate_amount', 375,
        'status', CASE
          WHEN i IN (2, 3) THEN 'checked_out'
          WHEN i IN (4, 5) THEN 'returned'
          ELSE 'pending'
        END,
        'planned_start', v_now - make_interval(days => (10 + i)),
        'planned_end', CASE WHEN i = 2 THEN v_now - interval '3 days' ELSE v_now + make_interval(days => (5 - i)) END,
        'actual_start', CASE WHEN i IN (2, 3, 4, 5) THEN v_now - make_interval(days => (9 + i)) ELSE null END,
        'actual_end', CASE WHEN i IN (4, 5) THEN v_now - make_interval(days => (2 + i)) ELSE null END
      )
    );

    -- Line B
    SELECT entity_id INTO v_entity_id
    FROM create_entity_with_version(
      p_entity_type => 'rental_contract_line',
      p_source_record_id => format('demo-baseline-rental-contract-line-%s-b', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'contract_id', v_contract_ids[i],
        'order_id', v_order_ids[4 + i],
        'asset_id', v_on_rent_asset_ids[1 + ((i + 3) % greatest(array_length(v_on_rent_asset_ids, 1), 1))],
        'category_id', v_category_ids[1 + (i % array_length(v_category_ids, 1))],
        'rental_type', 'external',
        'rate_type', 'weekly',
        'rate_amount', 1200,
        'status', CASE
          WHEN i = 3 THEN 'checked_out'
          WHEN i IN (4, 5) THEN 'returned'
          WHEN i = 6 THEN 'cancelled'
          ELSE 'pending'
        END,
        'planned_start', v_now - make_interval(days => (8 + i)),
        'planned_end', CASE WHEN i = 3 THEN v_now - interval '1 day' ELSE v_now + make_interval(days => (6 - i)) END,
        'actual_start', CASE WHEN i IN (3, 4, 5) THEN v_now - make_interval(days => (7 + i)) ELSE null END,
        'actual_end', CASE WHEN i IN (4, 5) THEN v_now - make_interval(days => (1 + i)) ELSE null END
      )
    );
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- Portal scope token for demo contract (enables portal schedule E2E tests)
  -- Token 'dia-demo-portal-scope-001' is a non-secret demo value used only
  -- in dev/CI. Production tokens must be cryptographically random (32+ bytes)
  -- and provisioned through a secure out-of-band channel — never derived from
  -- predictable identifiers and never shared across environments.
  -- ---------------------------------------------------------------------------
  INSERT INTO portal_contract_scope_tokens (contract_id, token_hash, job_site_id)
  VALUES (
    v_contract_ids[2],
    encode(digest('dia-demo-portal-scope-001', 'sha256'), 'hex'),
    null
  )
  ON CONFLICT (contract_id) DO UPDATE
    SET token_hash = EXCLUDED.token_hash,
        updated_at = now();

  -- ---------------------------------------------------------------------------
  -- Portal intake scope token for demo customer (enables portal intake E2E
  -- tests). Token 'dia-demo-intake-token-001' is a non-secret demo value
  -- used only in dev/CI. Production tokens must be cryptographically random
  -- (32+ bytes) and provisioned through a secure out-of-band channel.
  -- ---------------------------------------------------------------------------
  INSERT INTO portal_intake_scope_tokens
    (tenant_id, customer_candidate_id, token_hash, expires_at, issued_by)
  VALUES (
    'tenant-demo',
    'demo-intake-candidate-001',
    encode(digest('dia-demo-intake-token-001', 'sha256'), 'hex'),
    '9999-12-31 00:00:00+00'::timestamptz,
    'seed'
  )
  ON CONFLICT (token_hash) DO UPDATE
    SET expires_at = EXCLUDED.expires_at,
        updated_at = now();

  -- ---------------------------------------------------------------------------
  -- Invoices (current + prior month revenue)
  -- ---------------------------------------------------------------------------
  FOR i IN 1..8 LOOP
    SELECT entity_id INTO v_entity_id
    FROM create_entity_with_version(
      p_entity_type => 'invoice',
      p_source_record_id => format('demo-baseline-invoice-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format('Rental Invoice %s', lpad(i::text, 3, '0')),
        'invoice_number', format('INV-%s', lpad(i::text, 5, '0')),
        'status', (ARRAY['sent', 'paid', 'sent', 'paid', 'pending', 'paid', 'void', 'sent'])[i],
        'invoice_date', CASE
          WHEN i <= 5 THEN ((date_trunc('month', v_now)::date + (i + 1)))::text
          ELSE ((date_trunc('month', v_now - interval '1 month')::date + i))::text
        END,
        'billing_period_start', (v_now::date - make_interval(days => (30 + i)))::text,
        'billing_period_end', (v_now::date - make_interval(days => (20 - i)))::text,
        'subtotal', (ARRAY[4200, 5100, 3800, 4600, 2900, 3300, 800, 4100])[i],
        'tax', (ARRAY[336, 408, 304, 368, 232, 264, 64, 328])[i],
        'total', (ARRAY[4536, 5508, 4104, 4968, 3132, 3564, 864, 4428])[i],
        'branch_id', CASE WHEN i % 2 = 0 THEN v_branch_north ELSE v_branch_south END,
        'customer_id', v_customer_ids[1 + ((i - 1) % array_length(v_customer_ids, 1))],
        'billing_account_id', v_billing_ids[1 + ((i - 1) % array_length(v_billing_ids, 1))],
        'contract_id', v_contract_ids[1 + ((i - 1) % array_length(v_contract_ids, 1))],
        'job_site_id', v_job_site_ids[1 + ((i - 1) % array_length(v_job_site_ids, 1))],
        'transaction_currency_code', (ARRAY['USD', 'CAD', 'EUR'])[1 + ((i - 1) % 3)],
        'reporting_currency_code', 'USD',
        'fx_rate_applied', (ARRAY[1.0, 0.74, 1.09])[1 + ((i - 1) % 3)],
        'fx_rate_effective_at', (v_now - make_interval(days => (i % 7)))::text,
        'billing_exception_reason', CASE WHEN i = 7 THEN 'Missing signed delivery ticket' ELSE null END
      )
    );
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- Time-series points for fleet reporting (downtime + meter readings)
  -- ---------------------------------------------------------------------------
  SELECT id INTO v_fact_asset_downtime FROM fact_types WHERE key = 'asset_downtime';
  SELECT id INTO v_fact_asset_meter FROM fact_types WHERE key = 'asset_meter_reading';

  FOR i IN 1..14 LOOP
    INSERT INTO time_series_points (entity_id, fact_type_id, observed_at, data_payload, metadata, source_id)
    VALUES (
      v_asset_ids[1 + ((i - 1) % array_length(v_asset_ids, 1))],
      v_fact_asset_downtime,
      v_now - make_interval(days => i),
      jsonb_build_object(
        'downtime_minutes', 45 + (i * 12),
        'maintenance_record_id', CASE
          WHEN i % 4 = 0 THEN null
          ELSE v_maintenance_ids[1 + ((i - 1) % array_length(v_maintenance_ids, 1))]
        END,
        'inspection_id', CASE
          WHEN i % 4 = 0 THEN v_inspection_ids[1 + ((i - 1) % array_length(v_inspection_ids, 1))]
          ELSE null
        END
      ),
      jsonb_build_object('seed', 'demo-baseline', 'source', CASE WHEN i % 4 = 0 THEN 'inspection' ELSE 'maintenance' END),
      format('demo-baseline-downtime-%s', lpad(i::text, 3, '0'))
    );

    INSERT INTO time_series_points (entity_id, fact_type_id, observed_at, data_payload, metadata, source_id)
    VALUES (
      v_asset_ids[1 + ((i + 3) % array_length(v_asset_ids, 1))],
      v_fact_asset_meter,
      v_now - make_interval(hours => (i * 6)),
      jsonb_build_object(
        'reading_value', 100 + (i * 9.5),
        'reading_unit', 'hours'
      ),
      jsonb_build_object('seed', 'demo-baseline', 'source', 'meter'),
      format('demo-baseline-meter-%s', lpad(i::text, 3, '0'))
    );
  END LOOP;

  PERFORM refresh_org_scope_closure();
  PERFORM refresh_entity_org_scopes();
end;
$$;

DO $$
DECLARE
  v_seed_ts timestamptz := '2026-05-31T12:00:00Z'::timestamptz;
  v_agent_key text := 'revrec-analyst';
  v_fleet_agent_key text := 'fleet-auditor';

  v_tenant_a uuid;
  v_tenant_b uuid;

  v_fact_ops_event uuid;
  v_fact_ops_audit uuid;

  v_branch_ids uuid[];
  v_customer_ids uuid[];
  v_billing_ids uuid[];
  v_job_site_ids uuid[];
  v_asset_ids uuid[];
  v_available_asset_ids uuid[];

  v_run_a text := 'demo-ops-run-a-20260531';
  v_run_b text := 'demo-ops-run-b-20260531';
  v_workflow_id text := 'demo-ops-workflow-revrec-20260531';
  v_run_fleet_a text := 'demo-ops-fleet-run-a-20260531';
  v_run_fleet_b text := 'demo-ops-fleet-run-b-20260531';
  v_workflow_id_fleet text := 'demo-ops-workflow-fleet-20260531';

  v_order_id uuid;
  v_contract_id uuid;
  v_line_id uuid;
  v_invoice_id uuid;
  v_rate_card_id uuid;

  v_contract_ids uuid[] := '{}'::uuid[];
  v_line_ids uuid[] := '{}'::uuid[];
  v_contract_tenant_id uuid;
  v_contract_tenant_key text;
  v_asset_category_id uuid;

  v_idle_asset_id uuid;
  v_idle_asset_category_id uuid;
  v_demand_order_id uuid;
  v_demand_line_id uuid;

  v_contract_number text;
  v_contract_start date;
  v_contract_end date;
  v_expected_amount numeric;
  v_billed_amount numeric;
  v_expected_rate_type text;
  v_billed_rate_type text;
  v_expected_rate_amount numeric;
  v_billed_rate_amount numeric;

  v_approved_finding_id uuid;
  v_rejected_finding_id uuid;
  v_approved_draft_id uuid;
  v_agent_config_entity_id uuid;
  v_pending_placeholder_count int := 500;

  i int;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Remove previous ops demo rows so this seed stays idempotent.
  DELETE FROM time_series_points
  WHERE source_id LIKE 'demo-ops-%';

  DELETE FROM entities
  WHERE source_record_id LIKE 'demo-ops-%';

  DELETE FROM invoice_adjustment_draft
  WHERE payload ->> 'seed_namespace' = 'demo-ops';

  DELETE FROM finding
  WHERE fingerprint LIKE 'demo-ops-%'
     OR workflow_id LIKE 'demo-ops-%';

  DELETE FROM ops_workflow_run
  WHERE run_id LIKE 'demo-ops-%';

  DELETE FROM ops_agent_config
  WHERE tenant_id IN (
    SELECT id FROM tenants WHERE tenant_key LIKE 'demo-ops-%'
  );

  DELETE FROM entities
  WHERE entity_type = 'agent_config'
    AND source_record_id LIKE 'demo-ops-agent-config:%:%';

  DELETE FROM tenants
  WHERE tenant_key LIKE 'demo-ops-%';

  SELECT array_agg(id ORDER BY source_record_id) INTO v_branch_ids
  FROM entities
  WHERE entity_type = 'branch'
    AND source_record_id LIKE 'demo-baseline-branch-%';

  SELECT array_agg(id ORDER BY source_record_id) INTO v_customer_ids
  FROM entities
  WHERE entity_type = 'customer'
    AND source_record_id LIKE 'demo-baseline-customer-%';

  SELECT array_agg(id ORDER BY source_record_id) INTO v_billing_ids
  FROM entities
  WHERE entity_type = 'billing_account'
    AND source_record_id LIKE 'demo-baseline-billing-%';

  SELECT array_agg(id ORDER BY source_record_id) INTO v_job_site_ids
  FROM entities
  WHERE entity_type = 'job_site'
    AND source_record_id LIKE 'demo-baseline-job-site-primary-%';

  SELECT array_agg(e.id ORDER BY e.source_record_id) INTO v_asset_ids
  FROM entities e
  JOIN entity_versions ev
    ON ev.entity_id = e.id
   AND ev.is_current
  WHERE e.entity_type = 'asset'
    AND e.source_record_id LIKE 'demo-baseline-asset-%'
    AND ev.data ->> 'operational_status' = 'on_rent';

  SELECT array_agg(e.id ORDER BY e.source_record_id) INTO v_available_asset_ids
  FROM entities e
  JOIN entity_versions ev
    ON ev.entity_id = e.id
   AND ev.is_current
  WHERE e.entity_type = 'asset'
    AND e.source_record_id LIKE 'demo-baseline-asset-%'
    AND ev.data ->> 'operational_status' = 'available';

  IF COALESCE(array_length(v_branch_ids, 1), 0) < 2
    OR COALESCE(array_length(v_customer_ids, 1), 0) < 4
    OR COALESCE(array_length(v_billing_ids, 1), 0) < 4
    OR COALESCE(array_length(v_job_site_ids, 1), 0) < 4
    OR COALESCE(array_length(v_asset_ids, 1), 0) < 8
    OR COALESCE(array_length(v_available_asset_ids, 1), 0) < 6 THEN
    RAISE EXCEPTION 'Demo ops seed requires baseline entities from demo-baseline-* seed';
  END IF;

  INSERT INTO fact_types (key, label, description, unit)
  VALUES ('ops_contract_event', 'Ops Contract Event', 'Seeded contract lifecycle events for ops demo data', 'event')
  ON CONFLICT (key) DO UPDATE
    SET label = EXCLUDED.label,
        description = EXCLUDED.description,
        unit = EXCLUDED.unit
  RETURNING id INTO v_fact_ops_event;

  INSERT INTO fact_types (key, label, description, unit)
  VALUES ('ops_audit_event', 'Ops Audit Event', 'Seeded audit-chain events for findings and adjustments', 'event')
  ON CONFLICT (key) DO UPDATE
    SET label = EXCLUDED.label,
        description = EXCLUDED.description,
        unit = EXCLUDED.unit
  RETURNING id INTO v_fact_ops_audit;

  INSERT INTO fx_rates (base_currency_code, quote_currency_code, rate, effective_at)
  VALUES
    ('USD', 'USD', 1.0, '2026-01-01T00:00:00Z'),
    ('CAD', 'USD', 0.74, '2026-01-01T00:00:00Z'),
    ('EUR', 'USD', 1.09, '2026-01-01T00:00:00Z'),
    ('GBP', 'USD', 1.27, '2026-01-01T00:00:00Z')
  ON CONFLICT (base_currency_code, quote_currency_code, effective_at) DO UPDATE
    SET rate = EXCLUDED.rate;

  INSERT INTO tenants (tenant_key, name)
  VALUES ('demo-ops-a', 'Demo Ops Tenant A')
  ON CONFLICT (tenant_key) DO UPDATE
    SET name = EXCLUDED.name
  RETURNING id INTO v_tenant_a;

  INSERT INTO tenants (tenant_key, name)
  VALUES ('demo-ops-b', 'Demo Ops Tenant B')
  ON CONFLICT (tenant_key) DO UPDATE
    SET name = EXCLUDED.name
  RETURNING id INTO v_tenant_b;

  INSERT INTO ops_output_schema_registry (schema_key, schema_json, description)
  VALUES (
    'revrec_finding_v1',
    '{"type":"object","required":["contract_id","findings"]}'::jsonb,
    'Revenue recognition finding output schema v1'
  )
  ON CONFLICT (schema_key) DO UPDATE
    SET schema_json = EXCLUDED.schema_json,
        description = EXCLUDED.description,
        updated_at = now();

  INSERT INTO entities (entity_type, source_record_id)
  VALUES ('agent_config', format('demo-ops-agent-config:%s:%s', v_tenant_a, v_agent_key))
  ON CONFLICT (entity_type, source_record_id) DO UPDATE
    SET source_record_id = EXCLUDED.source_record_id
  RETURNING id INTO v_agent_config_entity_id;

  INSERT INTO entity_versions (entity_id, version_number, data)
  VALUES (
    v_agent_config_entity_id,
    1,
    jsonb_build_object(
      'tenant_id', v_tenant_a,
      'agent_key', v_agent_key,
      'enabled', true,
      'model', '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb,
      'system_prompt', 'Detect verifiable rental revenue leaks for tenant {tenant_id} with contract-level evidence.',
      'user_prompt_template', 'Analyze contract {contract_id} for tenant {tenant_id}. Evidence: {evidence_json}',
      'tools', '["rental_data"]'::jsonb,
      'output_schema_key', 'revrec_finding_v1',
      'thresholds', '{"rate_mismatch_min_delta":500,"min_confidence_to_surface":0.7}'::jsonb,
      'bounds', '{"max_findings_per_run":25,"max_tool_rounds":5}'::jsonb,
      'schedule', '{"cron":"0 13 * * 1-5","next_run_at":"2026-06-03T13:00:00Z","enabled":true}'::jsonb,
      'auto_apply', false
    )
  )
  ON CONFLICT (entity_id, version_number) DO UPDATE
    SET data = EXCLUDED.data,
        is_current = true,
        valid_to = NULL;

  INSERT INTO entities (entity_type, source_record_id)
  VALUES ('agent_config', format('demo-ops-agent-config:%s:%s', v_tenant_b, v_agent_key))
  ON CONFLICT (entity_type, source_record_id) DO UPDATE
    SET source_record_id = EXCLUDED.source_record_id
  RETURNING id INTO v_agent_config_entity_id;

  INSERT INTO entity_versions (entity_id, version_number, data)
  VALUES (
    v_agent_config_entity_id,
    1,
    jsonb_build_object(
      'tenant_id', v_tenant_b,
      'agent_key', v_agent_key,
      'enabled', true,
      'model', '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb,
      'system_prompt', 'Detect verifiable rental revenue leaks for tenant {tenant_id} with contract-level evidence.',
      'user_prompt_template', 'Analyze contract {contract_id} for tenant {tenant_id}. Evidence: {evidence_json}',
      'tools', '["rental_data"]'::jsonb,
      'output_schema_key', 'revrec_finding_v1',
      'thresholds', '{"rate_mismatch_min_delta":400,"min_confidence_to_surface":0.7}'::jsonb,
      'bounds', '{"max_findings_per_run":25,"max_tool_rounds":5}'::jsonb,
      'schedule', '{"cron":"0 13 * * 1-5","next_run_at":"2026-06-03T13:00:00Z","enabled":true}'::jsonb,
      'auto_apply', false
    )
  )
  ON CONFLICT (entity_id, version_number) DO UPDATE
    SET data = EXCLUDED.data,
        is_current = true,
        valid_to = NULL;

  INSERT INTO ops_agent_config (
    tenant_id,
    agent_key,
    enabled,
    model,
    system_prompt,
    user_prompt_template,
    tools,
    output_schema_key,
    thresholds,
    bounds,
    schedule,
    auto_apply
  )
  VALUES (
    v_tenant_a,
    v_fleet_agent_key,
    true,
    '{"provider":"azure_openai","model":"gpt-4.1-mini"}'::jsonb,
    'Detect idle or under-utilized fleet with transfer opportunities.',
    'Analyze seeded demo fleet utilization and branch demand signals.',
    '["rental_data"]'::jsonb,
    'fleet_finding_v1',
    '{"idle_days_min":30,"min_demand_orders":2}'::jsonb,
    '{"max_findings_per_run":20}'::jsonb,
    '{"cron":"0 15 * * 1-5","next_run_at":"2026-06-03T15:00:00Z"}'::jsonb,
    false
  )
  ON CONFLICT (tenant_id, agent_key) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        model = EXCLUDED.model,
        system_prompt = EXCLUDED.system_prompt,
        user_prompt_template = EXCLUDED.user_prompt_template,
        tools = EXCLUDED.tools,
        output_schema_key = EXCLUDED.output_schema_key,
        thresholds = EXCLUDED.thresholds,
        bounds = EXCLUDED.bounds,
        schedule = EXCLUDED.schedule,
        auto_apply = EXCLUDED.auto_apply,
        updated_at = now();

  INSERT INTO ops_agent_config (
    tenant_id,
    agent_key,
    enabled,
    model,
    system_prompt,
    user_prompt_template,
    tools,
    output_schema_key,
    thresholds,
    bounds,
    schedule,
    auto_apply
  )
  VALUES (
    v_tenant_b,
    v_fleet_agent_key,
    true,
    '{"provider":"azure_openai","model":"gpt-4.1-mini"}'::jsonb,
    'Detect idle or under-utilized fleet with transfer opportunities.',
    'Analyze seeded demo fleet utilization and branch demand signals.',
    '["rental_data"]'::jsonb,
    'fleet_finding_v1',
    '{"idle_days_min":35,"min_demand_orders":3}'::jsonb,
    '{"max_findings_per_run":20}'::jsonb,
    '{"cron":"0 15 * * 1-5","next_run_at":"2026-06-03T15:00:00Z"}'::jsonb,
    false
  )
  ON CONFLICT (tenant_id, agent_key) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        model = EXCLUDED.model,
        system_prompt = EXCLUDED.system_prompt,
        user_prompt_template = EXCLUDED.user_prompt_template,
        tools = EXCLUDED.tools,
        output_schema_key = EXCLUDED.output_schema_key,
        thresholds = EXCLUDED.thresholds,
        bounds = EXCLUDED.bounds,
        schedule = EXCLUDED.schedule,
        auto_apply = EXCLUDED.auto_apply,
        updated_at = now();

  -- Contract run counts are split by tenant to keep seeded contracts tenant-scoped:
  -- tenant A covers the 5 planted leak contracts; tenant B covers the 3 clean controls.
  INSERT INTO ops_workflow_run (run_id, tenant_id, workflow_key, started_at, finished_at, status, counts)
  VALUES
    (
      v_run_a,
      v_tenant_a,
      v_agent_key,
      v_seed_ts - interval '2 hours',
      v_seed_ts - interval '110 minutes',
      'succeeded',
      '{"contracts_scanned":5,"findings_produced":5,"clean_contracts":0}'::jsonb
    ),
    (
      v_run_b,
      v_tenant_b,
      v_agent_key,
      v_seed_ts - interval '90 minutes',
      v_seed_ts - interval '80 minutes',
      'succeeded',
      '{"contracts_scanned":3,"findings_produced":0,"clean_contracts":3}'::jsonb
    ),
    (
      v_run_fleet_a,
      v_tenant_a,
      v_fleet_agent_key,
      v_seed_ts - interval '75 minutes',
      v_seed_ts - interval '60 minutes',
      'succeeded',
      '{"assets_scanned":6,"findings_produced":1,"idle_assets":2}'::jsonb
    ),
    (
      v_run_fleet_b,
      v_tenant_b,
      v_fleet_agent_key,
      v_seed_ts - interval '75 minutes',
      v_seed_ts - interval '62 minutes',
      'succeeded',
      '{"assets_scanned":5,"findings_produced":0,"idle_assets":1}'::jsonb
    )
  ON CONFLICT (run_id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        workflow_key = EXCLUDED.workflow_key,
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at,
        status = EXCLUDED.status,
        counts = EXCLUDED.counts;

  FOR i IN 1..8 LOOP
    v_contract_number := format('C-DEMO-%s', 100 + i);
    v_contract_start := date '2026-04-01' + ((i - 1) * 3);
    v_contract_end := v_contract_start + 20;
    v_contract_tenant_id := CASE WHEN i <= 5 THEN v_tenant_a ELSE v_tenant_b END;
    v_contract_tenant_key := CASE WHEN i <= 5 THEN 'demo-ops-a' ELSE 'demo-ops-b' END;

    CASE i
      WHEN 1 THEN
        v_expected_amount := 3600;
        v_billed_amount := 2400;
        v_expected_rate_type := 'weekly';
        v_billed_rate_type := 'weekly';
        v_expected_rate_amount := 1200;
        v_billed_rate_amount := 1200;
      WHEN 2 THEN
        v_expected_amount := 1200;
        v_billed_amount := 2400;
        v_expected_rate_type := 'weekly';
        v_billed_rate_type := 'weekly';
        v_expected_rate_amount := 1200;
        v_billed_rate_amount := 1200;
      WHEN 3 THEN
        v_expected_amount := 1200;
        v_billed_amount := 1680;
        v_expected_rate_type := 'weekly';
        v_billed_rate_type := 'daily';
        v_expected_rate_amount := 1200;
        v_billed_rate_amount := 240;
      WHEN 4 THEN
        v_expected_amount := 3840;
        v_billed_amount := 3200;
        v_expected_rate_type := 'weekly';
        v_billed_rate_type := 'weekly';
        v_expected_rate_amount := 3840;
        v_billed_rate_amount := 3200;
      WHEN 5 THEN
        v_expected_amount := 1800;
        v_billed_amount := 2700;
        v_expected_rate_type := 'weekly';
        v_billed_rate_type := 'weekly';
        v_expected_rate_amount := 900;
        v_billed_rate_amount := 900;
      ELSE
        v_expected_amount := 1600 + (i * 50);
        v_billed_amount := v_expected_amount;
        v_expected_rate_type := 'weekly';
        v_billed_rate_type := 'weekly';
        v_expected_rate_amount := v_expected_amount;
        v_billed_rate_amount := v_expected_amount;
    END CASE;

    SELECT entity_id INTO v_order_id
    FROM create_entity_with_version(
      p_entity_type => 'rental_order',
      p_source_record_id => format('demo-ops-rental-order-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format('%s Rental Order', v_contract_number),
        'order_number', format('RO-DEMO-%s', lpad(i::text, 3, '0')),
        'status', 'converted',
        'rental_type', 'external',
        'branch_id', v_branch_ids[1 + ((i - 1) % 2)],
        'tenant_id', v_contract_tenant_id,
        'tenant_key', v_contract_tenant_key,
        'requester_id', format('ops-demo-%s@example.com', i),
        'customer_id', v_customer_ids[1 + ((i - 1) % 4)],
        'billing_account_id', v_billing_ids[1 + ((i - 1) % 4)],
        'job_site_id', v_job_site_ids[1 + ((i - 1) % 4)],
        'transaction_currency_code', (ARRAY['USD', 'CAD', 'EUR'])[1 + ((i - 1) % 3)],
        'reporting_currency_code', 'USD',
        'fx_rate_applied', (ARRAY[1.0, 0.74, 1.09])[1 + ((i - 1) % 3)],
        'fx_rate_effective_at', (now() - make_interval(days => (i % 5)))::text
      )
    );

    SELECT parent_id INTO v_asset_category_id
    FROM relationships_v2
    WHERE relationship_type = 'asset_category_has_asset'
      AND child_id = v_asset_ids[i]
      AND is_current
    -- rental_master_data_foundation enforces one current category assignment per
    -- asset; ORDER/LIMIT makes the seed resilient if historical rows are present.
    ORDER BY valid_from DESC
    LIMIT 1;

    IF v_asset_category_id IS NULL THEN
      RAISE EXCEPTION 'Demo ops seed expected asset_category_has_asset for asset %', v_asset_ids[i];
    END IF;

    PERFORM create_entity_with_version(
      p_entity_type => 'rental_order_line',
      p_source_record_id => format('demo-ops-rental-order-line-%s-a', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'order_id', v_order_id,
        'line_number', 1,
        'status', 'checked_out',
        'category_id', v_asset_category_id,
        'job_site_id', v_job_site_ids[1 + ((i - 1) % array_length(v_job_site_ids, 1))],
        'quantity', 1,
        'rate_type', v_expected_rate_type,
        'planned_start', v_contract_start,
        'planned_end', v_contract_end
      )
    );

    SELECT entity_id INTO v_contract_id
    FROM create_entity_with_version(
      p_entity_type => 'rental_contract',
      p_source_record_id => format('demo-ops-rental-contract-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format('%s Executed Contract', v_contract_number),
        'contract_number', v_contract_number,
        'order_id', v_order_id,
        'status', CASE WHEN i <= 5 THEN 'active' ELSE 'closed' END,
        'rental_type', 'external',
        'branch_id', v_branch_ids[1 + ((i - 1) % 2)],
        'tenant_id', v_contract_tenant_id,
        'tenant_key', v_contract_tenant_key,
        'billing_account_id', v_billing_ids[1 + ((i - 1) % 4)],
        'customer_id', v_customer_ids[1 + ((i - 1) % 4)],
        'job_site_id', v_job_site_ids[1 + ((i - 1) % 4)],
        'transaction_currency_code', (ARRAY['USD', 'CAD', 'EUR'])[1 + ((i - 1) % 3)],
        'reporting_currency_code', 'USD',
        'fx_rate_applied', (ARRAY[1.0, 0.74, 1.09])[1 + ((i - 1) % 3)],
        'fx_rate_effective_at', (now() - make_interval(days => (i % 5)))::text,
        'term_start', v_contract_start,
        'term_end', v_contract_end
      )
    );
    v_contract_ids := array_append(v_contract_ids, v_contract_id);

    SELECT entity_id INTO v_line_id
    FROM create_entity_with_version(
      p_entity_type => 'rental_contract_line',
      p_source_record_id => format('demo-ops-rental-contract-line-%s-a', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'contract_id', v_contract_id,
        'order_id', v_order_id,
        'asset_id', v_asset_ids[i],
        'category_id', null,
        'rental_type', 'external',
        'tenant_id', v_contract_tenant_id,
        'tenant_key', v_contract_tenant_key,
        'rate_type', v_expected_rate_type,
        'rate_amount', v_expected_rate_amount,
        'status', CASE WHEN i = 2 THEN 'returned' ELSE 'checked_out' END,
        'planned_start', v_contract_start,
        'planned_end', v_contract_end,
        'actual_start', v_contract_start,
        'actual_end', CASE WHEN i = 2 THEN date '2026-05-10' ELSE null END
      )
    );
    v_line_ids := array_append(v_line_ids, v_line_id);

    SELECT entity_id INTO v_rate_card_id
    FROM create_entity_with_version(
      p_entity_type => 'rate_card',
      p_source_record_id => format('demo-ops-rate-card-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'contract_number', v_contract_number,
        'contract_id', v_contract_id,
        'line_item_id', v_line_id,
        'tenant_id', v_contract_tenant_id,
        'tenant_key', v_contract_tenant_key,
        'rate_type', v_expected_rate_type,
        'base_rate', CASE WHEN i = 4 THEN 3200 ELSE v_expected_rate_amount END,
        'effective_rate', v_expected_rate_amount,
        'escalation_pct', CASE WHEN i = 4 THEN 0.20 ELSE 0.00 END,
        'effective_start', v_contract_start,
        'effective_end', v_contract_end
      )
    );

    SELECT entity_id INTO v_invoice_id
    FROM create_entity_with_version(
      p_entity_type => 'invoice',
      p_source_record_id => format('demo-ops-invoice-%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format('%s Invoice', v_contract_number),
        'invoice_number', format('INV-DEMO-%s', lpad(i::text, 3, '0')),
        'status', 'sent',
        'invoice_date', (v_contract_end - 1)::text,
        'billing_period_start', v_contract_start::text,
        'billing_period_end', v_contract_end::text,
        'subtotal', v_billed_amount,
        'tax', 0,
        'total', v_billed_amount,
        'branch_id', v_branch_ids[1 + ((i - 1) % 2)],
        'tenant_id', v_contract_tenant_id,
        'tenant_key', v_contract_tenant_key,
        'customer_id', v_customer_ids[1 + ((i - 1) % 4)],
        'billing_account_id', v_billing_ids[1 + ((i - 1) % 4)],
        'contract_id', v_contract_id,
        'job_site_id', v_job_site_ids[1 + ((i - 1) % 4)],
        'transaction_currency_code', (ARRAY['USD', 'CAD', 'EUR'])[1 + ((i - 1) % 3)],
        'reporting_currency_code', 'USD',
        'fx_rate_applied', (ARRAY[1.0, 0.74, 1.09])[1 + ((i - 1) % 3)],
        'fx_rate_effective_at', (now() - make_interval(days => (i % 5)))::text
      )
    );

    PERFORM create_entity_with_version(
      p_entity_type => 'invoice_line',
      p_source_record_id => format('demo-ops-invoice-line-%s-a', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'invoice_id', v_invoice_id,
        'contract_id', v_contract_id,
        'line_item_id', v_line_id,
        'line_number', 1,
        'tenant_id', v_contract_tenant_id,
        'tenant_key', v_contract_tenant_key,
        'rate_type', v_billed_rate_type,
        'rate_amount', v_billed_rate_amount,
        'amount', CASE WHEN i = 5 THEN 1800 ELSE v_billed_amount END,
        'service_start', v_contract_start::text,
        'service_end', v_contract_end::text
      )
    );

    IF i = 5 THEN
      PERFORM create_entity_with_version(
        p_entity_type => 'invoice_line',
        p_source_record_id => format('demo-ops-invoice-line-%s-b', lpad(i::text, 3, '0')),
        p_data => jsonb_build_object(
          'invoice_id', v_invoice_id,
          'contract_id', v_contract_id,
          'line_item_id', v_line_id,
          'line_number', 2,
          'tenant_id', v_contract_tenant_id,
          'tenant_key', v_contract_tenant_key,
          'rate_type', 'weekly',
          'rate_amount', 900,
          'amount', 900,
          'service_start', (v_contract_start + 7)::text,
          'service_end', (v_contract_start + 13)::text
        )
      );
    END IF;

    INSERT INTO time_series_points (entity_id, fact_type_id, observed_at, data_payload, metadata, source_id)
    VALUES
      (
        v_contract_id,
        v_fact_ops_event,
        (v_contract_start::timestamptz + interval '8 hours'),
        jsonb_build_object('event_type', 'checkout', 'contract_number', v_contract_number, 'line_item_id', v_line_id),
        jsonb_build_object('seed_namespace', 'demo-ops', 'trail', 'contract-lifecycle', 'tenant_id', v_contract_tenant_id, 'tenant_key', v_contract_tenant_key),
        format('demo-ops-ts-%s-checkout', lpad(i::text, 3, '0'))
      ),
      (
        v_contract_id,
        v_fact_ops_event,
        (v_contract_end::timestamptz + interval '9 hours'),
        jsonb_build_object('event_type', 'invoice_posted', 'contract_number', v_contract_number, 'invoice_id', v_invoice_id, 'billed_amount', v_billed_amount),
        jsonb_build_object('seed_namespace', 'demo-ops', 'trail', 'invoice', 'tenant_id', v_contract_tenant_id, 'tenant_key', v_contract_tenant_key),
        format('demo-ops-ts-%s-invoice', lpad(i::text, 3, '0'))
      );

    IF i = 2 THEN
      INSERT INTO time_series_points (entity_id, fact_type_id, observed_at, data_payload, metadata, source_id)
      VALUES (
        v_contract_id,
        v_fact_ops_event,
        '2026-05-10T15:00:00Z'::timestamptz,
        jsonb_build_object('event_type', 'return_recorded', 'contract_number', v_contract_number, 'actual_end', '2026-05-10'),
        jsonb_build_object('seed_namespace', 'demo-ops', 'trail', 'return', 'tenant_id', v_contract_tenant_id, 'tenant_key', v_contract_tenant_key),
        'demo-ops-ts-002-return'
      );
    END IF;
  END LOOP;

  v_idle_asset_id := v_available_asset_ids[2];
  SELECT parent_id INTO v_idle_asset_category_id
  FROM relationships_v2
  WHERE relationship_type = 'asset_category_has_asset'
    AND child_id = v_idle_asset_id
    AND is_current
  ORDER BY valid_from DESC
  LIMIT 1;

  IF v_idle_asset_category_id IS NULL THEN
    RAISE EXCEPTION 'Demo ops fleet scenario expected an idle asset category relationship';
  END IF;

  SELECT entity_id INTO v_demand_order_id
  FROM create_entity_with_version(
    p_entity_type => 'rental_order',
    p_source_record_id => 'demo-ops-rental-order-demand-001',
    p_data => jsonb_build_object(
      'name', 'Fleet demand transfer candidate order',
      'order_number', 'RO-DEMO-DMD-001',
      'status', 'open',
      'rental_type', 'external',
      'tenant_id', v_tenant_a,
      'tenant_key', 'demo-ops-a',
      'branch_id', v_branch_ids[2],
      'customer_id', v_customer_ids[1],
      'billing_account_id', v_billing_ids[1],
      'job_site_id', v_job_site_ids[1]
    )
  );

  SELECT entity_id INTO v_demand_line_id
  FROM create_entity_with_version(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'demo-ops-rental-order-line-demand-001',
    p_data => jsonb_build_object(
      'order_id', v_demand_order_id,
      'tenant_id', v_tenant_a,
      'tenant_key', 'demo-ops-a',
      'status', 'open',
      'category_id', v_idle_asset_category_id,
      'job_site_id', v_job_site_ids[1],
      'branch_id', v_branch_ids[2],
      'requested_quantity', 3,
      'requested_start', '2026-06-02',
      'requested_end', '2026-06-16'
    )
  );

  -- Shortage-scenario line: quantity intentionally exceeds available inventory at this branch so
  -- that the preferred-vendor rerent button is visible in the order detail page for E2E tests.
  -- The idle asset lives at v_branch_ids[1] while this order is at v_branch_ids[2], guaranteeing
  -- available_assets = 0 at the order's branch for this category.  quantity=100 is a belt-and-
  -- braces guard in case any assets of the same category happen to be at branch 2 in future seeds.
  PERFORM create_entity_with_version(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'demo-ops-rental-order-line-shortage-001',
    p_data => jsonb_build_object(
      'order_id', v_demand_order_id,
      'line_number', 1,
      'status', 'open',
      'category_id', v_idle_asset_category_id,
      'job_site_id', v_job_site_ids[1],
      'quantity', 100,
      'rate_type', 'monthly',
      'planned_start', '2026-07-01',
      'planned_end', '2026-09-30'
    )
  );

  INSERT INTO time_series_points (entity_id, fact_type_id, observed_at, data_payload, metadata, source_id)
  VALUES
    (
      v_idle_asset_id,
      v_fact_ops_event,
      v_seed_ts - interval '41 days',
      jsonb_build_object('event_type', 'idle_window_detected', 'idle_days', 41, 'asset_id', v_idle_asset_id),
      jsonb_build_object('seed_namespace', 'demo-ops', 'trail', 'fleet-idle', 'tenant_id', v_tenant_a, 'tenant_key', 'demo-ops-a'),
      'demo-ops-fleet-idle-001'
    ),
    (
      v_demand_line_id,
      v_fact_ops_event,
      v_seed_ts - interval '52 minutes',
      jsonb_build_object('event_type', 'category_demand_signal', 'open_orders', 3, 'target_branch_id', v_branch_ids[2], 'category_id', v_idle_asset_category_id),
      jsonb_build_object('seed_namespace', 'demo-ops', 'trail', 'fleet-demand', 'tenant_id', v_tenant_a, 'tenant_key', 'demo-ops-a'),
      'demo-ops-fleet-demand-001'
    );

  INSERT INTO finding (
    tenant_id, agent_key, run_id, workflow_id, contract_id, line_item_id, finding_type,
    severity, status, expected, billed, delta, evidence, proposed_action, confidence, rationale, fingerprint, created_at
  )
  VALUES (
    v_tenant_a, v_fleet_agent_key, v_run_fleet_a, v_workflow_id_fleet, null, null, 'idle_under_utilized',
    'medium', 'pending_approval',
    jsonb_build_object(
      'asset_id', v_idle_asset_id,
      'category_id', v_idle_asset_category_id,
      'home_branch_id', v_branch_ids[1],
      'target_branch_id', v_branch_ids[2],
      'idle_days', 41
    ),
    jsonb_build_object(
      'open_demand_orders', 3,
      'demand_line_id', v_demand_line_id
    ),
    1500,
    jsonb_build_array(
      jsonb_build_object('type', 'idle_window', 'detail', 'Asset idle for 41 days', 'source_id', 'demo-ops-fleet-idle-001'),
      jsonb_build_object('type', 'branch_demand', 'detail', 'South branch has 3 open orders in same category', 'source_id', 'demo-ops-fleet-demand-001')
    ),
    'Propose transfer to high-demand branch',
    0.89,
    'Idle asset category demand is concentrated at another branch; transfer can increase utilization.',
    'demo-ops-fleet-idle-transfer-001',
    v_seed_ts - interval '54 minutes'
  );

  INSERT INTO finding (
    tenant_id, agent_key, run_id, workflow_id, contract_id, line_item_id, finding_type,
    severity, status, expected, billed, delta, evidence, proposed_action, confidence, rationale, fingerprint, created_at
  )
  VALUES (
    v_tenant_a, v_agent_key, v_run_a, v_workflow_id, v_contract_ids[1], v_line_ids[1], 'unbilled_on_rent',
    'high', 'pending_approval',
    '{"amount":3600,"currency":"USD","rate_type":"weekly","weeks_expected":3}'::jsonb,
    '{"amount":2400,"currency":"USD","weeks_billed":2}'::jsonb,
    1200,
    jsonb_build_array(
      jsonb_build_object('type', 'on_rent_window', 'detail', 'Asset remained on-rent for weeks 2-3'),
      jsonb_build_object('type', 'invoice_gap', 'detail', 'Invoice line covers only two weeks')
    ),
    'Draft catch-up invoice line for missing rental week',
    0.96,
    'Contract remained active and on-rent for three weeks; invoicing captured only two weekly periods.',
    'demo-ops-unbilled-on-rent',
    v_seed_ts - interval '70 minutes'
  );

  INSERT INTO finding (
    tenant_id, agent_key, run_id, workflow_id, contract_id, line_item_id, finding_type,
    severity, status, expected, billed, delta, evidence, proposed_action, confidence, rationale, fingerprint, created_at
  )
  VALUES (
    v_tenant_a, v_agent_key, v_run_a, v_workflow_id, v_contract_ids[2], v_line_ids[2], 'billing_past_return',
    'high', 'pending_approval',
    '{"amount":1200,"currency":"USD","billable_through":"2026-05-10"}'::jsonb,
    '{"amount":2400,"currency":"USD","billed_through":"2026-05-24"}'::jsonb,
    1200,
    jsonb_build_array(
      jsonb_build_object('type', 'return_event', 'detail', 'Return recorded on 2026-05-10'),
      jsonb_build_object('type', 'invoice_period', 'detail', 'Invoice billed through 2026-05-24')
    ),
    'Issue credit memo for post-return billing',
    0.95,
    'Billing period extends two weeks beyond the confirmed return event.',
    'demo-ops-billing-past-return',
    v_seed_ts - interval '68 minutes'
  );

  INSERT INTO finding (
    tenant_id, agent_key, run_id, workflow_id, contract_id, line_item_id, finding_type,
    severity, status, expected, billed, delta, evidence, proposed_action, confidence, rationale, fingerprint, created_at
  )
  VALUES (
    v_tenant_a, v_agent_key, v_run_a, v_workflow_id, v_contract_ids[3], v_line_ids[3], 'rate_tier_mismatch',
    'medium', 'pending_approval',
    '{"amount":1200,"currency":"USD","rate_type":"weekly","rate_card_rate":1200}'::jsonb,
    '{"amount":1680,"currency":"USD","rate_type":"daily","billed_rate":240}'::jsonb,
    480,
    jsonb_build_array(
      jsonb_build_object('type', 'rate_card', 'detail', 'Rate card requires weekly tier'),
      jsonb_build_object('type', 'invoice_line', 'detail', 'Invoice line billed daily tier')
    ),
    'Re-rate billed line to contracted weekly tier',
    0.88,
    'Invoice used daily pricing despite contract and rate-card weekly tier terms.',
    'demo-ops-rate-tier-mismatch',
    v_seed_ts - interval '67 minutes'
  );

  -- Keep a stable pending queue for repeated non-reset smoke runs. These low-impact
  -- placeholders preserve pending_count availability without changing KPI dollar totals.
  FOR i IN 1..v_pending_placeholder_count LOOP
    INSERT INTO finding (
      tenant_id, agent_key, run_id, workflow_id, contract_id, line_item_id, finding_type,
      severity, status, expected, billed, delta, evidence, proposed_action, confidence, rationale, fingerprint, created_at
    )
    VALUES (
      v_tenant_a,
      v_agent_key,
      v_run_b,
      v_workflow_id,
      v_contract_ids[1],
      v_line_ids[1],
      'pending_review_placeholder',
      'low',
      'pending_approval',
      '{"amount":0,"currency":"USD"}'::jsonb,
      '{"amount":0,"currency":"USD"}'::jsonb,
      0,
      jsonb_build_array(
        jsonb_build_object('type', 'queue_maintenance', 'detail', format('placeholder finding %s for smoke queue stability', i))
      ),
      'No-op review placeholder',
      0.5,
      'Synthetic low-impact pending item to keep the seeded approval queue populated for repeated smoke executions.',
      format('demo-ops-pending-placeholder-%s', lpad(i::text, 3, '0')),
      v_seed_ts - interval '65 minutes' + make_interval(mins => i)
    );
  END LOOP;

  INSERT INTO finding (
    tenant_id, agent_key, run_id, workflow_id, contract_id, line_item_id, finding_type,
    severity, status, expected, billed, delta, evidence, proposed_action, confidence, rationale, fingerprint, created_at, decided_at, approver
  )
  VALUES (
    v_tenant_a, v_agent_key, v_run_a, v_workflow_id, v_contract_ids[4], v_line_ids[4], 'missed_escalation',
    'medium', 'approved',
    '{"amount":3840,"currency":"USD","base_rate":3200,"escalation_pct":0.20}'::jsonb,
    '{"amount":3200,"currency":"USD","invoiced_rate":3200}'::jsonb,
    640,
    jsonb_build_array(
      jsonb_build_object('type', 'contract_clause', 'detail', 'Renewal requires 20% escalation'),
      jsonb_build_object('type', 'invoice_line', 'detail', 'Renewal invoice remained at base rate')
    ),
    'Apply renewal escalation adjustment',
    0.91,
    'Renewal period did not apply the contracted annual escalation factor.',
    'demo-ops-missed-escalation',
    v_seed_ts - interval '66 minutes',
    v_seed_ts - interval '58 minutes',
    '{"actor":"demo.ops.manager@example.com","role":"branch_manager"}'::jsonb
  )
  RETURNING id INTO v_approved_finding_id;

  INSERT INTO finding (
    tenant_id, agent_key, run_id, workflow_id, contract_id, line_item_id, finding_type,
    severity, status, expected, billed, delta, evidence, proposed_action, confidence, rationale, fingerprint, created_at, decided_at, approver
  )
  VALUES (
    v_tenant_a, v_agent_key, v_run_a, v_workflow_id, v_contract_ids[5], v_line_ids[5], 'over_billed',
    'high', 'rejected',
    '{"amount":1800,"currency":"USD","weeks":2}'::jsonb,
    '{"amount":2700,"currency":"USD","overlap_week":"2026-04-20..2026-04-26"}'::jsonb,
    900,
    jsonb_build_array(
      jsonb_build_object('type', 'invoice_overlap', 'detail', 'Two invoice lines cover same service week'),
      jsonb_build_object('type', 'line_comparison', 'detail', 'Duplicate week billed twice at $900 each')
    ),
    'Issue credit for duplicate week',
    0.87,
    'Detected duplicate overlapping weekly line item; reviewer rejected due to disputed off-rent exception.',
    'demo-ops-over-billed',
    v_seed_ts - interval '65 minutes',
    v_seed_ts - interval '55 minutes',
    '{"actor":"demo.ops.controller@example.com","role":"admin","reason":"Disputed by customer; hold for manual resolution"}'::jsonb
  )
  RETURNING id INTO v_rejected_finding_id;

  INSERT INTO invoice_adjustment_draft (
    tenant_id,
    finding_id,
    amount,
    status,
    approver,
    payload
  )
  VALUES (
    v_tenant_a,
    v_approved_finding_id,
    640,
    'draft',
    '{"actor":"demo.ops.manager@example.com","role":"branch_manager"}'::jsonb,
    jsonb_build_object(
      'seed_namespace', 'demo-ops',
      'workflow_id', v_workflow_id,
      'contract_id', v_contract_ids[4],
      'line_item_id', v_line_ids[4],
      'adjustment_type', 'renewal_escalation_catchup',
      'currency', 'USD',
      'memo', 'Apply 20% renewal escalation per contract clause'
    )
  )
  RETURNING id INTO v_approved_draft_id;

  INSERT INTO time_series_points (entity_id, fact_type_id, observed_at, data_payload, metadata, source_id)
  VALUES
    (
      v_contract_ids[4],
      v_fact_ops_audit,
      v_seed_ts - interval '66 minutes',
      jsonb_build_object('event_type', 'finding_created', 'finding_id', v_approved_finding_id, 'workflow_id', v_workflow_id),
      jsonb_build_object('seed_namespace', 'demo-ops', 'finding_id', v_approved_finding_id, 'tenant_id', v_tenant_a, 'tenant_key', 'demo-ops-a'),
      'demo-ops-audit-001'
    ),
    (
      v_contract_ids[4],
      v_fact_ops_audit,
      v_seed_ts - interval '60 minutes',
      jsonb_build_object('event_type', 'adjustment_drafted', 'finding_id', v_approved_finding_id, 'draft_id', v_approved_draft_id, 'amount', 640),
      jsonb_build_object('seed_namespace', 'demo-ops', 'finding_id', v_approved_finding_id, 'draft_id', v_approved_draft_id, 'tenant_id', v_tenant_a, 'tenant_key', 'demo-ops-a'),
      'demo-ops-audit-002'
    ),
    (
      v_contract_ids[4],
      v_fact_ops_audit,
      v_seed_ts - interval '58 minutes',
      jsonb_build_object('event_type', 'finding_approved', 'finding_id', v_approved_finding_id, 'approved_by', 'demo.ops.manager@example.com'),
      jsonb_build_object('seed_namespace', 'demo-ops', 'finding_id', v_approved_finding_id, 'draft_id', v_approved_draft_id, 'tenant_id', v_tenant_a, 'tenant_key', 'demo-ops-a'),
      'demo-ops-audit-003'
    ),
    (
      v_contract_ids[5],
      v_fact_ops_audit,
      v_seed_ts - interval '55 minutes',
      jsonb_build_object('event_type', 'finding_rejected', 'finding_id', v_rejected_finding_id, 'reason', 'manual override'),
      jsonb_build_object('seed_namespace', 'demo-ops', 'finding_id', v_rejected_finding_id, 'tenant_id', v_tenant_a, 'tenant_key', 'demo-ops-a'),
      'demo-ops-audit-004'
    );

  PERFORM refresh_org_scope_closure();
  PERFORM refresh_entity_org_scopes();
END
$$;

-- ---------------------------------------------------------------------------
-- Credit & Risk Analyst demo seed
-- Seeds agent config + demo findings for the credit-analyst agent so the
-- Findings & Approvals console shows representative AR collections queue data.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_seed_ts       timestamptz := '2026-05-31T12:00:00Z'::timestamptz;
  v_credit_key    text        := 'credit-analyst';

  v_tenant_a      uuid;
  v_tenant_b      uuid;

  v_billing_ids   uuid[];
  v_customer_ids  uuid[];

  v_run_credit_a  text := 'demo-credit-run-a-20260531';
  v_run_credit_b  text := 'demo-credit-run-b-20260531';
  v_workflow_id   text := 'demo-credit-workflow-20260531';

  v_pending_finding_id  uuid;
  v_approved_finding_id uuid;
  v_rejected_finding_id uuid;
  v_proposal_id         uuid;
BEGIN
  -- Idempotent cleanup ---------------------------------------------------
  DELETE FROM credit_change_proposal
  WHERE payload ->> 'seed_namespace' = 'demo-credit';

  DELETE FROM finding
  WHERE fingerprint LIKE 'demo-credit-%'
     OR workflow_id LIKE 'demo-credit-%';

  DELETE FROM ops_workflow_run
  WHERE run_id LIKE 'demo-credit-%';

  DELETE FROM ops_agent_config
  WHERE tenant_id IN (
    SELECT id FROM tenants WHERE tenant_key IN ('demo-ops-a', 'demo-ops-b')
  ) AND agent_key = v_credit_key;

  -- Resolve demo tenants -------------------------------------------------
  SELECT id INTO v_tenant_a FROM tenants WHERE tenant_key = 'demo-ops-a';
  SELECT id INTO v_tenant_b FROM tenants WHERE tenant_key = 'demo-ops-b';

  IF v_tenant_a IS NULL OR v_tenant_b IS NULL THEN
    RAISE EXCEPTION 'Credit analyst demo seed requires demo-ops-a and demo-ops-b tenants (run the main ops seed first)';
  END IF;

  -- Billing accounts + customers from baseline ---------------------------
  SELECT array_agg(id ORDER BY source_record_id) INTO v_billing_ids
  FROM entities
  WHERE entity_type = 'billing_account'
    AND source_record_id LIKE 'demo-baseline-billing-%';

  SELECT array_agg(id ORDER BY source_record_id) INTO v_customer_ids
  FROM entities
  WHERE entity_type = 'customer'
    AND source_record_id LIKE 'demo-baseline-customer-%';

  IF COALESCE(array_length(v_billing_ids, 1), 0) < 4
    OR COALESCE(array_length(v_customer_ids, 1), 0) < 4 THEN
    RAISE EXCEPTION 'Credit analyst demo seed requires baseline billing_account + customer entities';
  END IF;

  -- Output schema (idempotent — migration also inserts this) -------------
  INSERT INTO ops_output_schema_registry (schema_key, schema_json, description)
  VALUES (
    'credit_proposal_v1',
    '{"type":"object","required":["account_id","risk_level","proposed_action","rationale"]}'::jsonb,
    'Credit & risk analyst proposal output schema v1'
  )
  ON CONFLICT (schema_key) DO UPDATE
    SET schema_json = EXCLUDED.schema_json,
        description = EXCLUDED.description,
        updated_at  = now();

  -- Agent config — tenant A ----------------------------------------------
  INSERT INTO ops_agent_config (
    tenant_id, agent_key, enabled, model,
    system_prompt, user_prompt_template,
    tools, output_schema_key, thresholds, bounds, schedule, auto_apply
  )
  VALUES (
    v_tenant_a,
    v_credit_key,
    true,
    '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb,
    'You are an AR collections priority and escalation assistant for an equipment-rental company. Rank overdue billing accounts, recommend the next human-approved collections step, preserve uncertainty when payment or account-history signals are stale, and never send outreach or take legal action automatically.',
    'Review billing account {account_id} for tenant {tenant_id}. Use AR aging, payment history, branch/account notes, and overdue trend evidence to recommend the next collections step. Keep the queue unchanged when no materially new signal exists. Evidence:\n{evidence_json}',
    '["rental_data"]'::jsonb,
    'credit_proposal_v1',
    '{"overdue_threshold":500,"exposure_utilization_pct":80,"min_confidence_to_surface":0.65,"notice_of_intent_days":60,"lien_preparation_days":90,"payment_history_stale_after_days":21}'::jsonb,
    '{"max_findings_per_run":30,"max_tool_rounds":5}'::jsonb,
    '{"cron":"0 6 * * *","next_run_at":"2026-06-03T06:00:00Z","enabled":true}'::jsonb,
    false
  )
  ON CONFLICT (tenant_id, agent_key) DO UPDATE
    SET enabled              = EXCLUDED.enabled,
        model                = EXCLUDED.model,
        system_prompt        = EXCLUDED.system_prompt,
        user_prompt_template = EXCLUDED.user_prompt_template,
        tools                = EXCLUDED.tools,
        output_schema_key    = EXCLUDED.output_schema_key,
        thresholds           = EXCLUDED.thresholds,
        bounds               = EXCLUDED.bounds,
        schedule             = EXCLUDED.schedule,
        auto_apply           = EXCLUDED.auto_apply,
        updated_at           = now();

  -- Agent config — tenant B ----------------------------------------------
  INSERT INTO ops_agent_config (
    tenant_id, agent_key, enabled, model,
    system_prompt, user_prompt_template,
    tools, output_schema_key, thresholds, bounds, schedule, auto_apply
  )
  VALUES (
    v_tenant_b,
    v_credit_key,
    true,
    '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb,
    'You are an AR collections priority and escalation assistant for an equipment-rental company. Rank overdue billing accounts, recommend the next human-approved collections step, preserve uncertainty when payment or account-history signals are stale, and never send outreach or take legal action automatically.',
    'Review billing account {account_id} for tenant {tenant_id}. Use AR aging, payment history, branch/account notes, and overdue trend evidence to recommend the next collections step. Keep the queue unchanged when no materially new signal exists. Evidence:\n{evidence_json}',
    '["rental_data"]'::jsonb,
    'credit_proposal_v1',
    '{"overdue_threshold":750,"exposure_utilization_pct":85,"min_confidence_to_surface":0.7,"notice_of_intent_days":60,"lien_preparation_days":90,"payment_history_stale_after_days":21}'::jsonb,
    '{"max_findings_per_run":20,"max_tool_rounds":5}'::jsonb,
    '{"cron":"0 6 * * *","next_run_at":"2026-06-03T06:00:00Z","enabled":true}'::jsonb,
    false
  )
  ON CONFLICT (tenant_id, agent_key) DO UPDATE
    SET enabled              = EXCLUDED.enabled,
        model                = EXCLUDED.model,
        system_prompt        = EXCLUDED.system_prompt,
        user_prompt_template = EXCLUDED.user_prompt_template,
        tools                = EXCLUDED.tools,
        output_schema_key    = EXCLUDED.output_schema_key,
        thresholds           = EXCLUDED.thresholds,
        bounds               = EXCLUDED.bounds,
        schedule             = EXCLUDED.schedule,
        auto_apply           = EXCLUDED.auto_apply,
        updated_at           = now();

  -- Workflow runs --------------------------------------------------------
  INSERT INTO ops_workflow_run (run_id, tenant_id, workflow_key, started_at, finished_at, status, counts)
  VALUES
    (
      v_run_credit_a,
      v_tenant_a,
      v_credit_key,
      v_seed_ts - interval '3 hours',
      v_seed_ts - interval '2 hours 50 minutes',
      'succeeded',
      '{"accounts_scoped":4,"findings_produced":3,"approved_findings":1,"rejected_findings":1,"pending_findings":1}'::jsonb
    ),
    (
      v_run_credit_b,
      v_tenant_b,
      v_credit_key,
      v_seed_ts - interval '2 hours',
      v_seed_ts - interval '1 hour 55 minutes',
      'succeeded',
      '{"accounts_scoped":4,"findings_produced":2,"approved_findings":0,"rejected_findings":0,"pending_findings":2}'::jsonb
    );

  -- Demo findings --------------------------------------------------------

  -- Finding 1: pending approval (60+ day account nearing formal escalation)
  INSERT INTO finding (
    tenant_id, agent_key, run_id, workflow_id,
    contract_id, line_item_id,
    finding_type, severity, status,
    expected, billed, delta,
    evidence, proposed_action, confidence, rationale,
    fingerprint
  )
  VALUES (
    v_tenant_a,
    v_credit_key,
    v_run_credit_a,
    v_workflow_id,
    v_billing_ids[1], NULL,
    'collections_priority', 'high', 'pending_approval',
    jsonb_build_object('amount', 14250, 'account_label', 'BA-TX-0001', 'customer_name', 'Blue Mesa Civil Works', 'branch_context', 'Houston North · Note: Payment delays noted on last two invoices.', 'escalation_stage', 'approaching_formal_escalation', 'material_signal_key', 'demo-credit-signal-1', 'stale_inputs', jsonb_build_array('payment_history_stale'), 'operating_model_tags', jsonb_build_array('credit-billing-analyst:t1', 'credit-billing-analyst:t8')),
    jsonb_build_object('amount', 18800),
    14250,
    jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object('label', 'Overdue AR', 'summary', '$14,250 overdue across 3 invoices'),
      jsonb_build_object('label', 'Escalation window', 'summary', 'Oldest overdue invoice is 67 days old; notice-of-intent review is now due'),
      jsonb_build_object('label', 'Branch context', 'summary', 'Houston North branch requested escalated follow-up after missed callbacks')
    )),
    'review_notice_of_intent',
    0.87,
    'Overdue aging has crossed the notice-of-intent threshold and branch follow-up is stalled. Review notice-of-intent language before recovery options narrow.',
    format('%s:collections_priority', v_billing_ids[1])
  )
  RETURNING id INTO v_pending_finding_id;

  -- Finding 2: approved — formal escalation review
  INSERT INTO finding (
    tenant_id, agent_key, run_id, workflow_id,
    contract_id, line_item_id,
    finding_type, severity, status,
    expected, billed, delta,
    evidence, proposed_action, confidence, rationale,
    fingerprint, decided_at, approver
  )
  VALUES (
    v_tenant_a,
    v_credit_key,
    v_run_credit_a,
    v_workflow_id,
    v_billing_ids[2], NULL,
    'collections_priority', 'high', 'approved',
    jsonb_build_object('amount', 8900, 'account_label', 'BA-TX-0002', 'customer_name', 'Ironwood Industrial Mechanics', 'branch_context', 'Dallas South · Note: No contact response in 14 days.', 'escalation_stage', 'formal_escalation_review', 'material_signal_key', 'demo-credit-signal-2', 'stale_inputs', '[]'::jsonb, 'operating_model_tags', jsonb_build_array('credit-billing-analyst:t1', 'credit-billing-analyst:t8')),
    jsonb_build_object('amount', 10200),
    8900,
    jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object('label', 'Overdue AR', 'summary', '$8,900 overdue with oldest invoice at 94 days'),
      jsonb_build_object('label', 'Escalation window', 'summary', 'Lien-prep review threshold reached'),
      jsonb_build_object('label', 'Payment signal', 'summary', 'NSF payment returned on 2026-05-10')
    )),
    'review_lien_preparation',
    0.92,
    'Account is now beyond the formal escalation threshold. Analyst approved lien-preparation review after verifying the NSF signal and failed outreach.',
    format('%s:collections_priority', v_billing_ids[2]),
    v_seed_ts - interval '2 hours 45 minutes',
    jsonb_build_object('approver_id', 'demo.credit.manager@example.com', 'approver_name', 'Credit Manager', 'note', 'Agreed — hold applied immediately')
  )
  RETURNING id INTO v_approved_finding_id;

  -- Finding 3: rejected — routine follow-up kept manual
  INSERT INTO finding (
    tenant_id, agent_key, run_id, workflow_id,
    contract_id, line_item_id,
    finding_type, severity, status,
    expected, billed, delta,
    evidence, proposed_action, confidence, rationale,
    fingerprint, decided_at, approver
  )
  VALUES (
    v_tenant_a,
    v_credit_key,
    v_run_credit_a,
    v_workflow_id,
    v_billing_ids[3], NULL,
    'collections_priority', 'medium', 'rejected',
    jsonb_build_object('amount', 16200, 'account_label', 'BA-TX-0003', 'customer_name', 'Summit Arc Steel Services', 'branch_context', 'Houston North · Note: Billing cycle mismatch under review.', 'escalation_stage', 'routine_follow_up', 'material_signal_key', 'demo-credit-signal-3', 'stale_inputs', '[]'::jsonb, 'operating_model_tags', jsonb_build_array('credit-billing-analyst:t1', 'credit-billing-analyst:t8')),
    jsonb_build_object('amount', 16200),
    16200,
    jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object('label', 'Overdue AR', 'summary', '$16,200 overdue, but aging remains inside routine follow-up thresholds'),
      jsonb_build_object('label', 'Branch context', 'summary', 'Branch notes indicate a billing-cycle mismatch rather than deteriorating payment intent')
    )),
    'routine_follow_up',
    0.70,
    'Routine follow-up remains appropriate, but the manager rejected automated escalation because the branch is reconciling a billing-cycle mismatch.',
    format('%s:collections_priority', v_billing_ids[3]),
    v_seed_ts - interval '2 hours 40 minutes',
    jsonb_build_object('approver_id', 'demo.credit.manager@example.com', 'approver_name', 'Credit Manager', 'note', 'Long-standing customer — payment delay due to billing cycle mismatch, not a risk signal')
  )
  RETURNING id INTO v_rejected_finding_id;

  -- Credit change proposal for the approved finding ----------------------
  INSERT INTO credit_change_proposal (
    tenant_id, finding_id, account_id,
    proposed_action, proposed_credit_limit,
    proposed_terms, proposed_hold,
    status, approver, payload
  )
  VALUES (
    v_tenant_a,
    v_approved_finding_id,
    v_billing_ids[2],
    'place_hold',
    NULL,
    NULL,
    true,
    'draft',
    jsonb_build_object('approver_id', 'demo.credit.manager@example.com', 'approver_name', 'Credit Manager'),
    jsonb_build_object(
      'seed_namespace', 'demo-credit',
      'risk_level', 'high',
      'rationale', 'NSF payment + no contact — hold applied',
      'confidence', 0.92,
      'current_exposure', 8900,
      'aging_trend', 'deteriorating',
      'fingerprint', format('demo-credit-%s:credit_risk:place_hold:high', v_billing_ids[2]),
      'run_id', v_run_credit_a,
      'applied_at', (v_seed_ts - interval '2 hours 45 minutes')::text,
      'applied_by', 'demo.credit.manager@example.com'
    )
  )
  RETURNING id INTO v_proposal_id;

END
$$;

-- ---------------------------------------------------------------------------
-- Account Health & Dormant-Account Growth Queue demo seed
-- Seeds agent config for the account-health-queue agent so the Findings &
-- Approvals console can surface ranked dormant/lost/at-risk/growth threads.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_account_health_key  text  := 'account-health-queue';
  v_tenant_a            uuid;
  v_tenant_b            uuid;
BEGIN
  -- Idempotent cleanup ---------------------------------------------------
  DELETE FROM ops_agent_config
  WHERE tenant_id IN (
    SELECT id FROM tenants WHERE tenant_key IN ('demo-ops-a', 'demo-ops-b')
  ) AND agent_key = v_account_health_key;

  -- Resolve demo tenants -------------------------------------------------
  SELECT id INTO v_tenant_a FROM tenants WHERE tenant_key = 'demo-ops-a';
  SELECT id INTO v_tenant_b FROM tenants WHERE tenant_key = 'demo-ops-b';

  IF v_tenant_a IS NULL OR v_tenant_b IS NULL THEN
    RAISE EXCEPTION 'Account health demo seed requires demo-ops-a and demo-ops-b tenants (run the main ops seed first)';
  END IF;

  -- Output schema (idempotent) -------------------------------------------
  INSERT INTO ops_output_schema_registry (schema_key, schema_json, description)
  VALUES (
    'account_health_thread_v1',
    '{"type":"object","required":["account_id","health_signal","priority","recommended_angle","rationale"]}'::jsonb,
    'Account health and dormant-account growth queue thread output schema v1'
  )
  ON CONFLICT (schema_key) DO UPDATE
    SET schema_json = EXCLUDED.schema_json,
        description = EXCLUDED.description,
        updated_at  = now();

  -- Agent config — tenant A ----------------------------------------------
  INSERT INTO ops_agent_config (
    tenant_id, agent_key, enabled, model,
    system_prompt, user_prompt_template,
    tools, output_schema_key, thresholds, bounds, schedule, auto_apply
  )
  VALUES (
    v_tenant_a,
    v_account_health_key,
    true,
    '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb,
    'You are the account health and dormant-account growth assistant for an outside sales representative at an equipment-rental company. Rank dormant, lost, at-risk, and expansion-prone accounts using rental history, utilization shifts, open opportunities, and contact gaps. Provide a reviewable win-back, retention, or growth angle for the rep. Never send outreach, mutate account stages, or commit commercial terms automatically. Surface stale or weak signals explicitly and allow a clean no-op when no genuinely new signal exists.',
    'Evaluate account health for customer {account_id} ({account_name}) in tenant {tenant_id}. Health signal: {health_signal}. Days since last rental: {days_since_rental}. Contact gap days: {contact_gap_days}. Utilization trend: {utilization_trend}. Open opportunities: {open_opportunities}. Provide a ranked health thread with a reviewable outreach draft. Evidence:\n{evidence_json}',
    '["rental_data"]'::jsonb,
    'account_health_thread_v1',
    '{"dormant_days":60,"lost_days":180,"contact_gap_at_risk_days":45,"min_confidence_to_surface":0.60}'::jsonb,
    '{"max_findings_per_run":50,"max_tool_rounds":5}'::jsonb,
    '{"cron":"0 7 * * 1","enabled":true}'::jsonb,
    false
  )
  ON CONFLICT (tenant_id, agent_key) DO UPDATE
    SET enabled              = EXCLUDED.enabled,
        model                = EXCLUDED.model,
        system_prompt        = EXCLUDED.system_prompt,
        user_prompt_template = EXCLUDED.user_prompt_template,
        tools                = EXCLUDED.tools,
        output_schema_key    = EXCLUDED.output_schema_key,
        thresholds           = EXCLUDED.thresholds,
        bounds               = EXCLUDED.bounds,
        schedule             = EXCLUDED.schedule,
        auto_apply           = EXCLUDED.auto_apply,
        updated_at           = now();

  -- Agent config — tenant B ----------------------------------------------
  INSERT INTO ops_agent_config (
    tenant_id, agent_key, enabled, model,
    system_prompt, user_prompt_template,
    tools, output_schema_key, thresholds, bounds, schedule, auto_apply
  )
  VALUES (
    v_tenant_b,
    v_account_health_key,
    true,
    '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb,
    'You are the account health and dormant-account growth assistant for an outside sales representative at an equipment-rental company. Rank dormant, lost, at-risk, and expansion-prone accounts using rental history, utilization shifts, open opportunities, and contact gaps. Provide a reviewable win-back, retention, or growth angle for the rep. Never send outreach, mutate account stages, or commit commercial terms automatically. Surface stale or weak signals explicitly and allow a clean no-op when no genuinely new signal exists.',
    'Evaluate account health for customer {account_id} ({account_name}) in tenant {tenant_id}. Health signal: {health_signal}. Days since last rental: {days_since_rental}. Contact gap days: {contact_gap_days}. Utilization trend: {utilization_trend}. Open opportunities: {open_opportunities}. Provide a ranked health thread with a reviewable outreach draft. Evidence:\n{evidence_json}',
    '["rental_data"]'::jsonb,
    'account_health_thread_v1',
    '{"dormant_days":60,"lost_days":180,"contact_gap_at_risk_days":45,"min_confidence_to_surface":0.60}'::jsonb,
    '{"max_findings_per_run":50,"max_tool_rounds":5}'::jsonb,
    '{"cron":"0 7 * * 1","enabled":true}'::jsonb,
    false
  )
  ON CONFLICT (tenant_id, agent_key) DO UPDATE
    SET enabled              = EXCLUDED.enabled,
        model                = EXCLUDED.model,
        system_prompt        = EXCLUDED.system_prompt,
        user_prompt_template = EXCLUDED.user_prompt_template,
        tools                = EXCLUDED.tools,
        output_schema_key    = EXCLUDED.output_schema_key,
        thresholds           = EXCLUDED.thresholds,
        bounds               = EXCLUDED.bounds,
        schedule             = EXCLUDED.schedule,
        auto_apply           = EXCLUDED.auto_apply,
        updated_at           = now();

END
$$;

-- ---------------------------------------------------------------------------
-- Territory Account Brief & Follow-up Assistant demo seed
-- Seeds agent config for the territory-account-brief agent so the Findings &
-- Approvals console can surface pre-visit briefs and follow-up contexts for
-- outside sales representatives (operating-model tags t1/t2/t4).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_territory_brief_key  text  := 'territory-account-brief';
  v_tenant_a             uuid;
  v_tenant_b             uuid;
BEGIN
  -- Idempotent cleanup ---------------------------------------------------
  DELETE FROM ops_agent_config
  WHERE tenant_id IN (
    SELECT id FROM tenants WHERE tenant_key IN ('demo-ops-a', 'demo-ops-b')
  ) AND agent_key = v_territory_brief_key;

  -- Resolve demo tenants -------------------------------------------------
  SELECT id INTO v_tenant_a FROM tenants WHERE tenant_key = 'demo-ops-a';
  SELECT id INTO v_tenant_b FROM tenants WHERE tenant_key = 'demo-ops-b';

  IF v_tenant_a IS NULL OR v_tenant_b IS NULL THEN
    RAISE EXCEPTION 'Territory brief demo seed requires demo-ops-a and demo-ops-b tenants (run the main ops seed first)';
  END IF;

  -- Output schema (idempotent) -------------------------------------------
  INSERT INTO ops_output_schema_registry (schema_key, schema_json, description)
  VALUES (
    'territory_brief_item_v1',
    '{"type":"object","required":["account_id","brief_type","priority","recommended_action","rationale"]}'::jsonb,
    'Territory account brief and follow-up assistant item output schema v1'
  )
  ON CONFLICT (schema_key) DO UPDATE
    SET schema_json = EXCLUDED.schema_json,
        description = EXCLUDED.description,
        updated_at  = now();

  -- Agent config — tenant A ----------------------------------------------
  INSERT INTO ops_agent_config (
    tenant_id, agent_key, enabled, model,
    system_prompt, user_prompt_template,
    tools, output_schema_key, thresholds, bounds, schedule, auto_apply
  )
  VALUES (
    v_tenant_a,
    v_territory_brief_key,
    true,
    '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb,
    'You are the territory account brief and follow-up assistant for an outside sales representative at an equipment-rental company. Assemble a disposition-ready pre-visit or territory-plan brief for a single customer account using recent rentals, open opportunities, visit history, multi-branch signals, promised follow-ups, and branch-side execution risks. Always: cite evidence from rental history, CRM, and branch records with freshness indicators; surface stale or missing data explicitly rather than presenting a falsely complete brief; preserve drill-down links to source account, quote, and branch records. Never commit pricing, send outreach, mutate CRM stages or notes, or make branch promises automatically.',
    'Prepare a territory account brief for customer {account_id} ({account_name}) in tenant {tenant_id}. Brief type: {brief_type}. Open opportunities: {open_opportunities}. Promised follow-ups outstanding: {promised_follow_up_count}. Days since last visit: {days_since_visit}. Recent rentals (last 90 days): {recent_rental_count}. Provide a disposition-ready brief with evidence and freshness indicators. Evidence:\n{evidence_json}',
    '["rental_data"]'::jsonb,
    'territory_brief_item_v1',
    '{"min_confidence_to_surface":0.60}'::jsonb,
    '{"max_findings_per_run":50,"max_tool_rounds":5}'::jsonb,
    '{"cron":"0 7 * * 1","enabled":true}'::jsonb,
    false
  )
  ON CONFLICT (tenant_id, agent_key) DO UPDATE
    SET enabled              = EXCLUDED.enabled,
        model                = EXCLUDED.model,
        system_prompt        = EXCLUDED.system_prompt,
        user_prompt_template = EXCLUDED.user_prompt_template,
        tools                = EXCLUDED.tools,
        output_schema_key    = EXCLUDED.output_schema_key,
        thresholds           = EXCLUDED.thresholds,
        bounds               = EXCLUDED.bounds,
        schedule             = EXCLUDED.schedule,
        auto_apply           = EXCLUDED.auto_apply,
        updated_at           = now();

  -- Agent config — tenant B ----------------------------------------------
  INSERT INTO ops_agent_config (
    tenant_id, agent_key, enabled, model,
    system_prompt, user_prompt_template,
    tools, output_schema_key, thresholds, bounds, schedule, auto_apply
  )
  VALUES (
    v_tenant_b,
    v_territory_brief_key,
    true,
    '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb,
    'You are the territory account brief and follow-up assistant for an outside sales representative at an equipment-rental company. Assemble a disposition-ready pre-visit or territory-plan brief for a single customer account using recent rentals, open opportunities, visit history, multi-branch signals, promised follow-ups, and branch-side execution risks. Always: cite evidence from rental history, CRM, and branch records with freshness indicators; surface stale or missing data explicitly rather than presenting a falsely complete brief; preserve drill-down links to source account, quote, and branch records. Never commit pricing, send outreach, mutate CRM stages or notes, or make branch promises automatically.',
    'Prepare a territory account brief for customer {account_id} ({account_name}) in tenant {tenant_id}. Brief type: {brief_type}. Open opportunities: {open_opportunities}. Promised follow-ups outstanding: {promised_follow_up_count}. Days since last visit: {days_since_visit}. Recent rentals (last 90 days): {recent_rental_count}. Provide a disposition-ready brief with evidence and freshness indicators. Evidence:\n{evidence_json}',
    '["rental_data"]'::jsonb,
    'territory_brief_item_v1',
    '{"min_confidence_to_surface":0.60}'::jsonb,
    '{"max_findings_per_run":50,"max_tool_rounds":5}'::jsonb,
    '{"cron":"0 7 * * 1","enabled":true}'::jsonb,
    false
  )
  ON CONFLICT (tenant_id, agent_key) DO UPDATE
    SET enabled              = EXCLUDED.enabled,
        model                = EXCLUDED.model,
        system_prompt        = EXCLUDED.system_prompt,
        user_prompt_template = EXCLUDED.user_prompt_template,
        tools                = EXCLUDED.tools,
        output_schema_key    = EXCLUDED.output_schema_key,
        thresholds           = EXCLUDED.thresholds,
        bounds               = EXCLUDED.bounds,
        schedule             = EXCLUDED.schedule,
        auto_apply           = EXCLUDED.auto_apply,
        updated_at           = now();

END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — demo vehicles (issue #4)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-vehicle-%'.
-- 12 vehicles (6 novo + 6 usado) with varied purchase_date so floor_plan_cost
-- is > 0 for the aged ones. Reuses rental_upsert_entity_current_state (the
-- generic SCD2 upsert) under the service_role write guard.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_now timestamptz := now();
  v_vehicles jsonb := jsonb_build_array(
    -- condition, brand, model, year, cost, sale_price, days_old, status, store
    jsonb_build_object('sr','demo-dia-vehicle-001','condition','novo','brand','Fiat','model','Pulse','model_year',2026,'cost',95000,'sale_price',119900,'days',75,'status','em_estoque','store','Matriz'),
    jsonb_build_object('sr','demo-dia-vehicle-002','condition','novo','brand','Jeep','model','Compass','model_year',2026,'cost',180000,'sale_price',229900,'days',120,'status','em_estoque','store','Matriz'),
    jsonb_build_object('sr','demo-dia-vehicle-003','condition','novo','brand','Volkswagen','model','Nivus','model_year',2026,'cost',120000,'sale_price',149900,'days',45,'status','em_estoque','store','Filial Sul'),
    jsonb_build_object('sr','demo-dia-vehicle-004','condition','novo','brand','Chevrolet','model','Onix','model_year',2026,'cost',88000,'sale_price',104900,'days',15,'status','em_estoque','store','Filial Sul'),
    jsonb_build_object('sr','demo-dia-vehicle-005','condition','novo','brand','Toyota','model','Corolla','model_year',2026,'cost',150000,'sale_price',184900,'days',200,'status','em_estoque','store','Matriz'),
    jsonb_build_object('sr','demo-dia-vehicle-006','condition','novo','brand','Hyundai','model','Creta','model_year',2026,'cost',135000,'sale_price',164900,'days',5,'status','em_estoque','store','Filial Norte'),
    jsonb_build_object('sr','demo-dia-vehicle-007','condition','usado','brand','Fiat','model','Argo','model_year',2022,'cost',62000,'sale_price',74900,'days',90,'status','em_estoque','store','Matriz'),
    jsonb_build_object('sr','demo-dia-vehicle-008','condition','usado','brand','Honda','model','Civic','model_year',2020,'cost',98000,'sale_price',119900,'days',160,'status','em_estoque','store','Filial Sul'),
    jsonb_build_object('sr','demo-dia-vehicle-009','condition','usado','brand','Volkswagen','model','Golf','model_year',2019,'cost',75000,'sale_price',92900,'days',240,'status','em_estoque','store','Matriz'),
    jsonb_build_object('sr','demo-dia-vehicle-010','condition','usado','brand','Renault','model','Duster','model_year',2021,'cost',70000,'sale_price',86900,'days',30,'status','em_estoque','store','Filial Norte'),
    jsonb_build_object('sr','demo-dia-vehicle-011','condition','usado','brand','Jeep','model','Renegade','model_year',2021,'cost',92000,'sale_price',112900,'days',55,'status','em_estoque','store','Filial Sul'),
    jsonb_build_object('sr','demo-dia-vehicle-012','condition','usado','brand','Toyota','model','Hilux','model_year',2018,'cost',145000,'sale_price',179900,'days',300,'status','vendido','store','Matriz')
  );
  v_item jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo vehicles, then recreate.
  DELETE FROM entities
  WHERE entity_type = 'vehicle'
    AND source_record_id LIKE 'demo-dia-vehicle-%';

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_vehicles)
  LOOP
    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'vehicle',
      p_source_record_id => v_item ->> 'sr',
      p_data => jsonb_build_object(
        'name', concat_ws(' ', v_item ->> 'brand', v_item ->> 'model', v_item ->> 'model_year'),
        'condition', v_item ->> 'condition',
        'brand', v_item ->> 'brand',
        'model', v_item ->> 'model',
        'model_year', (v_item ->> 'model_year')::int,
        'cost', (v_item ->> 'cost')::numeric,
        'sale_price', (v_item ->> 'sale_price')::numeric,
        'purchase_date', to_char((v_now - ((v_item ->> 'days')::int || ' days')::interval)::date, 'YYYY-MM-DD'),
        'status', v_item ->> 'status',
        'store', v_item ->> 'store',
        'source_record_id', v_item ->> 'sr'
      )
    );
  END LOOP;
END
$$;

commit;
