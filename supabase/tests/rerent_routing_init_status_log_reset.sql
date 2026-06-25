begin;

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"service_role","app_metadata":{"role":"admin","tenant":"alpha"}}',
  true
);
set local role service_role;

do $$
declare
  v_branch uuid;
  v_order uuid;
  v_line uuid;
  v_requested_count int;
  v_total_count int;
begin
  select entity_id
    into v_branch
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'branch',
    p_source_record_id => 'rerent-init-status-branch-001',
    p_data => jsonb_build_object(
      'name', 'Rerent Init Branch',
      'branch_code', 'RERENT-INIT',
      'tenant', 'alpha'
    )
  );

  select entity_id
    into v_order
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_source_record_id => 'rerent-init-status-order-001',
    p_data => jsonb_build_object(
      'status', 'draft',
      'order_number', 'RO-RERENT-INIT-001',
      'rental_type', 'external',
      'branch_id', v_branch,
      'tenant', 'alpha'
    )
  );

  select entity_id
    into v_line
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'rerent-init-status-line-001',
    p_data => jsonb_build_object(
      'order_id', v_order,
      'status', 'pending',
      'fulfillment_source', 'external_rerent',
      'tenant', 'alpha'
    )
  );

  select count(*)
    into v_requested_count
  from public.rerent_unit_status_log
  where order_line_id = v_line
    and status_key = 'requested';

  if v_requested_count <> 1 then
    raise exception
      'Expected first external_rerent save to seed exactly one requested row, found %',
      v_requested_count;
  end if;

  perform public.rental_upsert_entity_current_state(
    p_entity_type => 'rental_order_line',
    p_source_record_id => 'rerent-init-status-line-001',
    p_data => jsonb_build_object(
      'order_id', v_order,
      'status', 'pending',
      'fulfillment_source', 'external_rerent',
      'override_reason', 'preferred-vendor confirmed',
      'tenant', 'alpha'
    )
  );

  select count(*)
    into v_total_count
  from public.rerent_unit_status_log
  where order_line_id = v_line;

  if v_total_count <> 1 then
    raise exception
      'Expected rerent status log to remain single-row after update, found %',
      v_total_count;
  end if;
end;
$$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","app_metadata":{"role":"admin","tenant":"alpha"}}',
  true
);

do $$
declare
  v_line uuid;
  v_status_key text;
begin
  select id
    into v_line
  from public.entities
  where entity_type = 'rental_order_line'
    and source_record_id = 'rerent-init-status-line-001';

  select status_key
    into v_status_key
  from public.v_rerent_unit_current_status
  where order_line_id = v_line;

  if v_status_key <> 'requested' then
    raise exception
      'Expected v_rerent_unit_current_status to surface requested status, got %',
      coalesce(v_status_key, '<null>');
  end if;
end;
$$;

rollback;
