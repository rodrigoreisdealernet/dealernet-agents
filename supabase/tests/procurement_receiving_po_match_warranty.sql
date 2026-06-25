-- Behavioral tests for procurement receiving, PO matching, and warranty capture
-- (20260613020000_procurement_receiving_po_match_warranty.sql).
--
-- Assertions:
--   0.  Structural: tables, views, and RPCs exist; authenticated has all grants;
--       anon has no table or function access (all 5 RPCs + all 4 tables checked)
--   1.  read_only denied all 5 write RPCs; denied direct INSERT on all 4 tables
--       (full GRANT → RLS write-policy → function role-guard chain)
--   2.  receipts can be recorded with partial receipt handling
--   3.  full receipt closes the PO and receipt status becomes pending_match
--   4.  supplier invoices can be recorded against an issued PO
--   5.  two-way match: matched outcome when qty matches
--   6.  two-way match: discrepancy + hold when qty does not match
--   7.  three-way match: matched when qty + price + total all match
--   8.  three-way match: discrepancy when invoice qty diverges from received
--   9.  discrepancy resolution clears hold_downstream (accepted)
--  10.  escalated resolution keeps hold_downstream=true
--  11.  warranty can be attached to a purchased asset with full metadata
--  12.  warranty is queryable from v_procurement_warranty_records with
--       is_in_warranty computed correctly
--  13.  warranty validation rejects missing required fields
--  14.  receipt cannot be recorded against a draft or cancelled PO
--  15.  supplier invoice cannot be recorded against a draft PO
--  16.  branch_manager role-chain: all five write RPCs allowed end-to-end
--       (authenticated + branch_manager JWT → guard passes → data written)
--  17.  multi-discrepancy isolation: accepting a two-way receipt discrepancy
--       does not prematurely clear the discrepancy_held status on an invoice
--       tied to a separate three-way outcome on the same PO

begin;

do $$
declare
  v_supplier_id       uuid;
  v_branch_id         uuid;
  v_asset_id          uuid;
  v_requisition_id    uuid;
  v_po_id             uuid;
  v_po_id2            uuid;
  v_receipt_id        uuid;
  v_receipt_id2       uuid;
  v_invoice_id        uuid;
  v_match_outcome_id  uuid;
  v_match_outcome_id2 uuid;
  v_warranty_id       uuid;
  v_status            text;
  v_outcome           text;
  v_hold              boolean;
  v_discrepancies     jsonb;
  v_review_resolution text;
  v_caught            bool;
  v_count             int;
  v_is_in_warranty    boolean;
  v_days_remaining    int;
  v_cumulative        numeric;
begin
  -- 0. Structural checks ------------------------------------------------------
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'procurement_receipts'
  ) then
    raise exception 'FAIL 0: procurement_receipts table missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'procurement_supplier_invoices'
  ) then
    raise exception 'FAIL 0: procurement_supplier_invoices table missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'procurement_po_match_outcomes'
  ) then
    raise exception 'FAIL 0: procurement_po_match_outcomes table missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'procurement_warranty_records'
  ) then
    raise exception 'FAIL 0: procurement_warranty_records table missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v' and c.relname = 'v_procurement_receipts'
  ) then
    raise exception 'FAIL 0: v_procurement_receipts view missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v' and c.relname = 'v_procurement_po_match_outcomes'
  ) then
    raise exception 'FAIL 0: v_procurement_po_match_outcomes view missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v' and c.relname = 'v_procurement_warranty_records'
  ) then
    raise exception 'FAIL 0: v_procurement_warranty_records view missing';
  end if;

  if not exists (
    select 1 from public.fact_types where key = 'po_receipt_event'
  ) then
    raise exception 'FAIL 0: po_receipt_event fact type missing';
  end if;

  if not exists (
    select 1 from public.fact_types where key = 'po_match_event'
  ) then
    raise exception 'FAIL 0: po_match_event fact type missing';
  end if;

  if not exists (
    select 1 from public.fact_types where key = 'warranty_event'
  ) then
    raise exception 'FAIL 0: warranty_event fact type missing';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.procurement_record_receipt(uuid,numeric,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: authenticated should have EXECUTE on procurement_record_receipt';
  end if;

  if has_function_privilege(
    'anon',
    'public.procurement_record_receipt(uuid,numeric,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: anon should not have EXECUTE on procurement_record_receipt';
  end if;

  -- Remaining 4 write RPCs: authenticated granted, anon denied.
  if not has_function_privilege(
    'authenticated',
    'public.procurement_record_supplier_invoice(uuid,text,date,numeric,numeric,numeric,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: authenticated should have EXECUTE on procurement_record_supplier_invoice';
  end if;

  if has_function_privilege(
    'anon',
    'public.procurement_record_supplier_invoice(uuid,text,date,numeric,numeric,numeric,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: anon should not have EXECUTE on procurement_record_supplier_invoice';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.procurement_run_po_match(uuid,text,uuid,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: authenticated should have EXECUTE on procurement_run_po_match';
  end if;

  if has_function_privilege(
    'anon',
    'public.procurement_run_po_match(uuid,text,uuid,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: anon should not have EXECUTE on procurement_run_po_match';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.procurement_resolve_match_discrepancy(uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: authenticated should have EXECUTE on procurement_resolve_match_discrepancy';
  end if;

  if has_function_privilege(
    'anon',
    'public.procurement_resolve_match_discrepancy(uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: anon should not have EXECUTE on procurement_resolve_match_discrepancy';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.procurement_attach_warranty(uuid,uuid,uuid,text,text,date,date,text,text,text,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: authenticated should have EXECUTE on procurement_attach_warranty';
  end if;

  if has_function_privilege(
    'anon',
    'public.procurement_attach_warranty(uuid,uuid,uuid,text,text,date,date,text,text,text,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: anon should not have EXECUTE on procurement_attach_warranty';
  end if;

  -- Table grants: authenticated has SELECT on all 4 tables; anon has no access.
  if not has_table_privilege('authenticated', 'public.procurement_receipts', 'SELECT') then
    raise exception 'FAIL 0: authenticated should have SELECT on procurement_receipts';
  end if;
  if has_table_privilege('anon', 'public.procurement_receipts', 'SELECT') then
    raise exception 'FAIL 0: anon should not have SELECT on procurement_receipts';
  end if;
  if has_table_privilege('anon', 'public.procurement_receipts', 'INSERT') then
    raise exception 'FAIL 0: anon should not have INSERT on procurement_receipts';
  end if;

  if not has_table_privilege('authenticated', 'public.procurement_supplier_invoices', 'SELECT') then
    raise exception 'FAIL 0: authenticated should have SELECT on procurement_supplier_invoices';
  end if;
  if has_table_privilege('anon', 'public.procurement_supplier_invoices', 'SELECT') then
    raise exception 'FAIL 0: anon should not have SELECT on procurement_supplier_invoices';
  end if;
  if has_table_privilege('anon', 'public.procurement_supplier_invoices', 'INSERT') then
    raise exception 'FAIL 0: anon should not have INSERT on procurement_supplier_invoices';
  end if;

  if not has_table_privilege('authenticated', 'public.procurement_po_match_outcomes', 'SELECT') then
    raise exception 'FAIL 0: authenticated should have SELECT on procurement_po_match_outcomes';
  end if;
  if has_table_privilege('anon', 'public.procurement_po_match_outcomes', 'SELECT') then
    raise exception 'FAIL 0: anon should not have SELECT on procurement_po_match_outcomes';
  end if;
  if has_table_privilege('anon', 'public.procurement_po_match_outcomes', 'INSERT') then
    raise exception 'FAIL 0: anon should not have INSERT on procurement_po_match_outcomes';
  end if;

  if not has_table_privilege('authenticated', 'public.procurement_warranty_records', 'SELECT') then
    raise exception 'FAIL 0: authenticated should have SELECT on procurement_warranty_records';
  end if;
  if has_table_privilege('anon', 'public.procurement_warranty_records', 'SELECT') then
    raise exception 'FAIL 0: anon should not have SELECT on procurement_warranty_records';
  end if;
  if has_table_privilege('anon', 'public.procurement_warranty_records', 'INSERT') then
    raise exception 'FAIL 0: anon should not have INSERT on procurement_warranty_records';
  end if;

  raise notice 'PASS 0: structural and grant checks passed';

  -- 1. read_only denied all write RPCs and direct table writes ------------------
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000010","app_metadata":{"role":"read_only"}}',
    true
  );

  -- 1a. read_only denied all 5 write RPCs (role guard fires before any business logic).
  v_caught := false;
  begin
    perform public.procurement_record_receipt(gen_random_uuid(), 1);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 1: read_only should be denied procurement_record_receipt';
  end if;

  v_caught := false;
  begin
    perform public.procurement_record_supplier_invoice(
      gen_random_uuid(), 'RO-INV-GUARD', current_date, 1, 100.00
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 1: read_only should be denied procurement_record_supplier_invoice';
  end if;

  v_caught := false;
  begin
    perform public.procurement_run_po_match(gen_random_uuid(), 'two_way');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 1: read_only should be denied procurement_run_po_match';
  end if;

  v_caught := false;
  begin
    perform public.procurement_resolve_match_discrepancy(gen_random_uuid(), 'accepted');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 1: read_only should be denied procurement_resolve_match_discrepancy';
  end if;

  v_caught := false;
  begin
    perform public.procurement_attach_warranty(
      gen_random_uuid(), null, null,
      'WarrantyCo', null, current_date, current_date + 365, 'full', null, null, null
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 1: read_only should be denied procurement_attach_warranty';
  end if;

  -- 1b. read_only denied direct INSERT on all 4 tables (RLS write policy excludes read_only).
  v_caught := false;
  begin
    insert into public.procurement_receipts
      (purchase_order_id, receipt_number, received_quantity)
    values (gen_random_uuid(), 'RO-BLOCK-001', 1);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 1: read_only direct INSERT into procurement_receipts should be denied by RLS';
  end if;

  v_caught := false;
  begin
    insert into public.procurement_supplier_invoices
      (purchase_order_id, invoice_number, invoice_date, invoiced_quantity, invoiced_total)
    values (gen_random_uuid(), 'RO-INV-BLOCK-001', current_date, 1, 100.00);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 1: read_only direct INSERT into procurement_supplier_invoices should be denied by RLS';
  end if;

  v_caught := false;
  begin
    insert into public.procurement_po_match_outcomes
      (purchase_order_id, match_type, outcome)
    values (gen_random_uuid(), 'two_way', 'matched');
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 1: read_only direct INSERT into procurement_po_match_outcomes should be denied by RLS';
  end if;

  v_caught := false;
  begin
    insert into public.procurement_warranty_records
      (entity_id, warranty_provider, warranty_start_date, warranty_end_date)
    values (gen_random_uuid(), 'RO-Prov', current_date, current_date + 365);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 1: read_only direct INSERT into procurement_warranty_records should be denied by RLS';
  end if;

  reset role;
  raise notice 'PASS 1: read_only denied all write RPCs and direct table inserts';

  -- Set up shared test fixtures as admin.
  set local role authenticated;
  perform set_config(
    'request.jwt.claim.role', 'authenticated', true
  );
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000011","app_metadata":{"role":"admin"}}',
    true
  );

  select entity_id into v_branch_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_data => jsonb_build_object('name', 'Receiving Test Branch')
  );

  select entity_id into v_supplier_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'supplier',
    p_data => jsonb_build_object('name', 'Parts Supplier Inc')
  );

  -- Create and issue a PO of 10 units.
  select entity_id into v_requisition_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'requisition',
    p_data => jsonb_build_object(
      'status', 'approved',
      'branch_id', v_branch_id,
      'supplier_id', v_supplier_id,
      'expected_receipt_date', current_date + 5,
      'quantity', 10,
      'item_description', 'Hydraulic filter units'
    )
  );

  select r.purchase_order_id into v_po_id
  from public.procurement_generate_purchase_order(
    p_requisition_id => v_requisition_id,
    p_reason => 'Test PO for receiving'
  ) as r;

  perform public.procurement_transition_purchase_order(
    p_purchase_order_id => v_po_id,
    p_action => 'issue'
  );

  -- 2. Partial receipt --------------------------------------------------------
  select r.receipt_id, r.cumulative_received, r.po_status
    into v_receipt_id, v_cumulative, v_status
  from public.procurement_record_receipt(
    p_purchase_order_id    => v_po_id,
    p_received_quantity    => 4,
    p_delivery_note_number => 'DN-2026-001',
    p_reason               => 'First partial shipment'
  ) as r;

  if v_receipt_id is null then
    raise exception 'FAIL 2: receipt_id should not be null after partial receipt';
  end if;
  if v_cumulative <> 4 then
    raise exception 'FAIL 2: expected cumulative_received=4, got %', v_cumulative;
  end if;
  if v_status <> 'partially_received' then
    raise exception 'FAIL 2: expected PO status=partially_received after partial receipt, got %', coalesce(v_status, '<null>');
  end if;

  select count(*)::int into v_count
  from public.procurement_receipts
  where purchase_order_id = v_po_id;

  if v_count <> 1 then
    raise exception 'FAIL 2: expected 1 receipt row, got %', v_count;
  end if;

  raise notice 'PASS 2: partial receipt recorded, PO is partially_received';

  -- 3. Full receipt closes PO -------------------------------------------------
  select r.receipt_id, r.cumulative_received, r.po_status
    into v_receipt_id2, v_cumulative, v_status
  from public.procurement_record_receipt(
    p_purchase_order_id    => v_po_id,
    p_received_quantity    => 6,
    p_delivery_note_number => 'DN-2026-002',
    p_reason               => 'Second shipment completes order'
  ) as r;

  if v_cumulative <> 10 then
    raise exception 'FAIL 3: expected cumulative_received=10 after full receipt, got %', v_cumulative;
  end if;
  if v_status <> 'closed' then
    raise exception 'FAIL 3: expected PO status=closed after full receipt, got %', coalesce(v_status, '<null>');
  end if;

  select status into v_status
  from public.v_procurement_receipts
  where receipt_id = v_receipt_id;

  if v_status <> 'pending_match' then
    raise exception 'FAIL 3: expected receipt status=pending_match before match run, got %', coalesce(v_status, '<null>');
  end if;

  raise notice 'PASS 3: full receipt closes PO, receipt status is pending_match';

  -- 4. Supplier invoice recording ---------------------------------------------
  select r.invoice_id, r.invoiced_quantity, r.invoiced_total
    into v_invoice_id, v_cumulative, v_days_remaining
  from public.procurement_record_supplier_invoice(
    p_purchase_order_id  => v_po_id,
    p_invoice_number     => 'INV-SUPPLIER-001',
    p_invoice_date       => current_date - 1,
    p_invoiced_quantity  => 10,
    p_invoiced_unit_price => 25.00,
    p_invoiced_total     => 250.00
  ) as r(invoice_id, invoice_number, purchase_order_id, purchase_order_number,
         invoiced_quantity, invoiced_total);

  if v_invoice_id is null then
    raise exception 'FAIL 4: invoice_id should not be null';
  end if;
  if v_cumulative <> 10 then
    raise exception 'FAIL 4: expected invoiced_quantity=10, got %', v_cumulative;
  end if;

  raise notice 'PASS 4: supplier invoice recorded successfully';

  -- 5. Two-way match: matched -------------------------------------------------
  select r.match_outcome_id, r.outcome, r.hold_downstream, r.discrepancy_details
    into v_match_outcome_id, v_outcome, v_hold, v_discrepancies
  from public.procurement_run_po_match(
    p_purchase_order_id => v_po_id,
    p_match_type        => 'two_way'
  ) as r;

  if v_outcome <> 'matched' then
    raise exception 'FAIL 5: expected two-way match outcome=matched, got %', coalesce(v_outcome, '<null>');
  end if;
  if v_hold <> false then
    raise exception 'FAIL 5: expected hold_downstream=false for clean match';
  end if;
  if jsonb_array_length(v_discrepancies) <> 0 then
    raise exception 'FAIL 5: expected no discrepancies for clean match, got %', v_discrepancies;
  end if;

  raise notice 'PASS 5: two-way match produces matched outcome for clean receipt';

  -- 6. Two-way match: discrepancy + hold --------------------------------------
  -- Create a new PO of 8 units, issue it, receive only 5.
  select entity_id into v_requisition_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'requisition',
    p_data => jsonb_build_object(
      'status', 'approved',
      'branch_id', v_branch_id,
      'supplier_id', v_supplier_id,
      'expected_receipt_date', current_date + 3,
      'quantity', 8,
      'item_description', 'Replacement O-rings'
    )
  );

  select r.purchase_order_id into v_po_id2
  from public.procurement_generate_purchase_order(
    p_requisition_id => v_requisition_id,
    p_reason => 'Test PO for discrepancy'
  ) as r;

  perform public.procurement_transition_purchase_order(
    p_purchase_order_id => v_po_id2,
    p_action => 'issue'
  );

  perform public.procurement_record_receipt(
    p_purchase_order_id => v_po_id2,
    p_received_quantity => 5
  );

  select r.outcome, r.hold_downstream, r.discrepancy_details
    into v_outcome, v_hold, v_discrepancies
  from public.procurement_run_po_match(
    p_purchase_order_id => v_po_id2,
    p_match_type        => 'two_way'
  ) as r;

  if v_outcome <> 'discrepancy' then
    raise exception 'FAIL 6: expected two-way match outcome=discrepancy for under-delivery, got %', coalesce(v_outcome, '<null>');
  end if;
  if v_hold <> true then
    raise exception 'FAIL 6: expected hold_downstream=true for discrepancy';
  end if;
  if jsonb_array_length(v_discrepancies) = 0 then
    raise exception 'FAIL 6: expected at least one discrepancy entry';
  end if;
  if (v_discrepancies -> 0 ->> 'variance')::numeric <> 3 then
    raise exception 'FAIL 6: expected quantity variance=3, got %', v_discrepancies -> 0 ->> 'variance';
  end if;

  -- Receipt status should now be discrepancy_held.
  select status into v_status
  from public.procurement_receipts
  where purchase_order_id = v_po_id2
  order by created_at desc
  limit 1;

  if v_status <> 'discrepancy_held' then
    raise exception 'FAIL 6: expected receipt status=discrepancy_held, got %', coalesce(v_status, '<null>');
  end if;

  raise notice 'PASS 6: two-way match surfaces discrepancy and sets hold_downstream=true';

  -- 7. Three-way match: matched -----------------------------------------------
  -- PO1 has 10 received; record invoice exactly matching.
  -- invoice already recorded in step 4 (INV-SUPPLIER-001, qty=10, total=250).
  select r.outcome, r.hold_downstream, r.discrepancy_details
    into v_outcome, v_hold, v_discrepancies
  from public.procurement_run_po_match(
    p_purchase_order_id => v_po_id,
    p_match_type        => 'three_way',
    p_invoice_id        => v_invoice_id
  ) as r;

  if v_outcome <> 'matched' then
    raise exception 'FAIL 7: expected three-way match outcome=matched, got % (discrepancies: %)',
      coalesce(v_outcome, '<null>'), v_discrepancies;
  end if;
  if v_hold <> false then
    raise exception 'FAIL 7: expected hold_downstream=false for clean three-way match';
  end if;

  raise notice 'PASS 7: three-way match: matched when qty aligns';

  -- 8. Three-way match: discrepancy when invoice qty diverges -----------------
  -- Record a supplier invoice with mismatched quantity for PO2.
  select r.invoice_id into v_invoice_id
  from public.procurement_record_supplier_invoice(
    p_purchase_order_id  => v_po_id2,
    p_invoice_number     => 'INV-SUPPLIER-002',
    p_invoice_date       => current_date,
    p_invoiced_quantity  => 8,
    p_invoiced_total     => 160.00
  ) as r(invoice_id, invoice_number, purchase_order_id, purchase_order_number,
         invoiced_quantity, invoiced_total);

  select r.outcome, r.hold_downstream, r.discrepancy_details
    into v_outcome, v_hold, v_discrepancies
  from public.procurement_run_po_match(
    p_purchase_order_id => v_po_id2,
    p_match_type        => 'three_way',
    p_invoice_id        => v_invoice_id
  ) as r;

  if v_outcome <> 'discrepancy' then
    raise exception 'FAIL 8: expected three-way outcome=discrepancy for qty mismatch, got %', coalesce(v_outcome, '<null>');
  end if;
  if v_hold <> true then
    raise exception 'FAIL 8: expected hold_downstream=true for three-way discrepancy';
  end if;

  raise notice 'PASS 8: three-way match surfaces invoice qty discrepancy';

  -- 9. Discrepancy resolution: accepted clears hold ---------------------------
  select r.id into v_match_outcome_id
  from public.procurement_po_match_outcomes r
  where r.purchase_order_id = v_po_id2
    and r.outcome = 'discrepancy'
    and r.match_type = 'two_way'
  order by r.created_at
  limit 1;

  select r.hold_downstream, r.review_resolution
    into v_hold, v_review_resolution
  from public.procurement_resolve_match_discrepancy(
    p_match_outcome_id => v_match_outcome_id,
    p_resolution       => 'accepted',
    p_review_notes     => 'Supplier confirmed partial delivery, accepted'
  ) as r;

  if v_hold <> false then
    raise exception 'FAIL 9: expected hold_downstream=false after accepted resolution';
  end if;
  if v_review_resolution <> 'accepted' then
    raise exception 'FAIL 9: expected review_resolution=accepted, got %', coalesce(v_review_resolution, '<null>');
  end if;

  -- Receipt status should now be discrepancy_resolved.
  select status into v_status
  from public.procurement_receipts
  where purchase_order_id = v_po_id2
  order by created_at desc
  limit 1;

  if v_status <> 'discrepancy_resolved' then
    raise exception 'FAIL 9: expected receipt status=discrepancy_resolved after accepted resolution, got %', coalesce(v_status, '<null>');
  end if;

  raise notice 'PASS 9: accepted resolution clears hold_downstream and updates receipt status';

  -- 10. Escalated resolution keeps hold_downstream ----------------------------
  select r.id into v_match_outcome_id
  from public.procurement_po_match_outcomes r
  where r.purchase_order_id = v_po_id2
    and r.outcome = 'discrepancy'
    and r.match_type = 'three_way'
  order by r.created_at
  limit 1;

  select r.hold_downstream, r.review_resolution
    into v_hold, v_review_resolution
  from public.procurement_resolve_match_discrepancy(
    p_match_outcome_id => v_match_outcome_id,
    p_resolution       => 'escalated',
    p_review_notes     => 'Needs finance approval before clearing'
  ) as r;

  if v_hold <> true then
    raise exception 'FAIL 10: expected hold_downstream=true after escalated resolution';
  end if;
  if v_review_resolution <> 'escalated' then
    raise exception 'FAIL 10: expected review_resolution=escalated, got %', coalesce(v_review_resolution, '<null>');
  end if;

  raise notice 'PASS 10: escalated resolution keeps hold_downstream=true';

  -- 11. Warranty attached to a purchased asset --------------------------------
  select entity_id into v_asset_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_data => jsonb_build_object(
      'name', 'Hydraulic Pump Unit A',
      'status', 'available'
    )
  );

  select r.warranty_record_id, r.warranty_type, r.is_in_warranty
    into v_warranty_id, v_status, v_is_in_warranty
  from public.procurement_attach_warranty(
    p_entity_id           => v_asset_id,
    p_purchase_order_id   => v_po_id,
    p_receipt_id          => v_receipt_id,
    p_warranty_provider   => 'Parts Supplier Inc',
    p_serial_number       => 'SN-HPU-20260613',
    p_warranty_start_date => current_date,
    p_warranty_end_date   => current_date + 730,
    p_warranty_type       => 'full',
    p_warranty_terms      => '2-year full parts and labor',
    p_warranty_document_ref => 'https://docs.example.com/warranty/HPU-001'
  ) as r;

  if v_warranty_id is null then
    raise exception 'FAIL 11: warranty_record_id should not be null';
  end if;
  if v_status <> 'full' then
    raise exception 'FAIL 11: expected warranty_type=full, got %', coalesce(v_status, '<null>');
  end if;
  if v_is_in_warranty <> true then
    raise exception 'FAIL 11: expected is_in_warranty=true for future end date';
  end if;

  raise notice 'PASS 11: warranty attached to asset with full metadata';

  -- 12. Warranty queryable from v_procurement_warranty_records ----------------
  select w.is_in_warranty, (w.days_remaining)::int
    into v_is_in_warranty, v_days_remaining
  from public.v_procurement_warranty_records w
  where w.warranty_record_id = v_warranty_id;

  if v_is_in_warranty <> true then
    raise exception 'FAIL 12: v_procurement_warranty_records should show is_in_warranty=true';
  end if;
  if v_days_remaining < 729 then
    raise exception 'FAIL 12: days_remaining should be >= 729, got %', v_days_remaining;
  end if;

  select w.entity_name, w.purchase_order_number
    into v_status, v_outcome
  from public.v_procurement_warranty_records w
  where w.warranty_record_id = v_warranty_id;

  if v_status <> 'Hydraulic Pump Unit A' then
    raise exception 'FAIL 12: entity_name mismatch, got %', coalesce(v_status, '<null>');
  end if;
  if v_outcome is null or v_outcome not like 'PO-%' then
    raise exception 'FAIL 12: purchase_order_number should be present, got %', coalesce(v_outcome, '<null>');
  end if;

  -- Warranty audit event should exist in time_series_points.
  select count(*)::int into v_count
  from public.time_series_points tsp
  join public.fact_types ft on ft.id = tsp.fact_type_id
  where tsp.entity_id = v_asset_id
    and ft.key = 'warranty_event';

  if v_count <> 1 then
    raise exception 'FAIL 12: expected 1 warranty_event TSP, got %', v_count;
  end if;

  raise notice 'PASS 12: warranty record queryable from view with computed is_in_warranty';

  -- 13. Warranty validation rejects missing required fields -------------------
  v_caught := false;
  begin
    perform public.procurement_attach_warranty(
      p_entity_id         => v_asset_id,
      p_warranty_provider => null,
      p_warranty_start_date => current_date,
      p_warranty_end_date => current_date + 365
    );
  exception
    when sqlstate '22023' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 13: should reject null warranty_provider';
  end if;

  v_caught := false;
  begin
    perform public.procurement_attach_warranty(
      p_entity_id         => v_asset_id,
      p_warranty_provider => 'WarrantyCo',
      p_warranty_start_date => current_date + 10,
      p_warranty_end_date => current_date
    );
  exception
    when sqlstate '22023' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 13: should reject end_date < start_date';
  end if;

  raise notice 'PASS 13: warranty validation rejects missing/invalid required fields';

  -- 14. Receipt denied against draft or cancelled PO --------------------------
  select entity_id into v_requisition_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'requisition',
    p_data => jsonb_build_object(
      'status', 'approved',
      'branch_id', v_branch_id,
      'supplier_id', v_supplier_id,
      'expected_receipt_date', current_date + 2,
      'quantity', 3,
      'item_description', 'Draft PO test item'
    )
  );

  select r.purchase_order_id into v_po_id
  from public.procurement_generate_purchase_order(
    p_requisition_id => v_requisition_id,
    p_reason => 'Testing draft receipt rejection'
  ) as r;

  -- Draft PO should reject receipt.
  v_caught := false;
  begin
    perform public.procurement_record_receipt(
      p_purchase_order_id => v_po_id,
      p_received_quantity => 1
    );
  exception
    when sqlstate '22023' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 14: should reject receipt against draft PO';
  end if;

  -- Issue then cancel the PO and confirm receipt is rejected.
  perform public.procurement_transition_purchase_order(
    p_purchase_order_id => v_po_id, p_action => 'issue'
  );
  perform public.procurement_transition_purchase_order(
    p_purchase_order_id => v_po_id,
    p_action => 'cancel',
    p_reason => 'Cancelled for test'
  );

  v_caught := false;
  begin
    perform public.procurement_record_receipt(
      p_purchase_order_id => v_po_id,
      p_received_quantity => 1
    );
  exception
    when sqlstate '22023' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 14: should reject receipt against cancelled PO';
  end if;

  raise notice 'PASS 14: receipt correctly rejected for draft and cancelled POs';

  -- 15. Invoice denied against draft PO ---------------------------------------
  select entity_id into v_requisition_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'requisition',
    p_data => jsonb_build_object(
      'status', 'approved',
      'branch_id', v_branch_id,
      'supplier_id', v_supplier_id,
      'expected_receipt_date', current_date + 2,
      'quantity', 2,
      'item_description', 'Draft invoice test item'
    )
  );

  select r.purchase_order_id into v_po_id
  from public.procurement_generate_purchase_order(
    p_requisition_id => v_requisition_id,
    p_reason => 'Testing draft invoice rejection'
  ) as r;

  v_caught := false;
  begin
    perform public.procurement_record_supplier_invoice(
      p_purchase_order_id => v_po_id,
      p_invoice_number    => 'INV-DRAFT-001',
      p_invoice_date      => current_date,
      p_invoiced_quantity => 2,
      p_invoiced_total    => 50.00
    );
  exception
    when sqlstate '22023' then v_caught := true;
  end;
  if not v_caught then
    raise exception 'FAIL 15: should reject invoice against draft PO';
  end if;

  raise notice 'PASS 15: invoice correctly rejected for draft PO';

  -- 16. branch_manager role-chain allow paths ----------------------------------
  -- Create a fresh issued PO as admin, then exercise all five write RPCs as
  -- branch_manager to prove the authenticated + branch_manager JWT chain is
  -- permitted end-to-end.
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000011","app_metadata":{"role":"admin"}}',
    true
  );

  select entity_id into v_requisition_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'requisition',
    p_data => jsonb_build_object(
      'status', 'approved',
      'branch_id', v_branch_id,
      'supplier_id', v_supplier_id,
      'expected_receipt_date', current_date + 5,
      'quantity', 4,
      'item_description', 'Branch manager role-chain test items'
    )
  );

  select r.purchase_order_id into v_po_id
  from public.procurement_generate_purchase_order(
    p_requisition_id => v_requisition_id,
    p_reason => 'Branch manager allow-path test'
  ) as r;

  perform public.procurement_transition_purchase_order(
    p_purchase_order_id => v_po_id,
    p_action => 'issue'
  );

  -- Switch to branch_manager for all allow-path assertions.
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000020","app_metadata":{"role":"branch_manager"}}',
    true
  );

  -- 16a. branch_manager can record a partial receipt.
  select r.receipt_id into v_receipt_id
  from public.procurement_record_receipt(
    p_purchase_order_id    => v_po_id,
    p_received_quantity    => 2,
    p_delivery_note_number => 'DN-BM-001',
    p_reason               => 'Branch manager receiving test'
  ) as r;

  if v_receipt_id is null then
    raise exception 'FAIL 16: branch_manager should be allowed procurement_record_receipt';
  end if;

  -- 16b. branch_manager can record a supplier invoice.
  select r.invoice_id into v_invoice_id
  from public.procurement_record_supplier_invoice(
    p_purchase_order_id   => v_po_id,
    p_invoice_number      => 'INV-BM-001',
    p_invoice_date        => current_date,
    p_invoiced_quantity   => 4,
    p_invoiced_unit_price => 30.00,
    p_invoiced_total      => 120.00
  ) as r(invoice_id, invoice_number, purchase_order_id, purchase_order_number,
         invoiced_quantity, invoiced_total);

  if v_invoice_id is null then
    raise exception 'FAIL 16: branch_manager should be allowed procurement_record_supplier_invoice';
  end if;

  -- 16c. branch_manager can run a two-way PO match (2 received vs 4 ordered → discrepancy).
  select r.match_outcome_id, r.outcome, r.hold_downstream
    into v_match_outcome_id, v_outcome, v_hold
  from public.procurement_run_po_match(
    p_purchase_order_id => v_po_id,
    p_match_type        => 'two_way'
  ) as r;

  if v_match_outcome_id is null then
    raise exception 'FAIL 16: branch_manager should be allowed procurement_run_po_match';
  end if;
  if v_outcome <> 'discrepancy' then
    raise exception 'FAIL 16: expected discrepancy outcome for partial receipt (qty 2 vs 4), got %', coalesce(v_outcome, '<null>');
  end if;

  -- 16d. branch_manager can resolve a match discrepancy.
  select r.hold_downstream, r.review_resolution
    into v_hold, v_review_resolution
  from public.procurement_resolve_match_discrepancy(
    p_match_outcome_id => v_match_outcome_id,
    p_resolution       => 'accepted',
    p_review_notes     => 'Branch manager accepted partial delivery'
  ) as r;

  if v_review_resolution <> 'accepted' then
    raise exception 'FAIL 16: branch_manager should be allowed procurement_resolve_match_discrepancy (got %)',
      coalesce(v_review_resolution, '<null>');
  end if;
  if v_hold <> false then
    raise exception 'FAIL 16: expected hold_downstream=false after accepted resolution by branch_manager';
  end if;

  -- 16e. branch_manager can attach a warranty.
  select r.warranty_record_id into v_warranty_id
  from public.procurement_attach_warranty(
    p_entity_id           => v_asset_id,
    p_purchase_order_id   => v_po_id,
    p_receipt_id          => v_receipt_id,
    p_warranty_provider   => 'BM Warranty Co',
    p_warranty_start_date => current_date,
    p_warranty_end_date   => current_date + 365,
    p_warranty_type       => 'extended'
  ) as r;

  if v_warranty_id is null then
    raise exception 'FAIL 16: branch_manager should be allowed procurement_attach_warranty';
  end if;

  reset role;
  raise notice 'PASS 16: branch_manager role-chain allows all five write RPCs';

  -- 17. Multi-discrepancy isolation: accepting one outcome cannot clear another ---
  -- Create PO5 (5 units ordered), receive 3, record an invoice for 5.  This
  -- produces two independent discrepancy outcomes on the same PO:
  --   Outcome X (two-way):  ordered(5) vs received(3) → quantity variance
  --   Outcome Y (three-way): invoiced(5) vs received(3) → quantity variance
  -- Accepting outcome X must clear the receipt but leave the invoice held.
  -- Only after also accepting outcome Y is the invoice cleared.

  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000011","app_metadata":{"role":"admin"}}',
    true
  );

  select entity_id into v_requisition_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'requisition',
    p_data => jsonb_build_object(
      'status', 'approved',
      'branch_id', v_branch_id,
      'supplier_id', v_supplier_id,
      'expected_receipt_date', current_date + 5,
      'quantity', 5,
      'item_description', 'Multi-discrepancy isolation test items'
    )
  );

  select r.purchase_order_id into v_po_id
  from public.procurement_generate_purchase_order(
    p_requisition_id => v_requisition_id,
    p_reason => 'Multi-discrepancy isolation test'
  ) as r;

  perform public.procurement_transition_purchase_order(
    p_purchase_order_id => v_po_id,
    p_action => 'issue'
  );

  -- Record partial receipt: 3 of 5 ordered.
  select r.receipt_id into v_receipt_id
  from public.procurement_record_receipt(
    p_purchase_order_id    => v_po_id,
    p_received_quantity    => 3,
    p_delivery_note_number => 'DN-MULTI-001',
    p_reason               => 'Partial receipt for isolation test'
  ) as r;

  -- Record invoice for the full 5 (will diverge from 3 received).
  select r.invoice_id into v_invoice_id
  from public.procurement_record_supplier_invoice(
    p_purchase_order_id   => v_po_id,
    p_invoice_number      => 'INV-MULTI-001',
    p_invoice_date        => current_date,
    p_invoiced_quantity   => 5,
    p_invoiced_unit_price => 20.00,
    p_invoiced_total      => 100.00
  ) as r(invoice_id, invoice_number, purchase_order_id, purchase_order_number,
         invoiced_quantity, invoiced_total);

  -- Outcome X: two-way match → receipt discrepancy (5 ordered vs 3 received).
  select r.match_outcome_id into v_match_outcome_id
  from public.procurement_run_po_match(
    p_purchase_order_id => v_po_id,
    p_match_type        => 'two_way'
  ) as r;

  if v_match_outcome_id is null then
    raise exception 'FAIL 17: two-way match_outcome_id should not be null';
  end if;

  -- Outcome Y: three-way match → invoice discrepancy (5 invoiced vs 3 received).
  select r.match_outcome_id into v_match_outcome_id2
  from public.procurement_run_po_match(
    p_purchase_order_id => v_po_id,
    p_match_type        => 'three_way',
    p_invoice_id        => v_invoice_id
  ) as r;

  if v_match_outcome_id2 is null then
    raise exception 'FAIL 17: three-way match_outcome_id should not be null';
  end if;

  -- Both outcomes should be holding downstream.
  select hold_downstream into v_hold
  from public.procurement_po_match_outcomes
  where id = v_match_outcome_id;
  if v_hold <> true then
    raise exception 'FAIL 17: two-way outcome should have hold_downstream=true';
  end if;

  select hold_downstream into v_hold
  from public.procurement_po_match_outcomes
  where id = v_match_outcome_id2;
  if v_hold <> true then
    raise exception 'FAIL 17: three-way outcome should have hold_downstream=true';
  end if;

  -- Invoice should be in discrepancy_held.
  select status into v_status
  from public.procurement_supplier_invoices
  where id = v_invoice_id;
  if v_status <> 'discrepancy_held' then
    raise exception 'FAIL 17: invoice should be discrepancy_held before any resolution, got %', coalesce(v_status, '<null>');
  end if;

  -- Accept outcome X (two-way receipt discrepancy).
  perform public.procurement_resolve_match_discrepancy(
    p_match_outcome_id => v_match_outcome_id,
    p_resolution       => 'accepted',
    p_review_notes     => 'Partial delivery accepted'
  );

  -- Receipt should now be cleared.
  select status into v_status
  from public.procurement_receipts
  where id = v_receipt_id;
  if v_status <> 'discrepancy_resolved' then
    raise exception 'FAIL 17: receipt should be discrepancy_resolved after accepting two-way outcome, got %', coalesce(v_status, '<null>');
  end if;

  -- Invoice must still be discrepancy_held — outcome Y (three-way) is unresolved.
  select status into v_status
  from public.procurement_supplier_invoices
  where id = v_invoice_id;
  if v_status <> 'discrepancy_held' then
    raise exception 'FAIL 17: invoice must remain discrepancy_held after accepting unrelated two-way outcome, got %', coalesce(v_status, '<null>');
  end if;

  -- Outcome Y must still be holding downstream — resolving outcome X must not
  -- have cleared outcome Y's hold flag.
  select hold_downstream into v_hold
  from public.procurement_po_match_outcomes
  where id = v_match_outcome_id2;
  if v_hold <> true then
    raise exception 'FAIL 17: outcome Y (three-way) must still have hold_downstream=true after accepting outcome X, got %', v_hold;
  end if;

  -- Now accept outcome Y (three-way invoice discrepancy); invoice can be cleared.
  perform public.procurement_resolve_match_discrepancy(
    p_match_outcome_id => v_match_outcome_id2,
    p_resolution       => 'accepted',
    p_review_notes     => 'Invoice discrepancy accepted'
  );

  select status into v_status
  from public.procurement_supplier_invoices
  where id = v_invoice_id;
  if v_status <> 'discrepancy_resolved' then
    raise exception 'FAIL 17: invoice should be discrepancy_resolved after accepting three-way outcome, got %', coalesce(v_status, '<null>');
  end if;

  reset role;
  raise notice 'PASS 17: multi-discrepancy isolation — accepting two-way outcome does not clear invoice held by a separate three-way outcome';
end;
$$;

rollback;
