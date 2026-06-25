-- Verifies the MuleSoft connector migration can replay cleanly after the shared
-- connector foundation schema already exists with legacy integration_sync_state rows.

do $$
declare
  v_row record;
begin
  select connector_key, direction, cursor, cursor_value, state, metadata
    into v_row
    from public.integration_sync_state
   where scope_key = 'legacy-outbound';

  if not found then
    raise exception 'Expected migrated legacy-outbound sync row';
  end if;

  if v_row.connector_key <> 'mulesoft'
     or v_row.direction <> 'outbound'
     or v_row.cursor <> 'cursor-out'
     or v_row.cursor_value <> 'cursor-out'
     or v_row.state <> '{"legacy":"outbound"}'::jsonb
     or v_row.metadata <> '{"legacy":"outbound"}'::jsonb then
    raise exception 'Legacy outbound row backfill mismatch: %', row_to_json(v_row);
  end if;

  select connector_key, direction, cursor, cursor_value, state, metadata
    into v_row
    from public.integration_sync_state
   where scope_key = 'legacy-inbound';

  if not found then
    raise exception 'Expected migrated legacy-inbound sync row';
  end if;

  if v_row.connector_key <> 'mulesoft'
     or v_row.direction <> 'inbound'
     or v_row.cursor <> 'cursor-in'
     or v_row.cursor_value <> 'cursor-in'
     or v_row.state <> '{"legacy":"inbound"}'::jsonb
     or v_row.metadata <> '{"legacy":"inbound"}'::jsonb then
    raise exception 'Legacy inbound row backfill mismatch: %', row_to_json(v_row);
  end if;

  insert into public.integration_sync_state (
    integration_id,
    tenant_id,
    scope_key,
    cursor_value,
    source_of_truth,
    metadata
  ) values (
    '10000000-0000-0000-0000-000000000001'::uuid,
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'legacy-trigger-provider',
    'cursor-trigger',
    'provider',
    '{"legacy":"trigger"}'::jsonb
  )
  returning connector_key, direction, cursor, cursor_value, state, metadata
       into v_row;

  if v_row.connector_key <> 'mulesoft'
     or v_row.direction <> 'inbound'
     or v_row.cursor <> 'cursor-trigger'
     or v_row.cursor_value <> 'cursor-trigger'
     or v_row.state <> '{"legacy":"trigger"}'::jsonb
     or v_row.metadata <> '{"legacy":"trigger"}'::jsonb then
    raise exception 'Legacy-shape insert normalization mismatch: %', row_to_json(v_row);
  end if;

  raise notice 'PASS: MuleSoft connector replay-order compatibility rows backfilled cleanly';
end;
$$;
