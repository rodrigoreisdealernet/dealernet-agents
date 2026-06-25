-- Delivery complaint proof bundle and recovery routing.
--
-- Assembles delivery/pickup timestamps, route changes, branch notes,
-- proof-of-delivery artifacts, and likely recovery paths into one
-- reviewer-ready complaint case for the Market Logistics Dispatcher.
--
-- Design decisions:
--   - One canonical complaint thread per (stop_id, complaint_type) — repeated
--     updates collapse into the same row via upsert_complaint_case (no sibling
--     complaint records).
--   - Human approval remains required for all customer-facing promises, credits,
--     damage recovery, or status-changing disposition — the system only proposes.
--   - If route or POD evidence is incomplete, the system sets evidence_status =
--     'ambiguous' and leaves recovery_action = 'escalate_dispatcher' rather than
--     guessing.
--
-- Operating-model task covered:
--   market-logistics-dispatcher:t1 — triage missed/late/incorrect delivery complaints

-- ── delivery_complaint_cases ─────────────────────────────────────────────────

create table if not exists public.delivery_complaint_cases (
  id                    uuid          primary key default gen_random_uuid(),
  stop_id               uuid          not null references public.route_stops(id) on delete restrict,
  complaint_type        text          not null,
  complaint_narrative   text,
  -- Proposed recovery action (assist — human must approve before acting).
  recovery_action       text          not null default 'pending_review',
  recovery_owner        text,
  -- evidence_status: 'packaged' | 'ambiguous' | 'incomplete'
  evidence_status       text          not null default 'incomplete',
  -- Snapshot of the assembled evidence bundle at the time of last update.
  evidence_bundle       jsonb         not null default '{}'::jsonb,
  -- Disposition fields: human must set these; system never auto-fills them.
  disposed_at           timestamptz,
  disposed_by           text,
  disposition_note      text,
  requires_human_review boolean       not null default true,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  constraint delivery_complaint_cases_type_chk
    check (complaint_type in ('missed_delivery', 'late_delivery', 'incorrect_delivery', 'missed_pickup', 'late_pickup', 'incorrect_pickup', 'damage_on_delivery', 'damage_on_pickup', 'other')),
  constraint delivery_complaint_cases_recovery_action_chk
    check (recovery_action in ('pending_review', 're_run_required', 'branch_follow_up', 'escalate_dispatcher', 'escalate_branch_manager', 'document_service_failure', 'resolved')),
  constraint delivery_complaint_cases_evidence_status_chk
    check (evidence_status in ('packaged', 'ambiguous', 'incomplete'))
);

-- One open (undisposed) thread per stop + complaint type.
-- Resolved cases can accumulate as audit history.
create unique index if not exists idx_delivery_complaint_cases_open_thread
  on public.delivery_complaint_cases (stop_id, complaint_type)
  where disposed_at is null;

create index if not exists idx_delivery_complaint_cases_stop_id
  on public.delivery_complaint_cases (stop_id);

create index if not exists idx_delivery_complaint_cases_created
  on public.delivery_complaint_cases (created_at desc);

create trigger trg_delivery_complaint_cases_updated_at
  before update on public.delivery_complaint_cases
  for each row execute function update_updated_at();

-- ── Grants ────────────────────────────────────────────────────────────────────

grant select on public.delivery_complaint_cases to authenticated;
grant all    on public.delivery_complaint_cases to service_role;

-- ── Row-level security ────────────────────────────────────────────────────────

alter table public.delivery_complaint_cases enable row level security;

drop policy if exists "complaint_manager_read"  on public.delivery_complaint_cases;
drop policy if exists "complaint_service_role"  on public.delivery_complaint_cases;

-- Branch managers and admins read all complaint cases.
create policy "complaint_manager_read"
  on public.delivery_complaint_cases
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

create policy "complaint_service_role"
  on public.delivery_complaint_cases
  for all
  to service_role
  using (true)
  with check (true);

-- ── upsert_complaint_case RPC ─────────────────────────────────────────────────
--
-- Creates a new complaint case or updates the single open thread for the given
-- (stop_id, complaint_type) pair.  Repeated calls for the same open thread
-- append narrative, refresh the evidence bundle, and update the proposed
-- recovery — they never fork a sibling record.
--
-- The RPC performs a transactional advisory lock so concurrent calls for the
-- same (stop_id, complaint_type) cannot race into separate rows.

create or replace function public.upsert_complaint_case(
  p_stop_id             uuid,
  p_complaint_type      text,
  p_complaint_narrative text    default null,
  p_evidence_bundle     jsonb   default '{}'::jsonb,
  p_recovery_action     text    default 'pending_review',
  p_recovery_owner      text    default null,
  p_evidence_status     text    default 'incomplete'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app_role  text;
  v_case_id   uuid;
  v_narrative text;
begin
  v_app_role := public.ops_claim_app_role();

  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'upsert_complaint_case requires branch_manager or admin role';
  end if;

  if p_complaint_type not in (
    'missed_delivery', 'late_delivery', 'incorrect_delivery',
    'missed_pickup', 'late_pickup', 'incorrect_pickup',
    'damage_on_delivery', 'damage_on_pickup', 'other'
  ) then
    raise exception 'Invalid complaint_type: %', p_complaint_type;
  end if;

  if p_recovery_action not in (
    'pending_review', 're_run_required', 'branch_follow_up',
    'escalate_dispatcher', 'escalate_branch_manager',
    'document_service_failure', 'resolved'
  ) then
    raise exception 'Invalid recovery_action: %', p_recovery_action;
  end if;

  if p_evidence_status not in ('packaged', 'ambiguous', 'incomplete') then
    raise exception 'Invalid evidence_status: %', p_evidence_status;
  end if;

  -- Serialize concurrent submissions for the same stop + complaint type.
  perform pg_advisory_xact_lock(hashtext(p_stop_id::text || '|' || p_complaint_type));

  v_narrative := nullif(trim(p_complaint_narrative), '');

  -- Try to find an open thread for this stop + complaint type.
  select id
    into v_case_id
  from public.delivery_complaint_cases
  where stop_id = p_stop_id
    and complaint_type = p_complaint_type
    and disposed_at is null
  order by created_at desc, id desc
  limit 1
  for update;

  if found then
    -- Update the existing open thread — never create a sibling.
    update public.delivery_complaint_cases
    set
      complaint_narrative   = coalesce(v_narrative, complaint_narrative),
      evidence_bundle       = coalesce(p_evidence_bundle, evidence_bundle),
      recovery_action       = p_recovery_action,
      recovery_owner        = coalesce(p_recovery_owner, recovery_owner),
      evidence_status       = p_evidence_status,
      requires_human_review = true
    where id = v_case_id;

    return v_case_id;
  end if;

  -- No open thread — create one.
  insert into public.delivery_complaint_cases (
    stop_id,
    complaint_type,
    complaint_narrative,
    evidence_bundle,
    recovery_action,
    recovery_owner,
    evidence_status,
    requires_human_review
  ) values (
    p_stop_id,
    p_complaint_type,
    v_narrative,
    coalesce(p_evidence_bundle, '{}'::jsonb),
    p_recovery_action,
    p_recovery_owner,
    p_evidence_status,
    true
  )
  returning id into v_case_id;

  return v_case_id;
end;
$$;

revoke all on function public.upsert_complaint_case from public;
grant execute on function public.upsert_complaint_case to authenticated;

-- ── get_complaint_case RPC ────────────────────────────────────────────────────
--
-- Returns the full complaint bundle for a single complaint case, including:
--   - The complaint case record
--   - The linked stop and route context
--   - The linked POD bundle (if available)
--   - The linked open exception threads (if any)
--
-- Access: branch_manager or admin only.
-- Returns null if the case does not exist or the caller lacks access.

create or replace function public.get_complaint_case(p_case_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role  text;
  v_row       record;
begin
  v_app_role := public.ops_claim_app_role();

  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'get_complaint_case requires branch_manager or admin role'
      using errcode = '42501';
  end if;

  select
    c.id                    as case_id,
    c.complaint_type,
    c.complaint_narrative,
    c.recovery_action,
    c.recovery_owner,
    c.evidence_status,
    c.evidence_bundle,
    c.requires_human_review,
    c.disposed_at,
    c.disposed_by,
    c.disposition_note,
    c.created_at            as case_created_at,
    c.updated_at            as case_updated_at,
    -- Stop context
    s.id                    as stop_id,
    s.stop_type,
    s.sequence_order,
    s.status                as stop_status,
    s.contract_line_id,
    s.asset_id,
    s.address,
    s.customer_name,
    s.job_site_name,
    s.notes                 as stop_notes,
    s.departed_at,
    s.arrived_at,
    s.completed_at,
    -- Route context
    r.id                    as route_id,
    r.route_date,
    r.status                as route_status,
    -- POD bundle (outer join — may not exist yet)
    b.evidence_status       as pod_evidence_status,
    b.signature,
    b.condition_notes,
    b.photo_paths,
    b.completed_at          as pod_completed_at
  into v_row
  from public.delivery_complaint_cases c
  join public.route_stops s on s.id = c.stop_id
  join public.dispatch_routes r on r.id = s.route_id
  left join public.stop_pod_bundles b on b.stop_id = c.stop_id
  where c.id = p_case_id;

  if not found then
    return null;
  end if;

  return json_build_object(
    'case_id',                v_row.case_id,
    'complaint_type',         v_row.complaint_type,
    'complaint_narrative',    v_row.complaint_narrative,
    'recovery_action',        v_row.recovery_action,
    'recovery_owner',         v_row.recovery_owner,
    'evidence_status',        v_row.evidence_status,
    'evidence_bundle',        v_row.evidence_bundle,
    'requires_human_review',  v_row.requires_human_review,
    'disposed_at',            v_row.disposed_at,
    'disposed_by',            v_row.disposed_by,
    'disposition_note',       v_row.disposition_note,
    'case_created_at',        v_row.case_created_at,
    'case_updated_at',        v_row.case_updated_at,
    'stop', json_build_object(
      'stop_id',          v_row.stop_id,
      'stop_type',        v_row.stop_type,
      'sequence_order',   v_row.sequence_order,
      'stop_status',      v_row.stop_status,
      'contract_line_id', v_row.contract_line_id,
      'asset_id',         v_row.asset_id,
      'address',          v_row.address,
      'customer_name',    v_row.customer_name,
      'job_site_name',    v_row.job_site_name,
      'stop_notes',       v_row.stop_notes,
      'departed_at',      v_row.departed_at,
      'arrived_at',       v_row.arrived_at,
      'completed_at',     v_row.completed_at
    ),
    'route', json_build_object(
      'route_id',     v_row.route_id,
      'route_date',   v_row.route_date,
      'route_status', v_row.route_status
    ),
    'pod', case
      when v_row.pod_evidence_status is not null then
        json_build_object(
          'evidence_status',  v_row.pod_evidence_status,
          'signature',        v_row.signature,
          'condition_notes',  v_row.condition_notes,
          'photo_paths',      v_row.photo_paths,
          'completed_at',     v_row.pod_completed_at
        )
      else null
    end
  );
end;
$$;

revoke all on function public.get_complaint_case from public;
grant execute on function public.get_complaint_case(uuid)
  to authenticated, service_role;

-- ── v_complaint_case_review_bundle view ──────────────────────────────────────
--
-- Dispatcher-facing read model that joins each open complaint case with its
-- stop, route, POD bundle, and unresolved exception threads in one row.
-- Used by the complaint intake queue — one row per open complaint case.

create or replace view public.v_complaint_case_review_bundle
with (security_invoker = true)
as
select
  c.id                                      as case_id,
  c.stop_id,
  c.complaint_type,
  c.complaint_narrative,
  c.recovery_action,
  c.recovery_owner,
  c.evidence_status,
  c.requires_human_review,
  c.created_at                              as case_created_at,
  c.updated_at                              as case_updated_at,
  -- Stop context
  s.stop_type,
  s.status                                  as stop_status,
  s.customer_name,
  s.job_site_name,
  s.address,
  s.contract_line_id,
  s.asset_id,
  s.notes                                   as stop_notes,
  s.departed_at,
  s.arrived_at,
  s.completed_at                            as stop_completed_at,
  -- Route context
  r.id                                      as route_id,
  r.route_date,
  r.status                                  as route_status,
  -- POD evidence summary
  b.evidence_status                         as pod_evidence_status,
  b.signature                               as pod_signature,
  b.photo_paths                             as pod_photo_paths,
  b.condition_notes                         as pod_condition_notes,
  b.completed_at                            as pod_completed_at,
  -- Open exception count for this stop (quick escalation indicator)
  (
    select count(*)::int
    from public.route_stop_exceptions e
    where e.stop_id = c.stop_id
      and e.resolved_at is null
  )                                         as open_exception_count,
  -- Assembled review bundle (evidence + proposed path in one jsonb for queue handoff)
  jsonb_build_object(
    'complaint', jsonb_build_object(
      'case_id',           c.id,
      'type',              c.complaint_type,
      'narrative',         c.complaint_narrative,
      'recovery_action',   c.recovery_action,
      'recovery_owner',    c.recovery_owner,
      'evidence_status',   c.evidence_status,
      'evidence_bundle',   c.evidence_bundle,
      'requires_human_review', c.requires_human_review
    ),
    'stop', jsonb_build_object(
      'stop_id',       s.id,
      'stop_type',     s.stop_type,
      'status',        s.status,
      'customer_name', s.customer_name,
      'job_site_name', s.job_site_name,
      'address',       s.address,
      'stop_notes',    s.notes,
      'departed_at',   s.departed_at,
      'arrived_at',    s.arrived_at,
      'completed_at',  s.completed_at
    ),
    'route', jsonb_build_object(
      'route_id',    r.id,
      'route_date',  r.route_date,
      'route_status', r.status
    ),
    'pod', case
      when b.stop_id is not null then jsonb_build_object(
        'evidence_status',  b.evidence_status,
        'signature',        b.signature,
        'condition_notes',  b.condition_notes,
        'photo_paths',      to_jsonb(coalesce(b.photo_paths, '{}')),
        'completed_at',     b.completed_at
      )
      else null
    end
  )                                         as review_bundle
from public.delivery_complaint_cases c
join public.route_stops s on s.id = c.stop_id
join public.dispatch_routes r on r.id = s.route_id
left join public.stop_pod_bundles b on b.stop_id = c.stop_id
where c.disposed_at is null;

grant select on public.v_complaint_case_review_bundle to authenticated, service_role;
alter view public.v_complaint_case_review_bundle set (security_invoker = true);
