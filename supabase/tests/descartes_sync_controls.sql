begin;

do $$
declare
  v_tenant_id uuid := '10000000-0000-0000-0000-000000001148';
  v_tenant_key text := 'tenant-descartes-1148';
  v_other_tenant_id uuid := '10000000-0000-0000-0000-000000001149';
  v_other_tenant_key text := 'tenant-descartes-1149';
  v_asset_id uuid := '20000000-0000-0000-0000-000000001148';
  v_line_id uuid := '30000000-0000-0000-0000-000000001148';
  v_other_line_id uuid := '30000000-0000-0000-0000-000000001149';
  v_route_id uuid;
  v_driver_id uuid := gen_random_uuid();

  v_retry_delivery_id uuid;
  v_nonretry_delivery_id uuid;
  v_cross_tenant_delivery_id uuid;

  v_retry_status text;
  v_retry_count int;
  v_quarantine_status text;
  v_quarantine_reason text;
  v_dashboard_retryable bigint;
  v_audit_events bigint;
  v_drift_count int;
  v_visible_rows bigint;
  v_other_tenant_visible bigint;
  v_caught bool;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  insert into public.tenants (id, tenant_key, name)
  values (v_tenant_id, v_tenant_key, 'Descartes Test Tenant')
  on conflict (id) do update set
    tenant_key = excluded.tenant_key,
    name = excluded.name;

  insert into public.tenants (id, tenant_key, name)
  values (v_other_tenant_id, v_other_tenant_key, 'Descartes Other Tenant')
  on conflict (id) do update set
    tenant_key = excluded.tenant_key,
    name = excluded.name;

  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_asset_id, 'asset', 'descartes-test-asset-1148'),
    (v_line_id, 'rental_contract_line', 'descartes-test-line-1148'),
    (v_other_line_id, 'rental_contract_line', 'descartes-test-line-1149')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (
      v_asset_id,
      1,
      true,
      '{"name":"Descartes Test Asset","serial_number":"DSC-1148","status":"on_rent"}'::jsonb,
      now()
    ),
    (
      v_line_id,
      1,
      true,
      jsonb_build_object(
        'status', 'checked_out',
        'contract_id', gen_random_uuid()::text,
        'asset_id', v_asset_id::text,
        'confirm_load', jsonb_build_object(
          'assigned_driver', 'driver-1148',
          'assigned_truck', 'truck-1148',
          'departure_at', now()::text
        )
      ),
      now()
    ),
    (
      v_other_line_id,
      1,
      true,
      jsonb_build_object(
        'status', 'checked_out',
        'contract_id', gen_random_uuid()::text,
        'asset_id', v_asset_id::text
      ),
      now()
    )
  on conflict (entity_id, version_number) do nothing;

  insert into public.dispatch_routes (driver_id, route_date, status)
  values (v_driver_id, current_date, 'in_progress')
  returning id into v_route_id;

  insert into public.logistics_telematics_events (
    contract_line_id,
    route_id,
    source_system,
    source_event_id,
    event_time,
    telemetry_position_status,
    eld_compliance_status,
    driver_log_status,
    sync_status
  ) values (
    v_line_id,
    v_route_id,
    'descartes',
    'telematics-1148',
    now(),
    'stale',
    'warning',
    'current',
    'retryable_failure'
  );

  -- Emit retryable failure telemetry event.
  insert into public.descartes_sync_delivery (
    tenant_id, provider_key, scope, contract_line_id, route_id, source_event_id,
    sync_status, is_retryable, error_code, error_message, payload, occurred_at
  ) values (
    v_tenant_id,
    'descartes',
    'route',
    v_line_id,
    v_route_id,
    'evt-retry-1148',
    'retryable_failure',
    true,
    'timeout',
    'Provider timeout',
    '{"provider_route_status":"delivered"}'::jsonb,
    now()
  ) returning id into v_retry_delivery_id;

  -- Emit non-retryable shipment failure telemetry event.
  insert into public.descartes_sync_delivery (
    tenant_id, provider_key, scope, contract_line_id, route_id, source_event_id,
    sync_status, is_retryable, error_code, error_message, payload, occurred_at
  ) values (
    v_tenant_id,
    'descartes',
    'shipment',
    v_line_id,
    v_route_id,
    'evt-nonretry-1148',
    'non_retryable_failure',
    false,
    'invalid_request',
    'Shipment payload rejected',
    '{"provider_shipment_status":"cancelled"}'::jsonb,
    now()
  ) returning id into v_nonretry_delivery_id;

  -- Emit retryable failure telemetry for another tenant (for RLS checks).
  insert into public.descartes_sync_delivery (
    tenant_id, provider_key, scope, contract_line_id, route_id, source_event_id,
    sync_status, is_retryable, error_code, error_message, payload, occurred_at
  ) values (
    v_other_tenant_id,
    'descartes',
    'route',
    v_other_line_id,
    v_route_id,
    'evt-cross-tenant-1149',
    'retryable_failure',
    true,
    'timeout',
    'Provider timeout',
    '{"provider_route_status":"in_progress"}'::jsonb,
    now()
  ) returning id into v_cross_tenant_delivery_id;

  -- Emit compliance status with drift signal.
  perform public.descartes_record_sync_delivery(
    v_tenant_id,
    'compliance',
    v_line_id,
    v_route_id,
    'evt-compliance-1148',
    'succeeded',
    false,
    null,
    null,
    '{"provider_compliance_status":"compliant"}'::jsonb,
    now()
  );

  select coalesce(sum(event_count), 0) into v_dashboard_retryable
  from public.v_descartes_sync_dashboard
  where tenant_id = v_tenant_id
    and sync_status = 'retryable_failure';

  if v_dashboard_retryable <> 1 then
    raise exception 'Expected retryable failure count 1 in dashboard view, got %', v_dashboard_retryable;
  end if;

  -- Audit events are emitted to shared time_series_points model.
  select count(*) into v_audit_events
  from public.time_series_points tsp
  join public.fact_types ft on ft.id = tsp.fact_type_id
  where ft.key = 'integration_descartes_sync_event'
    and tsp.entity_id = v_line_id
    and tsp.metadata ->> 'tenant_id' = v_tenant_id::text;

  if v_audit_events < 3 then
    raise exception 'Expected at least 3 Descartes audit events in time_series_points, got %', v_audit_events;
  end if;

  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claim.tenant', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);

  v_caught := false;
  begin
    insert into public.descartes_sync_delivery (
      tenant_id, provider_key, scope, contract_line_id, route_id, source_event_id, sync_status, payload
    ) values (
      v_tenant_id, 'descartes', 'route', v_line_id, v_route_id, 'evt-anon-write-denied-1148', 'succeeded', '{}'::jsonb
    );
  exception
    when others then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected anon direct writes to descartes_sync_delivery to be denied';
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', v_tenant_key, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'read_only',
        'tenant', v_tenant_key
      )
    )::text,
    true
  );

  v_caught := false;
  begin
    insert into public.descartes_sync_delivery (
      tenant_id, provider_key, scope, contract_line_id, route_id, source_event_id, sync_status, payload
    ) values (
      v_tenant_id, 'descartes', 'route', v_line_id, v_route_id, 'evt-readonly-write-denied-1148', 'succeeded', '{}'::jsonb
    );
  exception
    when others then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected read_only direct writes to descartes_sync_delivery to be denied';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'field_operator',
        'tenant', v_tenant_key
      )
    )::text,
    true
  );

  v_caught := false;
  begin
    insert into public.descartes_sync_delivery (
      tenant_id, provider_key, scope, contract_line_id, route_id, source_event_id, sync_status, payload
    ) values (
      v_tenant_id, 'descartes', 'route', v_line_id, v_route_id, 'evt-operator-write-denied-1148', 'succeeded', '{}'::jsonb
    );
  exception
    when others then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected field_operator direct writes to descartes_sync_delivery to be denied';
  end if;

  v_caught := false;
  begin
    perform public.descartes_retry_delivery(v_retry_delivery_id, 'field operator should be denied');
  exception
    when others then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected field_operator retry RPC to be denied';
  end if;

  v_caught := false;
  begin
    perform public.descartes_quarantine_delivery(v_nonretry_delivery_id, 'field operator should be denied');
  exception
    when others then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected field_operator quarantine RPC to be denied';
  end if;

  select count(*) into v_visible_rows
  from public.descartes_sync_delivery;

  if v_visible_rows <> 0 then
    raise exception 'Expected field_operator table reads to be denied by RLS, got % visible rows', v_visible_rows;
  end if;

  select count(*) into v_visible_rows
  from public.v_descartes_sync_dashboard;

  if v_visible_rows <> 0 then
    raise exception 'Expected field_operator dashboard view reads to be denied by RLS, got % visible rows', v_visible_rows;
  end if;

  select count(*) into v_visible_rows
  from public.v_descartes_failed_work;

  if v_visible_rows <> 0 then
    raise exception 'Expected field_operator failed-work view reads to be denied by RLS, got % visible rows', v_visible_rows;
  end if;

  select count(*) into v_visible_rows
  from public.v_descartes_reconciliation_drift;

  if v_visible_rows <> 0 then
    raise exception 'Expected field_operator drift view reads to be denied by RLS, got % visible rows', v_visible_rows;
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.tenant', v_tenant_key, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'branch_manager',
        'tenant', v_tenant_key
      )
    )::text,
    true
  );

  select sync_status, retry_count
  into v_retry_status, v_retry_count
  from public.descartes_retry_delivery(v_retry_delivery_id, 'retry after timeout');

  if v_retry_status <> 'replay_queued' then
    raise exception 'Expected retry to queue replay, got %', v_retry_status;
  end if;

  if v_retry_count <> 1 then
    raise exception 'Expected retry_count increment to 1, got %', v_retry_count;
  end if;

  v_caught := false;
  begin
    perform public.descartes_retry_delivery(v_cross_tenant_delivery_id, 'cross tenant retry should fail');
  exception
    when others then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected branch_manager cross-tenant retry to fail';
  end if;

  v_caught := false;
  begin
    perform public.descartes_quarantine_delivery(v_cross_tenant_delivery_id, 'cross tenant quarantine should fail');
  exception
    when others then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected branch_manager cross-tenant quarantine to fail';
  end if;

  v_caught := false;
  begin
    perform public.descartes_retry_delivery(v_nonretry_delivery_id, 'should fail');
  exception
    when others then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Expected retry attempt on non-retryable row to fail';
  end if;

  select sync_status, quarantine_reason
  into v_quarantine_status, v_quarantine_reason
  from public.descartes_quarantine_delivery(v_nonretry_delivery_id, 'poison message');

  if v_quarantine_status <> 'quarantined' then
    raise exception 'Expected quarantine status, got %', v_quarantine_status;
  end if;

  if v_quarantine_reason <> 'poison message' then
    raise exception 'Expected quarantine reason to persist, got %', v_quarantine_reason;
  end if;

  select count(*) into v_visible_rows
  from public.descartes_sync_delivery;

  if v_visible_rows < 2 then
    raise exception 'Expected tenant-scoped authenticated reads to return own rows, got %', v_visible_rows;
  end if;

  select count(*) into v_other_tenant_visible
  from public.descartes_sync_delivery
  where tenant_id = v_other_tenant_id;

  if v_other_tenant_visible <> 0 then
    raise exception 'Expected tenant-scoped table reads to hide other-tenant rows, got %', v_other_tenant_visible;
  end if;

  select count(*) into v_other_tenant_visible
  from public.v_descartes_sync_dashboard
  where tenant_id = v_other_tenant_id;

  if v_other_tenant_visible <> 0 then
    raise exception 'Expected dashboard view to hide other-tenant rows, got %', v_other_tenant_visible;
  end if;

  select count(*) into v_other_tenant_visible
  from public.v_descartes_failed_work
  where tenant_id = v_other_tenant_id;

  if v_other_tenant_visible <> 0 then
    raise exception 'Expected failed-work view to hide other-tenant rows, got %', v_other_tenant_visible;
  end if;

  select count(*) into v_other_tenant_visible
  from public.v_descartes_reconciliation_drift
  where tenant_id = v_other_tenant_id;

  if v_other_tenant_visible <> 0 then
    raise exception 'Expected drift view to hide other-tenant rows, got %', v_other_tenant_visible;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'app_metadata', jsonb_build_object(
        'role', 'admin',
        'tenant', v_tenant_key
      )
    )::text,
    true
  );

  select count(*) into v_visible_rows
  from public.descartes_sync_delivery;

  if v_visible_rows < 2 then
    raise exception 'Expected admin tenant-scoped reads to return own rows, got %', v_visible_rows;
  end if;

  select count(*) into v_other_tenant_visible
  from public.descartes_sync_delivery
  where tenant_id = v_other_tenant_id;

  if v_other_tenant_visible <> 0 then
    raise exception 'Expected admin tenant-scoped reads to hide other-tenant rows, got %', v_other_tenant_visible;
  end if;

  select count(*) into v_drift_count
  from public.v_descartes_reconciliation_drift
  where tenant_id = v_tenant_id
    and drift_detected
    and scope in ('route', 'shipment', 'compliance');

  if v_drift_count <> 3 then
    raise exception 'Expected route/shipment/compliance drift diagnostics (3 rows), got %', v_drift_count;
  end if;

  raise notice 'PASS descartes sync observability/recovery/reconciliation controls';
end;
$$;

rollback;
