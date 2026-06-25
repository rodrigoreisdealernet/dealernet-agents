-- Behavioral tests for procurement purchase-order lifecycle
-- (20260612195000_procurement_purchase_order_lifecycle.sql).
--
-- Assertions:
--   0.  Structural: procurement RPCs and view exist with expected grants
--   1.  read_only authenticated callers are denied generate/transition RPCs
--   2.  admin can generate a draft purchase order from an approved requisition
--   3.  issuing transitions the purchase order to open
--   4.  receipt tracking projects partially_received then closed status
--   5.  amendment requires a reason, increments amendment_count, and updates
--       expected receipt
--   6.  cancellation requires a reason and persists the latest reason
--   7.  requisition current state is projected with purchase_order references
--       and lifecycle updates
--   8.  time_series_points captures lifecycle audit events

begin;

do $$
declare
  v_supplier_id uuid;
  v_branch_id uuid;
  v_requisition_id uuid;
  v_purchase_order_id uuid;
  v_purchase_order_number text;
  v_status text;
  v_amendment_count int;
  v_expected_receipt date;
  v_supplier_name text;
  v_branch_name text;
  v_reason text;
  v_received_quantity numeric;
  v_event_count int;
  v_caught bool;
begin
  -- 0. Structural checks ------------------------------------------------------
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'procurement_generate_purchase_order'
      and pg_catalog.pg_get_function_identity_arguments(p.oid)
          = 'p_requisition_id uuid, p_reason text'
  ) then
    raise exception 'FAIL 0: procurement_generate_purchase_order(uuid, text) missing';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'procurement_transition_purchase_order'
      and pg_catalog.pg_get_function_identity_arguments(p.oid)
          = 'p_purchase_order_id uuid, p_action text, p_reason text, p_expected_receipt_date date, p_received_quantity numeric, p_ordered_quantity numeric'
  ) then
    raise exception 'FAIL 0: procurement_transition_purchase_order(...) missing';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and c.relname = 'v_procurement_purchase_orders'
  ) then
    raise exception 'FAIL 0: v_procurement_purchase_orders missing';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.procurement_generate_purchase_order(uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: authenticated should have EXECUTE on generate RPC';
  end if;

  if has_function_privilege(
    'anon',
    'public.procurement_generate_purchase_order(uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL 0: anon should not have EXECUTE on generate RPC';
  end if;

  raise notice 'PASS 0: structural and grant checks passed';

  -- 1. read_only denied -------------------------------------------------------
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000010","app_metadata":{"role":"read_only"}}',
    true
  );

  v_caught := false;
  begin
    perform public.procurement_generate_purchase_order(gen_random_uuid(), null);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
  end;

  if not v_caught then
    raise exception 'FAIL 1: read_only caller should be denied generate RPC';
  end if;

  reset role;
  raise notice 'PASS 1: read_only caller denied generate RPC';

  -- 2. admin generates a draft PO from an approved requisition ----------------
  set local role authenticated;
  perform set_config(
    'request.jwt.claim.role',
    'authenticated',
    true
  );
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000011","app_metadata":{"role":"admin"}}',
    true
  );

  select entity_id into v_branch_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_data => jsonb_build_object('name', 'Procurement Test Branch')
  );

  select entity_id into v_supplier_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'supplier',
    p_data => jsonb_build_object('name', 'Acme Supply Co')
  );

  select entity_id into v_requisition_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'requisition',
    p_data => jsonb_build_object(
      'status', 'approved',
      'branch_id', v_branch_id,
      'supplier_id', v_supplier_id,
      'expected_receipt_date', (current_date + 7),
      'quantity', 8,
      'item_description', 'Hydraulic hose assemblies'
    )
  );

  select r.purchase_order_id, r.purchase_order_number, r.status
    into v_purchase_order_id, v_purchase_order_number, v_status
  from public.procurement_generate_purchase_order(
    p_requisition_id => v_requisition_id,
    p_reason => 'Approved by buyer'
  ) as r;

  if v_purchase_order_id is null or v_purchase_order_number not like 'PO-%' then
    raise exception 'FAIL 2: generate RPC returned invalid id/number (% / %)',
      v_purchase_order_id, coalesce(v_purchase_order_number, '<null>');
  end if;

  if v_status <> 'draft' then
    raise exception 'FAIL 2: expected generated PO status=draft, got %', v_status;
  end if;

  select status, supplier_name, branch_name, expected_receipt_date
    into v_status, v_supplier_name, v_branch_name, v_expected_receipt
  from public.v_procurement_purchase_orders
  where purchase_order_id = v_purchase_order_id;

  if v_status <> 'draft' then
    raise exception 'FAIL 2: projected PO status should be draft, got %', coalesce(v_status, '<null>');
  end if;
  if v_supplier_name <> 'Acme Supply Co' then
    raise exception 'FAIL 2: expected supplier_name=Acme Supply Co, got %', coalesce(v_supplier_name, '<null>');
  end if;
  if v_branch_name <> 'Procurement Test Branch' then
    raise exception 'FAIL 2: expected branch_name=Procurement Test Branch, got %', coalesce(v_branch_name, '<null>');
  end if;
  if v_expected_receipt <> current_date + 7 then
    raise exception 'FAIL 2: expected expected_receipt_date=% got %', current_date + 7, v_expected_receipt;
  end if;

  raise notice 'PASS 2: admin generated draft PO %', v_purchase_order_number;

  -- 3. issue -> open ----------------------------------------------------------
  select r.status, r.amendment_count
    into v_status, v_amendment_count
  from public.procurement_transition_purchase_order(
    p_purchase_order_id => v_purchase_order_id,
    p_action => 'issue'
  ) as r;

  if v_status <> 'open' or v_amendment_count <> 0 then
    raise exception 'FAIL 3: expected issue => open/amendment_count=0, got % / %',
      coalesce(v_status, '<null>'), coalesce(v_amendment_count, -1);
  end if;

  raise notice 'PASS 3: issue transitioned PO to open';

  -- 4. receive -> partially_received -> closed --------------------------------
  select r.status
    into v_status
  from public.procurement_transition_purchase_order(
    p_purchase_order_id => v_purchase_order_id,
    p_action => 'receive',
    p_received_quantity => 3
  ) as r;

  if v_status <> 'partially_received' then
    raise exception 'FAIL 4: expected partially_received after first receipt, got %', coalesce(v_status, '<null>');
  end if;

  select r.status
    into v_status
  from public.procurement_transition_purchase_order(
    p_purchase_order_id => v_purchase_order_id,
    p_action => 'receive',
    p_received_quantity => 8
  ) as r;

  if v_status <> 'closed' then
    raise exception 'FAIL 4: expected closed after full receipt, got %', coalesce(v_status, '<null>');
  end if;

  raise notice 'PASS 4: receipt tracking projected partial then closed status';

  -- 5. amendment requires a reason and projects expected receipt --------------
  select entity_id into v_requisition_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'requisition',
    p_data => jsonb_build_object(
      'status', 'approved',
      'branch_id', v_branch_id,
      'supplier_id', v_supplier_id,
      'expected_receipt_date', (current_date + 10),
      'quantity', 5,
      'item_description', 'Replacement filters'
    )
  );

  select r.purchase_order_id
    into v_purchase_order_id
  from public.procurement_generate_purchase_order(
    p_requisition_id => v_requisition_id,
    p_reason => 'Second approved requisition'
  ) as r;

  perform public.procurement_transition_purchase_order(
    p_purchase_order_id => v_purchase_order_id,
    p_action => 'issue'
  );

  v_caught := false;
  begin
    perform public.procurement_transition_purchase_order(
      p_purchase_order_id => v_purchase_order_id,
      p_action => 'amend',
      p_expected_receipt_date => current_date + 12
    );
  exception
    when sqlstate '22023' then v_caught := true;
  end;

  if not v_caught then
    raise exception 'FAIL 5: amendment without reason should fail';
  end if;

  select r.status, r.amendment_count
    into v_status, v_amendment_count
  from public.procurement_transition_purchase_order(
    p_purchase_order_id => v_purchase_order_id,
    p_action => 'amend',
    p_reason => 'Supplier requested two-day slip',
    p_expected_receipt_date => current_date + 12
  ) as r;

  if v_status <> 'open' or v_amendment_count <> 1 then
    raise exception 'FAIL 5: expected open + amendment_count=1 after amendment, got % / %',
      coalesce(v_status, '<null>'), coalesce(v_amendment_count, -1);
  end if;

  select expected_receipt_date, last_action_reason
    into v_expected_receipt, v_reason
  from public.v_procurement_purchase_orders
  where purchase_order_id = v_purchase_order_id;

  if v_expected_receipt <> current_date + 12 then
    raise exception 'FAIL 5: expected updated expected_receipt_date=% got %',
      current_date + 12, v_expected_receipt;
  end if;
  if v_reason <> 'Supplier requested two-day slip' then
    raise exception 'FAIL 5: amendment reason not projected, got %', coalesce(v_reason, '<null>');
  end if;

  raise notice 'PASS 5: amendment reason and projected expected receipt verified';

  -- 6. cancellation requires a reason -----------------------------------------
  v_caught := false;
  begin
    perform public.procurement_transition_purchase_order(
      p_purchase_order_id => v_purchase_order_id,
      p_action => 'cancel'
    );
  exception
    when sqlstate '22023' then v_caught := true;
  end;

  if not v_caught then
    raise exception 'FAIL 6: cancellation without reason should fail';
  end if;

  select r.status
    into v_status
  from public.procurement_transition_purchase_order(
    p_purchase_order_id => v_purchase_order_id,
    p_action => 'cancel',
    p_reason => 'Supplier discontinued item'
  ) as r;

  if v_status <> 'cancelled' then
    raise exception 'FAIL 6: expected cancelled status after cancellation, got %', coalesce(v_status, '<null>');
  end if;

  select status, last_action_reason
    into v_status, v_reason
  from public.v_procurement_purchase_orders
  where purchase_order_id = v_purchase_order_id;

  if v_status <> 'cancelled' or v_reason <> 'Supplier discontinued item' then
    raise exception 'FAIL 6: cancellation projection incorrect (% / %)',
      coalesce(v_status, '<null>'), coalesce(v_reason, '<null>');
  end if;

  raise notice 'PASS 6: cancellation reason persisted';

  -- 7. requisition projection carries PO references and latest lifecycle state -
  select
    ev.data ->> 'purchase_order_status',
    ev.data ->> 'purchase_order_last_reason',
    (ev.data ->> 'purchase_order_received_quantity')::numeric
    into v_status, v_reason, v_received_quantity
  from public.entity_versions ev
  where ev.entity_id = v_requisition_id
    and ev.is_current = true;

  if v_status <> 'cancelled' then
    raise exception 'FAIL 7: requisition projection expected purchase_order_status=cancelled, got %', coalesce(v_status, '<null>');
  end if;
  if v_reason <> 'Supplier discontinued item' then
    raise exception 'FAIL 7: requisition projection expected latest reason, got %', coalesce(v_reason, '<null>');
  end if;
  if coalesce(v_received_quantity, -1) <> 0 then
    raise exception 'FAIL 7: cancelled PO requisition projection expected received_quantity=0, got %', v_received_quantity;
  end if;

  raise notice 'PASS 7: requisition current-state projection updated';

  -- 8. time-series audit events ------------------------------------------------
  select count(*)
    into v_event_count
  from public.time_series_points tsp
  join public.fact_types ft
    on ft.id = tsp.fact_type_id
  where tsp.entity_id = v_purchase_order_id
    and ft.key = 'purchase_order_event';

  -- Second PO path executes four lifecycle events: generated, issued, amended,
  -- and cancelled.
  if v_event_count <> 4 then
    raise exception 'FAIL 8: expected 4 lifecycle events for amended/cancelled PO, got %', v_event_count;
  end if;

  raise notice 'PASS 8: lifecycle audit events captured in time_series_points';
end;
$$;

rollback;
