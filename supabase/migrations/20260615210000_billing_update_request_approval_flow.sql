-- ---------------------------------------------------------------------------
-- Customer billing-contact and payment update approval flow
-- Closes #1744
--
-- Implements an assist-only customer self-service flow for requesting billing-
-- contact or payment-detail updates with strict account authorisation,
-- human-gated approval, and a full auditable trail.
--
-- Adds:
--   portal_billing_update_scope_tokens  - high-entropy, time-bounded, revocable
--                                         tokens scoped to a billing account
--   billing_update_request              - pending/reviewed update requests with
--                                         full audit log
--   portal_issue_billing_update_token   - admin/service_role token issuance
--   portal_revoke_billing_update_token  - admin/service_role revocation
--   portal_submit_billing_update_request - anon/auth token-gated submission
--   portal_get_billing_update_status    - token-gated status visibility
--   ops_record_billing_update_decision  - admin approve/reject with review note
--   ops_apply_billing_update            - gated apply after human approval
--   v_billing_update_request_queue      - ops review queue view (service_role only)
--   ops_get_billing_update_queue        - security-definer RPC for browser ops callers
--
-- Operating-model tags threaded: rental-customer-portal-user:t5 (self-service
-- update initiation) and rental-customer-portal-user:t7 (change status
-- visibility and confirmation).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0. Extend app_role enum with credit_manager (additive, replay-safe).
--    credit_manager ops users can approve/apply billing-contact and
--    payment-detail update requests.  ADD VALUE IF NOT EXISTS is a no-op
--    on re-runs so the migration stays idempotent.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_enum
     where enumlabel = 'credit_manager'
       and enumtypid = 'public.app_role'::regtype
  ) then
    alter type public.app_role add value 'credit_manager';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. portal_billing_update_scope_tokens
--    Scoped to (tenant_id, billing_account_id, customer_id).
--    Raw token is never stored; only its SHA-256 hash is persisted.
-- ---------------------------------------------------------------------------
create table if not exists public.portal_billing_update_scope_tokens (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           text        not null,
  billing_account_id  text        not null,
  customer_id         text        not null,
  token_hash          text        not null unique,
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  issued_by           text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint billing_update_token_tenant_nonempty  check (length(btrim(tenant_id)) > 0),
  constraint billing_update_token_account_nonempty check (length(btrim(billing_account_id)) > 0),
  constraint billing_update_token_customer_nonempty check (length(btrim(customer_id)) > 0),
  constraint billing_update_token_hash_nonempty    check (length(btrim(token_hash)) > 0)
);

create index if not exists idx_billing_update_tokens_hash
  on public.portal_billing_update_scope_tokens (token_hash);

create index if not exists idx_billing_update_tokens_account
  on public.portal_billing_update_scope_tokens (tenant_id, billing_account_id);

-- anon/authenticated must not read the token table directly
revoke all on public.portal_billing_update_scope_tokens from anon, authenticated;
grant  all on public.portal_billing_update_scope_tokens to service_role;

create trigger trg_billing_update_tokens_updated_at
  before update on public.portal_billing_update_scope_tokens
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 2. billing_update_request
--    Records each customer-submitted request for a billing-contact or
--    payment-detail change, along with the full review decision and audit log.
--
--    request_type: 'billing_contact' | 'payment_detail'
--    status:       'pending' → 'under_review' → 'approved' | 'rejected' → 'applied'
--    requested_fields: jsonb with only the explicitly requested changes
--    audit_log: jsonb array accumulating timestamped events
-- ---------------------------------------------------------------------------
create table if not exists public.billing_update_request (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           text        not null,
  billing_account_id  text        not null,
  customer_id         text        not null,
  token_id            uuid        not null
                        references public.portal_billing_update_scope_tokens (id),
  request_type        text        not null
                        check (request_type in ('billing_contact', 'payment_detail')),
  requested_fields    jsonb       not null default '{}',
  status              text        not null default 'pending'
                        check (status in ('pending', 'under_review', 'approved', 'rejected', 'applied')),
  submitted_at        timestamptz not null default now(),
  reviewed_at         timestamptz,
  reviewed_by         text,
  review_note         text,
  applied_at          timestamptz,
  applied_by          text,
  audit_log           jsonb       not null default '[]',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint billing_update_request_tenant_nonempty   check (length(btrim(tenant_id)) > 0),
  constraint billing_update_request_account_nonempty  check (length(btrim(billing_account_id)) > 0),
  constraint billing_update_request_customer_nonempty check (length(btrim(customer_id)) > 0)
);

create index if not exists idx_billing_update_request_account
  on public.billing_update_request (tenant_id, billing_account_id, status);

create index if not exists idx_billing_update_request_token
  on public.billing_update_request (token_id);

create index if not exists idx_billing_update_request_submitted
  on public.billing_update_request (submitted_at desc);

-- anon/authenticated must not read this table directly
revoke all on public.billing_update_request from anon, authenticated;
grant  all on public.billing_update_request to service_role;

create trigger trg_billing_update_request_updated_at
  before update on public.billing_update_request
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 3. v_billing_update_request_queue
--    Internal ops review queue view for trusted-backend (service_role) use.
--    Shows pending, under_review and approved requests with account context.
--
--    Access model (service_role only):
--      service_role   – sees all requests across all tenants (trusted backend,
--                       e.g. Temporal activities, admin tooling).
--      authenticated  – NO direct access; browser ops callers must use the
--                       ops_get_billing_update_queue() security-definer RPC
--                       which enforces tenant scoping at the function level.
--      anon           – no access.
--
--    NOTE: The view is intentionally NOT granted to authenticated.  A
--    security-definer view without security_invoker that is accessible to
--    authenticated would bypass any base-table privilege check — and the
--    underlying billing_update_request table has all privileges revoked from
--    authenticated.  Browser ops callers use the RPC below instead.
-- ---------------------------------------------------------------------------
create or replace view public.v_billing_update_request_queue as
select
  r.id                  as request_id,
  r.tenant_id,
  r.billing_account_id,
  r.customer_id,
  r.request_type,
  r.requested_fields,
  r.status,
  r.submitted_at,
  r.reviewed_at,
  r.reviewed_by,
  r.review_note,
  r.applied_at,
  r.applied_by,
  r.audit_log
from public.billing_update_request r
where r.status in ('pending', 'under_review', 'approved')
order by r.submitted_at asc;

-- service_role only; anon and authenticated have no direct view access.
revoke all on public.v_billing_update_request_queue from anon, authenticated;
grant  select on public.v_billing_update_request_queue to service_role;

-- ---------------------------------------------------------------------------
-- 3a. ops_get_billing_update_queue
--     Security-definer RPC for browser ops callers.  Returns the pending /
--     under_review / approved queue rows visible to the caller:
--       service_role   – all tenants, all active statuses.
--       authenticated ops roles (admin / branch_manager / credit_manager) –
--                        own tenant only, filtered by optional params.
--       all others     – raise 42501.
--
--     p_status_filter      – exact status string, or NULL for all active.
--     p_request_type_filter – exact request_type string, or NULL for all.
-- ---------------------------------------------------------------------------
create or replace function public.ops_get_billing_update_queue(
  p_status_filter       text default null,
  p_request_type_filter text default null
)
returns table (
  request_id          uuid,
  tenant_id           text,
  billing_account_id  text,
  customer_id         text,
  request_type        text,
  requested_fields    jsonb,
  status              text,
  submitted_at        timestamptz,
  reviewed_at         timestamptz,
  reviewed_by         text,
  review_note         text,
  applied_at          timestamptz,
  applied_by          text,
  audit_log           jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims        jsonb := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb;
  v_request_role  text  := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    v_claims ->> 'role',
    ''
  );
  v_caller_tenant text;
begin
  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager', 'credit_manager')
    )
  ) then
    raise exception 'ops_get_billing_update_queue requires admin, branch_manager, credit_manager, or service_role'
      using errcode = '42501';
  end if;

  -- Authenticated callers are scoped to their own tenant
  if v_request_role = 'authenticated' then
    v_caller_tenant := v_claims -> 'app_metadata' ->> 'tenant';
    if nullif(btrim(coalesce(v_caller_tenant, '')), '') is null then
      raise exception 'Caller JWT is missing a tenant claim'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    r.id,
    r.tenant_id,
    r.billing_account_id,
    r.customer_id,
    r.request_type,
    r.requested_fields,
    r.status,
    r.submitted_at,
    r.reviewed_at,
    r.reviewed_by,
    r.review_note,
    r.applied_at,
    r.applied_by,
    r.audit_log
  from public.billing_update_request r
  where r.status in ('pending', 'under_review', 'approved')
    and (v_request_role = 'service_role' or r.tenant_id = v_caller_tenant)
    and (p_status_filter       is null or r.status       = p_status_filter)
    and (p_request_type_filter is null or r.request_type = p_request_type_filter)
  order by r.submitted_at asc;
end;
$$;

-- authenticated ops users and service_role may call; anon may not.
revoke all    on function public.ops_get_billing_update_queue(text, text) from public;
grant  execute on function public.ops_get_billing_update_queue(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. portal_issue_billing_update_token
--    admin/branch_manager or service_role issues a scoped token tied to a
--    specific billing account and customer.  Raw token returned once only.
-- ---------------------------------------------------------------------------
create or replace function public.portal_issue_billing_update_token(
  p_tenant_id          text,
  p_billing_account_id text,
  p_customer_id        text,
  p_expires_at         timestamptz,
  p_issued_by          text default null
)
returns table (
  token_id             uuid,
  raw_token            text,
  tenant_id            text,
  billing_account_id   text,
  customer_id          text,
  expires_at           timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
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
    raise exception 'portal_issue_billing_update_token requires authenticated admin/branch_manager or service_role'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_tenant_id, '')), '') is null then
    raise exception 'p_tenant_id must not be blank' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_billing_account_id, '')), '') is null then
    raise exception 'p_billing_account_id must not be blank' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_customer_id, '')), '') is null then
    raise exception 'p_customer_id must not be blank' using errcode = '22023';
  end if;
  if p_expires_at <= now() then
    raise exception 'p_expires_at must be in the future' using errcode = '22023';
  end if;

  -- Bind to caller's tenant to prevent cross-tenant token issuance
  if v_request_role <> 'service_role' then
    v_caller_tenant := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb
                       -> 'app_metadata' ->> 'tenant';
    if nullif(btrim(coalesce(v_caller_tenant, '')), '') is null then
      raise exception 'Caller JWT is missing a tenant claim; cannot issue billing update token'
        using errcode = '42501';
    end if;
    if v_caller_tenant <> p_tenant_id then
      raise exception 'Cannot issue billing update token for a different tenant'
        using errcode = '42501';
    end if;
  end if;

  v_raw_token  := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_raw_token, 'sha256'), 'hex');

  insert into public.portal_billing_update_scope_tokens
    (tenant_id, billing_account_id, customer_id, token_hash, expires_at, issued_by)
  values
    (p_tenant_id, p_billing_account_id, p_customer_id, v_token_hash, p_expires_at, p_issued_by)
  returning id into v_token_id;

  token_id           := v_token_id;
  raw_token          := v_raw_token;
  tenant_id          := p_tenant_id;
  billing_account_id := p_billing_account_id;
  customer_id        := p_customer_id;
  expires_at         := p_expires_at;
  return next;
end;
$$;

revoke all    on function public.portal_issue_billing_update_token(text, text, text, timestamptz, text) from public;
grant  execute on function public.portal_issue_billing_update_token(text, text, text, timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. portal_revoke_billing_update_token
--    Marks a billing update token as revoked by its raw value.
-- ---------------------------------------------------------------------------
create or replace function public.portal_revoke_billing_update_token(
  p_token text
)
returns boolean
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
    raise exception 'portal_revoke_billing_update_token requires authenticated admin/branch_manager or service_role'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_token, '')), '') is null then
    raise exception 'Token must not be blank' using errcode = '22023';
  end if;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  if v_request_role <> 'service_role' then
    v_caller_tenant := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb
                       -> 'app_metadata' ->> 'tenant';
    update public.portal_billing_update_scope_tokens
       set revoked_at = now(),
           updated_at = now()
     where token_hash = v_token_hash
       and tenant_id  = v_caller_tenant
       and revoked_at is null;
  else
    update public.portal_billing_update_scope_tokens
       set revoked_at = now(),
           updated_at = now()
     where token_hash = v_token_hash
       and revoked_at is null;
  end if;

  get diagnostics v_rows_updated = row_count;
  return v_rows_updated > 0;
end;
$$;

revoke all    on function public.portal_revoke_billing_update_token(text) from public;
grant  execute on function public.portal_revoke_billing_update_token(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. portal_submit_billing_update_request
--    Token-gated (anon/authenticated).  Validates the token, ensures the
--    request is within the allowed field set, and records the request in
--    pending status.  Returns the request_id for status polling.
--
--    Allowed request_type values: 'billing_contact', 'payment_detail'
--    Allowed requested_fields keys (validated against request_type):
--      billing_contact: billing_name, billing_email, billing_phone, billing_address
--      payment_detail:  payment_method, bank_account_name, bank_account_number,
--                       payment_reference, preferred_payment_terms
--
--    Operating-model tag: rental-customer-portal-user:t5
-- ---------------------------------------------------------------------------
create or replace function public.portal_submit_billing_update_request(
  p_token           text,
  p_request_type    text,
  p_billing_name    text    default null,
  p_billing_email   text    default null,
  p_billing_phone   text    default null,
  p_billing_address text    default null,
  p_payment_method  text    default null,
  p_payment_reference text  default null,
  p_preferred_payment_terms text default null,
  p_note            text    default null
)
returns table (
  request_id    uuid,
  status        text,
  submitted_at  timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_request_role     text;
  v_token_hash       text;
  v_token_row        public.portal_billing_update_scope_tokens%rowtype;
  v_request_id       uuid;
  v_submitted_at     timestamptz := clock_timestamp();
  v_requested_fields jsonb       := '{}';
  v_audit_entry      jsonb;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );

  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_submit_billing_update_request requires anon, authenticated, or service_role access'
      using errcode = '42501';
  end if;

  -- Validate token
  if nullif(btrim(coalesce(p_token, '')), '') is null then
    raise exception 'Billing update token is required'
      using errcode = '22023';
  end if;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  select * into v_token_row
  from public.portal_billing_update_scope_tokens
  where token_hash = v_token_hash;

  if not found then
    raise exception 'Billing update token is invalid'
      using errcode = '42501';
  end if;
  if v_token_row.revoked_at is not null then
    raise exception 'Billing update token has been revoked'
      using errcode = '42501';
  end if;
  if v_token_row.expires_at < now() then
    raise exception 'Billing update token has expired'
      using errcode = '42501';
  end if;

  -- Validate request_type
  if p_request_type not in ('billing_contact', 'payment_detail') then
    raise exception 'request_type must be billing_contact or payment_detail'
      using errcode = '22023';
  end if;

  -- Build requested_fields from the explicitly declared parameters only.
  -- No arbitrary JSON merge path is exposed.
  if p_request_type = 'billing_contact' then
    if p_billing_name    is not null and length(btrim(p_billing_name))    > 0 then
      v_requested_fields := v_requested_fields || jsonb_build_object('billing_name', btrim(p_billing_name));
    end if;
    if p_billing_email   is not null and length(btrim(p_billing_email))   > 0 then
      v_requested_fields := v_requested_fields || jsonb_build_object('billing_email', btrim(p_billing_email));
    end if;
    if p_billing_phone   is not null and length(btrim(p_billing_phone))   > 0 then
      v_requested_fields := v_requested_fields || jsonb_build_object('billing_phone', btrim(p_billing_phone));
    end if;
    if p_billing_address is not null and length(btrim(p_billing_address)) > 0 then
      v_requested_fields := v_requested_fields || jsonb_build_object('billing_address', btrim(p_billing_address));
    end if;
  elsif p_request_type = 'payment_detail' then
    if p_payment_method          is not null and length(btrim(p_payment_method))          > 0 then
      v_requested_fields := v_requested_fields || jsonb_build_object('payment_method', btrim(p_payment_method));
    end if;
    if p_payment_reference       is not null and length(btrim(p_payment_reference))       > 0 then
      v_requested_fields := v_requested_fields || jsonb_build_object('payment_reference', btrim(p_payment_reference));
    end if;
    if p_preferred_payment_terms is not null and length(btrim(p_preferred_payment_terms)) > 0 then
      v_requested_fields := v_requested_fields || jsonb_build_object('preferred_payment_terms', btrim(p_preferred_payment_terms));
    end if;
  end if;

  if v_requested_fields = '{}' then
    raise exception 'At least one field must be provided for the requested change'
      using errcode = '22023';
  end if;

  if p_note is not null and length(btrim(p_note)) > 0 then
    v_requested_fields := v_requested_fields || jsonb_build_object('customer_note', btrim(p_note));
  end if;

  -- Build initial audit entry
  v_audit_entry := jsonb_build_object(
    'event',        'submitted',
    'ts',           v_submitted_at,
    'request_type', p_request_type,
    'fields',       v_requested_fields,
    'operating_model_tags', jsonb_build_array('rental-customer-portal-user:t5')
  );

  insert into public.billing_update_request (
    tenant_id,
    billing_account_id,
    customer_id,
    token_id,
    request_type,
    requested_fields,
    status,
    submitted_at,
    audit_log
  ) values (
    v_token_row.tenant_id,
    v_token_row.billing_account_id,
    v_token_row.customer_id,
    v_token_row.id,
    p_request_type,
    v_requested_fields,
    'pending',
    v_submitted_at,
    jsonb_build_array(v_audit_entry)
  )
  returning id into v_request_id;

  request_id   := v_request_id;
  status       := 'pending';
  submitted_at := v_submitted_at;
  return next;
end;
$$;

revoke all    on function public.portal_submit_billing_update_request(text, text, text, text, text, text, text, text, text, text) from public;
grant  execute on function public.portal_submit_billing_update_request(text, text, text, text, text, text, text, text, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. portal_get_billing_update_status
--    Token-gated status check for the customer to track their request.
--    Returns the request status and any reviewer message without leaking
--    internal reviewer identity details.
--
--    Operating-model tag: rental-customer-portal-user:t7
-- ---------------------------------------------------------------------------
create or replace function public.portal_get_billing_update_status(
  p_token      text,
  p_request_id uuid
)
returns table (
  request_id    uuid,
  request_type  text,
  status        text,
  submitted_at  timestamptz,
  reviewed_at   timestamptz,
  review_note   text,
  applied_at    timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token_hash text;
  v_token_row  public.portal_billing_update_scope_tokens%rowtype;
  v_request    public.billing_update_request%rowtype;
begin
  if nullif(btrim(coalesce(p_token, '')), '') is null then
    raise exception 'Billing update token is required' using errcode = '22023';
  end if;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  select * into v_token_row
  from public.portal_billing_update_scope_tokens
  where token_hash = v_token_hash;

  if not found then
    raise exception 'Billing update token is invalid' using errcode = '42501';
  end if;
  if v_token_row.revoked_at is not null then
    raise exception 'Billing update token has been revoked' using errcode = '42501';
  end if;
  -- Note: expired tokens may still be used for status-only reads after submission.

  select * into v_request
  from public.billing_update_request
  where id       = p_request_id
    and token_id = v_token_row.id;

  if not found then
    raise exception 'Request not found or not accessible with this token'
      using errcode = '42501';
  end if;

  request_id   := v_request.id;
  request_type := v_request.request_type;
  status       := v_request.status;
  submitted_at := v_request.submitted_at;
  reviewed_at  := v_request.reviewed_at;
  review_note  := v_request.review_note;
  applied_at   := v_request.applied_at;
  return next;
end;
$$;

revoke all    on function public.portal_get_billing_update_status(text, uuid) from public;
grant  execute on function public.portal_get_billing_update_status(text, uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. ops_record_billing_update_decision
--    Internal approve/reject function.  Adds a timestamped audit entry,
--    transitions status, and records reviewer identity.
--    Money-moving or customer-facing changes are NOT applied here; that
--    requires a separate ops_apply_billing_update call.
--
--    p_decision: 'approve' | 'reject'
-- ---------------------------------------------------------------------------
create or replace function public.ops_record_billing_update_decision(
  p_request_id  uuid,
  p_decision    text,
  p_reviewer_id text,
  p_note        text default null
)
returns table (
  request_id  uuid,
  status      text,
  reviewed_at timestamptz
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
  v_request       public.billing_update_request%rowtype;
  v_new_status    text;
  v_reviewed_at   timestamptz := clock_timestamp();
  v_audit_entry   jsonb;
  v_caller_tenant text;
begin
  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager', 'credit_manager')
    )
  ) then
    raise exception 'ops_record_billing_update_decision requires admin, branch_manager, credit_manager, or service_role'
      using errcode = '42501';
  end if;

  if p_decision not in ('approve', 'reject') then
    raise exception 'p_decision must be approve or reject' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_reviewer_id, '')), '') is null then
    raise exception 'p_reviewer_id must not be blank' using errcode = '22023';
  end if;

  select * into v_request
  from public.billing_update_request
  where id = p_request_id;

  if not found then
    raise exception 'Billing update request not found' using errcode = 'P0002';
  end if;

  -- Authenticated callers are scoped to their own tenant; service_role is trusted.
  if v_request_role = 'authenticated' then
    v_caller_tenant := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb
                       -> 'app_metadata' ->> 'tenant';
    if nullif(btrim(coalesce(v_caller_tenant, '')), '') is null
       or v_caller_tenant <> v_request.tenant_id then
      raise exception 'Not authorized to record a decision for this request'
        using errcode = '42501';
    end if;
  end if;

  if v_request.status not in ('pending', 'under_review') then
    raise exception 'Request is not in a reviewable state (current status: %)', v_request.status
      using errcode = '23514';
  end if;

  v_new_status := case p_decision when 'approve' then 'approved' else 'rejected' end;

  v_audit_entry := jsonb_build_object(
    'event',       p_decision || 'd',
    'ts',          v_reviewed_at,
    'reviewer_id', p_reviewer_id,
    'note',        p_note
  );

  update public.billing_update_request
     set status      = v_new_status,
         reviewed_at = v_reviewed_at,
         reviewed_by = p_reviewer_id,
         review_note = p_note,
         audit_log   = audit_log || jsonb_build_array(v_audit_entry),
         updated_at  = now()
   where id = p_request_id;

  request_id  := p_request_id;
  status      := v_new_status;
  reviewed_at := v_reviewed_at;
  return next;
end;
$$;

revoke all    on function public.ops_record_billing_update_decision(uuid, text, text, text) from public;
grant  execute on function public.ops_record_billing_update_decision(uuid, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. ops_apply_billing_update
--    Gated write: transitions an approved request to 'applied' and records
--    the applier identity and timestamp in the audit log.
--    This function does NOT autonomously alter billing contact or payment
--    records — it marks the request as applied so that a downstream billing
--    process or manual action can consume the requested_fields.
-- ---------------------------------------------------------------------------
create or replace function public.ops_apply_billing_update(
  p_request_id uuid,
  p_applied_by text
)
returns table (
  request_id uuid,
  status     text,
  applied_at timestamptz
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
  v_request     public.billing_update_request%rowtype;
  v_applied_at  timestamptz := clock_timestamp();
  v_audit_entry jsonb;
  v_caller_tenant text;
begin
  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'credit_manager')
    )
  ) then
    raise exception 'ops_apply_billing_update requires admin, credit_manager, or service_role'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_applied_by, '')), '') is null then
    raise exception 'p_applied_by must not be blank' using errcode = '22023';
  end if;

  select * into v_request
  from public.billing_update_request
  where id = p_request_id;

  if not found then
    raise exception 'Billing update request not found' using errcode = 'P0002';
  end if;

  -- Authenticated callers are scoped to their own tenant; service_role is trusted.
  if v_request_role = 'authenticated' then
    v_caller_tenant := (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb
                       -> 'app_metadata' ->> 'tenant';
    if nullif(btrim(coalesce(v_caller_tenant, '')), '') is null
       or v_caller_tenant <> v_request.tenant_id then
      raise exception 'Not authorized to apply this request'
        using errcode = '42501';
    end if;
  end if;

  if v_request.status <> 'approved' then
    raise exception 'Request must be in approved status before it can be applied (current status: %)', v_request.status
      using errcode = '23514';
  end if;

  v_audit_entry := jsonb_build_object(
    'event',      'applied',
    'ts',         v_applied_at,
    'applied_by', p_applied_by
  );

  update public.billing_update_request
     set status     = 'applied',
         applied_at = v_applied_at,
         applied_by = p_applied_by,
         audit_log  = audit_log || jsonb_build_array(v_audit_entry),
         updated_at = now()
   where id = p_request_id;

  request_id := p_request_id;
  status     := 'applied';
  applied_at := v_applied_at;
  return next;
end;
$$;

revoke all    on function public.ops_apply_billing_update(uuid, text) from public;
grant  execute on function public.ops_apply_billing_update(uuid, text) to authenticated, service_role;
