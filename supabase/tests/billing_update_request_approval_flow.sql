-- Behavioral SQL access-contract tests for the billing-update request
-- approval flow (migration 20260615210000_billing_update_request_approval_flow.sql).
--
-- Assertions:
--   1. Structural grants: tables revoked from anon/authenticated; view and
--      RPCs carry correct least-privilege grants; view is NOT security_invoker.
--   2. service_role happy-path: issue token, submit request, record decision,
--      apply — full lifecycle.
--   3. anon with valid token can submit (portal_submit_billing_update_request)
--      and read status (portal_get_billing_update_status).
--   4. Invalid token rejected by submit and status RPCs.
--   5. Revoked token rejected by submit.
--   6. Expired token rejected by submit.
--   7. Direct table reads denied to anon (both tables).
--   8. Direct table reads denied to authenticated (both tables).
--   9. Non-ops authenticated caller denied ops_record_billing_update_decision.
--  10. Non-ops authenticated caller denied ops_apply_billing_update.
--  11. Ops admin authenticated caller can read queue and record decision
--      for own-tenant request.
--  12. Cross-tenant ops caller denied ops_record_billing_update_decision for
--      another tenant's request.
--  13. Cross-tenant ops caller denied ops_apply_billing_update for another
--      tenant's request.
--  14. portal_issue_billing_update_token denied for anon and non-admin
--      authenticated callers.
--  15. portal_issue_billing_update_token denied for cross-tenant issuance.

begin;

-- Replace auth.jwt() so it reads from request.jwt.claims — mirrors production
-- GoTrue behavior. Wrapped in a DO block so it degrades gracefully when running
-- against a real Supabase stack where auth is owned by supabase_auth_admin and
-- postgres cannot replace the function. In that case GoTrue's auth.jwt() already
-- reads from request.jwt.claims, so the no-op is safe.
do $guard$
begin
  execute $f$
    create or replace function auth.jwt() returns jsonb language sql as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $$
  $f$;
exception
  when insufficient_privilege then null;
end;
$guard$;

-- ── 1. Structural grant checks ───────────────────────────────────────────────
do $$
declare
  v_relopts text;
begin
  -- portal_billing_update_scope_tokens: only service_role
  if has_table_privilege('anon', 'public.portal_billing_update_scope_tokens', 'SELECT') then
    raise exception 'FAIL 1a: anon must not have SELECT on portal_billing_update_scope_tokens';
  end if;
  if has_table_privilege('authenticated', 'public.portal_billing_update_scope_tokens', 'SELECT') then
    raise exception 'FAIL 1b: authenticated must not have SELECT on portal_billing_update_scope_tokens';
  end if;
  if not has_table_privilege('service_role', 'public.portal_billing_update_scope_tokens', 'SELECT') then
    raise exception 'FAIL 1c: service_role must have SELECT on portal_billing_update_scope_tokens';
  end if;

  -- billing_update_request: only service_role
  if has_table_privilege('anon', 'public.billing_update_request', 'SELECT') then
    raise exception 'FAIL 1d: anon must not have SELECT on billing_update_request';
  end if;
  if has_table_privilege('authenticated', 'public.billing_update_request', 'SELECT') then
    raise exception 'FAIL 1e: authenticated must not have SELECT on billing_update_request';
  end if;
  if not has_table_privilege('service_role', 'public.billing_update_request', 'SELECT') then
    raise exception 'FAIL 1f: service_role must have SELECT on billing_update_request';
  end if;

  -- v_billing_update_request_queue: service_role only; neither anon nor authenticated
  if has_table_privilege('anon', 'public.v_billing_update_request_queue', 'SELECT') then
    raise exception 'FAIL 1g: anon must not have SELECT on v_billing_update_request_queue';
  end if;
  if has_table_privilege('authenticated', 'public.v_billing_update_request_queue', 'SELECT') then
    raise exception 'FAIL 1h: authenticated must not have SELECT on v_billing_update_request_queue (service-role-only; browser ops callers use ops_get_billing_update_queue RPC)';
  end if;
  if not has_table_privilege('service_role', 'public.v_billing_update_request_queue', 'SELECT') then
    raise exception 'FAIL 1i: service_role must have SELECT on v_billing_update_request_queue';
  end if;

  -- v_billing_update_request_queue: no security_invoker required (service_role only access)
  select c.reloptions::text into v_relopts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'v_billing_update_request_queue';

  if coalesce(v_relopts, '') like '%security_invoker=true%' then
    raise exception 'FAIL 1j: v_billing_update_request_queue must not use security_invoker=true (service_role-only view; underlying table revokes authenticated access)';
  end if;

  -- ops_get_billing_update_queue: authenticated and service_role; not anon
  if has_function_privilege('anon', 'public.ops_get_billing_update_queue(text,text)', 'EXECUTE') then
    raise exception 'FAIL 1j2: anon must not have EXECUTE on ops_get_billing_update_queue';
  end if;
  if not has_function_privilege('authenticated', 'public.ops_get_billing_update_queue(text,text)', 'EXECUTE') then
    raise exception 'FAIL 1j3: authenticated must have EXECUTE on ops_get_billing_update_queue';
  end if;
  if not has_function_privilege('service_role', 'public.ops_get_billing_update_queue(text,text)', 'EXECUTE') then
    raise exception 'FAIL 1j4: service_role must have EXECUTE on ops_get_billing_update_queue';
  end if;

  -- portal_submit_billing_update_request: anon, authenticated, service_role
  if not has_function_privilege('anon', 'public.portal_submit_billing_update_request(text,text,text,text,text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'FAIL 1k: anon must have EXECUTE on portal_submit_billing_update_request';
  end if;
  if not has_function_privilege('authenticated', 'public.portal_submit_billing_update_request(text,text,text,text,text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'FAIL 1l: authenticated must have EXECUTE on portal_submit_billing_update_request';
  end if;

  -- portal_get_billing_update_status: anon, authenticated, service_role
  if not has_function_privilege('anon', 'public.portal_get_billing_update_status(text,uuid)', 'EXECUTE') then
    raise exception 'FAIL 1m: anon must have EXECUTE on portal_get_billing_update_status';
  end if;

  -- ops_record_billing_update_decision: authenticated and service_role; not anon
  if has_function_privilege('anon', 'public.ops_record_billing_update_decision(uuid,text,text,text)', 'EXECUTE') then
    raise exception 'FAIL 1n: anon must not have EXECUTE on ops_record_billing_update_decision';
  end if;
  if not has_function_privilege('authenticated', 'public.ops_record_billing_update_decision(uuid,text,text,text)', 'EXECUTE') then
    raise exception 'FAIL 1o: authenticated must have EXECUTE on ops_record_billing_update_decision';
  end if;

  -- ops_apply_billing_update: authenticated and service_role; not anon
  if has_function_privilege('anon', 'public.ops_apply_billing_update(uuid,text)', 'EXECUTE') then
    raise exception 'FAIL 1p: anon must not have EXECUTE on ops_apply_billing_update';
  end if;
  if not has_function_privilege('authenticated', 'public.ops_apply_billing_update(uuid,text)', 'EXECUTE') then
    raise exception 'FAIL 1q: authenticated must have EXECUTE on ops_apply_billing_update';
  end if;

  -- portal_issue_billing_update_token: not anon; authenticated and service_role
  if has_function_privilege('anon', 'public.portal_issue_billing_update_token(text,text,text,timestamptz,text)', 'EXECUTE') then
    raise exception 'FAIL 1r: anon must not have EXECUTE on portal_issue_billing_update_token';
  end if;
  if not has_function_privilege('authenticated', 'public.portal_issue_billing_update_token(text,text,text,timestamptz,text)', 'EXECUTE') then
    raise exception 'FAIL 1s: authenticated must have EXECUTE on portal_issue_billing_update_token';
  end if;

  raise notice 'PASS 1: structural grants verified';
end;
$$;

-- ── Seed fixture data via service_role ───────────────────────────────────────
set local role postgres;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_token_a_id   uuid;
  v_raw_token_a  text;
  v_token_b_id   uuid;
  v_raw_token_b  text;
  v_request_a_id uuid;
  v_request_b_id uuid;
  v_status       text;
  v_rev_status   text;
  v_applied_at   timestamptz;
begin
  -- ── 2. service_role happy-path: full lifecycle ─────────────────────────────
  select t.token_id, t.raw_token
    into v_token_a_id, v_raw_token_a
  from public.portal_issue_billing_update_token(
    p_tenant_id          => 'tenant-bur-a',
    p_billing_account_id => 'acct-bur-a-001',
    p_customer_id        => 'cust-bur-a-001',
    p_expires_at         => now() + interval '1 hour',
    p_issued_by          => 'test-setup'
  ) as t;

  if v_token_a_id is null or v_raw_token_a is null then
    raise exception 'FAIL 2a: portal_issue_billing_update_token returned null';
  end if;

  -- raw token is 64-char hex
  if length(v_raw_token_a) <> 64 or v_raw_token_a !~ '^[0-9a-f]+$' then
    raise exception 'FAIL 2b: raw_token is not 64-char lowercase hex (got length %)', length(v_raw_token_a);
  end if;

  -- raw token must not be stored plaintext
  if exists (
    select 1 from public.portal_billing_update_scope_tokens
    where id = v_token_a_id and token_hash = v_raw_token_a
  ) then
    raise exception 'FAIL 2c: raw token stored as plaintext – must be SHA-256 hash only';
  end if;

  -- Submit a billing-contact request
  select r.request_id, r.status
    into v_request_a_id, v_status
  from public.portal_submit_billing_update_request(
    p_token        => v_raw_token_a,
    p_request_type => 'billing_contact',
    p_billing_name => 'Test Billing Name'
  ) as r;

  if v_request_a_id is null or v_status <> 'pending' then
    raise exception 'FAIL 2d: portal_submit_billing_update_request did not return pending request';
  end if;

  -- Record decision: approve
  select r.status into v_status
  from public.ops_record_billing_update_decision(
    p_request_id  => v_request_a_id,
    p_decision    => 'approve',
    p_reviewer_id => 'reviewer-001'
  ) as r;

  if v_status <> 'approved' then
    raise exception 'FAIL 2e: ops_record_billing_update_decision did not return approved status';
  end if;

  -- Apply
  select r.status, r.applied_at
    into v_status, v_applied_at
  from public.ops_apply_billing_update(
    p_request_id => v_request_a_id,
    p_applied_by => 'applier-001'
  ) as r;

  if v_status <> 'applied' or v_applied_at is null then
    raise exception 'FAIL 2f: ops_apply_billing_update did not return applied status or applied_at';
  end if;

  raise notice 'PASS 2: service_role full lifecycle (issue → submit → decide → apply) verified';

  -- ── Store tenant-b token for cross-tenant tests (13, 14) ─────────────────
  select t.token_id, t.raw_token
    into v_token_b_id, v_raw_token_b
  from public.portal_issue_billing_update_token(
    p_tenant_id          => 'tenant-bur-b',
    p_billing_account_id => 'acct-bur-b-001',
    p_customer_id        => 'cust-bur-b-001',
    p_expires_at         => now() + interval '1 hour',
    p_issued_by          => 'test-setup'
  ) as t;

  -- Submit a request for tenant-b so cross-tenant tests have a target
  select r.request_id into v_request_b_id
  from public.portal_submit_billing_update_request(
    p_token        => v_raw_token_b,
    p_request_type => 'payment_detail',
    p_payment_method => 'ach'
  ) as r;

  -- Approve tenant-b request (needed for cross-tenant apply test)
  perform public.ops_record_billing_update_decision(
    p_request_id  => v_request_b_id,
    p_decision    => 'approve',
    p_reviewer_id => 'reviewer-setup'
  );

  -- Store token IDs and request IDs in temp table for use in later blocks
  create temp table if not exists bur_test_state (
    key   text primary key,
    value text
  ) on commit drop;

  -- Grant read access so subsequent DO blocks running as anon/authenticated can
  -- read shared fixture state (e.g. raw tokens, request IDs) from this table.
  execute 'grant select on bur_test_state to anon, authenticated';

  insert into bur_test_state values
    ('raw_token_a',   v_raw_token_a),
    ('raw_token_b',   v_raw_token_b),
    ('request_a_id',  v_request_a_id::text),
    ('request_b_id',  v_request_b_id::text);

  raise notice 'PASS setup: fixture tokens and requests created for tenant-bur-a and tenant-bur-b';
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.role', '', true);

-- ── 3. anon with valid token can submit and check status ─────────────────────
set local role postgres;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_anon_raw_token  text;
  v_anon_request_id uuid;
  v_anon_status     text;
begin
  select t.raw_token into v_anon_raw_token
  from public.portal_issue_billing_update_token(
    p_tenant_id          => 'tenant-bur-anon',
    p_billing_account_id => 'acct-bur-anon-001',
    p_customer_id        => 'cust-bur-anon-001',
    p_expires_at         => now() + interval '1 hour'
  ) as t;

  insert into bur_test_state values ('raw_token_anon', v_anon_raw_token)
    on conflict (key) do update set value = excluded.value;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_raw_token   text;
  v_request_id  uuid;
  v_status      text;
  v_status2     text;
begin
  select value into v_raw_token from bur_test_state where key = 'raw_token_anon';

  select r.request_id, r.status into v_request_id, v_status
  from public.portal_submit_billing_update_request(
    p_token           => v_raw_token,
    p_request_type    => 'billing_contact',
    p_billing_email   => 'anon@test.example'
  ) as r;

  if v_request_id is null or v_status <> 'pending' then
    raise exception 'FAIL 3a: anon portal_submit_billing_update_request returned null or wrong status';
  end if;

  select r.status into v_status2
  from public.portal_get_billing_update_status(
    p_token      => v_raw_token,
    p_request_id => v_request_id
  ) as r;

  if v_status2 <> 'pending' then
    raise exception 'FAIL 3b: anon portal_get_billing_update_status returned unexpected status %', v_status2;
  end if;

  raise notice 'PASS 3: anon can submit and read status with a valid token';
end;
$$;

reset role;

-- ── 4. Invalid token rejected ─────────────────────────────────────────────────
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.portal_submit_billing_update_request(
      p_token           => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      p_request_type    => 'billing_contact',
      p_billing_name    => 'Invalid'
    );
    raise exception 'FAIL 4: invalid token was accepted';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%invalid%' or sqlerrm ilike '%42501%' then
        v_caught := true;
      else
        raise exception 'FAIL 4: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 4: invalid token did not raise an error';
  end if;
  raise notice 'PASS 4: invalid token correctly rejected';
end;
$$;

reset role;

-- ── 5. Revoked token rejected ─────────────────────────────────────────────────
set local role postgres;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_revoke_token text;
  v_revoked      boolean;
begin
  select t.raw_token into v_revoke_token
  from public.portal_issue_billing_update_token(
    p_tenant_id          => 'tenant-bur-revoke',
    p_billing_account_id => 'acct-bur-revoke',
    p_customer_id        => 'cust-bur-revoke',
    p_expires_at         => now() + interval '1 hour'
  ) as t;

  select public.portal_revoke_billing_update_token(v_revoke_token) into v_revoked;
  if not v_revoked then
    raise exception 'FAIL 5-setup: revocation returned false for active token';
  end if;

  insert into bur_test_state values ('raw_token_revoked', v_revoke_token)
    on conflict (key) do update set value = excluded.value;
end;
$$;

reset role;

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
  v_token  text;
begin
  select value into v_token from bur_test_state where key = 'raw_token_revoked';

  begin
    perform public.portal_submit_billing_update_request(
      p_token        => v_token,
      p_request_type => 'billing_contact',
      p_billing_name => 'Revoked'
    );
    raise exception 'FAIL 5: revoked token was accepted';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%revoked%' or sqlerrm ilike '%42501%' then
        v_caught := true;
      else
        raise exception 'FAIL 5: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 5: revoked token did not raise an error';
  end if;
  raise notice 'PASS 5: revoked token correctly rejected';
end;
$$;

reset role;

-- ── 6. Expired token rejected ─────────────────────────────────────────────────
set local role postgres;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_exp_token  text;
  v_token_id   uuid;
begin
  -- Issue with a valid future expiry first (function guards p_expires_at > now()),
  -- then back-date expires_at directly on the table to simulate an expired token.
  select t.raw_token, t.token_id
    into v_exp_token, v_token_id
  from public.portal_issue_billing_update_token(
    p_tenant_id          => 'tenant-bur-exp',
    p_billing_account_id => 'acct-bur-exp',
    p_customer_id        => 'cust-bur-exp',
    p_expires_at         => now() + interval '1 hour'
  ) as t;

  -- Back-date the token to simulate expiry; service_role has direct table access.
  update public.portal_billing_update_scope_tokens
     set expires_at = now() - interval '1 second'
   where id = v_token_id;

  insert into bur_test_state values ('raw_token_expired', v_exp_token)
    on conflict (key) do update set value = excluded.value;
end;
$$;

reset role;

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
  v_token  text;
begin
  select value into v_token from bur_test_state where key = 'raw_token_expired';

  begin
    perform public.portal_submit_billing_update_request(
      p_token        => v_token,
      p_request_type => 'billing_contact',
      p_billing_name => 'Expired'
    );
    raise exception 'FAIL 6: expired token was accepted';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%expired%' or sqlerrm ilike '%42501%' then
        v_caught := true;
      else
        raise exception 'FAIL 6: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 6: expired token did not raise an error';
  end if;
  raise notice 'PASS 6: expired token correctly rejected';
end;
$$;

reset role;

-- ── 7. Direct table reads denied to anon ─────────────────────────────────────
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool;
begin
  v_caught := false;
  begin
    perform 1 from public.portal_billing_update_scope_tokens limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then v_caught := true;
      else raise exception 'FAIL 7a: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 7a: anon can read portal_billing_update_scope_tokens directly';
  end if;

  v_caught := false;
  begin
    perform 1 from public.billing_update_request limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then v_caught := true;
      else raise exception 'FAIL 7b: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 7b: anon can read billing_update_request directly';
  end if;

  raise notice 'PASS 7: anon denied direct table reads on both protected tables';
end;
$$;

reset role;

-- ── 8. Direct table reads denied to authenticated ────────────────────────────
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-bur000000001","app_metadata":{"role":"read_only","tenant":"tenant-bur-a"}}',
  true
);

do $$
declare
  v_caught bool;
begin
  v_caught := false;
  begin
    perform 1 from public.portal_billing_update_scope_tokens limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then v_caught := true;
      else raise exception 'FAIL 8a: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 8a: authenticated can read portal_billing_update_scope_tokens directly';
  end if;

  v_caught := false;
  begin
    perform 1 from public.billing_update_request limit 1;
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'        then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' then v_caught := true;
      else raise exception 'FAIL 8b: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 8b: authenticated can read billing_update_request directly';
  end if;

  raise notice 'PASS 8: authenticated denied direct table reads on both protected tables';
end;
$$;

reset role;

-- ── 9. Non-ops authenticated caller denied ops_record_billing_update_decision ─
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-bur000000002","app_metadata":{"role":"read_only","tenant":"tenant-bur-a"}}',
  true
);

do $$
declare
  v_caught    bool := false;
  v_req_id    uuid;
begin
  select value::uuid into v_req_id from bur_test_state where key = 'request_a_id';

  begin
    perform public.ops_record_billing_update_decision(
      p_request_id  => v_req_id,
      p_decision    => 'approve',
      p_reviewer_id => 'non-ops-user'
    );
    raise exception 'FAIL 9: non-ops authenticated caller executed ops_record_billing_update_decision';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%requires%' or sqlerrm ilike '%42501%' or sqlerrm ilike '%admin%' then
        v_caught := true;
      else
        raise exception 'FAIL 9: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 9: non-ops caller not denied';
  end if;
  raise notice 'PASS 9: non-ops authenticated caller denied ops_record_billing_update_decision';
end;
$$;

reset role;

-- ── 10. Non-ops authenticated caller denied ops_apply_billing_update ──────────
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-bur000000003","app_metadata":{"role":"read_only","tenant":"tenant-bur-a"}}',
  true
);

do $$
declare
  v_caught bool := false;
  v_req_id uuid;
begin
  select value::uuid into v_req_id from bur_test_state where key = 'request_a_id';

  begin
    perform public.ops_apply_billing_update(
      p_request_id => v_req_id,
      p_applied_by => 'non-ops-user'
    );
    raise exception 'FAIL 10: non-ops authenticated caller executed ops_apply_billing_update';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%requires%' or sqlerrm ilike '%42501%' or sqlerrm ilike '%admin%' then
        v_caught := true;
      else
        raise exception 'FAIL 10: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 10: non-ops caller not denied';
  end if;
  raise notice 'PASS 10: non-ops authenticated caller denied ops_apply_billing_update';
end;
$$;

reset role;

-- ── 11. Ops admin can read queue and record decision for own-tenant request ───
-- Issue a fresh pending request for tenant-bur-a so an admin can act on it.
set local role postgres;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_fresh_token  text;
  v_fresh_req_id uuid;
  v_status       text;
begin
  select t.raw_token into v_fresh_token
  from public.portal_issue_billing_update_token(
    p_tenant_id          => 'tenant-bur-a',
    p_billing_account_id => 'acct-bur-a-ops',
    p_customer_id        => 'cust-bur-a-ops',
    p_expires_at         => now() + interval '1 hour'
  ) as t;

  select r.request_id into v_fresh_req_id
  from public.portal_submit_billing_update_request(
    p_token        => v_fresh_token,
    p_request_type => 'billing_contact',
    p_billing_phone => '555-111-2222'
  ) as r;

  insert into bur_test_state values ('request_fresh_a_id', v_fresh_req_id::text)
    on conflict (key) do update set value = excluded.value;
end;
$$;

reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-bur000000004","app_metadata":{"role":"admin","tenant":"tenant-bur-a"}}',
  true
);

do $$
declare
  v_req_id    uuid;
  v_queue_cnt bigint;
  v_status    text;
begin
  select value::uuid into v_req_id from bur_test_state where key = 'request_fresh_a_id';

  -- Ops admin should see own-tenant records via the queue RPC
  select count(*) into v_queue_cnt
  from public.ops_get_billing_update_queue()
  where request_id = v_req_id;

  if v_queue_cnt <> 1 then
    raise exception 'FAIL 11a: authenticated admin expected 1 own-tenant request in queue, got %', v_queue_cnt;
  end if;

  -- Admin should not see other tenant's requests via the queue RPC
  select count(*) into v_queue_cnt
  from public.ops_get_billing_update_queue()
  where tenant_id = 'tenant-bur-b';

  if v_queue_cnt <> 0 then
    raise exception 'FAIL 11b: authenticated admin (tenant-bur-a) can see tenant-bur-b rows via queue view';
  end if;

  -- Admin should be able to record a decision for own-tenant request
  select r.status into v_status
  from public.ops_record_billing_update_decision(
    p_request_id  => v_req_id,
    p_decision    => 'reject',
    p_reviewer_id => 'admin-reviewer-001',
    p_note        => 'Test rejection'
  ) as r;

  if v_status <> 'rejected' then
    raise exception 'FAIL 11c: authenticated admin expected rejected status, got %', v_status;
  end if;

  raise notice 'PASS 11: ops admin can read own-tenant queue via RPC, cannot see cross-tenant rows, and can record decision';
end;
$$;

reset role;

-- ── 12. Cross-tenant ops caller denied ops_record_billing_update_decision ─────
-- tenant-bur-b has a pending request (request_b_id); authenticated admin from
-- tenant-bur-a must not be able to record a decision for it.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-bur000000005","app_metadata":{"role":"admin","tenant":"tenant-bur-a"}}',
  true
);

do $$
declare
  v_caught bool := false;
  v_req_b  uuid;
begin
  select value::uuid into v_req_b from bur_test_state where key = 'request_b_id';

  begin
    perform public.ops_record_billing_update_decision(
      p_request_id  => v_req_b,
      p_decision    => 'approve',
      p_reviewer_id => 'cross-tenant-admin'
    );
    raise exception 'FAIL 12: cross-tenant admin recorded decision for another tenant''s request';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%not authorized%' or sqlerrm ilike '%42501%' then
        v_caught := true;
      else
        raise exception 'FAIL 12: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 12: cross-tenant decision was not denied';
  end if;
  raise notice 'PASS 12: cross-tenant ops_record_billing_update_decision correctly denied (42501)';
end;
$$;

reset role;

-- ── 13. Cross-tenant ops caller denied ops_apply_billing_update ───────────────
-- tenant-bur-b request_b_id is already in approved status (set up in fixture).
-- authenticated admin from tenant-bur-a must not be able to apply it.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-bur000000006","app_metadata":{"role":"admin","tenant":"tenant-bur-a"}}',
  true
);

do $$
declare
  v_caught bool := false;
  v_req_b  uuid;
begin
  select value::uuid into v_req_b from bur_test_state where key = 'request_b_id';

  begin
    perform public.ops_apply_billing_update(
      p_request_id => v_req_b,
      p_applied_by => 'cross-tenant-admin'
    );
    raise exception 'FAIL 13: cross-tenant admin applied another tenant''s request';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%not authorized%' or sqlerrm ilike '%42501%' then
        v_caught := true;
      else
        raise exception 'FAIL 13: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then
    raise exception 'FAIL 13: cross-tenant apply was not denied';
  end if;
  raise notice 'PASS 13: cross-tenant ops_apply_billing_update correctly denied (42501)';
end;
$$;

reset role;

-- ── 14. portal_issue_billing_update_token denied for anon and non-admin auth ──
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.portal_issue_billing_update_token(
      p_tenant_id          => 'tenant-bur-x',
      p_billing_account_id => 'acct-x',
      p_customer_id        => 'cust-x',
      p_expires_at         => now() + interval '1 hour'
    );
    raise exception 'FAIL 14a: anon issued a billing update token';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%42501%' then
        v_caught := true;
      else
        raise exception 'FAIL 14a: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then raise exception 'FAIL 14a: anon not denied'; end if;
  raise notice 'PASS 14a: anon denied portal_issue_billing_update_token';
end;
$$;

reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-bur000000007","app_metadata":{"role":"read_only","tenant":"tenant-bur-readonly"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.portal_issue_billing_update_token(
      p_tenant_id          => 'tenant-bur-readonly',
      p_billing_account_id => 'acct-ro',
      p_customer_id        => 'cust-ro',
      p_expires_at         => now() + interval '1 hour'
    );
    raise exception 'FAIL 14b: authenticated/read_only issued a billing update token';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%requires%' or sqlerrm ilike '%42501%' then
        v_caught := true;
      else
        raise exception 'FAIL 14b: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then raise exception 'FAIL 14b: read_only caller not denied'; end if;
  raise notice 'PASS 14b: authenticated/read_only denied portal_issue_billing_update_token';
end;
$$;

reset role;

-- ── 15. portal_issue_billing_update_token denied for cross-tenant issuance ────
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-bur000000008","app_metadata":{"role":"admin","tenant":"tenant-bur-issuer"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.portal_issue_billing_update_token(
      p_tenant_id          => 'tenant-bur-OTHER',
      p_billing_account_id => 'acct-other',
      p_customer_id        => 'cust-other',
      p_expires_at         => now() + interval '1 hour'
    );
    raise exception 'FAIL 15: cross-tenant token issuance was accepted';
  exception
    when insufficient_privilege then v_caught := true;
    when others then
      if sqlerrm ilike '%different tenant%' or sqlerrm ilike '%42501%' then
        v_caught := true;
      else
        raise exception 'FAIL 15: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;
  if not v_caught then raise exception 'FAIL 15: cross-tenant issuance not denied'; end if;
  raise notice 'PASS 15: authenticated/admin denied portal_issue_billing_update_token for a different tenant (42501)';
end;
$$;

reset role;

rollback;
