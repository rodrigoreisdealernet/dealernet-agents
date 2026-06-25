-- All fixture data inserted below is rolled back at the end of this script so
-- that running these assertions leaves the database in an unmodified state.
begin;

-- Reset-path validation for route exception threading and branch review bundle
-- (20260617001500_route_exception_thread_bundle.sql).
--
-- Confirms that after a full `supabase db reset --config supabase/config.toml`
-- (migrations + seed):
--   1. The open-thread partial index exists on route_stop_exceptions.
--   2. submit_stop_exception RPC is present and the v_route_exception_review_bundle
--      view is present.
--   3. Repeated same-stop same-type exception submissions collapse into one
--      unresolved thread (collapse semantics preserved after rebuild).
--   4. Photo evidence is merged and deduplicated across updates (evidence ordering).
--   5. ETA-delay validation rejects non-positive delay values.
--   6. v_route_exception_review_bundle exposes all evidence-bundle context fields
--      (evidence_bundle jsonb with exception / stop / route sub-objects) that
--      dispatch and branch review depend on.

-- ── 1. Schema object existence checks ────────────────────────────────────────

do $$
declare
  v_index_exists    bool;
  v_rls_enabled     bool;
  v_rpc_exists      bool;
  v_view_exists     bool;
begin
  -- Partial index for open-thread lookups.
  select exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename  = 'route_stop_exceptions'
      and indexname  = 'idx_route_stop_exceptions_open_thread'
  ) into v_index_exists;

  if not v_index_exists then
    raise exception 'Reset-path: idx_route_stop_exceptions_open_thread not found after reset';
  end if;

  -- RLS must be enabled on route_stop_exceptions (guards the service_role-only
  -- direct-insert restriction and the manager/driver read separation).
  select c.relrowsecurity
    into v_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'route_stop_exceptions';

  if not found or not coalesce(v_rls_enabled, false) then
    raise exception 'Reset-path: RLS not enabled on public.route_stop_exceptions after reset';
  end if;

  -- submit_stop_exception RPC.
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'submit_stop_exception'
  ) into v_rpc_exists;

  if not v_rpc_exists then
    raise exception 'Reset-path: submit_stop_exception RPC not found after reset';
  end if;

  -- v_route_exception_review_bundle view.
  select exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_route_exception_review_bundle'
      and c.relkind = 'v'
  ) into v_view_exists;

  if not v_view_exists then
    raise exception 'Reset-path: v_route_exception_review_bundle view not found after reset';
  end if;

  raise notice 'Reset-path object checks passed: index / RLS / RPC / view exist';
end;
$$;

-- ── 2. Thread-collapse semantics ─────────────────────────────────────────────
-- Repeated same-stop same-exception-type submissions must fold into one
-- unresolved row; no sibling exceptions may be forked.
--
-- submit_stop_exception grants execute only to authenticated; use that role
-- throughout so the RLS insert checks and the function grant both resolve.

set local role authenticated;

do $$
declare
  v_driver_id  uuid := gen_random_uuid();
  v_route_id   uuid;
  v_stop_id    uuid;
  v_exc_id_1   uuid;
  v_exc_id_2   uuid;
  v_open_count int;
begin
  -- Set admin JWT claims before any table access so RLS insert checks pass.
  perform set_config('request.jwt.claims',
    json_build_object(
      'sub', v_driver_id::text,
      'app_metadata', json_build_object('role', 'admin')
    )::text, true);

  -- Minimal route + stop fixture (no demo data dependency).
  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name
  ) values (
    v_route_id, 0, 'delivery', 'pending',
    '1 Thread Collapse Rd, Austin TX 78701',
    'Reset Contractor',
    'Reset Site'
  ) returning id into v_stop_id;

  -- First submission creates the open thread.
  v_exc_id_1 := public.submit_stop_exception(
    p_stop_id       => v_stop_id,
    p_exception_type => 'access_issue',
    p_notes         => 'Gate locked — first report',
    p_photo_paths   => array['photo_a.jpg']
  );

  if v_exc_id_1 is null then
    raise exception 'Reset-path: first submit_stop_exception returned null';
  end if;

  -- Second submission for the same open thread must return the same row id.
  v_exc_id_2 := public.submit_stop_exception(
    p_stop_id       => v_stop_id,
    p_exception_type => 'access_issue',
    p_notes         => 'Still locked — follow-up update',
    p_photo_paths   => array['photo_b.jpg']
  );

  if v_exc_id_2 is null then
    raise exception 'Reset-path: second submit_stop_exception returned null';
  end if;

  if v_exc_id_2 <> v_exc_id_1 then
    raise exception
      'Reset-path: thread-collapse failed — second submit forked a sibling row; expected % got %',
      v_exc_id_1, v_exc_id_2;
  end if;

  -- Confirm exactly one unresolved exception row for this stop/type.
  select count(*) into v_open_count
  from public.route_stop_exceptions
  where stop_id = v_stop_id
    and exception_type = 'access_issue'
    and resolved_at is null;

  if v_open_count <> 1 then
    raise exception
      'Reset-path: expected 1 open thread after two same-type submissions, found %',
      v_open_count;
  end if;

  raise notice 'Reset-path thread-collapse checks passed: repeated same-stop same-type collapses to one unresolved thread';
end;
$$;

-- ── 3. Evidence ordering — photo_paths merge and deduplication ───────────────

do $$
declare
  v_driver_id   uuid := gen_random_uuid();
  v_route_id    uuid;
  v_stop_id     uuid;
  v_exc_id      uuid;
  v_photo_paths text[];
begin
  perform set_config('request.jwt.claims',
    json_build_object(
      'sub', v_driver_id::text,
      'app_metadata', json_build_object('role', 'admin')
    )::text, true);

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name
  ) values (
    v_route_id, 1, 'delivery', 'pending',
    '2 Evidence Merge Ave, Austin TX 78701',
    'Evidence Contractor',
    'Evidence Site'
  ) returning id into v_stop_id;

  -- First submission with two photos.
  v_exc_id := public.submit_stop_exception(
    p_stop_id       => v_stop_id,
    p_exception_type => 'damage',
    p_notes         => 'Damage noted',
    p_photo_paths   => array['img1.jpg', 'img2.jpg']
  );

  -- Second submission adds one new photo and re-submits an existing one (dedup test).
  perform public.submit_stop_exception(
    p_stop_id       => v_stop_id,
    p_exception_type => 'damage',
    p_notes         => 'More damage',
    p_photo_paths   => array['img2.jpg', 'img3.jpg']
  );

  select e.photo_paths into v_photo_paths
  from public.route_stop_exceptions e
  where e.id = v_exc_id;

  -- After merge: exact sequence must be img1.jpg, img2.jpg, img3.jpg in that order.
  -- img2.jpg was first seen at position 2 and img3.jpg at position 4 (after concat
  -- with the existing array), so first-occurrence ordering must yield this sequence.
  -- A membership-only check would still pass for any permutation; compare the full
  -- array so a regression in the min(ord) dedup ordering fails the gate.
  if v_photo_paths <> array['img1.jpg', 'img2.jpg', 'img3.jpg'] then
    raise exception
      'Reset-path: photo_paths merge order incorrect; expected {img1.jpg,img2.jpg,img3.jpg} got %',
      v_photo_paths::text;
  end if;

  raise notice 'Reset-path evidence-ordering checks passed: photo_paths merged, deduplicated, and ordered correctly';
end;
$$;

-- ── 4. ETA-delay validation ──────────────────────────────────────────────────

do $$
declare
  v_driver_id  uuid := gen_random_uuid();
  v_route_id   uuid;
  v_stop_id    uuid;
  v_caught     bool := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object(
      'sub', v_driver_id::text,
      'app_metadata', json_build_object('role', 'admin')
    )::text, true);

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name
  ) values (
    v_route_id, 2, 'delivery', 'pending',
    '3 ETA Validate Blvd, Austin TX 78701',
    'ETA Contractor',
    'ETA Site'
  ) returning id into v_stop_id;

  -- Non-positive delay must be rejected.
  begin
    perform public.submit_stop_exception(
      p_stop_id                 => v_stop_id,
      p_exception_type          => 'eta_delay',
      p_notes                   => 'ETA delay validation test',
      p_estimated_delay_minutes => 0
    );
  exception when others then
    if sqlerrm ilike '%estimated_delay_minutes must be greater than zero%' then
      v_caught := true;
    else
      raise;
    end if;
  end;

  if not v_caught then
    raise exception 'Reset-path: submit_stop_exception should have rejected estimated_delay_minutes=0';
  end if;

  -- Valid positive delay must succeed.
  declare
    v_exc_id     uuid;
    v_delay_min  int;
  begin
    v_exc_id := public.submit_stop_exception(
      p_stop_id                 => v_stop_id,
      p_exception_type          => 'eta_delay',
      p_notes                   => 'Running 45 min late',
      p_estimated_delay_minutes => 45
    );

    if v_exc_id is null then
      raise exception 'Reset-path: valid eta_delay submission returned null';
    end if;

    select e.estimated_delay_minutes into v_delay_min
    from public.route_stop_exceptions e
    where e.id = v_exc_id;

    if coalesce(v_delay_min, 0) <> 45 then
      raise exception
        'Reset-path: expected estimated_delay_minutes=45, got %', v_delay_min;
    end if;
  end;

  raise notice 'Reset-path ETA-delay validation checks passed: zero/negative rejected, positive accepted';
end;
$$;

-- ── 5. v_route_exception_review_bundle — evidence-bundle projection ───────────

do $$
declare
  v_driver_id  uuid := gen_random_uuid();
  v_route_id   uuid;
  v_stop_id    uuid;
  v_exc_id     uuid;
  v_row        record;
  v_bundle     jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object(
      'sub', v_driver_id::text,
      'app_metadata', json_build_object('role', 'admin')
    )::text, true);

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'pending')
  returning id into v_route_id;

  insert into public.route_stops (
    route_id, sequence_order, stop_type, status,
    address, customer_name, job_site_name
  ) values (
    v_route_id, 3, 'pickup', 'pending',
    '4 Review Bundle St, Austin TX 78701',
    'Bundle Customer',
    'Bundle Site'
  ) returning id into v_stop_id;

  v_exc_id := public.submit_stop_exception(
    p_stop_id       => v_stop_id,
    p_exception_type => 'missing_attachment',
    p_notes         => 'Missing paperwork for branch review',
    p_photo_paths   => array['evidence1.jpg']
  );

  -- Query the view (authenticated + admin claims satisfies the manager-read RLS policies).
  select * into v_row
  from public.v_route_exception_review_bundle
  where exception_id = v_exc_id;

  if not found then
    raise exception 'Reset-path: v_route_exception_review_bundle row not found for exception %', v_exc_id;
  end if;

  -- Scalar projection fields required by dispatch/branch handoff.
  if v_row.stop_id is null then
    raise exception 'Reset-path: stop_id missing from v_route_exception_review_bundle';
  end if;

  if v_row.route_id is null then
    raise exception 'Reset-path: route_id missing from v_route_exception_review_bundle';
  end if;

  if v_row.exception_type is null then
    raise exception 'Reset-path: exception_type missing from v_route_exception_review_bundle';
  end if;

  if v_row.exception_type <> 'missing_attachment' then
    raise exception
      'Reset-path: expected exception_type=missing_attachment, got %', v_row.exception_type;
  end if;

  if not coalesce(v_row.is_damage_or_missing_attachment, false) then
    raise exception 'Reset-path: is_damage_or_missing_attachment should be true for missing_attachment';
  end if;

  if v_row.requires_human_review is null or not v_row.requires_human_review then
    raise exception 'Reset-path: requires_human_review must be true in view';
  end if;

  if v_row.customer_name is null then
    raise exception 'Reset-path: customer_name missing from v_route_exception_review_bundle';
  end if;

  if v_row.route_date is null then
    raise exception 'Reset-path: route_date missing from v_route_exception_review_bundle';
  end if;

  -- evidence_bundle jsonb must carry exception / stop / route sub-objects.
  v_bundle := v_row.evidence_bundle;

  if v_bundle is null then
    raise exception 'Reset-path: evidence_bundle jsonb is null in v_route_exception_review_bundle';
  end if;

  if (v_bundle -> 'exception') is null then
    raise exception 'Reset-path: evidence_bundle missing exception sub-object';
  end if;

  if (v_bundle -> 'stop') is null then
    raise exception 'Reset-path: evidence_bundle missing stop sub-object';
  end if;

  if (v_bundle -> 'route') is null then
    raise exception 'Reset-path: evidence_bundle missing route sub-object';
  end if;

  if (v_bundle -> 'exception' ->> 'requires_human_review') is null then
    raise exception 'Reset-path: evidence_bundle exception sub-object missing requires_human_review';
  end if;

  if (v_bundle -> 'exception' ->> 'type') <> 'missing_attachment' then
    raise exception
      'Reset-path: evidence_bundle exception.type mismatch; got %',
      (v_bundle -> 'exception' ->> 'type');
  end if;

  if (v_bundle -> 'stop' ->> 'stop_id') is null then
    raise exception 'Reset-path: evidence_bundle stop sub-object missing stop_id';
  end if;

  if (v_bundle -> 'route' ->> 'driver_id') is null then
    raise exception 'Reset-path: evidence_bundle route sub-object missing driver_id';
  end if;

  raise notice 'Reset-path view checks passed: v_route_exception_review_bundle evidence-bundle context fields present';
end;
$$;

reset role;

rollback;
