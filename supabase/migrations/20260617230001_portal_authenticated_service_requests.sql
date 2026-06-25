-- Portal authenticated service requests: call-off and extension request submission
-- via Supabase GoTrue authenticated sessions (portal_customer role).
--
-- Adds:
--   1. portal_customer_access_grant — maps auth users to customer/billing scope.
--   2. portal_get_authenticated_rentals — lists contract lines available to the
--      authenticated portal customer (scoped by JWT customer_id claim).
--   3. portal_submit_authenticated_service_request — creates a durable
--      off_rent_request entity without mutating contract or line state.
--   4. portal_list_authenticated_service_requests — lists service requests for
--      contracts within the authenticated customer scope.
--
-- Security model:
--   - All write/read RPCs reject anon callers; authenticated sessions must carry
--     a portal_customer role claim or service_role bypass.
--   - Scope is derived from JWT claims (customer_id / customer_ids), never from
--     caller-supplied query parameters.
--   - Contract/line state is never mutated by any RPC in this file.
--
-- References: ADR-0043

-- ---------------------------------------------------------------------------
-- 1. portal_customer_access_grant
-- ---------------------------------------------------------------------------

create table if not exists public.portal_customer_access_grant (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            text        not null,
  -- contact_entity_id references the entity_id of the CRM contact record (text PK)
  -- in the entities table; no FK enforced here because the contact entity may not
  -- exist yet at grant-creation time and the portal falls back to JWT scope claims.
  contact_entity_id    text,
  auth_user_id         uuid        unique,
  -- customer_id is a text foreign key into the entities table (entity_type='customer').
  -- No FK constraint is enforced because ADR-0019 defers broad FK scaffolding, and
  -- scope enforcement is performed at the RPC layer via JWT claims rather than at the
  -- table level.  Orphan detection is the operator's responsibility on grant revocation.
  customer_id          text        not null,
  billing_account_ids  text[]      not null default '{}',
  status               text        not null default 'active'
                         check (status in ('pending', 'active', 'revoked')),
  issued_at            timestamptz not null default now(),
  revoked_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.portal_customer_access_grant is
  'Maps a Supabase GoTrue auth user to the tenant/customer/billing-account scope '
  'they are permitted to read and write through the portal. '
  'Referenced by ADR-0043.';

-- Operator/service-role-only table access.  Authenticated portal users derive
-- their scope from JWT claims resolved inside SECURITY DEFINER RPCs — they must
-- never be able to query, insert, or modify grant records directly.
revoke all on table public.portal_customer_access_grant from public, anon, authenticated;
alter table public.portal_customer_access_grant enable row level security;
-- No permissive RLS policies for anon or authenticated; service_role bypasses RLS
-- (Supabase/PostgREST default), so only service_role can read/write this table.

-- ---------------------------------------------------------------------------
-- 2. portal_get_authenticated_rentals
-- ---------------------------------------------------------------------------

create or replace function public.portal_get_authenticated_rentals()
returns table (
  contract_entity_id   text,
  contract_status      text,
  contract_number      text,
  line_entity_id       text,
  line_status          text,
  line_asset_id        text,
  line_actual_start    text,
  line_actual_end      text,
  line_data            jsonb,
  asset_name           text,
  asset_status         text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims       jsonb  := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb, '{}'::jsonb);
  v_request_role text   := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(v_claims ->> 'role', ''),
    ''
  );
  v_customer_ids       text[];
  v_user_sub           uuid;
  v_grant_customer_ids text[];
begin
  if v_request_role not in ('authenticated', 'service_role') then
    raise exception 'portal_get_authenticated_rentals requires authenticated or service_role access'
      using errcode = '42501';
  end if;

  -- Authenticated callers must carry the portal_customer app role claim.
  if v_request_role = 'authenticated'
     and coalesce(v_claims -> 'app_metadata' ->> 'role', '') <> 'portal_customer' then
    raise exception 'portal_get_authenticated_rentals requires portal_customer app role'
      using errcode = '42501';
  end if;

  -- Resolve customer scope from JWT claims (mirrors portal_get_financial_entities pattern).
  select coalesce(array_agg(distinct val), '{}'::text[])
    into v_customer_ids
  from (
    select nullif(btrim(v_claims ->> 'customer_id'), '') as val
    union all
    select nullif(btrim(v_claims -> 'app_metadata' ->> 'customer_id'), '')
    union all
    select nullif(btrim(elem), '')
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_claims -> 'customer_ids') = 'array'
           then v_claims -> 'customer_ids' else '[]'::jsonb end
    ) elem
    union all
    select nullif(btrim(elem), '')
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_claims -> 'app_metadata' -> 'customer_ids') = 'array'
           then v_claims -> 'app_metadata' -> 'customer_ids' else '[]'::jsonb end
    ) elem
  ) scope_vals
  where val is not null;

  -- Fail closed: authenticated callers must carry at least one customer scope claim.
  if v_request_role = 'authenticated' and v_customer_ids = '{}'::text[] then
    raise exception 'portal_get_authenticated_rentals requires a customer_id or customer_ids scope claim'
      using errcode = '42501';
  end if;

  -- For authenticated callers, verify the caller has an active portal customer grant
  -- and intersect grant-authorized scope with JWT-claimed scope to prevent spoofing.
  if v_request_role = 'authenticated' then
    v_user_sub := nullif(btrim(v_claims ->> 'sub'), '')::uuid;
    if v_user_sub is null then
      raise exception 'portal_get_authenticated_rentals requires a valid sub claim'
        using errcode = '42501';
    end if;

    select array_agg(distinct cid)
      into v_grant_customer_ids
    from (
      select g.customer_id as cid
      from public.portal_customer_access_grant g
      where g.auth_user_id = v_user_sub and g.status = 'active'
      union all
      select unnest(g.billing_account_ids) as cid
      from public.portal_customer_access_grant g
      where g.auth_user_id = v_user_sub and g.status = 'active'
    ) t
    where cid is not null and cid <> '';

    if v_grant_customer_ids is null then
      raise exception 'portal_get_authenticated_rentals: no active portal customer grant for caller'
        using errcode = '42501';
    end if;

    -- Restrict to the intersection of JWT-claimed and grant-authorized customer IDs.
    select array_agg(distinct id)
      into v_customer_ids
    from unnest(v_customer_ids) id
    where id = any(v_grant_customer_ids);

    v_customer_ids := coalesce(v_customer_ids, '{}'::text[]);
    if v_customer_ids = '{}'::text[] then
      raise exception 'portal_get_authenticated_rentals: JWT customer claims not authorized by active grant'
        using errcode = '42501';
    end if;
  end if;

  -- service_role bypass: return all active contracts (for testing/admin).
  if v_request_role = 'service_role' then
    v_customer_ids := null;
  end if;

  return query
  -- entity_id columns in the base views are uuid (e.id); the RETURNS TABLE
  -- declares them as text to keep the API surface stable and JSON-friendly.
  -- contract_id in v_rental_contract_line_current is text (extracted from jsonb),
  -- so the join on c.entity_id requires ::text.  asset_id in v_current_assets is
  -- uuid, so the join on l.asset_id (text) requires ::text on the asset side.
  select
    c.entity_id::text                    as contract_entity_id,
    c.status                             as contract_status,
    c.data->>'contract_number'           as contract_number,
    l.entity_id::text                    as line_entity_id,
    l.status                             as line_status,
    l.asset_id                           as line_asset_id,
    l.actual_start                       as line_actual_start,
    l.actual_end                         as line_actual_end,
    l.data                               as line_data,
    a.name                               as asset_name,
    a.status                             as asset_status
  from public.v_rental_contract_current c
  join public.v_rental_contract_line_current l on l.contract_id = c.entity_id::text
  left join public.v_current_assets a on a.asset_id::text = l.asset_id
  where
    c.status in ('active', 'pending_execution')
    and (
      v_customer_ids is null
      or c.data->>'customer_id' = any(v_customer_ids)
      or c.data->>'billing_account_id' = any(v_customer_ids)
    )
  order by c.entity_id, l.entity_id;
end;
$$;

revoke all on function public.portal_get_authenticated_rentals() from public;
grant execute on function public.portal_get_authenticated_rentals() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. portal_submit_authenticated_service_request
-- ---------------------------------------------------------------------------

create or replace function public.portal_submit_authenticated_service_request(
  p_contract_id      uuid,
  p_contract_line_id uuid,
  p_request_type     text    default 'off_rent_pickup',
  p_urgency          text    default 'standard',
  p_reason           text    default null,
  p_customer_note    text    default null,
  p_has_supporting_photos      boolean default false,
  p_missing_contract_context   boolean default false
)
returns table (
  request_id       uuid,
  requested_at     timestamptz,
  deduped          boolean,
  disposition_path text,
  evidence_gaps    text[]
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_claims       jsonb  := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb, '{}'::jsonb);
  v_request_role text   := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(v_claims ->> 'role', ''),
    ''
  );
  v_user_id              text;
  v_customer_ids         text[];
  v_asset_id             text;
  v_job_site_id          text;
  v_line_status          text;
  v_contract_customer_id text;
  v_request_id           uuid;
  v_now                  timestamptz := clock_timestamp();
  v_existing_version_number int;
  v_existing_data        jsonb;
  v_request_type         text;
  v_urgency              text;
  v_reason               text;
  v_customer_note        text;
  v_disposition_path     text;
  v_recommended_disposition text;
  v_evidence_gaps        text[] := array[]::text[];
  v_evidence_gaps_json   jsonb;
  v_is_material_update   boolean;
  v_user_sub             uuid;
  v_grant_customer_ids   text[];
begin
  -- Reject anonymous callers — authenticated session required.
  if v_request_role not in ('authenticated', 'service_role') then
    raise exception 'portal_submit_authenticated_service_request requires authenticated or service_role access'
      using errcode = '42501';
  end if;

  -- Authenticated callers must carry the portal_customer app role claim.
  if v_request_role = 'authenticated'
     and coalesce(v_claims -> 'app_metadata' ->> 'role', '') <> 'portal_customer' then
    raise exception 'portal_submit_authenticated_service_request requires portal_customer app role'
      using errcode = '42501';
  end if;

  -- Resolve caller identity and customer scope from JWT claims.
  v_user_id := nullif(btrim(coalesce(
    v_claims ->> 'sub',
    v_claims -> 'app_metadata' ->> 'sub',
    ''
  )), '');

  select coalesce(array_agg(distinct val), '{}'::text[])
    into v_customer_ids
  from (
    select nullif(btrim(v_claims ->> 'customer_id'), '') as val
    union all
    select nullif(btrim(v_claims -> 'app_metadata' ->> 'customer_id'), '')
    union all
    select nullif(btrim(elem), '')
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_claims -> 'customer_ids') = 'array'
           then v_claims -> 'customer_ids' else '[]'::jsonb end
    ) elem
    union all
    select nullif(btrim(elem), '')
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_claims -> 'app_metadata' -> 'customer_ids') = 'array'
           then v_claims -> 'app_metadata' -> 'customer_ids' else '[]'::jsonb end
    ) elem
  ) scope_vals
  where val is not null;

  -- Fail closed: authenticated callers without a customer scope claim are denied.
  -- An empty customer_ids array means no scope was resolved from JWT claims; this
  -- prevents callers with a valid authenticated session but no portal grant from
  -- submitting requests against arbitrary contracts.
  if v_request_role <> 'service_role' and v_customer_ids = '{}'::text[] then
    raise exception 'portal_submit_authenticated_service_request requires a customer_id or customer_ids scope claim'
      using errcode = '42501';
  end if;

  -- For authenticated callers, verify the caller has an active portal customer grant
  -- and intersect grant-authorized scope with JWT-claimed scope to prevent spoofing.
  if v_request_role <> 'service_role' then
    v_user_sub := nullif(btrim(v_claims ->> 'sub'), '')::uuid;
    if v_user_sub is null then
      raise exception 'portal_submit_authenticated_service_request requires a valid sub claim'
        using errcode = '42501';
    end if;

    select array_agg(distinct cid)
      into v_grant_customer_ids
    from (
      select g.customer_id as cid
      from public.portal_customer_access_grant g
      where g.auth_user_id = v_user_sub and g.status = 'active'
      union all
      select unnest(g.billing_account_ids) as cid
      from public.portal_customer_access_grant g
      where g.auth_user_id = v_user_sub and g.status = 'active'
    ) t
    where cid is not null and cid <> '';

    if v_grant_customer_ids is null then
      raise exception 'portal_submit_authenticated_service_request: no active portal customer grant for caller'
        using errcode = '42501';
    end if;

    -- Restrict to the intersection of JWT-claimed and grant-authorized customer IDs.
    select array_agg(distinct id)
      into v_customer_ids
    from unnest(v_customer_ids) id
    where id = any(v_grant_customer_ids);

    v_customer_ids := coalesce(v_customer_ids, '{}'::text[]);
    if v_customer_ids = '{}'::text[] then
      raise exception 'portal_submit_authenticated_service_request: JWT customer claims not authorized by active grant'
        using errcode = '42501';
    end if;
  end if;

  -- For authenticated (non-service_role) callers, verify the contract belongs
  -- to the caller's customer scope.
  if v_request_role <> 'service_role' then
    select c.data->>'customer_id'
      into v_contract_customer_id
    from public.v_rental_contract_current c
    where c.entity_id = p_contract_id;

    if not found then
      raise exception 'Contract not found'
        using errcode = '22023';
    end if;

    if v_contract_customer_id is null or v_contract_customer_id <> all(v_customer_ids) then
      raise exception 'Contract is outside the authenticated customer scope'
        using errcode = '42501';
    end if;
  end if;

  -- Fetch line context and enforce eligibility.
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
    raise exception 'Customer requests are only allowed for checked-out lines'
      using errcode = '22023';
  end if;

  -- Normalise and validate inputs.
  v_request_type := case lower(coalesce(p_request_type, 'off_rent_pickup'))
    when 'off_rent_pickup'     then 'off_rent_pickup'
    when 'contract_extension'  then 'contract_extension'
    when 'field_service'       then 'field_service'
    else null
  end;
  if v_request_type is null then
    raise exception 'Unsupported request type'
      using errcode = '22023';
  end if;

  v_urgency := case lower(coalesce(p_urgency, 'standard'))
    when 'critical' then 'critical'
    when 'high'     then 'high'
    when 'standard' then 'standard'
    when 'low'      then 'low'
    else 'standard'
  end;
  v_reason        := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Customer requested follow-up from portal');
  v_customer_note := nullif(btrim(coalesce(p_customer_note, '')), '');

  -- Build evidence gap list — does not gate submission, feeds staff queue context.
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
    when 'off_rent_pickup'    then 'pickup_review'
    when 'contract_extension' then 'extension_review'
    when 'field_service'      then 'field_service_triage'
    else 'manual_follow_up'
  end;

  v_recommended_disposition := case v_request_type
    when 'off_rent_pickup'    then 'Review pickup/call-off readiness with contract line context, then schedule manually after branch approval.'
    when 'contract_extension' then 'Validate extension terms and branch availability, then approve or follow up manually with the customer.'
    when 'field_service'      then 'Triage field-service urgency and evidence, then dispatch only after branch approval.'
    else 'Branch review required before customer-facing commitments.'
  end;

  -- Idempotency: find any open request for same (contract, line, type).
  select e.id, ev.version_number, ev.data
    into v_request_id, v_existing_version_number, v_existing_data
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current = true
  where e.entity_type = 'off_rent_request'
    and coalesce(ev.data->>'source', '') = 'portal_authenticated'
    and ev.data->>'contract_id' = p_contract_id::text
    and ev.data->>'contract_line_id' = p_contract_line_id::text
    and coalesce(ev.data->>'request_type', 'off_rent_pickup') = v_request_type
    and coalesce(ev.data->>'status', 'requested') in ('requested', 'under_review', 'needs_follow_up')
  order by coalesce(ev.data->>'requested_at', '') desc
  limit 1;

  if v_request_id is null then
    -- New request — create entity + initial version.
    insert into public.entities (entity_type, source_record_id)
    values (
      'off_rent_request',
      format('portal-auth:%s:%s:%s:%s', p_contract_id::text, p_contract_line_id::text, v_request_type, v_now)
    )
    returning id into v_request_id;

    insert into public.entity_versions (entity_id, version_number, data)
    values (
      v_request_id,
      1,
      jsonb_build_object(
        'contract_id',            p_contract_id,
        'contract_line_id',       p_contract_line_id,
        'asset_id',               v_asset_id,
        'job_site_id',            v_job_site_id,
        'request_type',           v_request_type,
        'status',                 'requested',
        'urgency',                v_urgency,
        'reason',                 v_reason,
        'customer_note',          v_customer_note,
        'requester_user_id',      v_user_id,
        'has_supporting_photos',  coalesce(p_has_supporting_photos, false),
        'missing_contract_context', coalesce(p_missing_contract_context, false),
        'evidence_gaps',          to_jsonb(v_evidence_gaps),
        'disposition_path',       v_disposition_path,
        'recommended_disposition', v_recommended_disposition,
        'requires_human_approval', true,
        'requested_at',           v_now,
        'latest_signal_at',       v_now,
        'operating_model_tags',   jsonb_build_array(
          'rental-customer-portal-user:t2',
          'rental-customer-portal-user:t3',
          'rental-customer-portal-user:t6'
        ),
        'source',                 'portal_authenticated'
      )
    );

    request_id       := v_request_id;
    requested_at     := v_now;
    deduped          := false;
    disposition_path := v_disposition_path;
    evidence_gaps    := v_evidence_gaps;
    return next;
    return;
  end if;

  -- Existing open request — update if material fields changed.
  v_evidence_gaps_json    := to_jsonb(v_evidence_gaps);
  v_is_material_update    :=
    coalesce(v_existing_data->>'urgency', 'standard') <> v_urgency
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

  request_id       := v_request_id;
  requested_at     := coalesce((v_existing_data->>'requested_at')::timestamptz, v_now);
  disposition_path := v_disposition_path;
  evidence_gaps    := v_evidence_gaps;
  return next;
end;
$$;

revoke all on function public.portal_submit_authenticated_service_request(uuid, uuid, text, text, text, text, boolean, boolean) from public;
grant execute on function public.portal_submit_authenticated_service_request(uuid, uuid, text, text, text, text, boolean, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. portal_list_authenticated_service_requests
-- ---------------------------------------------------------------------------

create or replace function public.portal_list_authenticated_service_requests()
returns table (
  request_id              uuid,
  contract_id             text,
  contract_line_id        text,
  asset_id                text,
  job_site_id             text,
  request_type            text,
  status                  text,
  urgency                 text,
  reason                  text,
  customer_note           text,
  has_supporting_photos   boolean,
  missing_contract_context boolean,
  evidence_gaps           text[],
  disposition_path        text,
  recommended_disposition text,
  requires_human_approval boolean,
  requested_at            text
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_claims       jsonb  := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb, '{}'::jsonb);
  v_request_role text   := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(v_claims ->> 'role', ''),
    ''
  );
  v_customer_ids       text[];
  v_user_sub           uuid;
  v_grant_customer_ids text[];
begin
  if v_request_role not in ('authenticated', 'service_role') then
    raise exception 'portal_list_authenticated_service_requests requires authenticated or service_role access'
      using errcode = '42501';
  end if;

  -- Authenticated callers must carry the portal_customer app role claim.
  if v_request_role = 'authenticated'
     and coalesce(v_claims -> 'app_metadata' ->> 'role', '') <> 'portal_customer' then
    raise exception 'portal_list_authenticated_service_requests requires portal_customer app role'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct val), '{}'::text[])
    into v_customer_ids
  from (
    select nullif(btrim(v_claims ->> 'customer_id'), '') as val
    union all
    select nullif(btrim(v_claims -> 'app_metadata' ->> 'customer_id'), '')
    union all
    select nullif(btrim(elem), '')
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_claims -> 'customer_ids') = 'array'
           then v_claims -> 'customer_ids' else '[]'::jsonb end
    ) elem
    union all
    select nullif(btrim(elem), '')
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_claims -> 'app_metadata' -> 'customer_ids') = 'array'
           then v_claims -> 'app_metadata' -> 'customer_ids' else '[]'::jsonb end
    ) elem
  ) scope_vals
  where val is not null;

  -- Fail closed: authenticated callers without a customer scope claim are denied.
  if v_request_role <> 'service_role' and v_customer_ids = '{}'::text[] then
    raise exception 'portal_list_authenticated_service_requests requires a customer_id or customer_ids scope claim'
      using errcode = '42501';
  end if;

  -- For authenticated callers, verify the caller has an active portal customer grant
  -- and intersect grant-authorized scope with JWT-claimed scope to prevent spoofing.
  if v_request_role <> 'service_role' then
    v_user_sub := nullif(btrim(v_claims ->> 'sub'), '')::uuid;
    if v_user_sub is null then
      raise exception 'portal_list_authenticated_service_requests requires a valid sub claim'
        using errcode = '42501';
    end if;

    select array_agg(distinct cid)
      into v_grant_customer_ids
    from (
      select g.customer_id as cid
      from public.portal_customer_access_grant g
      where g.auth_user_id = v_user_sub and g.status = 'active'
      union all
      select unnest(g.billing_account_ids) as cid
      from public.portal_customer_access_grant g
      where g.auth_user_id = v_user_sub and g.status = 'active'
    ) t
    where cid is not null and cid <> '';

    if v_grant_customer_ids is null then
      raise exception 'portal_list_authenticated_service_requests: no active portal customer grant for caller'
        using errcode = '42501';
    end if;

    -- Restrict to the intersection of JWT-claimed and grant-authorized customer IDs.
    select array_agg(distinct id)
      into v_customer_ids
    from unnest(v_customer_ids) id
    where id = any(v_grant_customer_ids);

    v_customer_ids := coalesce(v_customer_ids, '{}'::text[]);
    if v_customer_ids = '{}'::text[] then
      raise exception 'portal_list_authenticated_service_requests: JWT customer claims not authorized by active grant'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    e.id as request_id,
    ev.data->>'contract_id'     as contract_id,
    ev.data->>'contract_line_id' as contract_line_id,
    ev.data->>'asset_id'        as asset_id,
    ev.data->>'job_site_id'     as job_site_id,
    coalesce(ev.data->>'request_type', 'off_rent_pickup') as request_type,
    coalesce(ev.data->>'status', 'requested')             as status,
    coalesce(ev.data->>'urgency', 'standard')             as urgency,
    coalesce(ev.data->>'reason', '')                      as reason,
    nullif(ev.data->>'customer_note', '')                 as customer_note,
    coalesce((ev.data->>'has_supporting_photos')::boolean, false)    as has_supporting_photos,
    coalesce((ev.data->>'missing_contract_context')::boolean, false) as missing_contract_context,
    coalesce(
      (select array_agg(gap)
       from jsonb_array_elements_text(coalesce(ev.data->'evidence_gaps', '[]'::jsonb)) gap),
      array[]::text[]
    ) as evidence_gaps,
    coalesce(ev.data->>'disposition_path', 'manual_follow_up') as disposition_path,
    coalesce(ev.data->>'recommended_disposition', 'Branch review required before customer-facing commitments.') as recommended_disposition,
    coalesce((ev.data->>'requires_human_approval')::boolean, true) as requires_human_approval,
    ev.data->>'requested_at' as requested_at
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current = true
  -- c.entity_id is uuid; ev.data->>'contract_id' is text extracted from jsonb,
  -- so ::text cast on entity_id is required to match types.
  join public.v_rental_contract_current c on c.entity_id::text = ev.data->>'contract_id'
  where e.entity_type = 'off_rent_request'
    and coalesce(ev.data->>'source', '') = 'portal_authenticated'
    and (
      v_request_role = 'service_role'
      or c.data->>'customer_id' = any(v_customer_ids)
    )
  order by coalesce(ev.data->>'requested_at', '') desc;
end;
$$;

revoke all on function public.portal_list_authenticated_service_requests() from public;
grant execute on function public.portal_list_authenticated_service_requests() to authenticated, service_role;
