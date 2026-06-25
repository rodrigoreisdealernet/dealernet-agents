-- Inventory rate structures: reusable rate plans + deterministic resolution
--
-- Adds effective-dated rate plans that support daily/weekly/monthly base rates
-- plus explicit weekend and special-rate overrides. Resolution is deterministic
-- and snapshots can be persisted on commercial records for historical stability.

-- ---------------------------------------------------------------------------
-- 1) Rate-plan catalog
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_rate_plans (
  id                   uuid        primary key default gen_random_uuid(),
  name                 text        not null,
  version_number       int         not null default 1
                       constraint inventory_rate_plans_version_pos check (version_number >= 1),
  supersedes_plan_id   uuid        references public.inventory_rate_plans(id) on delete set null,
  effective_from       date        not null,
  effective_to         date,
  daily_rate           numeric,
  weekly_rate          numeric,
  monthly_rate         numeric,
  weekend_rate         numeric,
  weekend_days         smallint[]  not null default '{0,6}'::smallint[],
  -- applicability / assignment targets
  asset_id             uuid,
  category_id          uuid,
  kit_id               uuid,
  branch_id            uuid,
  customer_id          uuid,
  billing_account_id   uuid,
  notes                text,
  is_active            boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint inventory_rate_plans_effective_window_chk
    check (effective_to is null or effective_to >= effective_from),
  constraint inventory_rate_plans_rate_presence_chk
    check (
      coalesce(daily_rate, 0) > 0
      or coalesce(weekly_rate, 0) > 0
      or coalesce(monthly_rate, 0) > 0
      or coalesce(weekend_rate, 0) > 0
    ),
  constraint inventory_rate_plans_rate_non_negative_chk
    check (
      coalesce(daily_rate, 0) >= 0
      and coalesce(weekly_rate, 0) >= 0
      and coalesce(monthly_rate, 0) >= 0
      and coalesce(weekend_rate, 0) >= 0
    ),
  constraint inventory_rate_plans_weekend_days_chk
    check (
      coalesce(array_length(weekend_days, 1), 0) >= 1
      and coalesce(array_length(weekend_days, 1), 0) <= 7
    )
);

create index if not exists idx_inventory_rate_plans_lookup
  on public.inventory_rate_plans (
    is_active,
    effective_from,
    effective_to,
    asset_id,
    category_id,
    kit_id,
    branch_id,
    customer_id,
    billing_account_id,
    version_number
  );

create trigger trg_inventory_rate_plans_updated_at
  before update on public.inventory_rate_plans
  for each row execute function update_updated_at();

alter table public.inventory_rate_plans enable row level security;

create policy inventory_rate_plans_staff_select
  on public.inventory_rate_plans for select
  to authenticated
  using (public.ops_claim_app_role() in ('admin', 'branch_manager'));

create policy inventory_rate_plans_admin_insert
  on public.inventory_rate_plans for insert
  to authenticated
  with check (public.ops_claim_app_role() = 'admin');

create policy inventory_rate_plans_admin_update
  on public.inventory_rate_plans for update
  to authenticated
  using (public.ops_claim_app_role() = 'admin');

grant select, insert, update on public.inventory_rate_plans to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Special-rate windows (deterministic priority)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_rate_plan_specials (
  id               uuid        primary key default gen_random_uuid(),
  rate_plan_id     uuid        not null references public.inventory_rate_plans(id) on delete cascade,
  name             text        not null,
  start_date       date        not null,
  end_date         date        not null,
  daily_rate       numeric     not null,
  priority         int         not null default 100,
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint inventory_rate_plan_specials_window_chk
    check (end_date >= start_date),
  constraint inventory_rate_plan_specials_rate_chk
    check (daily_rate > 0)
);

create index if not exists idx_inventory_rate_plan_specials_lookup
  on public.inventory_rate_plan_specials (rate_plan_id, is_active, start_date, end_date, priority);

create trigger trg_inventory_rate_plan_specials_updated_at
  before update on public.inventory_rate_plan_specials
  for each row execute function update_updated_at();

alter table public.inventory_rate_plan_specials enable row level security;

create policy inventory_rate_plan_specials_staff_select
  on public.inventory_rate_plan_specials for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and exists (
      select 1
      from public.inventory_rate_plans rp
      where rp.id = inventory_rate_plan_specials.rate_plan_id
    )
  );

create policy inventory_rate_plan_specials_admin_insert
  on public.inventory_rate_plan_specials for insert
  to authenticated
  with check (public.ops_claim_app_role() = 'admin');

create policy inventory_rate_plan_specials_admin_update
  on public.inventory_rate_plan_specials for update
  to authenticated
  using (public.ops_claim_app_role() = 'admin');

grant select, insert, update on public.inventory_rate_plan_specials to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Admin RPC: create / version a rate plan
-- ---------------------------------------------------------------------------
create or replace function public.inventory_create_rate_plan(
  p_name               text,
  p_effective_from     date,
  p_effective_to       date default null,
  p_daily_rate         numeric default null,
  p_weekly_rate        numeric default null,
  p_monthly_rate       numeric default null,
  p_weekend_rate       numeric default null,
  p_weekend_days       smallint[] default '{0,6}'::smallint[],
  p_asset_id           uuid default null,
  p_category_id        uuid default null,
  p_kit_id             uuid default null,
  p_branch_id          uuid default null,
  p_customer_id        uuid default null,
  p_billing_account_id uuid default null,
  p_notes              text default null,
  p_supersedes_plan_id uuid default null,
  p_specials           jsonb default '[]'::jsonb
)
returns table (
  rate_plan_id uuid,
  version_number int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role          text;
  v_version_number    int := 1;
  v_plan_id           uuid;
  v_special           jsonb;
begin
  v_app_role := public.ops_claim_app_role();
  if v_app_role <> 'admin' then
    raise exception 'inventory_create_rate_plan: access denied'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'p_name is required' using errcode = '22023';
  end if;

  if p_effective_from is null then
    raise exception 'p_effective_from is required' using errcode = '22023';
  end if;

  if p_supersedes_plan_id is not null then
    select coalesce(rp.version_number, 0) + 1
      into v_version_number
    from public.inventory_rate_plans rp
    where rp.id = p_supersedes_plan_id;

    if not found then
      raise exception 'Superseded plan % not found', p_supersedes_plan_id using errcode = '22023';
    end if;

    update public.inventory_rate_plans
       set effective_to = least(coalesce(effective_to, p_effective_from - 1), p_effective_from - 1)
     where id = p_supersedes_plan_id;
  end if;

  insert into public.inventory_rate_plans (
    name,
    version_number,
    supersedes_plan_id,
    effective_from,
    effective_to,
    daily_rate,
    weekly_rate,
    monthly_rate,
    weekend_rate,
    weekend_days,
    asset_id,
    category_id,
    kit_id,
    branch_id,
    customer_id,
    billing_account_id,
    notes
  )
  values (
    btrim(p_name),
    v_version_number,
    p_supersedes_plan_id,
    p_effective_from,
    p_effective_to,
    p_daily_rate,
    p_weekly_rate,
    p_monthly_rate,
    p_weekend_rate,
    coalesce(p_weekend_days, '{0,6}'::smallint[]),
    p_asset_id,
    p_category_id,
    p_kit_id,
    p_branch_id,
    p_customer_id,
    p_billing_account_id,
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_plan_id;

  for v_special in
    select * from jsonb_array_elements(coalesce(p_specials, '[]'::jsonb))
  loop
    insert into public.inventory_rate_plan_specials (
      rate_plan_id,
      name,
      start_date,
      end_date,
      daily_rate,
      priority,
      is_active
    ) values (
      v_plan_id,
      coalesce(nullif(v_special->>'name', ''), 'Special rate'),
      (v_special->>'start_date')::date,
      (v_special->>'end_date')::date,
      (v_special->>'daily_rate')::numeric,
      coalesce((v_special->>'priority')::int, 100),
      coalesce((v_special->>'is_active')::boolean, true)
    );
  end loop;

  rate_plan_id := v_plan_id;
  version_number := v_version_number;
  return next;
end;
$$;

revoke execute on function public.inventory_create_rate_plan(
  text, date, date, numeric, numeric, numeric, numeric, smallint[], uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, jsonb
) from public, anon;

grant execute on function public.inventory_create_rate_plan(
  text, date, date, numeric, numeric, numeric, numeric, smallint[], uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, jsonb
) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Resolver RPC: deterministic precedence + weekend/special segmentation
--
-- Precedence (highest to lowest):
--   asset override > category/kit plan > branch default > customer/account > global
-- Weekend behavior:
--   days where extract(dow) is in weekend_days use weekend_rate (if set)
--   unless a special window applies for that day (special > weekend).
-- Proration:
--   monthly_rate is normalized to a 30-day daily equivalent.
--   weekly_rate is normalized to a 7-day daily equivalent.
--   base rate selection follows rental length thresholds:
--     >= 28 days => monthly (if configured)
--     >= 7 days  => weekly  (if configured)
--     otherwise  => daily
-- ---------------------------------------------------------------------------
create or replace function public.rental_resolve_rate_plan(
  p_asset_id           uuid default null,
  p_category_id        uuid default null,
  p_kit_id             uuid default null,
  p_branch_id          uuid default null,
  p_customer_id        uuid default null,
  p_billing_account_id uuid default null,
  p_start_date         date default null,
  p_end_date           date default null,
  p_quantity           int default 1
)
returns table (
  rate_plan_id         uuid,
  rate_plan_name       text,
  plan_version         int,
  resolution_scope     text,
  resolved_rate_type   text,
  resolved_daily_rate  numeric,
  base_amount          numeric,
  rate_breakdown       jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role            text;
  v_billable_days       int;
  v_qty                 int;
  v_plan                record;
  v_base_rate_type      text;
  v_base_daily_rate     numeric;
  v_segments            jsonb := '[]'::jsonb;
  v_total_amount        numeric := 0;
  v_distinct_rate_types text[] := '{}'::text[];
begin
  v_app_role := public.ops_claim_app_role();
  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'rental_resolve_rate_plan: access denied' using errcode = '42501';
  end if;

  if p_start_date is null or p_end_date is null or p_end_date <= p_start_date then
    raise exception 'Invalid rental window: start_date/end_date are required and end_date must be after start_date'
      using errcode = '22023';
  end if;

  v_qty := greatest(coalesce(p_quantity, 1), 1);
  v_billable_days := (p_end_date - p_start_date);

  select
    rp.*,
    case
      when rp.asset_id is not null then 'asset'
      when rp.category_id is not null or rp.kit_id is not null then 'category_or_kit'
      when rp.branch_id is not null then 'branch'
      when rp.customer_id is not null or rp.billing_account_id is not null then 'customer_or_account'
      else 'global'
    end as scope_label,
    case
      when rp.asset_id is not null then 500
      when rp.category_id is not null or rp.kit_id is not null then 400
      when rp.branch_id is not null then 300
      when rp.customer_id is not null or rp.billing_account_id is not null then 200
      else 100
    end as scope_rank,
    (
      (case when rp.asset_id is not null then 1 else 0 end)
      + (case when rp.category_id is not null then 1 else 0 end)
      + (case when rp.kit_id is not null then 1 else 0 end)
      + (case when rp.branch_id is not null then 1 else 0 end)
      + (case when rp.customer_id is not null then 1 else 0 end)
      + (case when rp.billing_account_id is not null then 1 else 0 end)
    ) as specificity
  into v_plan
  from public.inventory_rate_plans rp
  where rp.is_active
    and p_start_date >= rp.effective_from
    and (rp.effective_to is null or p_start_date <= rp.effective_to)
    and (rp.asset_id is null or rp.asset_id = p_asset_id)
    and (rp.category_id is null or rp.category_id = p_category_id)
    and (rp.kit_id is null or rp.kit_id = p_kit_id)
    and (rp.branch_id is null or rp.branch_id = p_branch_id)
    and (rp.customer_id is null or rp.customer_id = p_customer_id)
    and (rp.billing_account_id is null or rp.billing_account_id = p_billing_account_id)
  order by
    scope_rank desc,
    specificity desc,
    rp.version_number desc,
    rp.effective_from desc,
    rp.created_at desc
  limit 1;

  if not found then
    raise exception 'No active rate plan matched the provided context and start date'
      using errcode = 'P0002';
  end if;

  if v_billable_days >= 28 and coalesce(v_plan.monthly_rate, 0) > 0 then
    v_base_rate_type := 'monthly';
    v_base_daily_rate := round(v_plan.monthly_rate / 30.0, 6);
  elsif v_billable_days >= 7 and coalesce(v_plan.weekly_rate, 0) > 0 then
    v_base_rate_type := 'weekly';
    v_base_daily_rate := round(v_plan.weekly_rate / 7.0, 6);
  elsif coalesce(v_plan.daily_rate, 0) > 0 then
    v_base_rate_type := 'daily';
    v_base_daily_rate := v_plan.daily_rate;
  elsif coalesce(v_plan.weekend_rate, 0) > 0 then
    v_base_rate_type := 'weekend';
    v_base_daily_rate := v_plan.weekend_rate;
  else
    raise exception 'Matched rate plan % has no usable base rate', v_plan.id using errcode = '22023';
  end if;

  with day_rates as (
    select
      d::date as day_date,
      coalesce(sp.daily_rate,
        case
          when extract(dow from d)::smallint = any(v_plan.weekend_days)
               and coalesce(v_plan.weekend_rate, 0) > 0
            then v_plan.weekend_rate
          else v_base_daily_rate
        end
      ) as day_rate,
      coalesce(sp.rate_type,
        case
          when extract(dow from d)::smallint = any(v_plan.weekend_days)
               and coalesce(v_plan.weekend_rate, 0) > 0
            then 'weekend'
          else v_base_rate_type
        end
      ) as rate_type
    from generate_series(p_start_date::timestamp, (p_end_date - 1)::timestamp, interval '1 day') g(d)
    left join lateral (
      select
        s.daily_rate,
        'special'::text as rate_type
      from public.inventory_rate_plan_specials s
      where s.rate_plan_id = v_plan.id
        and s.is_active
        and d::date between s.start_date and s.end_date
      order by s.priority asc, s.start_date desc, s.created_at desc, s.id
      limit 1
    ) sp on true
  ),
  segmented as (
    select
      day_date,
      day_rate,
      rate_type,
      row_number() over (order by day_date)
      - row_number() over (partition by rate_type, day_rate order by day_date) as grp
    from day_rates
  ),
  grouped as (
    select
      min(day_date) as start_date,
      max(day_date) as end_date,
      rate_type,
      day_rate,
      count(*)::int as day_count,
      round(sum(day_rate), 2) as segment_amount
    from segmented
    group by grp, rate_type, day_rate
    order by min(day_date)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'start_date', start_date,
      'end_date', end_date,
      'day_count', day_count,
      'rate_type', rate_type,
      'unit_rate', day_rate,
      'segment_amount', segment_amount,
      'segment_total', round(segment_amount * v_qty, 2)
    )), '[]'::jsonb),
    coalesce(round(sum(segment_amount * v_qty), 2), 0),
    coalesce(array_agg(distinct rate_type), '{}'::text[])
  into v_segments, v_total_amount, v_distinct_rate_types
  from grouped;

  if jsonb_array_length(v_segments) = 0 then
    raise exception 'Rate resolution produced no billable segments' using errcode = '22023';
  end if;

  rate_plan_id := v_plan.id;
  rate_plan_name := v_plan.name;
  plan_version := v_plan.version_number;
  resolution_scope := v_plan.scope_label;
  resolved_rate_type := case
    when coalesce(array_length(v_distinct_rate_types, 1), 0) = 1 then v_distinct_rate_types[1]
    else 'mixed'
  end;
  resolved_daily_rate := round(v_base_daily_rate, 2);
  base_amount := v_total_amount;
  rate_breakdown := jsonb_build_object(
    'rate_plan_id', v_plan.id,
    'rate_plan_name', v_plan.name,
    'plan_version', v_plan.version_number,
    'resolution_scope', v_plan.scope_label,
    'proration_policy', jsonb_build_object(
      'monthly_daily_equivalent', 30,
      'weekly_daily_equivalent', 7,
      'special_overrides_weekend', true
    ),
    'base_rate_type', v_base_rate_type,
    'base_daily_rate', round(v_base_daily_rate, 2),
    'quantity', v_qty,
    'rental_days', v_billable_days,
    'segments', v_segments,
    'base_amount', v_total_amount,
    'resolved_rate_type', case
      when coalesce(array_length(v_distinct_rate_types, 1), 0) = 1 then v_distinct_rate_types[1]
      else 'mixed'
    end,
    'context', jsonb_build_object(
      'asset_id', p_asset_id,
      'category_id', p_category_id,
      'kit_id', p_kit_id,
      'branch_id', p_branch_id,
      'customer_id', p_customer_id,
      'billing_account_id', p_billing_account_id,
      'start_date', p_start_date,
      'end_date', p_end_date
    )
  );

  return next;
end;
$$;

revoke execute on function public.rental_resolve_rate_plan(
  uuid, uuid, uuid, uuid, uuid, uuid, date, date, int
) from public, anon;

grant execute on function public.rental_resolve_rate_plan(
  uuid, uuid, uuid, uuid, uuid, uuid, date, date, int
) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Extend staff_save_quote_order to persist resolved rate snapshots
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
          p_kit_id             => null,
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
        'order_id',              v_order_id,
        'status',                'draft',
        'category_id',           nullif(v_line->>'category_id', ''),
        'asset_id',              nullif(v_line->>'asset_id', ''),
        'branch_id',             nullif(v_line->>'branch_id', ''),
        'planned_start',         nullif(v_line->>'start_date', ''),
        'planned_end',           nullif(v_line->>'end_date', ''),
        'quantity',              greatest(v_line_qty, 1),
        'rate_type',             coalesce(nullif(v_final_rate_type, ''), 'daily'),
        'daily_rate',            v_final_daily_rate,
        'resolved_rate_plan_id', v_resolved_plan_id,
        'rate_resolution_source',v_resolution_source,
        'resolved_rate_snapshot',coalesce(v_resolved_snapshot, '{}'::jsonb),
        'resolved_base_amount',  v_resolved_base_amount,
        'name',                  nullif(v_line->>'name', '')
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

revoke execute on function public.staff_save_quote_order(
  uuid, text, text, text, date, text, text, text, jsonb, jsonb
) from public, anon;

grant execute on function public.staff_save_quote_order(
  uuid, text, text, text, date, text, text, text, jsonb, jsonb
) to authenticated;
