-- Credit review and lien-deadline control assistant (t2, t4, t5)
-- Adds:
--   • ops_agent_config entry for credit-lien-control (t2 / t4 / t5)
--   • ops_output_schema_registry entries for credit_application_proposal_v1,
--     lien_deadline_proposal_v1, lien_waiver_proposal_v1
--   • credit_application table — pending credit-application requests
--   • lien_deadline_obligation table — per-contract lien tracking
--   • lien_waiver_obligation table — per-payment waiver tracking

-- ---------------------------------------------------------------------------
-- Output schemas
-- ---------------------------------------------------------------------------

insert into public.ops_output_schema_registry (schema_key, schema_json, description)
values (
  'credit_application_proposal_v1',
  '{
    "type":"object",
    "required":["application_id","risk_level","recommended_action","rationale"],
    "properties":{
      "application_id":{"type":"string"},
      "customer_id":{"type":"string"},
      "account_id":{"type":"string"},
      "risk_level":{"type":"string","enum":["low","medium","high","critical"]},
      "recommended_action":{"type":"string","enum":["approve","approve_with_conditions","deny","request_more_info","manual_review","no_op"]},
      "proposed_credit_limit":{"type":"number"},
      "proposed_terms":{"type":"string"},
      "current_credit_limit":{"type":"number"},
      "requested_credit_limit":{"type":"number"},
      "operating_model_tags":{"type":"array","items":{"type":"string"}},
      "evidence":{"type":"array"},
      "stale_inputs":{"type":"array","items":{"type":"string"}},
      "material_signal_key":{"type":"string"},
      "confidence":{"type":"number"},
      "rationale":{"type":"string"}
    }
  }'::jsonb,
  'Credit application creditworthiness review proposal v1 — t2'
),
(
  'lien_deadline_proposal_v1',
  '{
    "type":"object",
    "required":["obligation_id","urgency","recommended_action","rationale"],
    "properties":{
      "obligation_id":{"type":"string"},
      "project_id":{"type":"string"},
      "account_id":{"type":"string"},
      "state":{"type":"string"},
      "deadline_date":{"type":["string","null"]},
      "days_remaining":{"type":["integer","null"]},
      "deadline_type":{"type":"string","enum":["preliminary_notice","lien_filing","claim_on_bond","no_notice_required","unknown"]},
      "urgency":{"type":"string","enum":["overdue","critical","warning","ok","not_required","unknown_jurisdiction"]},
      "notice_sent":{"type":"boolean"},
      "recommended_action":{"type":"string","enum":["send_notice","schedule_notice","acknowledge_no_action_required","manual_review","escalate_missing_data","no_op"]},
      "operating_model_tags":{"type":"array","items":{"type":"string"}},
      "evidence":{"type":"array"},
      "stale_inputs":{"type":"array","items":{"type":"string"}},
      "material_signal_key":{"type":"string"},
      "confidence":{"type":"number"},
      "rationale":{"type":"string"}
    }
  }'::jsonb,
  'Lien preliminary-notice deadline tracking proposal v1 — t4'
),
(
  'lien_waiver_proposal_v1',
  '{
    "type":"object",
    "required":["obligation_id","waiver_type","waiver_status","recommended_action","rationale"],
    "properties":{
      "obligation_id":{"type":"string"},
      "project_id":{"type":"string"},
      "account_id":{"type":"string"},
      "payment_id":{"type":"string"},
      "waiver_type":{"type":"string","enum":["conditional_partial","unconditional_partial","conditional_final","unconditional_final","unknown"]},
      "payment_amount":{"type":"number"},
      "waiver_status":{"type":"string","enum":["pending_receipt","received","missing","expired","sent_awaiting_return","not_required"]},
      "recommended_action":{"type":"string","enum":["request_waiver","confirm_waiver_received","close_obligation","manual_review","no_op"]},
      "operating_model_tags":{"type":"array","items":{"type":"string"}},
      "evidence":{"type":"array"},
      "stale_inputs":{"type":"array","items":{"type":"string"}},
      "material_signal_key":{"type":"string"},
      "confidence":{"type":"number"},
      "rationale":{"type":"string"}
    }
  }'::jsonb,
  'Lien waiver tracking proposal v1 — t5'
)
on conflict (schema_key) do update
  set schema_json  = excluded.schema_json,
      description  = excluded.description,
      updated_at   = now();

-- ---------------------------------------------------------------------------
-- Agent config — insert for every tenant that already exists at migration time.
-- Fresh installs (no tenants yet) will have configs seeded by seed.sql instead.
-- ---------------------------------------------------------------------------

do $$
declare
  v_tenant record;
begin
  -- Zero iterations is expected and safe on a fresh install where no tenants
  -- exist yet; those environments will receive config rows via seed.sql.
  for v_tenant in select id from public.tenants loop
    insert into public.ops_agent_config (
      agent_key,
      tenant_id,
      enabled,
      system_prompt,
      user_prompt_template,
      thresholds,
      bounds
    ) values (
      'credit-lien-control',
      v_tenant.id,
      true,
      'You are a credit review and lien-deadline control assistant for an equipment-rental company. '
      'For credit applications (t2): assemble creditworthiness evidence and propose a limit/terms recommendation for analyst approval — never apply limits automatically. '
      'For lien deadlines (t4): deadline dates are provided deterministically; your role is to assemble project and contract evidence and propose whether to send or schedule a notice — never send automatically. '
      'For lien waivers (t5): surface outstanding waiver obligations alongside incoming payments and propose closeout actions for analyst approval — never close obligations automatically. '
      'Escalate explicitly when project, state, or payment evidence is incomplete rather than fabricating compliance confidence.',
      'Review obligation {obligation_id} for tenant {tenant_id}. Proposed action: {recommended_action}. Evidence:\n{evidence_json}',
      jsonb_build_object(
        'min_confidence_to_surface', 0.6,
        'max_applications', 100,
        'max_obligations', 100
      ),
      jsonb_build_object(
        'max_findings_per_run', 50,
        'max_tool_rounds', 5
      )
    )
    on conflict (tenant_id, agent_key) do update
      set system_prompt        = excluded.system_prompt,
          user_prompt_template = excluded.user_prompt_template,
          thresholds           = excluded.thresholds,
          bounds               = excluded.bounds,
          updated_at           = now();
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- credit_application — pending credit applications awaiting analyst review
-- ---------------------------------------------------------------------------

create table if not exists public.credit_application (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  customer_id          uuid references public.entities(id) on delete set null,
  account_id           uuid references public.entities(id) on delete set null,
  customer_name        text not null default '',
  requested_credit_limit numeric(15,2) not null default 0,
  current_credit_limit   numeric(15,2) not null default 0,
  requested_terms      text not null default '',
  notes                text not null default '',
  status               text not null default 'pending_review'
                         check (status in ('pending_review','approved','approved_with_conditions','denied','more_info_requested','cancelled')),
  rental_data          jsonb not null default '{}',
  submitted_at         timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists credit_application_tenant_status_idx
  on public.credit_application (tenant_id, status);

revoke all on table public.credit_application from anon, authenticated;
grant select, insert, update on table public.credit_application to authenticated;
grant select, insert, update, delete on table public.credit_application to service_role;

alter table public.credit_application enable row level security;

drop policy if exists "credit_application_select" on public.credit_application;
drop policy if exists "credit_application_insert" on public.credit_application;
drop policy if exists "credit_application_update" on public.credit_application;
drop policy if exists "credit_application_service_role_all" on public.credit_application;

create policy "credit_application_select"
  on public.credit_application
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

create policy "credit_application_insert"
  on public.credit_application
  for insert
  to authenticated
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

create policy "credit_application_update"
  on public.credit_application
  for update
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  )
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

create policy "credit_application_service_role_all"
  on public.credit_application
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- lien_deadline_obligation — per-contract preliminary-notice tracking (t4)
-- ---------------------------------------------------------------------------

create table if not exists public.lien_deadline_obligation (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  project_id            uuid references public.entities(id) on delete set null,
  account_id            uuid references public.entities(id) on delete set null,
  customer_name         text not null default '',
  project_name          text not null default '',
  state                 char(2) not null,
  first_furnishing_date date not null,
  notice_sent           boolean not null default false,
  notice_sent_at        timestamptz,
  rental_data           jsonb not null default '{}',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists lien_deadline_obligation_tenant_idx
  on public.lien_deadline_obligation (tenant_id);

create index if not exists lien_deadline_obligation_notice_sent_idx
  on public.lien_deadline_obligation (tenant_id, notice_sent);

revoke all on table public.lien_deadline_obligation from anon, authenticated;
grant select, insert, update on table public.lien_deadline_obligation to authenticated;
grant select, insert, update, delete on table public.lien_deadline_obligation to service_role;

alter table public.lien_deadline_obligation enable row level security;

drop policy if exists "lien_deadline_select" on public.lien_deadline_obligation;
drop policy if exists "lien_deadline_insert" on public.lien_deadline_obligation;
drop policy if exists "lien_deadline_update" on public.lien_deadline_obligation;
drop policy if exists "lien_deadline_service_role_all" on public.lien_deadline_obligation;

create policy "lien_deadline_select"
  on public.lien_deadline_obligation
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

create policy "lien_deadline_insert"
  on public.lien_deadline_obligation
  for insert
  to authenticated
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

create policy "lien_deadline_update"
  on public.lien_deadline_obligation
  for update
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  )
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

create policy "lien_deadline_service_role_all"
  on public.lien_deadline_obligation
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- lien_waiver_obligation — per-payment waiver tracking (t5)
-- ---------------------------------------------------------------------------

create table if not exists public.lien_waiver_obligation (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  project_id     uuid references public.entities(id) on delete set null,
  account_id     uuid references public.entities(id) on delete set null,
  payment_id     uuid,
  customer_name  text not null default '',
  waiver_type    text not null
                   check (waiver_type in ('conditional_partial','unconditional_partial','conditional_final','unconditional_final','unknown')),
  payment_amount numeric(15,2) not null default 0,
  payment_date   date,
  waiver_status  text not null default 'pending_receipt'
                   check (waiver_status in ('pending_receipt','received','missing','expired','sent_awaiting_return','not_required')),
  rental_data    jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists lien_waiver_obligation_tenant_idx
  on public.lien_waiver_obligation (tenant_id);

create index if not exists lien_waiver_obligation_status_idx
  on public.lien_waiver_obligation (tenant_id, waiver_status);

revoke all on table public.lien_waiver_obligation from anon, authenticated;
grant select, insert, update on table public.lien_waiver_obligation to authenticated;
grant select, insert, update, delete on table public.lien_waiver_obligation to service_role;

alter table public.lien_waiver_obligation enable row level security;

drop policy if exists "lien_waiver_select" on public.lien_waiver_obligation;
drop policy if exists "lien_waiver_insert" on public.lien_waiver_obligation;
drop policy if exists "lien_waiver_update" on public.lien_waiver_obligation;
drop policy if exists "lien_waiver_service_role_all" on public.lien_waiver_obligation;

create policy "lien_waiver_select"
  on public.lien_waiver_obligation
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

create policy "lien_waiver_insert"
  on public.lien_waiver_obligation
  for insert
  to authenticated
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

create policy "lien_waiver_update"
  on public.lien_waiver_obligation
  for update
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  )
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

create policy "lien_waiver_service_role_all"
  on public.lien_waiver_obligation
  for all
  to service_role
  using (true)
  with check (true);
