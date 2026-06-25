-- ---------------------------------------------------------------------------
-- Portal Catalog Requisition Surface
--
-- Provides:
--   v_portal_catalog_assets         – available-asset rows for internal/service
--                                     use; not directly exposed to anon (see
--                                     security note in section 1)
--   portal_get_catalog_assets       – SECURITY DEFINER read RPC; the correct
--                                     path for unauthenticated portal callers to
--                                     browse available equipment
--   portal_submit_requisition       – creates a durable requisition entity that
--                                     dispatch can act on; enforces the shared
--                                     portal scope-token so the same token used
--                                     for the off-rent schedule also gates
--                                     catalog submissions
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. v_portal_catalog_assets
--    Internal catalog view — exposes available-asset rows without leaking
--    cost/condition data.  security_invoker = true is retained for defence-in-
--    depth: if an elevated session queries it directly the view still obeys
--    that session's table-level grants/RLS.
--
--    Security note: anon and authenticated roles do NOT have SELECT on the
--    underlying entities/entity_versions tables (revoked by the lockdown
--    migration).  With security_invoker = true, direct anon SELECT on this
--    view therefore fails.  The view is intentionally NOT granted to anon;
--    unauthenticated portal browse must go through portal_get_catalog_assets
--    (SECURITY DEFINER, section 2 below).  The previous anon/authenticated
--    SELECT grant has been replaced with a service_role-only grant.
-- ---------------------------------------------------------------------------
create or replace view public.v_portal_catalog_assets
with (security_invoker = true) as
select
  e.id                                     as asset_id,
  ev.data ->> 'name'                       as name,
  ev.data ->> 'make'                       as make,
  ev.data ->> 'model'                      as model,
  ev.data ->> 'year'                       as year,
  ev.data ->> 'identifier'                 as identifier,
  ev.data ->> 'category_id'               as category_id,
  ev.data ->> 'branch_id'                  as branch_id,
  ev.data ->> 'daily_rate'                 as daily_rate,
  ev.data ->> 'weekly_rate'                as weekly_rate,
  ev.data ->> 'monthly_rate'               as monthly_rate,
  ev.data ->> 'image_url'                  as image_url,
  ev.data ->> 'status'                     as status
from public.entities e
join public.entity_versions ev
  on ev.entity_id = e.id
  and ev.is_current = true
where e.entity_type = 'asset'
  and ev.data ->> 'status' = 'available';

-- Only service_role (server-side) may query the view directly.
-- anon/authenticated portal browse goes through the SECURITY DEFINER RPC below.
revoke select on table public.v_portal_catalog_assets from anon, authenticated;
grant  select on table public.v_portal_catalog_assets to service_role;

-- ---------------------------------------------------------------------------
-- 2. portal_get_catalog_assets
--    SECURITY DEFINER read RPC for portal catalog browse.
--    Runs as the function owner (service_role privileges) so it can read the
--    underlying entities/entity_versions tables regardless of the caller's
--    role.  Returns the same columns as v_portal_catalog_assets.
--    Scope-token enforcement mirrors portal_submit_requisition:
--      - service_role callers bypass token checks (server-side use)
--      - anon/authenticated callers must supply a valid scope token bound to
--        the job site (portal_contract_scope_tokens.job_site_id)
-- ---------------------------------------------------------------------------
create or replace function public.portal_get_catalog_assets(
  p_job_site_id  text,
  p_scope_token  text    default null
)
returns table (
  asset_id      text,
  name          text,
  make          text,
  model         text,
  year          text,
  identifier    text,
  category_id   text,
  branch_id     text,
  daily_rate    text,
  weekly_rate   text,
  monthly_rate  text,
  image_url     text,
  status        text
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
    e.id::text                   as asset_id,
    ev.data ->> 'name'           as name,
    ev.data ->> 'make'           as make,
    ev.data ->> 'model'          as model,
    ev.data ->> 'year'           as year,
    ev.data ->> 'identifier'     as identifier,
    ev.data ->> 'category_id'    as category_id,
    ev.data ->> 'branch_id'      as branch_id,
    ev.data ->> 'daily_rate'     as daily_rate,
    ev.data ->> 'weekly_rate'    as weekly_rate,
    ev.data ->> 'monthly_rate'   as monthly_rate,
    ev.data ->> 'image_url'      as image_url,
    ev.data ->> 'status'         as status
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.entity_type = 'asset'
    and ev.data ->> 'status' = 'available';
end;
$$;

revoke all on function public.portal_get_catalog_assets(text, text) from public;
grant execute on function public.portal_get_catalog_assets(text, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. portal_submit_requisition
--    Creates a requisition entity (entity_type = 'requisition') with the
--    supplied details and returns the new request id + timestamp.
--    Scope-token enforcement mirrors portal_submit_off_rent_request:
--      - service_role callers bypass token checks (server-side use)
--      - all other callers must supply a valid scope token for the job site
-- ---------------------------------------------------------------------------
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
set search_path = public, pg_temp
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
  -- Validate role
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_submit_requisition requires anon, authenticated, or service_role access'
      using errcode = '42501';
  end if;

  -- Non-service_role callers must supply a scope token bound to the job site
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

  -- Validate required fields
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

  -- Persist the requisition as a durable entity so dispatch can act on it.
  -- source_record_id is intentionally null: job_site_id is a text field (not
  -- a UUID FK into entities), so traceability back to the site is via the
  -- jsonb payload's job_site_id key rather than the source_record_id column.
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
