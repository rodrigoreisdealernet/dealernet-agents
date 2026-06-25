-- Restrict accounting general-ledger access to finance audience (admin + branch_manager).

drop policy if exists accounting_posted_ledger_entries_authenticated_read on public.accounting_posted_ledger_entries;
drop policy if exists accounting_posted_ledger_entries_finance_read on public.accounting_posted_ledger_entries;
create policy accounting_posted_ledger_entries_finance_read
  on public.accounting_posted_ledger_entries
  for select
  to authenticated
  using (
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb -> 'app_metadata' ->> 'role'
      in ('admin', 'branch_manager')
  );

create or replace function public.accounting_get_general_ledger(
  p_start_date date default null,
  p_end_date date default null,
  p_customer_id uuid default null,
  p_billing_account_id uuid default null,
  p_branch_id uuid default null,
  p_gl_account_code text default null,
  p_basis text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  id uuid,
  posted_at timestamptz,
  basis text,
  customer_id uuid,
  billing_account_id uuid,
  branch_id uuid,
  gl_account_code text,
  gl_account_name text,
  counter_account_code text,
  counter_account_name text,
  source_document_type text,
  source_document_id uuid,
  source_document_number text,
  source_amount numeric,
  debit_amount numeric,
  credit_amount numeric,
  currency_code text,
  sync_status text,
  export_status text,
  source_document_path text,
  posting_batch_id uuid,
  posting_entry_id uuid,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_request_role text;
  v_app_role text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_app_role := coalesce(
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb -> 'app_metadata' ->> 'role',
    ''
  );

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and v_app_role in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'accounting_get_general_ledger requires finance read access'
      using errcode = '42501';
  end if;

  return query
  select
    gl.id,
    gl.posted_at,
    gl.basis,
    gl.customer_id,
    gl.billing_account_id,
    gl.branch_id,
    gl.gl_account_code,
    gl.gl_account_name,
    gl.counter_account_code,
    gl.counter_account_name,
    gl.source_document_type,
    gl.source_document_id,
    gl.source_document_number,
    gl.source_amount,
    gl.debit_amount,
    gl.credit_amount,
    gl.currency_code,
    gl.sync_status,
    gl.export_status,
    gl.source_document_path,
    gl.posting_batch_id,
    gl.posting_entry_id,
    gl.metadata,
    gl.created_at
  from public.accounting_general_ledger gl
  where (p_start_date is null or gl.posted_at >= p_start_date::timestamptz)
    and (p_end_date is null or gl.posted_at < (p_end_date::timestamptz + interval '1 day'))
    and (p_customer_id is null or gl.customer_id = p_customer_id)
    and (p_billing_account_id is null or gl.billing_account_id = p_billing_account_id)
    and (p_branch_id is null or gl.branch_id = p_branch_id)
    and (p_gl_account_code is null or gl.gl_account_code = p_gl_account_code)
    and (p_basis is null or gl.basis = p_basis)
  order by gl.posted_at desc, gl.source_document_number asc, gl.id asc
  limit greatest(coalesce(p_limit, 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.accounting_get_general_ledger(date, date, uuid, uuid, uuid, text, text, integer, integer) from public, anon;
grant execute on function public.accounting_get_general_ledger(date, date, uuid, uuid, uuid, text, text, integer, integer) to authenticated, service_role;
