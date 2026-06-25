-- All fixture data inserted below is rolled back at the end of this script so
-- that running these assertions leaves the database in an unmodified state.
begin;

-- Reset-path validation for delivery_complaint_proof_bundle
-- (20260617130000_delivery_complaint_proof_bundle.sql).
--
-- Confirms that after a full `supabase db reset --config supabase/config.toml`
-- (migrations + seed):
--   1. delivery_complaint_cases table exists with RLS enabled.
--   2. upsert_complaint_case and get_complaint_case RPCs are present.
--   3. v_complaint_case_review_bundle view is present and includes all expected
--      evidence-bundle context and recovery-routing fields.
--   4. An upsert round-trip creates a case, idempotent re-upsert returns the
--      same case_id (no sibling record), and get_complaint_case returns the
--      full evidence-bundle including stop/route/POD context.
--   5. Tenant-scoped read via the view is confirmed: the review_bundle jsonb
--      contains all fields needed for the complaint-review flow.

-- ── 1. Schema object existence checks ────────────────────────────────────────

do $$
declare
  v_has_rls             bool;
  v_upsert_exists       bool;
  v_get_case_exists     bool;
  v_view_exists         bool;
begin
  -- delivery_complaint_cases table + RLS
  select c.relrowsecurity
    into v_has_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'delivery_complaint_cases';

  if not found or not coalesce(v_has_rls, false) then
    raise exception 'Expected RLS enabled on public.delivery_complaint_cases after reset';
  end if;

  -- upsert_complaint_case RPC
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'upsert_complaint_case'
  ) into v_upsert_exists;

  if not v_upsert_exists then
    raise exception 'upsert_complaint_case RPC not found after reset';
  end if;

  -- get_complaint_case RPC
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_complaint_case'
  ) into v_get_case_exists;

  if not v_get_case_exists then
    raise exception 'get_complaint_case RPC not found after reset';
  end if;

  -- v_complaint_case_review_bundle view
  select exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_complaint_case_review_bundle'
      and c.relkind = 'v'
  ) into v_view_exists;

  if not v_view_exists then
    raise exception 'v_complaint_case_review_bundle view not found after reset';
  end if;

  raise notice 'Reset-path object checks passed: table/RLS/RPCs/view exist';
end;
$$;

-- ── 2. Fixture: upsert + idempotent re-upsert + get_complaint_case bundle ────

do $$
declare
  v_driver_id   uuid := gen_random_uuid();
  v_route_id    uuid;
  v_stop_id     uuid;
  v_case_id     uuid;
  v_case_id_2   uuid;
  v_bundle      json;
  v_review      record;
begin
  -- Seed a minimal route + stop fixture (no demo data dependency).
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name
  ) values (
    v_route_id, 0, 'delivery', 'pending',
    '1 Complaint Reset Ave, Austin TX 78701',
    'Reset Contractor',
    'Reset Site'
  ) returning id into v_stop_id;

  -- Use admin claims so the RPC role gate passes.
  perform set_config('request.jwt.claims',
    '{"app_metadata":{"role":"admin"}}', true);

  -- First upsert creates the complaint case.
  v_case_id := public.upsert_complaint_case(
    p_stop_id           => v_stop_id,
    p_complaint_type    => 'late_delivery',
    p_complaint_narrative => 'Driver arrived 2 hours late — reset-path fixture',
    p_evidence_bundle   => '{"source": "reset_path_test"}'::jsonb,
    p_recovery_action   => 'branch_follow_up',
    p_evidence_status   => 'packaged'
  );

  if v_case_id is null then
    raise exception 'Reset-path: upsert_complaint_case returned null on first insert';
  end if;

  -- Second upsert for the same open thread must return the same case_id.
  v_case_id_2 := public.upsert_complaint_case(
    p_stop_id         => v_stop_id,
    p_complaint_type  => 'late_delivery',
    p_evidence_status => 'ambiguous'
  );

  if v_case_id_2 is null then
    raise exception 'Reset-path: idempotent upsert returned null';
  end if;

  if v_case_id_2 <> v_case_id then
    raise exception
      'Reset-path: idempotent upsert forked a sibling record; expected % got %',
      v_case_id, v_case_id_2;
  end if;

  -- get_complaint_case must return the full evidence-bundle context.
  v_bundle := public.get_complaint_case(v_case_id);

  if v_bundle is null then
    raise exception 'Reset-path: get_complaint_case returned null';
  end if;

  if (v_bundle::jsonb ->> 'complaint_type') <> 'late_delivery' then
    raise exception 'Reset-path: complaint_type missing from get_complaint_case output';
  end if;

  if (v_bundle::jsonb ->> 'recovery_action') is null then
    raise exception 'Reset-path: recovery_action missing from get_complaint_case output';
  end if;

  if (v_bundle::jsonb ->> 'requires_human_review') is null then
    raise exception 'Reset-path: requires_human_review missing from get_complaint_case output';
  end if;

  if (v_bundle::jsonb -> 'stop') is null then
    raise exception 'Reset-path: stop context missing from get_complaint_case output';
  end if;

  if (v_bundle::jsonb -> 'route') is null then
    raise exception 'Reset-path: route context missing from get_complaint_case output';
  end if;

  -- evidence_status was set to 'ambiguous' by the idempotent re-upsert.
  if (v_bundle::jsonb ->> 'evidence_status') <> 'ambiguous' then
    raise exception
      'Reset-path: expected evidence_status=ambiguous after re-upsert, got %',
      (v_bundle::jsonb ->> 'evidence_status');
  end if;

  raise notice 'Reset-path fixture checks passed: upsert / idempotent upsert / get_complaint_case bundle';
end;
$$;

-- ── 3. v_complaint_case_review_bundle — review_bundle jsonb completeness ─────

do $$
declare
  v_driver_id   uuid := gen_random_uuid();
  v_route_id    uuid;
  v_stop_id     uuid;
  v_case_id     uuid;
  v_review      record;
  v_bundle      jsonb;
begin
  -- Fresh stop fixture for this block.
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name
  ) values (
    v_route_id, 0, 'delivery', 'pending',
    '2 View Reset Blvd, Austin TX 78701',
    'View Reset Contractor',
    'View Reset Site'
  ) returning id into v_stop_id;

  perform set_config('request.jwt.claims',
    '{"app_metadata":{"role":"admin"}}', true);

  v_case_id := public.upsert_complaint_case(
    p_stop_id           => v_stop_id,
    p_complaint_type    => 'missed_delivery',
    p_recovery_action   => 'escalate_dispatcher',
    p_evidence_status   => 'incomplete'
  );

  -- Query the view (postgres superuser bypasses RLS; security_invoker means the
  -- underlying tables see the superuser context set above).
  select * into v_review
  from public.v_complaint_case_review_bundle
  where case_id = v_case_id;

  if not found then
    raise exception 'Reset-path: v_complaint_case_review_bundle row not found for new case';
  end if;

  -- Recovery-routing fields.
  if v_review.recovery_action is null then
    raise exception 'Reset-path: recovery_action missing from v_complaint_case_review_bundle';
  end if;

  if v_review.recovery_action <> 'escalate_dispatcher' then
    raise exception
      'Reset-path: expected recovery_action=escalate_dispatcher, got %',
      v_review.recovery_action;
  end if;

  -- Tenant-scoped read-model context.
  if v_review.customer_name is null then
    raise exception 'Reset-path: customer_name missing from v_complaint_case_review_bundle';
  end if;

  if v_review.route_id is null then
    raise exception 'Reset-path: route_id missing from v_complaint_case_review_bundle';
  end if;

  -- review_bundle jsonb must carry complaint + stop + route sub-objects.
  v_bundle := v_review.review_bundle;

  if v_bundle is null then
    raise exception 'Reset-path: review_bundle jsonb is null in v_complaint_case_review_bundle';
  end if;

  if (v_bundle -> 'complaint') is null then
    raise exception 'Reset-path: review_bundle missing complaint sub-object';
  end if;

  if (v_bundle -> 'stop') is null then
    raise exception 'Reset-path: review_bundle missing stop sub-object';
  end if;

  if (v_bundle -> 'route') is null then
    raise exception 'Reset-path: review_bundle missing route sub-object';
  end if;

  if (v_bundle -> 'complaint' ->> 'requires_human_review') is null then
    raise exception 'Reset-path: review_bundle complaint missing requires_human_review';
  end if;

  raise notice 'Reset-path view checks passed: v_complaint_case_review_bundle evidence-bundle context fields present';
end;
$$;

reset role;

rollback;
