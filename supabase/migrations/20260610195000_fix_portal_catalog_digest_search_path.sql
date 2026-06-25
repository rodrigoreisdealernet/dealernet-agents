-- Fix portal_get_catalog_assets and portal_submit_requisition so digest()
-- (pgcrypto) resolves in both Supabase local Docker stack (extensions schema)
-- and plain Postgres (public schema).  The original definitions in
-- 20260609140000_portal_catalog_requisition.sql used
--   set search_path = public, pg_temp
-- which omits the 'extensions' schema where Supabase installs pgcrypto.
-- Adding 'extensions' mirrors the fix applied to portal_get_demo_portal_url
-- and portal_get_contract_schedule in earlier migrations; PostgreSQL silently
-- ignores schema names that do not exist.
--
-- Note: 20260610114000_portal_inventory_projection.sql extended the return type
-- of portal_get_catalog_assets to 21 columns and changed the body to query
-- v_portal_catalog_assets.  That migration runs before this one (timestamps
-- 11:40 vs 19:50), so PostgreSQL would reject a plain CREATE OR REPLACE
-- against the new wider signature.  We DROP first to allow the recreation.

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

create or replace function public.portal_submit_requisition(
  p_job_site_id    text,
  p_asset_id       text,
  p_start_date     date,
  p_end_date       date,
  p_dispatch_yard  text    default null,
  p_notes          text    default null,
  p_scope_token    text    default null
)
returns table (
  requisition_id uuid,
  submitted_at   timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_request_role    text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_token_hash      text;
  v_stored_hash     text;
  v_requisition_id  uuid := gen_random_uuid();
  v_submitted_at    timestamptz := now();
begin
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_submit_requisition requires anon, authenticated, or service_role access'
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

  if nullif(btrim(coalesce(p_job_site_id, '')), '') is null then
    raise exception 'job_site_id is required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_asset_id, '')), '') is null then
    raise exception 'asset_id is required' using errcode = '22023';
  end if;
  if p_start_date is null then
    raise exception 'start_date is required' using errcode = '22023';
  end if;
  if p_end_date is null then
    raise exception 'end_date is required' using errcode = '22023';
  end if;
  if p_end_date < p_start_date then
    raise exception 'end_date must be on or after start_date' using errcode = '22023';
  end if;

  insert into public.entities (id, entity_type, source_record_id)
  values (v_requisition_id, 'requisition', null);

  insert into public.entity_versions (
    entity_id,
    version_number,
    is_current,
    valid_from,
    data
  ) values (
    v_requisition_id,
    1,
    true,
    v_submitted_at,
    jsonb_build_object(
      'job_site_id',   p_job_site_id,
      'asset_id',      p_asset_id,
      'start_date',    p_start_date::text,
      'end_date',      p_end_date::text,
      'dispatch_yard', coalesce(nullif(btrim(coalesce(p_dispatch_yard, '')), ''), null),
      'notes',         coalesce(nullif(btrim(coalesce(p_notes, '')), ''), null),
      'status',        'pending',
      'submitted_at',  v_submitted_at,
      'source',        'portal_catalog'
    )
  );

  requisition_id := v_requisition_id;
  submitted_at   := v_submitted_at;
  return next;
end;
$$;

revoke all on function public.portal_submit_requisition(text, text, date, date, text, text, text) from public;
grant execute on function public.portal_submit_requisition(text, text, date, date, text, text, text)
  to anon, authenticated, service_role;
