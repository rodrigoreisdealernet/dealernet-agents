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
  -- (Removed) CRM payment-issue seed — the CRM domain was pruned from the DIA core
  -- schema (see migration 20260625120000_dia_core_prune_wynne_domain.sql).
  -- ---------------------------------------------------------------------------

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
  v_retired_schema_keys text[] := ARRAY[
    'revrec_finding_v1',
    'fleet_finding_v1',
    'credit_proposal_v1',
    'account_health_thread_v1',
    'territory_brief_item_v1'
  ];
  v_retired_agent_keys text[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT retired.key), ARRAY[]::text[])
  INTO v_retired_agent_keys
  FROM (
    SELECT agent_key AS key
    FROM ops_agent_config
    WHERE output_schema_key = ANY(v_retired_schema_keys)

    UNION

    SELECT ev.data ->> 'agent_key' AS key
    FROM entities e
    JOIN entity_versions ev ON ev.entity_id = e.id
    WHERE e.entity_type = 'agent_config'
      AND ev.data ->> 'output_schema_key' = ANY(v_retired_schema_keys)
  ) retired
  WHERE retired.key IS NOT NULL;

  DELETE FROM finding
  WHERE agent_key = ANY(v_retired_agent_keys)
     OR run_id IN (
       SELECT run_id
       FROM ops_workflow_run
       WHERE workflow_key = ANY(v_retired_agent_keys)
     );

  DELETE FROM ops_workflow_run
  WHERE workflow_key = ANY(v_retired_agent_keys);

  DELETE FROM ops_agent_config
  WHERE agent_key = ANY(v_retired_agent_keys)
     OR output_schema_key = ANY(v_retired_schema_keys);

  DELETE FROM entities e
  WHERE e.entity_type = 'agent_config'
    AND EXISTS (
      SELECT 1
      FROM entity_versions ev
      WHERE ev.entity_id = e.id
        AND (
          ev.data ->> 'agent_key' = ANY(v_retired_agent_keys)
          OR ev.data ->> 'output_schema_key' = ANY(v_retired_schema_keys)
        )
    );

  DELETE FROM ops_output_schema_registry
  WHERE schema_key = ANY(v_retired_schema_keys);

  INSERT INTO tenants (tenant_key, name)
  VALUES
    ('demo-ops-a', 'Demo Ops Tenant A'),
    ('demo-ops-b', 'Demo Ops Tenant B')
  ON CONFLICT (tenant_key) DO UPDATE
    SET name = EXCLUDED.name;
END;
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — RESET / zera banco (issue #46)
-- Apaga TODOS os registros dos tipos DIA antes de repopular, para um dataset
-- limpo (remove inclusive sobras não-demo que inflavam as contagens das views).
-- O tipo 'company' é COMPARTILHADO com o domínio rental, então aqui só
-- removemos as empresas do namespace DIA (demo-dia-company-%) — o baseline
-- rental/demo-baseline (empresas, contratos, tokens de portal) é preservado.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Tipos exclusivos do domínio DIA: apaga tudo (demo e não-demo).
  DELETE FROM entities
  WHERE entity_type IN ('vehicle', 'brand', 'part', 'part_sale', 'service_order');

  -- 'company' é compartilhado com rental: remove apenas o namespace DIA.
  DELETE FROM entities
  WHERE entity_type = 'company'
    AND source_record_id LIKE 'demo-dia-company-%';
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — demo vehicles (issue #4, ampliado #46)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-vehicle-%'.
-- ~120 veículos GERADOS POR LOJA (8 lojas, 15 cada) para concentrar os dados:
-- cada veículo herda a 'brand' e o 'store' da sua loja (marca consistente com a
-- loja, alinhado às 4 marcas / 8 lojas do bloco de empresas abaixo). Cobre
-- condition novo/usado, status em_estoque/vendido e days_in_stock de 0 a ~420
-- (variando floor_plan_cost). Reuses rental_upsert_entity_current_state.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_now timestamptz := now();
  -- store/brand alinhados às 4 marcas e 8 lojas (2 por marca). cost_base reflete
  -- o segmento (motos baratas, caminhões caros) e cada loja tem seus modelos.
  -- A geração (days_in_stock 0..~420) inclui veículos em_estoque na faixa 75-90d
  -- e acima de 90d, cobrindo o que o Vehicle Stock-Aging Analyst (#32) precisa.
  v_lojas jsonb := jsonb_build_array(
    jsonb_build_object('store','Fiat São Paulo','brand','Fiat','cost_base',85000,'models',jsonb_build_array('Pulse','Argo','Mobi','Cronos','Toro','Strada')),
    jsonb_build_object('store','Fiat Campinas','brand','Fiat','cost_base',82000,'models',jsonb_build_array('Pulse','Argo','Mobi','Cronos','Fastback','Fiorino')),
    jsonb_build_object('store','Volkswagen Porto Alegre','brand','Volkswagen','cost_base',95000,'models',jsonb_build_array('Polo','Nivus','T-Cross','Virtus','Golf','Saveiro')),
    jsonb_build_object('store','Volkswagen Curitiba','brand','Volkswagen','cost_base',98000,'models',jsonb_build_array('Polo','Nivus','T-Cross','Virtus','Taos','Amarok')),
    jsonb_build_object('store','Volvo Caminhões Manaus','brand','Volvo','cost_base',420000,'models',jsonb_build_array('FH 460','VM 270','FH 540','VM 220')),
    jsonb_build_object('store','Volvo Caminhões Brasília','brand','Volvo','cost_base',460000,'models',jsonb_build_array('FH 460','VM 270','FH 540','FMX 500')),
    jsonb_build_object('store','Honda Motos Belo Horizonte','brand','Honda','cost_base',18000,'models',jsonb_build_array('CG 160','Biz 125','CB 500','XRE 300','PCX 160')),
    jsonb_build_object('store','Honda Motos Salvador','brand','Honda','cost_base',16000,'models',jsonb_build_array('CG 160','Biz 125','CB 300','XRE 190','Pop 110'))
  );
  v_loja jsonb;
  v_models jsonb;
  v_nmodels int;
  v_seq int := 0;
  k int;
  v_cond text;
  v_status text;
  v_cost numeric;
  v_model text;
  v_days int;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo vehicles, then recreate.
  DELETE FROM entities
  WHERE entity_type = 'vehicle'
    AND source_record_id LIKE 'demo-dia-vehicle-%';

  FOR v_loja IN SELECT * FROM jsonb_array_elements(v_lojas)
  LOOP
    v_models  := v_loja -> 'models';
    v_nmodels := jsonb_array_length(v_models);

    FOR k IN 1..15 LOOP
      v_seq    := v_seq + 1;
      v_cond   := CASE WHEN k % 2 = 0 THEN 'novo' ELSE 'usado' END;
      v_status := CASE WHEN k % 7 = 0 THEN 'vendido' ELSE 'em_estoque' END;
      v_model  := v_models ->> (k % v_nmodels);
      v_days   := (k * 29) % 420;
      v_cost   := (v_loja ->> 'cost_base')::numeric
                  + ((k % 8) * ((v_loja ->> 'cost_base')::numeric * 0.05));

      PERFORM rental_upsert_entity_current_state(
        p_entity_type => 'vehicle',
        p_source_record_id => format('demo-dia-vehicle-%s', lpad(v_seq::text, 3, '0')),
        p_data => jsonb_build_object(
          'name', concat_ws(' ', v_loja ->> 'brand', v_model, (2018 + (k % 9))::text),
          'condition', v_cond,
          'brand', v_loja ->> 'brand',
          'model', v_model,
          'model_year', CASE WHEN v_cond = 'novo' THEN 2026 ELSE 2018 + (k % 8) END,
          'cost', round(v_cost, 2),
          'sale_price', round(v_cost * 1.18, -2),
          'purchase_date', to_char((v_now - (v_days || ' days')::interval)::date, 'YYYY-MM-DD'),
          'status', v_status,
          'store', v_loja ->> 'store',
          'source_record_id', format('demo-dia-vehicle-%s', lpad(v_seq::text, 3, '0'))
        )
      );
    END LOOP;
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- Vehicle Stock-Aging Analyst agent config (issue #32)
-- Seeds `vehicle-aging-analyst` for demo-ops-a and demo-ops-b in BOTH the
-- entity store (entity_type='agent_config'; read by ops_agent_config_current →
-- ops_load_agent_config and by the worker schedule reconcile) and the base
-- `ops_agent_config` table (parity). enabled=true but schedule.enabled=false so
-- the recurring run stays off by default. The output schema registry row is
-- owned by migration 20260626140001_vehicle_aging_agent.sql (applied first).
-- Idempotent via ON CONFLICT upserts; tenants come from the main ops seed above.
-- ===========================================================================
DO $$
DECLARE
  v_agent_key   text  := 'vehicle-aging-analyst';
  v_schema_key  text  := 'vehicle_aging_finding_v1';
  v_model       jsonb := '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb;
  v_system_prompt text := 'You are the Vehicle Stock-Aging Analyst for a vehicle dealership. Rank in-stock vehicles approaching the 90-day floor-plan exposure line for tenant {tenant_id}. Recommend a reviewable next action (monitor, markdown, transfer, prioritize_sale, wholesale_auction) using days in stock, floor-plan cost, store, and pricing. Never apply markdowns, transfers, or sales automatically; surface evidence and keep uncertainty explicit.';
  v_user_prompt text := 'Assess vehicle {vehicle_id} ({brand} {model} {model_year}) at store {store} for tenant {tenant_id}. Days in stock: {days_in_stock}. Aging bucket: {aging_bucket}. Floor-plan cost: {floor_plan_cost}. Cost: {cost}. Sale price: {sale_price}. Recommend the next human-approved action with supporting evidence. Evidence:\n{evidence_json}';
  v_tools       jsonb := '[]'::jsonb;
  v_thresholds  jsonb := '{"aging_warning_days":75,"aging_breach_days":90}'::jsonb;
  v_bounds      jsonb := '{"max_findings_per_run":50,"max_tool_rounds":2}'::jsonb;
  v_schedule    jsonb := '{"cron":"0 6 * * 1-5","enabled":false}'::jsonb;
  v_tenant_keys text[] := ARRAY['demo-ops-a','demo-ops-b'];
  v_tenant_key  text;
  v_tenant_id   uuid;
  v_entity_id   uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  FOREACH v_tenant_key IN ARRAY v_tenant_keys
  LOOP
    SELECT id INTO v_tenant_id FROM tenants WHERE tenant_key = v_tenant_key;
    IF v_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Vehicle aging seed requires tenant % (run the main ops seed first)', v_tenant_key;
    END IF;

    -- Idempotent reset: drop any prior current version first. The SCD2 BEFORE
    -- INSERT trigger forbids ON CONFLICT from re-updating an existing current
    -- version in the same command, so a clean delete (cascading to versions)
    -- keeps a re-applied seed replay-safe.
    DELETE FROM entities
    WHERE entity_type = 'agent_config'
      AND source_record_id = format('demo-ops-agent-config:%s:%s', v_tenant_id, v_agent_key);

    -- Canonical config in the entity store (read by ops_agent_config_current).
    INSERT INTO entities (entity_type, source_record_id)
    VALUES ('agent_config', format('demo-ops-agent-config:%s:%s', v_tenant_id, v_agent_key))
    ON CONFLICT (entity_type, source_record_id) DO UPDATE
      SET source_record_id = EXCLUDED.source_record_id
    RETURNING id INTO v_entity_id;

    INSERT INTO entity_versions (entity_id, version_number, data)
    VALUES (
      v_entity_id,
      1,
      jsonb_build_object(
        'tenant_id', v_tenant_id,
        'agent_key', v_agent_key,
        'enabled', true,
        'model', v_model,
        'system_prompt', v_system_prompt,
        'user_prompt_template', v_user_prompt,
        'tools', v_tools,
        'output_schema_key', v_schema_key,
        'thresholds', v_thresholds,
        'bounds', v_bounds,
        'schedule', v_schedule,
        'auto_apply', false
      )
    )
    ON CONFLICT (entity_id, version_number) DO UPDATE
      SET data = EXCLUDED.data,
          is_current = true,
          valid_to = NULL;

    -- Base-table parity row.
    INSERT INTO ops_agent_config (
      tenant_id, agent_key, enabled, model,
      system_prompt, user_prompt_template,
      tools, output_schema_key, thresholds, bounds, schedule, auto_apply
    )
    VALUES (
      v_tenant_id, v_agent_key, true, v_model,
      v_system_prompt, v_user_prompt,
      v_tools, v_schema_key, v_thresholds, v_bounds, v_schedule, false
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
  END LOOP;
END
$$;

-- ===========================================================================
-- DIA dealership domain — demo companies + brands (issue #5)
-- Idempotent namespaces: source_record_id LIKE 'demo-dia-company-%' / '-brand-%'.
-- Does NOT touch the pre-existing demo-baseline-company-* entries.
-- Reuses rental_upsert_entity_current_state (the generic SCD2 upsert) under the
-- service_role write guard.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  -- 4 marcas distintas cobrindo os 3 segmentos (automoveis x2 + caminhoes + motos).
  v_brands jsonb := jsonb_build_array(
    jsonb_build_object('sr','demo-dia-brand-1','name','Fiat','segment','automoveis','status','ativo'),
    jsonb_build_object('sr','demo-dia-brand-2','name','Volkswagen','segment','automoveis','status','ativo'),
    jsonb_build_object('sr','demo-dia-brand-3','name','Volvo','segment','caminhoes','status','ativo'),
    jsonb_build_object('sr','demo-dia-brand-4','name','Honda','segment','motos','status','ativo')
  );
  -- 8 lojas divididas entre as 4 marcas (2 por marca) para CONCENTRAR os dados.
  -- O trade_name de cada loja é reutilizado no campo 'store' dos veículos, então
  -- os veículos agrupam por loja/marca. Uma loja fica inativa (filtro de status).
  v_companies jsonb := jsonb_build_array(
    jsonb_build_object('sr','demo-dia-company-1','brand_sr','demo-dia-brand-1','legal_name','DIA Fiat São Paulo Ltda','trade_name','Fiat São Paulo','cnpj','12.345.678/0001-90','city','São Paulo','state','SP','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-2','brand_sr','demo-dia-brand-1','legal_name','DIA Fiat Campinas Ltda','trade_name','Fiat Campinas','cnpj','12.345.678/0002-71','city','Campinas','state','SP','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-3','brand_sr','demo-dia-brand-2','legal_name','DIA VW Porto Alegre Ltda','trade_name','Volkswagen Porto Alegre','cnpj','12.345.678/0003-52','city','Porto Alegre','state','RS','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-4','brand_sr','demo-dia-brand-2','legal_name','DIA VW Curitiba Ltda','trade_name','Volkswagen Curitiba','cnpj','12.345.678/0004-33','city','Curitiba','state','PR','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-5','brand_sr','demo-dia-brand-3','legal_name','DIA Volvo Manaus Ltda','trade_name','Volvo Caminhões Manaus','cnpj','12.345.678/0005-14','city','Manaus','state','AM','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-6','brand_sr','demo-dia-brand-3','legal_name','DIA Volvo Brasília Ltda','trade_name','Volvo Caminhões Brasília','cnpj','12.345.678/0006-04','city','Brasília','state','DF','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-7','brand_sr','demo-dia-brand-4','legal_name','DIA Honda BH Ltda','trade_name','Honda Motos Belo Horizonte','cnpj','12.345.678/0007-87','city','Belo Horizonte','state','MG','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-8','brand_sr','demo-dia-brand-4','legal_name','DIA Honda Salvador Ltda','trade_name','Honda Motos Salvador','cnpj','12.345.678/0008-68','city','Salvador','state','BA','status','inativo')
  );
  v_item jsonb;
  v_brand_id uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo companies/brands, then recreate.
  DELETE FROM entities
  WHERE entity_type = 'company'
    AND source_record_id LIKE 'demo-dia-company-%';

  DELETE FROM entities
  WHERE entity_type = 'brand'
    AND source_record_id LIKE 'demo-dia-brand-%';

  -- Brands first so companies can resolve their brand_id.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_brands)
  LOOP
    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'brand',
      p_source_record_id => v_item ->> 'sr',
      p_data => jsonb_build_object(
        'name', v_item ->> 'name',
        'segment', v_item ->> 'segment',
        'status', v_item ->> 'status',
        'source_record_id', v_item ->> 'sr'
      )
    );
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_companies)
  LOOP
    -- Resolve the brand entity_id from its demo source_record_id.
    SELECT id INTO v_brand_id
    FROM entities
    WHERE entity_type = 'brand'
      AND source_record_id = v_item ->> 'brand_sr';

    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'company',
      p_source_record_id => v_item ->> 'sr',
      p_data => jsonb_build_object(
        'name', v_item ->> 'trade_name',
        'legal_name', v_item ->> 'legal_name',
        'trade_name', v_item ->> 'trade_name',
        'cnpj', v_item ->> 'cnpj',
        'city', v_item ->> 'city',
        'state', v_item ->> 'state',
        'status', v_item ->> 'status',
        'brand_id', v_brand_id::text,
        'source_record_id', v_item ->> 'sr'
      )
    );
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — demo service orders / Oficina (issue #7)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-service-%'.
-- Orders across all statuses, todas abertas DENTRO do mês corrente (conceito
-- MÊS ATUAL do Morning Brief, #46 — clamp no 1º dia do mês).
-- At least 2 'concluida' with closed_at set so turnaround_hours populates.
-- Reuses rental_upsert_entity_current_state (the generic SCD2 upsert) under
-- the service_role write guard.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_now timestamptz := now();
  -- open_days = days ago the order was opened; turn_h = hours to close (null = open).
  v_orders jsonb := jsonb_build_array(
    jsonb_build_object('sr','demo-dia-service-001','order_number','OS-2026-001','customer','Maria Souza','vehicle','BRA2E19','description','Revisão de 10.000 km','status','concluida','open_days',55,'turn_h',6,'revenue',850.00,'technician','Carlos'),
    jsonb_build_object('sr','demo-dia-service-002','order_number','OS-2026-002','customer','João Lima','vehicle','RIO3F45','description','Troca de pastilhas de freio','status','concluida','open_days',40,'turn_h',3,'revenue',520.00,'technician','Ana'),
    jsonb_build_object('sr','demo-dia-service-003','order_number','OS-2026-003','customer','Pedro Alves','vehicle','SAO7G88','description','Alinhamento e balanceamento','status','concluida','open_days',20,'turn_h',2,'revenue',280.00,'technician','Carlos'),
    jsonb_build_object('sr','demo-dia-service-004','order_number','OS-2026-004','customer','Lucas Reis','vehicle','BHZ1H22','description','Diagnóstico eletrônico','status','em_andamento','open_days',5,'turn_h',null,'revenue',150.00,'technician','Ana'),
    jsonb_build_object('sr','demo-dia-service-005','order_number','OS-2026-005','customer','Fernanda Dias','vehicle','POA9J33','description','Troca de óleo e filtros','status','em_andamento','open_days',3,'turn_h',null,'revenue',420.00,'technician','Bruno'),
    jsonb_build_object('sr','demo-dia-service-006','order_number','OS-2026-006','customer','Roberto Nunes','vehicle','CWB4K11','description','Reparo do ar-condicionado','status','aberta','open_days',2,'turn_h',null,'revenue',null,'technician',null),
    jsonb_build_object('sr','demo-dia-service-007','order_number','OS-2026-007','customer','Camila Rocha','vehicle','REC6L77','description','Substituição de embreagem','status','aberta','open_days',1,'turn_h',null,'revenue',null,'technician','Bruno'),
    jsonb_build_object('sr','demo-dia-service-008','order_number','OS-2026-008','customer','Tiago Melo','vehicle','SSA2M55','description','Revisão geral pré-viagem','status','aberta','open_days',0,'turn_h',null,'revenue',null,'technician',null),
    jsonb_build_object('sr','demo-dia-service-009','order_number','OS-2026-009','customer','Juliana Castro','vehicle','FOR8N99','description','Troca de bateria','status','em_andamento','open_days',7,'turn_h',null,'revenue',680.00,'technician','Carlos'),
    jsonb_build_object('sr','demo-dia-service-010','order_number','OS-2026-010','customer','Marcelo Pinto','vehicle','VIX5P44','description','Reparo na suspensão','status','aberta','open_days',1,'turn_h',null,'revenue',null,'technician','Ana'),
    -- concluídas adicionais (turnaround variado)
    jsonb_build_object('sr','demo-dia-service-011','order_number','OS-2026-011','customer','Beatriz Gomes','vehicle','CGR1Q66','description','Revisão de 20.000 km','status','concluida','open_days',48,'turn_h',8,'revenue',1120.00,'technician','Bruno'),
    jsonb_build_object('sr','demo-dia-service-012','order_number','OS-2026-012','customer','Rafael Teixeira','vehicle','NAT3R12','description','Troca de correia dentada','status','concluida','open_days',33,'turn_h',12,'revenue',1450.00,'technician','Carlos'),
    jsonb_build_object('sr','demo-dia-service-013','order_number','OS-2026-013','customer','Patrícia Moraes','vehicle','MCZ8S21','description','Reparo de embreagem','status','concluida','open_days',15,'turn_h',5,'revenue',980.00,'technician','Ana'),
    -- em andamento adicionais
    jsonb_build_object('sr','demo-dia-service-014','order_number','OS-2026-014','customer','Gustavo Barros','vehicle','BSB6T34','description','Funilaria e pintura','status','em_andamento','open_days',9,'turn_h',null,'revenue',2300.00,'technician','Bruno'),
    jsonb_build_object('sr','demo-dia-service-015','order_number','OS-2026-015','customer','Sandra Lopes','vehicle','GYN2U55','description','Diagnóstico de ruído na suspensão','status','em_andamento','open_days',4,'turn_h',null,'revenue',null,'technician','Carlos'),
    -- abertas adicionais
    jsonb_build_object('sr','demo-dia-service-016','order_number','OS-2026-016','customer','Eduardo Pires','vehicle','THE9V77','description','Troca de fluido de freio','status','aberta','open_days',0,'turn_h',null,'revenue',null,'technician',null),
    -- canceladas (validam o status cancelada na view)
    jsonb_build_object('sr','demo-dia-service-017','order_number','OS-2026-017','customer','Vanessa Cardoso','vehicle','SLZ4W88','description','Orçamento de motor recusado pelo cliente','status','cancelada','open_days',12,'turn_h',null,'revenue',null,'technician','Ana'),
    jsonb_build_object('sr','demo-dia-service-018','order_number','OS-2026-018','customer','Henrique Dantas','vehicle','PMW7X99','description','Serviço cancelado — peça indisponível','status','cancelada','open_days',6,'turn_h',null,'revenue',null,'technician','Bruno')
  );
  v_item jsonb;
  v_opened timestamptz;
  v_data jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo service orders, then recreate.
  DELETE FROM entities
  WHERE entity_type = 'service_order'
    AND source_record_id LIKE 'demo-dia-service-%';

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_orders)
  LOOP
    -- Conceito MÊS ATUAL (#46): toda OS é aberta DENTRO do mês corrente. Mantém
    -- 'open_days' como dias-atrás, mas trava no 1º dia do mês (clamp) para não
    -- vazar para o mês anterior.
    v_opened := greatest(
      date_trunc('month', now()),
      v_now - ((v_item ->> 'open_days')::int || ' days')::interval
    );

    v_data := jsonb_build_object(
      'name', concat_ws(' - ', v_item ->> 'order_number', v_item ->> 'customer'),
      'order_number', v_item ->> 'order_number',
      'customer', v_item ->> 'customer',
      'vehicle', v_item ->> 'vehicle',
      'description', v_item ->> 'description',
      'status', v_item ->> 'status',
      'opened_at', to_char(v_opened, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'technician', v_item ->> 'technician',
      'source_record_id', v_item ->> 'sr'
    );

    IF nullif(v_item ->> 'revenue', '') IS NOT NULL THEN
      v_data := v_data || jsonb_build_object('revenue', (v_item ->> 'revenue')::numeric);
    END IF;

    IF nullif(v_item ->> 'turn_h', '') IS NOT NULL THEN
      v_data := v_data || jsonb_build_object(
        'closed_at',
        to_char(v_opened + ((v_item ->> 'turn_h')::int || ' hours')::interval, 'YYYY-MM-DD"T"HH24:MI:SSOF')
      );
    END IF;

    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'service_order',
      p_source_record_id => v_item ->> 'sr',
      p_data => v_data
    );
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — demo parts (issue #8)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-part-%'.
-- 15 parts covering every stock_status (zerado/critico/baixo/ok) so both
-- v_dia_part_current and v_dia_parts_critical have representative rows.
-- Reuses rental_upsert_entity_current_state (the generic SCD2 upsert) under
-- the service_role write guard.
-- stock_status precedence (assumes min_stock <= reorder_point):
--   zerado qty=0 > critico qty<=min_stock > baixo qty<=reorder_point > ok
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_parts jsonb := jsonb_build_array(
    -- part_number, description, manufacturer, unit_cost, unit_price, qty, min_stock, reorder_point, location, status -> expected stock_status
    -- ok (qty > reorder_point)
    jsonb_build_object('sr','demo-dia-part-001','part_number','FLT-OIL-001','description','Filtro de óleo motor 1.0','manufacturer','Tecfil','unit_cost',18.50,'unit_price',39.90,'qty',120,'min_stock',10,'reorder_point',30,'location','A1-03','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-002','part_number','FLT-AIR-002','description','Filtro de ar condicionado','manufacturer','Mann','unit_cost',32.00,'unit_price',74.90,'qty',80,'min_stock',8,'reorder_point',25,'location','A1-04','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-003','part_number','BRK-PAD-003','description','Pastilha de freio dianteira','manufacturer','Bosch','unit_cost',95.00,'unit_price',189.90,'qty',60,'min_stock',6,'reorder_point',20,'location','B2-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-004','part_number','SPK-PLG-004','description','Vela de ignição iridium','manufacturer','NGK','unit_cost',28.00,'unit_price',59.90,'qty',200,'min_stock',20,'reorder_point',50,'location','B2-02','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-005','part_number','WPR-BLD-005','description','Palheta limpador 24"','manufacturer','Bosch','unit_cost',22.00,'unit_price',49.90,'qty',45,'min_stock',5,'reorder_point',15,'location','C3-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-006','part_number','BAT-12V-006','description','Bateria 60Ah','manufacturer','Moura','unit_cost',280.00,'unit_price',459.90,'qty',18,'min_stock',3,'reorder_point',8,'location','D4-01','status','ativo'),
    -- baixo (qty <= reorder_point, > min_stock)
    jsonb_build_object('sr','demo-dia-part-007','part_number','FLT-FUEL-007','description','Filtro de combustível','manufacturer','Tecfil','unit_cost',24.00,'unit_price',54.90,'qty',12,'min_stock',5,'reorder_point',15,'location','A1-05','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-008','part_number','BLT-ALT-008','description','Correia do alternador','manufacturer','Gates','unit_cost',45.00,'unit_price',98.90,'qty',9,'min_stock',4,'reorder_point',12,'location','C3-02','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-009','part_number','LMP-H4-009','description','Lâmpada farol H4','manufacturer','Philips','unit_cost',15.00,'unit_price',34.90,'qty',20,'min_stock',8,'reorder_point',25,'location','C3-03','status','ativo'),
    -- critico (qty <= min_stock, > 0)
    jsonb_build_object('sr','demo-dia-part-010','part_number','BRK-DSC-010','description','Disco de freio ventilado','manufacturer','Fremax','unit_cost',140.00,'unit_price',279.90,'qty',3,'min_stock',4,'reorder_point',10,'location','B2-03','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-011','part_number','SHK-ABS-011','description','Amortecedor dianteiro','manufacturer','Cofap','unit_cost',210.00,'unit_price',389.90,'qty',2,'min_stock',3,'reorder_point',8,'location','D4-02','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-012','part_number','CLT-KIT-012','description','Kit de embreagem','manufacturer','LuK','unit_cost',420.00,'unit_price',749.90,'qty',1,'min_stock',2,'reorder_point',6,'location','D4-03','status','ativo'),
    -- zerado (qty = 0)
    jsonb_build_object('sr','demo-dia-part-013','part_number','RAD-CLN-013','description','Radiador de arrefecimento','manufacturer','Valeo','unit_cost',360.00,'unit_price',629.90,'qty',0,'min_stock',2,'reorder_point',5,'location','D4-04','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-014','part_number','TBL-FRT-014','description','Bieleta dianteira','manufacturer','Nakata','unit_cost',38.00,'unit_price',84.90,'qty',0,'min_stock',5,'reorder_point',12,'location','C3-04','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-015','part_number','SNR-O2-015','description','Sensor de oxigênio (sonda lambda)','manufacturer','Bosch','unit_cost',180.00,'unit_price',329.90,'qty',0,'min_stock',3,'reorder_point',7,'location','D4-05','status','ativo'),
    -- ok adicionais (qty > reorder_point)
    jsonb_build_object('sr','demo-dia-part-016','part_number','OIL-5W30-016','description','Óleo motor sintético 5W30 1L','manufacturer','Mobil','unit_cost',38.00,'unit_price',74.90,'qty',300,'min_stock',30,'reorder_point',80,'location','A2-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-017','part_number','FLT-CAB-017','description','Filtro de cabine antipólen','manufacturer','Mann','unit_cost',26.00,'unit_price',58.90,'qty',95,'min_stock',10,'reorder_point',30,'location','A2-02','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-018','part_number','FLU-BRK-018','description','Fluido de freio DOT4 500ml','manufacturer','Bosch','unit_cost',19.00,'unit_price',42.90,'qty',150,'min_stock',15,'reorder_point',40,'location','A2-03','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-019','part_number','TER-CLN-019','description','Aditivo de radiador 1L','manufacturer','Paraflu','unit_cost',21.00,'unit_price',45.90,'qty',110,'min_stock',12,'reorder_point',35,'location','A2-04','status','ativo'),
    -- baixo (qty <= reorder_point, > min_stock)
    jsonb_build_object('sr','demo-dia-part-020','part_number','BLT-DST-020','description','Correia dentada','manufacturer','Gates','unit_cost',82.00,'unit_price',169.90,'qty',14,'min_stock',5,'reorder_point',16,'location','C4-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-021','part_number','JNT-CAB-021','description','Junta do cabeçote','manufacturer','Sabó','unit_cost',120.00,'unit_price',239.90,'qty',10,'min_stock',4,'reorder_point',12,'location','C4-02','status','ativo'),
    -- critico (qty <= min_stock, > 0)
    jsonb_build_object('sr','demo-dia-part-022','part_number','BMB-WTR-022','description','Bomba d''água','manufacturer','Schadek','unit_cost',155.00,'unit_price',299.90,'qty',2,'min_stock',3,'reorder_point',8,'location','D5-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-023','part_number','TRM-STT-023','description','Válvula termostática','manufacturer','Wahler','unit_cost',58.00,'unit_price',119.90,'qty',1,'min_stock',2,'reorder_point',6,'location','D5-02','status','ativo'),
    -- zerado (qty = 0)
    jsonb_build_object('sr','demo-dia-part-024','part_number','CMP-AC-024','description','Compressor de ar-condicionado','manufacturer','Denso','unit_cost',780.00,'unit_price',1399.90,'qty',0,'min_stock',2,'reorder_point',5,'location','D5-03','status','ativo'),
    -- inativo (não some da view; status inativo para validar filtro)
    jsonb_build_object('sr','demo-dia-part-025','part_number','OLD-CRB-025','description','Carburador (linha descontinuada)','manufacturer','Weber','unit_cost',0,'unit_price',0,'qty',0,'min_stock',0,'reorder_point',0,'location','X9-99','status','inativo'),
    jsonb_build_object('sr','demo-dia-part-026','part_number','FLT-OIL-026','description','Filtro de óleo motor 2.0','manufacturer','Tecfil','unit_cost',24.00,'unit_price',49.90,'qty',75,'min_stock',8,'reorder_point',25,'location','A2-05','status','ativo')
  );
  v_item jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo parts, then recreate.
  DELETE FROM entities
  WHERE entity_type = 'part'
    AND source_record_id LIKE 'demo-dia-part-%';

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_parts)
  LOOP
    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'part',
      p_source_record_id => v_item ->> 'sr',
      p_data => jsonb_build_object(
        'name', concat_ws(' ', v_item ->> 'part_number', v_item ->> 'description'),
        'part_number', v_item ->> 'part_number',
        'description', v_item ->> 'description',
        'manufacturer', v_item ->> 'manufacturer',
        'unit_cost', (v_item ->> 'unit_cost')::numeric,
        'unit_price', (v_item ->> 'unit_price')::numeric,
        'quantity_in_stock', (v_item ->> 'qty')::numeric,
        'min_stock', (v_item ->> 'min_stock')::numeric,
        'reorder_point', (v_item ->> 'reorder_point')::numeric,
        'location', v_item ->> 'location',
        'status', v_item ->> 'status',
        'source_record_id', v_item ->> 'sr'
      )
    );
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — demo part sales (issue #10)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-part-sale-%'.
-- ~12 sales referencing the demo parts (demo-dia-part-NNN). Created via the
-- atomic RPC create_part_sale so the stock decrement is applied consistently:
-- the parts block above re-seeds parts from scratch each run, so re-running the
-- whole seed restores stock to its baseline and then applies these sales once
-- (no double-decrement). The prior DELETE drops cancelled history too.
-- Quantities are chosen so a few parts reach critico/zerado after the sales:
--   part-006 (qty 18, min 3) sell 15 -> 3  = critico
--   part-007 (qty 12, min 5) sell 8  -> 4  = critico
--   part-010 (qty 3,  min 4) sell 3  -> 0  = zerado
--   part-012 (qty 1,  min 2) sell 1  -> 0  = zerado
--   part-008 (qty 9,  min 4, reorder 12) sell 6 -> 3 = critico
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_sales jsonb := jsonb_build_array(
    -- sr, part_sr, qty, unit_price, discount, customer, salesperson, month_offset, day
    jsonb_build_object('sr','demo-dia-part-sale-001','part_sr','demo-dia-part-001','qty',20,'unit_price',39.90,'discount',0,'customer','Auto Center Vitória','salesperson','Marina Souza','mo',-1,'day',5),
    jsonb_build_object('sr','demo-dia-part-sale-002','part_sr','demo-dia-part-002','qty',10,'unit_price',74.90,'discount',5.00,'customer','Oficina do Zé','salesperson','Carlos Lima','mo',-1,'day',9),
    jsonb_build_object('sr','demo-dia-part-sale-003','part_sr','demo-dia-part-003','qty',8,'unit_price',189.90,'discount',0,'customer','Frota Rápida Ltda','salesperson','Marina Souza','mo',-1,'day',14),
    jsonb_build_object('sr','demo-dia-part-sale-004','part_sr','demo-dia-part-004','qty',30,'unit_price',59.90,'discount',20.00,'customer','Mecânica Central','salesperson','João Pedro','mo',-1,'day',20),
    jsonb_build_object('sr','demo-dia-part-sale-005','part_sr','demo-dia-part-005','qty',6,'unit_price',49.90,'discount',0,'customer','Cliente Balcão','salesperson','Carlos Lima','mo',-1,'day',24),
    jsonb_build_object('sr','demo-dia-part-sale-006','part_sr','demo-dia-part-006','qty',15,'unit_price',459.90,'discount',50.00,'customer','TransLog Transportes','salesperson','Marina Souza','mo',0,'day',2),
    jsonb_build_object('sr','demo-dia-part-sale-007','part_sr','demo-dia-part-007','qty',8,'unit_price',54.90,'discount',0,'customer','Oficina do Zé','salesperson','João Pedro','mo',0,'day',4),
    jsonb_build_object('sr','demo-dia-part-sale-008','part_sr','demo-dia-part-008','qty',6,'unit_price',98.90,'discount',0,'customer','Auto Center Vitória','salesperson','Carlos Lima','mo',0,'day',6),
    jsonb_build_object('sr','demo-dia-part-sale-009','part_sr','demo-dia-part-009','qty',5,'unit_price',34.90,'discount',0,'customer','Cliente Balcão','salesperson','Marina Souza','mo',0,'day',8),
    jsonb_build_object('sr','demo-dia-part-sale-010','part_sr','demo-dia-part-010','qty',3,'unit_price',279.90,'discount',0,'customer','Frota Rápida Ltda','salesperson','João Pedro','mo',0,'day',10),
    jsonb_build_object('sr','demo-dia-part-sale-011','part_sr','demo-dia-part-012','qty',1,'unit_price',749.90,'discount',30.00,'customer','Mecânica Central','salesperson','Carlos Lima','mo',0,'day',12,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-012','part_sr','demo-dia-part-004','qty',12,'unit_price',59.90,'discount',0,'customer','Cliente Balcão','salesperson','Marina Souza','mo',0,'day',14,'cancel',false),
    -- vendas adicionais referenciando peças com estoque suficiente
    jsonb_build_object('sr','demo-dia-part-sale-013','part_sr','demo-dia-part-016','qty',40,'unit_price',74.90,'discount',0,'customer','Auto Center Vitória','salesperson','Marina Souza','mo',-1,'day',7,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-014','part_sr','demo-dia-part-017','qty',20,'unit_price',58.90,'discount',10.00,'customer','Oficina do Zé','salesperson','João Pedro','mo',-1,'day',18,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-015','part_sr','demo-dia-part-018','qty',25,'unit_price',42.90,'discount',0,'customer','Mecânica Central','salesperson','Carlos Lima','mo',0,'day',3,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-016','part_sr','demo-dia-part-020','qty',2,'unit_price',169.90,'discount',0,'customer','Frota Rápida Ltda','salesperson','Marina Souza','mo',0,'day',5,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-017','part_sr','demo-dia-part-026','qty',10,'unit_price',49.90,'discount',5.00,'customer','Cliente Balcão','salesperson','João Pedro','mo',0,'day',9,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-018','part_sr','demo-dia-part-001','qty',15,'unit_price',39.90,'discount',0,'customer','TransLog Transportes','salesperson','Carlos Lima','mo',0,'day',11,'cancel',false),
    -- vendas canceladas (exercitam cancel_part_sale + estorno de estoque; somem da view)
    jsonb_build_object('sr','demo-dia-part-sale-019','part_sr','demo-dia-part-019','qty',8,'unit_price',45.90,'discount',0,'customer','Auto Center Vitória','salesperson','Marina Souza','mo',0,'day',13,'cancel',true),
    jsonb_build_object('sr','demo-dia-part-sale-020','part_sr','demo-dia-part-003','qty',4,'unit_price',189.90,'discount',0,'customer','Oficina do Zé','salesperson','Carlos Lima','mo',0,'day',15,'cancel',true)
  );
  v_item jsonb;
  v_part_id uuid;
  v_sale_id uuid;
  v_sale_date text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo sales (parts are re-seeded above, so stock is
  -- back to baseline before these sales re-apply their decrements).
  DELETE FROM entities
  WHERE entity_type = 'part_sale'
    AND source_record_id LIKE 'demo-dia-part-sale-%';

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_sales)
  LOOP
    SELECT id INTO v_part_id
    FROM entities
    WHERE entity_type = 'part'
      AND source_record_id = v_item ->> 'part_sr';

    IF v_part_id IS NULL THEN
      CONTINUE;
    END IF;

    -- Conceito MÊS ATUAL (#46): ignora o offset de mês ('mo') e ancora a venda no
    -- mês corrente (dia 'day'), travando em hoje para não gerar data futura.
    v_sale_date := to_char(
      least(
        (date_trunc('month', now()) + (((v_item ->> 'day')::int - 1) || ' days')::interval)::date,
        now()::date
      ),
      'YYYY-MM-DD'
    );

    SELECT entity_id INTO v_sale_id
    FROM create_part_sale(
      jsonb_build_object(
        'part_id', v_part_id::text,
        'quantity', (v_item ->> 'qty')::numeric,
        'unit_price', (v_item ->> 'unit_price')::numeric,
        'discount', (v_item ->> 'discount')::numeric,
        'sale_date', v_sale_date,
        'customer', v_item ->> 'customer',
        'salesperson', v_item ->> 'salesperson',
        'channel', 'balcao',
        'source_record_id', v_item ->> 'sr'
      )
    );

    -- Sales flagged cancel: exercise cancel_part_sale (restocks the part; the
    -- cancelled sale is filtered out of v_dia_part_sale_current).
    IF (v_item ->> 'cancel')::boolean THEN
      PERFORM cancel_part_sale(v_sale_id);
    END IF;
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — VOLUME EM MASSA (issue #46)
-- Os blocos acima criam um conjunto CURADO que garante a cobertura de todas as
-- situações distintas (stock_status, status de OS, vendas canceladas, etc.).
-- Os blocos abaixo geram VOLUME ADICIONAL via generate_series para deixar o
-- banco bem mais populado, sem comprometer a coerência:
--   * peças em massa nascem com estoque amplo ('ok');
--   * vendas em massa só referenciam essas peças com quantidades pequenas, então
--     nunca disparam o guard de estoque insuficiente.
-- Namespaces dedicados (sufixo '-bNNN') para não colidir com o conjunto curado.
-- ===========================================================================

-- (As marcas/empresas e os veículos NÃO têm bloco "em massa": as 4 marcas, as
--  8 lojas e os ~120 veículos por loja já são criados nos blocos curados acima.
--  Aqui em baixo geram-se apenas OS, peças e vendas em massa.)

-- --- Ordens de serviço em massa (~82) -------------------------------------
begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_now timestamptz := now();
  v_statuses text[] := ARRAY['aberta','em_andamento','concluida','cancelada'];
  v_descs    text[] := ARRAY['Revisão programada','Troca de óleo','Reparo de freios','Diagnóstico eletrônico','Alinhamento e balanceamento','Troca de embreagem','Reparo de suspensão','Funilaria e pintura','Troca de bateria','Reparo do ar-condicionado'];
  v_techs    text[] := ARRAY['Carlos','Ana','Bruno','Diego','Eduardo',null];
  v_custs    text[] := ARRAY['Cliente A','Cliente B','Cliente C','Cliente D','Cliente E','Cliente F','Cliente G','Cliente H'];
  i int;
  v_status text;
  v_opened timestamptz;
  v_data jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  FOR i IN 1..82 LOOP
    v_status := v_statuses[1 + (i % 4)];
    -- MÊS ATUAL (#46): abre dentro do mês corrente (clamp no 1º dia do mês).
    v_opened := greatest(
      date_trunc('month', now()),
      v_now - (((i * 3) % 28) || ' days')::interval
    );

    v_data := jsonb_build_object(
      'name', format('OS-2026-B%s - %s', lpad(i::text, 3, '0'), v_custs[1 + (i % array_length(v_custs, 1))]),
      'order_number', format('OS-2026-B%s', lpad(i::text, 3, '0')),
      'customer', v_custs[1 + (i % array_length(v_custs, 1))],
      'vehicle', format('%s%s%s%s', chr(65 + (i % 26)), chr(65 + ((i * 2) % 26)), chr(65 + ((i * 3) % 26)), lpad((i % 10000)::text, 4, '0')),
      'description', v_descs[1 + (i % array_length(v_descs, 1))],
      'status', v_status,
      'opened_at', to_char(v_opened, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'technician', v_techs[1 + (i % array_length(v_techs, 1))],
      'source_record_id', format('demo-dia-service-b%s', lpad(i::text, 3, '0'))
    );

    -- Concluídas ganham closed_at (turnaround) e receita; em_andamento receita parcial.
    IF v_status = 'concluida' THEN
      v_data := v_data || jsonb_build_object(
        'closed_at', to_char(v_opened + (((i % 12) + 2) || ' hours')::interval, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
        'revenue', 200 + ((i % 20) * 95)
      );
    ELSIF v_status = 'em_andamento' AND i % 2 = 0 THEN
      v_data := v_data || jsonb_build_object('revenue', 150 + ((i % 15) * 70));
    END IF;

    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'service_order',
      p_source_record_id => format('demo-dia-service-b%s', lpad(i::text, 3, '0')),
      p_data => v_data
    );
  END LOOP;
END
$$;

commit;

-- --- Peças em massa (~74, estoque amplo -> 'ok') --------------------------
begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_mfrs  text[] := ARRAY['Bosch','Tecfil','Mann','NGK','Gates','Cofap','Nakata','Philips','Valeo','Denso','Mobil','LuK'];
  v_descs text[] := ARRAY['Filtro de óleo','Filtro de ar','Pastilha de freio','Vela de ignição','Correia','Amortecedor','Bieleta','Lâmpada','Sensor','Rolamento','Junta','Bomba'];
  i int;
  v_cost numeric;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  FOR i IN 1..74 LOOP
    v_cost := 12 + ((i % 30) * 11);

    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'part',
      p_source_record_id => format('demo-dia-part-b%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format('BULK-%s %s', lpad(i::text, 4, '0'), v_descs[1 + (i % array_length(v_descs, 1))]),
        'part_number', format('BULK-%s', lpad(i::text, 4, '0')),
        'description', format('%s (linha %s)', v_descs[1 + (i % array_length(v_descs, 1))], 1 + (i % 5)),
        'manufacturer', v_mfrs[1 + (i % array_length(v_mfrs, 1))],
        'unit_cost', v_cost,
        'unit_price', round(v_cost * 2.1, 2),
        -- estoque sempre >> reorder_point => stock_status 'ok'
        'quantity_in_stock', 120 + ((i % 12) * 40),
        'min_stock', 10,
        'reorder_point', 30,
        'location', format('%s%s-%s', chr(65 + (i % 6)), 1 + (i % 9), lpad((i % 99)::text, 2, '0')),
        'status', 'ativo',
        'source_record_id', format('demo-dia-part-b%s', lpad(i::text, 3, '0'))
      )
    );
  END LOOP;
END
$$;

commit;

-- --- Vendas em massa (~88, só contra as peças em massa de estoque amplo) ---
begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_custs text[] := ARRAY['Auto Center Vitória','Oficina do Zé','Frota Rápida Ltda','Mecânica Central','Cliente Balcão','TransLog Transportes','Garagem Premium','Oficina Bairro'];
  v_sellers text[] := ARRAY['Marina Souza','Carlos Lima','João Pedro','Aline Costa','Rafael Dias'];
  i int;
  v_part_id uuid;
  v_part_sr text;
  v_unit_price numeric;
  v_sale_date text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  FOR i IN 1..88 LOOP
    -- referencia peças em massa (1..74), cada uma com estoque amplo
    v_part_sr := format('demo-dia-part-b%s', lpad((1 + ((i - 1) % 74))::text, 3, '0'));

    SELECT id INTO v_part_id
    FROM entities
    WHERE entity_type = 'part' AND source_record_id = v_part_sr;

    CONTINUE WHEN v_part_id IS NULL;

    SELECT unit_price INTO v_unit_price
    FROM v_dia_part_current WHERE entity_id = v_part_id;

    -- MÊS ATUAL (#46): todas as vendas no mês corrente (sem recuar meses),
    -- travadas em hoje para não gerar data futura.
    v_sale_date := to_char(
      least(
        (date_trunc('month', now()) + (((i * 7) % 27) || ' days')::interval)::date,
        now()::date
      ),
      'YYYY-MM-DD'
    );

    PERFORM create_part_sale(
      jsonb_build_object(
        'part_id', v_part_id::text,
        'quantity', 1 + (i % 5),                 -- 1..5, << estoque (>=120)
        'unit_price', coalesce(v_unit_price, 49.90),
        'discount', CASE WHEN i % 4 = 0 THEN round((i % 30)::numeric, 2) ELSE 0 END,
        'sale_date', v_sale_date,
        'customer', v_custs[1 + (i % array_length(v_custs, 1))],
        'salesperson', v_sellers[1 + (i % array_length(v_sellers, 1))],
        'channel', 'balcao',
        'source_record_id', format('demo-dia-part-sale-b%s', lpad(i::text, 3, '0'))
      )
    );
  END LOOP;
END
$$;

commit;
