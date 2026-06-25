-- ---------------------------------------------------------------------------
-- Migration: 20260613002500_save_quote_order_rate_and_kit_snapshot.sql
--
-- Purpose: Merge rate-plan snapshot handling (from 20260613001000) with kit
-- component snapshot handling (from 20260613002000) into a single authoritative
-- staff_save_quote_order definition.  Both upstream migrations define the
-- function with only one of the two capabilities; this migration runs after
-- both and replaces the function body so that a full reset yields a version
-- that persists resolved_rate_snapshot AND kit_component_snapshot on every
-- rental_order_line.
-- ---------------------------------------------------------------------------

create or replace function public.staff_save_quote_order(
  p_order_id           uuid    default null,
  p_customer_id        text    default null,
  p_billing_account_id text    default null,
  p_job_site_id        text    default null,
  p_expiration_date    date    default null,
  p_display_rate_mode  text    default 'rate',
  p_internal_notes     text    default null,
  p_external_notes     text    default null,
  p_lines              jsonb   default '[]'::jsonb,
  p_cancel_line_ids    jsonb   default '[]'::jsonb
)
returns table (
  order_id     uuid,
  order_number text,
  saved_lines  jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role               text;
  v_user_id                uuid;
  v_order_id               uuid;
  v_order_number           text;
  v_line                   jsonb;
  v_line_id                uuid;
  v_cancel_id              text;
  v_cancel_data            jsonb;
  v_saved_lines            jsonb := '[]'::jsonb;
  v_kit_id                 uuid;
  v_kit_component_snapshot jsonb;
  v_input_daily_rate       numeric;
  v_input_rate_type        text;
  v_line_start             date;
  v_line_end               date;
  v_line_qty               int;
  v_final_daily_rate       numeric;
  v_final_rate_type        text;
  v_resolved_snapshot      jsonb;
  v_resolved_plan_id       uuid;
  v_resolution_source      text;
  v_resolved_base_amount   numeric;
begin
  v_app_role := public.ops_claim_app_role();
  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'staff_save_quote_order: access denied'
      using errcode = '42501';
  end if;

  v_user_id := (
    coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub'
  )::uuid;

  if p_order_id is not null then
    select ev.data->>'order_number'
      into v_order_number
    from entities e
    join entity_versions ev
      on ev.entity_id = e.id
     and ev.is_current
    where e.id = p_order_id
      and e.entity_type = 'rental_order';

    if not found then
      raise exception 'staff_save_quote_order: order % not found', p_order_id
        using errcode = '22023';
    end if;
  end if;

  if v_order_number is null then
    v_order_number := format(
      'Q-%s-%s',
      to_char(clock_timestamp(), 'YYYYMMDD'),
      left(gen_random_uuid()::text, 8)
    );
  end if;

  select upserted.entity_id
    into v_order_id
  from rental_upsert_entity_current_state(
    p_entity_type => 'rental_order',
    p_entity_id   => p_order_id,
    p_data        => jsonb_build_object(
      'status',              'draft',
      'order_number',        v_order_number,
      'rental_type',         'external',
      'customer_id',         nullif(p_customer_id, ''),
      'billing_account_id',  nullif(p_billing_account_id, ''),
      'job_site_id',         nullif(p_job_site_id, ''),
      'expiration_date',     p_expiration_date,
      'display_rate_mode',   coalesce(nullif(p_display_rate_mode, ''), 'rate'),
      'internal_notes',      nullif(p_internal_notes, ''),
      'external_notes',      nullif(p_external_notes, ''),
      'created_by',          v_user_id
    )
  ) as upserted;

  for v_cancel_id in
    select jsonb_array_elements_text(coalesce(p_cancel_line_ids, '[]'::jsonb))
  loop
    begin
      select ev.data
        into v_cancel_data
      from entities e
      join entity_versions ev
        on ev.entity_id = e.id
       and ev.is_current
      where e.id = v_cancel_id::uuid
        and e.entity_type = 'rental_order_line';

      if found and v_cancel_data is not null then
        perform rental_upsert_entity_current_state(
          p_entity_type => 'rental_order_line',
          p_entity_id   => v_cancel_id::uuid,
          p_data        => v_cancel_data || jsonb_build_object('status', 'cancelled')
        );
      end if;
    exception when others then
      null;
    end;
  end loop;

  for v_line in
    select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_line_id := nullif(v_line->>'line_id', '')::uuid;
    v_kit_id := nullif(v_line->>'kit_id', '')::uuid;
    v_kit_component_snapshot := '[]'::jsonb;
    v_input_daily_rate := (nullif(v_line->>'daily_rate', ''))::numeric;
    v_input_rate_type := coalesce(nullif(v_line->>'rate_type', ''), 'daily');
    v_line_start := (nullif(v_line->>'start_date', ''))::date;
    v_line_end := (nullif(v_line->>'end_date', ''))::date;
    v_line_qty := coalesce((nullif(v_line->>'quantity', ''))::int, 1);

    v_final_daily_rate := null;
    v_final_rate_type := v_input_rate_type;
    v_resolved_snapshot := null;
    v_resolved_plan_id := null;
    v_resolution_source := 'manual';
    v_resolved_base_amount := null;

    if v_kit_id is not null then
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'relationship_id', components.relationship_id,
            'component_id', components.component_id,
            'component_type', components.component_entity_type,
            'component_name', components.component_label,
            'quantity', components.quantity,
            'is_required', components.is_required,
            'is_default', components.is_default,
            'effective_from', components.effective_from,
            'effective_to', components.effective_to
          )
        ),
        '[]'::jsonb
      )
      into v_kit_component_snapshot
      from rental_inventory_kit_components_current components
      where components.kit_id = v_kit_id
        and (
          components.effective_from is null
          or v_line_end is null
          or components.effective_from <= v_line_end
        )
        and (
          components.effective_to is null
          or v_line_start is null
          or components.effective_to >= v_line_start
        );
    end if;

    if v_input_daily_rate is not null and v_input_daily_rate > 0 then
      -- Explicit manual daily_rate is an operator override and intentionally
      -- bypasses weekend/special plan segmentation for this line.
      v_final_daily_rate := v_input_daily_rate;
      if v_line_start is not null and v_line_end is not null and v_line_end > v_line_start then
        v_resolved_base_amount := round(v_final_daily_rate * (v_line_end - v_line_start) * greatest(v_line_qty, 1), 2);
      end if;
      v_resolved_snapshot := jsonb_build_object(
        'resolution_source', 'manual_override',
        'resolved_rate_type', v_final_rate_type,
        'resolved_daily_rate', v_final_daily_rate,
        'base_amount', v_resolved_base_amount,
        'start_date', v_line_start,
        'end_date', v_line_end,
        'quantity', greatest(v_line_qty, 1)
      );
    elsif v_line_start is not null and v_line_end is not null and v_line_end > v_line_start then
      begin
        select
          rr.rate_plan_id,
          rr.resolved_rate_type,
          rr.resolved_daily_rate,
          rr.base_amount,
          rr.rate_breakdown
        into
          v_resolved_plan_id,
          v_final_rate_type,
          v_final_daily_rate,
          v_resolved_base_amount,
          v_resolved_snapshot
        from public.rental_resolve_rate_plan(
          p_asset_id           => nullif(v_line->>'asset_id', '')::uuid,
          p_category_id        => nullif(v_line->>'category_id', '')::uuid,
          p_kit_id             => v_kit_id,
          p_branch_id          => nullif(v_line->>'branch_id', '')::uuid,
          p_customer_id        => case
            when nullif(p_customer_id, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then nullif(p_customer_id, '')::uuid
            else null
          end,
          p_billing_account_id => case
            when nullif(p_billing_account_id, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then nullif(p_billing_account_id, '')::uuid
            else null
          end,
          p_start_date         => v_line_start,
          p_end_date           => v_line_end,
          p_quantity           => greatest(v_line_qty, 1)
        ) rr;

        v_resolution_source := 'rate_plan';
      exception
        when others then
          if v_input_daily_rate is null or v_input_daily_rate <= 0 then
            raise exception
              'staff_save_quote_order: line % has no manual daily_rate and rate-plan resolution failed (%). Provide daily_rate or configure matching rate plan.',
              coalesce(v_line->>'category_id', '<unknown>'),
              sqlerrm
              using errcode = '22023';
          end if;
      end;
    elsif v_input_daily_rate is null or v_input_daily_rate <= 0 then
      raise exception
        'staff_save_quote_order: line requires start_date/end_date to resolve pricing when daily_rate is not provided'
        using errcode = '22023';
    end if;

    select upserted.entity_id
      into v_line_id
    from rental_upsert_entity_current_state(
      p_entity_type => 'rental_order_line',
      p_entity_id   => v_line_id,
      p_data        => jsonb_build_object(
        'order_id',               v_order_id,
        'status',                 'draft',
        'kit_id',                 v_kit_id,
        'kit_component_snapshot', v_kit_component_snapshot,
        'category_id',            nullif(v_line->>'category_id', ''),
        'asset_id',               nullif(v_line->>'asset_id', ''),
        'branch_id',              nullif(v_line->>'branch_id', ''),
        'planned_start',          nullif(v_line->>'start_date', ''),
        'planned_end',            nullif(v_line->>'end_date', ''),
        'quantity',               greatest(v_line_qty, 1),
        'rate_type',              coalesce(nullif(v_final_rate_type, ''), 'daily'),
        'daily_rate',             v_final_daily_rate,
        'resolved_rate_plan_id',  v_resolved_plan_id,
        'rate_resolution_source', v_resolution_source,
        'resolved_rate_snapshot', coalesce(v_resolved_snapshot, '{}'::jsonb),
        'resolved_base_amount',   v_resolved_base_amount,
        'name',                   nullif(v_line->>'name', '')
      )
    ) as upserted;

    v_saved_lines := v_saved_lines || jsonb_build_array(
      jsonb_build_object(
        'line_id',     v_line_id,
        'category_id', nullif(v_line->>'category_id', ''),
        'kit_id',      v_kit_id
      )
    );
  end loop;

  order_id     := v_order_id;
  order_number := v_order_number;
  saved_lines  := v_saved_lines;
  return next;
end;
$$;

revoke execute on function public.staff_save_quote_order(
  uuid, text, text, text, date, text, text, text, jsonb, jsonb
) from public, anon;

grant execute on function public.staff_save_quote_order(
  uuid, text, text, text, date, text, text, text, jsonb, jsonb
) to authenticated;
