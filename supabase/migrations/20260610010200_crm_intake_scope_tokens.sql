-- ---------------------------------------------------------------------------
-- CRM: Secure self-serve intake via email/SMS forms
--
-- Introduces portal_intake_scope_tokens – a narrow, revocable, time-bounded
-- token boundary for pre-contract customer intake sessions.
--
-- Key design decisions:
--   - Kept separate from portal_contract_scope_tokens (which is contract-
--     scoped) because intake links are issued before a contract exists.
--   - Tokens are high-entropy raw values stored only as SHA-256 hashes.
--   - A token is scoped to exactly one (tenant_id, customer_candidate_id)
--     pair and expires at a wall-clock timestamp.
--   - Revocation is supported via revoked_at; any non-null value makes the
--     token invalid regardless of expiry.
--   - The submit RPC creates / enriches customer, contact, and job-site
--     entities through explicit allowed fields only; no arbitrary JSON merge
--     path from the public surface.
--   - Document metadata staging references a signed-URL storage key only;
--     document retrieval is authenticated back-office only.
-- ---------------------------------------------------------------------------

-- 1. Intake scope token table
create table if not exists public.portal_intake_scope_tokens (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             text        not null,
  customer_candidate_id text        not null,
  token_hash            text        not null,
  expires_at            timestamptz not null,
  revoked_at            timestamptz null,
  issued_by             text        null,
  created_at            timestamptz not null default timezone('utc'::text, now()),
  updated_at            timestamptz not null default timezone('utc'::text, now()),
  constraint portal_intake_scope_tokens_token_hash_nonempty
    check (length(btrim(token_hash)) > 0),
  constraint portal_intake_scope_tokens_tenant_nonempty
    check (length(btrim(tenant_id)) > 0),
  constraint portal_intake_scope_tokens_candidate_nonempty
    check (length(btrim(customer_candidate_id)) > 0)
);

create unique index if not exists idx_portal_intake_scope_tokens_hash
  on public.portal_intake_scope_tokens (token_hash);

create index if not exists idx_portal_intake_scope_tokens_tenant
  on public.portal_intake_scope_tokens (tenant_id, customer_candidate_id);

-- anon/authenticated must not read the token table directly
revoke all on public.portal_intake_scope_tokens from anon, authenticated;
grant all  on public.portal_intake_scope_tokens to service_role;

-- 1a. Register customer_intake_submitted as a fact type for interaction events
insert into public.fact_types (key, label, description, unit)
values (
  'customer_intake_submitted',
  'Customer Intake Submitted',
  'Records a self-serve intake form submission event for the customer',
  'event'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. portal_issue_intake_token
--    Back-office / service-role function to issue a new intake token.
--    Returns the raw (unhashed) token once – the caller must embed it in the
--    email / SMS link.  The raw token is NOT stored.
-- ---------------------------------------------------------------------------
create or replace function public.portal_issue_intake_token(
  p_tenant_id             text,
  p_customer_candidate_id text,
  p_expires_at            timestamptz,
  p_issued_by             text default null
)
returns table (
  token_id              uuid,
  raw_token             text,
  tenant_id             text,
  customer_candidate_id text,
  expires_at            timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role  text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_caller_tenant text;
  v_raw_token     text;
  v_token_hash    text;
  v_token_id      uuid;
begin
  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'portal_issue_intake_token requires authenticated admin/branch_manager or service_role'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_tenant_id, '')), '') is null then
    raise exception 'p_tenant_id must not be blank'
      using errcode = '22023';
  end if;

  -- Bind the issuance to the caller's own tenant so an admin from tenant A
  -- cannot mint intake tokens for tenant B.  service_role is exempt.
  if v_request_role <> 'service_role' then
    v_caller_tenant := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb
                       -> 'app_metadata' ->> 'tenant';
    if nullif(btrim(coalesce(v_caller_tenant, '')), '') is null then
      raise exception 'Caller JWT is missing a tenant claim; cannot issue intake token'
        using errcode = '42501';
    end if;
    if v_caller_tenant <> p_tenant_id then
      raise exception 'Cannot issue intake token for a different tenant'
        using errcode = '42501';
    end if;
  end if;

  if nullif(btrim(coalesce(p_customer_candidate_id, '')), '') is null then
    raise exception 'p_customer_candidate_id must not be blank'
      using errcode = '22023';
  end if;

  if p_expires_at <= now() then
    raise exception 'p_expires_at must be in the future'
      using errcode = '22023';
  end if;

  -- Generate a high-entropy raw token (32 random bytes -> 64 hex chars).
  v_raw_token  := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_raw_token, 'sha256'), 'hex');

  insert into public.portal_intake_scope_tokens
    (tenant_id, customer_candidate_id, token_hash, expires_at, issued_by)
  values
    (p_tenant_id, p_customer_candidate_id, v_token_hash, p_expires_at, p_issued_by)
  returning id into v_token_id;

  token_id              := v_token_id;
  raw_token             := v_raw_token;
  tenant_id             := p_tenant_id;
  customer_candidate_id := p_customer_candidate_id;
  expires_at            := p_expires_at;
  return next;
end;
$$;

revoke all    on function public.portal_issue_intake_token(text, text, timestamptz, text) from public;
grant execute on function public.portal_issue_intake_token(text, text, timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. portal_revoke_intake_token
--    Marks a token as revoked by its raw value.  Back-office / service-role
--    only.
-- ---------------------------------------------------------------------------
create or replace function public.portal_revoke_intake_token(
  p_token text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role  text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_caller_tenant text;
  v_token_hash    text;
  v_rows_updated  int;
begin
  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'portal_revoke_intake_token requires authenticated admin/branch_manager or service_role'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_token, '')), '') is null then
    raise exception 'Token must not be blank'
      using errcode = '22023';
  end if;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  -- Bind revocation to the caller's own tenant so an admin from tenant A
  -- cannot revoke intake tokens belonging to tenant B.  service_role is exempt.
  if v_request_role <> 'service_role' then
    v_caller_tenant := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb
                       -> 'app_metadata' ->> 'tenant';
    -- If the token doesn't exist OR belongs to a different tenant, silently
    -- return false to avoid leaking token existence across tenants.
    if not exists (
      select 1 from public.portal_intake_scope_tokens
      where token_hash = v_token_hash
        and tenant_id  = v_caller_tenant
    ) then
      return false;
    end if;
  end if;

  update public.portal_intake_scope_tokens
  set revoked_at = now(),
      updated_at = now()
  where token_hash = v_token_hash
    and revoked_at is null;

  get diagnostics v_rows_updated = row_count;
  return v_rows_updated > 0;
end;
$$;

revoke all    on function public.portal_revoke_intake_token(text) from public;
grant execute on function public.portal_revoke_intake_token(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. _portal_intake_validate (internal helper)
--    Returns the token row when valid (not expired, not revoked).
--    Raises 42501 otherwise.  Called only by sibling SECURITY DEFINER RPCs;
--    not exposed to anon or authenticated callers directly.
-- ---------------------------------------------------------------------------
create or replace function public._portal_intake_validate(p_token text)
returns public.portal_intake_scope_tokens
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token_hash text;
  v_row        public.portal_intake_scope_tokens;
begin
  if nullif(btrim(coalesce(p_token, '')), '') is null then
    raise exception 'Intake token is required'
      using errcode = '42501';
  end if;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  select *
    into v_row
  from public.portal_intake_scope_tokens
  where token_hash = v_token_hash;

  if not found then
    raise exception 'Intake token is invalid'
      using errcode = '42501';
  end if;

  if v_row.revoked_at is not null then
    raise exception 'Intake token has been revoked'
      using errcode = '42501';
  end if;

  if v_row.expires_at <= now() then
    raise exception 'Intake token has expired'
      using errcode = '42501';
  end if;

  return v_row;
end;
$$;

-- Not exposed to anon or authenticated; sibling SECURITY DEFINER functions
-- run as the function owner and can call it without a separate GRANT EXECUTE.
revoke all on function public._portal_intake_validate(text) from public, anon, authenticated;
grant execute on function public._portal_intake_validate(text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. portal_submit_intake
--    Token-scoped intake submission.  Creates or enriches a customer entity
--    and optionally a contact and / or job-site entity through explicit
--    allowed fields only.  No arbitrary JSON merge path is exposed.
--    Returns the customer entity_id so the caller can display confirmation.
-- ---------------------------------------------------------------------------
create or replace function public.portal_submit_intake(
  p_token            text,
  p_customer_name    text default null,
  p_customer_type    text default null,
  p_contact_name     text default null,
  p_contact_email    text default null,
  p_contact_phone    text default null,
  p_job_site_name    text default null,
  p_job_site_address text default null
)
returns table (
  customer_entity_id uuid,
  contact_entity_id  uuid,
  job_site_entity_id uuid,
  tenant_id          text,
  submitted_at       timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session       public.portal_intake_scope_tokens;
  v_customer_id   uuid;
  v_contact_id    uuid;
  v_job_site_id   uuid;
  v_now           timestamptz := clock_timestamp();
  v_fact_type_id  uuid;
begin
  v_session := public._portal_intake_validate(p_token);

  -- Upsert customer entity keyed by (tenant_id, customer_candidate_id).
  -- Uses explicit allowed fields only; no arbitrary JSON merge path.
  select t.entity_id
    into v_customer_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'customer',
    p_source_record_id => format('intake:%s:%s', v_session.tenant_id, v_session.customer_candidate_id),
    p_data             => jsonb_strip_nulls(jsonb_build_object(
      'name',          nullif(btrim(coalesce(p_customer_name, '')), ''),
      'customer_type', nullif(btrim(coalesce(p_customer_type, '')), ''),
      'tenant_id',     v_session.tenant_id
    ))
  ) as t;

  -- Optional contact
  if nullif(btrim(coalesce(p_contact_name, '')), '') is not null
     or nullif(btrim(coalesce(p_contact_email, '')), '') is not null
     or nullif(btrim(coalesce(p_contact_phone, '')), '') is not null
  then
    select t.entity_id
      into v_contact_id
    from public.rental_upsert_entity_current_state(
      p_entity_type      => 'contact',
      p_source_record_id => format('intake-contact:%s:%s', v_session.tenant_id, v_session.customer_candidate_id),
      p_data             => jsonb_strip_nulls(jsonb_build_object(
        'name',        nullif(btrim(coalesce(p_contact_name, '')), ''),
        'email',       nullif(btrim(coalesce(p_contact_email, '')), ''),
        'phone',       nullif(btrim(coalesce(p_contact_phone, '')), ''),
        'customer_id', v_customer_id,
        'tenant_id',   v_session.tenant_id
      ))
    ) as t;

    perform public.rental_upsert_relationship(
      'customer_intake_created_contact', v_customer_id, v_contact_id
    );
  end if;

  -- Optional job site
  if nullif(btrim(coalesce(p_job_site_name, '')), '') is not null
     or nullif(btrim(coalesce(p_job_site_address, '')), '') is not null
  then
    select t.entity_id
      into v_job_site_id
    from public.rental_upsert_entity_current_state(
      p_entity_type      => 'job_site',
      p_source_record_id => format('intake-jobsite:%s:%s', v_session.tenant_id, v_session.customer_candidate_id),
      p_data             => jsonb_strip_nulls(jsonb_build_object(
        'name',        nullif(btrim(coalesce(p_job_site_name, '')), ''),
        'address',     nullif(btrim(coalesce(p_job_site_address, '')), ''),
        'customer_id', v_customer_id,
        'tenant_id',   v_session.tenant_id
      ))
    ) as t;

    perform public.rental_upsert_relationship(
      'customer_intake_created_job_site', v_customer_id, v_job_site_id
    );
  end if;

  -- Record the intake submission event in time_series_points
  select id into v_fact_type_id from public.fact_types where key = 'customer_intake_submitted';

  if v_fact_type_id is not null then
    insert into public.time_series_points
      (entity_id, fact_type_id, observed_at, data_payload, source_id)
    values (
      v_customer_id,
      v_fact_type_id,
      v_now,
      jsonb_build_object(
        'tenant_id',             v_session.tenant_id,
        'customer_candidate_id', v_session.customer_candidate_id,
        'submitted_at',          v_now
      ),
      'portal_intake'
    );
  end if;

  customer_entity_id := v_customer_id;
  contact_entity_id  := v_contact_id;
  job_site_entity_id := v_job_site_id;
  tenant_id          := v_session.tenant_id;
  submitted_at       := v_now;
  return next;
end;
$$;

revoke all    on function public.portal_submit_intake(text, text, text, text, text, text, text, text) from public;
grant execute on function public.portal_submit_intake(text, text, text, text, text, text, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. portal_stage_document_metadata
--    Stages document metadata for a signed-URL upload.  The storage reference
--    must be a tenant-scoped path (validated by a prefix check).  Actual blob
--    content and retrieval remain an authenticated back-office path.
-- ---------------------------------------------------------------------------
create or replace function public.portal_stage_document_metadata(
  p_token         text,
  p_document_type text,
  p_storage_ref   text,
  p_mime_type     text default null,
  p_filename      text default null
)
returns table (
  document_entity_id uuid,
  customer_entity_id uuid,
  storage_ref        text,
  staged_at          timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session       public.portal_intake_scope_tokens;
  v_doc_id        uuid;
  v_customer_id   uuid;
  v_now           timestamptz := clock_timestamp();
  v_allowed_types text[] := array['drivers_license','insurance_certificate','credit_application','other'];
begin
  v_session := public._portal_intake_validate(p_token);

  if not (nullif(btrim(coalesce(p_document_type, '')), '') = any(v_allowed_types)) then
    raise exception 'document_type must be one of: drivers_license, insurance_certificate, credit_application, other'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_storage_ref, '')), '') is null then
    raise exception 'storage_ref must not be blank'
      using errcode = '22023';
  end if;

  -- Ensure the storage reference is scoped to the tenant
  if not (p_storage_ref like 'tenants/' || v_session.tenant_id || '/%') then
    raise exception 'storage_ref must be scoped to tenant %', v_session.tenant_id
      using errcode = '42501';
  end if;

  -- Resolve the customer entity for this intake session (may be null if
  -- document is staged before portal_submit_intake has been called)
  select e.id
    into v_customer_id
  from public.entities e
  where e.entity_type = 'customer'
    and e.source_record_id = format('intake:%s:%s', v_session.tenant_id, v_session.customer_candidate_id);

  select t.entity_id
    into v_doc_id
  from public.rental_upsert_entity_current_state(
    p_entity_type      => 'document',
    p_source_record_id => format('intake-doc:%s:%s:%s',
      v_session.tenant_id, v_session.customer_candidate_id, p_storage_ref),
    p_data             => jsonb_strip_nulls(jsonb_build_object(
      'customer_id',   v_customer_id,
      'tenant_id',     v_session.tenant_id,
      'document_type', p_document_type,
      'storage_ref',   p_storage_ref,
      'mime_type',     nullif(btrim(coalesce(p_mime_type, '')), ''),
      'filename',      nullif(btrim(coalesce(p_filename, '')), ''),
      'status',        'pending_review',
      'staged_at',     v_now
    ))
  ) as t;

  if v_customer_id is not null then
    perform public.rental_upsert_relationship(
      'customer_has_document', v_customer_id, v_doc_id
    );
  end if;

  document_entity_id := v_doc_id;
  customer_entity_id := v_customer_id;
  storage_ref        := p_storage_ref;
  staged_at          := v_now;
  return next;
end;
$$;

revoke all    on function public.portal_stage_document_metadata(text, text, text, text, text) from public;
grant execute on function public.portal_stage_document_metadata(text, text, text, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Extend relationship type catalog with intake-specific relationship types
-- ---------------------------------------------------------------------------
create or replace view rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    -- org hierarchy (20260609150000_enterprise_org_hierarchy)
    ('company_has_region',               'company',   'region'),
    ('region_has_branch',                'region',    'branch'),
    -- CRM customer profile (20260609150000_crm_customer_profile_model)
    ('customer_has_billing_account',     'customer',  'billing_account'),
    ('customer_has_contact',             'customer',  'contact'),
    ('customer_has_job_site',            'customer',  'job_site'),
    ('customer_has_document',            'customer',  'document'),
    ('customer_has_note',                'customer',  'note'),
    -- CRM intake (this migration)
    ('customer_intake_created_contact',  'customer',  'contact'),
    ('customer_intake_created_job_site', 'customer',  'job_site'),
    -- rental master data (20260605154500_rental_master_data_foundation)
    ('branch_has_asset',                 'branch',    'asset'),
    ('asset_category_has_asset',         'asset_category', 'asset'),
    ('asset_has_maintenance_record',     'asset',     'maintenance_record'),
    ('asset_has_inspection',             'asset',     'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

-- ---------------------------------------------------------------------------
-- 8. Fix portal_get_contract_schedule: cast text asset_id to uuid for join
--    (20260609200000_portal_schedule_access.sql had uuid = text type mismatch)
-- ---------------------------------------------------------------------------
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

revoke all on function public.portal_get_contract_schedule(uuid, text) from public;
grant execute on function public.portal_get_contract_schedule(uuid, text) to anon, authenticated, service_role;
