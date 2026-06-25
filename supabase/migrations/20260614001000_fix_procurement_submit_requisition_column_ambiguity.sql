-- Fix ambiguous column reference "requisition_id" in procurement_submit_requisition.
--
-- The original definition in 20260612193000_procurement_requisition_approval_routing.sql
-- uses RETURNS TABLE (requisition_id uuid, ...), which creates an implicit OUT parameter
-- named requisition_id.  Two WHERE clauses inside the function body then reference
-- unqualified `requisition_id`, which PostgreSQL 15+ flags as ambiguous because the
-- name resolves to both the OUT parameter and the column in
-- procurement_requisition_approvals.  Adding explicit table aliases removes the
-- ambiguity without changing any observable behaviour.
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
  from public.procurement_requisition_approvals pra
  where pra.requisition_id = v_requisition_id;

  if v_approval_count = 0 then
    raise exception 'No active approval routing configured for requisition_type %, branch %, total_amount %',
      p_requisition_type, p_branch_id, p_total_amount
      using errcode = 'P0001';
  end if;

  select coalesce(max(pra.step_order), 0)
    into v_max_step_order
  from public.procurement_requisition_approvals pra
  where pra.requisition_id = v_requisition_id;

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
