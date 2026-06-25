-- ---------------------------------------------------------------------------
-- Procurement requisitions + approval routing
--
-- Adds:
--   procurement_approval_step_templates      - configurable routing rules with
--                                              purchasing-limit brackets
--   procurement_requisition_approvals        - per-requisition approval steps
--   procurement_requisition_approval_audit   - explicit approve/reject trail
--   procurement_submit_requisition(...)      - create requisitions for
--                                              equipment/parts/merchandise
--   procurement_record_approval_decision(...) - explicit approve/reject updates
--   procurement_get_po_eligible_requisitions(...) - approved requisitions ready
--                                              for PO generation
-- ---------------------------------------------------------------------------

create table if not exists public.procurement_approval_step_templates (
  id                  uuid primary key default gen_random_uuid(),
  requisition_type    text not null check (requisition_type in ('equipment', 'parts', 'merchandise')),
  branch_id           text,
  min_total_amount    numeric(12,2) not null default 0,
  max_total_amount    numeric(12,2),
  step_order          integer not null check (step_order > 0),
  required_role       text not null,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (max_total_amount is null or max_total_amount >= min_total_amount)
);

create unique index if not exists uq_procurement_approval_step_templates_unique
  on public.procurement_approval_step_templates (
    requisition_type,
    coalesce(branch_id, ''),
    min_total_amount,
    coalesce(max_total_amount, -1),
    step_order,
    required_role
  );

create trigger trg_procurement_approval_step_templates_updated_at
  before update on public.procurement_approval_step_templates
  for each row execute function public.update_updated_at();

create table if not exists public.procurement_requisition_approvals (
  requisition_id      uuid not null references public.entities(id) on delete cascade,
  step_order          integer not null check (step_order > 0),
  required_role       text not null,
  min_total_amount    numeric(12,2) not null,
  max_total_amount    numeric(12,2),
  status              text not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected')),
  decided_by          text,
  decided_at          timestamptz,
  decision_comment    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (requisition_id, step_order),
  check (max_total_amount is null or max_total_amount >= min_total_amount)
);

create trigger trg_procurement_requisition_approvals_updated_at
  before update on public.procurement_requisition_approvals
  for each row execute function public.update_updated_at();

create table if not exists public.procurement_requisition_approval_audit (
  id                  uuid primary key default gen_random_uuid(),
  requisition_id      uuid not null references public.entities(id) on delete cascade,
  step_order          integer not null check (step_order > 0),
  decision            text not null check (decision in ('approve', 'reject')),
  decided_by          text not null,
  decision_comment    text,
  decided_at          timestamptz not null default now()
);

create index if not exists idx_procurement_approval_audit_requisition
  on public.procurement_requisition_approval_audit (requisition_id, decided_at desc);

-- Seed default configurable routing by requisition type and purchasing limit.
-- Amount < 5,000 routes to one branch_manager step.
-- Amount >= 5,000 routes to two sequential steps:
--   1) branch_manager
--   2) admin
insert into public.procurement_approval_step_templates (
  requisition_type,
  branch_id,
  min_total_amount,
  max_total_amount,
  step_order,
  required_role,
  is_active
)
select *
from (
  values
    ('equipment',   null::text, 0::numeric, 4999.99::numeric, 1, 'branch_manager', true),
    ('equipment',   null::text, 5000::numeric, null::numeric, 1, 'branch_manager', true),
    ('equipment',   null::text, 5000::numeric, null::numeric, 2, 'admin',          true),
    ('parts',       null::text, 0::numeric, 4999.99::numeric, 1, 'branch_manager', true),
    ('parts',       null::text, 5000::numeric, null::numeric, 1, 'branch_manager', true),
    ('parts',       null::text, 5000::numeric, null::numeric, 2, 'admin',          true),
    ('merchandise', null::text, 0::numeric, 4999.99::numeric, 1, 'branch_manager', true),
    ('merchandise', null::text, 5000::numeric, null::numeric, 1, 'branch_manager', true),
    ('merchandise', null::text, 5000::numeric, null::numeric, 2, 'admin',          true)
) as seed_rows(
  requisition_type,
  branch_id,
  min_total_amount,
  max_total_amount,
  step_order,
  required_role,
  is_active
)
where not exists (
  select 1
  from public.procurement_approval_step_templates existing
  where existing.requisition_type = seed_rows.requisition_type
    and coalesce(existing.branch_id, '') = coalesce(seed_rows.branch_id, '')
    and existing.min_total_amount = seed_rows.min_total_amount
    and coalesce(existing.max_total_amount, -1) = coalesce(seed_rows.max_total_amount, -1)
    and existing.step_order = seed_rows.step_order
    and existing.required_role = seed_rows.required_role
);

create or replace function public.procurement_submit_requisition(
  p_requisition_type  text,
  p_branch_id         text,
  p_cost_center       text,
  p_total_amount      numeric,
  p_requested_items   jsonb default '[]'::jsonb,
  p_notes             text default null
)
returns table (
  requisition_id      uuid,
  status              text,
  submitted_at        timestamptz,
  required_approvals  integer
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_request_role      text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_now               timestamptz := now();
  v_requisition_id    uuid := gen_random_uuid();
  v_approval_count    integer := 0;
  v_max_step_order    integer := 0;
begin
  if v_request_role not in ('authenticated', 'service_role') then
    raise exception 'procurement_submit_requisition requires authenticated or service_role access'
      using errcode = '42501';
  end if;

  if p_requisition_type not in ('equipment', 'parts', 'merchandise') then
    raise exception 'requisition_type must be equipment, parts, or merchandise'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_branch_id, '')), '') is null then
    raise exception 'branch_id is required' using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_cost_center, '')), '') is null then
    raise exception 'cost_center is required' using errcode = '22023';
  end if;

  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'total_amount must be greater than 0' using errcode = '22023';
  end if;

  insert into public.entities (id, entity_type, source_record_id)
  values (v_requisition_id, 'procurement_requisition', null);

  insert into public.entity_versions (
    entity_id,
    version_number,
    is_current,
    valid_from,
    data
  )
  values (
    v_requisition_id,
    1,
    true,
    v_now,
    jsonb_build_object(
      'requisition_type', p_requisition_type,
      'branch_id', p_branch_id,
      'cost_center', p_cost_center,
      'total_amount', p_total_amount,
      'requested_items', coalesce(p_requested_items, '[]'::jsonb),
      'notes', coalesce(nullif(btrim(coalesce(p_notes, '')), ''), null),
      'status', 'pending_approval',
      'po_eligible', false,
      'submitted_at', v_now,
      'source', 'procurement'
    )
  );

  -- Select one active template per step order by preferring branch-specific
  -- templates over global ones; within the same step+branch_match group,
  -- choose the row with the highest min_total_amount.
  with ranked_steps as (
    select distinct on (step_order)
      step_order,
      required_role,
      min_total_amount,
      max_total_amount,
      (branch_id = p_branch_id) as branch_match
    from public.procurement_approval_step_templates
    where is_active = true
      and requisition_type = p_requisition_type
      and (branch_id is null or branch_id = p_branch_id)
      and p_total_amount >= min_total_amount
      and (max_total_amount is null or p_total_amount <= max_total_amount)
    order by step_order, branch_match desc, min_total_amount desc
  )
  insert into public.procurement_requisition_approvals (
    requisition_id,
    step_order,
    required_role,
    min_total_amount,
    max_total_amount,
    status
  )
  select
    v_requisition_id,
    step_order,
    required_role,
    min_total_amount,
    max_total_amount,
    'pending'
  from ranked_steps;

  select count(*)
    into v_approval_count
  from public.procurement_requisition_approvals
  where requisition_id = v_requisition_id;

  if v_approval_count = 0 then
    raise exception 'No active approval routing configured for requisition_type %, branch %, total_amount %',
      p_requisition_type, p_branch_id, p_total_amount
      using errcode = 'P0001';
  end if;

  select coalesce(max(step_order), 0)
    into v_max_step_order
  from public.procurement_requisition_approvals
  where requisition_id = v_requisition_id;

  if v_max_step_order <> v_approval_count then
    raise exception 'Approval routing configuration for requisition_type %, branch %, total_amount % has step gaps',
      p_requisition_type, p_branch_id, p_total_amount
      using errcode = 'P0001';
  end if;

  requisition_id := v_requisition_id;
  status := 'pending_approval';
  submitted_at := v_now;
  required_approvals := v_approval_count;
  return next;
end;
$$;

create or replace function public.procurement_record_approval_decision(
  p_requisition_id    uuid,
  p_step_order        integer,
  p_decision          text,
  p_comment           text default null
)
returns table (
  requisition_id      uuid,
  status              text,
  po_eligible         boolean
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_request_role      text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_request_claims    jsonb := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb;
  v_app_role          text := coalesce(
    nullif(v_request_claims #>> '{app_metadata,role}', ''),
    nullif(v_request_claims ->> 'app_role', ''),
    ''
  );
  v_actor             text := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    v_request_claims ->> 'sub',
    v_request_role,
    'unknown'
  );
  v_decision          text := lower(coalesce(p_decision, ''));
  v_now               timestamptz := now();
  v_current_data      jsonb;
  v_current_status    text;
  v_next_version      integer;
  v_has_remaining     boolean := false;
  v_target            public.procurement_requisition_approvals%rowtype;
begin
  if v_request_role not in ('authenticated', 'service_role') then
    raise exception 'procurement_record_approval_decision requires authenticated or service_role access'
      using errcode = '42501';
  end if;

  if v_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject' using errcode = '22023';
  end if;

  select ev.data
    into v_current_data
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.id = p_requisition_id
    and e.entity_type = 'procurement_requisition';

  if v_current_data is null then
    raise exception 'procurement requisition % not found', p_requisition_id
      using errcode = 'P0002';
  end if;

  v_current_status := coalesce(v_current_data ->> 'status', '');

  if v_current_status <> 'pending_approval' then
    raise exception 'procurement requisition % is not pending approval (status=%)',
      p_requisition_id, v_current_status
      using errcode = 'P0001';
  end if;

  select *
    into v_target
  from public.procurement_requisition_approvals
  where requisition_id = p_requisition_id
    and step_order = p_step_order
  for update;

  if not found then
    raise exception 'approval step % not found for requisition %', p_step_order, p_requisition_id
      using errcode = 'P0002';
  end if;

  if v_request_role <> 'service_role' and v_app_role <> v_target.required_role then
    raise exception 'approval step % requires app role %, caller app role %',
      p_step_order, v_target.required_role, coalesce(nullif(v_app_role, ''), '<none>')
      using errcode = '42501';
  end if;

  if v_target.status <> 'pending' then
    raise exception 'approval step % for requisition % is already %',
      p_step_order, p_requisition_id, v_target.status
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.procurement_requisition_approvals prior
    where prior.requisition_id = p_requisition_id
      and prior.step_order < p_step_order
      and prior.status <> 'approved'
  ) then
    raise exception 'approval step % cannot be decided before earlier steps are approved', p_step_order
      using errcode = 'P0001';
  end if;

  if p_step_order > 1 and not exists (
    select 1
    from public.procurement_requisition_approvals immediate_prior
    where immediate_prior.requisition_id = p_requisition_id
      and immediate_prior.step_order = p_step_order - 1
      and immediate_prior.status = 'approved'
  ) then
    raise exception 'approval step % requires approved step %', p_step_order, p_step_order - 1
      using errcode = 'P0001';
  end if;

  update public.procurement_requisition_approvals
  set status = case when v_decision = 'approve' then 'approved' else 'rejected' end,
      decided_by = v_actor,
      decided_at = v_now,
      decision_comment = coalesce(nullif(btrim(coalesce(p_comment, '')), ''), null)
  where requisition_id = p_requisition_id
    and step_order = p_step_order;

  insert into public.procurement_requisition_approval_audit (
    requisition_id,
    step_order,
    decision,
    decided_by,
    decision_comment,
    decided_at
  ) values (
    p_requisition_id,
    p_step_order,
    v_decision,
    v_actor,
    coalesce(nullif(btrim(coalesce(p_comment, '')), ''), null),
    v_now
  );

  select coalesce(max(version_number), 0) + 1
    into v_next_version
  from public.entity_versions
  where entity_id = p_requisition_id;

  if v_decision = 'reject' then
    insert into public.entity_versions (
      entity_id,
      version_number,
      is_current,
      valid_from,
      data
    ) values (
      p_requisition_id,
      v_next_version,
      true,
      v_now,
      jsonb_set(
        jsonb_set(v_current_data, '{status}', '"rejected"', true),
        '{po_eligible}',
        'false'::jsonb,
        true
      ) || jsonb_build_object(
        'rejected_at', v_now,
        'rejected_step_order', p_step_order
      )
    );

    requisition_id := p_requisition_id;
    status := 'rejected';
    po_eligible := false;
    return next;
    return;
  end if;

  select exists (
    select 1
    from public.procurement_requisition_approvals remaining
    where remaining.requisition_id = p_requisition_id
      and remaining.status = 'pending'
  ) into v_has_remaining;

  if v_has_remaining then
    requisition_id := p_requisition_id;
    status := 'pending_approval';
    po_eligible := false;
    return next;
    return;
  end if;

  insert into public.entity_versions (
    entity_id,
    version_number,
    is_current,
    valid_from,
    data
  ) values (
    p_requisition_id,
    v_next_version,
    true,
    v_now,
    jsonb_set(
      jsonb_set(v_current_data, '{status}', '"approved"', true),
      '{po_eligible}',
      'true'::jsonb,
      true
    ) || jsonb_build_object(
      'approved_at', v_now
    )
  );

  requisition_id := p_requisition_id;
  status := 'approved';
  po_eligible := true;
  return next;
end;
$$;

create or replace function public.procurement_get_po_eligible_requisitions(
  p_branch_id text default null
)
returns table (
  requisition_id      uuid,
  requisition_type    text,
  branch_id           text,
  cost_center         text,
  total_amount        numeric,
  status              text,
  approved_at         timestamptz
)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select
    e.id as requisition_id,
    ev.data ->> 'requisition_type' as requisition_type,
    ev.data ->> 'branch_id' as branch_id,
    ev.data ->> 'cost_center' as cost_center,
    (ev.data ->> 'total_amount')::numeric as total_amount,
    ev.data ->> 'status' as status,
    (ev.data ->> 'approved_at')::timestamptz as approved_at
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.entity_type = 'procurement_requisition'
    and ev.data ->> 'status' = 'approved'
    and coalesce((ev.data ->> 'po_eligible')::boolean, false) = true
    and (p_branch_id is null or ev.data ->> 'branch_id' = p_branch_id)
  order by approved_at nulls last, requisition_id;
$$;

revoke all on table public.procurement_approval_step_templates from public;
revoke all on table public.procurement_requisition_approvals from public;
revoke all on table public.procurement_requisition_approval_audit from public;

grant select on table public.procurement_approval_step_templates to service_role;
grant select on table public.procurement_requisition_approvals to service_role;
grant select on table public.procurement_requisition_approval_audit to service_role;

revoke all on function public.procurement_submit_requisition(text, text, text, numeric, jsonb, text) from public;
revoke all on function public.procurement_record_approval_decision(uuid, integer, text, text) from public;
revoke all on function public.procurement_get_po_eligible_requisitions(text) from public;

grant execute on function public.procurement_submit_requisition(text, text, text, numeric, jsonb, text)
  to authenticated, service_role;
grant execute on function public.procurement_record_approval_decision(uuid, integer, text, text)
  to authenticated, service_role;
grant execute on function public.procurement_get_po_eligible_requisitions(text)
  to authenticated, service_role;
