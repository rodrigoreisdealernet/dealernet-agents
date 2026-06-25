-- Ops Factory persistence layer (tenant-scoped config + findings + runs + drafts + read views)

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_key text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ops_agent_config (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  agent_key text not null,
  enabled boolean not null default true,
  model jsonb not null default '{}'::jsonb,
  system_prompt text,
  user_prompt_template text,
  tools jsonb not null default '[]'::jsonb,
  output_schema_key text,
  thresholds jsonb not null default '{}'::jsonb,
  bounds jsonb not null default '{}'::jsonb,
  schedule jsonb not null default '{}'::jsonb,
  auto_apply boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ops_agent_config_pk primary key (tenant_id, agent_key)
);

create table if not exists public.ops_workflow_run (
  run_id text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  workflow_key text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.finding (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  agent_key text not null,
  run_id text references public.ops_workflow_run(run_id) on delete set null,
  workflow_id text,
  contract_id uuid,
  line_item_id uuid,
  finding_type text not null,
  severity text not null,
  status text not null default 'pending_approval',
  expected jsonb not null default '{}'::jsonb,
  billed jsonb not null default '{}'::jsonb,
  delta numeric,
  evidence jsonb not null default '{}'::jsonb,
  proposed_action text,
  confidence numeric,
  rationale text,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  approver jsonb,
  constraint finding_status_chk check (status in ('pending_approval', 'approved', 'rejected', 'informational')),
  constraint finding_confidence_chk check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint finding_tenant_fingerprint_uk unique (tenant_id, fingerprint)
);

create index if not exists idx_finding_tenant_status on public.finding (tenant_id, status);
create index if not exists idx_finding_tenant_agent_created on public.finding (tenant_id, agent_key, created_at desc);

create table if not exists public.invoice_adjustment_draft (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  finding_id uuid not null references public.finding(id) on delete cascade,
  amount numeric not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  approver jsonb,
  payload jsonb not null default '{}'::jsonb,
  constraint invoice_adjustment_draft_status_chk check (status = 'draft')
);

-- Ops persistence access model (tenant-scoped authenticated read/write + service role full access)
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to authenticated, service_role;
grant execute on function auth.jwt() to authenticated, service_role;

create or replace function public.ops_claims_json()
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  v_claims_text text;
  v_claims_json jsonb;
begin
  -- request.jwt.claims is the modern PostgREST JSON claim payload; expected shape:
  -- {"app_metadata":{"tenant":"<tenant-key>","role":"<app-role>"}, ...}
  v_claims_text := nullif(current_setting('request.jwt.claims', true), '');
  if v_claims_text is not null then
    begin
      v_claims_json := v_claims_text::jsonb;
    exception
      when others then
        v_claims_json := null;
    end;
  end if;

  return coalesce(v_claims_json, auth.jwt(), '{}'::jsonb);
end;
$$;

create or replace function public.ops_claim_tenant_key()
returns text
language sql
stable
security invoker
as $$
  select coalesce(
    -- Legacy single-claim GUC fallback used by direct DB paths (e.g. SQL harnesses)
    -- that do not always provide request.jwt.claims JSON.
    nullif(current_setting('request.jwt.claim.tenant', true), ''),
    nullif(public.ops_claims_json() ->> 'tenant', ''),
    nullif(public.ops_claims_json() -> 'app_metadata' ->> 'tenant', '')
  );
$$;

create or replace function public.ops_claim_app_role()
returns text
language sql
stable
security invoker
as $$
  select coalesce(
    nullif(public.ops_claims_json() -> 'app_metadata' ->> 'role', ''),
    nullif(public.ops_claims_json() ->> 'role', '')
  );
$$;

create or replace function public.ops_tenant_match(p_tenant_id uuid)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1
    from public.tenants t
    where t.id = p_tenant_id
      and t.tenant_key = public.ops_claim_tenant_key()
  );
$$;

revoke all on table public.tenants from anon, authenticated;
grant select on table public.tenants to authenticated;
grant select, insert, update, delete on table public.tenants to service_role;

revoke all on table public.ops_agent_config from anon, authenticated;
grant select, insert, update on table public.ops_agent_config to authenticated;
grant select, insert, update, delete on table public.ops_agent_config to service_role;

revoke all on table public.ops_workflow_run from anon, authenticated;
grant select, insert, update on table public.ops_workflow_run to authenticated;
grant select, insert, update, delete on table public.ops_workflow_run to service_role;

revoke all on table public.finding from anon, authenticated;
grant select, insert, update on table public.finding to authenticated;
grant select, insert, update, delete on table public.finding to service_role;

revoke all on table public.invoice_adjustment_draft from anon, authenticated;
grant select, insert, update on table public.invoice_adjustment_draft to authenticated;
grant select, insert, update, delete on table public.invoice_adjustment_draft to service_role;

alter table public.tenants enable row level security;
alter table public.ops_agent_config enable row level security;
alter table public.ops_workflow_run enable row level security;
alter table public.finding enable row level security;
alter table public.invoice_adjustment_draft enable row level security;

drop policy if exists ops_tenants_authenticated_read on public.tenants;
drop policy if exists ops_tenants_service_role_all on public.tenants;
create policy ops_tenants_authenticated_read
  on public.tenants
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and tenant_key = public.ops_claim_tenant_key()
  );
create policy ops_tenants_service_role_all
  on public.tenants
  for all
  to service_role
  using (true)
  with check (true);

do $$
declare
  v_table text;
  v_policy_read text;
  v_policy_write_insert text;
  v_policy_write_update text;
  v_policy_service text;
  v_tenant_tables constant text[] := array[
    'ops_agent_config',
    'ops_workflow_run',
    'finding',
    'invoice_adjustment_draft'
  ];
begin
  foreach v_table in array v_tenant_tables loop
    v_policy_read := format('ops_%s_authenticated_read', v_table);
    v_policy_write_insert := format('ops_%s_authenticated_write', v_table);
    v_policy_write_update := format('ops_%s_authenticated_write_update', v_table);
    v_policy_service := format('ops_%s_service_role_all', v_table);

    execute format('drop policy if exists %I on public.%I', v_policy_read, v_table);
    execute format('drop policy if exists %I on public.%I', v_policy_write_insert, v_table);
    execute format('drop policy if exists %I on public.%I', v_policy_write_update, v_table);
    execute format('drop policy if exists %I on public.%I', v_policy_service, v_table);

    execute format(
      $p$
      create policy %2$I
        on public.%1$I
        for select
        to authenticated
        using (
          public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
          and public.ops_tenant_match(tenant_id)
        )
      $p$,
      v_table,
      v_policy_read
    );

    execute format(
      $p$
      create policy %2$I
        on public.%1$I
        for insert
        to authenticated
        with check (
          public.ops_claim_app_role() in ('admin', 'branch_manager')
          and public.ops_tenant_match(tenant_id)
        )
      $p$,
      v_table,
      v_policy_write_insert
    );

    execute format(
      $p$
      create policy %2$I
        on public.%1$I
        for update
        to authenticated
        using (
          public.ops_claim_app_role() in ('admin', 'branch_manager')
          and public.ops_tenant_match(tenant_id)
        )
        with check (
          public.ops_claim_app_role() in ('admin', 'branch_manager')
          and public.ops_tenant_match(tenant_id)
        )
      $p$,
      v_table,
      v_policy_write_update
    );

    execute format(
      $p$
      create policy %2$I
        on public.%1$I
        for all
        to service_role
        using (true)
        with check (true)
      $p$,
      v_table,
      v_policy_service
    );
  end loop;
end;
$$;

create or replace view public.ops_findings_view
with (security_invoker = true)
as
with current_entities as (
  select
    e.id as entity_id,
    e.entity_type,
    e.source_record_id,
    ev.data,
    ev.data ->> 'name' as name
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
)
select
  f.id,
  f.tenant_id,
  f.agent_key,
  f.run_id,
  f.workflow_id,
  f.contract_id,
  contract.data ->> 'contract_number' as contract_number,
  coalesce(contract.name, contract.source_record_id) as contract_label,
  f.line_item_id,
  coalesce(line_item.data ->> 'line_number', line_item.source_record_id, line_item.name) as line_item_label,
  customer.entity_id as customer_id,
  customer.name as customer_name,
  f.finding_type,
  f.severity,
  f.status,
  f.expected,
  case
    when coalesce(f.expected ->> 'amount', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      then (f.expected ->> 'amount')::numeric
    else null
  end as expected_amount,
  f.billed,
  case
    when coalesce(f.billed ->> 'amount', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      then (f.billed ->> 'amount')::numeric
    else null
  end as billed_amount,
  f.delta,
  f.evidence,
  f.proposed_action,
  f.confidence,
  f.rationale,
  f.fingerprint,
  f.created_at,
  f.decided_at,
  f.approver
from public.finding f
left join current_entities contract
  on contract.entity_id = f.contract_id
 and contract.entity_type = 'rental_contract'
left join current_entities line_item
  on line_item.entity_id = f.line_item_id
 and line_item.entity_type = 'rental_contract_line'
left join current_entities customer
  on customer.entity_id = case
    when coalesce(contract.data ->> 'customer_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (contract.data ->> 'customer_id')::uuid
    else null
  end
 and customer.entity_type = 'customer';

create or replace view public.ops_finding_kpis
with (security_invoker = true)
as
select
  t.id as tenant_id,
  count(*) filter (where f.status = 'pending_approval') as pending_count,
  coalesce(sum(case when f.status in ('pending_approval', 'approved') then coalesce(f.delta, 0) else 0 end), 0) as recoverable_delta,
  count(*) filter (
    where f.status = 'approved'
      and date_trunc('month', f.decided_at) = date_trunc('month', now())
  ) as approved_this_cycle,
  count(*) filter (where f.created_at >= now() - interval '24 hours') as findings_last_24h
from public.tenants t
left join public.finding f
  on f.tenant_id = t.id
group by t.id;

create or replace view public.ops_agent_status_view
with (security_invoker = true)
as
select
  c.tenant_id,
  c.agent_key,
  c.enabled,
  c.auto_apply,
  last_run.run_id as last_run_id,
  last_run.started_at as last_run_started_at,
  last_run.finished_at as last_run_finished_at,
  last_run.status as last_run_status,
  case
    when coalesce(c.schedule ->> 'next_run_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}$'
      or coalesce(c.schedule ->> 'next_run_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?$'
      then (c.schedule ->> 'next_run_at')::timestamptz
    else null
  end as next_run_at,
  run_counts.total_runs,
  run_counts.succeeded_runs,
  run_counts.failed_runs,
  pending.pending_findings,
  (pending.pending_findings > 0) as has_pending_badge
from public.ops_agent_config c
left join lateral (
  select
    r.run_id,
    r.started_at,
    r.finished_at,
    r.status
  from public.ops_workflow_run r
  where r.tenant_id = c.tenant_id
    and r.workflow_key = c.agent_key
  order by r.started_at desc nulls last
  limit 1
) as last_run on true
left join lateral (
  select
    count(*) as total_runs,
    count(*) filter (where r.status = 'succeeded') as succeeded_runs,
    count(*) filter (where r.status = 'failed') as failed_runs
  from public.ops_workflow_run r
  where r.tenant_id = c.tenant_id
    and r.workflow_key = c.agent_key
) as run_counts on true
left join lateral (
  select
    count(*) as pending_findings
  from public.finding f
  where f.tenant_id = c.tenant_id
    and f.agent_key = c.agent_key
    and f.status = 'pending_approval'
) as pending on true;

create or replace view public.ops_audit_trail_view
with (security_invoker = true)
as
select
  tsp.entity_id,
  e.entity_type,
  ev.data ->> 'name' as entity_name,
  tsp.fact_type_id,
  ft.key as fact_key,
  ft.label as fact_label,
  tsp.observed_at,
  tsp.data_payload,
  tsp.metadata,
  tsp.source_id,
  tsp.created_at,
  row_number() over (
    partition by tsp.entity_id
    order by tsp.observed_at, tsp.created_at, tsp.id
  ) as point_order
from public.time_series_points tsp
join public.entities e
  on e.id = tsp.entity_id
left join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
join public.fact_types ft
  on ft.id = tsp.fact_type_id;
