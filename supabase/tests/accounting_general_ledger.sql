begin;

do $$
declare
  v_tenant_1 uuid := '00000000-0000-0000-0000-000000000901';
  v_tenant_2 uuid := '00000000-0000-0000-0000-000000000902';
  v_tenant_key_1 text := 'ledger-tenant-1';
  v_tenant_key_2 text := 'ledger-tenant-2';
  v_customer_1 uuid := '00000000-0000-0000-0000-000000000101';
  v_customer_2 uuid := '00000000-0000-0000-0000-000000000102';
  v_billing_1 uuid := '00000000-0000-0000-0000-000000000201';
  v_billing_2 uuid := '00000000-0000-0000-0000-000000000202';
  v_branch_1 uuid := '00000000-0000-0000-0000-000000000301';
  v_branch_2 uuid := '00000000-0000-0000-0000-000000000302';
  v_doc_invoice uuid := '00000000-0000-0000-0000-000000000401';
  v_doc_payment uuid := '00000000-0000-0000-0000-000000000402';
  v_doc_refund uuid := '00000000-0000-0000-0000-000000000403';
  v_count bigint;
  v_path text;
  v_doc text;
  v_caught boolean;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_1, v_tenant_key_1, 'Ledger Tenant 1'),
    (v_tenant_2, v_tenant_key_2, 'Ledger Tenant 2')
  on conflict (id) do update
    set tenant_key = excluded.tenant_key,
        name = excluded.name;

  insert into public.accounting_posted_ledger_entries (
    tenant_id,
    posting_batch_id,
    posting_entry_id,
    posted_at,
    basis,
    customer_id,
    billing_account_id,
    branch_id,
    gl_account_code,
    gl_account_name,
    counter_account_code,
    counter_account_name,
    source_document_type,
    source_document_id,
    source_document_number,
    source_amount,
    debit_amount,
    credit_amount,
    currency_code,
    sync_status,
    export_status
  )
  values
  (
    v_tenant_1,
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '2026-06-02T10:00:00Z',
    'accrual',
    v_customer_1,
    v_billing_1,
    v_branch_1,
    '4000-RENT',
    'Rental Revenue',
    '1200-AR',
    'Accounts Receivable',
    'invoice',
    v_doc_invoice,
    'INV-1001',
    1200.00,
    1200.00,
    0,
    'USD',
    'synced',
    'queued'
  ),
  (
    v_tenant_1,
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002',
    '2026-06-03T12:00:00Z',
    'cash',
    v_customer_1,
    v_billing_1,
    v_branch_1,
    '1000-CASH',
    'Cash',
    '1200-AR',
    'Accounts Receivable',
    'payment',
    v_doc_payment,
    'PAY-2201',
    800.00,
    0,
    800.00,
    'USD',
    'pending',
    'not_exported'
  ),
  (
    v_tenant_2,
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000003',
    '2026-06-04T09:00:00Z',
    'cash',
    v_customer_2,
    v_billing_2,
    v_branch_2,
    '4200-REFUND',
    'Refund Expense',
    '1000-CASH',
    'Cash',
    'refund',
    v_doc_refund,
    'RFND-3001',
    120.00,
    120.00,
    0,
    'USD',
    'pending',
    'not_exported'
  );

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', v_tenant_key_1, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'branch_manager',
        'tenant', v_tenant_key_1
      )
    )::text,
    true
  );

  select count(*) into v_count
  from public.accounting_get_general_ledger(
    p_start_date => '2026-06-01',
    p_end_date => '2026-06-30',
    p_basis => null,
    p_limit => 200,
    p_offset => 0
  );
  if v_count <> 2 then
    raise exception 'Expected 2 tenant-scoped rows for matching tenant finance user, got %', v_count;
  end if;

  select count(*) into v_count
  from public.accounting_get_general_ledger(
    p_start_date => '2026-06-01',
    p_end_date => '2026-06-30',
    p_customer_id => v_customer_1,
    p_billing_account_id => v_billing_1,
    p_branch_id => v_branch_1,
    p_gl_account_code => '1000-CASH',
    p_basis => 'cash',
    p_limit => 200,
    p_offset => 0
  );
  if v_count <> 1 then
    raise exception 'Expected 1 cash row filtered by customer/billing/branch/gl account, got %', v_count;
  end if;

  select count(*) into v_count
  from public.accounting_get_general_ledger(
    p_start_date => '2026-06-01',
    p_end_date => '2026-06-30',
    p_customer_id => v_customer_2,
    p_limit => 200,
    p_offset => 0
  );
  if v_count <> 0 then
    raise exception 'Expected 0 rows for non-matching tenant finance user, got %', v_count;
  end if;

  perform set_config('request.jwt.claim.tenant', v_tenant_key_2, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'branch_manager',
        'tenant', v_tenant_key_2
      )
    )::text,
    true
  );
  select count(*) into v_count
  from public.accounting_get_general_ledger(
    p_start_date => '2026-06-01',
    p_end_date => '2026-06-30',
    p_limit => 200,
    p_offset => 0
  );
  if v_count <> 1 then
    raise exception 'Expected 1 row for second matching tenant finance user, got %', v_count;
  end if;

  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  select count(*) into v_count
  from public.accounting_get_general_ledger(
    p_start_date => '2026-06-01',
    p_end_date => '2026-06-30',
    p_limit => 200,
    p_offset => 0
  );
  if v_count <> 3 then
    raise exception 'Expected 3 rows for service_role access, got %', v_count;
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', v_tenant_key_1, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'branch_manager',
        'tenant', v_tenant_key_1
      )
    )::text,
    true
  );

  select source_document_number, source_document_path
    into v_doc, v_path
  from public.accounting_get_general_ledger(
    p_start_date => '2026-06-03',
    p_end_date => '2026-06-03',
    p_customer_id => v_customer_1,
    p_basis => 'cash',
    p_limit => 10,
    p_offset => 0
  )
  limit 1;

  if v_doc <> 'PAY-2201' then
    raise exception 'Expected date-filtered document PAY-2201, got %', v_doc;
  end if;

  if v_path <> format('/entities/payment/%s', v_doc_payment) then
    raise exception 'Expected source drill-down path /entities/payment/<id>, got %', v_path;
  end if;

  select count(*) into v_count
  from public.accounting_get_general_ledger(
    p_start_date => '2026-06-01',
    p_end_date => '2026-06-30',
    p_basis => null,
    p_limit => 1,
    p_offset => 1
  );
  if v_count <> 1 then
    raise exception 'Expected pagination (limit=1, offset=1) to return one row, got %', v_count;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'read_only',
        'tenant', v_tenant_key_1
      )
    )::text,
    true
  );
  v_caught := false;
  begin
    perform 1 from public.accounting_get_general_ledger();
  exception
    when insufficient_privilege then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected non-finance authenticated role to be denied from accounting_get_general_ledger';
  end if;

  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  v_caught := false;
  begin
    perform 1 from public.accounting_get_general_ledger();
  exception
    when insufficient_privilege then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected anon access to accounting_get_general_ledger to be denied';
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

rollback;
