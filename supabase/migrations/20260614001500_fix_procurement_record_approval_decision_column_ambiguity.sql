-- Fix ambiguous column reference "requisition_id" in procurement_record_approval_decision.
--
-- The function is declared with RETURNS TABLE (requisition_id uuid, ...), which creates
-- an implicit OUT parameter named requisition_id.  Two unqualified WHERE clauses inside
-- the function body (`where requisition_id = p_requisition_id`) conflict with the same-
-- named column in procurement_requisition_approvals (SELECT for-update and UPDATE clauses),
-- triggering an "ambiguous column reference" error at runtime.
-- Adding explicit table aliases resolves the ambiguity without changing any behaviour.
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
  from public.procurement_requisition_approvals pra
  where pra.requisition_id = p_requisition_id
    and pra.step_order = p_step_order
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

  update public.procurement_requisition_approvals pra
  set status = case when v_decision = 'approve' then 'approved' else 'rejected' end,
      decided_by = v_actor,
      decided_at = v_now,
      decision_comment = coalesce(nullif(btrim(coalesce(p_comment, '')), ''), null)
  where pra.requisition_id = p_requisition_id
    and pra.step_order = p_step_order;

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
