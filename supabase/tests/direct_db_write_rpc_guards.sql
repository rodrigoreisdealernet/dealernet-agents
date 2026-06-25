-- Contract tests for the write-RPC role guard across migrations PR #264, #291, #335,
-- and the portal catalog requisition surface (20260609140000_portal_catalog_requisition.sql).
--
-- Migrations covered:
--   20260607133000_authenticated_write_rpc_hardening.sql        (PR #264)
--   20260607140000_allow_direct_db_writes_in_rpc_guards.sql     (PR #291)
--   20260607160000_write_rpc_guard_read_modern_claims.sql        (PR #335)
--   20260609140000_portal_catalog_requisition.sql               (portal catalog browse + submit)
--
-- PR #335 closed the security hole introduced by PR #291:
--   * Modern PostgREST sets the role in request.jwt.claims JSON, NOT in the
--     legacy request.jwt.claim.role GUC. PR #291 allowed role='' (thinking it
--     was a trusted direct-DB context), but with modern PostgREST every API
--     caller (including anon/read_only) read as '' → any caller could write.
--   * PR #335 adds a JSON-claims fallback and removes the '' allowance.
--     Seeds / migrations that need to write explicitly set
--       SET LOCAL request.jwt.claim.role = 'service_role';
--     before invoking the RPCs (as seed.sql already does).
--
-- Invariants tested:
--   1. No-claim / empty-claim context (role resolved to ''):
--      All three hardened write RPCs are BLOCKED (SQLSTATE 42501).
--      Covers both: explicit set_config(..., '') and missing GUC.
--   2. Explicit service_role claim (seed.sql / migration path):
--      All three hardened write RPCs succeed — simulates `SET LOCAL
--      request.jwt.claim.role = 'service_role'` in seed.sql/harness.
--   3. anon API context (role = 'anon'):
--      All three hardened write RPCs are blocked with SQLSTATE 42501.
--      The dedicated portal_submit_off_rent_request RPC requires a valid scope token.
--   4. Demo seed / temporal harness regression:
--      Explicit service_role write path stays green, anon write boundary
--      remains intact immediately after.
--   5. Portal scope boundary with SET LOCAL ROLE + scoped token:
--      - anon role + valid scoped token can submit for in-scope contract lines.
--      - forged or missing token is denied (42501).
--      - cross-scope contract-line access is denied (42501).
--      - scoped request-read RPC returns only in-scope contract/request state.
--   6. Portal catalog requisition scope boundary (portal_submit_requisition):
--      - service_role bypasses token requirement and can submit a requisition.
--      - anon + valid scoped token + matching job_site_id can submit a requisition.
--      - anon + missing token is denied (42501).
--      - anon + forged token is denied (42501).
--      - anon + valid token but wrong job_site_id is denied (42501).
--      - authenticated + valid scoped token can submit a requisition.
--      - direct INSERT into entities is blocked for anon (no write grant).
--      - direct INSERT into entity_versions is blocked for anon (no write grant).
--      - service_role can SELECT from v_portal_catalog_assets; only available
--        assets are returned, not rented/unavailable ones.
--      - anon cannot SELECT from v_portal_catalog_assets directly: the view
--        runs with security_invoker = true and anon lacks SELECT on the
--        underlying entities/entity_versions tables (locked down by
--        20260607131500_lock_down_anon_read_access.sql). Portal browse must
--        go through a security-definer function if direct anon access is needed.
--   7. portal_get_contract_schedule scope boundary:
--      - service_role can read schedule without a scope token.
--      - service_role reads only the requested contract rows.
--      - anon + valid scope token returns only rows for the scoped contract.
--      - anon + null/missing token reads the schedule (public read; no token
--        required; off-rent actions still require a valid token).
--      - anon + forged token is denied (42501).
--      - authenticated + valid scope token returns only rows for the scoped
--        contract.
--      - authenticated + null/missing token reads the schedule (public read).
--      - authenticated + forged token is denied (42501).

begin;

do $$
declare
  v_allowed_site constant text := 'guard-site-a';
  v_blocked_site constant text := 'guard-site-b';
  v_entity_id  uuid;
  v_asset_id   uuid;
  v_branch_id  uuid;
  v_contract_id uuid;
  v_contract_id_scope_blocked uuid;
  v_contract_line_id uuid;
  v_contract_line_id_contract_b uuid;
  v_contract_line_id_scope_blocked uuid;
  v_off_rent_request_id uuid;
  v_catalog_asset_id       uuid;
  v_catalog_unavail_asset_id uuid;
  v_catalog_requisition_id uuid;
  v_catalog_count          int;
  -- Test-only deterministic tokens. Production portal scope tokens must be
  -- high-entropy cryptographically random secrets.
  v_scope_token constant text := 'guard-scope-token-a';
  v_scope_token_contract_b constant text := 'guard-scope-token-b';
  v_scope_token_forged constant text := 'guard-scope-token-forged';
  v_version_num int;
  v_rel_id     uuid;
  v_count int;
  v_scoped_count int;
  v_cross_scope_count int;
  v_caught     bool;
begin

  -- ──────────────────────────────────────────────────────────────────────────
  -- 1. No-claim / empty-claim context (role resolves to '')
  --    PR #335 closed the hole from PR #291: an empty or absent JWT role claim
  --    is no longer a trusted context. Asserting all three RPCs are blocked
  --    prevents a regression to the PR #291 security hole.
  -- ──────────────────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.role', '', true);

  -- 1a. create_entity_with_version must be blocked for empty role
  v_caught := false;
  begin
    select entity_id, version_number into v_branch_id, v_version_num
    from create_entity_with_version(
      'branch',
      '{"name":"Guard Test Branch (empty-role)"}'::jsonb,
      'guard-test-empty-role-branch'
    );
    raise exception 'FAIL 1a: create_entity_with_version succeeded with empty role — PR #335 security fix is missing';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 1a: create_entity_with_version raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 1a: create_entity_with_version did not raise 42501 for empty role';
  end if;

  -- 1b. rental_upsert_entity_current_state must be blocked for empty role
  v_caught := false;
  begin
    select entity_id into v_entity_id
    from rental_upsert_entity_current_state(
      p_entity_type      => 'branch',
      p_data             => '{"name":"empty-role-blocked"}'::jsonb,
      p_source_record_id => 'guard-test-empty-role-upsert'
    );
    raise exception 'FAIL 1b: rental_upsert_entity_current_state succeeded with empty role — PR #335 fix missing';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 1b: rental_upsert_entity_current_state raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 1b: rental_upsert_entity_current_state did not raise 42501 for empty role';
  end if;

  -- 1c. rental_upsert_relationship must be blocked for empty role
  --     The auth guard fires before the catalog look-up; placeholder UUIDs suffice.
  v_caught := false;
  begin
    perform rental_upsert_relationship(
      'branch_has_asset',
      gen_random_uuid(),
      gen_random_uuid()
    );
    raise exception 'FAIL 1c: rental_upsert_relationship succeeded with empty role — PR #335 fix missing';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 1c: rental_upsert_relationship raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 1c: rental_upsert_relationship did not raise 42501 for empty role';
  end if;

  raise notice 'PASS 1: Empty/absent role claim blocked from all three hardened write RPCs (SQLSTATE 42501)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 2. Explicit service_role claim (seed / migration harness path)
  --    seed.sql uses `SET LOCAL request.jwt.claim.role = 'service_role'`.
  --    The guard reads this from the legacy GUC (nullif strips empty strings,
  --    so an explicit 'service_role' value is kept). All three RPCs must succeed.
  -- ──────────────────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- 2a. create_entity_with_version
  select entity_id, version_number
    into v_branch_id, v_version_num
  from create_entity_with_version(
    'branch',
    '{"name":"Guard Test Branch (svc-role)"}'::jsonb,
    'guard-test-svc-branch'
  );
  if v_branch_id is null then
    raise exception 'service_role context [2a]: create_entity_with_version returned null entity_id';
  end if;
  if v_version_num <> 1 then
    raise exception 'service_role context [2a]: expected version 1, got %', v_version_num;
  end if;

  -- 2b. rental_upsert_entity_current_state
  select entity_id
    into v_asset_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_data             => '{"name":"Guard Test Asset (svc-role)","ownership_type":"owned","operational_status":"available"}'::jsonb,
    p_source_record_id => 'guard-test-svc-asset'
  );
  if v_asset_id is null then
    raise exception 'service_role context [2b]: rental_upsert_entity_current_state returned null entity_id';
  end if;

  -- 2c. rental_upsert_relationship
  v_rel_id := rental_upsert_relationship(
    'branch_has_asset',
    v_branch_id,
    v_asset_id
  );
  if v_rel_id is null then
    raise exception 'service_role context [2c]: rental_upsert_relationship returned null';
  end if;

  -- 2d. Seed checked-out contract line for portal off-rent submission boundary checks
  select entity_id
    into v_contract_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'rental_contract',
    p_data             => '{"status":"active","contract_number":"RPC-GUARD-PORTAL"}'::jsonb,
    p_source_record_id => 'guard-test-portal-contract'
  );
  if v_contract_id is null then
    raise exception 'service_role context [2d]: rental_contract seed returned null';
  end if;

  select entity_id
    into v_contract_line_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'rental_contract_line',
    p_data             => jsonb_build_object(
      'status', 'checked_out',
      'contract_id', v_contract_id::text,
      'asset_id', v_asset_id::text,
      'job_site_id', v_allowed_site
    ),
    p_source_record_id => 'guard-test-portal-contract-line'
  );
  if v_contract_line_id is null then
    raise exception 'service_role context [2d]: rental_contract_line seed returned null';
  end if;

  select entity_id
    into v_contract_line_id_scope_blocked
  from rental_upsert_entity_current_state(
    p_entity_type      => 'rental_contract_line',
    p_data             => jsonb_build_object(
      'status', 'checked_out',
      'contract_id', v_contract_id::text,
      'asset_id', v_asset_id::text,
      'job_site_id', v_blocked_site
    ),
    p_source_record_id => 'guard-test-portal-contract-line-scope-b'
  );
  if v_contract_line_id_scope_blocked is null then
    raise exception 'service_role context [2d]: scoped rental_contract_line seed returned null';
  end if;

  select entity_id
    into v_contract_id_scope_blocked
  from rental_upsert_entity_current_state(
    p_entity_type      => 'rental_contract',
    p_data             => '{"status":"active","contract_number":"RPC-GUARD-PORTAL-B"}'::jsonb,
    p_source_record_id => 'guard-test-portal-contract-b'
  );
  if v_contract_id_scope_blocked is null then
    raise exception 'service_role context [2d]: blocked rental_contract seed returned null';
  end if;

  select entity_id
    into v_contract_line_id_contract_b
  from rental_upsert_entity_current_state(
    p_entity_type      => 'rental_contract_line',
    p_data             => jsonb_build_object(
      'status', 'checked_out',
      'contract_id', v_contract_id_scope_blocked::text,
      'asset_id', v_asset_id::text,
      'job_site_id', v_allowed_site
    ),
    p_source_record_id => 'guard-test-portal-contract-line-contract-b'
  );
  if v_contract_line_id_contract_b is null then
    raise exception 'service_role context [2d]: contract-b rental_contract_line seed returned null';
  end if;

  insert into public.portal_contract_scope_tokens (contract_id, token_hash, job_site_id)
  values (v_contract_id, encode(digest(v_scope_token, 'sha256'), 'hex'), v_allowed_site);
  insert into public.portal_contract_scope_tokens (contract_id, token_hash, job_site_id)
  values (v_contract_id_scope_blocked, encode(digest(v_scope_token_contract_b, 'sha256'), 'hex'), v_allowed_site);

  raise notice 'PASS 2: Explicit service_role claim can call all three hardened write RPCs';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 3. anon API context — must be blocked (SQLSTATE 42501 / insufficient_privilege)
  --    PostgREST surfaces role='anon' for unauthenticated API requests. This
  --    must remain blocked regardless of PR #291 / #335 changes.
  -- ──────────────────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.role', 'anon', true);

  -- 3a. create_entity_with_version must be blocked for anon
  v_caught := false;
  begin
    select entity_id into v_entity_id
    from create_entity_with_version('branch', '{"name":"anon-blocked"}'::jsonb);
    raise exception 'FAIL 3a: create_entity_with_version succeeded for anon — 42501 guard is missing';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 3a: create_entity_with_version raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3a: create_entity_with_version did not raise 42501 for anon role';
  end if;

  -- 3b. rental_upsert_entity_current_state must be blocked for anon
  v_caught := false;
  begin
    select entity_id into v_entity_id
    from rental_upsert_entity_current_state(
      p_entity_type      => 'branch',
      p_data             => '{"name":"anon-upsert-blocked"}'::jsonb,
      p_source_record_id => 'anon-upsert-blocked'
    );
    raise exception 'FAIL 3b: rental_upsert_entity_current_state succeeded for anon — 42501 guard is missing';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 3b: rental_upsert_entity_current_state raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3b: rental_upsert_entity_current_state did not raise 42501 for anon role';
  end if;

  -- 3c. rental_upsert_relationship must be blocked for anon
  v_caught := false;
  begin
    perform rental_upsert_relationship(
      'branch_has_asset',
      gen_random_uuid(),
      gen_random_uuid()
    );
    raise exception 'FAIL 3c: rental_upsert_relationship succeeded for anon — 42501 guard is missing';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 3c: rental_upsert_relationship raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3c: rental_upsert_relationship did not raise 42501 for anon role';
  end if;

  -- 3d. portal_submit_off_rent_request requires scoped portal token
  v_caught := false;
  begin
    perform portal_submit_off_rent_request(
      p_contract_id => v_contract_id,
      p_contract_line_id => v_contract_line_id,
      p_scope_token => null,
      p_reason => 'anon portal guard test'
    );
    raise exception 'FAIL 3d: portal_submit_off_rent_request succeeded without portal scope token';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 3d: portal_submit_off_rent_request raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 3d: portal_submit_off_rent_request did not raise 42501 without scope token';
  end if;

  raise notice 'PASS 3: anon context blocked from generic writes and requires scoped token for portal off-rent RPC';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 4. Demo seed / temporal harness regression
  --    seed.sql opens with `SET LOCAL request.jwt.claim.role = 'service_role'`.
  --    Confirm that explicit-service_role writes stay green and that anon writes
  --    remain blocked immediately after — the authenticated-write policy boundary
  --    must not have been weakened.
  -- ──────────────────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select entity_id
    into v_entity_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'branch',
    p_data             => '{"name":"Seed Regression Branch","branch_code":"SR-01"}'::jsonb,
    p_source_record_id => 'guard-test-seed-regression-branch'
  );
  if v_entity_id is null then
    raise exception 'Seed regression [4a]: service_role upsert returned null — seed path broken';
  end if;

  -- Confirm anon is still blocked immediately after the service_role write
  perform set_config('request.jwt.claim.role', 'anon', true);
  v_caught := false;
  begin
    select entity_id into v_entity_id
    from rental_upsert_entity_current_state(
      p_entity_type      => 'branch',
      p_data             => '{"name":"anon-post-seed"}'::jsonb,
      p_source_record_id => 'anon-post-seed'
    );
    raise exception 'FAIL 4b: anon write succeeded after seed regression test — authenticated-write boundary weakened';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 4b: unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 4b: anon write not blocked after seed regression test — boundary weakened';
  end if;

  raise notice 'PASS 4: Demo seed regression — explicit service_role path green, anon write boundary intact';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 5. Portal scope boundary (SET LOCAL ROLE + scoped token)
  --    Validate role + claim-path behavior against real execution context:
  --      * anon role + scoped claim can submit an in-scope request.
  --      * invalid claim role is denied (42501).
  --      * cross-scope line access is denied (42501).
  --      * view reads obey policy chain + scope filter.
  -- ──────────────────────────────────────────────────────────────────────────
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  select request_id
    into v_off_rent_request_id
  from portal_submit_off_rent_request(
    p_contract_id => v_contract_id,
    p_contract_line_id => v_contract_line_id,
    p_scope_token => v_scope_token,
    p_reason => 'anon scoped portal request'
  );
  if v_off_rent_request_id is null then
    raise exception 'FAIL 5a: scoped anon request returned null request_id';
  end if;

  v_caught := false;
  begin
    perform portal_submit_off_rent_request(
      p_contract_id => v_contract_id,
      p_contract_line_id => v_contract_line_id_scope_blocked,
      p_scope_token => v_scope_token,
      p_reason => 'anon cross-scope portal request'
    );
    raise exception 'FAIL 5b: cross-scope contract line was accepted for scoped anon claim';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 5b: cross-scope request raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 5b: cross-scope request did not raise 42501';
  end if;

  v_caught := false;
  begin
    perform portal_submit_off_rent_request(
      p_contract_id => v_contract_id,
      p_contract_line_id => v_contract_line_id,
      p_scope_token => v_scope_token_forged,
      p_reason => 'forged scope token should fail'
    );
    raise exception 'FAIL 5c: forged scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 5c: forged scope token raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 5c: forged scope token did not raise 42501';
  end if;

  v_caught := false;
  begin
    perform portal_submit_off_rent_request(
      p_contract_id => v_contract_id_scope_blocked,
      p_contract_line_id => v_contract_line_id_contract_b,
      p_scope_token => v_scope_token,
      p_reason => 'cross-contract scope token should fail'
    );
    raise exception 'FAIL 5d: cross-contract scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 5d: cross-contract scope token raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 5d: cross-contract scope token did not raise 42501';
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);

  select count(*)
    into v_count
  from portal_list_off_rent_requests(v_contract_id, v_scope_token)
  where contract_line_id = v_contract_line_id::text;
  if v_count = 0 then
    raise exception 'FAIL 5e: authenticated scoped request read did not return in-scope requests';
  end if;

  select count(*)
    into v_count
  from portal_list_off_rent_requests(v_contract_id, v_scope_token)
  where contract_line_id = v_contract_line_id_scope_blocked::text;
  if v_count <> 0 then
    raise exception 'FAIL 5f: authenticated scoped request read leaked cross-scope request rows';
  end if;

  v_caught := false;
  begin
    perform 1
    from portal_list_off_rent_requests(v_contract_id, v_scope_token_forged)
    limit 1;
    raise exception 'FAIL 5g: forged scope token unexpectedly read request rows';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 5g: forged token read raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 5g: forged scope token did not raise 42501 for request reads';
  end if;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  execute 'reset role';

  raise notice 'PASS 5: Portal off-rent scope boundaries verified';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 6. Portal catalog requisition scope boundary
  --    (migration 20260609140000_portal_catalog_requisition.sql)
  --
  --    Seed: create one available asset and one rented asset using the
  --    service_role claim already active from the reset above.
  -- ──────────────────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- Seed an available catalog asset (data->>'status' = 'available')
  select entity_id
    into v_catalog_asset_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_data             => '{"name":"Catalog Guard Asset (available)","make":"Caterpillar","model":"320","status":"available","daily_rate":"950"}'::jsonb,
    p_source_record_id => 'guard-catalog-asset-available'
  );
  if v_catalog_asset_id is null then
    raise exception 'FAIL 6-setup: available catalog asset seed returned null';
  end if;

  -- Seed a rented (unavailable) catalog asset
  select entity_id
    into v_catalog_unavail_asset_id
  from rental_upsert_entity_current_state(
    p_entity_type      => 'asset',
    p_data             => '{"name":"Catalog Guard Asset (rented)","make":"John Deere","model":"210L","status":"rented","daily_rate":"750"}'::jsonb,
    p_source_record_id => 'guard-catalog-asset-rented'
  );
  if v_catalog_unavail_asset_id is null then
    raise exception 'FAIL 6-setup: rented catalog asset seed returned null';
  end if;

  -- Inventory projection requires current branch assignment via relationships.
  perform rental_upsert_relationship('branch_has_asset', v_branch_id, v_catalog_asset_id);
  perform rental_upsert_relationship('branch_has_asset', v_branch_id, v_catalog_unavail_asset_id);

  -- 6a. service_role can submit a requisition without a scope token
  select requisition_id
    into v_catalog_requisition_id
  from portal_submit_requisition(
    p_job_site_id   => v_allowed_site,
    p_asset_id      => v_catalog_asset_id::text,
    p_start_date    => current_date + 1,
    p_end_date      => current_date + 15,
    p_dispatch_yard => 'North Yard',
    p_notes         => 'Guard test requisition',
    p_scope_token   => null
  );
  if v_catalog_requisition_id is null then
    raise exception 'FAIL 6a: service_role portal_submit_requisition returned null requisition_id';
  end if;

  -- Confirm the created entity is persisted as entity_type = 'requisition'
  if not exists (
    select 1 from public.entities where id = v_catalog_requisition_id and entity_type = 'requisition'
  ) then
    raise exception 'FAIL 6a: requisition entity not found in entities table';
  end if;

  raise notice 'PASS 6a: service_role can submit requisition without scope token';

  -- 6b. anon + valid scope token + correct job_site_id → succeeds
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  select requisition_id
    into v_catalog_requisition_id
  from portal_submit_requisition(
    p_job_site_id   => v_allowed_site,
    p_asset_id      => v_catalog_asset_id::text,
    p_start_date    => current_date + 2,
    p_end_date      => current_date + 16,
    p_scope_token   => v_scope_token
  );
  if v_catalog_requisition_id is null then
    raise exception 'FAIL 6b: anon + valid scope token returned null requisition_id';
  end if;

  raise notice 'PASS 6b: anon + valid scoped token can submit requisition for in-scope job site';

  -- 6c. anon + missing scope token → denied (42501)
  v_caught := false;
  begin
    perform portal_submit_requisition(
      p_job_site_id => v_allowed_site,
      p_asset_id    => v_catalog_asset_id::text,
      p_start_date  => current_date + 1,
      p_end_date    => current_date + 15,
      p_scope_token => null
    );
    raise exception 'FAIL 6c: anon requisition without scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6c: missing scope token raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6c: missing scope token did not raise 42501';
  end if;

  raise notice 'PASS 6c: anon + missing scope token is denied (42501)';

  -- 6d. anon + forged scope token → denied (42501)
  v_caught := false;
  begin
    perform portal_submit_requisition(
      p_job_site_id => v_allowed_site,
      p_asset_id    => v_catalog_asset_id::text,
      p_start_date  => current_date + 1,
      p_end_date    => current_date + 15,
      p_scope_token => v_scope_token_forged
    );
    raise exception 'FAIL 6d: anon requisition with forged scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6d: forged scope token raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6d: forged scope token did not raise 42501';
  end if;

  raise notice 'PASS 6d: anon + forged scope token is denied (42501)';

  -- 6e. anon + valid token but wrong job_site_id → denied (42501)
  --     v_scope_token is bound to v_allowed_site; v_blocked_site has no token entry.
  v_caught := false;
  begin
    perform portal_submit_requisition(
      p_job_site_id => v_blocked_site,
      p_asset_id    => v_catalog_asset_id::text,
      p_start_date  => current_date + 1,
      p_end_date    => current_date + 15,
      p_scope_token => v_scope_token
    );
    raise exception 'FAIL 6e: anon requisition for out-of-scope job site was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6e: wrong job_site_id raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6e: wrong job_site_id + valid token did not raise 42501';
  end if;

  raise notice 'PASS 6e: anon + valid token + wrong job_site_id is denied (42501)';

  -- 6f. anon cannot INSERT directly into entities (no write grant)
  v_caught := false;
  begin
    insert into public.entities (id, entity_type)
    values (gen_random_uuid(), 'requisition');
    raise exception 'FAIL 6f: anon direct INSERT into entities succeeded — write grant is wrong';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6f: anon INSERT into entities raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6f: anon direct INSERT into entities was not blocked';
  end if;

  raise notice 'PASS 6f: anon direct INSERT into entities is blocked';

  -- 6g. anon cannot INSERT directly into entity_versions (no write grant)
  v_caught := false;
  begin
    insert into public.entity_versions (entity_id, is_current, valid_from, data)
    values (gen_random_uuid(), true, now(), '{}'::jsonb);
    raise exception 'FAIL 6g: anon direct INSERT into entity_versions succeeded — write grant is wrong';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6g: anon INSERT into entity_versions raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6g: anon direct INSERT into entity_versions was not blocked';
  end if;

  raise notice 'PASS 6g: anon direct INSERT into entity_versions is blocked';

  -- 6h. authenticated + valid scope token can also submit a requisition
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);

  select requisition_id
    into v_catalog_requisition_id
  from portal_submit_requisition(
    p_job_site_id   => v_allowed_site,
    p_asset_id      => v_catalog_asset_id::text,
    p_start_date    => current_date + 3,
    p_end_date      => current_date + 17,
    p_scope_token   => v_scope_token
  );
  if v_catalog_requisition_id is null then
    raise exception 'FAIL 6h: authenticated + valid scope token returned null requisition_id';
  end if;

  raise notice 'PASS 6h: authenticated + valid scoped token can submit requisition';

  -- Restore to superuser / service_role context for view tests
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- 6i. service_role SELECT from v_portal_catalog_assets returns only available assets
  select count(*)
    into v_catalog_count
  from public.v_portal_catalog_assets
  where asset_id = v_catalog_asset_id;
  if v_catalog_count <> 1 then
    raise exception 'FAIL 6i: available asset not found in v_portal_catalog_assets (count=%)', v_catalog_count;
  end if;

  select count(*)
    into v_catalog_count
  from public.v_portal_catalog_assets
  where asset_id = v_catalog_unavail_asset_id;
  if v_catalog_count <> 0 then
    raise exception 'FAIL 6i: rented/unavailable asset is exposed in v_portal_catalog_assets';
  end if;

  raise notice 'PASS 6i: v_portal_catalog_assets exposes only available assets to service_role';

  -- 6j. anon cannot SELECT from v_portal_catalog_assets directly.
  --     The view has security_invoker = true; anon lacks SELECT on the underlying
  --     entities / entity_versions tables (revoked by lock_down_anon_read_access
  --     migration).  Portal browse for unauthenticated callers must go through a
  --     security-definer function — direct view access is intentionally blocked.
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  v_caught := false;
  begin
    select count(*) into v_catalog_count from public.v_portal_catalog_assets;
    raise exception 'FAIL 6j: anon SELECT from v_portal_catalog_assets succeeded — security_invoker + underlying table grant is wrong';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6j: anon view select raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6j: anon SELECT from v_portal_catalog_assets was not blocked';
  end if;

  raise notice 'PASS 6j: anon direct SELECT from v_portal_catalog_assets is blocked (security_invoker enforced)';

  -- 6j1. inventory projection views/catalogs must keep security_invoker=true
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  with expected_views(view_name) as (
    values
      ('rental_entity_type_catalog'),
      ('rental_relationship_type_catalog'),
      ('rental_current_stock_items'),
      ('rental_current_inventory_records')
  ),
  view_security as (
    select
      e.view_name,
      coalesce(c.reloptions, array[]::text[]) @> array['security_invoker=true']::text[] as has_security_invoker
    from expected_views e
    left join pg_class c on c.relname = e.view_name
    left join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  )
  select
    count(*),
    count(*) filter (where has_security_invoker)
    into v_count, v_catalog_count
  from view_security;
  if v_count <> v_catalog_count then
    raise exception 'FAIL 6j1: expected security_invoker=true on all inventory/catalog projection views (%/% configured)', v_catalog_count, v_count;
  end if;

  select count(*)
    into v_catalog_count
  from public.rental_entity_type_catalog
  where entity_type in ('company', 'rental_contract', 'stock_item');
  if v_catalog_count <> 3 then
    raise exception 'FAIL 6j1: entity type catalog missing expected entries (company/rental_contract/stock_item)';
  end if;

  select count(*)
    into v_catalog_count
  from public.rental_relationship_type_catalog
  where relationship_type in ('company_has_region', 'region_has_branch', 'branch_has_stock_item', 'asset_category_has_stock_item');
  if v_catalog_count <> 4 then
    raise exception 'FAIL 6j1: relationship type catalog missing expected org/stock-item relationships';
  end if;

  raise notice 'PASS 6j1: inventory/catalog projection views enforce security_invoker and retain required types';

  -- 6j2. anon direct reads from inventory projection views remain blocked.
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  v_caught := false;
  begin
    select count(*) into v_catalog_count from public.rental_current_inventory_records;
    raise exception 'FAIL 6j2: anon SELECT from rental_current_inventory_records succeeded';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6j2: unexpected error selecting rental_current_inventory_records: % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6j2: anon SELECT from rental_current_inventory_records was not blocked';
  end if;

  v_caught := false;
  begin
    select count(*) into v_catalog_count from public.rental_current_stock_items;
    raise exception 'FAIL 6j2: anon SELECT from rental_current_stock_items succeeded';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6j2: unexpected error selecting rental_current_stock_items: % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6j2: anon SELECT from rental_current_stock_items was not blocked';
  end if;

  raise notice 'PASS 6j2: anon direct reads from inventory projection views are blocked';

  -- -----------------------------------------------------------------------
  -- 6k–6n. portal_get_catalog_assets — the correct anon browse path
  -- -----------------------------------------------------------------------

  -- 6k. service_role can call portal_get_catalog_assets without a token
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select count(*)
    into v_catalog_count
  from portal_get_catalog_assets(p_job_site_id => v_allowed_site);
  if v_catalog_count < 1 then
    raise exception 'FAIL 6k: service_role portal_get_catalog_assets returned 0 rows; expected at least the seeded available asset';
  end if;

  raise notice 'PASS 6k: service_role can browse catalog via portal_get_catalog_assets without token';

  -- 6l. anon + valid scoped token can browse catalog
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  select count(*)
    into v_catalog_count
  from portal_get_catalog_assets(
    p_job_site_id => v_allowed_site,
    p_scope_token => v_scope_token
  );
  if v_catalog_count < 1 then
    raise exception 'FAIL 6l: anon + valid scope token returned 0 rows from portal_get_catalog_assets';
  end if;

  raise notice 'PASS 6l: anon + valid scoped token can browse catalog via portal_get_catalog_assets';

  -- 6m. anon + missing token → 42501
  v_caught := false;
  begin
    perform portal_get_catalog_assets(
      p_job_site_id => v_allowed_site,
      p_scope_token => null
    );
    raise exception 'FAIL 6m: anon + null token was allowed — scope enforcement missing';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6m: unexpected error % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6m: anon + missing token was not blocked';
  end if;

  raise notice 'PASS 6m: anon + missing scope token is rejected by portal_get_catalog_assets';

  -- 6n. anon + forged token → 42501
  v_caught := false;
  begin
    perform portal_get_catalog_assets(
      p_job_site_id => v_allowed_site,
      p_scope_token => 'completely-wrong-token-value'
    );
    raise exception 'FAIL 6n: anon + forged token was allowed';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6n: unexpected error % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6n: anon + forged token was not blocked';
  end if;

  raise notice 'PASS 6n: anon + forged scope token is rejected by portal_get_catalog_assets';

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  execute 'reset role';

  raise notice 'PASS 6: Portal catalog requisition + catalog browse scope boundaries verified (6a–6n)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 7. portal_get_contract_schedule scope boundary
  --    Validates that the schedule-read RPC allows public reads (null/empty
  --    token), rejects forged tokens, only returns rows for the requested
  --    contract, and that service_role bypasses the token check intentionally.
  --
  --    7a. service_role can read schedule without a scope token and only sees
  --        the requested contract rows.
  --    7b. anon + valid scope token returns only rows for the correct contract.
  --    7c. anon + null/missing token reads the schedule (public read).
  --    7d. anon + forged token is denied (42501).
  --    7e. authenticated + valid scope token returns only rows for the correct
  --        contract.
  --    7f. authenticated + null/missing token reads the schedule (public read).
  --    7g. authenticated + forged token is denied (42501).
  -- ──────────────────────────────────────────────────────────────────────────

  -- 7a. service_role bypasses scope enforcement
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select
    count(*),
    count(*) filter (where line_contract_id = v_contract_id::text),
    count(*) filter (where line_contract_id = v_contract_id_scope_blocked::text)
    into v_count, v_scoped_count, v_cross_scope_count
  from portal_get_contract_schedule(v_contract_id, null);
  if v_count <> 2 or v_scoped_count <> 2 or v_cross_scope_count <> 0 then
    raise exception
      'FAIL 7a: service_role expected exactly 2 scoped schedule rows and 0 cross-contract rows, got total=% scoped=% cross=%',
      v_count, v_scoped_count, v_cross_scope_count;
  end if;
  raise notice 'PASS 7a: service_role can call portal_get_contract_schedule without a scope token and only sees requested contract rows';

  -- 7b. anon + valid scope token can read schedule
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  select
    count(*),
    count(*) filter (where line_contract_id = v_contract_id::text),
    count(*) filter (where line_contract_id = v_contract_id_scope_blocked::text)
    into v_count, v_scoped_count, v_cross_scope_count
  from portal_get_contract_schedule(v_contract_id, v_scope_token);
  if v_count <> 2 or v_scoped_count <> 2 or v_cross_scope_count <> 0 then
    raise exception
      'FAIL 7b: anon expected exactly 2 scoped schedule rows and 0 cross-contract rows, got total=% scoped=% cross=%',
      v_count, v_scoped_count, v_cross_scope_count;
  end if;
  raise notice 'PASS 7b: anon + valid scope token can call portal_get_contract_schedule and only sees scoped rows';

  -- 7c. anon + null/missing scope token → public read (schedule visible)
  select
    count(*),
    count(*) filter (where line_contract_id = v_contract_id::text),
    count(*) filter (where line_contract_id = v_contract_id_scope_blocked::text)
    into v_count, v_scoped_count, v_cross_scope_count
  from portal_get_contract_schedule(v_contract_id, null);
  if v_count <> 2 or v_scoped_count <> 2 or v_cross_scope_count <> 0 then
    raise exception
      'FAIL 7c: anon + null token expected exactly 2 scoped schedule rows and 0 cross-contract rows (public read), got total=% scoped=% cross=%',
      v_count, v_scoped_count, v_cross_scope_count;
  end if;

  raise notice 'PASS 7c: anon + null scope token reads the schedule (public read allowed)';

  -- 7d. anon + forged token → 42501
  v_caught := false;
  begin
    perform portal_get_contract_schedule(v_contract_id, v_scope_token_forged);
    raise exception 'FAIL 7d: anon + forged scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 7d: unexpected error % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 7d: anon + forged scope token was not blocked';
  end if;

  raise notice 'PASS 7d: anon + forged scope token is rejected by portal_get_contract_schedule';

  -- 7e. authenticated + valid scope token can read the same scoped rows
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);

  select
    count(*),
    count(*) filter (where line_contract_id = v_contract_id::text),
    count(*) filter (where line_contract_id = v_contract_id_scope_blocked::text)
    into v_count, v_scoped_count, v_cross_scope_count
  from portal_get_contract_schedule(v_contract_id, v_scope_token);
  if v_count <> 2 or v_scoped_count <> 2 or v_cross_scope_count <> 0 then
    raise exception
      'FAIL 7e: authenticated expected exactly 2 scoped schedule rows and 0 cross-contract rows, got total=% scoped=% cross=%',
      v_count, v_scoped_count, v_cross_scope_count;
  end if;

  raise notice 'PASS 7e: authenticated + valid scope token can call portal_get_contract_schedule and only sees scoped rows';

  -- 7f. authenticated + null/missing scope token → public read (schedule visible)
  select
    count(*),
    count(*) filter (where line_contract_id = v_contract_id::text),
    count(*) filter (where line_contract_id = v_contract_id_scope_blocked::text)
    into v_count, v_scoped_count, v_cross_scope_count
  from portal_get_contract_schedule(v_contract_id, null);
  if v_count <> 2 or v_scoped_count <> 2 or v_cross_scope_count <> 0 then
    raise exception
      'FAIL 7f: authenticated + null token expected exactly 2 scoped schedule rows and 0 cross-contract rows (public read), got total=% scoped=% cross=%',
      v_count, v_scoped_count, v_cross_scope_count;
  end if;

  raise notice 'PASS 7f: authenticated + null scope token reads the schedule (public read allowed)';

  -- 7g. authenticated + forged token → 42501
  v_caught := false;
  begin
    perform portal_get_contract_schedule(v_contract_id, v_scope_token_forged);
    raise exception 'FAIL 7g: authenticated + forged scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 7g: unexpected error % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 7g: authenticated + forged scope token was not blocked';
  end if;

  raise notice 'PASS 7g: authenticated + forged scope token is rejected by portal_get_contract_schedule';

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  execute 'reset role';

  raise notice 'PASS 7: portal_get_contract_schedule scope boundaries verified (7a–7g)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 8a. portal_get_demo_portal_url is service_role-only
  --     Anon/authenticated callers must be denied with insufficient_privilege
  --     (42501) so the demo scope token is never exposed via a public RPC.
  -- ──────────────────────────────────────────────────────────────────────────
  v_caught := false;
  begin
    execute 'set local role anon';
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

    perform portal_get_demo_portal_url();
    raise exception 'FAIL 8a: anon was allowed to call portal_get_demo_portal_url — demo token is exposed';
  exception
    when insufficient_privilege then
      v_caught := true;
  end;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  execute 'reset role';

  if not v_caught then
    raise exception 'FAIL 8a: anon + portal_get_demo_portal_url was not blocked';
  end if;

  raise notice 'PASS 8a: anon cannot call portal_get_demo_portal_url (demo token not exposed to public)';

  raise notice 'All direct_db_write_rpc_guards contract tests passed (including scope boundaries)';
end;
$$;

rollback;
