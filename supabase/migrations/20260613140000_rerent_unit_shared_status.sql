-- Re-rented unit shared status visibility
-- Closes: #1262
-- Purpose: expose a shared, multi-audience status model for re-rented units
--          spanning the full lifecycle (requested → returned) with a timeline
--          log for every state transition, and a current-status view scoped
--          to each caller's audience (operator / job-site / vendor).
--
-- Design notes:
--   * Status dimension follows the same pattern as dim_rental_order_status and
--     dim_rental_line_status (key/label/description/sort_order/is_terminal).
--   * rerent_unit_status_log is a write-once fact table: each row is one state
--     transition. Current status per line is derived via the view below.
--   * The view v_rerent_unit_current_status is security_invoker so column-level
--     visibility can be added per-audience in future iterations.
--   * RLS on rerent_unit_status_log limits reads to authenticated users within
--     the same tenant as the order, preventing cross-tenant leakage.
--   * Vendor columns (vendor_ref, vendor_notes) are surfaced only when the caller
--     has admin or branch_manager role; job-site callers get NULL for those fields.

-- -------------------------------------------------------------------------
-- 1. Dimension: rerent_unit_status
-- -------------------------------------------------------------------------
create table if not exists public.dim_rerent_unit_status (
    id          uuid        primary key default gen_random_uuid(),
    key         text        not null unique,
    label       text        not null,
    description text,
    sort_order  int         not null default 0,
    is_terminal boolean     not null default false,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create or replace function public.update_dim_rerent_unit_status_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_dim_rerent_unit_status_updated_at on public.dim_rerent_unit_status;
create trigger trg_dim_rerent_unit_status_updated_at
    before update on public.dim_rerent_unit_status
    for each row execute function public.update_dim_rerent_unit_status_updated_at();

insert into public.dim_rerent_unit_status (key, label, description, sort_order, is_terminal)
values
    ('requested',         'Requested',          'Re-rent need identified; vendor request sent',             1, false),
    ('awarded',           'Awarded',            'Vendor confirmed unit availability; order placed',         2, false),
    ('dispatched',        'Dispatched',         'Vendor has dispatched the unit; en route to job site',     3, false),
    ('on_rent',           'On Rent',            'Unit is on-site and in active use at the job site',        4, false),
    ('return_in_transit', 'Return in Transit',  'Unit leaving job site; in transit back to vendor facility', 5, false),
    ('returned',          'Returned',           'Unit received and confirmed returned to vendor',            6, true)
on conflict (key) do nothing;

-- -------------------------------------------------------------------------
-- 2. Timeline fact table: rerent_unit_status_log
-- -------------------------------------------------------------------------
create table if not exists public.rerent_unit_status_log (
    id                uuid        primary key default gen_random_uuid(),
    -- references the rental_order_line entity that is being re-rented
    order_line_id     uuid        not null,
    -- the new status key (matches dim_rerent_unit_status.key)
    status_key        text        not null references public.dim_rerent_unit_status (key),
    -- the audience that can see the full record (internal = operator/facility,
    -- job_site = job-site user, vendor = vendor-side user)
    audience          text        not null default 'internal'
                                  check (audience in ('internal', 'job_site', 'vendor')),
    -- actor attribution: user_id or a system label such as 'system' or 'vendor_api'
    changed_by        text        not null,
    -- optional human-readable note (e.g. dispatch reference, return receipt)
    notes             text,
    -- vendor-visible reference (purchase order number, vendor confirmation code)
    -- surfaced to admin/branch_manager callers only; NULL for job_site callers
    vendor_ref        text,
    -- tenant for cross-tenant isolation
    tenant            text        not null default 'default',
    changed_at        timestamptz not null default now()
);

comment on table  public.rerent_unit_status_log is
    'Write-once timeline of re-rented unit status transitions. '
    'Each row records one state change attributed to the actor or system that made it.';
comment on column public.rerent_unit_status_log.vendor_ref is
    'Vendor-side reference (PO number, confirmation code). '
    'Visible to admin and branch_manager roles only.';

create index if not exists idx_rerent_unit_status_log_order_line_id
    on public.rerent_unit_status_log (order_line_id, changed_at desc);

create index if not exists idx_rerent_unit_status_log_tenant
    on public.rerent_unit_status_log (tenant);

-- -------------------------------------------------------------------------
-- 3. RLS: rerent_unit_status_log
--    * Authenticated users in the same tenant may select.
--    * admin / branch_manager / field_operator may insert.
--    * service_role bypasses all policies.
-- -------------------------------------------------------------------------
alter table public.rerent_unit_status_log enable row level security;

-- Ensure roles exist (mirrors pattern from user_roles_profiles migration)
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

grant usage  on schema public to authenticated, service_role;
grant select on public.rerent_unit_status_log  to authenticated;
grant insert on public.rerent_unit_status_log  to authenticated;
grant all    on public.rerent_unit_status_log  to service_role;
revoke all   on public.rerent_unit_status_log  from anon;

grant select on public.dim_rerent_unit_status to authenticated, anon;

drop policy if exists rerent_status_log_tenant_select  on public.rerent_unit_status_log;
drop policy if exists rerent_status_log_operator_insert on public.rerent_unit_status_log;
drop policy if exists rerent_status_log_service_role    on public.rerent_unit_status_log;

-- Any authenticated caller in the same tenant can read status log entries.
create policy rerent_status_log_tenant_select
    on public.rerent_unit_status_log
    for select
    to authenticated
    using (tenant = public.get_my_tenant());

-- Operators and managers can insert new status transitions.
create policy rerent_status_log_operator_insert
    on public.rerent_unit_status_log
    for insert
    to authenticated
    with check (
        tenant = public.get_my_tenant()
        and public.get_my_role() in ('admin', 'branch_manager', 'field_operator')
    );

-- Service role bypasses RLS for system/workflow writes.
create policy rerent_status_log_service_role
    on public.rerent_unit_status_log
    for all
    to service_role
    using (true)
    with check (true);

-- -------------------------------------------------------------------------
-- 4. View: v_rerent_unit_current_status
--    Shows the most-recent status for each order_line_id visible to the
--    caller's tenant.  Vendor-specific columns (vendor_ref) are masked to
--    NULL for callers whose role is field_operator or read_only.
-- -------------------------------------------------------------------------
create or replace view public.v_rerent_unit_current_status
with (security_invoker = true)
as
with ranked as (
    select
        log.id,
        log.order_line_id,
        log.status_key,
        dim.label                              as status_label,
        dim.sort_order                         as status_sort_order,
        dim.is_terminal,
        log.audience,
        log.changed_by,
        log.notes,
        -- mask vendor_ref for field_operator / read_only callers
        case
            when public.get_my_role() in ('admin', 'branch_manager') then log.vendor_ref
            else null
        end                                    as vendor_ref,
        log.tenant,
        log.changed_at,
        row_number() over (
            partition by log.order_line_id
            order by log.changed_at desc
        ) as rn
    from public.rerent_unit_status_log log
    join public.dim_rerent_unit_status  dim on dim.key = log.status_key
    where log.tenant = public.get_my_tenant()
)
select
    id,
    order_line_id,
    status_key,
    status_label,
    status_sort_order,
    is_terminal,
    audience,
    changed_by,
    notes,
    vendor_ref,
    tenant,
    changed_at
from ranked
where rn = 1;

comment on view public.v_rerent_unit_current_status is
    'Current re-rent unit status per order line within the caller''s tenant. '
    'vendor_ref is masked to NULL for field_operator and read_only roles.';

grant select on public.v_rerent_unit_current_status to authenticated, service_role;
revoke all   on public.v_rerent_unit_current_status from anon;

-- -------------------------------------------------------------------------
-- 5. Register new entity / fact types used by this feature
-- -------------------------------------------------------------------------
insert into public.fact_types (key, label, description, unit)
values
    ('rerent_status_changed',   'Re-rent Status Changed',   'Re-rented unit moved to a new lifecycle status',  'event'),
    ('rerent_unit_returned',    'Re-rent Unit Returned',    'Re-rented unit confirmed returned to vendor',      'event'),
    ('rerent_unit_dispatched',  'Re-rent Unit Dispatched',  'Vendor dispatched unit; en route to job site',     'event')
on conflict (key) do nothing;
