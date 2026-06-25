-- ---------------------------------------------------------------------------
-- staff_save_quote_order
--
-- Creates or updates a rental_order entity (status = 'draft') together with
-- its rental_order_line children so that the full quote builder flow persists
-- to the canonical rental-order/line model rather than the fee-engine
-- staff_quote_drafts snapshot table.
--
-- Parameters
--   p_order_id           uuid        null = create new order; non-null = update
--   p_customer_id        text        customer entity / CRM ID (optional)
--   p_billing_account_id text        billing account entity ID (optional)
--   p_job_site_id        text        job-site entity ID (optional)
--   p_expiration_date    date        date after which the quote expires
--   p_display_rate_mode  text        'rate' (default) or 'price' — UI display hint
--   p_internal_notes     text        staff-only notes (not shown to customer)
--   p_external_notes     text        customer-facing notes included in quote doc
--   p_lines              jsonb       array of line objects — see shape below
--   p_cancel_line_ids    jsonb       array of text UUIDs of lines to soft-cancel
--
-- p_lines element shape:
--   {
--     "line_id":     "<uuid|null>",   entity ID when updating an existing line
--     "category_id": "<uuid>",
--     "asset_id":    "<uuid|null>",
--     "branch_id":   "<uuid|null>",
--     "start_date":  "<YYYY-MM-DD>",
--     "end_date":    "<YYYY-MM-DD>",
--     "quantity":    <int>,
--     "daily_rate":  <numeric>,
--     "rate_type":   "<daily|weekly|monthly>",
--     "name":        "<string|null>"
--   }
--
-- Returns (single row)
--   order_id     uuid   — entity ID of the rental_order
--   order_number text   — e.g. 'Q-20260611-a1b2c3d4'
--   saved_lines  jsonb  — array of { line_id, category_id } for the saved lines
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
  v_app_role     text;
  v_user_id      uuid;
  v_order_id     uuid;
  v_order_number text;
  v_line         jsonb;
  v_line_id      uuid;
  v_cancel_id    text;
  v_cancel_data  jsonb;
  v_saved_lines  jsonb := '[]'::jsonb;
begin
  -- ── Role guard ─────────────────────────────────────────────────────────────
  v_app_role := public.ops_claim_app_role();
  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'staff_save_quote_order: access denied'
      using errcode = '42501';
  end if;

  v_user_id := (
    coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub'
  )::uuid;

  -- ── Order number ────────────────────────────────────────────────────────────
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

  -- ── Upsert rental_order ─────────────────────────────────────────────────────
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

  -- ── Soft-cancel removed lines ───────────────────────────────────────────────
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
      null; -- best-effort; do not abort the whole save for a stale cancel ID
    end;
  end loop;

  -- ── Upsert active lines ─────────────────────────────────────────────────────
  for v_line in
    select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_line_id := nullif(v_line->>'line_id', '')::uuid;

    select upserted.entity_id
      into v_line_id
    from rental_upsert_entity_current_state(
      p_entity_type => 'rental_order_line',
      p_entity_id   => v_line_id,
      p_data        => jsonb_build_object(
        'order_id',      v_order_id,
        'status',        'draft',
        'category_id',   nullif(v_line->>'category_id', ''),
        'asset_id',      nullif(v_line->>'asset_id', ''),
        'branch_id',     nullif(v_line->>'branch_id', ''),
        'planned_start', nullif(v_line->>'start_date', ''),
        'planned_end',   nullif(v_line->>'end_date', ''),
        'quantity',      coalesce((nullif(v_line->>'quantity', ''))::int, 1),
        'rate_type',     coalesce(nullif(v_line->>'rate_type', ''), 'daily'),
        'daily_rate',    (nullif(v_line->>'daily_rate', ''))::numeric,
        'name',          nullif(v_line->>'name', '')
      )
    ) as upserted;

    v_saved_lines := v_saved_lines || jsonb_build_array(
      jsonb_build_object(
        'line_id',     v_line_id,
        'category_id', nullif(v_line->>'category_id', '')
      )
    );
  end loop;

  order_id     := v_order_id;
  order_number := v_order_number;
  saved_lines  := v_saved_lines;
  return next;
end;
$$;

-- ── Permissions ───────────────────────────────────────────────────────────────
revoke execute on function public.staff_save_quote_order(
  uuid, text, text, text, date, text, text, text, jsonb, jsonb
) from public, anon;

grant execute on function public.staff_save_quote_order(
  uuid, text, text, text, date, text, text, text, jsonb, jsonb
) to authenticated;
