-- Provide controlled anon-role access to contract schedule data for the customer portal.
-- v_rental_contract_current, v_rental_contract_line_current, and v_current_assets are
-- revoked from anon (see 20260607131500_lock_down_anon_read_access). These
-- SECURITY DEFINER functions expose only the fields required by /portal/schedule/:contractId.

-- ---------------------------------------------------------------------------
-- portal_get_contract_schedule
-- Returns contract + line + asset rows for the given contract ID.
-- Requires a valid portal scope token for anon and authenticated callers;
-- service-role callers bypass the token check.
-- ---------------------------------------------------------------------------

-- Drop the previous arity-1 signature before creating the new arity-2 variant.
drop function if exists public.portal_get_contract_schedule(uuid);

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
    if nullif(btrim(coalesce(p_scope_token, '')), '') is null then
      raise exception 'Portal scope token is required'
        using errcode = '42501';
    end if;

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
    on a.asset_id = l.asset_id
  where c.entity_id = p_contract_id;
end;
$$;

revoke all on function public.portal_get_contract_schedule(uuid, text) from public;
grant execute on function public.portal_get_contract_schedule(uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- portal_get_demo_portal_url
-- Returns the portal schedule URL for the seeded demo contract, including the
-- demo scope token. Used by CI to resolve E2E_PORTAL_SCHEDULE_SCOPED_URL.
-- SECURITY: restricted to service_role only — the anon key is public by design,
-- so exposing a real scope token to anon/authenticated callers would make the
-- demo share token a public credential. CI must call this with a service_role
-- key stored as a workflow-only secret (never available to browser clients).
-- Returns NULL when the demo scope token is not seeded.
-- ---------------------------------------------------------------------------
create or replace function public.portal_get_demo_portal_url()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract_id uuid;
  v_token_hash  text;
  v_demo_token  constant text := 'dia-demo-portal-scope-001';
begin
  -- Look up the demo contract entity ID
  select e.id
    into v_contract_id
  from public.entities e
  where e.entity_type = 'rental_contract'
    and e.source_record_id = 'demo-baseline-rental-contract-002'
  limit 1;

  if v_contract_id is null then
    return null;
  end if;

  -- Verify the demo scope token is registered for this contract
  select s.token_hash
    into v_token_hash
  from public.portal_contract_scope_tokens s
  where s.contract_id = v_contract_id
    and s.token_hash = encode(digest(v_demo_token, 'sha256'), 'hex');

  if not found then
    return null;
  end if;

  return format('/portal/schedule/%s?scope=%s', v_contract_id::text, v_demo_token);
end;
$$;

revoke all on function public.portal_get_demo_portal_url() from public;
grant execute on function public.portal_get_demo_portal_url() to service_role;
