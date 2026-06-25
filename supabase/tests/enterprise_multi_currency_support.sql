begin;

do $$
declare
  v_invoice_id uuid;
  v_rollup_tx numeric;
  v_rollup_reporting numeric;
  v_access_count bigint;
  v_caught boolean;
  v_service_fx_id uuid;
begin
  -- FX pair/effective-date uniqueness must hold.
  insert into fx_rates (base_currency_code, quote_currency_code, rate, effective_at)
  values ('EUR', 'USD', 1.09, '2026-06-01T00:00:00Z')
  on conflict do nothing;

  begin
    insert into fx_rates (base_currency_code, quote_currency_code, rate, effective_at)
    values ('EUR', 'USD', 1.10, '2026-06-01T00:00:00Z');
    raise exception 'Expected duplicate fx_rates insert to fail for same pair/effective_at';
  exception
    when unique_violation then
      null;
  end;

  -- Access-control behavior: authenticated can read but cannot write.
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);

  select count(*)
    into v_access_count
  from fx_rates
  where base_currency_code = 'EUR'
    and quote_currency_code = 'USD';
  if v_access_count = 0 then
    raise exception 'Expected authenticated read access to fx_rates';
  end if;

  v_caught := false;
  begin
    insert into fx_rates (base_currency_code, quote_currency_code, rate, effective_at)
    values ('EUR', 'GBP', 0.85, '2026-06-01T00:00:00Z');
    raise exception 'Expected authenticated write to fx_rates to be denied';
  exception
    when insufficient_privilege then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected authenticated write to fx_rates to be blocked';
  end if;

  -- Access-control behavior: anon cannot read/write fx_rates.
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  v_caught := false;
  begin
    perform 1 from fx_rates limit 1;
    raise exception 'Expected anon read access to fx_rates to be denied';
  exception
    when insufficient_privilege then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected anon read on fx_rates to be blocked';
  end if;

  v_caught := false;
  begin
    insert into fx_rates (base_currency_code, quote_currency_code, rate, effective_at)
    values ('USD', 'EUR', 0.90, '2026-06-01T00:00:00Z');
    raise exception 'Expected anon write to fx_rates to be denied';
  exception
    when insufficient_privilege then
      v_caught := true;
  end;
  if not v_caught then
    raise exception 'Expected anon write to fx_rates to be blocked';
  end if;

  -- Access-control behavior: service_role can write and authenticated can read the write.
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  insert into fx_rates (base_currency_code, quote_currency_code, rate, effective_at)
  values ('GBP', 'USD', 1.27, '2026-06-02T00:00:00Z')
  returning id into v_service_fx_id;
  if v_service_fx_id is null then
    raise exception 'Expected service_role write to fx_rates to succeed';
  end if;

  insert into entities (entity_type, source_record_id)
  values ('invoice', 'enterprise-fx-test-invoice-001')
  returning id into v_invoice_id;

  insert into entity_versions (entity_id, version_number, data)
  values (
    v_invoice_id,
    1,
    jsonb_build_object(
      'invoice_number', 'INV-FX-001',
      'status', 'sent',
      'total', 100,
      'transaction_currency_code', 'EUR',
      'reporting_currency_code', 'USD',
      'fx_rate_applied', 1.09,
      'fx_rate_effective_at', '2026-06-01T00:00:00Z'
    )
  );

  select transaction_total_amount, reporting_total_amount
    into v_rollup_tx, v_rollup_reporting
  from v_invoice_currency_rollups
  where invoice_id = v_invoice_id;

  if v_rollup_tx <> 100 then
    raise exception 'Expected transaction_total_amount = 100, got %', v_rollup_tx;
  end if;

  if v_rollup_reporting <> 109.00 then
    raise exception 'Expected reporting_total_amount = 109.00, got %', v_rollup_reporting;
  end if;

  if not exists (
    select 1
    from v_commercial_document_currency_snapshots
    where entity_id = v_invoice_id
      and transaction_currency_code = 'EUR'
      and reporting_currency_code = 'USD'
  ) then
    raise exception 'Expected invoice currency snapshot to be exposed in v_commercial_document_currency_snapshots';
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);

  select count(*)
    into v_access_count
  from fx_rates
  where id = v_service_fx_id;
  if v_access_count <> 1 then
    raise exception 'Expected authenticated read to include service_role-written fx_rates rows';
  end if;

  perform 1
  from v_invoice_currency_rollups
  where invoice_id = v_invoice_id;
  if not found then
    raise exception 'Expected authenticated access to v_invoice_currency_rollups';
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

rollback;
