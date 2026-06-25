-- Accounting export configuration and audit trail
-- Supports tenant-configurable export mode (xero, sage, export_only) and
-- append-only export run records for auditability.

-- ---------------------------------------------------------------------------
-- accounting_export_config
-- One active row per tenant; stores export mode, format version, and optional
-- GL/tax code remapping profiles.
-- ---------------------------------------------------------------------------

create table if not exists public.accounting_export_config (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  export_mode text not null check (export_mode in ('xero', 'sage', 'export_only')),
  format_version text not null check (format_version in ('xero_csv_v1', 'sage_intacct_gl_csv_v1', 'export_only_v1')),
  -- Optional: account code remapping { "4000-RENT": "200", ... }
  account_code_map jsonb not null default '{}'::jsonb,
  -- Optional: tax code remapping { "sales_tax": "TAX001", ... }
  tax_code_map jsonb not null default '{}'::jsonb,
  -- Free-form notes for the accountant / operator
  notes text,
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_accounting_export_config_updated_at
  before update on public.accounting_export_config
  for each row execute function public.update_updated_at();

create index if not exists idx_accounting_export_config_tenant
  on public.accounting_export_config (tenant_id, enabled);

-- Only one active (enabled = true) config per tenant is allowed.
-- Disabled configs accumulate as history; see accounting_upsert_export_config RPC.
create unique index if not exists uq_accounting_export_config_one_active_per_tenant
  on public.accounting_export_config (tenant_id)
  where enabled = true;

revoke all on table public.accounting_export_config from public, anon;
grant select on table public.accounting_export_config to authenticated;
grant select, insert, update on table public.accounting_export_config to service_role;

alter table public.accounting_export_config enable row level security;

-- Authenticated users can read their tenant's export config
drop policy if exists accounting_export_config_authenticated_read on public.accounting_export_config;
create policy accounting_export_config_authenticated_read
  on public.accounting_export_config
  for select
  to authenticated
  using (
    public.ops_tenant_match(tenant_id)
    and public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

-- All writes to accounting_export_config must go through the
-- accounting_upsert_export_config service-role RPC; direct authenticated
-- insert/update is intentionally not granted and therefore not permitted.
drop policy if exists accounting_export_config_admin_write on public.accounting_export_config;
drop policy if exists accounting_export_config_admin_update on public.accounting_export_config;

drop policy if exists accounting_export_config_service_role_all on public.accounting_export_config;
create policy accounting_export_config_service_role_all
  on public.accounting_export_config
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- accounting_export_runs
-- Append-only audit log of every export run.
-- The CSV payload is NOT stored here; it is streamed from the API response.
-- ---------------------------------------------------------------------------

create table if not exists public.accounting_export_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  export_config_id uuid references public.accounting_export_config(id) on delete set null,
  export_mode text not null check (export_mode in ('xero', 'sage', 'export_only')),
  format_version text not null check (format_version in ('xero_csv_v1', 'sage_intacct_gl_csv_v1', 'export_only_v1')),
  period_start date not null,
  period_end date not null,
  basis text check (basis in ('accrual', 'cash', 'all')),
  triggered_by text not null,
  row_count integer not null default 0,
  -- 'pending' | 'complete' | 'empty' | 'failed'
  artifact_status text not null default 'pending'
    check (artifact_status in ('pending', 'complete', 'empty', 'failed')),
  error_detail text,
  created_at timestamptz not null default now(),
  constraint chk_accounting_export_runs_period check (period_end >= period_start)
);

create index if not exists idx_accounting_export_runs_tenant_created
  on public.accounting_export_runs (tenant_id, created_at desc);

create index if not exists idx_accounting_export_runs_config
  on public.accounting_export_runs (export_config_id);

revoke all on table public.accounting_export_runs from public, anon;
grant select on table public.accounting_export_runs to authenticated;
grant select, insert on table public.accounting_export_runs to service_role;

alter table public.accounting_export_runs enable row level security;

-- Finance roles can read their tenant's export runs
drop policy if exists accounting_export_runs_authenticated_read on public.accounting_export_runs;
create policy accounting_export_runs_authenticated_read
  on public.accounting_export_runs
  for select
  to authenticated
  using (
    public.ops_tenant_match(tenant_id)
    and public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

drop policy if exists accounting_export_runs_service_role_all on public.accounting_export_runs;
create policy accounting_export_runs_service_role_all
  on public.accounting_export_runs
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Upsert export config for a tenant (admin only via service_role)
create or replace function public.accounting_upsert_export_config(
  p_tenant_id uuid,
  p_export_mode text,
  p_format_version text,
  p_account_code_map jsonb default '{}'::jsonb,
  p_tax_code_map jsonb default '{}'::jsonb,
  p_notes text default null,
  p_created_by text default null
)
returns public.accounting_export_config
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.accounting_export_config;
begin
  -- Disable any existing active config for this tenant
  update public.accounting_export_config
    set enabled = false, updated_at = now()
  where tenant_id = p_tenant_id and enabled = true;

  -- Insert the new config
  insert into public.accounting_export_config (
    tenant_id, export_mode, format_version, account_code_map,
    tax_code_map, notes, enabled, created_by
  ) values (
    p_tenant_id, p_export_mode, p_format_version, p_account_code_map,
    p_tax_code_map, p_notes, true, p_created_by
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.accounting_upsert_export_config from public, anon, authenticated;
grant execute on function public.accounting_upsert_export_config to service_role;

-- Record a completed export run (service_role only)
create or replace function public.accounting_record_export_run(
  p_tenant_id uuid,
  p_export_config_id uuid,
  p_export_mode text,
  p_format_version text,
  p_period_start date,
  p_period_end date,
  p_basis text,
  p_triggered_by text,
  p_row_count integer,
  p_artifact_status text,
  p_error_detail text default null
)
returns public.accounting_export_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.accounting_export_runs;
begin
  insert into public.accounting_export_runs (
    tenant_id, export_config_id, export_mode, format_version,
    period_start, period_end, basis, triggered_by,
    row_count, artifact_status, error_detail
  ) values (
    p_tenant_id, p_export_config_id, p_export_mode, p_format_version,
    p_period_start, p_period_end, p_basis, p_triggered_by,
    p_row_count, p_artifact_status, p_error_detail
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.accounting_record_export_run from public, anon, authenticated;
grant execute on function public.accounting_record_export_run to service_role;

comment on table public.accounting_export_config is
  'Tenant-scoped accounting export mode configuration. One active row per tenant. '
  'Controls whether exported data targets Xero, Sage Intacct, or a standalone CSV hand-off.';

comment on table public.accounting_export_runs is
  'Append-only audit log of accounting export runs. CSV payload is not stored here; '
  'it is streamed from the API response. Provides who/when/period/status auditability.';
