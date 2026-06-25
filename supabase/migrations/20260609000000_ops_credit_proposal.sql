-- Credit-change proposal table: gated write target for the credit-analyst agent.
-- When the credit manager approves a credit finding, the workflow inserts a row here
-- with the proposed limit/hold/terms change.  Nothing is applied automatically to
-- customer terms — a downstream billing process or manual action consumes this table.

create table if not exists public.credit_change_proposal (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  finding_id uuid not null references public.finding(id) on delete cascade,
  account_id uuid,
  proposed_action text not null,
  proposed_credit_limit numeric,
  proposed_terms text,
  proposed_hold boolean not null default false,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  approver jsonb,
  payload jsonb not null default '{}'::jsonb,
  constraint credit_change_proposal_status_chk check (status = 'draft')
);

create index if not exists idx_credit_change_proposal_tenant_finding
  on public.credit_change_proposal (tenant_id, finding_id);

create index if not exists idx_credit_change_proposal_tenant_account
  on public.credit_change_proposal (tenant_id, account_id);

-- Register credit_proposal_v1 in the output schema registry.
insert into public.ops_output_schema_registry (schema_key, schema_json, description)
values (
  'credit_proposal_v1',
  '{"type":"object","required":["account_id","risk_level","proposed_action","rationale"]}'::jsonb,
  'Credit & risk analyst proposal output schema v1'
)
on conflict (schema_key) do update
  set schema_json  = excluded.schema_json,
      description  = excluded.description,
      updated_at   = now();

-- RLS / grants ---------------------------------------------------------------

revoke all on table public.credit_change_proposal from anon, authenticated;
-- authenticated may read proposals for their own tenant; only service_role (the temporal
-- worker) may write rows — this is a gated workflow write target, not a UI write path.
grant select on table public.credit_change_proposal to authenticated;
grant select, insert, update, delete on table public.credit_change_proposal to service_role;

alter table public.credit_change_proposal enable row level security;

-- Tenant-scoped read: users may only see proposals for their own tenant.
-- Uses the same helpers as every other ops table: ops_claim_app_role() for role
-- gating and ops_tenant_match() for tenant isolation.
drop policy if exists "credit_change_proposal_tenant_read" on public.credit_change_proposal;
create policy "credit_change_proposal_tenant_read"
  on public.credit_change_proposal
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

-- service_role has unrestricted access for the temporal workflow writer.
create policy "credit_change_proposal_service_role_all"
  on public.credit_change_proposal
  for all
  to service_role
  using (true)
  with check (true);
