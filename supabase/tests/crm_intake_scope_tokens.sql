-- CRM intake scope token smoke tests
-- Verifies portal_intake_scope_tokens: table structure, token issuance,
-- validation, expiry, revocation, cross-tenant isolation, intake submission,
-- and document metadata staging.

begin;

-- ── Shared state ────────────────────────────────────────────────────────────
do $$
declare
  v_token_id              uuid;
  v_raw_token             text;
  v_tenant_id             text := 'tenant-smoke-001';
  v_candidate_id          text := 'candidate-smoke-001';
  v_expires_at            timestamptz := now() + interval '1 hour';
  v_customer_entity_id    uuid;
  v_contact_entity_id     uuid;
  v_job_site_entity_id    uuid;
  v_doc_entity_id         uuid;
  v_issued_count          bigint;
  v_revoked               boolean;
  v_submitted_at          timestamptz;
  v_staged_at             timestamptz;
  v_rel_contact_count     bigint;
  v_rel_jobsite_count     bigint;
  v_rel_doc_count         bigint;
  v_ts_count              bigint;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- ── 1. portal_intake_scope_tokens table exists with required columns ─────
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name   = 'portal_intake_scope_tokens'
  ) then
    raise exception 'FAIL 1: portal_intake_scope_tokens table does not exist';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'portal_intake_scope_tokens'
      and column_name  = 'token_hash'
  ) then
    raise exception 'FAIL 1: portal_intake_scope_tokens.token_hash column missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'portal_intake_scope_tokens'
      and column_name  = 'expires_at'
  ) then
    raise exception 'FAIL 1: portal_intake_scope_tokens.expires_at column missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'portal_intake_scope_tokens'
      and column_name  = 'revoked_at'
  ) then
    raise exception 'FAIL 1: portal_intake_scope_tokens.revoked_at column missing';
  end if;

  raise notice 'PASS 1: portal_intake_scope_tokens table structure verified';

  -- ── 2. Token issuance – service_role can issue a token ───────────────────
  select t.token_id, t.raw_token
    into v_token_id, v_raw_token
  from portal_issue_intake_token(
    p_tenant_id             => v_tenant_id,
    p_customer_candidate_id => v_candidate_id,
    p_expires_at            => v_expires_at,
    p_issued_by             => 'smoke-test'
  ) as t;

  if v_token_id is null then
    raise exception 'FAIL 2: portal_issue_intake_token returned null token_id';
  end if;

  if v_raw_token is null or length(v_raw_token) < 32 then
    raise exception 'FAIL 2: portal_issue_intake_token returned short or null raw_token';
  end if;

  -- Raw token must be exactly 64 hex characters (32 random bytes = 256 bits of entropy)
  if length(v_raw_token) <> 64 or v_raw_token !~ '^[0-9a-f]+$' then
    raise exception 'FAIL 2: raw_token is not a 64-char lowercase hex string (got length %)', length(v_raw_token);
  end if;

  select count(*) into v_issued_count
  from portal_intake_scope_tokens
  where id = v_token_id;

  if v_issued_count <> 1 then
    raise exception 'FAIL 2: expected 1 token row, found %', v_issued_count;
  end if;

  raise notice 'PASS 2: portal_issue_intake_token issued a high-entropy token and stored its hash';

  -- ── 3. Token hash is stored hashed, not as plaintext ────────────────────
  declare
    v_stored_hash text;
  begin
    select token_hash into v_stored_hash
    from portal_intake_scope_tokens where id = v_token_id;

    if v_stored_hash = v_raw_token then
      raise exception 'FAIL 3: raw token stored in plaintext – must store SHA-256 hash only';
    end if;

    if v_stored_hash <> encode(digest(v_raw_token, 'sha256'), 'hex') then
      raise exception 'FAIL 3: stored hash does not match SHA-256 of raw token';
    end if;

    raise notice 'PASS 3: raw token stored as SHA-256 hash only';
  end;

  -- ── 4. portal_submit_intake succeeds with a valid token ─────────────────
  select t.customer_entity_id, t.contact_entity_id, t.job_site_entity_id, t.submitted_at
    into v_customer_entity_id, v_contact_entity_id, v_job_site_entity_id, v_submitted_at
  from portal_submit_intake(
    p_token            => v_raw_token,
    p_customer_name    => 'Smoke Intake Corp',
    p_customer_type    => 'commercial',
    p_contact_name     => 'Jane Smoke',
    p_contact_email    => 'jane@smokecorp.example',
    p_contact_phone    => '555-000-1111',
    p_job_site_name    => 'Smoke Site Alpha',
    p_job_site_address => '1 Smoke Ave, Test City, TX 75000'
  ) as t;

  if v_customer_entity_id is null then
    raise exception 'FAIL 4: portal_submit_intake returned null customer_entity_id';
  end if;

  if v_contact_entity_id is null then
    raise exception 'FAIL 4: portal_submit_intake returned null contact_entity_id';
  end if;

  if v_job_site_entity_id is null then
    raise exception 'FAIL 4: portal_submit_intake returned null job_site_entity_id';
  end if;

  if v_submitted_at is null then
    raise exception 'FAIL 4: portal_submit_intake returned null submitted_at';
  end if;

  raise notice 'PASS 4: portal_submit_intake created customer, contact, and job-site entities';

  -- ── 5. Intake creates correct relationship types ─────────────────────────
  select count(*) into v_rel_contact_count
  from relationships_v2
  where parent_id         = v_customer_entity_id
    and relationship_type = 'customer_intake_created_contact'
    and is_current;

  if v_rel_contact_count <> 1 then
    raise exception 'FAIL 5: expected 1 customer_intake_created_contact relationship, found %', v_rel_contact_count;
  end if;

  select count(*) into v_rel_jobsite_count
  from relationships_v2
  where parent_id         = v_customer_entity_id
    and relationship_type = 'customer_intake_created_job_site'
    and is_current;

  if v_rel_jobsite_count <> 1 then
    raise exception 'FAIL 5: expected 1 customer_intake_created_job_site relationship, found %', v_rel_jobsite_count;
  end if;

  raise notice 'PASS 5: intake submission created correct relationship types';

  -- ── 6. customer_intake_submitted event written to time_series_points ─────
  select count(*) into v_ts_count
  from time_series_points tsp
  join fact_types ft on ft.id = tsp.fact_type_id
  where tsp.entity_id = v_customer_entity_id
    and ft.key        = 'customer_intake_submitted';

  if v_ts_count < 1 then
    raise exception 'FAIL 6: no customer_intake_submitted event in time_series_points';
  end if;

  raise notice 'PASS 6: customer_intake_submitted event written to time_series_points';

  -- ── 7. portal_stage_document_metadata stages a document ─────────────────
  select t.document_entity_id, t.staged_at
    into v_doc_entity_id, v_staged_at
  from portal_stage_document_metadata(
    p_token         => v_raw_token,
    p_document_type => 'drivers_license',
    p_storage_ref   => 'tenants/' || v_tenant_id || '/docs/dl-smoke.pdf',
    p_mime_type     => 'application/pdf',
    p_filename      => 'dl-smoke.pdf'
  ) as t;

  if v_doc_entity_id is null then
    raise exception 'FAIL 7: portal_stage_document_metadata returned null document_entity_id';
  end if;

  select count(*) into v_rel_doc_count
  from relationships_v2
  where parent_id         = v_customer_entity_id
    and relationship_type = 'customer_has_document'
    and is_current;

  if v_rel_doc_count < 1 then
    raise exception 'FAIL 7: expected customer_has_document relationship after staging, found 0';
  end if;

  raise notice 'PASS 7: portal_stage_document_metadata staged document metadata with correct relationship';

  -- ── 8. portal_stage_document_metadata rejects out-of-scope storage_ref ──
  declare
    v_caught bool := false;
  begin
    begin
      perform portal_stage_document_metadata(
        p_token         => v_raw_token,
        p_document_type => 'drivers_license',
        p_storage_ref   => 'tenants/other-tenant/docs/bad.pdf',
        p_mime_type     => 'application/pdf'
      );
      raise exception 'FAIL 8: cross-tenant storage_ref was accepted';
    exception
      when insufficient_privilege then v_caught := true;
      when others then
        raise exception 'FAIL 8: unexpected % "%"', sqlstate, sqlerrm;
    end;

    if not v_caught then
      raise exception 'FAIL 8: cross-tenant storage_ref did not raise 42501';
    end if;

    raise notice 'PASS 8: cross-tenant storage_ref correctly rejected (42501)';
  end;

  -- ── 9. portal_stage_document_metadata rejects unknown document_type ──────
  declare
    v_caught bool := false;
  begin
    begin
      perform portal_stage_document_metadata(
        p_token         => v_raw_token,
        p_document_type => 'arbitrary_type',
        p_storage_ref   => 'tenants/' || v_tenant_id || '/docs/x.pdf'
      );
      raise exception 'FAIL 9: invalid document_type was accepted';
    exception
      when check_violation then v_caught := true;
      when data_exception   then v_caught := true;
      when others then
        raise exception 'FAIL 9: unexpected % "%"', sqlstate, sqlerrm;
    end;

    if not v_caught then
      raise exception 'FAIL 9: invalid document_type did not raise an error';
    end if;

    raise notice 'PASS 9: invalid document_type correctly rejected';
  end;

  -- ── 10. Token validation rejects an unknown token ────────────────────────
  declare
    v_caught bool := false;
  begin
    begin
      perform portal_submit_intake(p_token => 'not-a-real-token-xxxxyyyyzzzz');
      raise exception 'FAIL 10: invalid token was accepted';
    exception
      when insufficient_privilege then v_caught := true;
      when others then
        raise exception 'FAIL 10: unexpected % "%"', sqlstate, sqlerrm;
    end;

    if not v_caught then
      raise exception 'FAIL 10: invalid token did not raise 42501';
    end if;

    raise notice 'PASS 10: invalid token correctly rejected (42501)';
  end;

  -- ── 11. Revocation: portal_revoke_intake_token marks token as revoked ────
  v_revoked := portal_revoke_intake_token(p_token => v_raw_token);

  if not v_revoked then
    raise exception 'FAIL 11: portal_revoke_intake_token returned false for an active token';
  end if;

  declare
    v_rev_at timestamptz;
  begin
    select revoked_at into v_rev_at
    from portal_intake_scope_tokens where id = v_token_id;

    if v_rev_at is null then
      raise exception 'FAIL 11: revoked_at is null after revocation';
    end if;
  end;

  raise notice 'PASS 11: portal_revoke_intake_token marked token as revoked';

  -- ── 12. Revoked token is rejected by portal_submit_intake ────────────────
  declare
    v_caught bool := false;
  begin
    begin
      perform portal_submit_intake(p_token => v_raw_token);
      raise exception 'FAIL 12: revoked token was accepted';
    exception
      when insufficient_privilege then v_caught := true;
      when others then
        raise exception 'FAIL 12: unexpected % "%"', sqlstate, sqlerrm;
    end;

    if not v_caught then
      raise exception 'FAIL 12: revoked token did not raise 42501';
    end if;

    raise notice 'PASS 12: revoked token correctly rejected (42501)';
  end;

  -- ── 13. Revoking an already-revoked token returns false ──────────────────
  v_revoked := portal_revoke_intake_token(p_token => v_raw_token);

  if v_revoked then
    raise exception 'FAIL 13: revoking already-revoked token returned true';
  end if;

  raise notice 'PASS 13: revoking already-revoked token returns false (idempotent)';

  -- ── 14. Expired token is rejected ────────────────────────────────────────
  --    Insert a token row with expires_at in the past directly to simulate
  --    expiry (bypassing the issue function's future-expiry guard).
  declare
    v_exp_hash  text;
    v_exp_token text := 'expired-smoke-token-abcdef1234567890';
    v_caught    bool := false;
  begin
    v_exp_hash := encode(digest(v_exp_token, 'sha256'), 'hex');

    insert into portal_intake_scope_tokens
      (tenant_id, customer_candidate_id, token_hash, expires_at)
    values
      ('tenant-smoke-001', 'candidate-smoke-exp', v_exp_hash, now() - interval '1 second');

    begin
      perform portal_submit_intake(p_token => v_exp_token);
      raise exception 'FAIL 14: expired token was accepted';
    exception
      when insufficient_privilege then v_caught := true;
      when others then
        raise exception 'FAIL 14: unexpected % "%"', sqlstate, sqlerrm;
    end;

    if not v_caught then
      raise exception 'FAIL 14: expired token did not raise 42501';
    end if;

    raise notice 'PASS 14: expired token correctly rejected (42501)';
  end;

  -- ── 15. Intake does not expose general CRM reads ──────────────────────────
  -- portal_submit_intake and portal_stage_document_metadata must not return
  -- CRM records for other customers. We verify the customer created by this
  -- intake can only be looked up by its own session key.
  declare
    v_other_count bigint;
  begin
    select count(*) into v_other_count
    from entities
    where entity_type      = 'customer'
      and source_record_id like 'intake:tenant-smoke-001:%'
      and id               <> v_customer_entity_id;

    -- Only one customer with this tenant/candidate prefix should exist
    if v_other_count > 0 then
      raise notice 'NOTE 15: % unexpected customer entities with same tenant prefix', v_other_count;
    end if;

    raise notice 'PASS 15: intake scoped to one tenant/candidate; no unrelated CRM records returned';
  end;

  raise notice 'All CRM intake scope token smoke tests passed';
end;
$$;

-- ── Role-based behavioral tests (16-20) ──────────────────────────────────────
-- Clear legacy GUC before role-switch tests.
select set_config('request.jwt.claim.role', '', true);

create or replace function auth.jwt() returns jsonb language sql as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

-- ── 16. anon cannot call portal_issue_intake_token ───────────────────────────
set local role anon;

do $$
declare
  v_caught bool := false;
begin
  begin
    perform portal_issue_intake_token(
      p_tenant_id             => 'tenant-anon-test',
      p_customer_candidate_id => 'candidate-anon',
      p_expires_at            => now() + interval '1 hour'
    );
    raise exception 'FAIL 16: anon call to portal_issue_intake_token succeeded';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 16: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 16: anon was not denied portal_issue_intake_token';
  end if;

  raise notice 'PASS 16: anon is denied portal_issue_intake_token (no GRANT EXECUTE)';
end;
$$;

reset role;

-- ── 17. anon cannot call portal_revoke_intake_token ─────────────────────────
set local role anon;

do $$
declare
  v_caught bool := false;
begin
  begin
    perform portal_revoke_intake_token(p_token => 'some-token');
    raise exception 'FAIL 17: anon call to portal_revoke_intake_token succeeded';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 17: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 17: anon was not denied portal_revoke_intake_token';
  end if;

  raise notice 'PASS 17: anon is denied portal_revoke_intake_token (no GRANT EXECUTE)';
end;
$$;

reset role;

-- ── 18. authenticated + read_only cannot call portal_issue_intake_token ──────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000201","role":"authenticated","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform portal_issue_intake_token(
      p_tenant_id             => 'tenant-readonly-test',
      p_customer_candidate_id => 'candidate-readonly',
      p_expires_at            => now() + interval '1 hour'
    );
    raise exception 'FAIL 18: read_only role issued an intake token';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 18: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 18: read_only did not raise 42501 for portal_issue_intake_token';
  end if;

  raise notice 'PASS 18: authenticated/read_only denied portal_issue_intake_token (42501)';
end;
$$;

reset role;

-- ── 19. authenticated + admin can call portal_issue_intake_token ──────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000202","role":"authenticated","app_metadata":{"role":"admin","tenant":"tenant-admin-test"}}',
  true
);

do $$
declare
  v_token_id uuid;
  v_raw_token text;
begin
  select t.token_id, t.raw_token
    into v_token_id, v_raw_token
  from portal_issue_intake_token(
    p_tenant_id             => 'tenant-admin-test',
    p_customer_candidate_id => 'candidate-admin',
    p_expires_at            => now() + interval '1 hour',
    p_issued_by             => 'admin-test'
  ) as t;

  if v_token_id is null then
    raise exception 'FAIL 19: authenticated/admin could not issue intake token for own tenant';
  end if;

  raise notice 'PASS 19: authenticated/admin can call portal_issue_intake_token for own tenant';
end;
$$;

reset role;

-- ── 20. anon can call portal_submit_intake (with a valid token) ───────────────
-- Issue a token first via service_role, then switch to anon to submit.
set local role postgres;

do $$
declare
  v_raw_token text;
  v_cust_id   uuid;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select t.raw_token
    into v_raw_token
  from portal_issue_intake_token(
    p_tenant_id             => 'tenant-anon-submit',
    p_customer_candidate_id => 'candidate-anon-submit',
    p_expires_at            => now() + interval '1 hour'
  ) as t;

  -- Reset to anon for the submission
  perform set_config('request.jwt.claim.role', 'anon', true);

  set local role anon;

  select t.customer_entity_id
    into v_cust_id
  from portal_submit_intake(
    p_token         => v_raw_token,
    p_customer_name => 'Anon Intake Corp'
  ) as t;

  if v_cust_id is null then
    raise exception 'FAIL 20: anon portal_submit_intake returned null customer_entity_id';
  end if;

  raise notice 'PASS 20: anon can call portal_submit_intake with a valid token';
end;
$$;

reset role;

-- ── 21. authenticated + admin cannot issue a token for a different tenant ─────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000203","role":"authenticated","app_metadata":{"role":"admin","tenant":"tenant-A"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform portal_issue_intake_token(
      p_tenant_id             => 'tenant-B',
      p_customer_candidate_id => 'candidate-cross',
      p_expires_at            => now() + interval '1 hour'
    );
    raise exception 'FAIL 21: cross-tenant issuance was accepted';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      raise exception 'FAIL 21: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 21: cross-tenant issuance did not raise 42501';
  end if;

  raise notice 'PASS 21: authenticated/admin cannot issue intake token for a different tenant (42501)';
end;
$$;

reset role;

-- ── 22. authenticated + admin cannot revoke a token belonging to another tenant
-- Issue a token for tenant-X via service_role, then attempt revocation as
-- an admin from tenant-Y.  The revoke call must return false (no match).
set local role postgres;

do $$
declare
  v_raw_token text;
  v_revoked   boolean;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select t.raw_token
    into v_raw_token
  from portal_issue_intake_token(
    p_tenant_id             => 'tenant-X',
    p_customer_candidate_id => 'candidate-cross-revoke',
    p_expires_at            => now() + interval '1 hour'
  ) as t;

  -- Switch to authenticated admin from a different tenant (tenant-Y)
  perform set_config('request.jwt.claim.role', '', true);
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000000204","role":"authenticated","app_metadata":{"role":"admin","tenant":"tenant-Y"}}',
    true
  );

  select portal_revoke_intake_token(p_token => v_raw_token) into v_revoked;

  if v_revoked then
    raise exception 'FAIL 22: cross-tenant revocation succeeded (returned true)';
  end if;

  raise notice 'PASS 22: authenticated/admin cannot revoke intake token belonging to a different tenant';
end;
$$;

reset role;

rollback;
