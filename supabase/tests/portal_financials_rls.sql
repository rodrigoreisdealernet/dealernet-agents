-- Behavioral access-control tests for portal_get_financial_entities().
-- Validates that authenticated portal JWT scope claims prevent cross-customer,
-- cross-billing-account, cross-job-site, and cross-contract data from being returned.

begin;

do $$
declare
  v_customer_1_id constant uuid := 'beefcafe-1000-0000-0001-000000000001';
  v_customer_2_id constant uuid := 'beefcafe-1000-0000-0001-000000000002';
  v_billing_1_id  constant uuid := 'beefcafe-1000-0000-0002-000000000001';
  v_billing_2_id  constant uuid := 'beefcafe-1000-0000-0002-000000000002';
  v_billing_3_id  constant uuid := 'beefcafe-1000-0000-0002-000000000003';
  v_job_site_1_id constant uuid := 'beefcafe-1000-0000-0003-000000000001';
  v_job_site_2_id constant uuid := 'beefcafe-1000-0000-0003-000000000002';
  v_job_site_3_id constant uuid := 'beefcafe-1000-0000-0003-000000000003';
  v_contract_a_id constant uuid := 'beefcafe-1000-0000-0004-000000000001';
  v_contract_b_id constant uuid := 'beefcafe-1000-0000-0004-000000000002';
  v_contract_c_id constant uuid := 'beefcafe-1000-0000-0004-000000000003';
  v_contract_d_id constant uuid := 'beefcafe-1000-0000-0004-000000000004';
  v_contract_e_id constant uuid := 'beefcafe-1000-0000-0004-000000000005';
  v_invoice_a_id  constant uuid := 'beefcafe-1000-0000-0005-000000000001';
  v_invoice_b_id  constant uuid := 'beefcafe-1000-0000-0005-000000000002';
  v_invoice_c_id  constant uuid := 'beefcafe-1000-0000-0005-000000000003';
  v_invoice_d_id  constant uuid := 'beefcafe-1000-0000-0005-000000000004';
  v_invoice_e_id  constant uuid := 'beefcafe-1000-0000-0005-000000000005';
  v_line_a_id     constant uuid := 'beefcafe-1000-0000-0006-000000000001';
  v_line_b_id     constant uuid := 'beefcafe-1000-0000-0006-000000000002';
  v_line_c_id     constant uuid := 'beefcafe-1000-0000-0006-000000000003';
  v_line_d_id     constant uuid := 'beefcafe-1000-0000-0006-000000000004';
  v_line_e_id     constant uuid := 'beefcafe-1000-0000-0006-000000000005';
  v_asset_a_id    constant uuid := 'beefcafe-1000-0000-0007-000000000001';
  v_asset_b_id    constant uuid := 'beefcafe-1000-0000-0007-000000000002';
  v_asset_c_id    constant uuid := 'beefcafe-1000-0000-0007-000000000003';
  v_asset_d_id    constant uuid := 'beefcafe-1000-0000-0007-000000000004';
  v_asset_e_id    constant uuid := 'beefcafe-1000-0000-0007-000000000005';
  v_payment_a_id  constant uuid := 'beefcafe-1000-0000-0008-000000000001';
  v_payment_b_id  constant uuid := 'beefcafe-1000-0000-0008-000000000002';
  v_payment_c_id  constant uuid := 'beefcafe-1000-0000-0008-000000000003';
  v_payment_d_id  constant uuid := 'beefcafe-1000-0000-0008-000000000004';
  v_payment_e_id  constant uuid := 'beefcafe-1000-0000-0008-000000000005';
  v_document_a_id constant uuid := 'beefcafe-1000-0000-0009-000000000001';
  v_document_b_id constant uuid := 'beefcafe-1000-0000-0009-000000000002';
  v_document_c_id constant uuid := 'beefcafe-1000-0000-0009-000000000003';
  v_document_d_id constant uuid := 'beefcafe-1000-0000-0009-000000000004';
  v_document_e_id constant uuid := 'beefcafe-1000-0000-0009-000000000005';
begin
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_customer_1_id, 'customer', 'portal-financials-customer-1'),
    (v_customer_2_id, 'customer', 'portal-financials-customer-2'),
    (v_billing_1_id, 'billing_account', 'portal-financials-billing-1'),
    (v_billing_2_id, 'billing_account', 'portal-financials-billing-2'),
    (v_billing_3_id, 'billing_account', 'portal-financials-billing-3'),
    (v_job_site_1_id, 'job_site', 'portal-financials-job-site-1'),
    (v_job_site_2_id, 'job_site', 'portal-financials-job-site-2'),
    (v_job_site_3_id, 'job_site', 'portal-financials-job-site-3'),
    (v_contract_a_id, 'rental_contract', 'portal-financials-contract-a'),
    (v_contract_b_id, 'rental_contract', 'portal-financials-contract-b'),
    (v_contract_c_id, 'rental_contract', 'portal-financials-contract-c'),
    (v_contract_d_id, 'rental_contract', 'portal-financials-contract-d'),
    (v_contract_e_id, 'rental_contract', 'portal-financials-contract-e'),
    (v_invoice_a_id, 'invoice', 'portal-financials-invoice-a'),
    (v_invoice_b_id, 'invoice', 'portal-financials-invoice-b'),
    (v_invoice_c_id, 'invoice', 'portal-financials-invoice-c'),
    (v_invoice_d_id, 'invoice', 'portal-financials-invoice-d'),
    (v_invoice_e_id, 'invoice', 'portal-financials-invoice-e'),
    (v_line_a_id, 'rental_contract_line', 'portal-financials-line-a'),
    (v_line_b_id, 'rental_contract_line', 'portal-financials-line-b'),
    (v_line_c_id, 'rental_contract_line', 'portal-financials-line-c'),
    (v_line_d_id, 'rental_contract_line', 'portal-financials-line-d'),
    (v_line_e_id, 'rental_contract_line', 'portal-financials-line-e'),
    (v_asset_a_id, 'asset', 'portal-financials-asset-a'),
    (v_asset_b_id, 'asset', 'portal-financials-asset-b'),
    (v_asset_c_id, 'asset', 'portal-financials-asset-c'),
    (v_asset_d_id, 'asset', 'portal-financials-asset-d'),
    (v_asset_e_id, 'asset', 'portal-financials-asset-e'),
    (v_payment_a_id, 'payment', 'portal-financials-payment-a'),
    (v_payment_b_id, 'payment', 'portal-financials-payment-b'),
    (v_payment_c_id, 'payment', 'portal-financials-payment-c'),
    (v_payment_d_id, 'payment', 'portal-financials-payment-d'),
    (v_payment_e_id, 'payment', 'portal-financials-payment-e'),
    (v_document_a_id, 'document', 'portal-financials-document-a'),
    (v_document_b_id, 'document', 'portal-financials-document-b'),
    (v_document_c_id, 'document', 'portal-financials-document-c'),
    (v_document_d_id, 'document', 'portal-financials-document-d'),
    (v_document_e_id, 'document', 'portal-financials-document-e');

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_customer_1_id, 1, true, jsonb_build_object('name', 'Scoped Customer'), now()),
    (v_customer_2_id, 1, true, jsonb_build_object('name', 'Cross Customer'), now()),
    (v_billing_1_id, 1, true, jsonb_build_object('name', 'Billing One'), now()),
    (v_billing_2_id, 1, true, jsonb_build_object('name', 'Billing Two'), now()),
    (v_billing_3_id, 1, true, jsonb_build_object('name', 'Billing Three'), now()),
    (v_job_site_1_id, 1, true, jsonb_build_object('name', 'Job Site One'), now()),
    (v_job_site_2_id, 1, true, jsonb_build_object('name', 'Job Site Two'), now()),
    (v_job_site_3_id, 1, true, jsonb_build_object('name', 'Job Site Three'), now()),
    (v_contract_a_id, 1, true, jsonb_build_object('contract_number', 'PORTAL-A', 'status', 'active', 'customer_id', v_customer_1_id, 'billing_account_id', v_billing_1_id, 'job_site_id', v_job_site_1_id), now()),
    (v_contract_b_id, 1, true, jsonb_build_object('contract_number', 'PORTAL-B', 'status', 'active', 'customer_id', v_customer_2_id, 'billing_account_id', v_billing_3_id, 'job_site_id', v_job_site_3_id), now()),
    (v_contract_c_id, 1, true, jsonb_build_object('contract_number', 'PORTAL-C', 'status', 'active', 'customer_id', v_customer_1_id, 'billing_account_id', v_billing_2_id, 'job_site_id', v_job_site_1_id), now()),
    (v_contract_d_id, 1, true, jsonb_build_object('contract_number', 'PORTAL-D', 'status', 'active', 'customer_id', v_customer_1_id, 'billing_account_id', v_billing_1_id, 'job_site_id', v_job_site_2_id), now()),
    (v_contract_e_id, 1, true, jsonb_build_object('contract_number', 'PORTAL-E', 'status', 'active', 'customer_id', v_customer_1_id, 'billing_account_id', v_billing_1_id, 'job_site_id', v_job_site_1_id), now()),
    (v_invoice_a_id, 1, true, jsonb_build_object('invoice_number', 'INV-A', 'status', 'sent', 'customer_id', v_customer_1_id, 'billing_account_id', v_billing_1_id, 'job_site_id', v_job_site_1_id, 'contract_id', v_contract_a_id, 'total', 100, 'open_balance', 50), now()),
    (v_invoice_b_id, 1, true, jsonb_build_object('invoice_number', 'INV-B', 'status', 'sent', 'customer_id', v_customer_2_id, 'billing_account_id', v_billing_3_id, 'job_site_id', v_job_site_3_id, 'contract_id', v_contract_b_id, 'total', 200, 'open_balance', 200), now()),
    (v_invoice_c_id, 1, true, jsonb_build_object('invoice_number', 'INV-C', 'status', 'sent', 'customer_id', v_customer_1_id, 'billing_account_id', v_billing_2_id, 'job_site_id', v_job_site_1_id, 'contract_id', v_contract_c_id, 'total', 300, 'open_balance', 300), now()),
    (v_invoice_d_id, 1, true, jsonb_build_object('invoice_number', 'INV-D', 'status', 'sent', 'customer_id', v_customer_1_id, 'billing_account_id', v_billing_1_id, 'job_site_id', v_job_site_2_id, 'contract_id', v_contract_d_id, 'total', 400, 'open_balance', 400), now()),
    (v_invoice_e_id, 1, true, jsonb_build_object('invoice_number', 'INV-E', 'status', 'sent', 'customer_id', v_customer_1_id, 'billing_account_id', v_billing_1_id, 'job_site_id', v_job_site_1_id, 'contract_id', v_contract_e_id, 'total', 500, 'open_balance', 500), now()),
    (v_line_a_id, 1, true, jsonb_build_object('contract_id', v_contract_a_id, 'asset_id', v_asset_a_id, 'status', 'checked_out', 'rate_amount', 10), now()),
    (v_line_b_id, 1, true, jsonb_build_object('contract_id', v_contract_b_id, 'asset_id', v_asset_b_id, 'status', 'checked_out', 'rate_amount', 20), now()),
    (v_line_c_id, 1, true, jsonb_build_object('contract_id', v_contract_c_id, 'asset_id', v_asset_c_id, 'status', 'checked_out', 'rate_amount', 30), now()),
    (v_line_d_id, 1, true, jsonb_build_object('contract_id', v_contract_d_id, 'asset_id', v_asset_d_id, 'status', 'checked_out', 'rate_amount', 40), now()),
    (v_line_e_id, 1, true, jsonb_build_object('contract_id', v_contract_e_id, 'asset_id', v_asset_e_id, 'status', 'checked_out', 'rate_amount', 50), now()),
    (v_asset_a_id, 1, true, jsonb_build_object('name', 'Asset A'), now()),
    (v_asset_b_id, 1, true, jsonb_build_object('name', 'Asset B'), now()),
    (v_asset_c_id, 1, true, jsonb_build_object('name', 'Asset C'), now()),
    (v_asset_d_id, 1, true, jsonb_build_object('name', 'Asset D'), now()),
    (v_asset_e_id, 1, true, jsonb_build_object('name', 'Asset E'), now()),
    (v_payment_a_id, 1, true, jsonb_build_object('invoice_id', v_invoice_a_id, 'amount', 25, 'status', 'posted'), now()),
    (v_payment_b_id, 1, true, jsonb_build_object('invoice_id', v_invoice_b_id, 'amount', 35, 'status', 'posted'), now()),
    (v_payment_c_id, 1, true, jsonb_build_object('invoice_id', v_invoice_c_id, 'amount', 45, 'status', 'posted'), now()),
    (v_payment_d_id, 1, true, jsonb_build_object('invoice_id', v_invoice_d_id, 'amount', 55, 'status', 'posted'), now()),
    (v_payment_e_id, 1, true, jsonb_build_object('invoice_id', v_invoice_e_id, 'amount', 65, 'status', 'posted'), now()),
    (v_document_a_id, 1, true, jsonb_build_object('invoice_id', v_invoice_a_id, 'contract_id', v_contract_a_id, 'title', 'Document A'), now()),
    (v_document_b_id, 1, true, jsonb_build_object('invoice_id', v_invoice_b_id, 'contract_id', v_contract_b_id, 'title', 'Document B'), now()),
    (v_document_c_id, 1, true, jsonb_build_object('invoice_id', v_invoice_c_id, 'contract_id', v_contract_c_id, 'title', 'Document C'), now()),
    (v_document_d_id, 1, true, jsonb_build_object('invoice_id', v_invoice_d_id, 'contract_id', v_contract_d_id, 'title', 'Document D'), now()),
    (v_document_e_id, 1, true, jsonb_build_object('invoice_id', v_invoice_e_id, 'contract_id', v_contract_e_id, 'title', 'Document E'), now());
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught boolean := false;
begin
  begin
    perform * from public.portal_get_financial_entities();
    raise exception 'FAIL 1: authenticated caller without portal scope claims was allowed';
  exception
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 1: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 1: missing portal scope claims should raise 42501';
  end if;

  raise notice 'PASS 1: portal financial RPC fails closed when scope claims are missing';
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000000099',
    'role', 'authenticated',
    'customer_id', 'beefcafe-1000-0000-0001-000000000001',
    'app_metadata', jsonb_build_object('role', 'read_only')
  )::text,
  true
);

do $$
declare
  v_contract_b_id constant uuid := 'beefcafe-1000-0000-0004-000000000002';
  v_invoice_b_id  constant uuid := 'beefcafe-1000-0000-0005-000000000002';
begin
  if not exists (select 1 from public.portal_get_financial_entities() where id = 'beefcafe-1000-0000-0004-000000000001'::uuid) then
    raise exception 'FAIL 2: authorized contract row missing for customer-scoped portal JWT';
  end if;

  if exists (select 1 from public.portal_get_financial_entities() where id in (v_contract_b_id, v_invoice_b_id)) then
    raise exception 'FAIL 2: customer-scoped portal JWT received cross-customer rows';
  end if;

  raise notice 'PASS 2: customer scope blocks cross-customer rows';
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000000099',
    'role', 'authenticated',
    'customer_id', 'beefcafe-1000-0000-0001-000000000001',
    'billing_account_ids', jsonb_build_array('beefcafe-1000-0000-0002-000000000001'),
    'app_metadata', jsonb_build_object('role', 'read_only')
  )::text,
  true
);

do $$
declare
  v_contract_c_id constant uuid := 'beefcafe-1000-0000-0004-000000000003';
  v_invoice_c_id  constant uuid := 'beefcafe-1000-0000-0005-000000000003';
begin
  if exists (select 1 from public.portal_get_financial_entities() where id in (v_contract_c_id, v_invoice_c_id)) then
    raise exception 'FAIL 3: billing-account scoped portal JWT received cross-billing-account rows';
  end if;

  raise notice 'PASS 3: billing-account scope blocks cross-billing-account rows';
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000000099',
    'role', 'authenticated',
    'customer_id', 'beefcafe-1000-0000-0001-000000000001',
    'billing_account_ids', jsonb_build_array('beefcafe-1000-0000-0002-000000000001'),
    'job_site_ids', jsonb_build_array('beefcafe-1000-0000-0003-000000000001'),
    'app_metadata', jsonb_build_object('role', 'read_only')
  )::text,
  true
);

do $$
declare
  v_contract_d_id constant uuid := 'beefcafe-1000-0000-0004-000000000004';
  v_invoice_d_id  constant uuid := 'beefcafe-1000-0000-0005-000000000004';
begin
  if exists (select 1 from public.portal_get_financial_entities() where id in (v_contract_d_id, v_invoice_d_id)) then
    raise exception 'FAIL 4: job-site scoped portal JWT received cross-job-site rows';
  end if;

  raise notice 'PASS 4: job-site scope blocks cross-job-site rows';
end;
$$;

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000000099',
    'role', 'authenticated',
    'customer_id', 'beefcafe-1000-0000-0001-000000000001',
    'billing_account_ids', jsonb_build_array('beefcafe-1000-0000-0002-000000000001'),
    'job_site_ids', jsonb_build_array('beefcafe-1000-0000-0003-000000000001'),
    'contract_ids', jsonb_build_array('beefcafe-1000-0000-0004-000000000001'),
    'app_metadata', jsonb_build_object('role', 'read_only')
  )::text,
  true
);

do $$
declare
  v_contract_e_id constant uuid := 'beefcafe-1000-0000-0004-000000000005';
  v_invoice_e_id  constant uuid := 'beefcafe-1000-0000-0005-000000000005';
  v_line_e_id     constant uuid := 'beefcafe-1000-0000-0006-000000000005';
  v_asset_e_id    constant uuid := 'beefcafe-1000-0000-0007-000000000005';
  v_payment_e_id  constant uuid := 'beefcafe-1000-0000-0008-000000000005';
  v_document_e_id constant uuid := 'beefcafe-1000-0000-0009-000000000005';
begin
  if not exists (select 1 from public.portal_get_financial_entities() where id = 'beefcafe-1000-0000-0004-000000000001'::uuid) then
    raise exception 'FAIL 5: contract-scoped portal JWT missing authorized contract row';
  end if;

  if exists (
    select 1
    from public.portal_get_financial_entities()
    where id in (v_contract_e_id, v_invoice_e_id, v_line_e_id, v_asset_e_id, v_payment_e_id, v_document_e_id)
  ) then
    raise exception 'FAIL 5: contract-scoped portal JWT received cross-contract related rows';
  end if;

  raise notice 'PASS 5: contract scope blocks cross-contract rows and related entities';
end;
$$;

reset role;

rollback;
