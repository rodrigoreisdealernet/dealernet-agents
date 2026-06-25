-- Move portal catalog/storefront inventory reads onto shared inventory projection.

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
  and coalesce(inventory.operational_status, inventory.data ->> 'status', 'available') = 'available';

revoke select on table public.v_portal_catalog_assets from anon, authenticated;
grant  select on table public.v_portal_catalog_assets to service_role;

-- Rollback plan (required for DROP): if this migration must be reverted, restore
-- the prior portal_get_catalog_assets(text,text) definition from the previous
-- migration chain before dropping this replacement.
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

create or replace view public.v_storefront_asset_catalog
with (security_invoker = true) as
select
  inventory.entity_id,
  inventory.name,
  inventory.make,
  inventory.data ->> 'year'                           as year,
  inventory.data ->> 'identifier'                     as identifier,
  inventory.data ->> 'image_url'                      as image_url,
  inventory.data ->> 'description'                    as description,
  coalesce(inventory.operational_status, 'available') as operational_status,
  (nullif(inventory.data ->> 'daily_rate',   ''))::numeric as daily_rate,
  (nullif(inventory.data ->> 'weekly_rate',  ''))::numeric as weekly_rate,
  (nullif(inventory.data ->> 'monthly_rate', ''))::numeric as monthly_rate,
  inventory.current_asset_category_id  as asset_category_id,
  inventory.current_asset_category_name as asset_category_name,
  inventory.current_branch_id          as branch_id,
  inventory.current_branch_name        as branch_name,
  inventory.model,
  inventory.fuel_type,
  inventory.meter_type,
  inventory.latest_meter_metadata,
  inventory.specs,
  inventory.tags,
  inventory.condition,
  inventory.inventory_kind,
  inventory.entity_type as inventory_entity_type
from public.rental_current_inventory_records inventory
where inventory.current_branch_id is not null;

grant select on table public.v_storefront_asset_catalog to anon, authenticated, service_role;
