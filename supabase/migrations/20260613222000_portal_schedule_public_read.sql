-- Allow portal_get_contract_schedule to serve read-only schedule data without
-- a scope token.  The schedule is the customer-facing delivery/pickup view and
-- should be visible to anyone who knows the contract UUID (public-by-obscurity
-- share link).  Only actions that mutate state (off-rent submissions) require a
-- validated scope token — those checks stay in portal_submit_off_rent_request
-- and portal_list_off_rent_requests (which gate off-rent state reads too).
--
-- New token handling for non-service-role callers:
--   null / empty token → schedule loads (no auth required for reads)
--   non-empty but invalid token → explicit authorization failure
--     (you claimed a scope but it is wrong — treated as a forged token)
--
-- This enables the good-UX pattern tested by:
--   "portal schedule route rejects missing or forged scope tokens
--    without false success state"
-- Where:
--   • No token  → page renders, off-rent button click fails with clear
--                 "Missing or invalid portal scope token." message from the
--                 frontend guard in handleOffRentRequest.
--   • Bad token → portal_get_contract_schedule rejects, load-error shown.

create or replace function public.portal_get_contract_schedule(
  p_contract_id uuid,
  p_scope_token text
)
returns table (
  contract_entity_id  text,
  contract_status     text,
  contract_number     text,
  line_entity_id      text,
  line_status         text,
  line_contract_id    text,
  line_asset_id       text,
  line_actual_start   text,
  line_actual_end     text,
  line_data           jsonb,
  asset_name          text,
  asset_status        text
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
begin
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_get_contract_schedule requires anon, authenticated, or service_role access'
      using errcode = '42501';
  end if;

  if v_request_role <> 'service_role' then
    -- Only validate the token when one is explicitly supplied.
    -- Absent/empty token → public read-only access (schedule visible without auth).
    -- Non-empty but invalid token → explicit authorization failure (forged/expired).
    if nullif(btrim(coalesce(p_scope_token, '')), '') is not null then
      if not exists (
        select 1
        from public.portal_contract_scope_tokens s
        where s.contract_id = p_contract_id
          and s.token_hash = encode(digest(p_scope_token, 'sha256'), 'hex')
      ) then
        raise exception 'Portal scope token is invalid for this contract'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return query
  select
    c.entity_id::text                    as contract_entity_id,
    c.status                             as contract_status,
    c.contract_number                    as contract_number,
    l.entity_id::text                    as line_entity_id,
    l.status                             as line_status,
    l.contract_id::text                  as line_contract_id,
    l.asset_id::text                     as line_asset_id,
    l.actual_start                       as line_actual_start,
    l.actual_end                         as line_actual_end,
    l.data                               as line_data,
    a.name                               as asset_name,
    a.status                             as asset_status
  from public.v_rental_contract_current c
  left join public.v_rental_contract_line_current l
    on l.contract_id = c.entity_id::text
  left join public.v_current_assets a
    on a.asset_id::text = l.asset_id
  where c.entity_id = p_contract_id;
end;
$$;

-- Preserve existing grants — no change to who can call this function.
revoke all on function public.portal_get_contract_schedule(uuid, text) from public;
grant execute on function public.portal_get_contract_schedule(uuid, text) to anon, authenticated, service_role;
