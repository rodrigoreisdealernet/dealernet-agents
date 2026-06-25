-- Driver and operator compliance readiness queue — backing tables and views
-- Created: 2026-06-19
-- Purpose: Provides the four Supabase views consumed by the compliance
--          readiness queue route (/ops/compliance-readiness-queue):
--            v_driver_qualification_exceptions
--            v_hos_exceptions_current
--            v_operator_cert_exceptions
--            v_training_compliance_exceptions
--
--          Each view is backed by a write-through table populated by the
--          ELD/LMS/HR integration layer (or Temporal workers). The frontend
--          reads read-only views; writes flow through service_role only.
--
-- Operating-model tags:
--   safety-compliance-manager:t2 (DOT qualification oversight)
--   safety-compliance-manager:t4 (HOS / operator certification)
--   safety-compliance-manager:t7 (training currency / recertification)

-- ---------------------------------------------------------------------------
-- 1. driver_qualification_records
--    One row per driver per qualification type. Refreshed by the DOT/FMCSA
--    integration worker; status transitions drive the exception surface.
-- ---------------------------------------------------------------------------

create table if not exists public.driver_qualification_records (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  person_id           uuid        not null,
  person_name         text        not null,
  branch_id           uuid,
  branch_name         text,
  equipment_class     text        not null default 'CDL fleet',
  qualification_type  text        not null,
  expiry_date         date,
  status              text        not null default 'active',
  cited_rule          text        not null default '49 CFR 391 — Driver Qualification Files',
  evidence_ref        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint driver_qual_status_chk
    check (status in ('active', 'expiring', 'expired', 'suspended', 'waived'))
);

create index if not exists idx_driver_qual_tenant_person
  on public.driver_qualification_records (tenant_id, person_id);

create index if not exists idx_driver_qual_expiry
  on public.driver_qualification_records (expiry_date)
  where expiry_date is not null;

create trigger trg_driver_qual_updated_at
  before update on public.driver_qualification_records
  for each row execute function public.update_updated_at();

alter table public.driver_qualification_records enable row level security;

revoke all on table public.driver_qualification_records from anon, authenticated;
grant select on table public.driver_qualification_records to authenticated;
grant select, insert, update, delete on table public.driver_qualification_records to service_role;

drop policy if exists driver_qual_authenticated_read on public.driver_qualification_records;
create policy driver_qual_authenticated_read
  on public.driver_qualification_records
  for select
  to authenticated
  using (
    public.ops_tenant_match(tenant_id)
    and public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

drop policy if exists driver_qual_service_role_all on public.driver_qualification_records;
create policy driver_qual_service_role_all
  on public.driver_qualification_records
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- 2. hos_exception_log
--    One row per ELD-detected HOS exception. Rows remain active until the
--    integration worker sets resolved_at after the exception is cleared.
-- ---------------------------------------------------------------------------

create table if not exists public.hos_exception_log (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  person_id           uuid        not null,
  person_name         text        not null,
  branch_id           uuid,
  branch_name         text,
  equipment_class     text        not null default 'CDL fleet',
  violation_type      text        not null,
  violation_date      date,
  cited_rule          text        not null default '49 CFR 395 — Hours of Service',
  evidence_ref        text,
  severity            text        not null default 'warning',
  resolved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint hos_severity_chk
    check (severity in ('warning', 'critical'))
);

create index if not exists idx_hos_log_tenant_person
  on public.hos_exception_log (tenant_id, person_id);

create index if not exists idx_hos_log_unresolved
  on public.hos_exception_log (tenant_id, resolved_at)
  where resolved_at is null;

create trigger trg_hos_log_updated_at
  before update on public.hos_exception_log
  for each row execute function public.update_updated_at();

alter table public.hos_exception_log enable row level security;

revoke all on table public.hos_exception_log from anon, authenticated;
grant select on table public.hos_exception_log to authenticated;
grant select, insert, update, delete on table public.hos_exception_log to service_role;

drop policy if exists hos_log_authenticated_read on public.hos_exception_log;
create policy hos_log_authenticated_read
  on public.hos_exception_log
  for select
  to authenticated
  using (
    public.ops_tenant_match(tenant_id)
    and public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

drop policy if exists hos_log_service_role_all on public.hos_exception_log;
create policy hos_log_service_role_all
  on public.hos_exception_log
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- 3. operator_cert_records
--    One row per operator per certification type (OSHA lift ticket, aerial
--    work platform, etc.). Refreshed by the LMS/HR integration worker.
-- ---------------------------------------------------------------------------

create table if not exists public.operator_cert_records (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  person_id           uuid        not null,
  person_name         text        not null,
  branch_id           uuid,
  branch_name         text,
  equipment_class     text        not null default 'Regulated equipment',
  certification_type  text        not null,
  expiry_date         date,
  status              text        not null default 'active',
  cited_rule          text        not null default 'OSHA 29 CFR 1910.178 / 1926.1427 — Operator Certification',
  evidence_ref        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint operator_cert_status_chk
    check (status in ('active', 'expiring', 'expired', 'suspended', 'waived'))
);

create index if not exists idx_operator_cert_tenant_person
  on public.operator_cert_records (tenant_id, person_id);

create index if not exists idx_operator_cert_expiry
  on public.operator_cert_records (expiry_date)
  where expiry_date is not null;

create trigger trg_operator_cert_updated_at
  before update on public.operator_cert_records
  for each row execute function public.update_updated_at();

alter table public.operator_cert_records enable row level security;

revoke all on table public.operator_cert_records from anon, authenticated;
grant select on table public.operator_cert_records to authenticated;
grant select, insert, update, delete on table public.operator_cert_records to service_role;

drop policy if exists operator_cert_authenticated_read on public.operator_cert_records;
create policy operator_cert_authenticated_read
  on public.operator_cert_records
  for select
  to authenticated
  using (
    public.ops_tenant_match(tenant_id)
    and public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

drop policy if exists operator_cert_service_role_all on public.operator_cert_records;
create policy operator_cert_service_role_all
  on public.operator_cert_records
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- 4. personnel_training_records
--    One row per person per required training module. Refreshed from the LMS;
--    status transitions from 'pending' → 'overdue' when due_date passes.
-- ---------------------------------------------------------------------------

create table if not exists public.personnel_training_records (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  person_id           uuid        not null,
  person_name         text        not null,
  branch_id           uuid,
  branch_name         text,
  equipment_class     text        not null default 'General safety',
  training_type       text        not null,
  due_date            date,
  status              text        not null default 'pending',
  cited_rule          text        not null default 'Internal training policy / OSHA recordkeeping',
  evidence_ref        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint personnel_training_status_chk
    check (status in ('pending', 'scheduled', 'overdue', 'completed', 'waived'))
);

create index if not exists idx_personnel_training_tenant_person
  on public.personnel_training_records (tenant_id, person_id);

create index if not exists idx_personnel_training_due
  on public.personnel_training_records (due_date)
  where due_date is not null and status not in ('completed', 'waived');

create trigger trg_personnel_training_updated_at
  before update on public.personnel_training_records
  for each row execute function public.update_updated_at();

alter table public.personnel_training_records enable row level security;

revoke all on table public.personnel_training_records from anon, authenticated;
grant select on table public.personnel_training_records to authenticated;
grant select, insert, update, delete on table public.personnel_training_records to service_role;

drop policy if exists personnel_training_authenticated_read on public.personnel_training_records;
create policy personnel_training_authenticated_read
  on public.personnel_training_records
  for select
  to authenticated
  using (
    public.ops_tenant_match(tenant_id)
    and public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

drop policy if exists personnel_training_service_role_all on public.personnel_training_records;
create policy personnel_training_service_role_all
  on public.personnel_training_records
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- 5. v_driver_qualification_exceptions
--    Surfaces qualifications that are expired or expiring within 30 days.
--    The classification engine (lib/compliance-readiness-queue.ts) applies
--    fine-grained blocking/follow-up logic on top; the view pre-filters to
--    keep the PostgREST payload small.
-- ---------------------------------------------------------------------------

create or replace view public.v_driver_qualification_exceptions
with (security_invoker = true)
as
select
  person_id::text          as person_id,
  person_name,
  branch_id::text          as branch_id,
  branch_name,
  equipment_class,
  qualification_type,
  expiry_date,
  status,
  cited_rule,
  evidence_ref
from public.driver_qualification_records
where
  status = 'expired'
  or (
    expiry_date is not null
    and expiry_date <= (current_date + interval '30 days')
    and status != 'expired'
  );

revoke all on public.v_driver_qualification_exceptions from anon;
grant select on public.v_driver_qualification_exceptions to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. v_hos_exceptions_current
--    Surfaces all unresolved HOS violations. The view intentionally returns
--    all severities so the classification engine can tier them.
-- ---------------------------------------------------------------------------

create or replace view public.v_hos_exceptions_current
with (security_invoker = true)
as
select
  person_id::text          as person_id,
  person_name,
  branch_id::text          as branch_id,
  branch_name,
  equipment_class,
  violation_type,
  violation_date,
  cited_rule,
  evidence_ref,
  severity
from public.hos_exception_log
where resolved_at is null;

revoke all on public.v_hos_exceptions_current from anon;
grant select on public.v_hos_exceptions_current to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. v_operator_cert_exceptions
--    Surfaces certifications that are expired or expiring within 30 days.
-- ---------------------------------------------------------------------------

create or replace view public.v_operator_cert_exceptions
with (security_invoker = true)
as
select
  person_id::text          as person_id,
  person_name,
  branch_id::text          as branch_id,
  branch_name,
  equipment_class,
  certification_type,
  expiry_date,
  status,
  cited_rule,
  evidence_ref
from public.operator_cert_records
where
  status = 'expired'
  or (
    expiry_date is not null
    and expiry_date <= (current_date + interval '30 days')
    and status != 'expired'
  );

revoke all on public.v_operator_cert_exceptions from anon;
grant select on public.v_operator_cert_exceptions to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. v_training_compliance_exceptions
--    Surfaces training records that are overdue or due within 30 days and
--    not yet completed or waived.
-- ---------------------------------------------------------------------------

create or replace view public.v_training_compliance_exceptions
with (security_invoker = true)
as
select
  person_id::text          as person_id,
  person_name,
  branch_id::text          as branch_id,
  branch_name,
  equipment_class,
  training_type,
  due_date,
  status,
  cited_rule,
  evidence_ref
from public.personnel_training_records
where
  status not in ('completed', 'waived')
  and (
    status = 'overdue'
    or (
      due_date is not null
      and due_date <= (current_date + interval '30 days')
    )
  );

revoke all on public.v_training_compliance_exceptions from anon;
grant select on public.v_training_compliance_exceptions to authenticated, service_role;
