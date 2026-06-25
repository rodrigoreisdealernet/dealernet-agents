-- Live Yard View activity projection + realtime refresh feed.
-- Closes #1279.
--
-- Reuses canonical rental order, reservation-contract, asset, inspection-hold,
-- and maintenance lifecycle state to project one normalized board row per yard
-- activity item. No parallel board-state table is introduced.

create table if not exists public.live_yard_projection_feed (
  feed_key text primary key,
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.live_yard_projection_feed (feed_key)
values ('live_yard_activity')
on conflict (feed_key) do nothing;

revoke all on public.live_yard_projection_feed from public, anon;
grant select on public.live_yard_projection_feed to authenticated, service_role;

create or replace function public.touch_live_yard_projection_feed()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.live_yard_projection_feed (feed_key, updated_at)
  values ('live_yard_activity', clock_timestamp())
  on conflict (feed_key) do update
    set updated_at = excluded.updated_at;
$$;

create or replace function public.trg_touch_live_yard_projection_feed_entity_versions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_type text;
begin
  if not coalesce(new.is_current, false) then
    return new;
  end if;

  select e.entity_type
    into v_entity_type
  from public.entities e
  where e.id = new.entity_id;

  if v_entity_type in (
    'asset',
    'rental_order',
    'rental_order_line',
    'rental_contract',
    'rental_contract_line',
    'maintenance_record'
  ) then
    perform public.touch_live_yard_projection_feed();
  end if;

  return new;
end;
$$;

create or replace function public.trg_touch_live_yard_projection_feed_relationships()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_relationship_type text := coalesce(new.relationship_type, old.relationship_type);
begin
  if v_relationship_type in (
    'branch_has_asset',
    'asset_category_has_asset',
    'asset_has_maintenance_record'
  ) then
    perform public.touch_live_yard_projection_feed();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_entity_versions_live_yard_projection_feed on public.entity_versions;
create trigger trg_entity_versions_live_yard_projection_feed
after insert or update of data, is_current
on public.entity_versions
for each row
execute function public.trg_touch_live_yard_projection_feed_entity_versions();

drop trigger if exists trg_relationships_live_yard_projection_feed on public.relationships_v2;
create trigger trg_relationships_live_yard_projection_feed
after insert or update of relationship_type, parent_id, child_id, is_current
on public.relationships_v2
for each row
execute function public.trg_touch_live_yard_projection_feed_relationships();

do $$
begin
  if not exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  begin
    alter publication supabase_realtime add table public.live_yard_projection_feed;
  exception
    when duplicate_object then null;
  end;
end;
$$;

create or replace view public.v_live_yard_activity_current
with (security_invoker = true) as
with request_context as (
  select
    coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
      ''
    ) as request_role,
    public.get_my_tenant() as request_tenant
),
current_orders as (
  select
    e.id as order_id,
    ev.data as order_data,
    lower(coalesce(nullif(ev.data ->> 'status', ''), 'draft')) as order_status,
    nullif(ev.data ->> 'order_number', '') as order_number,
    case
      when coalesce(nullif(ev.data ->> 'branch_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'branch_id')::uuid
      else null
    end as branch_id,
    case
      when coalesce(nullif(ev.data ->> 'customer_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'customer_id')::uuid
      else null
    end as customer_id,
    case
      when coalesce(nullif(ev.data ->> 'job_site_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'job_site_id')::uuid
      else null
    end as job_site_id,
    coalesce(nullif(ev.data ->> 'tenant', ''), 'default') as tenant_key
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.entity_type = 'rental_order'
),
current_customers as (
  select
    e.id as entity_id,
    ev.data ->> 'name' as name
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.entity_type = 'customer'
),
current_job_sites as (
  select
    e.id as entity_id,
    ev.data ->> 'name' as name
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.entity_type = 'job_site'
),
current_order_lines as (
  select
    e.id as order_line_id,
    ev.data as line_data,
    ev.data ->> 'order_id' as order_id,
    lower(coalesce(nullif(ev.data ->> 'status', ''), 'pending')) as line_status,
    case
      when coalesce(nullif(ev.data ->> 'branch_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'branch_id')::uuid
      else null
    end as branch_id,
    case
      when coalesce(nullif(ev.data ->> 'category_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'category_id')::uuid
      else null
    end as category_id,
    case
      when coalesce(nullif(ev.data ->> 'job_site_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'job_site_id')::uuid
      else null
    end as job_site_id,
    case
      when coalesce(nullif(ev.data ->> 'quantity', ''), '') ~ '^-?[0-9]+$'
        then (ev.data ->> 'quantity')::integer
      else 0
    end as quantity,
    nullif(ev.data ->> 'planned_start', '')::timestamptz as planned_start_at,
    nullif(ev.data ->> 'planned_end', '')::timestamptz as planned_end_at,
    coalesce(nullif(ev.data ->> 'tenant', ''), null) as tenant_key
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.entity_type = 'rental_order_line'
),
current_contracts as (
  select
    e.id as contract_id,
    ev.data as contract_data,
    lower(coalesce(nullif(ev.data ->> 'status', ''), 'pending_execution')) as contract_status,
    nullif(ev.data ->> 'contract_number', '') as contract_number,
    ev.data ->> 'order_id' as order_id,
    case
      when coalesce(nullif(ev.data ->> 'customer_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'customer_id')::uuid
      else null
    end as customer_id,
    case
      when coalesce(nullif(ev.data ->> 'job_site_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'job_site_id')::uuid
      else null
    end as job_site_id,
    coalesce(nullif(ev.data ->> 'tenant', ''), 'default') as tenant_key
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.entity_type = 'rental_contract'
),
current_contract_lines as (
  select
    e.id as contract_line_id,
    ev.data as line_data,
    ev.data ->> 'contract_id' as contract_id,
    lower(coalesce(nullif(ev.data ->> 'status', ''), 'pending')) as line_status,
    case
      when coalesce(nullif(ev.data ->> 'asset_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'asset_id')::uuid
      else null
    end as asset_id,
    case
      when coalesce(nullif(ev.data ->> 'category_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'category_id')::uuid
      else null
    end as category_id,
    case
      when coalesce(nullif(ev.data ->> 'fulfillment_branch_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'fulfillment_branch_id')::uuid
      when coalesce(nullif(ev.data ->> 'branch_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'branch_id')::uuid
      else null
    end as fulfillment_branch_id,
    case
      when coalesce(nullif(ev.data ->> 'job_site_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (ev.data ->> 'job_site_id')::uuid
      else null
    end as job_site_id,
    case
      when coalesce(nullif(ev.data ->> 'quantity', ''), '') ~ '^-?[0-9]+$'
        then (ev.data ->> 'quantity')::integer
      else 1
    end as quantity,
    nullif(ev.data ->> 'planned_start', '')::timestamptz as planned_start_at,
    nullif(ev.data ->> 'planned_end', '')::timestamptz as planned_end_at,
    nullif(ev.data ->> 'actual_start', '')::timestamptz as actual_start_at,
    nullif(ev.data ->> 'actual_end', '')::timestamptz as actual_end_at,
    coalesce(nullif(ev.data ->> 'tenant', ''), null) as tenant_key
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.entity_type = 'rental_contract_line'
),
current_maintenance_records as (
  select
    e.id as maintenance_record_id,
    e.source_record_id,
    ev.data as maintenance_data,
    lower(coalesce(nullif(ev.data ->> 'status', ''), 'open')) as maintenance_status,
    lower(coalesce(nullif(ev.data ->> 'maintenance_type', ''), 'maintenance')) as maintenance_type,
    lower(coalesce(nullif(ev.data ->> 'availability_impact', ''), 'none')) as availability_impact,
    nullif(ev.data ->> 'opened_at', '')::timestamptz as opened_at,
    nullif(ev.data ->> 'expected_return_at', '')::timestamptz as expected_return_at,
    nullif(ev.data ->> 'completed_at', '')::timestamptz as completed_at,
    coalesce(nullif(ev.data ->> 'tenant', ''), 'default') as tenant_key
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.entity_type = 'maintenance_record'
),
open_maintenance_assets as (
  select
    maintenance.maintenance_record_id,
    maintenance.source_record_id,
    maintenance.maintenance_status,
    maintenance.maintenance_type,
    maintenance.availability_impact,
    maintenance.opened_at,
    maintenance.expected_return_at,
    assets.entity_id as asset_id,
    assets.name as asset_name,
    assets.current_branch_id as branch_id,
    assets.current_branch_name as branch_name,
    assets.current_asset_category_id as asset_category_id,
    assets.current_asset_category_name as asset_category_name,
    assets.data as asset_data,
    assets.maintenance_due_status,
    assets.tenant_key as asset_tenant_key,
    maintenance.tenant_key as maintenance_tenant_key
  from current_maintenance_records maintenance
  join public.relationships_v2 rel
    on rel.child_id = maintenance.maintenance_record_id
   and rel.relationship_type = 'asset_has_maintenance_record'
   and rel.is_current
  join (
    select
      a.*,
      coalesce(nullif(a.data ->> 'tenant', ''), 'default') as tenant_key
    from public.rental_current_assets a
  ) assets
    on assets.entity_id = rel.parent_id
  where maintenance.completed_at is null
    and maintenance.maintenance_status not in ('completed', 'closed', 'cancelled')
),
board_rows as (
  select
    'going_out'::text as lane_key,
    1::int as lane_sort_order,
    'rental_order_line'::text as source_entity_type,
    order_lines.order_line_id as source_entity_id,
    order_lines.order_line_id::text as activity_id,
    orders.order_status as activity_status,
    coalesce(order_lines.branch_id, orders.branch_id) as branch_id,
    coalesce(branches.name, 'Unknown Branch') as branch_name,
    coalesce(order_lines.branch_id, orders.branch_id) as location_id,
    coalesce(branches.name, 'Unknown Branch') as location_name,
    order_lines.planned_start_at as scheduled_start_at,
    order_lines.planned_end_at as scheduled_end_at,
    order_lines.planned_start_at as due_at,
    coalesce(order_lines.planned_start_at, order_lines.planned_end_at) as sort_at,
    coalesce(order_lines.planned_start_at < now(), false) as is_overdue,
    false as is_needs_review,
    null::text as needs_review_reason,
    orders.order_id,
    order_lines.order_line_id,
    orders.order_number,
    null::uuid as contract_id,
    null::uuid as contract_line_id,
    null::text as contract_number,
    null::uuid as maintenance_record_id,
    null::text as maintenance_status,
    null::uuid as asset_id,
    null::text as asset_name,
    order_lines.category_id as asset_category_id,
    categories.name as asset_category_name,
    coalesce(order_lines.job_site_id, orders.job_site_id) as job_site_id,
    job_sites.name as job_site_name,
    orders.customer_id,
    customers.name as customer_name,
    greatest(order_lines.quantity, 1) as quantity,
    'Approved order awaiting reservation fulfillment'::text as status_detail,
    coalesce(order_lines.tenant_key, orders.tenant_key, 'default') as tenant_key
  from current_order_lines order_lines
  join current_orders orders
    on orders.order_id::text = order_lines.order_id
  left join public.rental_current_branches branches
    on branches.entity_id = coalesce(order_lines.branch_id, orders.branch_id)
  left join public.rental_current_asset_categories categories
    on categories.entity_id = order_lines.category_id
  left join current_job_sites job_sites
    on job_sites.entity_id = coalesce(order_lines.job_site_id, orders.job_site_id)
  left join current_customers customers
    on customers.entity_id = orders.customer_id
  where orders.order_status = 'approved'
    and order_lines.line_status <> 'cancelled'

  union all

  select
    'going_out'::text as lane_key,
    1::int as lane_sort_order,
    'rental_contract_line'::text as source_entity_type,
    contract_lines.contract_line_id as source_entity_id,
    contract_lines.contract_line_id::text as activity_id,
    contract_lines.line_status as activity_status,
    coalesce(contract_lines.fulfillment_branch_id, assets.current_branch_id, orders.branch_id) as branch_id,
    coalesce(branches.name, assets.current_branch_name, 'Unknown Branch') as branch_name,
    coalesce(contract_lines.fulfillment_branch_id, assets.current_branch_id, orders.branch_id) as location_id,
    coalesce(branches.name, assets.current_branch_name, 'Unknown Branch') as location_name,
    contract_lines.planned_start_at as scheduled_start_at,
    contract_lines.planned_end_at as scheduled_end_at,
    contract_lines.planned_start_at as due_at,
    coalesce(contract_lines.planned_start_at, contract_lines.planned_end_at, contract_lines.actual_start_at) as sort_at,
    coalesce(contract_lines.planned_start_at < now(), false) as is_overdue,
    false as is_needs_review,
    null::text as needs_review_reason,
    orders.order_id,
    null::uuid as order_line_id,
    orders.order_number,
    contracts.contract_id,
    contract_lines.contract_line_id,
    contracts.contract_number,
    null::uuid as maintenance_record_id,
    null::text as maintenance_status,
    assets.entity_id as asset_id,
    assets.name as asset_name,
    contract_lines.category_id as asset_category_id,
    coalesce(categories.name, assets.current_asset_category_name) as asset_category_name,
    coalesce(contract_lines.job_site_id, contracts.job_site_id, orders.job_site_id) as job_site_id,
    job_sites.name as job_site_name,
    coalesce(contracts.customer_id, orders.customer_id) as customer_id,
    customers.name as customer_name,
    greatest(contract_lines.quantity, 1) as quantity,
    'Reservation contract awaiting checkout'::text as status_detail,
    coalesce(contract_lines.tenant_key, contracts.tenant_key, orders.tenant_key, 'default') as tenant_key
  from current_contract_lines contract_lines
  join current_contracts contracts
    on contracts.contract_id::text = contract_lines.contract_id
  left join current_orders orders
    on orders.order_id::text = contracts.order_id
  left join public.rental_current_assets assets
    on assets.entity_id = contract_lines.asset_id
  left join public.rental_current_branches branches
    on branches.entity_id = coalesce(contract_lines.fulfillment_branch_id, assets.current_branch_id, orders.branch_id)
  left join public.rental_current_asset_categories categories
    on categories.entity_id = contract_lines.category_id
  left join current_job_sites job_sites
    on job_sites.entity_id = coalesce(contract_lines.job_site_id, contracts.job_site_id, orders.job_site_id)
  left join current_customers customers
    on customers.entity_id = coalesce(contracts.customer_id, orders.customer_id)
  where contract_lines.line_status = 'pending'
    and contracts.contract_status in ('pending_execution', 'active')

  union all

  select
    'coming_in'::text as lane_key,
    2::int as lane_sort_order,
    'rental_contract_line'::text as source_entity_type,
    contract_lines.contract_line_id as source_entity_id,
    contract_lines.contract_line_id::text as activity_id,
    contract_lines.line_status as activity_status,
    coalesce(contract_lines.fulfillment_branch_id, assets.current_branch_id, orders.branch_id) as branch_id,
    coalesce(branches.name, assets.current_branch_name, 'Unknown Branch') as branch_name,
    coalesce(contract_lines.fulfillment_branch_id, assets.current_branch_id, orders.branch_id) as location_id,
    coalesce(branches.name, assets.current_branch_name, 'Unknown Branch') as location_name,
    contract_lines.actual_start_at as scheduled_start_at,
    contract_lines.planned_end_at as scheduled_end_at,
    coalesce(contract_lines.planned_end_at, contract_lines.actual_end_at) as due_at,
    coalesce(contract_lines.planned_end_at, contract_lines.actual_start_at) as sort_at,
    coalesce(coalesce(contract_lines.planned_end_at, contract_lines.actual_end_at) < now(), false) as is_overdue,
    false as is_needs_review,
    null::text as needs_review_reason,
    orders.order_id,
    null::uuid as order_line_id,
    orders.order_number,
    contracts.contract_id,
    contract_lines.contract_line_id,
    contracts.contract_number,
    null::uuid as maintenance_record_id,
    null::text as maintenance_status,
    assets.entity_id as asset_id,
    assets.name as asset_name,
    contract_lines.category_id as asset_category_id,
    coalesce(categories.name, assets.current_asset_category_name) as asset_category_name,
    coalesce(contract_lines.job_site_id, contracts.job_site_id, orders.job_site_id) as job_site_id,
    job_sites.name as job_site_name,
    coalesce(contracts.customer_id, orders.customer_id) as customer_id,
    customers.name as customer_name,
    greatest(contract_lines.quantity, 1) as quantity,
    'Checked-out contract line due back to yard'::text as status_detail,
    coalesce(contract_lines.tenant_key, contracts.tenant_key, orders.tenant_key, 'default') as tenant_key
  from current_contract_lines contract_lines
  join current_contracts contracts
    on contracts.contract_id::text = contract_lines.contract_id
  left join current_orders orders
    on orders.order_id::text = contracts.order_id
  left join public.rental_current_assets assets
    on assets.entity_id = contract_lines.asset_id
  left join public.rental_current_branches branches
    on branches.entity_id = coalesce(contract_lines.fulfillment_branch_id, assets.current_branch_id, orders.branch_id)
  left join public.rental_current_asset_categories categories
    on categories.entity_id = contract_lines.category_id
  left join current_job_sites job_sites
    on job_sites.entity_id = coalesce(contract_lines.job_site_id, contracts.job_site_id, orders.job_site_id)
  left join current_customers customers
    on customers.entity_id = coalesce(contracts.customer_id, orders.customer_id)
  where contract_lines.line_status = 'checked_out'
    and contracts.contract_status in ('pending_execution', 'active')

  union all

  select
    'needs_review'::text as lane_key,
    3::int as lane_sort_order,
    'asset'::text as source_entity_type,
    assets.entity_id as source_entity_id,
    assets.entity_id::text as activity_id,
    case
      when lower(coalesce(assets.operational_status, 'inspection_hold')) in ('on_inspection_hold', 'inspection_hold')
        then 'inspection_hold'
      else lower(coalesce(assets.operational_status, 'inspection_hold'))
    end as activity_status,
    assets.current_branch_id as branch_id,
    coalesce(assets.current_branch_name, 'Unknown Branch') as branch_name,
    assets.current_branch_id as location_id,
    coalesce(assets.current_branch_name, 'Unknown Branch') as location_name,
    assets.updated_at as scheduled_start_at,
    null::timestamptz as scheduled_end_at,
    null::timestamptz as due_at,
    assets.updated_at as sort_at,
    false as is_overdue,
    true as is_needs_review,
    'inspection_hold'::text as needs_review_reason,
    null::uuid as order_id,
    null::uuid as order_line_id,
    null::text as order_number,
    null::uuid as contract_id,
    null::uuid as contract_line_id,
    null::text as contract_number,
    null::uuid as maintenance_record_id,
    null::text as maintenance_status,
    assets.entity_id as asset_id,
    assets.name as asset_name,
    assets.current_asset_category_id as asset_category_id,
    assets.current_asset_category_name as asset_category_name,
    null::uuid as job_site_id,
    null::text as job_site_name,
    null::uuid as customer_id,
    null::text as customer_name,
    1 as quantity,
    'Asset is blocked on inspection review'::text as status_detail,
    coalesce(nullif(assets.data ->> 'tenant', ''), 'default') as tenant_key
  from public.rental_current_assets assets
  where lower(coalesce(assets.operational_status, '')) in ('on_inspection_hold', 'inspection_hold')
    and not exists (
      select 1
      from open_maintenance_assets maintenance
      where maintenance.asset_id = assets.entity_id
    )

  union all

  select
    'maintenance'::text as lane_key,
    4::int as lane_sort_order,
    'maintenance_record'::text as source_entity_type,
    maintenance.maintenance_record_id as source_entity_id,
    maintenance.maintenance_record_id::text as activity_id,
    maintenance.maintenance_status as activity_status,
    maintenance.branch_id,
    coalesce(maintenance.branch_name, 'Unknown Branch') as branch_name,
    maintenance.branch_id as location_id,
    coalesce(maintenance.branch_name, 'Unknown Branch') as location_name,
    maintenance.opened_at as scheduled_start_at,
    maintenance.expected_return_at as scheduled_end_at,
    maintenance.expected_return_at as due_at,
    coalesce(maintenance.expected_return_at, maintenance.opened_at) as sort_at,
    coalesce(maintenance.expected_return_at < now(), false) as is_overdue,
    false as is_needs_review,
    null::text as needs_review_reason,
    null::uuid as order_id,
    null::uuid as order_line_id,
    null::text as order_number,
    null::uuid as contract_id,
    null::uuid as contract_line_id,
    null::text as contract_number,
    maintenance.maintenance_record_id,
    maintenance.maintenance_status,
    maintenance.asset_id,
    maintenance.asset_name,
    maintenance.asset_category_id,
    maintenance.asset_category_name,
    null::uuid as job_site_id,
    null::text as job_site_name,
    null::uuid as customer_id,
    null::text as customer_name,
    1 as quantity,
    format(
      'Open %s work order%s',
      maintenance.maintenance_type,
      case
        when maintenance.availability_impact in ('soft_down', 'hard_down') then format(' (%s)', maintenance.availability_impact)
        else ''
      end
    ) as status_detail,
    coalesce(maintenance.maintenance_tenant_key, maintenance.asset_tenant_key, 'default') as tenant_key
  from open_maintenance_assets maintenance
)
select
  board_rows.activity_id,
  board_rows.lane_key,
  case board_rows.lane_key
    when 'going_out' then 'Going Out'
    when 'coming_in' then 'Coming In'
    when 'needs_review' then 'Needs Review'
    when 'maintenance' then 'Maintenance'
    else board_rows.lane_key
  end as lane_label,
  board_rows.lane_sort_order,
  board_rows.source_entity_type,
  board_rows.source_entity_id,
  board_rows.activity_status,
  board_rows.branch_id,
  board_rows.branch_name,
  board_rows.location_id,
  board_rows.location_name,
  board_rows.scheduled_start_at,
  board_rows.scheduled_end_at,
  board_rows.due_at,
  board_rows.sort_at,
  board_rows.is_overdue,
  board_rows.is_needs_review,
  board_rows.needs_review_reason,
  board_rows.order_id,
  board_rows.order_line_id,
  board_rows.order_number,
  board_rows.contract_id,
  board_rows.contract_line_id,
  board_rows.contract_number,
  board_rows.maintenance_record_id,
  board_rows.maintenance_status,
  board_rows.asset_id,
  board_rows.asset_name,
  board_rows.asset_category_id,
  board_rows.asset_category_name,
  board_rows.job_site_id,
  board_rows.job_site_name,
  board_rows.customer_id,
  board_rows.customer_name,
  board_rows.quantity,
  board_rows.status_detail
from board_rows
cross join request_context req
where req.request_role = 'service_role'
   or coalesce(nullif(board_rows.tenant_key, ''), 'default')
      = coalesce(nullif(req.request_tenant, ''), 'default');

revoke all on public.v_live_yard_activity_current from public, anon;
grant select on public.v_live_yard_activity_current to authenticated, service_role;
