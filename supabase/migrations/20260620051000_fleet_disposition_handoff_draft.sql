-- Draft handoff artifact for approved fleet disposition decisions.
-- Captures lifecycle/procurement handoff intent without executing sell/PO actions.

create table if not exists public.fleet_disposition_handoff_draft (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  finding_id uuid not null references public.finding(id) on delete cascade,
  disposition text not null,
  handoff_path text not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  approver jsonb,
  payload jsonb not null default '{}'::jsonb,
  constraint fleet_disposition_handoff_disposition_chk check (disposition in ('keep', 'sell', 'replace')),
  constraint fleet_disposition_handoff_path_chk check (handoff_path in ('lifecycle', 'procurement')),
  constraint fleet_disposition_handoff_status_chk check (status = 'draft')
);

create index if not exists idx_fleet_disposition_handoff_tenant_finding
  on public.fleet_disposition_handoff_draft (tenant_id, finding_id);

revoke all on table public.fleet_disposition_handoff_draft from anon, authenticated;
grant select on table public.fleet_disposition_handoff_draft to authenticated;
grant select, insert, update, delete on table public.fleet_disposition_handoff_draft to service_role;

alter table public.fleet_disposition_handoff_draft enable row level security;

drop policy if exists fleet_disposition_handoff_tenant_read on public.fleet_disposition_handoff_draft;
create policy fleet_disposition_handoff_tenant_read
  on public.fleet_disposition_handoff_draft
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

drop policy if exists fleet_disposition_handoff_service_role_all on public.fleet_disposition_handoff_draft;
create policy fleet_disposition_handoff_service_role_all
  on public.fleet_disposition_handoff_draft
  for all
  to service_role
  using (true)
  with check (true);
