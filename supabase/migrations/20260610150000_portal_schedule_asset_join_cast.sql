-- Keep portal_get_contract_schedule join type-safe when contract-line asset_id
-- is text while v_current_assets.asset_id is uuid.
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
    on a.asset_id::text = l.asset_id
  where c.entity_id = p_contract_id;
end;
$$;
