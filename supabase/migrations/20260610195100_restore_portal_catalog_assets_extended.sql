-- Restore portal_get_catalog_assets(text, text) with the full 21-column
-- extended signature AND the extensions search-path fix.
--
-- After the sequence:
--   20260610114000  →  21-column version (set search_path = public, pg_temp)
--   20260610115000  →  drop (to allow 195000 to apply)
--   20260610195000  →  13-column version (set search_path = public, extensions, pg_temp)
--
-- …the function exists with 13 columns but is missing the 8 inventory
-- projection columns (fuel_type, meter_type, latest_meter_metadata, specs,
-- tags, condition, inventory_kind, inventory_entity_type) that were added
-- in 20260610114000.  This migration restores the full signature while
-- also carrying forward the extensions search-path fix so digest() resolves
-- correctly in both Supabase Docker (extensions schema) and plain Postgres.
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
set search_path = public, extensions, pg_temp
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
