-- Maintenance soft-down / hard-down status with inventory-availability integration
-- Issue: #434 (child of #433)
--
-- Adds availability_impact semantics (soft_down / hard_down) to maintenance work
-- orders and propagates the derived down state into inventory availability,
-- quote/reservation asset selection, and fleet calendar surfaces.
--
-- Design:
--   - availability_impact, blocking_reason, opened_at, expected_return_at, and
--     completed_at live in the maintenance_record entity_versions.data JSONB blob.
--   - v_asset_active_down_state derives the most restrictive active down state per
--     asset (hard_down > soft_down) from open (not completed) maintenance records.
--   - rental_current_assets is extended with down_severity, down_reason, and
--     down_expected_return_at via a LEFT JOIN to v_asset_active_down_state.
--   - rental_asset_availability_current gains soft_down_assets and hard_down_assets
--     counts; available_assets excludes any asset with an active down record.
--   - portal_storefront_get_availability marks down assets as is_available = false
--     with the blocking reason surfaced as conflict_reason.
--   - v_portal_catalog_assets and portal_get_catalog_assets exclude hard_down assets
--     (hard_down = immediately excluded from all new allocations); soft_down assets
--     are kept in the catalog but callers receive the down_severity badge via the
--     rental_current_assets view or the asset detail data source.
--
-- Rollback:
--   DROP VIEW IF EXISTS v_asset_active_down_state CASCADE;
--   (rental_current_assets, rental_asset_availability_current, and the portal
--    functions will be restored by re-running their original migrations.)

-- -------------------------------------------------------------------------
-- 1. Derived down-state view
--    One row per asset that has at least one open maintenance record with
--    availability_impact in ('soft_down', 'hard_down').
--    Resolves to the most restrictive active state when multiple records exist.
-- -------------------------------------------------------------------------
create or replace view public.v_asset_active_down_state
with (security_invoker = true) as
with active_impacts as (
  select
    rel.parent_id                            as asset_id,
    ev.data ->> 'availability_impact'        as availability_impact,
    ev.data ->> 'blocking_reason'            as blocking_reason,
    ev.data ->> 'expected_return_at'         as expected_return_at
  from public.relationships_v2 rel
  join public.entities me
    on me.id = rel.child_id
   and me.entity_type = 'maintenance_record'
  join public.entity_versions ev
    on ev.entity_id = rel.child_id
   and ev.is_current = true
  where rel.relationship_type = 'asset_has_maintenance_record'
    and rel.is_current = true
    and ev.data ->> 'availability_impact' in ('soft_down', 'hard_down')
    and ev.data ->> 'completed_at' is null
),
ranked as (
  select
    asset_id,
    availability_impact  as down_severity,
    blocking_reason      as down_reason,
    expected_return_at,
    row_number() over (
      partition by asset_id
      order by
        case availability_impact
          when 'hard_down' then 1
          when 'soft_down' then 2
          else 3
        end
    ) as rn
  from active_impacts
)
select
  asset_id,
  down_severity,
  down_reason,
  expected_return_at
from ranked
where rn = 1;

-- Allow all authenticated roles to read the derived view.
grant select on public.v_asset_active_down_state to authenticated, service_role;

-- -------------------------------------------------------------------------
-- 2. Extend rental_current_assets with down-state columns
--    Adds down_severity, down_reason, down_expected_return_at via LEFT JOIN.
-- -------------------------------------------------------------------------
create or replace view public.rental_current_assets
with (security_invoker = true) as
with base_assets as (
  select *
  from public.rental_current_entity_state
  where entity_type = 'asset'
),
current_assets as (
  select
    base_assets.*,
    nullif(base_assets.data ->> 'maintenance_due_at', '')::timestamptz as maintenance_due_at
  from base_assets
),
maintenance_rules as (
  select interval '14 days' as due_window
),
current_branch_assignments as (
  select
    relationships_v2.parent_id as branch_id,
    relationships_v2.child_id  as asset_id
  from public.relationships_v2
  where relationships_v2.relationship_type = 'branch_has_asset'
    and relationships_v2.is_current
),
current_category_assignments as (
  select
    relationships_v2.parent_id as asset_category_id,
    relationships_v2.child_id  as asset_id
  from public.relationships_v2
  where relationships_v2.relationship_type = 'asset_category_has_asset'
    and relationships_v2.is_current
)
select
  current_assets.entity_id,
  current_assets.entity_type,
  current_assets.source_record_id,
  current_assets.entity_version_id,
  current_assets.version_number,
  current_assets.valid_from,
  current_assets.valid_to,
  current_assets.data,
  current_assets.name,
  current_assets.created_at,
  current_assets.updated_at,
  current_branch_assignments.branch_id                as current_branch_id,
  rental_current_branches.name                        as current_branch_name,
  current_category_assignments.asset_category_id      as current_asset_category_id,
  rental_current_asset_categories.name                as current_asset_category_name,
  current_assets.data ->> 'ownership_type'            as ownership_type,
  current_assets.data ->> 'operational_status'        as operational_status,
  current_assets.maintenance_due_at                   as maintenance_due_at,
  case
    when current_assets.maintenance_due_at is null then 'none'
    when current_assets.maintenance_due_at < now() then 'overdue'
    when current_assets.maintenance_due_at <= now() + maintenance_rules.due_window then 'due'
    else 'not_due'
  end                                                 as maintenance_due_status,
  ads.down_severity,
  ads.down_reason,
  ads.expected_return_at                              as down_expected_return_at
from current_assets
cross join maintenance_rules
left join current_branch_assignments
  on current_branch_assignments.asset_id = current_assets.entity_id
left join public.rental_current_branches
  on rental_current_branches.entity_id = current_branch_assignments.branch_id
left join current_category_assignments
  on current_category_assignments.asset_id = current_assets.entity_id
left join public.rental_current_asset_categories
  on rental_current_asset_categories.entity_id = current_category_assignments.asset_category_id
left join public.v_asset_active_down_state ads
  on ads.asset_id = current_assets.entity_id;

-- -------------------------------------------------------------------------
-- 3. Update rental_asset_availability_current
--    Adds soft_down_assets and hard_down_assets counts.
--    available_assets now excludes any asset with an active down record.
-- -------------------------------------------------------------------------
create or replace view public.rental_asset_availability_current
with (security_invoker = true) as
select
  rental_current_assets.current_branch_id          as branch_id,
  rental_current_assets.current_branch_name         as branch_name,
  rental_current_assets.current_asset_category_id  as asset_category_id,
  rental_current_assets.current_asset_category_name as asset_category_name,
  count(*)                                          as total_assets,
  count(*) filter (
    where coalesce(rental_current_assets.operational_status, '') = 'available'
      and rental_current_assets.down_severity is null
  )                                                 as available_assets,
  count(*) filter (
    where coalesce(rental_current_assets.operational_status, '') <> 'available'
      or rental_current_assets.down_severity is not null
  )                                                 as unavailable_assets,
  count(*) filter (
    where rental_current_assets.maintenance_due_status = 'due'
  )                                                 as maintenance_due_assets,
  count(*) filter (
    where rental_current_assets.maintenance_due_status = 'overdue'
  )                                                 as maintenance_overdue_assets,
  count(*) filter (
    where rental_current_assets.down_severity = 'soft_down'
  )                                                 as soft_down_assets,
  count(*) filter (
    where rental_current_assets.down_severity = 'hard_down'
  )                                                 as hard_down_assets
from public.rental_current_assets
where rental_current_assets.current_branch_id is not null
  and rental_current_assets.current_asset_category_id is not null
group by
  rental_current_assets.current_branch_id,
  rental_current_assets.current_branch_name,
  rental_current_assets.current_asset_category_id,
  rental_current_assets.current_asset_category_name;

-- -------------------------------------------------------------------------
-- 4. Update rental_asset_availability function
--    Exposes the new soft_down_assets and hard_down_assets columns.
--    The return type has changed so the old function must be dropped first;
--    CREATE OR REPLACE cannot change an existing function's return type.
-- -------------------------------------------------------------------------
drop function if exists public.rental_asset_availability(uuid, uuid);

create or replace function public.rental_asset_availability(
  p_branch_id          uuid default null,
  p_asset_category_id  uuid default null
)
returns table (
  branch_id            uuid,
  branch_name          text,
  asset_category_id    uuid,
  asset_category_name  text,
  total_assets         bigint,
  available_assets     bigint,
  unavailable_assets   bigint,
  maintenance_due_assets   bigint,
  maintenance_overdue_assets bigint,
  soft_down_assets     bigint,
  hard_down_assets     bigint
) as $$
  select
    v.branch_id,
    v.branch_name,
    v.asset_category_id,
    v.asset_category_name,
    v.total_assets,
    v.available_assets,
    v.unavailable_assets,
    v.maintenance_due_assets,
    v.maintenance_overdue_assets,
    v.soft_down_assets,
    v.hard_down_assets
  from public.rental_asset_availability_current v
  where (p_branch_id         is null or v.branch_id         = p_branch_id)
    and (p_asset_category_id is null or v.asset_category_id = p_asset_category_id)
  order by
    v.branch_name,
    v.asset_category_name;
$$ language sql stable;

-- -------------------------------------------------------------------------
-- 5. Update portal_storefront_get_availability
--    Down assets (soft_down or hard_down) are marked is_available = false
--    with the blocking reason surfaced as conflict_reason.
-- -------------------------------------------------------------------------
create or replace function public.portal_storefront_get_availability(
  p_start_date  date    default null,
  p_end_date    date    default null,
  p_category_id uuid   default null,
  p_branch_id   uuid   default null
)
returns table (
  entity_id           uuid,
  name                text,
  make                text,
  year                text,
  identifier          text,
  image_url           text,
  description         text,
  daily_rate          numeric,
  weekly_rate         numeric,
  monthly_rate        numeric,
  asset_category_id   uuid,
  asset_category_name text,
  branch_id           uuid,
  branch_name         text,
  is_available        boolean,
  conflict_reason     text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
begin
  if v_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_storefront_get_availability: access denied'
      using errcode = '42501';
  end if;

  if p_start_date is not null and p_end_date is not null and p_start_date >= p_end_date then
    raise exception 'End date must be after start date'
      using errcode = '22023';
  end if;

  return query
  with booked as (
    -- Assets that have an active (non-returned) contract line overlapping
    -- the requested period.  When dates are NULL we skip the check.
    select distinct l.asset_id::uuid as asset_id
    from v_rental_contract_line_current l
    where l.status not in ('returned', 'cancelled')
      and p_start_date is not null
      and p_end_date   is not null
      and (
        coalesce(
          nullif(l.actual_start, '')::date,
          nullif(l.data ->> 'planned_start', '')::date
        ) <= p_end_date
      )
      and (
        coalesce(
          nullif(l.actual_end, '')::date,
          nullif(l.data ->> 'planned_end', '')::date
        ) is null
        or coalesce(
          nullif(l.actual_end, '')::date,
          nullif(l.data ->> 'planned_end', '')::date
        ) >= p_start_date
      )
  ),
  down as (
    -- Assets with an active soft_down or hard_down maintenance record
    select asset_id, down_severity, down_reason
    from public.v_asset_active_down_state
  )
  select
    c.entity_id::uuid,
    c.name,
    c.make,
    c.year,
    c.identifier,
    c.image_url,
    c.description,
    c.daily_rate,
    c.weekly_rate,
    c.monthly_rate,
    c.asset_category_id::uuid,
    c.asset_category_name,
    c.branch_id::uuid,
    c.branch_name,
    (b.asset_id is null and d.asset_id is null)  as is_available,
    case
      when b.asset_id is not null then 'On rent during selected period'
      when d.asset_id is not null then coalesce(
        d.down_reason,
        d.down_severity || ' — maintenance in progress'
      )
      else null
    end as conflict_reason
  from public.v_storefront_asset_catalog c
  left join booked b on b.asset_id = c.entity_id::uuid
  left join down   d on d.asset_id = c.entity_id::uuid
  where (p_category_id is null or c.asset_category_id::uuid = p_category_id)
    and (p_branch_id   is null or c.branch_id::uuid          = p_branch_id);
end;
$$;

grant execute on function public.portal_storefront_get_availability to anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- 6. Update v_portal_catalog_assets
--    Excludes hard_down assets from the bookable catalog.
--    Builds on rental_current_inventory_records to preserve all extended
--    columns introduced by 20260610114000_portal_inventory_projection.sql.
--    (Soft_down assets are retained so ops users can see and plan recovery,
--    but they appear with is_available = false in the storefront RPC above.)
-- -------------------------------------------------------------------------
create or replace view public.v_portal_catalog_assets
with (security_invoker = true) as
select
  inventory.entity_id                           as asset_id,
  inventory.name                                as name,
  inventory.make                                as make,
  inventory.model                               as model,
  inventory.data ->> 'year'                     as year,
  inventory.data ->> 'identifier'               as identifier,
  inventory.current_asset_category_id::text     as category_id,
  inventory.current_branch_id::text             as branch_id,
  inventory.data ->> 'daily_rate'               as daily_rate,
  inventory.data ->> 'weekly_rate'              as weekly_rate,
  inventory.data ->> 'monthly_rate'             as monthly_rate,
  inventory.data ->> 'image_url'                as image_url,
  coalesce(inventory.operational_status, inventory.data ->> 'status', 'available') as status,
  inventory.fuel_type                           as fuel_type,
  inventory.meter_type                          as meter_type,
  inventory.latest_meter_metadata               as latest_meter_metadata,
  inventory.specs                               as specs,
  inventory.tags                                as tags,
  inventory.condition                           as condition,
  inventory.inventory_kind                      as inventory_kind,
  inventory.entity_type                         as inventory_entity_type
from public.rental_current_inventory_records inventory
where inventory.current_branch_id is not null
  and coalesce(inventory.operational_status, inventory.data ->> 'status', 'available') = 'available'
  and not exists (
    select 1
    from public.v_asset_active_down_state ads
    where ads.asset_id = inventory.entity_id
      and ads.down_severity = 'hard_down'
  );

revoke select on table public.v_portal_catalog_assets from anon, authenticated;
grant  select on table public.v_portal_catalog_assets to service_role;

-- -------------------------------------------------------------------------
-- 7. Update portal_get_catalog_assets
--    Mirrors the v_portal_catalog_assets hard_down exclusion so the
--    SECURITY DEFINER RPC returns consistent results.
--    Preserves all return columns from 20260610114000_portal_inventory_projection.
-- -------------------------------------------------------------------------
drop function if exists public.portal_get_catalog_assets(text, text);

create function public.portal_get_catalog_assets(
  p_job_site_id  text,
  p_scope_token  text    default null
)
returns table (
  asset_id              text,
  name                  text,
  make                  text,
  model                 text,
  year                  text,
  identifier            text,
  category_id           text,
  branch_id             text,
  daily_rate            text,
  weekly_rate           text,
  monthly_rate          text,
  image_url             text,
  status                text,
  fuel_type             text,
  meter_type            text,
  latest_meter_metadata jsonb,
  specs                 jsonb,
  tags                  jsonb,
  condition             text,
  inventory_kind        text,
  inventory_entity_type text
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
  v_token_hash   text;
  v_stored_hash  text;
begin
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_get_catalog_assets requires anon, authenticated, or service_role access'
      using errcode = '42501';
  end if;

  if v_request_role <> 'service_role' then
    if nullif(btrim(coalesce(p_scope_token, '')), '') is null then
      raise exception 'Portal scope token is required'
        using errcode = '42501';
    end if;

    v_token_hash := encode(digest(p_scope_token, 'sha256'), 'hex');

    select pct.token_hash
      into v_stored_hash
    from public.portal_contract_scope_tokens pct
    where pct.job_site_id = p_job_site_id
    limit 1;

    if v_stored_hash is null or v_stored_hash <> v_token_hash then
      raise exception 'Invalid or expired portal scope token'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    c.asset_id::text,
    c.name,
    c.make,
    c.model,
    c.year,
    c.identifier,
    c.category_id,
    c.branch_id,
    c.daily_rate,
    c.weekly_rate,
    c.monthly_rate,
    c.image_url,
    c.status,
    c.fuel_type,
    c.meter_type,
    c.latest_meter_metadata,
    c.specs,
    c.tags,
    c.condition,
    c.inventory_kind,
    c.inventory_entity_type
  from public.v_portal_catalog_assets c;
end;
$$;

revoke all on function public.portal_get_catalog_assets(text, text) from public;
grant execute on function public.portal_get_catalog_assets(text, text)
  to anon, authenticated, service_role;
