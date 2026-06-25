-- Portal-safe off-rent request surface:
-- - Exposes current request status without granting anon table access.
-- - Provides a dedicated RPC for portal submissions instead of write-guarded generic RPCs.

create or replace view public.v_portal_off_rent_request_current as
select
  e.id as request_id,
  ev.data->>'contract_id' as contract_id,
  ev.data->>'contract_line_id' as contract_line_id,
  ev.data->>'asset_id' as asset_id,
  ev.data->>'job_site_id' as job_site_id,
  ev.data->>'request_type' as request_type,
  ev.data->>'status' as status,
  ev.data->>'reason' as reason,
  ev.data->>'requested_at' as requested_at
from public.entities e
join public.entity_versions ev on ev.entity_id = e.id and ev.is_current = true
where e.entity_type = 'off_rent_request'
  and coalesce(ev.data->>'source', '') = 'portal_schedule'
  and coalesce(ev.data->>'asset_id', '') <> ''
  and coalesce(ev.data->>'contract_line_id', '') <> '';

grant select on table public.v_portal_off_rent_request_current to anon, authenticated, service_role;

create or replace function public.portal_submit_off_rent_request(
  p_contract_id uuid,
  p_contract_line_id uuid,
  p_reason text default 'Flagged idle by site user from portal schedule'
)
returns table (
  request_id uuid,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_asset_id text;
  v_job_site_id text;
  v_line_status text;
  v_request_id uuid;
  v_requested_at timestamptz := now();
  v_reason text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );

  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_submit_off_rent_request requires portal or authenticated access'
      using errcode = '42501';
  end if;

  select l.asset_id, l.data->>'job_site_id', l.status
    into v_asset_id, v_job_site_id, v_line_status
  from public.v_rental_contract_line_current l
  where l.entity_id = p_contract_line_id
    and l.contract_id = p_contract_id::text;

  if not found then
    raise exception 'Unknown contract line for contract'
      using errcode = '22023';
  end if;

  if v_line_status <> 'checked_out' then
    raise exception 'Off-rent requests are only allowed for checked-out lines'
      using errcode = '22023';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    v_reason := 'Flagged idle by site user from portal schedule';
  end if;

  insert into public.entities (entity_type, source_record_id)
  values ('off_rent_request', format('portal-schedule:%s:%s:%s', p_contract_id::text, p_contract_line_id::text, v_requested_at))
  returning id into v_request_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_request_id,
    1,
    jsonb_build_object(
      'contract_id', p_contract_id,
      'contract_line_id', p_contract_line_id,
      'asset_id', v_asset_id,
      'job_site_id', v_job_site_id,
      'request_type', 'off_rent_pickup',
      'status', 'requested',
      'reason', v_reason,
      'requested_at', v_requested_at,
      'source', 'portal_schedule'
    )
  );

  request_id := v_request_id;
  requested_at := v_requested_at;
  return next;
end;
$$;

revoke all on function public.portal_submit_off_rent_request(uuid, uuid, text) from public;
grant execute on function public.portal_submit_off_rent_request(uuid, uuid, text) to anon, authenticated, service_role;
