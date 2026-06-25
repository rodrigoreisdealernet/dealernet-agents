begin;

do $$
declare
  v_tenant_a_id uuid;
  v_tenant_b_id uuid;
  v_branch_id uuid;
  v_billing_account_id uuid;
  v_job_site_id uuid;
  v_invoice_id uuid;
  v_invoice_version_id uuid;
  v_invoice_line_a_id uuid;
  v_invoice_line_b_id uuid;
  v_state_jurisdiction_id uuid;
  v_city_jurisdiction_id uuid;
  v_state_rate_id uuid;
  v_city_rate_id uuid;
  v_snapshot_issue_id uuid;
  v_snapshot_refund_id uuid;
  v_snapshot_tenant_b_id uuid;
  v_header_rows bigint;
  v_line_rows bigint;
  v_collected_tax_total numeric;
  v_state_collected numeric;
  v_city_refunded numeric;
  v_refund_signed numeric;
  v_export_keys_first text[];
  v_export_keys_second text[];
  v_refund_audit_reason text;
  v_override_blocked boolean;
  v_cross_tenant_snapshot_visible bigint;
  v_cross_tenant_export_visible bigint;
  v_unapproved_role_snapshot_visible bigint;
  v_same_tenant_export_visible bigint;
  v_service_cross_tenant_export_visible bigint;
  v_service_same_tenant_export_visible bigint;
  v_service_same_tenant_summary_visible bigint;
  v_period_export_rows_tenant_a bigint;
  v_period_export_rows_tenant_b bigint;
begin
  insert into tenants (tenant_key, name)
  values
    ('tax-test-tenant-a', 'Tax Test Tenant A'),
    ('tax-test-tenant-b', 'Tax Test Tenant B');

  select id into v_tenant_a_id
  from tenants
  where tenant_key = 'tax-test-tenant-a';

  select id into v_tenant_b_id
  from tenants
  where tenant_key = 'tax-test-tenant-b';

  insert into entities (entity_type, source_record_id)
  values ('branch', 'tax-test-branch')
  returning id into v_branch_id;

  insert into entities (entity_type, source_record_id)
  values ('billing_account', 'tax-test-billing-account')
  returning id into v_billing_account_id;

  insert into entities (entity_type, source_record_id)
  values ('job_site', 'tax-test-job-site')
  returning id into v_job_site_id;

  insert into entities (entity_type, source_record_id)
  values ('invoice', 'tax-test-invoice-001')
  returning id into v_invoice_id;

  insert into entity_versions (entity_id, version_number, data)
  values (
    v_invoice_id,
    1,
    jsonb_build_object(
      'invoice_number', 'INV-TAX-001',
      'status', 'pending',
      'invoice_date', '2026-06-15',
      'subtotal', 1000.00,
      'tax', 90.00,
      'total', 1090.00,
      'billing_account_id', v_billing_account_id,
      'branch_id', v_branch_id,
      'job_site_id', v_job_site_id
    )
  )
  returning id into v_invoice_version_id;

  insert into entities (entity_type, source_record_id)
  values ('invoice_line', 'tax-test-invoice-line-a')
  returning id into v_invoice_line_a_id;

  insert into entities (entity_type, source_record_id)
  values ('invoice_line', 'tax-test-invoice-line-b')
  returning id into v_invoice_line_b_id;

  insert into tax_jurisdictions (jurisdiction_code, jurisdiction_name, country_code, region_code, level)
  values
    ('US-CA', 'California', 'US', 'CA', 'state'),
    ('US-CA-LA', 'Los Angeles', 'US', 'CA', 'city');

  select id into v_state_jurisdiction_id
  from tax_jurisdictions
  where jurisdiction_code = 'US-CA';

  select id into v_city_jurisdiction_id
  from tax_jurisdictions
  where jurisdiction_code = 'US-CA-LA';

  insert into tax_jurisdiction_rates (jurisdiction_id, tax_code, rate, effective_from)
  values
    (v_state_jurisdiction_id, 'sales_tax', 0.060000, date '2026-01-01'),
    (v_city_jurisdiction_id, 'sales_tax', 0.030000, date '2026-01-01');

  select id into v_state_rate_id
  from tax_jurisdiction_rates
  where jurisdiction_id = v_state_jurisdiction_id;

  select id into v_city_rate_id
  from tax_jurisdiction_rates
  where jurisdiction_id = v_city_jurisdiction_id;

  insert into invoice_tax_snapshots (
    invoice_id,
    tenant_id,
    invoice_version_id,
    source_event_id,
    event_type,
    snapshot_effective_at,
    finalized_at,
    billing_account_id,
    branch_id,
    job_site_id,
    determination_scope,
    override_reason,
    override_actor,
    override_metadata,
    audit_metadata
  )
  values (
    v_invoice_id,
    v_tenant_a_id,
    v_invoice_version_id,
    'inv-tax-001-finalized',
    'invoice_finalized',
    date '2026-06-15',
    '2026-06-15T12:30:00Z'::timestamptz,
    v_billing_account_id,
    v_branch_id,
    v_job_site_id,
    'override',
    'Customer provided resale certificate for labor-only line',
    'billing-manager@wynne.dev',
    jsonb_build_object('override_ticket', 'TAX-123', 'requested_by', 'billing_manager'),
    jsonb_build_object('actor', 'billing-manager@wynne.dev', 'action', 'invoice_finalized')
  )
  returning id into v_snapshot_issue_id;

  insert into invoice_tax_jurisdiction_snapshots (
    invoice_tax_snapshot_id,
    jurisdiction_id,
    jurisdiction_rate_id,
    jurisdiction_code,
    tax_code,
    tax_rate,
    taxable_amount,
    exempt_amount,
    collected_tax_amount,
    exemption_reason
  )
  values
    (v_snapshot_issue_id, v_state_jurisdiction_id, v_state_rate_id, 'US-CA', 'sales_tax', 0.060000, 1000.00, 0.00, 60.00, null),
    (v_snapshot_issue_id, v_city_jurisdiction_id, v_city_rate_id, 'US-CA-LA', 'sales_tax', 0.030000, 1000.00, 200.00, 30.00, 'Labor-only service exempt');

  insert into invoice_line_tax_snapshots (
    invoice_tax_snapshot_id,
    invoice_line_id,
    line_source_key,
    jurisdiction_id,
    jurisdiction_rate_id,
    jurisdiction_code,
    tax_code,
    tax_rate,
    taxable_amount,
    exempt_amount,
    collected_tax_amount,
    exemption_reason
  )
  values
    (v_snapshot_issue_id, v_invoice_line_a_id, 'line-a:equipment', v_state_jurisdiction_id, v_state_rate_id, 'US-CA', 'sales_tax', 0.060000, 800.00, 0.00, 48.00, null),
    (v_snapshot_issue_id, v_invoice_line_a_id, 'line-a:equipment', v_city_jurisdiction_id, v_city_rate_id, 'US-CA-LA', 'sales_tax', 0.030000, 800.00, 0.00, 24.00, null),
    (v_snapshot_issue_id, v_invoice_line_b_id, 'line-b:labor', v_state_jurisdiction_id, v_state_rate_id, 'US-CA', 'sales_tax', 0.060000, 200.00, 0.00, 12.00, null),
    (v_snapshot_issue_id, v_invoice_line_b_id, 'line-b:labor', v_city_jurisdiction_id, v_city_rate_id, 'US-CA-LA', 'sales_tax', 0.030000, 200.00, 200.00, 6.00, 'Labor-only service exempt');

  -- Refund reversal offsets the city jurisdiction with audit trail.
  insert into invoice_tax_snapshots (
    invoice_id,
    tenant_id,
    invoice_version_id,
    source_event_id,
    event_type,
    snapshot_effective_at,
    finalized_at,
    billing_account_id,
    branch_id,
    job_site_id,
    determination_scope,
    audit_metadata
  )
  values (
    v_invoice_id,
    v_tenant_a_id,
    v_invoice_version_id,
    'inv-tax-001-refund-001',
    'refund',
    date '2026-06-18',
    '2026-06-18T09:00:00Z'::timestamptz,
    v_billing_account_id,
    v_branch_id,
    v_job_site_id,
    'job_site',
    jsonb_build_object('actor', 'system', 'action', 'refund_issued', 'reason', 'partial tax reversal for service credit')
  )
  returning id into v_snapshot_refund_id;

  insert into invoice_tax_jurisdiction_snapshots (
    invoice_tax_snapshot_id,
    jurisdiction_id,
    jurisdiction_rate_id,
    jurisdiction_code,
    tax_code,
    tax_rate,
    taxable_amount,
    exempt_amount,
    collected_tax_amount,
    exemption_reason
  )
  values
    (v_snapshot_refund_id, v_city_jurisdiction_id, v_city_rate_id, 'US-CA-LA', 'sales_tax', 0.030000, 100.00, 0.00, 3.00, null);

  -- Same filing period + jurisdiction for another tenant to prove service-side tenant isolation.
  insert into invoice_tax_snapshots (
    invoice_id,
    tenant_id,
    invoice_version_id,
    source_event_id,
    event_type,
    snapshot_effective_at,
    finalized_at,
    billing_account_id,
    branch_id,
    job_site_id,
    determination_scope,
    audit_metadata
  )
  values (
    v_invoice_id,
    v_tenant_b_id,
    v_invoice_version_id,
    'inv-tax-tenant-b-finalized',
    'invoice_finalized',
    date '2026-06-16',
    '2026-06-16T09:00:00Z'::timestamptz,
    v_billing_account_id,
    v_branch_id,
    v_job_site_id,
    'job_site',
    jsonb_build_object('actor', 'tenant-b-system', 'action', 'invoice_finalized')
  )
  returning id into v_snapshot_tenant_b_id;

  insert into invoice_tax_jurisdiction_snapshots (
    invoice_tax_snapshot_id,
    jurisdiction_id,
    jurisdiction_rate_id,
    jurisdiction_code,
    tax_code,
    tax_rate,
    taxable_amount,
    exempt_amount,
    collected_tax_amount,
    exemption_reason
  )
  values
    (v_snapshot_tenant_b_id, v_state_jurisdiction_id, v_state_rate_id, 'US-CA', 'sales_tax', 0.060000, 500.00, 0.00, 30.00, null);

  insert into invoice_line_tax_snapshots (
    invoice_tax_snapshot_id,
    invoice_line_id,
    line_source_key,
    jurisdiction_id,
    jurisdiction_rate_id,
    jurisdiction_code,
    tax_code,
    tax_rate,
    taxable_amount,
    exempt_amount,
    collected_tax_amount,
    exemption_reason
  )
  values
    (v_snapshot_refund_id, v_invoice_line_b_id, 'line-b:labor-refund', v_city_jurisdiction_id, v_city_rate_id, 'US-CA-LA', 'sales_tax', 0.030000, 100.00, 0.00, 3.00, null);

  select count(*) into v_header_rows
  from invoice_tax_jurisdiction_snapshots
  where invoice_tax_snapshot_id = v_snapshot_issue_id;
  if v_header_rows <> 2 then
    raise exception 'Expected 2 header jurisdiction snapshots, got %', v_header_rows;
  end if;

  select count(*) into v_line_rows
  from invoice_line_tax_snapshots
  where invoice_tax_snapshot_id = v_snapshot_issue_id;
  if v_line_rows <> 4 then
    raise exception 'Expected 4 line tax snapshots, got %', v_line_rows;
  end if;

  -- Reconcile persisted tax snapshot to invoice header tax field.
  select sum(collected_tax_amount)
    into v_collected_tax_total
  from invoice_tax_jurisdiction_snapshots
  where invoice_tax_snapshot_id = v_snapshot_issue_id;
  if v_collected_tax_total <> 90.00 then
    raise exception 'Expected collected header tax to reconcile to invoice tax (90.00), got %', v_collected_tax_total;
  end if;

  -- Summary view: state remains positive, city reflects refund offset and refunded total.
  select collected_tax_amount
    into v_state_collected
  from v_invoice_tax_filing_period_jurisdiction_summary
  where filing_period_start = date '2026-06-01'
    and tenant_id = v_tenant_a_id
    and jurisdiction_code = 'US-CA';
  if v_state_collected <> 60.00 then
    raise exception 'Expected US-CA collected_tax_amount 60.00, got %', v_state_collected;
  end if;

  select refunded_tax_amount
    into v_city_refunded
  from v_invoice_tax_filing_period_jurisdiction_summary
  where filing_period_start = date '2026-06-01'
    and tenant_id = v_tenant_a_id
    and jurisdiction_code = 'US-CA-LA';
  if v_city_refunded <> 3.00 then
    raise exception 'Expected US-CA-LA refunded_tax_amount 3.00, got %', v_city_refunded;
  end if;

  select signed_collected_tax_amount
    into v_refund_signed
  from v_invoice_tax_filing_export_rows
  where source_event_id = 'inv-tax-001-refund-001'
    and jurisdiction_code = 'US-CA-LA';
  if v_refund_signed <> -3.00 then
    raise exception 'Expected refund export row signed tax -3.00, got %', v_refund_signed;
  end if;

  select audit_metadata ->> 'reason'
    into v_refund_audit_reason
  from v_invoice_tax_filing_export_rows
  where source_event_id = 'inv-tax-001-refund-001'
    and jurisdiction_code = 'US-CA-LA';
  if v_refund_audit_reason <> 'partial tax reversal for service credit' then
    raise exception 'Expected refund audit reason in export row';
  end if;

  -- Deterministic export rows (stable keys/order for period regeneration).
  select array_agg(export_row_key order by export_row_key)
    into v_export_keys_first
  from v_invoice_tax_filing_export_rows
  where filing_period_start = date '2026-06-01';

  select array_agg(export_row_key order by export_row_key)
    into v_export_keys_second
  from v_invoice_tax_filing_export_rows
  where filing_period_start = date '2026-06-01';

  if v_export_keys_first is null or cardinality(v_export_keys_first) <> 4 then
    raise exception 'Expected 4 deterministic export rows for period, got %', coalesce(cardinality(v_export_keys_first), 0);
  end if;

  select count(*)
    into v_period_export_rows_tenant_a
  from v_invoice_tax_filing_export_rows
  where filing_period_start = date '2026-06-01'
    and tenant_id = v_tenant_a_id;
  if v_period_export_rows_tenant_a <> 3 then
    raise exception 'Expected 3 tenant-a export rows for period, got %', v_period_export_rows_tenant_a;
  end if;

  select count(*)
    into v_period_export_rows_tenant_b
  from v_invoice_tax_filing_export_rows
  where filing_period_start = date '2026-06-01'
    and tenant_id = v_tenant_b_id;
  if v_period_export_rows_tenant_b <> 1 then
    raise exception 'Expected 1 tenant-b export row for period, got %', v_period_export_rows_tenant_b;
  end if;

  if v_export_keys_first <> v_export_keys_second then
    raise exception 'Expected deterministic export key ordering for filing export';
  end if;

  -- Manual overrides must include explicit reason + actor metadata.
  v_override_blocked := false;
  begin
    insert into invoice_tax_snapshots (
      invoice_id,
      tenant_id,
      invoice_version_id,
      source_event_id,
      event_type,
      snapshot_effective_at,
      determination_scope,
      audit_metadata
    )
    values (
      v_invoice_id,
      v_tenant_a_id,
      v_invoice_version_id,
      'inv-tax-001-invalid-override',
      'invoice_finalized',
      date '2026-06-20',
      'override',
      jsonb_build_object('actor', 'billing-manager@wynne.dev')
    );
  exception
    when check_violation then
      v_override_blocked := true;
  end;

  if not v_override_blocked then
    raise exception 'Expected override snapshots without reason/actor to be rejected';
  end if;

  execute 'set local role authenticated';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('app_metadata', jsonb_build_object('tenant', 'tax-test-tenant-b', 'role', 'read_only'))::text,
    true
  );

  select count(*)
    into v_cross_tenant_snapshot_visible
  from invoice_tax_snapshots
  where source_event_id = 'inv-tax-001-finalized';
  if v_cross_tenant_snapshot_visible <> 0 then
    raise exception 'Expected cross-tenant snapshot access to be denied, got % rows', v_cross_tenant_snapshot_visible;
  end if;

  select count(*)
    into v_cross_tenant_export_visible
  from v_invoice_tax_filing_export_rows
  where source_event_id = 'inv-tax-001-finalized';
  if v_cross_tenant_export_visible <> 0 then
    raise exception 'Expected cross-tenant export access to be denied, got % rows', v_cross_tenant_export_visible;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('app_metadata', jsonb_build_object('tenant', 'tax-test-tenant-a', 'role', 'custom_role'))::text,
    true
  );

  select count(*)
    into v_unapproved_role_snapshot_visible
  from invoice_tax_snapshots
  where source_event_id = 'inv-tax-001-finalized';
  if v_unapproved_role_snapshot_visible <> 0 then
    raise exception 'Expected unapproved role snapshot access to be denied, got % rows', v_unapproved_role_snapshot_visible;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('app_metadata', jsonb_build_object('tenant', 'tax-test-tenant-a', 'role', 'read_only'))::text,
    true
  );

  select count(*)
    into v_same_tenant_export_visible
  from v_invoice_tax_filing_export_rows
  where source_event_id = 'inv-tax-001-finalized';
  if v_same_tenant_export_visible <> 2 then
    raise exception 'Expected same-tenant export access for finalized event (2 rows), got %', v_same_tenant_export_visible;
  end if;

  execute 'set local role service_role';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('app_metadata', jsonb_build_object('tenant', 'tax-test-tenant-b', 'role', 'admin'))::text,
    true
  );

  select count(*)
    into v_service_cross_tenant_export_visible
  from v_invoice_tax_filing_export_rows
  where source_event_id = 'inv-tax-001-finalized';
  if v_service_cross_tenant_export_visible <> 0 then
    raise exception 'Expected service_role cross-tenant export access to be denied, got % rows', v_service_cross_tenant_export_visible;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('app_metadata', jsonb_build_object('tenant', 'tax-test-tenant-a', 'role', 'admin'))::text,
    true
  );

  select count(*)
    into v_service_same_tenant_export_visible
  from v_invoice_tax_filing_export_rows
  where source_event_id = 'inv-tax-001-finalized'
    and tenant_id = v_tenant_a_id;
  if v_service_same_tenant_export_visible <> 2 then
    raise exception 'Expected service_role same-tenant export access for finalized event (2 rows), got %', v_service_same_tenant_export_visible;
  end if;

  select count(*)
    into v_service_same_tenant_summary_visible
  from v_invoice_tax_filing_period_jurisdiction_summary
  where filing_period_start = date '2026-06-01'
    and tenant_id = v_tenant_a_id
    and jurisdiction_code = 'US-CA';
  if v_service_same_tenant_summary_visible <> 1 then
    raise exception 'Expected one same-tenant summary row for US-CA, got %', v_service_same_tenant_summary_visible;
  end if;

  execute 'reset role';
end;
$$;

rollback;
