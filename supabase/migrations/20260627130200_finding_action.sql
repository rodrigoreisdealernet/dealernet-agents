-- Issue #73: execute the recommended action after a vehicle-aging finding is
-- approved. `finding_action` is the auditable, idempotent record of the side
-- effect applied to the vehicle (markdown / disposition / monitor no-op).
--
-- Access model differs from invoice_adjustment_draft: the UI is READ-ONLY here.
-- Only the backend service_role writes execution records; authenticated users
-- may read their own tenant's rows but cannot insert/alter them.

create table if not exists public.finding_action (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  finding_id uuid not null references public.finding(id) on delete cascade,
  vehicle_id uuid,
  action_type text not null,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  executed_at timestamptz not null default now(),
  approver jsonb,
  created_at timestamptz not null default now(),
  constraint finding_action_status_chk check (status in ('executed', 'pending_execution', 'failed')),
  -- One action row per finding == idempotency key for "execute after approval".
  constraint finding_action_finding_uk unique (finding_id)
);

create index if not exists idx_finding_action_tenant_status on public.finding_action (tenant_id, status);

alter table public.finding_action enable row level security;

revoke all on table public.finding_action from anon, authenticated;
grant select on table public.finding_action to authenticated;
grant select, insert, update, delete on table public.finding_action to service_role;

drop policy if exists ops_finding_action_authenticated_read on public.finding_action;
drop policy if exists ops_finding_action_service_role_all on public.finding_action;

-- UI-READ-ONLY: tenant-scoped read for authenticated operators. No insert/update
-- policy for authenticated -> they cannot create or alter execution records.
create policy ops_finding_action_authenticated_read
  on public.finding_action
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

-- service_role retains full access to write execution records.
create policy ops_finding_action_service_role_all
  on public.finding_action
  for all
  to service_role
  using (true)
  with check (true);

-- Audit fact type used by the ops decision API when it records action
-- execution / disposition events into time_series_points. Without this row the
-- async audit writer (app.py append_audit_event) silently skips, so the
-- "audited no-op" (monitor) and "audited dismiss" requirements would be unmet.
insert into public.fact_types (key, label, description, unit)
values ('ops_audit_event', 'Ops Audit Event', 'Audit trail for ops agent action execution and finding dispositions', 'event')
on conflict (key) do nothing;
