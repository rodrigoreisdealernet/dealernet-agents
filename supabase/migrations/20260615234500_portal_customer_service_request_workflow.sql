-- Customer pickup / extension / field-service assist workflow for portal schedule.
-- Adds canonical request submission + listing RPCs with scope-token enforcement
-- and update-in-place deduplication per (contract, line, request_type).

create or replace function public.portal_list_customer_service_requests(
  p_contract_id uuid,
  p_scope_token text
)
returns table (
  request_id uuid,
  contract_id text,
  contract_line_id text,
  asset_id text,
  job_site_id text,
  request_type text,
  status text,
  urgency text,
  reason text,
  customer_note text,
  has_supporting_photos boolean,
  missing_contract_context boolean,
  evidence_gaps text[],
  disposition_path text,
  recommended_disposition text,
  requires_human_approval boolean,
  requested_at text
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
  v_scope_job_site_id text;
begin
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_list_customer_service_requests requires anon, authenticated, or service_role access'
      using errcode = '42501';
  end if;

  if v_request_role <> 'service_role' then
    if nullif(btrim(coalesce(p_scope_token, '')), '') is null then
      raise exception 'Portal scope token is required'
        using errcode = '42501';
    end if;

    select s.job_site_id
      into v_scope_job_site_id
    from public.portal_contract_scope_tokens s
    where s.contract_id = p_contract_id
      and s.token_hash = encode(digest(convert_to(p_scope_token, 'UTF8'), 'sha256'::text), 'hex');

    if not found then
      raise exception 'Portal scope token is invalid for this contract'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    e.id as request_id,
    ev.data->>'contract_id' as contract_id,
    ev.data->>'contract_line_id' as contract_line_id,
    ev.data->>'asset_id' as asset_id,
    ev.data->>'job_site_id' as job_site_id,
    coalesce(ev.data->>'request_type', 'off_rent_pickup') as request_type,
    coalesce(ev.data->>'status', 'requested') as status,
    coalesce(ev.data->>'urgency', 'standard') as urgency,
    coalesce(ev.data->>'reason', '') as reason,
    nullif(ev.data->>'customer_note', '') as customer_note,
    coalesce((ev.data->>'has_supporting_photos')::boolean, false) as has_supporting_photos,
    coalesce((ev.data->>'missing_contract_context')::boolean, false) as missing_contract_context,
    coalesce(
      (
        select array_agg(value)
        from jsonb_array_elements_text(coalesce(ev.data->'evidence_gaps', '[]'::jsonb)) as value
      ),
      array[]::text[]
    ) as evidence_gaps,
    coalesce(ev.data->>'disposition_path', 'manual_follow_up') as disposition_path,
    coalesce(ev.data->>'recommended_disposition', 'Branch review required before customer-facing commitments.') as recommended_disposition,
    coalesce((ev.data->>'requires_human_approval')::boolean, true) as requires_human_approval,
    ev.data->>'requested_at' as requested_at
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current = true
  where e.entity_type = 'off_rent_request'
    and coalesce(ev.data->>'source', '') = 'portal_schedule'
    and ev.data->>'contract_id' = p_contract_id::text
    and (v_scope_job_site_id is null or coalesce(ev.data->>'job_site_id', '') = v_scope_job_site_id)
  order by coalesce(ev.data->>'requested_at', '') desc;
end;
$$;

revoke all on function public.portal_list_customer_service_requests(uuid, text) from public;
grant execute on function public.portal_list_customer_service_requests(uuid, text) to anon, authenticated, service_role;

create or replace function public.portal_submit_customer_service_request(
  p_contract_id uuid,
  p_contract_line_id uuid,
  p_scope_token text,
  p_request_type text default 'off_rent_pickup',
  p_urgency text default 'standard',
  p_reason text default null,
  p_customer_note text default null,
  p_has_supporting_photos boolean default false,
  p_missing_contract_context boolean default false
)
returns table (
  request_id uuid,
  requested_at timestamptz,
  deduped boolean,
  disposition_path text,
  evidence_gaps text[]
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
  v_scope_job_site_id text;
  v_asset_id text;
  v_job_site_id text;
  v_line_status text;
  v_request_id uuid;
  v_now timestamptz := clock_timestamp();
  v_existing_version_number int;
  v_existing_data jsonb;
  v_request_type text;
  v_urgency text;
  v_reason text;
  v_customer_note text;
  v_disposition_path text;
  v_recommended_disposition text;
  v_evidence_gaps text[] := array[]::text[];
  v_evidence_gaps_json jsonb;
  v_is_material_update boolean;
begin
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_submit_customer_service_request requires anon, authenticated, or service_role access'
      using errcode = '42501';
  end if;

  if v_request_role <> 'service_role' then
    if nullif(btrim(coalesce(p_scope_token, '')), '') is null then
      raise exception 'Portal scope token is required'
        using errcode = '42501';
    end if;

    select s.job_site_id
      into v_scope_job_site_id
    from public.portal_contract_scope_tokens s
    where s.contract_id = p_contract_id
      and s.token_hash = encode(digest(convert_to(p_scope_token, 'UTF8'), 'sha256'::text), 'hex');

    if not found then
      raise exception 'Portal scope token is invalid for this contract'
        using errcode = '42501';
    end if;
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

  if v_scope_job_site_id is not null and coalesce(v_job_site_id, '') <> v_scope_job_site_id then
    raise exception 'Contract line job site is outside portal scope'
      using errcode = '42501';
  end if;

  if v_line_status <> 'checked_out' then
    raise exception 'Customer requests are only allowed for checked-out lines'
      using errcode = '22023';
  end if;

  v_request_type := case lower(coalesce(p_request_type, 'off_rent_pickup'))
    when 'off_rent_pickup' then 'off_rent_pickup'
    when 'contract_extension' then 'contract_extension'
    when 'field_service' then 'field_service'
    else null
  end;
  if v_request_type is null then
    raise exception 'Unsupported request type'
      using errcode = '22023';
  end if;

  v_urgency := case lower(coalesce(p_urgency, 'standard'))
    when 'critical' then 'critical'
    when 'high' then 'high'
    when 'standard' then 'standard'
    when 'low' then 'low'
    else 'standard'
  end;
  v_reason := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Customer requested follow-up from portal schedule');
  v_customer_note := nullif(btrim(coalesce(p_customer_note, '')), '');

  if not coalesce(p_has_supporting_photos, false) then
    v_evidence_gaps := array_append(v_evidence_gaps, 'supporting_photos_missing');
  end if;
  if coalesce(p_missing_contract_context, false) then
    v_evidence_gaps := array_append(v_evidence_gaps, 'contract_context_missing');
  end if;
  if v_request_type = 'field_service' and v_customer_note is null then
    v_evidence_gaps := array_append(v_evidence_gaps, 'service_symptoms_missing');
  end if;

  v_disposition_path := case v_request_type
    when 'off_rent_pickup' then 'pickup_review'
    when 'contract_extension' then 'extension_review'
    when 'field_service' then 'field_service_triage'
    else 'manual_follow_up'
  end;

  v_recommended_disposition := case v_request_type
    when 'off_rent_pickup' then 'Review pickup/call-off readiness with contract line context, then schedule manually after branch approval.'
    when 'contract_extension' then 'Validate extension terms and branch availability, then approve or follow up manually with the customer.'
    when 'field_service' then 'Triage field-service urgency and evidence, then dispatch only after branch approval.'
    else 'Branch review required before customer-facing commitments.'
  end;

  select e.id, ev.version_number, ev.data
    into v_request_id, v_existing_version_number, v_existing_data
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current = true
  where e.entity_type = 'off_rent_request'
    and coalesce(ev.data->>'source', '') = 'portal_schedule'
    and ev.data->>'contract_id' = p_contract_id::text
    and ev.data->>'contract_line_id' = p_contract_line_id::text
    and coalesce(ev.data->>'request_type', 'off_rent_pickup') = v_request_type
    and coalesce(ev.data->>'status', 'requested') in ('requested', 'under_review', 'needs_follow_up')
  order by coalesce(ev.data->>'requested_at', '') desc
  limit 1;

  if v_request_id is null then
    insert into public.entities (entity_type, source_record_id)
    values ('off_rent_request', format('portal-schedule:%s:%s:%s:%s', p_contract_id::text, p_contract_line_id::text, v_request_type, v_now))
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
        'request_type', v_request_type,
        'status', 'requested',
        'urgency', v_urgency,
        'reason', v_reason,
        'customer_note', v_customer_note,
        'has_supporting_photos', coalesce(p_has_supporting_photos, false),
        'missing_contract_context', coalesce(p_missing_contract_context, false),
        'evidence_gaps', to_jsonb(v_evidence_gaps),
        'disposition_path', v_disposition_path,
        'recommended_disposition', v_recommended_disposition,
        'requires_human_approval', true,
        'requested_at', v_now,
        'latest_signal_at', v_now,
        'operating_model_tags', jsonb_build_array(
          'rental-customer-portal-user:t2',
          'rental-customer-portal-user:t3',
          'rental-customer-portal-user:t6'
        ),
        'source', 'portal_schedule'
      )
    );

    request_id := v_request_id;
    requested_at := v_now;
    deduped := false;
    disposition_path := v_disposition_path;
    evidence_gaps := v_evidence_gaps;
    return next;
    return;
  end if;

  v_evidence_gaps_json := to_jsonb(v_evidence_gaps);
  v_is_material_update := coalesce(v_existing_data->>'urgency', 'standard') <> v_urgency
    or coalesce(v_existing_data->>'reason', '') <> v_reason
    or coalesce(v_existing_data->>'customer_note', '') <> coalesce(v_customer_note, '')
    or coalesce((v_existing_data->>'has_supporting_photos')::boolean, false) <> coalesce(p_has_supporting_photos, false)
    or coalesce((v_existing_data->>'missing_contract_context')::boolean, false) <> coalesce(p_missing_contract_context, false)
    or coalesce(v_existing_data->'evidence_gaps', '[]'::jsonb) <> v_evidence_gaps_json;

  if v_is_material_update then
    insert into public.entity_versions (entity_id, version_number, data)
    values (
      v_request_id,
      v_existing_version_number + 1,
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(
                        coalesce(v_existing_data, '{}'::jsonb),
                        '{urgency}', to_jsonb(v_urgency), true
                      ),
                      '{reason}', to_jsonb(v_reason), true
                    ),
                    '{customer_note}', to_jsonb(v_customer_note), true
                  ),
                  '{has_supporting_photos}', to_jsonb(coalesce(p_has_supporting_photos, false)), true
                ),
                '{missing_contract_context}', to_jsonb(coalesce(p_missing_contract_context, false)), true
              ),
              '{evidence_gaps}', v_evidence_gaps_json, true
            ),
            '{disposition_path}', to_jsonb(v_disposition_path), true
          ),
          '{recommended_disposition}', to_jsonb(v_recommended_disposition), true
        ),
        '{latest_signal_at}', to_jsonb(v_now), true
      )
    );
    deduped := false;
  else
    deduped := true;
  end if;

  request_id := v_request_id;
  requested_at := coalesce((v_existing_data->>'requested_at')::timestamptz, v_now);
  disposition_path := v_disposition_path;
  evidence_gaps := v_evidence_gaps;
  return next;
end;
$$;

revoke all on function public.portal_submit_customer_service_request(uuid, uuid, text, text, text, text, text, boolean, boolean) from public;
grant execute on function public.portal_submit_customer_service_request(uuid, uuid, text, text, text, text, text, boolean, boolean) to anon, authenticated, service_role;
