-- Live Yard View inline actions with authoritative write-path guards.
-- Closes #1281.
--
-- Adds a single RPC for explicit review / maintenance transitions that:
--   1. validates the board row is still current before writing
--   2. writes through canonical entity/relationship RPCs
--   3. preserves audit details inside the new entity versions

create or replace function public.rental_apply_live_yard_action(
  p_source_entity_type text,
  p_source_entity_id uuid,
  p_action text,
  p_expected_lane_key text,
  p_expected_activity_status text
)
returns table (
  action_applied text,
  asset_id uuid,
  maintenance_record_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_original_claim_role_setting text := current_setting('request.jwt.claim.role', true);
  v_original_claims_setting text := current_setting('request.jwt.claims', true);
  v_original_claim_role_was_set boolean := v_original_claim_role_setting is not null;
  v_original_claims_was_set boolean := v_original_claims_setting is not null;
  v_request_role text;
  v_request_claims jsonb;
  v_app_role public.app_role;
  v_request_sub text;
  v_actor_id uuid;
  v_now timestamptz := clock_timestamp();
  v_board_row public.v_live_yard_activity_current%rowtype;
  v_asset_data jsonb;
  v_asset_status text;
  v_maintenance_data jsonb;
  v_maintenance_status text;
  v_next_asset_data jsonb;
  v_next_maintenance_data jsonb;
  v_created_maintenance_id uuid;
  v_created_maintenance_version_id uuid;
  v_created_maintenance_version int;
  v_audit jsonb;
begin
  v_request_claims := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    v_request_claims ->> 'role',
    ''
  );
  v_app_role := public.get_my_role();
  v_request_sub := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    v_request_claims ->> 'sub',
    ''
  );

  if v_request_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_actor_id := v_request_sub::uuid;
  end if;

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and v_app_role in ('admin', 'branch_manager', 'field_operator')
    )
  ) then
    raise exception 'rental_apply_live_yard_action requires an authenticated operator or manager'
      using errcode = '42501';
  end if;

  if p_source_entity_type not in ('asset', 'maintenance_record') then
    raise exception 'Unsupported live yard source entity type: %', p_source_entity_type
      using errcode = '22023';
  end if;

  select *
    into v_board_row
  from public.v_live_yard_activity_current
  where source_entity_type = p_source_entity_type
    and source_entity_id = p_source_entity_id
    and lane_key = coalesce(nullif(p_expected_lane_key, ''), lane_key)
    and activity_status = lower(coalesce(nullif(p_expected_activity_status, ''), activity_status));

  if not found then
    raise exception 'Live yard item is stale or already changed. Refresh the board and try again.'
      using errcode = 'P0001';
  end if;

  select ev.data
    into v_asset_data
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.id = coalesce(v_board_row.asset_id, p_source_entity_id)
    and e.entity_type = 'asset';

  if v_asset_data is null then
    raise exception 'Live yard action could not load the linked asset state.'
      using errcode = 'P0001';
  end if;

  v_asset_status := lower(
    coalesce(
      nullif(v_asset_data ->> 'operational_status', ''),
      nullif(v_asset_data ->> 'status', ''),
      'available'
    )
  );

  v_audit := jsonb_strip_nulls(jsonb_build_object(
    'action', lower(p_action),
    'at', v_now,
    'by', v_actor_id,
    'source', 'dispatch_yard',
    'source_entity_type', p_source_entity_type,
    'source_entity_id', p_source_entity_id,
    'expected_lane_key', p_expected_lane_key,
    'expected_activity_status', p_expected_activity_status
  ));

  case lower(p_action)
    when 'mark_available' then
      if v_board_row.lane_key <> 'needs_review'
        or p_source_entity_type <> 'asset'
        or v_asset_status not in ('inspection_hold', 'on_inspection_hold')
      then
        raise exception 'mark_available is only valid for current Needs Review inspection-hold assets.'
          using errcode = '22023';
      end if;

      v_next_asset_data := v_asset_data || jsonb_strip_nulls(jsonb_build_object(
        'operational_status', 'available',
        'status', 'available',
        'review_resolved_at', v_now,
        'review_resolved_by', v_actor_id,
        'live_yard_last_action', v_audit
      ));

      begin
        perform set_config('request.jwt.claim.role', 'service_role', true);
        perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

        perform public.rental_upsert_entity_current_state(
          p_entity_type => 'asset',
          p_entity_id => coalesce(v_board_row.asset_id, p_source_entity_id),
          p_data => v_next_asset_data
        );
      exception
        when others then
          if v_original_claim_role_was_set then
            perform set_config('request.jwt.claim.role', v_original_claim_role_setting, true);
          else
            execute 'reset request.jwt.claim.role';
          end if;

          if v_original_claims_was_set then
            perform set_config('request.jwt.claims', v_original_claims_setting, true);
          else
            execute 'reset request.jwt.claims';
          end if;
          raise;
      end;

      if v_original_claim_role_was_set then
        perform set_config('request.jwt.claim.role', v_original_claim_role_setting, true);
      else
        execute 'reset request.jwt.claim.role';
      end if;

      if v_original_claims_was_set then
        perform set_config('request.jwt.claims', v_original_claims_setting, true);
      else
        execute 'reset request.jwt.claims';
      end if;

      action_applied := 'mark_available';
      asset_id := coalesce(v_board_row.asset_id, p_source_entity_id);
      maintenance_record_id := null;
      return next;

    when 'open_maintenance' then
      if v_board_row.lane_key <> 'needs_review'
        or p_source_entity_type <> 'asset'
        or v_asset_status not in ('inspection_hold', 'on_inspection_hold')
      then
        raise exception 'open_maintenance is only valid for current Needs Review inspection-hold assets.'
          using errcode = '22023';
      end if;

      begin
        perform set_config('request.jwt.claim.role', 'service_role', true);
        perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

        select created.entity_id, created.entity_version_id, created.version_number
          into v_created_maintenance_id, v_created_maintenance_version_id, v_created_maintenance_version
        from public.create_entity_with_version(
          p_entity_type => 'maintenance_record',
          p_source_record_id => null,
          p_data => jsonb_strip_nulls(jsonb_build_object(
            'tenant', coalesce(nullif(v_asset_data ->> 'tenant', ''), 'default'),
            'status', 'open',
            'maintenance_type', 'corrective',
            'availability_impact', 'hard_down',
            'opened_at', v_now,
            'opened_by', v_actor_id,
            'asset_id', coalesce(v_board_row.asset_id, p_source_entity_id),
            'opened_from_lane', v_board_row.lane_key,
            'live_yard_last_action', v_audit
          ))
        ) as created;

        perform public.rental_upsert_relationship(
          p_relationship_type => 'asset_has_maintenance_record',
          p_parent_id => coalesce(v_board_row.asset_id, p_source_entity_id),
          p_child_id => v_created_maintenance_id,
          p_metadata => jsonb_build_object(
            'opened_via', 'dispatch_yard',
            'live_yard_action', lower(p_action)
          ),
          p_valid_from => v_now
        );

        v_next_asset_data := v_asset_data || jsonb_strip_nulls(jsonb_build_object(
          'operational_status', 'in_maintenance',
          'status', 'in_maintenance',
          'maintenance_opened_at', v_now,
          'maintenance_opened_by', v_actor_id,
          'live_yard_last_action', v_audit
        ));

        perform public.rental_upsert_entity_current_state(
          p_entity_type => 'asset',
          p_entity_id => coalesce(v_board_row.asset_id, p_source_entity_id),
          p_data => v_next_asset_data
        );
      exception
        when others then
          if v_original_claim_role_was_set then
            perform set_config('request.jwt.claim.role', v_original_claim_role_setting, true);
          else
            execute 'reset request.jwt.claim.role';
          end if;

          if v_original_claims_was_set then
            perform set_config('request.jwt.claims', v_original_claims_setting, true);
          else
            execute 'reset request.jwt.claims';
          end if;
          raise;
      end;

      if v_original_claim_role_was_set then
        perform set_config('request.jwt.claim.role', v_original_claim_role_setting, true);
      else
        execute 'reset request.jwt.claim.role';
      end if;

      if v_original_claims_was_set then
        perform set_config('request.jwt.claims', v_original_claims_setting, true);
      else
        execute 'reset request.jwt.claims';
      end if;

      action_applied := 'open_maintenance';
      asset_id := coalesce(v_board_row.asset_id, p_source_entity_id);
      maintenance_record_id := v_created_maintenance_id;
      return next;

    when 'complete_maintenance' then
      if v_board_row.lane_key <> 'maintenance' or p_source_entity_type <> 'maintenance_record' then
        raise exception 'complete_maintenance is only valid for current Maintenance work orders.'
          using errcode = '22023';
      end if;

      select ev.data
        into v_maintenance_data
      from public.entities e
      join public.entity_versions ev
        on ev.entity_id = e.id
       and ev.is_current
      where e.id = p_source_entity_id
        and e.entity_type = 'maintenance_record';

      if v_maintenance_data is null then
        raise exception 'Live yard action could not load the maintenance record state.'
          using errcode = 'P0001';
      end if;

      v_maintenance_status := lower(coalesce(nullif(v_maintenance_data ->> 'status', ''), 'open'));
      if v_maintenance_status in ('completed', 'closed', 'cancelled') then
        raise exception 'Maintenance work order is already %.', v_maintenance_status
          using errcode = '22023';
      end if;

      v_next_maintenance_data := v_maintenance_data || jsonb_strip_nulls(jsonb_build_object(
        'status', 'completed',
        'completed_at', v_now,
        'completed_by', v_actor_id,
        'live_yard_last_action', v_audit
      ));

      begin
        perform set_config('request.jwt.claim.role', 'service_role', true);
        perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

        perform public.rental_upsert_entity_current_state(
          p_entity_type => 'maintenance_record',
          p_entity_id => p_source_entity_id,
          p_data => v_next_maintenance_data
        );

        v_next_asset_data := v_asset_data || jsonb_strip_nulls(jsonb_build_object(
          'operational_status', 'available',
          'status', 'available',
          'maintenance_completed_at', v_now,
          'maintenance_completed_by', v_actor_id,
          'live_yard_last_action', v_audit
        ));

        perform public.rental_upsert_entity_current_state(
          p_entity_type => 'asset',
          p_entity_id => coalesce(v_board_row.asset_id, p_source_entity_id),
          p_data => v_next_asset_data
        );
      exception
        when others then
          if v_original_claim_role_was_set then
            perform set_config('request.jwt.claim.role', v_original_claim_role_setting, true);
          else
            execute 'reset request.jwt.claim.role';
          end if;

          if v_original_claims_was_set then
            perform set_config('request.jwt.claims', v_original_claims_setting, true);
          else
            execute 'reset request.jwt.claims';
          end if;
          raise;
      end;

      if v_original_claim_role_was_set then
        perform set_config('request.jwt.claim.role', v_original_claim_role_setting, true);
      else
        execute 'reset request.jwt.claim.role';
      end if;

      if v_original_claims_was_set then
        perform set_config('request.jwt.claims', v_original_claims_setting, true);
      else
        execute 'reset request.jwt.claims';
      end if;

      action_applied := 'complete_maintenance';
      asset_id := coalesce(v_board_row.asset_id, p_source_entity_id);
      maintenance_record_id := p_source_entity_id;
      return next;

    else
      raise exception 'Unsupported live yard action: %', p_action
        using errcode = '22023';
  end case;
end;
$$;

revoke execute on function public.rental_apply_live_yard_action(text, uuid, text, text, text) from public, anon;
grant execute on function public.rental_apply_live_yard_action(text, uuid, text, text, text) to authenticated, service_role;
