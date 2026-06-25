-- Compliance subject read model + tenant-config rule inputs for Safety & Compliance Monitor.
--
-- Provides one scoped subject record per asset/operator/checkout decision with
-- due dates, branch ownership, evidence references, tenant-configured rule inputs,
-- and explicit missing/stale/unknown prerequisite gap states.

create table if not exists public.compliance_subject_records (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  subject_type        text not null check (subject_type in ('asset', 'operator', 'checkout_decision')),
  subject_ref         text not null,
  subject_label       text,
  owning_branch_id    uuid,
  owning_branch_name  text,
  equipment_category  text,
  jurisdiction_code   text,
  regulated_category  text,
  due_date            date,
  current_state       text not null default 'unknown'
                      check (current_state in ('compliant', 'due_soon', 'overdue', 'blocked', 'unknown')),
  evidence_refs       jsonb not null default '[]'::jsonb,
  prerequisite_status jsonb not null default '[]'::jsonb,
  source_ref          text,
  source_synced_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint compliance_subject_records_tenant_subject_uniq
    unique (tenant_id, subject_type, subject_ref)
);

create index if not exists idx_compliance_subject_records_tenant_scope
  on public.compliance_subject_records (tenant_id, subject_type, due_date);

create trigger trg_compliance_subject_records_updated_at
  before update on public.compliance_subject_records
  for each row execute function public.update_updated_at();

alter table public.compliance_subject_records enable row level security;

revoke all on table public.compliance_subject_records from anon, authenticated;
grant select on table public.compliance_subject_records to authenticated;
grant select, insert, update, delete on table public.compliance_subject_records to service_role;

drop policy if exists compliance_subject_records_authenticated_read
  on public.compliance_subject_records;
create policy compliance_subject_records_authenticated_read
  on public.compliance_subject_records
  for select
  to authenticated
  using (
    public.ops_tenant_match(tenant_id)
    and public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

drop policy if exists compliance_subject_records_service_role_all
  on public.compliance_subject_records;
create policy compliance_subject_records_service_role_all
  on public.compliance_subject_records
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.compliance_rule_inputs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  subject_type        text not null check (subject_type in ('asset', 'operator', 'checkout_decision')),
  rule_key            text not null,
  rule_reference      text,
  jurisdiction_code   text,
  equipment_category  text,
  regulated_category  text,
  trigger_condition   text not null default 'always',
  required_inputs     jsonb not null default '[]'::jsonb,
  stale_after_hours   integer not null default 24,
  due_window_days     integer,
  enabled             boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint compliance_rule_inputs_stale_after_chk check (stale_after_hours >= 0)
);

create index if not exists idx_compliance_rule_inputs_tenant_scope
  on public.compliance_rule_inputs (tenant_id, subject_type, enabled);

create unique index if not exists idx_compliance_rule_inputs_scope_uniq
  on public.compliance_rule_inputs (
    tenant_id,
    subject_type,
    rule_key,
    coalesce(jurisdiction_code, ''),
    coalesce(equipment_category, ''),
    coalesce(regulated_category, '')
  );

create trigger trg_compliance_rule_inputs_updated_at
  before update on public.compliance_rule_inputs
  for each row execute function public.update_updated_at();

alter table public.compliance_rule_inputs enable row level security;

revoke all on table public.compliance_rule_inputs from anon, authenticated;
grant select on table public.compliance_rule_inputs to authenticated;
grant select, insert, update, delete on table public.compliance_rule_inputs to service_role;

drop policy if exists compliance_rule_inputs_authenticated_read
  on public.compliance_rule_inputs;
create policy compliance_rule_inputs_authenticated_read
  on public.compliance_rule_inputs
  for select
  to authenticated
  using (
    public.ops_tenant_match(tenant_id)
    and public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

drop policy if exists compliance_rule_inputs_service_role_all
  on public.compliance_rule_inputs;
create policy compliance_rule_inputs_service_role_all
  on public.compliance_rule_inputs
  for all
  to service_role
  using (true)
  with check (true);

create or replace view public.v_compliance_subject_monitor
with (security_invoker = true)
as
with subject_rule_agg as (
  select
    s.id as subject_record_id,
    coalesce(
      jsonb_agg(distinct
        jsonb_build_object(
          'rule_key', r.rule_key,
          'rule_reference', r.rule_reference,
          'trigger_condition', r.trigger_condition,
          'required_inputs', r.required_inputs,
          'stale_after_hours', r.stale_after_hours,
          'due_window_days', r.due_window_days
        )
      ) filter (where r.id is not null),
      '[]'::jsonb
    ) as rule_inputs,
    array_remove(
      array_agg(distinct req.required_key) filter (where req.required_key is not null),
      null
    ) as required_keys
  from public.compliance_subject_records s
  left join public.compliance_rule_inputs r
    on r.tenant_id = s.tenant_id
   and r.subject_type = s.subject_type
   and r.enabled
   and (r.jurisdiction_code is null or r.jurisdiction_code = s.jurisdiction_code)
   and (r.equipment_category is null or r.equipment_category = s.equipment_category)
   and (r.regulated_category is null or r.regulated_category = s.regulated_category)
  left join lateral (
    select value as required_key
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(r.required_inputs) = 'array' then r.required_inputs
        else '[]'::jsonb
      end
    )
  ) req on true
  group by s.id
)
select
  s.id::text as subject_record_id,
  s.tenant_id::text as tenant_id,
  s.subject_type,
  s.subject_ref,
  s.subject_label,
  s.due_date,
  s.current_state,
  case
    when coalesce(gaps.missing_count, 0) > 0 then 'blocked'
    when coalesce(gaps.stale_count, 0) > 0 or coalesce(gaps.unknown_count, 0) > 0 then 'unknown'
    else s.current_state
  end as compliance_state,
  s.owning_branch_id::text as owning_branch_id,
  s.owning_branch_name,
  s.equipment_category,
  s.jurisdiction_code,
  s.regulated_category,
  coalesce(s.evidence_refs, '[]'::jsonb) as evidence_refs,
  coalesce(rule_agg.rule_inputs, '[]'::jsonb) as rule_inputs,
  coalesce(gaps.evidence_gaps, '[]'::jsonb) as evidence_gaps,
  case
    when coalesce(gaps.missing_count, 0) > 0
      and (coalesce(gaps.stale_count, 0) > 0 or coalesce(gaps.unknown_count, 0) > 0)
      then 'blocked_missing_and_stale_or_unknown'
    when coalesce(gaps.missing_count, 0) > 0 then 'blocked_missing'
    when coalesce(gaps.stale_count, 0) > 0 or coalesce(gaps.unknown_count, 0) > 0 then 'blocked_stale_or_unknown'
    else 'clear'
  end as evidence_gap_state,
  s.source_ref,
  s.source_synced_at,
  s.updated_at as subject_updated_at
from public.compliance_subject_records s
left join subject_rule_agg rule_agg
  on rule_agg.subject_record_id = s.id
left join lateral (
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'required_input', detail.required_key,
          'gap_state', detail.gap_state,
          'reason', detail.reason,
          'evidence_ref', detail.evidence_ref
        )
      ) filter (where detail.gap_state is not null),
      '[]'::jsonb
    ) as evidence_gaps,
    count(*) filter (where detail.gap_state = 'missing') as missing_count,
    count(*) filter (where detail.gap_state = 'stale') as stale_count,
    count(*) filter (where detail.gap_state = 'unknown') as unknown_count
  from (
    select
      required_key.required_key,
      prereq.evidence_ref,
      case
        when prereq.required_key is null then 'missing'
        when prereq.status in ('missing', 'blocked') then 'missing'
        when prereq.status = 'stale' then 'stale'
        when prereq.status = 'unknown' then 'unknown'
        else null
      end as gap_state,
      case
        when prereq.required_key is null then format('Required input %s is missing.', required_key.required_key)
        when prereq.status in ('missing', 'blocked') then format('Required input %s is blocked or missing.', required_key.required_key)
        when prereq.status = 'stale' then format('Required input %s is stale.', required_key.required_key)
        when prereq.status = 'unknown' then format('Required input %s is unknown.', required_key.required_key)
        else null
      end as reason
    from unnest(coalesce(rule_agg.required_keys, array[]::text[])) as required_key(required_key)
    left join lateral (
      select
        nullif(item ->> 'key', '') as required_key,
        lower(coalesce(item ->> 'status', 'unknown')) as status,
        nullif(item ->> 'evidence_ref', '') as evidence_ref
      from jsonb_array_elements(
        case
          when jsonb_typeof(s.prerequisite_status) = 'array' then s.prerequisite_status
          else '[]'::jsonb
        end
      ) item
      where nullif(item ->> 'key', '') = required_key.required_key
      order by
        case lower(coalesce(item ->> 'status', 'unknown'))
          when 'ready' then 4
          when 'compliant' then 4
          when 'current' then 4
          when 'stale' then 3
          when 'unknown' then 2
          when 'missing' then 1
          else 0
        end desc
      limit 1
    ) prereq on true
  ) detail
) gaps on true;

revoke all on table public.v_compliance_subject_monitor from anon;
grant select on table public.v_compliance_subject_monitor to authenticated, service_role;
