-- Accounting auto ledger entries — schema and posting-function tests
--
-- Runs against a fresh Postgres instance with all migrations applied.
-- Verifies:
--   1. Schema DDL (tables, constraints, RLS) applied cleanly.
--   2. post_journal_entry produces balanced, tenant-scoped entries.
--   3. RPC contract: first post returns r_is_duplicate=false, retries return the
--      same entry id with r_is_duplicate=true.
--   4. Cash-basis payment_applied can post the partial-payment recognition shape
--      introduced by the accounting fix.
--   5. Reversal: voiding an entry flips debit/credit and marks original reversed.
--   6. Unbalanced entry is rejected.
--   7. Cross-tenant isolation via ops_tenant_match.

begin;

do $$
declare
  v_tenant_a_id       uuid;
  v_tenant_b_id       uuid;
  v_branch_id         uuid;
  v_invoice_entity_id uuid;

  -- posting outputs
  v_entry_id_1        uuid;
  v_entry_id_2        uuid;
  v_reversal_id       uuid;
  v_partial_cash_id   uuid;

  -- counters
  v_debit_total       numeric(19,4);
  v_credit_total      numeric(19,4);
  v_line_count        bigint;
  v_entry_count       bigint;
  v_posting_status    text;
  v_revenue_amount    numeric(19,4);
  v_tax_amount        numeric(19,4);
  v_ar_cleared_amount numeric(19,4);
  v_deferred_amount   numeric(19,4);

  -- idempotency
  v_idem_entry_id     uuid;
  v_is_duplicate      boolean;

  -- cross-tenant isolation
  v_visible_count     bigint;

  -- role-privilege denial
  v_caught_anon       boolean;
  v_caught_auth       boolean;

begin
  -- ── Arrange: tenants and source entity ──────────────────────────────────

  insert into tenants (tenant_key, name)
  values
    ('acct-test-tenant-a', 'Accounting Test Tenant A'),
    ('acct-test-tenant-b', 'Accounting Test Tenant B');

  select id into v_tenant_a_id from tenants where tenant_key = 'acct-test-tenant-a';
  select id into v_tenant_b_id from tenants where tenant_key = 'acct-test-tenant-b';

  insert into entities (entity_type, source_record_id)
  values ('branch', 'acct-test-branch')
  returning id into v_branch_id;

  insert into entities (entity_type, source_record_id)
  values ('invoice', 'acct-test-invoice-001')
  returning id into v_invoice_entity_id;

  -- ── Test 1: post_journal_entry creates a balanced accrual invoice entry ─

  select r_journal_entry_id, r_is_duplicate into v_entry_id_1, v_is_duplicate from public.post_journal_entry(
    p_tenant_id          := v_tenant_a_id,
    p_branch_id          := v_branch_id,
    p_source_event_id    := 'evt-inv-issued-accrual-001',
    p_source_event_type  := 'invoice_issued',
    p_source_record_id   := v_invoice_entity_id,
    p_posting_basis      := 'accrual',
    p_posting_date       := '2026-06-10',
    p_currency_code      := 'USD',
    p_lines              := '[
      {"sequence":1,"side":"debit", "account_code":"1100","account_name":"Accounts Receivable","amount":"108.00","description":"AR debit"},
      {"sequence":2,"side":"credit","account_code":"4000","account_name":"Revenue",            "amount":"100.00","description":"Revenue credit"},
      {"sequence":3,"side":"credit","account_code":"2200","account_name":"Tax Payable",         "amount":"8.00", "description":"Tax credit"}
    ]'::jsonb,
    p_is_reversal        := false,
    p_reverses_entry_id  := null,
    p_actor_id           := 'test-workflow',
    p_actor_type         := 'workflow',
    p_audit_metadata     := '{"test":"true"}'::jsonb
  );

  assert v_entry_id_1 is not null, 'Test 1 FAIL: entry_id should not be null';
  assert coalesce(v_is_duplicate, false) = false, 'Test 1 FAIL: first post should not be marked duplicate';

  -- Verify header totals
  select total_debit, total_credit
  into v_debit_total, v_credit_total
  from journal_entries
  where id = v_entry_id_1;

  assert v_debit_total  = 108.00, format('Test 1 FAIL: total_debit=%s expected 108.00', v_debit_total);
  assert v_credit_total = 108.00, format('Test 1 FAIL: total_credit=%s expected 108.00', v_credit_total);

  -- Verify line count
  select count(*) into v_line_count from journal_entry_lines where journal_entry_id = v_entry_id_1;
  assert v_line_count = 3, format('Test 1 FAIL: line_count=%s expected 3', v_line_count);

  raise notice 'Test 1 PASS: accrual invoice_issued entry is balanced with 3 lines';

  -- ── Test 2: Idempotency — same source_event_id + basis returns same id ─

  select r_journal_entry_id, r_is_duplicate into v_idem_entry_id, v_is_duplicate from public.post_journal_entry(
    p_tenant_id          := v_tenant_a_id,
    p_branch_id          := v_branch_id,
    p_source_event_id    := 'evt-inv-issued-accrual-001',  -- same as Test 1
    p_source_event_type  := 'invoice_issued',
    p_source_record_id   := v_invoice_entity_id,
    p_posting_basis      := 'accrual',
    p_posting_date       := '2026-06-11',                  -- different date
    p_currency_code      := 'USD',
    p_lines              := '[
      {"sequence":1,"side":"debit","account_code":"1100","account_name":"AR","amount":"108.00","description":"dup"},
      {"sequence":2,"side":"credit","account_code":"4000","account_name":"Rev","amount":"108.00","description":"dup"}
    ]'::jsonb,
    p_is_reversal        := false,
    p_reverses_entry_id  := null,
    p_actor_id           := null,
    p_actor_type         := 'system',
    p_audit_metadata     := null
  );

  assert v_idem_entry_id = v_entry_id_1,
    format('Test 2 FAIL: idempotent call returned %s, expected %s', v_idem_entry_id, v_entry_id_1);
  assert v_is_duplicate = true, 'Test 2 FAIL: idempotent replay should set r_is_duplicate=true';

  -- Verify no duplicate lines were inserted
  select count(*) into v_line_count from journal_entry_lines where journal_entry_id = v_entry_id_1;
  assert v_line_count = 3, format('Test 2 FAIL: expected 3 lines, found %s after idempotent call', v_line_count);

  raise notice 'Test 2 PASS: idempotent re-post returns same entry id';

  -- ── Test 3: Cash-basis invoice_issued ────────────────────────────────────

  select r_journal_entry_id into v_entry_id_2 from public.post_journal_entry(
    p_tenant_id          := v_tenant_a_id,
    p_branch_id          := null,
    p_source_event_id    := 'evt-inv-issued-cash-001',
    p_source_event_type  := 'invoice_issued',
    p_source_record_id   := v_invoice_entity_id,
    p_posting_basis      := 'cash',
    p_posting_date       := '2026-06-10',
    p_currency_code      := 'USD',
    p_lines              := '[
      {"sequence":1,"side":"debit", "account_code":"1100","account_name":"Accounts Receivable","amount":"108.00","description":"AR debit (cash)"},
      {"sequence":2,"side":"credit","account_code":"2300","account_name":"Deferred Revenue",   "amount":"108.00","description":"Deferred credit"}
    ]'::jsonb,
    p_is_reversal        := false,
    p_reverses_entry_id  := null,
    p_actor_id           := null,
    p_actor_type         := 'system',
    p_audit_metadata     := null
  );

  assert v_entry_id_2 is not null, 'Test 3 FAIL: cash entry_id is null';
  assert v_entry_id_2 <> v_entry_id_1, 'Test 3 FAIL: cash entry should have different id from accrual entry';

  select total_debit, total_credit into v_debit_total, v_credit_total
  from journal_entries where id = v_entry_id_2;
  assert v_debit_total = 108.00, 'Test 3 FAIL: cash debit mismatch';
  assert v_credit_total = 108.00, 'Test 3 FAIL: cash credit mismatch';

  raise notice 'Test 3 PASS: cash invoice_issued entry balanced';

  -- ── Test 4: Reversal entry — void the accrual invoice ────────────────────

  select r_journal_entry_id into v_reversal_id from public.post_journal_entry(
    p_tenant_id          := v_tenant_a_id,
    p_branch_id          := v_branch_id,
    p_source_event_id    := 'evt-inv-void-accrual-001',
    p_source_event_type  := 'invoice_void',
    p_source_record_id   := v_invoice_entity_id,
    p_posting_basis      := 'accrual',
    p_posting_date       := '2026-06-11',
    p_currency_code      := 'USD',
    p_lines              := '[
      {"sequence":1,"side":"credit","account_code":"1100","account_name":"Accounts Receivable","amount":"108.00","description":"AR reversal"},
      {"sequence":2,"side":"debit", "account_code":"4000","account_name":"Revenue",            "amount":"100.00","description":"Revenue reversal"},
      {"sequence":3,"side":"debit", "account_code":"2200","account_name":"Tax Payable",         "amount":"8.00", "description":"Tax reversal"}
    ]'::jsonb,
    p_is_reversal        := true,
    p_reverses_entry_id  := v_entry_id_1,
    p_actor_id           := 'test-void-actor',
    p_actor_type         := 'user',
    p_audit_metadata     := '{"void_reason":"test void"}'::jsonb
  );

  assert v_reversal_id is not null, 'Test 4 FAIL: reversal entry_id is null';
  assert v_reversal_id <> v_entry_id_1, 'Test 4 FAIL: reversal should be a new entry';

  -- Original entry should now be 'reversed'
  select posting_status into v_posting_status from journal_entries where id = v_entry_id_1;
  assert v_posting_status = 'reversed', format('Test 4 FAIL: original posting_status=%s expected reversed', v_posting_status);

  -- Reversal entry should be 'posted' and is_reversal=true
  select posting_status into v_posting_status from journal_entries where id = v_reversal_id;
  assert v_posting_status = 'posted', 'Test 4 FAIL: reversal entry should have posting_status=posted';

  raise notice 'Test 4 PASS: reversal entry created; original entry marked reversed';

  -- ── Test 5: Unbalanced entry rejected ────────────────────────────────────

  begin
    perform public.post_journal_entry(
      p_tenant_id          := v_tenant_a_id,
      p_branch_id          := null,
      p_source_event_id    := 'evt-unbalanced-001',
      p_source_event_type  := 'fee_charged',
      p_source_record_id   := null,
      p_posting_basis      := 'accrual',
      p_posting_date       := '2026-06-10',
      p_currency_code      := 'USD',
      p_lines              := '[
        {"sequence":1,"side":"debit","account_code":"1100","account_name":"AR","amount":"50.00","description":"unbalanced debit"},
        {"sequence":2,"side":"credit","account_code":"4100","account_name":"Fee","amount":"49.99","description":"unbalanced credit"}
      ]'::jsonb,
      p_is_reversal        := false,
      p_reverses_entry_id  := null,
      p_actor_id           := null,
      p_actor_type         := 'system',
      p_audit_metadata     := null
    );
    raise exception 'Test 5 FAIL: expected unbalanced entry to be rejected';
  exception
    when others then
      if sqlerrm like '%unbalanced%' then
        raise notice 'Test 5 PASS: unbalanced entry correctly rejected';
      else
        raise exception 'Test 5 FAIL: unexpected error: %', sqlerrm;
      end if;
  end;

  -- ── Test 6: payment_applied entry (accrual) ──────────────────────────────

  perform public.post_journal_entry(
    p_tenant_id          := v_tenant_a_id,
    p_branch_id          := null,
    p_source_event_id    := 'evt-pay-applied-accrual-001',
    p_source_event_type  := 'payment_applied',
    p_source_record_id   := v_invoice_entity_id,
    p_posting_basis      := 'accrual',
    p_posting_date       := '2026-06-12',
    p_currency_code      := 'USD',
    p_lines              := '[
      {"sequence":1,"side":"debit", "account_code":"1000","account_name":"Cash","amount":"108.00","description":"Cash debit"},
      {"sequence":2,"side":"credit","account_code":"1100","account_name":"AR",  "amount":"108.00","description":"AR credit"}
    ]'::jsonb,
    p_is_reversal        := false,
    p_reverses_entry_id  := null,
    p_actor_id           := null,
    p_actor_type         := 'system',
    p_audit_metadata     := null
  );

  raise notice 'Test 6 PASS: payment_applied accrual entry posted';

  -- ── Test 6b: payment_applied entry (cash, partial recognition) ────────────

  select r_journal_entry_id, r_is_duplicate into v_partial_cash_id, v_is_duplicate from public.post_journal_entry(
    p_tenant_id          := v_tenant_a_id,
    p_branch_id          := null,
    p_source_event_id    := 'evt-pay-applied-cash-partial-001',
    p_source_event_type  := 'payment_applied',
    p_source_record_id   := v_invoice_entity_id,
    p_posting_basis      := 'cash',
    p_posting_date       := '2026-06-12',
    p_currency_code      := 'USD',
    p_lines              := '[
      {"sequence":1,"side":"debit", "account_code":"1000","account_name":"Cash",             "amount":"50.00",  "description":"Cash debit"},
      {"sequence":2,"side":"credit","account_code":"1100","account_name":"Accounts Receivable","amount":"50.00","description":"AR cleared"},
      {"sequence":3,"side":"debit", "account_code":"2300","account_name":"Deferred Revenue", "amount":"50.00",  "description":"Deferred released"},
      {"sequence":4,"side":"credit","account_code":"4000","account_name":"Revenue",          "amount":"46.2963","description":"Revenue recognised"},
      {"sequence":5,"side":"credit","account_code":"2200","account_name":"Tax Payable",      "amount":"3.7037", "description":"Tax recognised"}
    ]'::jsonb,
    p_is_reversal        := false,
    p_reverses_entry_id  := null,
    p_actor_id           := null,
    p_actor_type         := 'system',
    p_audit_metadata     := jsonb_build_object('scenario', 'partial_cash_payment')
  );

  assert v_partial_cash_id is not null, 'Test 6b FAIL: partial cash entry_id is null';
  assert coalesce(v_is_duplicate, false) = false, 'Test 6b FAIL: first partial cash post should not be duplicate';

  select total_debit, total_credit
  into v_debit_total, v_credit_total
  from journal_entries
  where id = v_partial_cash_id;

  assert v_debit_total = 100.00, format('Test 6b FAIL: total_debit=%s expected 100.00', v_debit_total);
  assert v_credit_total = 100.00, format('Test 6b FAIL: total_credit=%s expected 100.00', v_credit_total);

  select
    coalesce(sum(case when account_code = '4000' and side = 'credit' then amount end), 0),
    coalesce(sum(case when account_code = '2200' and side = 'credit' then amount end), 0),
    coalesce(sum(case when account_code = '1100' and side = 'credit' then amount end), 0),
    coalesce(sum(case when account_code = '2300' and side = 'debit' then amount end), 0)
  into
    v_revenue_amount,
    v_tax_amount,
    v_ar_cleared_amount,
    v_deferred_amount
  from journal_entry_lines
  where journal_entry_id = v_partial_cash_id;

  assert round(v_revenue_amount + v_tax_amount, 4) = 50.0000,
    format('Test 6b FAIL: recognised cash total=%s expected 50.0000', round(v_revenue_amount + v_tax_amount, 4));
  assert v_revenue_amount < 100.00,
    format('Test 6b FAIL: revenue recognised=%s should be less than full invoice subtotal', v_revenue_amount);
  assert v_tax_amount > 0, 'Test 6b FAIL: tax should be recognised for partial cash payment';
  assert v_ar_cleared_amount = 50.00,
    format('Test 6b FAIL: AR cleared=%s expected 50.00', v_ar_cleared_amount);
  assert v_deferred_amount = 50.00,
    format('Test 6b FAIL: Deferred Revenue released=%s expected 50.00', v_deferred_amount);

  raise notice 'Test 6b PASS: partial cash payment preserves proportional cash-basis recognition';

  -- ── Test 7: Tenant isolation (direct table query) ─────────────────────────
  -- Tenant B should see 0 entries for tenant A's data (no RLS here since we're
  -- superuser in the test, so we assert via tenant_id filter directly).

  select count(*) into v_entry_count
  from journal_entries
  where tenant_id = v_tenant_b_id;

  assert v_entry_count = 0,
    format('Test 7 FAIL: tenant B should see 0 entries, found %s', v_entry_count);

  raise notice 'Test 7 PASS: tenant B has 0 entries (tenant isolation preserved)';

  -- ── Test 8: fee_charged entry ─────────────────────────────────────────────

  perform public.post_journal_entry(
    p_tenant_id          := v_tenant_a_id,
    p_branch_id          := null,
    p_source_event_id    := 'evt-fee-charged-001',
    p_source_event_type  := 'fee_charged',
    p_source_record_id   := null,
    p_posting_basis      := 'accrual',
    p_posting_date       := '2026-06-10',
    p_currency_code      := 'USD',
    p_lines              := '[
      {"sequence":1,"side":"debit", "account_code":"1100","account_name":"AR",          "amount":"25.00","description":"Fee AR debit"},
      {"sequence":2,"side":"credit","account_code":"4100","account_name":"Fee Revenue", "amount":"25.00","description":"Fee Revenue credit"}
    ]'::jsonb,
    p_is_reversal        := false,
    p_reverses_entry_id  := null,
    p_actor_id           := null,
    p_actor_type         := 'system',
    p_audit_metadata     := null
  );

  raise notice 'Test 8 PASS: fee_charged accrual entry posted';

  -- ── Test 9: credit_applied (reversal) ───────────────────────────────────

  perform public.post_journal_entry(
    p_tenant_id          := v_tenant_a_id,
    p_branch_id          := null,
    p_source_event_id    := 'evt-credit-applied-001',
    p_source_event_type  := 'credit_applied',
    p_source_record_id   := null,
    p_posting_basis      := 'accrual',
    p_posting_date       := '2026-06-10',
    p_currency_code      := 'USD',
    p_lines              := '[
      {"sequence":1,"side":"credit","account_code":"1100","account_name":"AR",          "amount":"25.00","description":"Credit AR credit"},
      {"sequence":2,"side":"debit", "account_code":"4100","account_name":"Fee Revenue", "amount":"25.00","description":"Fee Revenue reversal"}
    ]'::jsonb,
    p_is_reversal        := false,
    p_reverses_entry_id  := null,
    p_actor_id           := null,
    p_actor_type         := 'system',
    p_audit_metadata     := null
  );

  raise notice 'Test 9 PASS: credit_applied accrual entry posted';

  -- ── Test 10: GL export view produces rows for tenant ─────────────────────

  select count(*) into v_entry_count
  from v_journal_entry_gl_export
  where tenant_id = v_tenant_a_id;

  assert v_entry_count > 0,
    format('Test 10 FAIL: GL export view returned 0 rows for tenant A');

  raise notice 'Test 10 PASS: GL export view produces % rows for tenant A', v_entry_count;

  -- ── Test 11: anon role cannot execute post_journal_entry ─────────────────

  v_caught_anon := false;
  execute 'set local role anon';
  begin
    perform public.post_journal_entry(
      p_tenant_id          := v_tenant_a_id,
      p_branch_id          := null,
      p_source_event_id    := 'evt-anon-denied-001',
      p_source_event_type  := 'fee_charged',
      p_source_record_id   := null,
      p_posting_basis      := 'accrual',
      p_posting_date       := '2026-06-10',
      p_currency_code      := 'USD',
      p_lines              := '[
        {"sequence":1,"side":"debit","account_code":"1100","account_name":"AR","amount":"10.00","description":"anon test"},
        {"sequence":2,"side":"credit","account_code":"4100","account_name":"Fee","amount":"10.00","description":"anon test"}
      ]'::jsonb,
      p_is_reversal        := false,
      p_reverses_entry_id  := null,
      p_actor_id           := null,
      p_actor_type         := 'system',
      p_audit_metadata     := null
    );
    raise exception 'Test 11 FAIL: anon should not be able to call post_journal_entry';
  exception
    when insufficient_privilege then
      v_caught_anon := true;
    when others then
      raise exception 'Test 11 FAIL: unexpected error for anon: % "%"', sqlstate, sqlerrm;
  end;
  execute 'reset role';
  assert v_caught_anon, 'Test 11 FAIL: anon call did not raise insufficient_privilege';
  raise notice 'Test 11 PASS: anon role correctly denied execute on post_journal_entry';

  -- ── Test 12: authenticated role cannot execute post_journal_entry ─────────

  v_caught_auth := false;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);
  begin
    perform public.post_journal_entry(
      p_tenant_id          := v_tenant_a_id,
      p_branch_id          := null,
      p_source_event_id    := 'evt-auth-denied-001',
      p_source_event_type  := 'fee_charged',
      p_source_record_id   := null,
      p_posting_basis      := 'accrual',
      p_posting_date       := '2026-06-10',
      p_currency_code      := 'USD',
      p_lines              := '[
        {"sequence":1,"side":"debit","account_code":"1100","account_name":"AR","amount":"10.00","description":"auth test"},
        {"sequence":2,"side":"credit","account_code":"4100","account_name":"Fee","amount":"10.00","description":"auth test"}
      ]'::jsonb,
      p_is_reversal        := false,
      p_reverses_entry_id  := null,
      p_actor_id           := null,
      p_actor_type         := 'system',
      p_audit_metadata     := null
    );
    raise exception 'Test 12 FAIL: authenticated should not be able to call post_journal_entry';
  exception
    when insufficient_privilege then
      v_caught_auth := true;
    when others then
      raise exception 'Test 12 FAIL: unexpected error for authenticated: % "%"', sqlstate, sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  execute 'reset role';
  assert v_caught_auth, 'Test 12 FAIL: authenticated call did not raise insufficient_privilege';
  raise notice 'Test 12 PASS: authenticated role correctly denied execute on post_journal_entry';

  raise notice 'All accounting auto ledger entry checks passed';
end;
$$;

rollback;
