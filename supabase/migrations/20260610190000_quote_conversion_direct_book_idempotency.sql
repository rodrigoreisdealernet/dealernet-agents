create or replace function rental_convert_quote_to_reservation(
  p_order_id uuid
)
returns table (
  success boolean,
  reservation_id uuid,
  conflicts jsonb,
  message text
)
language plpgsql
as $$
declare
  v_order_data jsonb;
  v_order_status text;
  v_order_number text;
  v_contract_id uuid;
  v_contract_number text;
  v_conflicts jsonb;
  v_line record;
  v_conversion_actor text;
  v_converted_at timestamptz;
  v_existing_reservation_id uuid;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      format('rental_convert_quote_to_reservation:%s', p_order_id::text),
      0
    )
  );

  v_converted_at := now();
  v_conversion_actor := coalesce(
    nullif(
      (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'sub',
      ''
    ),
    auth.uid()::text,
    'service_role'
  );

  select
    rental_order.data,
    rental_order.status,
    coalesce(rental_order.order_number, format('RO-%s', left(rental_order.entity_id::text, 8)))
    into v_order_data, v_order_status, v_order_number
  from v_rental_order_current rental_order
  where rental_order.entity_id = p_order_id;

  if not found then
    raise exception 'Unknown rental order: %', p_order_id
      using errcode = '22023';
  end if;

  v_existing_reservation_id := nullif(v_order_data->>'reservation_contract_id', '')::uuid;

  if v_order_status = 'converted' and v_existing_reservation_id is not null then
    success := true;
    reservation_id := v_existing_reservation_id;
    conflicts := '[]'::jsonb;
    message := format(
      'Order %s already converted to reservation contract %s.',
      v_order_number,
      coalesce(v_order_data->>'reservation_contract_number', left(v_existing_reservation_id::text, 8))
    );
    return next;
    return;
  end if;

  if v_order_status not in ('draft', 'quoted', 'approved') then
    success := false;
    reservation_id := null;
    conflicts := jsonb_build_array(
      jsonb_build_object(
        'order_id', p_order_id,
        'reason', 'order_not_ready_for_conversion',
        'status', v_order_status
      )
    );
    message := 'Order must be draft, quoted, or approved before conversion.';
    return next;
    return;
  end if;

  for v_line in
    select
      nullif(rental_order.data->>'branch_id', '')::uuid as branch_id,
      nullif(order_line.category_id, '')::uuid as asset_category_id,
      order_line.planned_start,
      order_line.planned_end
    from v_rental_order_line_current order_line
    join v_rental_order_current rental_order
      on rental_order.entity_id::text = order_line.order_id
    where rental_order.entity_id = p_order_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(
        jsonb_build_object(
          'branch_id', v_line.branch_id,
          'asset_category_id', v_line.asset_category_id,
          'planned_start', v_line.planned_start,
          'planned_end', v_line.planned_end
        )::text,
        0
      )
    );
  end loop;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'line_entity_id', availability.line_entity_id,
        'order_id', availability.order_id,
        'branch_id', availability.branch_id,
        'asset_category_id', availability.asset_category_id,
        'requested_quantity', availability.requested_quantity,
        'available_quantity', availability.available_quantity,
        'shortage_quantity', availability.shortage_quantity,
        'shortage_reason', availability.shortage_reason,
        'alternatives', availability.alternatives
      )
    ),
    '[]'::jsonb
  )
    into v_conflicts
  from rental_quote_line_availability_current availability
  where availability.order_id = p_order_id
    and availability.is_available = false;

  if jsonb_array_length(v_conflicts) > 0 then
    success := false;
    reservation_id := null;
    conflicts := v_conflicts;
    message := 'Reservation conversion blocked due to availability conflicts.';
    return next;
    return;
  end if;

  v_contract_number := format(
    'RC-%s-%s',
    to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
    substr(gen_random_uuid()::text, 1, 8)
  );

  select upserted.entity_id
    into v_contract_id
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_contract',
    p_data => jsonb_build_object(
      'name', format('Reservation Contract %s', v_contract_number),
      'contract_number', v_contract_number,
      'order_id', p_order_id,
      'originating_quote_order_id', p_order_id,
      'status', 'pending_execution',
      'rental_type', coalesce(v_order_data->>'rental_type', 'external'),
      'customer_id', v_order_data->>'customer_id',
      'billing_account_id', v_order_data->>'billing_account_id',
      'job_site_id', v_order_data->>'job_site_id',
      'quote_snapshot', v_order_data,
      'converted_at', v_converted_at,
      'converted_by_actor', v_conversion_actor
    ),
    p_entity_id => v_existing_reservation_id,
    p_source_record_id => format('reservation:%s', p_order_id)
  ) as upserted;

  for v_line in
    select
      order_line.entity_id,
      order_line.category_id,
      order_line.quantity,
      order_line.planned_start,
      order_line.planned_end,
      order_line.job_site_id,
      order_line.rate_type,
      order_line.data
    from v_rental_order_line_current order_line
    where order_line.order_id = p_order_id::text
      and order_line.status <> 'cancelled'
  loop
    perform create_entity_with_version(
      p_entity_type => 'rental_contract_line',
      p_data => jsonb_build_object(
        'contract_id', v_contract_id,
        'order_id', p_order_id,
        'order_line_id', v_line.entity_id,
        'category_id', v_line.category_id,
        'quantity', v_line.quantity,
        'status', 'pending',
        'rental_type', coalesce(v_order_data->>'rental_type', 'external'),
        'rate_type', coalesce(v_line.rate_type, 'daily'),
        'planned_start', v_line.planned_start,
        'planned_end', v_line.planned_end,
        'job_site_id', coalesce(v_line.job_site_id, v_order_data->>'job_site_id'),
        'quote_line_snapshot', coalesce(v_line.data, '{}'::jsonb),
        'converted_at', v_converted_at
      ),
      p_source_record_id => format('%s:%s', p_order_id, v_line.entity_id)
    );
  end loop;

  perform rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_entity_id => p_order_id,
    p_data => v_order_data || jsonb_build_object(
      'status', 'converted',
      'conversion_source_order_id', p_order_id,
      'conversion_actor_id', v_conversion_actor,
      'quote_snapshot', v_order_data,
      'converted_at', v_converted_at,
      'reservation_contract_id', v_contract_id,
      'reservation_contract_number', v_contract_number
    )
  );

  success := true;
  reservation_id := v_contract_id;
  conflicts := '[]'::jsonb;
  message := format('Converted order %s to reservation contract %s.', v_order_number, v_contract_number);
  return next;
end;
$$;

alter function rental_convert_quote_to_reservation(uuid) owner to postgres;

revoke execute on function public.rental_convert_quote_to_reservation(uuid) from public, anon;
grant execute on function public.rental_convert_quote_to_reservation(uuid) to authenticated, service_role;
