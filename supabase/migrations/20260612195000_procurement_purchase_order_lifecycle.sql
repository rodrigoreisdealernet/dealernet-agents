-- Procurement purchase-order lifecycle and amendments
--
-- Implements child story #1233.
--
-- Changes:
--   1. Extend the entity-type catalog with requisition, supplier, and
--      purchase_order so procurement entities can use the shared SCD2 helpers.
--   2. Register a purchase_order_event fact type for durable lifecycle audit
--      entries in time_series_points.
--   3. Add a helper + view that project the current purchase-order state with
--      supplier, branch, expected receipt, and open/partially received/closed
--      status.
--   4. Add generate/transition RPCs for creation from approved requisitions,
--      issue, receipt tracking, amendment, and controlled cancellation.

create or replace view public.rental_entity_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company'),
    ('region'),
    ('branch'),
    ('customer'),
    ('billing_account'),
    ('contact'),
    ('job_site'),
    ('asset_category'),
    ('asset'),
    ('stock_item'),
    ('maintenance_record'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line'),
    ('invoice'),
    ('invoice_line'),
    ('transfer'),
    ('rate_card'),
    ('document'),
    ('note'),
    ('agent_config'),
    ('customer_issue'),
    ('requisition'),
    ('supplier'),
    ('purchase_order')
) as rental_entity_types(entity_type);

insert into public.fact_types (key, label, description, unit)
values (
  'purchase_order_event',
  'Purchase Order Event',
  'Lifecycle audit events for procurement purchase orders',
  'event'
)
on conflict (key) do nothing;

create or replace function public.procurement_project_purchase_order_status(
  p_lifecycle_status text,
  p_ordered_quantity numeric,
  p_received_quantity numeric
)
returns text
language sql
immutable
as $$
  select case
    when coalesce(nullif(p_lifecycle_status, ''), 'draft') = 'cancelled' then 'cancelled'
    when coalesce(p_ordered_quantity, 0) > 0
      and coalesce(p_received_quantity, 0) >= coalesce(p_ordered_quantity, 0) then 'closed'
    when coalesce(p_received_quantity, 0) > 0 then 'partially_received'
    when coalesce(nullif(p_lifecycle_status, ''), 'draft') = 'draft' then 'draft'
    else 'open'
  end;
$$;

create or replace view public.v_procurement_purchase_orders
with (security_invoker = true) as
select
  e.id                                                           as purchase_order_id,
  ev.version_number,
  ev.data ->> 'purchase_order_number'                            as purchase_order_number,
  nullif(ev.data ->> 'requisition_id', '')::uuid                 as requisition_id,
  nullif(ev.data ->> 'supplier_id', '')::uuid                    as supplier_id,
  supplier_ev.data ->> 'name'                                      as supplier_name,
  nullif(ev.data ->> 'branch_id', '')::uuid                      as branch_id,
  branch_ev.data ->> 'name'                                      as branch_name,
  nullif(ev.data ->> 'expected_receipt_date', '')::date          as expected_receipt_date,
  coalesce((ev.data ->> 'ordered_quantity')::numeric, 0)         as ordered_quantity,
  coalesce((ev.data ->> 'received_quantity')::numeric, 0)        as received_quantity,
  public.procurement_project_purchase_order_status(
    ev.data ->> 'status',
    (ev.data ->> 'ordered_quantity')::numeric,
    (ev.data ->> 'received_quantity')::numeric
  )                                                              as status,
  coalesce((ev.data ->> 'amendment_count')::int, 0)              as amendment_count,
  ev.data ->> 'last_action'                                      as last_action,
  ev.data ->> 'last_action_reason'                               as last_action_reason,
  ev.data ->> 'item_description'                                 as item_description,
  ev.data ->> 'source'                                           as source,
  e.created_at,
  ev.valid_from                                                  as updated_at
from public.entities e
join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current = true
left join public.entities supplier_e
  on supplier_e.id = nullif(ev.data ->> 'supplier_id', '')::uuid
 and supplier_e.entity_type = 'supplier'
left join public.entity_versions supplier_ev
  on supplier_ev.entity_id = supplier_e.id
 and supplier_ev.is_current = true
left join public.entities branch_e
  on branch_e.id = nullif(ev.data ->> 'branch_id', '')::uuid
 and branch_e.entity_type = 'branch'
left join public.entity_versions branch_ev
  on branch_ev.entity_id = branch_e.id
 and branch_ev.is_current = true
where e.entity_type = 'purchase_order';

revoke all on table public.v_procurement_purchase_orders from public, anon;
grant select on table public.v_procurement_purchase_orders to authenticated, service_role;

create or replace function public.procurement_generate_purchase_order(
  p_requisition_id uuid,
  p_reason text default null
)
returns table (
  purchase_order_id uuid,
  purchase_order_number text,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_app_role text := coalesce(public.ops_claim_app_role(), '');
  v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  v_actor_id uuid := nullif(v_claims ->> 'sub', '')::uuid;
  v_requisition_data jsonb;
  v_requisition_status text;
  v_purchase_order_id uuid;
  v_purchase_order_number text;
  v_purchase_order_data jsonb;
  v_requisition_projection jsonb;
  v_supplier_id uuid;
  v_branch_id uuid;
  v_expected_receipt_date date;
  v_ordered_quantity numeric;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_event_fact_type_id uuid;
  v_attempt int;
begin
  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and v_app_role in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'procurement_generate_purchase_order: access denied'
      using errcode = '42501';
  end if;

  if p_requisition_id is null then
    raise exception 'procurement_generate_purchase_order: requisition_id is required'
      using errcode = '22023';
  end if;

  select ev.data
    into v_requisition_data
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.id = p_requisition_id
    and e.entity_type = 'requisition';

  if not found then
    raise exception 'procurement_generate_purchase_order: requisition % not found', p_requisition_id
      using errcode = '22023';
  end if;

  v_requisition_status := coalesce(v_requisition_data ->> 'status', '');
  if v_requisition_status <> 'approved' then
    raise exception 'procurement_generate_purchase_order: requisition % must be approved (current status=%)',
      p_requisition_id, coalesce(v_requisition_status, '<null>')
      using errcode = '22023';
  end if;

  if nullif(v_requisition_data ->> 'purchase_order_id', '') is not null then
    raise exception 'procurement_generate_purchase_order: requisition % already has purchase_order_id=%',
      p_requisition_id,
      v_requisition_data ->> 'purchase_order_id'
      using errcode = '22023';
  end if;

  v_supplier_id := nullif(v_requisition_data ->> 'supplier_id', '')::uuid;
  v_branch_id := nullif(v_requisition_data ->> 'branch_id', '')::uuid;
  v_expected_receipt_date := nullif(v_requisition_data ->> 'expected_receipt_date', '')::date;
  v_ordered_quantity := coalesce(
    nullif(v_requisition_data ->> 'quantity', '')::numeric,
    nullif(v_requisition_data ->> 'ordered_quantity', '')::numeric
  );

  if v_supplier_id is null then
    raise exception 'procurement_generate_purchase_order: approved requisition % is missing supplier_id',
      p_requisition_id
      using errcode = '22023';
  end if;
  if v_branch_id is null then
    raise exception 'procurement_generate_purchase_order: approved requisition % is missing branch_id',
      p_requisition_id
      using errcode = '22023';
  end if;
  if v_expected_receipt_date is null then
    raise exception 'procurement_generate_purchase_order: approved requisition % is missing expected_receipt_date',
      p_requisition_id
      using errcode = '22023';
  end if;
  if coalesce(v_ordered_quantity, 0) <= 0 then
    raise exception 'procurement_generate_purchase_order: approved requisition % must provide a positive quantity',
      p_requisition_id
      using errcode = '22023';
  end if;

  for v_attempt in 1..5 loop
    v_purchase_order_number := format(
      'PO-%s-%s',
      to_char(now() at time zone 'UTC', 'YYYYMMDD'),
      left(gen_random_uuid()::text, 8)
    );

    exit when not exists (
      select 1
      from public.entities e
      join public.entity_versions ev
        on ev.entity_id = e.id
       and ev.is_current = true
      where e.entity_type = 'purchase_order'
        and ev.data ->> 'purchase_order_number' = v_purchase_order_number
    );
  end loop;

  if exists (
    select 1
    from public.entities e
    join public.entity_versions ev
      on ev.entity_id = e.id
     and ev.is_current = true
    where e.entity_type = 'purchase_order'
      and ev.data ->> 'purchase_order_number' = v_purchase_order_number
  ) then
    raise exception 'procurement_generate_purchase_order: unable to allocate a unique purchase_order_number'
      using errcode = '23505';
  end if;

  v_purchase_order_data := jsonb_strip_nulls(jsonb_build_object(
    'status', 'draft',
    'purchase_order_number', v_purchase_order_number,
    'requisition_id', p_requisition_id,
    'supplier_id', v_supplier_id,
    'branch_id', v_branch_id,
    'expected_receipt_date', v_expected_receipt_date,
    'ordered_quantity', v_ordered_quantity,
    'received_quantity', 0,
    'amendment_count', 0,
    'item_description', nullif(v_requisition_data ->> 'item_description', ''),
    'source', 'approved_requisition',
    'created_by', v_actor_id,
    'last_action', 'generated',
    'last_action_reason', v_reason
  ));

  select upserted.entity_id
    into v_purchase_order_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'purchase_order',
    p_entity_id   => null,
    p_data        => v_purchase_order_data
  ) as upserted;

  v_requisition_projection := v_requisition_data || jsonb_strip_nulls(jsonb_build_object(
    'purchase_order_id', v_purchase_order_id,
    'purchase_order_number', v_purchase_order_number,
    'purchase_order_status', 'draft',
    'purchase_order_last_action', 'generated',
    'purchase_order_last_reason', v_reason
  ));

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'requisition',
    p_entity_id   => p_requisition_id,
    p_data        => v_requisition_projection
  );

  select id
    into v_event_fact_type_id
  from public.fact_types
  where key = 'purchase_order_event';

  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id
  ) values (
    v_purchase_order_id,
    v_event_fact_type_id,
    now(),
    jsonb_strip_nulls(jsonb_build_object(
      'event_type', 'generated',
      'reason', v_reason,
      'purchase_order_number', v_purchase_order_number,
      'requisition_id', p_requisition_id,
      'status', 'draft',
      'ordered_quantity', v_ordered_quantity,
      'received_quantity', 0,
      'expected_receipt_date', v_expected_receipt_date
    )),
    v_purchase_order_number
  );

  purchase_order_id := v_purchase_order_id;
  purchase_order_number := v_purchase_order_number;
  status := 'draft';
  return next;
end;
$$;

create or replace function public.procurement_transition_purchase_order(
  p_purchase_order_id uuid,
  p_action text,
  p_reason text default null,
  p_expected_receipt_date date default null,
  p_received_quantity numeric default null,
  p_ordered_quantity numeric default null
)
returns table (
  purchase_order_id uuid,
  purchase_order_number text,
  status text,
  amendment_count int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_app_role text := coalesce(public.ops_claim_app_role(), '');
  v_current_data jsonb;
  v_next_data jsonb;
  v_requisition_data jsonb;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_current_status text;
  v_next_status text;
  v_purchase_order_number text;
  v_requisition_id uuid;
  v_expected_receipt_date date;
  v_ordered_quantity numeric;
  v_received_quantity numeric;
  v_amendment_count int;
  v_event_fact_type_id uuid;
  v_event_type text;
begin
  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and v_app_role in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'procurement_transition_purchase_order: access denied'
      using errcode = '42501';
  end if;

  if p_purchase_order_id is null then
    raise exception 'procurement_transition_purchase_order: purchase_order_id is required'
      using errcode = '22023';
  end if;

  select ev.data
    into v_current_data
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.id = p_purchase_order_id
    and e.entity_type = 'purchase_order';

  if not found then
    raise exception 'procurement_transition_purchase_order: purchase_order % not found', p_purchase_order_id
      using errcode = '22023';
  end if;

  if v_action not in ('issue', 'amend', 'receive', 'cancel') then
    raise exception 'procurement_transition_purchase_order: unsupported action "%"', coalesce(p_action, '<null>')
      using errcode = '22023';
  end if;

  v_purchase_order_number := v_current_data ->> 'purchase_order_number';
  v_requisition_id := nullif(v_current_data ->> 'requisition_id', '')::uuid;
  v_current_status := coalesce(v_current_data ->> 'status', 'draft');
  v_expected_receipt_date := coalesce(
    p_expected_receipt_date,
    nullif(v_current_data ->> 'expected_receipt_date', '')::date
  );
  v_ordered_quantity := coalesce(
    p_ordered_quantity,
    nullif(v_current_data ->> 'ordered_quantity', '')::numeric,
    0
  );
  v_received_quantity := coalesce(
    p_received_quantity,
    nullif(v_current_data ->> 'received_quantity', '')::numeric,
    0
  );
  v_amendment_count := coalesce(
    nullif(v_current_data ->> 'amendment_count', '')::int,
    0
  );

  if v_ordered_quantity <= 0 then
    raise exception 'procurement_transition_purchase_order: ordered_quantity must remain positive'
      using errcode = '22023';
  end if;
  if v_received_quantity < 0 then
    raise exception 'procurement_transition_purchase_order: received_quantity cannot be negative'
      using errcode = '22023';
  end if;
  if v_received_quantity > v_ordered_quantity then
    raise exception 'procurement_transition_purchase_order: received_quantity (%) cannot exceed ordered_quantity (%)',
      v_received_quantity, v_ordered_quantity
      using errcode = '22023';
  end if;

  case v_action
    when 'issue' then
      if v_current_status <> 'draft' then
        raise exception 'procurement_transition_purchase_order: only draft orders can be issued (current status=%)',
          v_current_status
          using errcode = '22023';
      end if;
      v_next_status := 'open';
      v_event_type := 'issued';
    when 'amend' then
      if v_current_status in ('cancelled', 'closed') then
        raise exception 'procurement_transition_purchase_order: cannot amend a % order', v_current_status
          using errcode = '22023';
      end if;
      if v_reason is null then
        raise exception 'procurement_transition_purchase_order: amendment reason is required'
          using errcode = '22023';
      end if;
      v_amendment_count := v_amendment_count + 1;
      v_next_status := public.procurement_project_purchase_order_status(
        v_current_status,
        v_ordered_quantity,
        v_received_quantity
      );
      v_event_type := 'amended';
    when 'receive' then
      if v_current_status = 'draft' then
        raise exception 'procurement_transition_purchase_order: issue the order before recording receipts'
          using errcode = '22023';
      end if;
      if v_current_status = 'closed' then
        raise exception 'procurement_transition_purchase_order: closed orders cannot receive additional quantity'
          using errcode = '22023';
      end if;
      if v_current_status = 'cancelled' then
        raise exception 'procurement_transition_purchase_order: cannot receive against a cancelled order'
          using errcode = '22023';
      end if;
      if p_received_quantity is null then
        raise exception 'procurement_transition_purchase_order: received_quantity is required for receive'
          using errcode = '22023';
      end if;
      v_next_status := public.procurement_project_purchase_order_status(
        'open',
        v_ordered_quantity,
        v_received_quantity
      );
      v_event_type := 'received';
    when 'cancel' then
      if v_current_status = 'closed' then
        raise exception 'procurement_transition_purchase_order: closed orders cannot be cancelled'
          using errcode = '22023';
      end if;
      if v_reason is null then
        raise exception 'procurement_transition_purchase_order: cancellation reason is required'
          using errcode = '22023';
      end if;
      v_next_status := 'cancelled';
      v_event_type := 'cancelled';
  end case;

  v_next_data := v_current_data || jsonb_strip_nulls(jsonb_build_object(
    'status', v_next_status,
    'expected_receipt_date', v_expected_receipt_date,
    'ordered_quantity', v_ordered_quantity,
    'received_quantity', v_received_quantity,
    'amendment_count', v_amendment_count,
    'last_action', v_event_type,
    'last_action_reason', v_reason,
    'issued_at', case when v_event_type = 'issued' then now() else null end,
    'amended_at', case when v_event_type = 'amended' then now() else null end,
    'cancelled_at', case when v_event_type = 'cancelled' then now() else null end,
    'last_received_at', case when v_event_type = 'received' then now() else null end
  ));

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'purchase_order',
    p_entity_id   => p_purchase_order_id,
    p_data        => v_next_data
  );

  if v_requisition_id is not null then
    select ev.data
      into v_requisition_data
    from public.entities e
    join public.entity_versions ev
      on ev.entity_id = e.id
     and ev.is_current = true
    where e.id = v_requisition_id
      and e.entity_type = 'requisition';

    if found then
      perform public.rental_upsert_entity_current_state(
        p_entity_type => 'requisition',
        p_entity_id   => v_requisition_id,
        p_data        => v_requisition_data || jsonb_strip_nulls(jsonb_build_object(
          'purchase_order_status', v_next_status,
          'purchase_order_last_action', v_event_type,
          'purchase_order_last_reason', v_reason,
          'purchase_order_expected_receipt_date', v_expected_receipt_date,
          'purchase_order_received_quantity', v_received_quantity
        ))
      );
    end if;
  end if;

  select id
    into v_event_fact_type_id
  from public.fact_types
  where key = 'purchase_order_event';

  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id
  ) values (
    p_purchase_order_id,
    v_event_fact_type_id,
    now(),
    jsonb_strip_nulls(jsonb_build_object(
      'event_type', v_event_type,
      'reason', v_reason,
      'purchase_order_number', v_purchase_order_number,
      'status', v_next_status,
      'ordered_quantity', v_ordered_quantity,
      'received_quantity', v_received_quantity,
      'expected_receipt_date', v_expected_receipt_date
    )),
    v_purchase_order_number
  );

  purchase_order_id := p_purchase_order_id;
  purchase_order_number := v_purchase_order_number;
  status := v_next_status;
  amendment_count := v_amendment_count;
  return next;
end;
$$;

revoke all on function public.procurement_generate_purchase_order(uuid, text) from public, anon;
grant execute on function public.procurement_generate_purchase_order(uuid, text) to authenticated, service_role;

revoke all on function public.procurement_transition_purchase_order(uuid, text, text, date, numeric, numeric) from public, anon;
grant execute on function public.procurement_transition_purchase_order(uuid, text, text, date, numeric, numeric) to authenticated, service_role;
