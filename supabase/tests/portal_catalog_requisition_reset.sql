-- Reset-path regression tests for portal catalog requisition
-- (migration 20260609140000_portal_catalog_requisition.sql).
--
-- Run after `supabase db reset --config supabase/config.toml` to confirm:
--   1. Schema shape: v_portal_catalog_assets view, portal_get_catalog_assets,
--      and portal_submit_requisition exist with the expected signatures and
--      grants.
--   2. Seed data: at least one available asset exists in the demo-baseline
--      seed so portal_get_catalog_assets has rows to return.
--   3. Catalog browse (service_role): portal_get_catalog_assets bypasses the
--      scope-token check for service_role and returns available assets.
--   4. Requisition submission (service_role): portal_submit_requisition
--      creates a persisted 'requisition' entity and returns a UUID.
--   5. Dispatch-ready entity shape: the persisted entity has status='pending',
--      source='portal_catalog', and the required dispatch handoff fields
--      (job_site_id, asset_id, start_date, end_date).
--   6. Scope-token enforcement (anon path):
--      - anon + valid scope token bound to job_site_id can browse catalog.
--      - anon + valid scope token bound to job_site_id can submit a requisition.
--      - anon + missing token is denied (42501).
--      - anon + forged token is denied (42501).
--
-- Intended to be run against the local Supabase stack immediately after
-- `supabase db reset --config supabase/config.toml` so seed.sql has been applied.

-- Supabase installs pgcrypto in the 'extensions' schema; plain Postgres installs
-- it in 'public'.  Including both in the session search_path makes digest()
-- resolvable in either environment ('extensions' is silently ignored when absent).
set search_path = public, extensions;

begin;

do $$
declare
  v_demo_job_site_id  constant text := 'reset-catalog-test-site-001';
  v_demo_scope_token  constant text := 'reset-catalog-test-scope-token-001';
  v_forged_token      constant text := 'reset-catalog-test-forged-token';

  v_view_exists        bool;
  v_rpc_catalog_exists bool;
  v_rpc_submit_exists  bool;
  v_available_count    int;
  v_asset_id_text      text;
  v_requisition_id     uuid;
  v_req_status         text;
  v_req_source         text;
  v_req_job_site_id    text;
  v_req_asset_id       text;
  v_req_start_date     text;
  v_req_end_date       text;
  v_catalog_count      int;
  v_caught             bool;
  v_dummy_contract_id  uuid := gen_random_uuid();
begin
  -- Establish service_role context for all setup and service_role path tests.
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- ──────────────────────────────────────────────────────────────────────────
  -- 1. Schema shape
  -- ──────────────────────────────────────────────────────────────────────────

  -- 1a. v_portal_catalog_assets view exists
  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and c.relname = 'v_portal_catalog_assets'
  ) into v_view_exists;

  if not v_view_exists then
    raise exception 'FAIL 1a: v_portal_catalog_assets view is missing — migration 20260609140000 may not have applied';
  end if;

  raise notice 'PASS 1a: v_portal_catalog_assets view exists';

  -- 1b. portal_get_catalog_assets(text, text) exists as SECURITY DEFINER
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'portal_get_catalog_assets'
      and p.prosecdef = true
      and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_job_site_id text, p_scope_token text'
  ) into v_rpc_catalog_exists;

  if not v_rpc_catalog_exists then
    raise exception 'FAIL 1b: portal_get_catalog_assets(text, text) is missing or not SECURITY DEFINER';
  end if;

  raise notice 'PASS 1b: portal_get_catalog_assets(text, text) exists (SECURITY DEFINER)';

  -- 1c. portal_submit_requisition(text, text, date, date, text, text, text)
  --     exists as SECURITY DEFINER
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'portal_submit_requisition'
      and p.prosecdef = true
      and pg_catalog.pg_get_function_identity_arguments(p.oid)
          = 'p_job_site_id text, p_asset_id text, p_start_date date, p_end_date date, p_dispatch_yard text, p_notes text, p_scope_token text'
  ) into v_rpc_submit_exists;

  if not v_rpc_submit_exists then
    raise exception 'FAIL 1c: portal_submit_requisition(text, text, date, date, text, text, text) is missing or not SECURITY DEFINER';
  end if;

  raise notice 'PASS 1c: portal_submit_requisition(text, text, date, date, text, text, text) exists (SECURITY DEFINER)';

  raise notice 'PASS 1: Migration schema shape verified (1a–1c)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 2. Seed data: available assets must exist after reset + seed
  -- ──────────────────────────────────────────────────────────────────────────

  select count(*)
    into v_available_count
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.entity_type = 'asset'
    and ev.data ->> 'status' = 'available'
    and e.source_record_id like 'demo-baseline-asset-%';

  if v_available_count < 1 then
    raise exception
      'FAIL 2: Expected at least 1 seeded available asset after db reset; found %',
      v_available_count;
  end if;

  raise notice 'PASS 2: % seeded available asset(s) present after reset', v_available_count;

  -- Resolve a seeded available asset to use for the service_role requisition tests
  select e.id::text
    into v_asset_id_text
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.entity_type = 'asset'
    and ev.data ->> 'status' = 'available'
    and e.source_record_id like 'demo-baseline-asset-%'
  order by e.source_record_id
  limit 1;

  -- ──────────────────────────────────────────────────────────────────────────
  -- 3. Catalog browse — service_role bypasses scope token and gets results
  -- ──────────────────────────────────────────────────────────────────────────

  select count(*)
    into v_catalog_count
  from portal_get_catalog_assets(v_demo_job_site_id, null);

  if v_catalog_count < 1 then
    raise exception
      'FAIL 3: portal_get_catalog_assets returned 0 rows as service_role — seeded available assets are missing from the catalog view';
  end if;

  raise notice 'PASS 3: portal_get_catalog_assets returned % row(s) as service_role', v_catalog_count;

  -- ──────────────────────────────────────────────────────────────────────────
  -- 4. Requisition submission — service_role creates a durable entity
  -- ──────────────────────────────────────────────────────────────────────────

  select requisition_id
    into v_requisition_id
  from portal_submit_requisition(
    p_job_site_id   => v_demo_job_site_id,
    p_asset_id      => v_asset_id_text,
    p_start_date    => current_date + 1,
    p_end_date      => current_date + 14,
    p_dispatch_yard => 'North Yard',
    p_notes         => 'Reset-path smoke test requisition',
    p_scope_token   => null
  );

  if v_requisition_id is null then
    raise exception 'FAIL 4: portal_submit_requisition returned null requisition_id as service_role';
  end if;

  if not exists (
    select 1 from public.entities
    where id = v_requisition_id
      and entity_type = 'requisition'
  ) then
    raise exception 'FAIL 4: requisition entity not persisted in entities table (entity_type=''requisition'')';
  end if;

  raise notice 'PASS 4: service_role submitted requisition %; entity persisted', v_requisition_id;

  -- ──────────────────────────────────────────────────────────────────────────
  -- 5. Dispatch-ready entity shape
  --    The entity_versions row must carry the fields consumed by the dispatch
  --    handoff: status, source, job_site_id, asset_id, start_date, end_date.
  -- ──────────────────────────────────────────────────────────────────────────

  select
    ev.data ->> 'status'       as req_status,
    ev.data ->> 'source'       as req_source,
    ev.data ->> 'job_site_id'  as req_job_site_id,
    ev.data ->> 'asset_id'     as req_asset_id,
    ev.data ->> 'start_date'   as req_start_date,
    ev.data ->> 'end_date'     as req_end_date
    into v_req_status, v_req_source, v_req_job_site_id,
         v_req_asset_id, v_req_start_date, v_req_end_date
  from public.entity_versions ev
  where ev.entity_id = v_requisition_id
    and ev.is_current = true;

  if v_req_status is null then
    raise exception 'FAIL 5: entity_versions row for requisition % not found or status is null', v_requisition_id;
  end if;
  if v_req_status <> 'pending' then
    raise exception 'FAIL 5: expected status=pending, got %', v_req_status;
  end if;
  if v_req_source <> 'portal_catalog' then
    raise exception 'FAIL 5: expected source=portal_catalog, got %', v_req_source;
  end if;
  if v_req_job_site_id <> v_demo_job_site_id then
    raise exception 'FAIL 5: expected job_site_id=%, got %', v_demo_job_site_id, v_req_job_site_id;
  end if;
  if v_req_asset_id <> v_asset_id_text then
    raise exception 'FAIL 5: expected asset_id=%, got %', v_asset_id_text, v_req_asset_id;
  end if;
  if v_req_start_date is null or v_req_end_date is null then
    raise exception 'FAIL 5: start_date or end_date is null in requisition entity';
  end if;

  raise notice 'PASS 5: Dispatch-ready requisition shape verified (status=pending, source=portal_catalog, all dispatch fields present)';

  -- ──────────────────────────────────────────────────────────────────────────
  -- 6. Scope-token enforcement — anon path
  --    Seed a test scope token bound to v_demo_job_site_id so we can exercise
  --    the anon code path without depending on the demo portal scope token
  --    (which has job_site_id=null and therefore does not match catalog RPCs
  --    by job_site_id lookup).
  -- ──────────────────────────────────────────────────────────────────────────

  -- Seed a test scope token bound to v_demo_job_site_id.
  -- portal_contract_scope_tokens has no FK constraint back to entities, so a
  -- fresh UUID is sufficient for the contract_id in this test context.
  insert into public.portal_contract_scope_tokens (contract_id, token_hash, job_site_id)
  values (
    v_dummy_contract_id,
    encode(digest(v_demo_scope_token, 'sha256'), 'hex'),
    v_demo_job_site_id
  )
  on conflict (contract_id) do update
    set token_hash   = excluded.token_hash,
        job_site_id  = excluded.job_site_id,
        updated_at   = now();

  -- 6a. anon + valid scope token + matching job_site_id → catalog browse succeeds
  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  select count(*)
    into v_catalog_count
  from portal_get_catalog_assets(v_demo_job_site_id, v_demo_scope_token);

  if v_catalog_count < 1 then
    raise exception
      'FAIL 6a: anon + valid scope token returned 0 rows from portal_get_catalog_assets — expected at least one seeded available asset';
  end if;

  raise notice 'PASS 6a: anon + valid scope token can browse catalog (% row(s) returned)', v_catalog_count;

  -- 6b. anon + valid scope token + matching job_site_id → requisition submission succeeds
  select requisition_id
    into v_requisition_id
  from portal_submit_requisition(
    p_job_site_id   => v_demo_job_site_id,
    p_asset_id      => v_asset_id_text,
    p_start_date    => current_date + 2,
    p_end_date      => current_date + 16,
    p_scope_token   => v_demo_scope_token
  );

  if v_requisition_id is null then
    raise exception 'FAIL 6b: anon + valid scope token returned null requisition_id from portal_submit_requisition';
  end if;

  raise notice 'PASS 6b: anon + valid scope token can submit requisition; id=%', v_requisition_id;

  -- 6c. anon + missing scope token → 42501 for catalog browse
  v_caught := false;
  begin
    perform portal_get_catalog_assets(v_demo_job_site_id, null);
    raise exception 'FAIL 6c: anon catalog browse without scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6c: missing scope token raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6c: missing scope token did not raise 42501 for catalog browse';
  end if;

  raise notice 'PASS 6c: anon + missing scope token denied (42501) for catalog browse';

  -- 6d. anon + forged scope token → 42501 for catalog browse
  v_caught := false;
  begin
    perform portal_get_catalog_assets(v_demo_job_site_id, v_forged_token);
    raise exception 'FAIL 6d: anon catalog browse with forged scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6d: forged scope token raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6d: forged scope token did not raise 42501 for catalog browse';
  end if;

  raise notice 'PASS 6d: anon + forged scope token denied (42501) for catalog browse';

  -- 6e. anon + missing scope token → 42501 for requisition submission
  v_caught := false;
  begin
    perform portal_submit_requisition(
      p_job_site_id => v_demo_job_site_id,
      p_asset_id    => v_asset_id_text,
      p_start_date  => current_date + 1,
      p_end_date    => current_date + 14,
      p_scope_token => null
    );
    raise exception 'FAIL 6e: anon requisition without scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6e: missing scope token raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6e: missing scope token did not raise 42501 for requisition submission';
  end if;

  raise notice 'PASS 6e: anon + missing scope token denied (42501) for requisition submission';

  -- 6f. anon + forged scope token → 42501 for requisition submission
  v_caught := false;
  begin
    perform portal_submit_requisition(
      p_job_site_id => v_demo_job_site_id,
      p_asset_id    => v_asset_id_text,
      p_start_date  => current_date + 1,
      p_end_date    => current_date + 14,
      p_scope_token => v_forged_token
    );
    raise exception 'FAIL 6f: anon requisition with forged scope token was accepted';
  exception
    when insufficient_privilege then
      v_caught := true;
    when others then
      raise exception 'FAIL 6f: forged scope token raised unexpected % "%"', sqlstate, sqlerrm;
  end;
  if not v_caught then
    raise exception 'FAIL 6f: forged scope token did not raise 42501 for requisition submission';
  end if;

  raise notice 'PASS 6f: anon + forged scope token denied (42501) for requisition submission';

  raise notice 'PASS 6: Scope-token enforcement verified (6a–6f)';

  raise notice 'All portal_catalog_requisition reset-path checks passed';
end;
$$;

rollback;
