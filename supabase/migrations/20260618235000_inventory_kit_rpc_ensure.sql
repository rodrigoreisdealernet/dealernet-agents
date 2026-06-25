-- Ensure staff_upsert_inventory_kit RPC and its dependent views exist and are
-- visible to PostgREST.  The original migration (20260613002000) used
-- DROP/CREATE rather than CREATE OR REPLACE, so if that migration was applied
-- but PostgREST's schema cache was not refreshed, or if the migration failed
-- partway through, the RPC would return HTTP 404.  This migration is fully
-- idempotent (CREATE OR REPLACE everywhere) and ends with a NOTIFY to force
-- PostgREST to reload its schema cache.

-- ---------------------------------------------------------------------------
-- 1) Projection views (idempotent re-assert)
-- ---------------------------------------------------------------------------

create or replace view public.rental_current_inventory_kits
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_type,
  rces.source_record_id,
  rces.entity_version_id,
  rces.version_number,
  rces.valid_from,
  rces.valid_to,
  rces.data,
  rces.name,
  rces.created_at,
  rces.updated_at,
  rces.data ->> 'description' as description,
  nullif(rces.data ->> 'effective_from', '')::date as effective_from,
  nullif(rces.data ->> 'effective_to', '')::date as effective_to,
  nullif(rces.data ->> 'rate_plan_id', '')::uuid as rate_plan_id,
  coalesce(
    case
      when jsonb_typeof(rces.data -> 'pricing_override') = 'object' then rces.data -> 'pricing_override'
      else null
    end,
    '{}'::jsonb
  ) as pricing_override
from rental_current_entity_state rces
where rces.entity_type = 'inventory_kit';

create or replace view public.rental_inventory_kit_components_current
with (security_invoker = true) as
-- Keep a tiny positive floor so downstream availability division never hits zero.
select
  rel.id as relationship_id,
  kits.entity_id as kit_id,
  kits.name as kit_name,
  rel.relationship_type,
  rel.child_id as component_id,
  component.entity_type as component_entity_type,
  component.name as component_name,
  coalesce(nullif(rel.metadata ->> 'component_name', ''), component.name) as component_label,
  greatest(coalesce((nullif(rel.metadata ->> 'quantity', ''))::numeric, 1), 0.000001) as quantity,
  coalesce((nullif(rel.metadata ->> 'is_required', ''))::boolean, true) as is_required,
  coalesce((nullif(rel.metadata ->> 'is_default', ''))::boolean, false) as is_default,
  nullif(rel.metadata ->> 'effective_from', '')::date as effective_from,
  nullif(rel.metadata ->> 'effective_to', '')::date as effective_to,
  rel.metadata
from relationships_v2 rel
join rental_current_inventory_kits kits
  on kits.entity_id = rel.parent_id
join rental_current_entity_state component
  on component.entity_id = rel.child_id
where rel.is_current
  and rel.relationship_type in ('kit_has_asset', 'kit_has_asset_category', 'kit_has_stock_item');

grant select on public.rental_current_inventory_kits to authenticated, service_role;
grant select on public.rental_inventory_kit_components_current to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Admin RPC (CREATE OR REPLACE for idempotent schema-cache fix)
-- ---------------------------------------------------------------------------

create or replace function public.staff_upsert_inventory_kit(
  p_kit_id uuid default null,
  p_name text default null,
  p_description text default null,
  p_effective_from date default null,
  p_effective_to date default null,
  p_rate_plan_id uuid default null,
  p_pricing_override jsonb default '{}'::jsonb,
  p_components jsonb default '[]'::jsonb
)
returns table (
  kit_id uuid,
  entity_version_id uuid,
  version_number bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role text;
  v_kit_id uuid;
  v_component jsonb;
  v_component_id uuid;
  v_component_type text;
  v_relationship_type text;
  v_quantity numeric;
  v_min_component_qty constant numeric := 0.000001;
begin
  v_app_role := public.ops_claim_app_role();
  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'staff_upsert_inventory_kit: access denied'
      using errcode = '42501';
  end if;

  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'staff_upsert_inventory_kit: name is required'
      using errcode = '22023';
  end if;

  if p_effective_from is not null
     and p_effective_to is not null
     and p_effective_to < p_effective_from then
    raise exception 'staff_upsert_inventory_kit: effective_to must be >= effective_from'
      using errcode = '22023';
  end if;

  select upserted.entity_id
    into v_kit_id
  from rental_upsert_entity_current_state(
    p_entity_type => 'inventory_kit',
    p_entity_id => p_kit_id,
    p_data => jsonb_build_object(
      'name', trim(p_name),
      'description', nullif(trim(coalesce(p_description, '')), ''),
      'effective_from', p_effective_from,
      'effective_to', p_effective_to,
      'rate_plan_id', p_rate_plan_id,
      'pricing_override', coalesce(p_pricing_override, '{}'::jsonb)
    )
  ) as upserted;

  update relationships_v2
     set is_current = false,
         valid_to = now(),
         updated_at = now()
   where parent_id = v_kit_id
     and is_current
     and relationship_type in ('kit_has_asset', 'kit_has_asset_category', 'kit_has_stock_item');

  for v_component in
    select *
    from jsonb_array_elements(coalesce(p_components, '[]'::jsonb))
  loop
    v_component_type := lower(coalesce(v_component ->> 'component_type', ''));
    v_component_id := nullif(v_component ->> 'component_id', '')::uuid;
    v_quantity := greatest(coalesce((nullif(v_component ->> 'quantity', ''))::numeric, 1), v_min_component_qty);

    if v_component_id is null then
      raise exception 'staff_upsert_inventory_kit: component_id is required for every component'
        using errcode = '22023';
    end if;

    if v_component_type = 'asset' then
      v_relationship_type := 'kit_has_asset';
    elsif v_component_type = 'asset_category' then
      v_relationship_type := 'kit_has_asset_category';
    elsif v_component_type = 'stock_item' then
      v_relationship_type := 'kit_has_stock_item';
    else
      raise exception 'staff_upsert_inventory_kit: invalid component_type "%"', v_component_type
        using errcode = '22023';
    end if;

    perform 1
    from entities
    where id = v_component_id
      and entity_type = v_component_type;

    if not found then
      raise exception 'staff_upsert_inventory_kit: component % is not an entity of type %', v_component_id, v_component_type
        using errcode = '22023';
    end if;

    perform rental_upsert_relationship(
      p_relationship_type => v_relationship_type,
      p_parent_id => v_kit_id,
      p_child_id => v_component_id,
      p_metadata => jsonb_build_object(
        'component_type', v_component_type,
        'component_name', nullif(v_component ->> 'component_name', ''),
        'quantity', v_quantity,
        'is_required', coalesce((nullif(v_component ->> 'is_required', ''))::boolean, true),
        'is_default', coalesce((nullif(v_component ->> 'is_default', ''))::boolean, false),
        'effective_from', nullif(v_component ->> 'effective_from', '')::date,
        'effective_to', nullif(v_component ->> 'effective_to', '')::date
      )
    );
  end loop;

  return query
  select
    v_kit_id,
    ev.id,
    ev.version_number::bigint
  from entity_versions ev
  where ev.entity_id = v_kit_id
    and ev.is_current;
end;
$$;

revoke execute on function public.staff_upsert_inventory_kit(uuid, text, text, date, date, uuid, jsonb, jsonb)
  from public, anon;
grant execute on function public.staff_upsert_inventory_kit(uuid, text, text, date, date, uuid, jsonb, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Signal PostgREST to refresh its schema cache
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
