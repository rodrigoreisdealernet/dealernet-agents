-- Accounting tax filing snapshots
-- Stores invoice-time tax determination snapshots and exposes deterministic
-- jurisdiction/period summaries + export rows for filing preparation.

create table if not exists tax_jurisdictions (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_code text not null unique,
  jurisdiction_name text not null,
  country_code text not null,
  region_code text,
  level text not null default 'other',
  parent_jurisdiction_id uuid references tax_jurisdictions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_tax_jurisdictions_country_code_format check (country_code ~ '^[A-Z]{2}$'),
  constraint chk_tax_jurisdictions_level check (level in ('country', 'state', 'county', 'city', 'district', 'other'))
);

create trigger trg_tax_jurisdictions_updated_at
  before update on tax_jurisdictions
  for each row execute function update_updated_at();

create table if not exists tax_jurisdiction_rates (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null references tax_jurisdictions(id) on delete cascade,
  tax_code text not null default 'sales_tax',
  rate numeric(9,6) not null,
  effective_from date not null,
  effective_to date,
  is_exempt boolean not null default false,
  exemption_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_tax_jurisdiction_rates_rate_nonnegative check (rate >= 0),
  constraint chk_tax_jurisdiction_rates_effective_window check (effective_to is null or effective_to >= effective_from),
  constraint chk_tax_jurisdiction_rates_exemption_reason check (
    is_exempt = false or nullif(trim(coalesce(exemption_reason, '')), '') is not null
  )
);

create unique index if not exists idx_tax_jurisdiction_rates_effective_from_unique
  on tax_jurisdiction_rates (jurisdiction_id, tax_code, effective_from, is_exempt);

create index if not exists idx_tax_jurisdiction_rates_lookup
  on tax_jurisdiction_rates (jurisdiction_id, tax_code, effective_from desc);

create trigger trg_tax_jurisdiction_rates_updated_at
  before update on tax_jurisdiction_rates
  for each row execute function update_updated_at();

create table if not exists invoice_tax_snapshots (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references entities(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  invoice_version_id uuid references entity_versions(id) on delete set null,
  source_event_id text not null,
  event_type text not null,
  snapshot_effective_at date not null,
  finalized_at timestamptz not null default now(),
  billing_account_id uuid references entities(id) on delete set null,
  branch_id uuid references entities(id) on delete set null,
  job_site_id uuid references entities(id) on delete set null,
  service_location_id uuid references entities(id) on delete set null,
  determination_scope text not null,
  override_reason text,
  override_actor text,
  override_metadata jsonb not null default '{}'::jsonb,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_invoice_tax_snapshots_source_event unique (source_event_id),
  constraint chk_invoice_tax_snapshots_event_type check (
    event_type in ('invoice_finalized', 'credit', 'refund', 'void')
  ),
  constraint chk_invoice_tax_snapshots_scope check (
    determination_scope in ('branch', 'billing_account', 'job_site', 'service_location', 'override')
  ),
  constraint chk_invoice_tax_snapshots_override_metadata check (
    determination_scope <> 'override'
    or (
      nullif(trim(coalesce(override_reason, '')), '') is not null
      and nullif(trim(coalesce(override_actor, '')), '') is not null
    )
  )
);

create index if not exists idx_invoice_tax_snapshots_invoice_effective
  on invoice_tax_snapshots (invoice_id, snapshot_effective_at);

create index if not exists idx_invoice_tax_snapshots_period_jurisdiction_context
  on invoice_tax_snapshots (tenant_id, snapshot_effective_at, billing_account_id, branch_id, job_site_id);

create index if not exists idx_invoice_tax_snapshots_period_context
  on invoice_tax_snapshots (snapshot_effective_at, billing_account_id, branch_id, job_site_id);

create trigger trg_invoice_tax_snapshots_updated_at
  before update on invoice_tax_snapshots
  for each row execute function update_updated_at();

create table if not exists invoice_tax_jurisdiction_snapshots (
  id uuid primary key default gen_random_uuid(),
  invoice_tax_snapshot_id uuid not null references invoice_tax_snapshots(id) on delete cascade,
  jurisdiction_id uuid not null references tax_jurisdictions(id),
  jurisdiction_rate_id uuid references tax_jurisdiction_rates(id) on delete set null,
  jurisdiction_code text not null,
  tax_code text not null default 'sales_tax',
  tax_rate numeric(9,6) not null,
  taxable_amount numeric(14,2) not null default 0,
  exempt_amount numeric(14,2) not null default 0,
  collected_tax_amount numeric(14,2) not null default 0,
  exemption_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_invoice_tax_jurisdiction_tax_rate_nonnegative check (tax_rate >= 0),
  constraint chk_invoice_tax_jurisdiction_amounts_nonnegative check (
    taxable_amount >= 0 and exempt_amount >= 0 and collected_tax_amount >= 0
  ),
  constraint chk_invoice_tax_jurisdiction_exemption_reason check (
    exempt_amount = 0 or nullif(trim(coalesce(exemption_reason, '')), '') is not null
  )
);

create index if not exists idx_invoice_tax_jurisdiction_snapshot_parent
  on invoice_tax_jurisdiction_snapshots (invoice_tax_snapshot_id);

create trigger trg_invoice_tax_jurisdiction_snapshots_updated_at
  before update on invoice_tax_jurisdiction_snapshots
  for each row execute function update_updated_at();

create table if not exists invoice_line_tax_snapshots (
  id uuid primary key default gen_random_uuid(),
  invoice_tax_snapshot_id uuid not null references invoice_tax_snapshots(id) on delete cascade,
  invoice_line_id uuid references entities(id) on delete set null,
  line_source_key text,
  jurisdiction_id uuid not null references tax_jurisdictions(id),
  jurisdiction_rate_id uuid references tax_jurisdiction_rates(id) on delete set null,
  jurisdiction_code text not null,
  tax_code text not null default 'sales_tax',
  tax_rate numeric(9,6) not null,
  taxable_amount numeric(14,2) not null default 0,
  exempt_amount numeric(14,2) not null default 0,
  collected_tax_amount numeric(14,2) not null default 0,
  exemption_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_invoice_line_tax_tax_rate_nonnegative check (tax_rate >= 0),
  constraint chk_invoice_line_tax_amounts_nonnegative check (
    taxable_amount >= 0 and exempt_amount >= 0 and collected_tax_amount >= 0
  ),
  constraint chk_invoice_line_tax_exemption_reason check (
    exempt_amount = 0 or nullif(trim(coalesce(exemption_reason, '')), '') is not null
  )
);

create index if not exists idx_invoice_line_tax_snapshots_parent
  on invoice_line_tax_snapshots (invoice_tax_snapshot_id, invoice_line_id);

create trigger trg_invoice_line_tax_snapshots_updated_at
  before update on invoice_line_tax_snapshots
  for each row execute function update_updated_at();

-- Privileges + RLS: authenticated reads filing outputs; service_role writes snapshots.
revoke all on table public.tax_jurisdictions from public, anon;
grant select on table public.tax_jurisdictions to authenticated;
grant select, insert, update, delete on table public.tax_jurisdictions to service_role;

revoke all on table public.tax_jurisdiction_rates from public, anon;
grant select on table public.tax_jurisdiction_rates to authenticated;
grant select, insert, update, delete on table public.tax_jurisdiction_rates to service_role;

revoke all on table public.invoice_tax_snapshots from public, anon;
grant select on table public.invoice_tax_snapshots to authenticated;
grant select, insert, update, delete on table public.invoice_tax_snapshots to service_role;

revoke all on table public.invoice_tax_jurisdiction_snapshots from public, anon;
grant select on table public.invoice_tax_jurisdiction_snapshots to authenticated;
grant select, insert, update, delete on table public.invoice_tax_jurisdiction_snapshots to service_role;

revoke all on table public.invoice_line_tax_snapshots from public, anon;
grant select on table public.invoice_line_tax_snapshots to authenticated;
grant select, insert, update, delete on table public.invoice_line_tax_snapshots to service_role;

alter table public.tax_jurisdictions enable row level security;
alter table public.tax_jurisdiction_rates enable row level security;
alter table public.invoice_tax_snapshots enable row level security;
alter table public.invoice_tax_jurisdiction_snapshots enable row level security;
alter table public.invoice_line_tax_snapshots enable row level security;

drop policy if exists tax_jurisdictions_authenticated_read on public.tax_jurisdictions;
create policy tax_jurisdictions_authenticated_read
  on public.tax_jurisdictions
  for select
  to authenticated
  using (public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only'));

drop policy if exists tax_jurisdictions_service_role_all on public.tax_jurisdictions;
create policy tax_jurisdictions_service_role_all
  on public.tax_jurisdictions
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists tax_jurisdiction_rates_authenticated_read on public.tax_jurisdiction_rates;
create policy tax_jurisdiction_rates_authenticated_read
  on public.tax_jurisdiction_rates
  for select
  to authenticated
  using (public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only'));

drop policy if exists tax_jurisdiction_rates_service_role_all on public.tax_jurisdiction_rates;
create policy tax_jurisdiction_rates_service_role_all
  on public.tax_jurisdiction_rates
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists invoice_tax_snapshots_authenticated_read on public.invoice_tax_snapshots;
create policy invoice_tax_snapshots_authenticated_read
  on public.invoice_tax_snapshots
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

drop policy if exists invoice_tax_snapshots_service_role_all on public.invoice_tax_snapshots;
drop policy if exists invoice_tax_snapshots_service_role_read on public.invoice_tax_snapshots;
create policy invoice_tax_snapshots_service_role_read
  on public.invoice_tax_snapshots
  for select
  to service_role
  using (public.ops_tenant_match(tenant_id));

drop policy if exists invoice_tax_snapshots_service_role_insert on public.invoice_tax_snapshots;
create policy invoice_tax_snapshots_service_role_insert
  on public.invoice_tax_snapshots
  for insert
  to service_role
  with check (true);

drop policy if exists invoice_tax_snapshots_service_role_update on public.invoice_tax_snapshots;
create policy invoice_tax_snapshots_service_role_update
  on public.invoice_tax_snapshots
  for update
  to service_role
  using (true)
  with check (true);

drop policy if exists invoice_tax_snapshots_service_role_delete on public.invoice_tax_snapshots;
create policy invoice_tax_snapshots_service_role_delete
  on public.invoice_tax_snapshots
  for delete
  to service_role
  using (true);

drop policy if exists invoice_tax_jurisdiction_snapshots_authenticated_read on public.invoice_tax_jurisdiction_snapshots;
create policy invoice_tax_jurisdiction_snapshots_authenticated_read
  on public.invoice_tax_jurisdiction_snapshots
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.invoice_tax_snapshots s
      where s.id = invoice_tax_jurisdiction_snapshots.invoice_tax_snapshot_id
        and public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
        and public.ops_tenant_match(s.tenant_id)
    )
  );

drop policy if exists invoice_tax_jurisdiction_snapshots_service_role_all on public.invoice_tax_jurisdiction_snapshots;
drop policy if exists invoice_tax_jurisdiction_snapshots_service_role_read on public.invoice_tax_jurisdiction_snapshots;
create policy invoice_tax_jurisdiction_snapshots_service_role_read
  on public.invoice_tax_jurisdiction_snapshots
  for select
  to service_role
  using (
    exists (
      select 1
      from public.invoice_tax_snapshots s
      where s.id = invoice_tax_jurisdiction_snapshots.invoice_tax_snapshot_id
        and public.ops_tenant_match(s.tenant_id)
    )
  );

drop policy if exists invoice_tax_jurisdiction_snapshots_service_role_insert on public.invoice_tax_jurisdiction_snapshots;
create policy invoice_tax_jurisdiction_snapshots_service_role_insert
  on public.invoice_tax_jurisdiction_snapshots
  for insert
  to service_role
  with check (true);

drop policy if exists invoice_tax_jurisdiction_snapshots_service_role_update on public.invoice_tax_jurisdiction_snapshots;
create policy invoice_tax_jurisdiction_snapshots_service_role_update
  on public.invoice_tax_jurisdiction_snapshots
  for update
  to service_role
  using (true)
  with check (true);

drop policy if exists invoice_tax_jurisdiction_snapshots_service_role_delete on public.invoice_tax_jurisdiction_snapshots;
create policy invoice_tax_jurisdiction_snapshots_service_role_delete
  on public.invoice_tax_jurisdiction_snapshots
  for delete
  to service_role
  using (true);

drop policy if exists invoice_line_tax_snapshots_authenticated_read on public.invoice_line_tax_snapshots;
create policy invoice_line_tax_snapshots_authenticated_read
  on public.invoice_line_tax_snapshots
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.invoice_tax_snapshots s
      where s.id = invoice_line_tax_snapshots.invoice_tax_snapshot_id
        and public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
        and public.ops_tenant_match(s.tenant_id)
    )
  );

drop policy if exists invoice_line_tax_snapshots_service_role_all on public.invoice_line_tax_snapshots;
drop policy if exists invoice_line_tax_snapshots_service_role_read on public.invoice_line_tax_snapshots;
create policy invoice_line_tax_snapshots_service_role_read
  on public.invoice_line_tax_snapshots
  for select
  to service_role
  using (
    exists (
      select 1
      from public.invoice_tax_snapshots s
      where s.id = invoice_line_tax_snapshots.invoice_tax_snapshot_id
        and public.ops_tenant_match(s.tenant_id)
    )
  );

drop policy if exists invoice_line_tax_snapshots_service_role_insert on public.invoice_line_tax_snapshots;
create policy invoice_line_tax_snapshots_service_role_insert
  on public.invoice_line_tax_snapshots
  for insert
  to service_role
  with check (true);

drop policy if exists invoice_line_tax_snapshots_service_role_update on public.invoice_line_tax_snapshots;
create policy invoice_line_tax_snapshots_service_role_update
  on public.invoice_line_tax_snapshots
  for update
  to service_role
  using (true)
  with check (true);

drop policy if exists invoice_line_tax_snapshots_service_role_delete on public.invoice_line_tax_snapshots;
create policy invoice_line_tax_snapshots_service_role_delete
  on public.invoice_line_tax_snapshots
  for delete
  to service_role
  using (true);

create or replace view v_invoice_tax_filing_period_jurisdiction_summary
with (security_invoker = true) as
with normalized as (
  select
    s.id as invoice_tax_snapshot_id,
    s.tenant_id,
    s.invoice_id,
    s.source_event_id,
    s.event_type,
    s.snapshot_effective_at,
    date_trunc('month', s.snapshot_effective_at)::date as filing_period_start,
    (date_trunc('month', s.snapshot_effective_at) + interval '1 month - 1 day')::date as filing_period_end,
    s.billing_account_id,
    s.branch_id,
    s.job_site_id,
    coalesce(s.service_location_id, s.job_site_id) as service_location_id,
    js.jurisdiction_id,
    js.jurisdiction_code,
    j.jurisdiction_name,
    js.tax_code,
    js.tax_rate,
    js.taxable_amount,
    js.exempt_amount,
    js.collected_tax_amount,
    case
      when s.event_type in ('credit', 'refund', 'void') then -1::numeric
      else 1::numeric
    end as event_sign,
    case
      when s.event_type in ('credit', 'refund', 'void') then js.collected_tax_amount
      else 0::numeric
    end as refunded_tax_amount
  from invoice_tax_snapshots s
  join invoice_tax_jurisdiction_snapshots js
    on js.invoice_tax_snapshot_id = s.id
  left join tax_jurisdictions j
    on j.id = js.jurisdiction_id
)
select
  tenant_id,
  filing_period_start,
  filing_period_end,
  jurisdiction_id,
  jurisdiction_code,
  jurisdiction_name,
  round(sum(taxable_amount * event_sign), 2) as taxable_amount,
  round(sum(exempt_amount * event_sign), 2) as exempt_amount,
  round(sum(collected_tax_amount * event_sign), 2) as collected_tax_amount,
  round(sum(refunded_tax_amount), 2) as refunded_tax_amount,
  count(distinct invoice_tax_snapshot_id) as tax_event_count
from normalized
group by tenant_id, filing_period_start, filing_period_end, jurisdiction_id, jurisdiction_code, jurisdiction_name;

revoke all on table public.v_invoice_tax_filing_period_jurisdiction_summary from public, anon;
grant select on table public.v_invoice_tax_filing_period_jurisdiction_summary to authenticated, service_role;

create or replace view v_invoice_tax_filing_export_rows
with (security_invoker = true) as
select
  s.tenant_id,
  date_trunc('month', s.snapshot_effective_at)::date as filing_period_start,
  (date_trunc('month', s.snapshot_effective_at) + interval '1 month - 1 day')::date as filing_period_end,
  s.source_event_id,
  s.event_type,
  s.snapshot_effective_at,
  s.finalized_at,
  s.invoice_id,
  s.billing_account_id,
  s.branch_id,
  s.job_site_id,
  coalesce(s.service_location_id, s.job_site_id) as service_location_id,
  s.determination_scope,
  s.override_reason,
  s.override_actor,
  s.audit_metadata,
  js.id as invoice_tax_jurisdiction_snapshot_id,
  js.jurisdiction_id,
  js.jurisdiction_code,
  j.jurisdiction_name,
  js.jurisdiction_rate_id,
  js.tax_code,
  js.tax_rate,
  js.taxable_amount,
  js.exempt_amount,
  js.collected_tax_amount,
  case
    when s.event_type in ('credit', 'refund', 'void') then -js.collected_tax_amount
    else js.collected_tax_amount
  end as signed_collected_tax_amount,
  case
    when s.event_type in ('credit', 'refund', 'void') then js.collected_tax_amount
    else 0::numeric
  end as refunded_tax_amount,
  concat_ws(':',
    to_char(date_trunc('month', s.snapshot_effective_at), 'YYYY-MM'),
    js.jurisdiction_code,
    s.source_event_id,
    js.id::text
  ) as export_row_key
from invoice_tax_snapshots s
join invoice_tax_jurisdiction_snapshots js
  on js.invoice_tax_snapshot_id = s.id
left join tax_jurisdictions j
  on j.id = js.jurisdiction_id;

revoke all on table public.v_invoice_tax_filing_export_rows from public, anon;
grant select on table public.v_invoice_tax_filing_export_rows to authenticated, service_role;
