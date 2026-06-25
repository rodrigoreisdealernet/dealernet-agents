create or replace view v_rental_order_line_current
with (security_invoker = true) as
select
  e.id as entity_id,
  ev.id as version_id,
  ev.version_number,
  ev.data->>'order_id' as order_id,
  ev.data->>'status' as status,
  ev.data->>'category_id' as category_id,
  coalesce(nullif(ev.data->>'quantity', '')::int, 0) as quantity,
  nullif(ev.data->>'planned_start', '')::date as planned_start,
  nullif(ev.data->>'planned_end', '')::date as planned_end,
  ev.data->>'job_site_id' as job_site_id,
  ev.data->>'rate_type' as rate_type,
  ev.data as data
from entities e
join entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
where e.entity_type = 'rental_order_line';

create or replace function rental_dates_overlap(
  p_start_a date,
  p_end_a date,
  p_start_b date,
  p_end_b date
)
returns boolean
language sql
immutable
as $$
  select
    p_start_a is not null
    and p_end_a is not null
    and p_start_b is not null
    and p_end_b is not null
    and p_start_a <= p_end_b
    and p_start_b <= p_end_a;
$$;

create or replace function rental_category_window_availability(
  p_branch_id uuid,
  p_asset_category_id uuid,
  p_start_date date,
  p_end_date date
)
returns table (
  total_assets bigint,
  available_assets bigint,
  unavailable_assets bigint,
  maintenance_due_assets bigint,
  maintenance_overdue_assets bigint,
  committed_quantity bigint,
  shortage_reason text
)
language sql
stable
as $$
with inventory as (
  select
    a.total_assets,
    a.available_assets,
    a.unavailable_assets,
    a.maintenance_due_assets,
    a.maintenance_overdue_assets
  from rental_asset_availability_current a
  where a.branch_id = p_branch_id
    and a.asset_category_id = p_asset_category_id
),
contract_commitments as (
  select count(*)::bigint as committed_quantity
  from v_rental_contract_line_current contract_line
  join rental_current_assets assets
    on assets.entity_id::text = contract_line.asset_id
  where assets.current_branch_id = p_branch_id
    and assets.current_asset_category_id = p_asset_category_id
    and contract_line.status in ('pending', 'checked_out')
    and rental_dates_overlap(
      coalesce(nullif(contract_line.actual_start, '')::date, nullif(contract_line.data->>'planned_start', '')::date),
      coalesce(nullif(contract_line.actual_end, '')::date, nullif(contract_line.data->>'planned_end', '')::date),
      p_start_date,
      p_end_date
    )
),
approved_order_commitments as (
  select coalesce(sum(line.quantity), 0)::bigint as committed_quantity
  from v_rental_order_line_current line
  join v_rental_order_current rental_order
    on rental_order.entity_id::text = line.order_id
  where rental_order.status = 'approved'
    and nullif(rental_order.data->>'branch_id', '')::uuid = p_branch_id
    and nullif(line.category_id, '')::uuid = p_asset_category_id
    and line.status <> 'cancelled'
    and rental_dates_overlap(line.planned_start, line.planned_end, p_start_date, p_end_date)
),
aggregated as (
  select
    coalesce((select total_assets from inventory), 0)::bigint as total_assets,
    coalesce((select available_assets from inventory), 0)::bigint as available_assets,
    coalesce((select unavailable_assets from inventory), 0)::bigint as unavailable_assets,
    coalesce((select maintenance_due_assets from inventory), 0)::bigint as maintenance_due_assets,
    coalesce((select maintenance_overdue_assets from inventory), 0)::bigint as maintenance_overdue_assets,
    coalesce((select committed_quantity from contract_commitments), 0)
      + coalesce((select committed_quantity from approved_order_commitments), 0) as committed_quantity
)
select
  aggregated.total_assets,
  greatest(aggregated.available_assets - aggregated.committed_quantity, 0) as available_assets,
  aggregated.unavailable_assets,
  aggregated.maintenance_due_assets,
  aggregated.maintenance_overdue_assets,
  aggregated.committed_quantity,
  case
    when p_start_date is null or p_end_date is null then 'missing_date_range'
    when p_start_date > p_end_date then 'invalid_date_range'
    when aggregated.total_assets = 0 then 'no_inventory_in_location'
    when greatest(aggregated.available_assets - aggregated.committed_quantity, 0) = 0
         and aggregated.committed_quantity > 0 then 'fully_committed_for_requested_window'
    when greatest(aggregated.available_assets - aggregated.committed_quantity, 0) = 0 then 'no_operational_inventory'
    else null
  end as shortage_reason
from aggregated;
$$;

create or replace function rental_build_alternative_suggestions(
  p_branch_id uuid,
  p_asset_category_id uuid,
  p_quantity int,
  p_start_date date,
  p_end_date date,
  p_limit int default 5
)
returns jsonb
language sql
stable
as $$
with requested as (
  select
    a.branch_id,
    a.branch_name,
    a.asset_category_id,
    a.asset_category_name,
    (
      select assets.ownership_type
      from rental_current_assets assets
      where assets.current_branch_id = a.branch_id
        and assets.current_asset_category_id = a.asset_category_id
        and coalesce(assets.operational_status, '') = 'available'
      group by assets.ownership_type
      order by count(*) desc, assets.ownership_type asc
      limit 1
    ) as preferred_ownership_type
  from rental_asset_availability_current a
  where a.branch_id = p_branch_id
    and a.asset_category_id = p_asset_category_id
),
candidates as (
  select
    a.branch_id,
    a.branch_name,
    a.asset_category_id,
    a.asset_category_name,
    scoped.available_assets,
    scoped.shortage_reason,
    case
      when a.asset_category_id = p_asset_category_id and a.branch_id <> p_branch_id then 1
      when a.branch_id = p_branch_id and a.asset_category_id <> p_asset_category_id then 2
      else 9
    end as suggestion_priority,
    coalesce((
      select count(*)::bigint
      from rental_current_assets assets
      where assets.current_branch_id = a.branch_id
        and assets.current_asset_category_id = a.asset_category_id
        and coalesce(assets.operational_status, '') = 'available'
        and coalesce(assets.ownership_type, '') = coalesce((select preferred_ownership_type from requested), '')
    ), 0) as ownership_match_count
  from rental_asset_availability_current a
  cross join lateral rental_category_window_availability(
    a.branch_id,
    a.asset_category_id,
    p_start_date,
    p_end_date
  ) as scoped
  where scoped.available_assets > 0
    and (
      (a.asset_category_id = p_asset_category_id and a.branch_id <> p_branch_id)
      or (a.branch_id = p_branch_id and a.asset_category_id <> p_asset_category_id)
    )
),
ranked as (
  select *
  from candidates
  order by
    suggestion_priority asc,
    ownership_match_count desc,
    available_assets desc,
    branch_name asc,
    asset_category_name asc
  limit greatest(coalesce(p_limit, 5), 0)
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'branch_id', ranked.branch_id,
      'branch_name', ranked.branch_name,
      'asset_category_id', ranked.asset_category_id,
      'asset_category_name', ranked.asset_category_name,
      'available_quantity', ranked.available_assets,
      'requested_quantity', greatest(coalesce(p_quantity, 1), 1),
      'fit_type', case
        when ranked.suggestion_priority = 1 then 'same_category_other_location'
        else 'same_location_substitute_category'
      end,
      'shortage_reason', ranked.shortage_reason,
      'explanation', case
        when ranked.suggestion_priority = 1 then 'Same category at a different location'
        else 'Closest substitute at the requested location ranked by ownership-type fit then available quantity'
      end
    )
  ),
  '[]'::jsonb
)
from ranked;
$$;

create or replace function rental_quote_line_availability_policy(
  p_branch_id uuid,
  p_asset_category_id uuid,
  p_quantity int,
  p_start_date date,
  p_end_date date
)
returns table (
  available_quantity bigint,
  requested_quantity int,
  is_available boolean,
  shortage_quantity bigint,
  shortage_reason text,
  alternatives jsonb
)
language plpgsql
stable
as $$
declare
  v_total_assets bigint := 0;
  v_available_assets bigint := 0;
  v_unavailable_assets bigint := 0;
  v_maintenance_due_assets bigint := 0;
  v_maintenance_overdue_assets bigint := 0;
  v_committed_quantity bigint := 0;
  v_shortage_reason text;
  v_requested_quantity int := greatest(coalesce(p_quantity, 1), 1);
begin
  select
    scoped.total_assets,
    scoped.available_assets,
    scoped.unavailable_assets,
    scoped.maintenance_due_assets,
    scoped.maintenance_overdue_assets,
    scoped.committed_quantity,
    scoped.shortage_reason
    into
      v_total_assets,
      v_available_assets,
      v_unavailable_assets,
      v_maintenance_due_assets,
      v_maintenance_overdue_assets,
      v_committed_quantity,
      v_shortage_reason
  from rental_category_window_availability(
    p_branch_id,
    p_asset_category_id,
    p_start_date,
    p_end_date
  ) as scoped;

  available_quantity := v_available_assets;
  requested_quantity := v_requested_quantity;
  is_available := v_available_assets >= v_requested_quantity;
  shortage_quantity := greatest(v_requested_quantity - v_available_assets, 0);
  shortage_reason := case
    when is_available then null
    else coalesce(v_shortage_reason, 'insufficient_quantity')
  end;
  alternatives := case
    when is_available then '[]'::jsonb
    else rental_build_alternative_suggestions(
      p_branch_id,
      p_asset_category_id,
      v_requested_quantity,
      p_start_date,
      p_end_date,
      5
    )
  end;

  return next;
end;
$$;

create or replace function rental_quote_availability(
  p_asset_id uuid default null,
  p_asset_category_id uuid default null,
  p_branch_id uuid default null,
  p_quantity int default 1,
  p_start_date date default null,
  p_end_date date default null
)
returns table (
  branch_id uuid,
  asset_category_id uuid,
  requested_quantity int,
  available_quantity bigint,
  is_available boolean,
  shortage_quantity bigint,
  shortage_reason text,
  alternatives jsonb
)
language plpgsql
stable
as $$
declare
  v_branch_id uuid := p_branch_id;
  v_asset_category_id uuid := p_asset_category_id;
begin
  if p_asset_id is not null and (v_branch_id is null or v_asset_category_id is null) then
    select
      assets.current_branch_id,
      assets.current_asset_category_id
      into v_branch_id, v_asset_category_id
    from rental_current_assets assets
    where assets.entity_id = p_asset_id;
  end if;

  if v_branch_id is null or v_asset_category_id is null then
    raise exception 'quote availability requires branch_id and asset_category_id (or resolvable asset_id)'
      using errcode = '22023';
  end if;

  return query
  select
    v_branch_id,
    v_asset_category_id,
    policy.requested_quantity,
    policy.available_quantity,
    policy.is_available,
    policy.shortage_quantity,
    policy.shortage_reason,
    policy.alternatives
  from rental_quote_line_availability_policy(
    v_branch_id,
    v_asset_category_id,
    p_quantity,
    p_start_date,
    p_end_date
  ) as policy;
end;
$$;

create or replace view rental_quote_line_availability_current
with (security_invoker = true) as
select
  order_line.entity_id as line_entity_id,
  rental_order.entity_id as order_id,
  rental_order.status as order_status,
  nullif(rental_order.data->>'branch_id', '')::uuid as branch_id,
  nullif(order_line.category_id, '')::uuid as asset_category_id,
  order_line.quantity as requested_quantity,
  order_line.planned_start,
  order_line.planned_end,
  policy.available_quantity,
  policy.is_available,
  policy.shortage_quantity,
  policy.shortage_reason,
  policy.alternatives
from v_rental_order_line_current order_line
join v_rental_order_current rental_order
  on rental_order.entity_id::text = order_line.order_id
cross join lateral rental_quote_line_availability_policy(
  nullif(rental_order.data->>'branch_id', '')::uuid,
  nullif(order_line.category_id, '')::uuid,
  order_line.quantity,
  order_line.planned_start,
  order_line.planned_end
) as policy
where rental_order.status in ('draft', 'quoted', 'approved');

create or replace function rental_convert_quote_to_reservation(
  p_order_id uuid
)
returns table (
  success boolean,
  reservation_id uuid,
  conflicts jsonb,
  message text
)
language plpgsql
as $$
declare
  v_order_data jsonb;
  v_order_status text;
  v_order_number text;
  v_contract_id uuid;
  v_contract_number text;
  v_conflicts jsonb;
  v_line record;
begin
  select
    rental_order.data,
    rental_order.status,
    coalesce(rental_order.order_number, format('RO-%s', left(rental_order.entity_id::text, 8)))
    into v_order_data, v_order_status, v_order_number
  from v_rental_order_current rental_order
  where rental_order.entity_id = p_order_id;

  if not found then
    raise exception 'Unknown rental order: %', p_order_id
      using errcode = '22023';
  end if;

  if v_order_status not in ('quoted', 'approved') then
    success := false;
    reservation_id := null;
    conflicts := jsonb_build_array(
      jsonb_build_object(
        'order_id', p_order_id,
        'reason', 'order_not_ready_for_conversion',
        'status', v_order_status
      )
    );
    message := 'Order must be quoted or approved before conversion.';
    return next;
    return;
  end if;

  for v_line in
    select
      nullif(rental_order.data->>'branch_id', '')::uuid as branch_id,
      nullif(order_line.category_id, '')::uuid as asset_category_id,
      order_line.planned_start,
      order_line.planned_end
    from v_rental_order_line_current order_line
    join v_rental_order_current rental_order
      on rental_order.entity_id::text = order_line.order_id
    where rental_order.entity_id = p_order_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(
        jsonb_build_object(
          'branch_id', v_line.branch_id,
          'asset_category_id', v_line.asset_category_id,
          'planned_start', v_line.planned_start,
          'planned_end', v_line.planned_end
        )::text,
        0
      )
    );
  end loop;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'line_entity_id', availability.line_entity_id,
        'order_id', availability.order_id,
        'branch_id', availability.branch_id,
        'asset_category_id', availability.asset_category_id,
        'requested_quantity', availability.requested_quantity,
        'available_quantity', availability.available_quantity,
        'shortage_quantity', availability.shortage_quantity,
        'shortage_reason', availability.shortage_reason,
        'alternatives', availability.alternatives
      )
    ),
    '[]'::jsonb
  )
    into v_conflicts
  from rental_quote_line_availability_current availability
  where availability.order_id = p_order_id
    and availability.is_available = false;

  if jsonb_array_length(v_conflicts) > 0 then
    success := false;
    reservation_id := null;
    conflicts := v_conflicts;
    message := 'Reservation conversion blocked due to availability conflicts.';
    return next;
    return;
  end if;

  v_contract_number := format(
    'RC-%s-%s',
    to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
    substr(gen_random_uuid()::text, 1, 8)
  );

  select upserted.entity_id
    into v_contract_id
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract',
    p_data => jsonb_build_object(
      'name', format('Reservation Contract %s', v_contract_number),
      'contract_number', v_contract_number,
      'order_id', p_order_id,
      'status', 'pending_execution',
      'rental_type', coalesce(v_order_data->>'rental_type', 'external'),
      'customer_id', v_order_data->>'customer_id',
      'billing_account_id', v_order_data->>'billing_account_id',
      'job_site_id', v_order_data->>'job_site_id'
    )
  ) as upserted;

  for v_line in
    select
      order_line.entity_id,
      order_line.category_id,
      order_line.quantity,
      order_line.planned_start,
      order_line.planned_end,
      order_line.job_site_id,
      order_line.rate_type,
      order_line.data
    from v_rental_order_line_current order_line
    where order_line.order_id = p_order_id::text
      and order_line.status <> 'cancelled'
  loop
    perform create_entity_with_version(
      p_entity_type => 'rental_contract_line',
      p_data => jsonb_build_object(
        'contract_id', v_contract_id,
        'order_id', p_order_id,
        'order_line_id', v_line.entity_id,
        'category_id', v_line.category_id,
        'quantity', v_line.quantity,
        'status', 'pending',
        'rental_type', coalesce(v_order_data->>'rental_type', 'external'),
        'rate_type', coalesce(v_line.rate_type, 'daily'),
        'planned_start', v_line.planned_start,
        'planned_end', v_line.planned_end,
        'job_site_id', coalesce(v_line.job_site_id, v_order_data->>'job_site_id')
      )
    );
  end loop;

  perform rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_entity_id => p_order_id,
    p_data => v_order_data || jsonb_build_object(
      'status', 'converted',
      'converted_at', now(),
      'reservation_contract_id', v_contract_id,
      'reservation_contract_number', v_contract_number
    )
  );

  success := true;
  reservation_id := v_contract_id;
  conflicts := '[]'::jsonb;
  message := format('Converted order %s to reservation contract %s.', v_order_number, v_contract_number);
  return next;
end;
$$;

alter function rental_dates_overlap(date, date, date, date) owner to postgres;
alter function rental_category_window_availability(uuid, uuid, date, date) owner to postgres;
alter function rental_build_alternative_suggestions(uuid, uuid, int, date, date, int) owner to postgres;
alter function rental_quote_line_availability_policy(uuid, uuid, int, date, date) owner to postgres;
alter function rental_quote_availability(uuid, uuid, uuid, int, date, date) owner to postgres;
alter function rental_convert_quote_to_reservation(uuid) owner to postgres;

revoke execute on function public.rental_quote_availability(uuid, uuid, uuid, int, date, date) from public, anon;
revoke execute on function public.rental_convert_quote_to_reservation(uuid) from public, anon;
grant execute on function public.rental_quote_availability(uuid, uuid, uuid, int, date, date) to authenticated, service_role;
grant execute on function public.rental_convert_quote_to_reservation(uuid) to authenticated, service_role;

revoke all on public.v_rental_order_line_current from public, anon;
revoke all on public.rental_quote_line_availability_current from public, anon;
grant select on public.rental_asset_availability_current to authenticated, service_role;
grant select on public.rental_entity_type_catalog to authenticated, service_role;
grant select on public.rental_relationship_type_catalog to authenticated, service_role;
grant select on public.rental_current_entity_state to authenticated, service_role;
grant select on public.rental_current_branches to authenticated, service_role;
grant select on public.rental_current_asset_categories to authenticated, service_role;
grant select on public.rental_current_assets to authenticated, service_role;
grant select on public.v_rental_contract_line_current to authenticated, service_role;
grant select on public.v_rental_order_current to authenticated, service_role;
grant select on public.v_rental_order_line_current to authenticated, service_role;
grant select on public.rental_quote_line_availability_current to authenticated, service_role;
