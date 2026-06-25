-- Accounting: auto ledger entries for invoice/payment/fee (accrual + cash basis)
--
-- Adds append-oriented accounting posting artifacts:
--   accounting_posting_rules  — configurable per-event-type debit/credit templates
--   journal_entries           — one record per source event per posting basis
--   journal_entry_lines       — individual debit/credit lines (balanced per entry)
--   v_journal_entry_gl_export — denormalised read view for GL/export consumers
--
-- Design decisions:
--   * Idempotency: (source_event_id, posting_basis) unique constraint prevents duplicates.
--   * Immutability: never UPDATE/DELETE journal_entries or journal_entry_lines; voids/
--     refunds produce new reversing journal_entries referencing reverses_entry_id.
--   * Tenant + branch scope: every entry carries tenant_id and optional branch_id.
--   * Posting basis: 'accrual' or 'cash' recorded on every entry.
--   * Write path: Temporal activity / guarded RPC only (no browser-direct inserts).

-- ---------------------------------------------------------------------------
-- Posting rules: event-type → GL account debit/credit templates
-- ---------------------------------------------------------------------------

create table if not exists public.accounting_posting_rules (
  id                 uuid         primary key default gen_random_uuid(),
  tenant_id          uuid         not null references public.tenants(id) on delete restrict,
  event_type         text         not null,
  posting_basis      text         not null,
  line_sequence      int          not null,
  side               text         not null,
  account_code       text         not null,
  account_name       text         not null,
  amount_expression  text         not null default 'subtotal',
  description_tmpl   text         not null default '',
  is_active          boolean      not null default true,
  metadata           jsonb        not null default '{}'::jsonb,
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now(),

  constraint uq_accounting_posting_rules_tenant_event_basis_seq
    unique (tenant_id, event_type, posting_basis, line_sequence),
  constraint chk_accounting_posting_rules_event_type check (
    event_type in (
      'invoice_issued',
      'invoice_void',
      'payment_applied',
      'payment_refund',
      'fee_charged',
      'credit_applied'
    )
  ),
  constraint chk_accounting_posting_rules_posting_basis check (
    posting_basis in ('accrual', 'cash')
  ),
  constraint chk_accounting_posting_rules_side check (
    side in ('debit', 'credit')
  ),
  constraint chk_accounting_posting_rules_account_code_nonempty check (
    nullif(trim(account_code), '') is not null
  )
);

create trigger trg_accounting_posting_rules_updated_at
  before update on public.accounting_posting_rules
  for each row execute function update_updated_at();

create index if not exists idx_accounting_posting_rules_lookup
  on public.accounting_posting_rules (tenant_id, event_type, posting_basis, line_sequence)
  where is_active;

-- ---------------------------------------------------------------------------
-- Journal entries: one per source event per posting basis
-- ---------------------------------------------------------------------------

create table if not exists public.journal_entries (
  id                 uuid         primary key default gen_random_uuid(),
  tenant_id          uuid         not null references public.tenants(id) on delete restrict,
  branch_id          uuid         references public.entities(id) on delete set null,
  source_event_id    text         not null,
  source_event_type  text         not null,
  source_record_id   uuid         references public.entities(id) on delete set null,
  posting_basis      text         not null,
  posting_date       date         not null,
  posted_at          timestamptz  not null default now(),
  currency_code      text         not null default 'USD',
  total_debit        numeric(19,4) not null default 0,
  total_credit       numeric(19,4) not null default 0,
  is_reversal        boolean      not null default false,
  reverses_entry_id  uuid         references public.journal_entries(id) on delete set null,
  posting_status     text         not null default 'posted',
  actor_id           text,
  actor_type         text         not null default 'system',
  audit_metadata     jsonb        not null default '{}'::jsonb,
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now(),

  constraint uq_journal_entries_source_event_basis
    unique (source_event_id, posting_basis),
  constraint chk_journal_entries_posting_basis check (
    posting_basis in ('accrual', 'cash')
  ),
  constraint chk_journal_entries_source_event_type check (
    source_event_type in (
      'invoice_issued',
      'invoice_void',
      'payment_applied',
      'payment_refund',
      'fee_charged',
      'credit_applied'
    )
  ),
  constraint chk_journal_entries_posting_status check (
    posting_status in ('posted', 'reversed', 'pending')
  ),
  constraint chk_journal_entries_actor_type check (
    actor_type in ('system', 'user', 'workflow')
  ),
  constraint chk_journal_entries_balanced check (
    total_debit = total_credit
  ),
  constraint chk_journal_entries_reversal_needs_ref check (
    is_reversal = false or reverses_entry_id is not null
  )
);

create trigger trg_journal_entries_updated_at
  before update on public.journal_entries
  for each row execute function update_updated_at();

create index if not exists idx_journal_entries_tenant_date
  on public.journal_entries (tenant_id, posting_date desc);

create index if not exists idx_journal_entries_source_record
  on public.journal_entries (source_record_id, posting_basis)
  where source_record_id is not null;

create index if not exists idx_journal_entries_source_event_id
  on public.journal_entries (source_event_id);

-- ---------------------------------------------------------------------------
-- Journal entry lines: individual debit / credit legs
-- ---------------------------------------------------------------------------

create table if not exists public.journal_entry_lines (
  id                 uuid          primary key default gen_random_uuid(),
  journal_entry_id   uuid          not null references public.journal_entries(id) on delete cascade,
  line_sequence      int           not null,
  side               text          not null,
  account_code       text          not null,
  account_name       text          not null,
  amount             numeric(19,4) not null,
  description        text          not null default '',
  metadata           jsonb         not null default '{}'::jsonb,
  created_at         timestamptz   not null default now(),

  constraint uq_journal_entry_lines_entry_seq
    unique (journal_entry_id, line_sequence),
  constraint chk_journal_entry_lines_side check (
    side in ('debit', 'credit')
  ),
  constraint chk_journal_entry_lines_amount_positive check (
    amount > 0
  ),
  constraint chk_journal_entry_lines_account_code_nonempty check (
    nullif(trim(account_code), '') is not null
  )
);

create index if not exists idx_journal_entry_lines_entry
  on public.journal_entry_lines (journal_entry_id);

create index if not exists idx_journal_entry_lines_account
  on public.journal_entry_lines (account_code);

-- ---------------------------------------------------------------------------
-- Idempotent posting function
-- ---------------------------------------------------------------------------

create or replace function public.post_journal_entry(
  p_tenant_id          uuid,
  p_branch_id          uuid,
  p_source_event_id    text,
  p_source_event_type  text,
  p_source_record_id   uuid,
  p_posting_basis      text,
  p_posting_date       date,
  p_currency_code      text,
  p_lines              jsonb,          -- array of {sequence,side,account_code,account_name,amount,description}
  p_is_reversal        boolean,
  p_reverses_entry_id  uuid,
  p_actor_id           text,
  p_actor_type         text,
  p_audit_metadata     jsonb
)
returns table (
  r_journal_entry_id uuid,
  r_is_duplicate     boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry_id      uuid;
  v_total_debit   numeric(19,4) := 0;
  v_total_credit  numeric(19,4) := 0;
  v_line          jsonb;
  v_line_side     text;
  v_line_amount   numeric(19,4);
begin
  -- Idempotency: return existing entry if already posted
  select id into v_entry_id
  from public.journal_entries
  where source_event_id = p_source_event_id
    and posting_basis    = p_posting_basis;

  if found then
    r_journal_entry_id := v_entry_id;
    r_is_duplicate     := true;
    return next;
    return;
  end if;

  -- Validate lines array is not empty
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'post_journal_entry: p_lines must be a non-empty JSON array';
  end if;

  -- Compute debit / credit totals for balance check
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_side   := v_line ->> 'side';
    v_line_amount := (v_line ->> 'amount')::numeric(19,4);

    if v_line_amount <= 0 then
      raise exception 'post_journal_entry: line amount must be positive, got %', v_line_amount;
    end if;
    if v_line_side not in ('debit', 'credit') then
      raise exception 'post_journal_entry: side must be debit or credit, got %', v_line_side;
    end if;

    if v_line_side = 'debit' then
      v_total_debit := v_total_debit + v_line_amount;
    else
      v_total_credit := v_total_credit + v_line_amount;
    end if;
  end loop;

  if round(v_total_debit, 4) <> round(v_total_credit, 4) then
    raise exception 'post_journal_entry: entry is unbalanced (debit=%, credit=%)',
      v_total_debit, v_total_credit;
  end if;

  -- Insert journal entry header
  insert into public.journal_entries (
    tenant_id, branch_id, source_event_id, source_event_type, source_record_id,
    posting_basis, posting_date, posted_at, currency_code,
    total_debit, total_credit,
    is_reversal, reverses_entry_id,
    posting_status, actor_id, actor_type, audit_metadata
  )
  values (
    p_tenant_id, p_branch_id, p_source_event_id, p_source_event_type, p_source_record_id,
    p_posting_basis, p_posting_date, now(), coalesce(p_currency_code, 'USD'),
    v_total_debit, v_total_credit,
    coalesce(p_is_reversal, false), p_reverses_entry_id,
    'posted', p_actor_id, coalesce(p_actor_type, 'system'), coalesce(p_audit_metadata, '{}'::jsonb)
  )
  returning id into v_entry_id;

  -- Insert lines
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into public.journal_entry_lines (
      journal_entry_id, line_sequence, side, account_code, account_name, amount, description, metadata
    )
    values (
      v_entry_id,
      (v_line ->> 'sequence')::int,
      v_line ->> 'side',
      v_line ->> 'account_code',
      v_line ->> 'account_name',
      (v_line ->> 'amount')::numeric(19,4),
      coalesce(v_line ->> 'description', ''),
      coalesce(v_line -> 'metadata', '{}'::jsonb)
    );
  end loop;

  -- Mark the reversed entry as 'reversed' if this is a reversal
  if coalesce(p_is_reversal, false) and p_reverses_entry_id is not null then
    update public.journal_entries
    set posting_status = 'reversed',
        updated_at     = now()
    where id = p_reverses_entry_id
      and posting_status = 'posted';
  end if;

  r_journal_entry_id := v_entry_id;
  r_is_duplicate     := false;
  return next;

exception
  -- Concurrency-safe idempotency: if a competing transaction inserted the same
  -- (source_event_id, posting_basis) between our pre-check and the header insert,
  -- the unique constraint fires. Re-fetch the winner's id and return it as a
  -- duplicate rather than propagating the error (the documented "safe on retry"
  -- guarantee must hold under concurrent fire, not just serial replay).
  when unique_violation then
    select id into v_entry_id
    from public.journal_entries
    where source_event_id = p_source_event_id
      and posting_basis    = p_posting_basis;
    r_journal_entry_id := v_entry_id;
    r_is_duplicate     := true;
    return next;
end;
$$;

revoke execute on function public.post_journal_entry(
  uuid, uuid, text, text, uuid, text, date, text, jsonb, boolean, uuid, text, text, jsonb
) from public, anon, authenticated;

grant execute on function public.post_journal_entry(
  uuid, uuid, text, text, uuid, text, date, text, jsonb, boolean, uuid, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- Default posting rules (shared/system defaults, tenant_id = null rows
-- are seeded per-tenant at activation time; these are reference defaults)
-- ---------------------------------------------------------------------------
-- NOTE: actual tenant-specific rules are inserted by the application/seed at
-- tenant on-boarding. The Temporal accounting activities derive lines directly
-- from event data; posting_rules are consumed by export/audit tooling.

-- ---------------------------------------------------------------------------
-- GL export view (security_invoker so RLS applies to caller's role)
-- ---------------------------------------------------------------------------

create or replace view public.v_journal_entry_gl_export
with (security_invoker = true) as
select
  je.id                  as journal_entry_id,
  je.tenant_id,
  je.branch_id,
  je.source_event_id,
  je.source_event_type,
  je.source_record_id,
  je.posting_basis,
  je.posting_date,
  je.posted_at,
  je.currency_code,
  je.total_debit,
  je.total_credit,
  je.is_reversal,
  je.reverses_entry_id,
  je.posting_status,
  je.actor_id,
  je.actor_type,
  je.audit_metadata,
  jel.id                 as line_id,
  jel.line_sequence,
  jel.side,
  jel.account_code,
  jel.account_name,
  jel.amount,
  jel.description        as line_description,
  jel.metadata           as line_metadata,
  concat_ws(':',
    je.posting_basis,
    je.source_event_id,
    jel.account_code,
    jel.side
  )                      as gl_export_key
from public.journal_entries je
join public.journal_entry_lines jel
  on jel.journal_entry_id = je.id;

revoke all on public.v_journal_entry_gl_export from public, anon;
grant select on public.v_journal_entry_gl_export to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select on table public.accounting_posting_rules to authenticated;
grant select, insert, update, delete on table public.accounting_posting_rules to service_role;

grant select on table public.journal_entries to authenticated;
grant select, insert, update, delete on table public.journal_entries to service_role;

grant select on table public.journal_entry_lines to authenticated;
grant select, insert, update, delete on table public.journal_entry_lines to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.accounting_posting_rules enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_entry_lines enable row level security;

-- accounting_posting_rules

drop policy if exists accounting_posting_rules_authenticated_read on public.accounting_posting_rules;
create policy accounting_posting_rules_authenticated_read
  on public.accounting_posting_rules
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

drop policy if exists accounting_posting_rules_service_role_read on public.accounting_posting_rules;
create policy accounting_posting_rules_service_role_read
  on public.accounting_posting_rules
  for select
  to service_role
  using (public.ops_tenant_match(tenant_id));

drop policy if exists accounting_posting_rules_service_role_insert on public.accounting_posting_rules;
create policy accounting_posting_rules_service_role_insert
  on public.accounting_posting_rules
  for insert
  to service_role
  with check (true);

drop policy if exists accounting_posting_rules_service_role_update on public.accounting_posting_rules;
create policy accounting_posting_rules_service_role_update
  on public.accounting_posting_rules
  for update
  to service_role
  using (true)
  with check (true);

drop policy if exists accounting_posting_rules_service_role_delete on public.accounting_posting_rules;
create policy accounting_posting_rules_service_role_delete
  on public.accounting_posting_rules
  for delete
  to service_role
  using (true);

-- journal_entries

drop policy if exists journal_entries_authenticated_read on public.journal_entries;
create policy journal_entries_authenticated_read
  on public.journal_entries
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

drop policy if exists journal_entries_service_role_read on public.journal_entries;
create policy journal_entries_service_role_read
  on public.journal_entries
  for select
  to service_role
  using (public.ops_tenant_match(tenant_id));

drop policy if exists journal_entries_service_role_insert on public.journal_entries;
create policy journal_entries_service_role_insert
  on public.journal_entries
  for insert
  to service_role
  with check (true);

drop policy if exists journal_entries_service_role_update on public.journal_entries;
create policy journal_entries_service_role_update
  on public.journal_entries
  for update
  to service_role
  using (true)
  with check (true);

drop policy if exists journal_entries_service_role_delete on public.journal_entries;
create policy journal_entries_service_role_delete
  on public.journal_entries
  for delete
  to service_role
  using (true);

-- journal_entry_lines (via parent journal_entries)

drop policy if exists journal_entry_lines_authenticated_read on public.journal_entry_lines;
create policy journal_entry_lines_authenticated_read
  on public.journal_entry_lines
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.journal_entries je
      where je.id = journal_entry_lines.journal_entry_id
        and public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
        and public.ops_tenant_match(je.tenant_id)
    )
  );

drop policy if exists journal_entry_lines_service_role_read on public.journal_entry_lines;
create policy journal_entry_lines_service_role_read
  on public.journal_entry_lines
  for select
  to service_role
  using (
    exists (
      select 1
      from public.journal_entries je
      where je.id = journal_entry_lines.journal_entry_id
        and public.ops_tenant_match(je.tenant_id)
    )
  );

drop policy if exists journal_entry_lines_service_role_insert on public.journal_entry_lines;
create policy journal_entry_lines_service_role_insert
  on public.journal_entry_lines
  for insert
  to service_role
  with check (true);

drop policy if exists journal_entry_lines_service_role_update on public.journal_entry_lines;
create policy journal_entry_lines_service_role_update
  on public.journal_entry_lines
  for update
  to service_role
  using (true)
  with check (true);

drop policy if exists journal_entry_lines_service_role_delete on public.journal_entry_lines;
create policy journal_entry_lines_service_role_delete
  on public.journal_entry_lines
  for delete
  to service_role
  using (true);
