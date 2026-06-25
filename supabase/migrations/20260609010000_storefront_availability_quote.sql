-- Storefront: date-range availability + live quote calc
-- Supports the customer-facing /portal/storefront route.
-- Exposes a safe catalog view to anon and provides security-definer RPCs
-- for date-range availability checks and quote-request submission.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS portal_storefront_get_availability CASCADE;
--   DROP FUNCTION IF EXISTS portal_storefront_submit_quote CASCADE;
--   DROP TABLE IF EXISTS storefront_quote_requests;
--   DROP VIEW IF EXISTS v_storefront_asset_catalog;

-- -------------------------------------------------------------------------
-- 1. Storefront catalog view
--    Safe subset of rental_current_assets for anon/public consumption.
--    No PII, no internal operational fields.
-- -------------------------------------------------------------------------
create or replace view public.v_storefront_asset_catalog
with (security_invoker = true) as
select
  a.entity_id,
  a.name,
  a.data ->> 'make'        as make,
  a.data ->> 'year'        as year,
  a.data ->> 'identifier'  as identifier,
  a.data ->> 'image_url'   as image_url,
  a.data ->> 'description' as description,
  coalesce(a.operational_status, 'available') as operational_status,
  (nullif(a.data ->> 'daily_rate',   ''))::numeric as daily_rate,
  (nullif(a.data ->> 'weekly_rate',  ''))::numeric as weekly_rate,
  (nullif(a.data ->> 'monthly_rate', ''))::numeric as monthly_rate,
  a.current_asset_category_id  as asset_category_id,
  a.current_asset_category_name as asset_category_name,
  a.current_branch_id          as branch_id,
  a.current_branch_name        as branch_name
from public.rental_current_assets a
where a.current_branch_id is not null;

grant select on table public.v_storefront_asset_catalog to anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- 2. Quote-request storage
-- -------------------------------------------------------------------------
create table if not exists public.storefront_quote_requests (
  id                 uuid        primary key default gen_random_uuid(),
  asset_id           uuid,
  asset_category_id  uuid,
  branch_id          uuid,
  start_date         date        not null,
  end_date           date        not null,
  quantity           integer     not null default 1
                     constraint storefront_quote_requests_quantity_pos check (quantity >= 1),
  contact_name       text        not null
                     constraint storefront_quote_requests_contact_name_nonempty check (length(btrim(contact_name)) > 0),
  contact_email      text        not null
                     constraint storefront_quote_requests_contact_email_nonempty check (length(btrim(contact_email)) > 0),
  contact_phone      text,
  company_name       text,
  notes              text,
  rate_type          text,
  base_amount        numeric,
  env_fee            numeric,
  damage_waiver      numeric,
  tax_amount         numeric,
  total_amount       numeric,
  currency           text        not null default 'USD',
  status             text        not null default 'pending',
  created_at         timestamptz not null default timezone('utc'::text, now()),
  constraint storefront_quote_requests_dates_order check (end_date > start_date)
);

alter table public.storefront_quote_requests enable row level security;

-- Only privileged internal staff (admin / branch_manager) may read quote requests.
-- Using ops_claim_app_role() scopes the check to the JWT app_metadata.role claim,
-- so ordinary authenticated users (e.g. read_only or field_operator) and all
-- anonymous callers are denied, even if they hold an authenticated Postgres role.
create policy storefront_quote_requests_staff_read
  on public.storefront_quote_requests
  for select
  to authenticated
  using (public.ops_claim_app_role() in ('admin', 'branch_manager'));

-- Grant table-level SELECT to authenticated so the GRANT→RLS chain is complete.
-- Rows are still filtered by the policy above; non-staff sessions see nothing.
grant select on public.storefront_quote_requests to authenticated;

-- No direct table writes from clients; insertion is via the RPC only
-- (anon has no INSERT policy — the RPC runs SECURITY DEFINER)

-- -------------------------------------------------------------------------
-- 3. RPC: date-range availability
--    Returns all catalog assets with availability status for the requested
--    period.  A NULL date means "no date filter" — returns current status.
-- -------------------------------------------------------------------------
create or replace function public.portal_storefront_get_availability(
  p_start_date date default null,
  p_end_date   date default null,
  p_category_id uuid default null,
  p_branch_id   uuid default null
)
returns table (
  entity_id          uuid,
  name               text,
  make               text,
  year               text,
  identifier         text,
  image_url          text,
  description        text,
  daily_rate         numeric,
  weekly_rate        numeric,
  monthly_rate       numeric,
  asset_category_id  uuid,
  asset_category_name text,
  branch_id          uuid,
  branch_name        text,
  is_available       boolean,
  conflict_reason    text
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
        -- line's effective start date
        coalesce(
          nullif(l.actual_start, '')::date,
          nullif(l.data ->> 'planned_start', '')::date
        ) <= p_end_date
      )
      and (
        -- line has no end (still on rent) or its end is after the requested start
        coalesce(
          nullif(l.actual_end, '')::date,
          nullif(l.data ->> 'planned_end', '')::date
        ) is null
        or coalesce(
          nullif(l.actual_end, '')::date,
          nullif(l.data ->> 'planned_end', '')::date
        ) >= p_start_date
      )
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
    (b.asset_id is null) as is_available,
    case
      when b.asset_id is not null then 'On rent during selected period'
      else null
    end as conflict_reason
  from v_storefront_asset_catalog c
  left join booked b on b.asset_id = c.entity_id::uuid
  where (p_category_id is null or c.asset_category_id::uuid = p_category_id)
    and (p_branch_id   is null or c.branch_id::uuid          = p_branch_id);
end;
$$;

grant execute on function public.portal_storefront_get_availability to anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- 4. RPC: submit quote request
--    Security-definer insert; anon never touches the table directly.
-- -------------------------------------------------------------------------
create or replace function public.portal_storefront_submit_quote(
  p_asset_id         uuid,
  p_asset_category_id uuid,
  p_branch_id        uuid,
  p_start_date       date,
  p_end_date         date,
  p_contact_name     text,
  p_contact_email    text,
  p_contact_phone    text    default null,
  p_company_name     text    default null,
  p_notes            text    default null,
  p_rate_type        text    default null,
  p_base_amount      numeric default null,
  p_env_fee          numeric default null,
  p_damage_waiver    numeric default null,
  p_tax_amount       numeric default null,
  p_total_amount     numeric default null
)
returns table (
  quote_request_id uuid,
  created_at       timestamptz
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
  v_id           uuid;
  v_created_at   timestamptz := timezone('utc'::text, now());
  v_email        text;
  v_name         text;
begin
  if v_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_storefront_submit_quote: access denied'
      using errcode = '42501';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception 'Start date and end date are required'
      using errcode = '22023';
  end if;

  if p_start_date >= p_end_date then
    raise exception 'End date must be after start date'
      using errcode = '22023';
  end if;

  v_name := nullif(btrim(coalesce(p_contact_name, '')), '');
  if v_name is null then
    raise exception 'Contact name is required'
      using errcode = '22023';
  end if;

  v_email := lower(btrim(coalesce(p_contact_email, '')));
  if v_email = '' or v_email not like '%@%.%' then
    raise exception 'A valid contact email is required'
      using errcode = '22023';
  end if;

  insert into public.storefront_quote_requests (
    asset_id, asset_category_id, branch_id,
    start_date, end_date,
    contact_name, contact_email, contact_phone, company_name, notes,
    rate_type, base_amount, env_fee, damage_waiver, tax_amount, total_amount,
    status, created_at
  ) values (
    p_asset_id, p_asset_category_id, p_branch_id,
    p_start_date, p_end_date,
    v_name, v_email,
    nullif(btrim(coalesce(p_contact_phone,  '')), ''),
    nullif(btrim(coalesce(p_company_name,   '')), ''),
    nullif(btrim(coalesce(p_notes,          '')), ''),
    p_rate_type, p_base_amount, p_env_fee, p_damage_waiver, p_tax_amount, p_total_amount,
    'pending', v_created_at
  )
  returning id into v_id;

  quote_request_id := v_id;
  created_at       := v_created_at;
  return next;
end;
$$;

grant execute on function public.portal_storefront_submit_quote to anon, authenticated, service_role;
