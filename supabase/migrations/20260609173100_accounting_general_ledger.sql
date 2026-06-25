-- Accounting general ledger projection (read-only query surface + filtered RPC)

create table if not exists public.accounting_posted_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  posting_batch_id uuid not null,
  posting_entry_id uuid not null,
  posted_at timestamptz not null,
  basis text not null check (basis in ('accrual', 'cash')),
  customer_id uuid,
  billing_account_id uuid,
  branch_id uuid,
  gl_account_code text not null,
  gl_account_name text not null,
  counter_account_code text,
  counter_account_name text,
  source_document_type text not null check (source_document_type in ('invoice', 'payment', 'fee', 'credit', 'refund', 'write_off')),
  source_document_id uuid not null,
  source_document_number text not null,
  source_amount numeric(18,2) not null,
  debit_amount numeric(18,2) not null default 0,
  credit_amount numeric(18,2) not null default 0,
  currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  sync_status text not null default 'not_synced',
  export_status text not null default 'not_exported',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_posted_ledger_entries_amounts_chk check (
    source_amount >= 0
    and debit_amount >= 0
    and credit_amount >= 0
    and (debit_amount > 0 or credit_amount > 0)
  ),
  constraint accounting_posted_ledger_entries_unique_source_line unique (posting_entry_id, basis, gl_account_code, counter_account_code, source_document_id)
);

create or replace function public.accounting_prevent_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'accounting_posted_ledger_entries is immutable; insert a new reversal/replacement posting row instead of mutating existing rows' using errcode = '55000';
end;
$$;

drop trigger if exists trg_accounting_posted_ledger_entries_immutable_update on public.accounting_posted_ledger_entries;
create trigger trg_accounting_posted_ledger_entries_immutable_update
  before update on public.accounting_posted_ledger_entries
  for each row execute function public.accounting_prevent_ledger_mutation();

drop trigger if exists trg_accounting_posted_ledger_entries_immutable_delete on public.accounting_posted_ledger_entries;
create trigger trg_accounting_posted_ledger_entries_immutable_delete
  before delete on public.accounting_posted_ledger_entries
  for each row execute function public.accounting_prevent_ledger_mutation();

create index if not exists idx_accounting_ledger_posted_at on public.accounting_posted_ledger_entries (posted_at desc);
create index if not exists idx_accounting_ledger_basis_posted_at on public.accounting_posted_ledger_entries (basis, posted_at desc);
create index if not exists idx_accounting_ledger_customer_posted_at on public.accounting_posted_ledger_entries (customer_id, posted_at desc);
create index if not exists idx_accounting_ledger_billing_posted_at on public.accounting_posted_ledger_entries (billing_account_id, posted_at desc);
create index if not exists idx_accounting_ledger_branch_posted_at on public.accounting_posted_ledger_entries (branch_id, posted_at desc);
create index if not exists idx_accounting_ledger_gl_posted_at on public.accounting_posted_ledger_entries (gl_account_code, posted_at desc);

revoke all on table public.accounting_posted_ledger_entries from public, anon;
grant select on table public.accounting_posted_ledger_entries to authenticated;
grant select, insert on table public.accounting_posted_ledger_entries to service_role;

alter table public.accounting_posted_ledger_entries enable row level security;

drop policy if exists accounting_posted_ledger_entries_authenticated_read on public.accounting_posted_ledger_entries;
create policy accounting_posted_ledger_entries_authenticated_read
  on public.accounting_posted_ledger_entries
  for select
  to authenticated
  using (true);

drop policy if exists accounting_posted_ledger_entries_service_role_all on public.accounting_posted_ledger_entries;
create policy accounting_posted_ledger_entries_service_role_all
  on public.accounting_posted_ledger_entries
  for all
  to service_role
  using (true)
  with check (true);

create or replace view public.accounting_general_ledger
with (security_invoker = true) as
select
  entry.id,
  entry.posted_at,
  entry.basis,
  entry.customer_id,
  entry.billing_account_id,
  entry.branch_id,
  entry.gl_account_code,
  entry.gl_account_name,
  entry.counter_account_code,
  entry.counter_account_name,
  entry.source_document_type,
  entry.source_document_id,
  entry.source_document_number,
  entry.source_amount,
  entry.debit_amount,
  entry.credit_amount,
  entry.currency_code,
  entry.sync_status,
  entry.export_status,
  format('/entities/%s/%s', entry.source_document_type, entry.source_document_id) as source_document_path,
  entry.posting_batch_id,
  entry.posting_entry_id,
  entry.metadata,
  entry.created_at
from public.accounting_posted_ledger_entries entry;

revoke all on table public.accounting_general_ledger from public, anon;
grant select on table public.accounting_general_ledger to authenticated, service_role;

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
language sql
stable
security invoker
as $$
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
$$;

revoke all on function public.accounting_get_general_ledger(date, date, uuid, uuid, uuid, text, text, integer, integer) from public, anon;
grant execute on function public.accounting_get_general_ledger(date, date, uuid, uuid, uuid, text, text, integer, integer) to authenticated, service_role;
