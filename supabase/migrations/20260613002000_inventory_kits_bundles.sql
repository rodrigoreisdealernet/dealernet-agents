-- Inventory kits/bundles definition + availability + quote linkage

-- ---------------------------------------------------------------------------
-- 1) Extend catalogs with inventory_kit and kit component relationships
-- ---------------------------------------------------------------------------

create or replace view public.rental_entity_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company'),
    ('region'),
    ('branch'),
    ('customer'),
    ('billing_account'),
    ('contact'),
    ('job_site'),
    ('asset_category'),
    ('asset'),
    ('stock_item'),
    ('inventory_kit'),
    ('maintenance_record'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line'),
    ('invoice'),
    ('invoice_line'),
    ('transfer'),
    ('rate_card'),
    ('document'),
    ('note'),
    ('agent_config'),
    ('customer_issue')
) as rental_entity_types(entity_type);

create or replace view public.rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company_has_region',            'company',         'region'),
    ('region_has_branch',             'region',          'branch'),
    ('customer_has_billing_account',  'customer',        'billing_account'),
    ('customer_has_contact',          'customer',        'contact'),
    ('customer_has_job_site',         'customer',        'job_site'),
    ('customer_has_document',         'customer',        'document'),
    ('customer_has_note',             'customer',        'note'),
    ('customer_has_issue',            'customer',        'customer_issue'),
    ('billing_account_has_issue',     'billing_account', 'customer_issue'),
    ('branch_has_asset',              'branch',          'asset'),
    ('asset_category_has_asset',      'asset_category',  'asset'),
    ('branch_has_stock_item',         'branch',          'stock_item'),
    ('asset_category_has_stock_item', 'asset_category',  'stock_item'),
    ('kit_has_asset',                 'inventory_kit',   'asset'),
    ('kit_has_asset_category',        'inventory_kit',   'asset_category'),
    ('kit_has_stock_item',            'inventory_kit',   'stock_item'),
    ('asset_has_maintenance_record',  'asset',           'maintenance_record'),
    ('asset_has_inspection',          'asset',           'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

-- ---------------------------------------------------------------------------
-- 2) Projection views for kits and kit components
-- ---------------------------------------------------------------------------

create or replace view public.rental_current_inventory_kits
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_type,
  rces.source_record_id,
  rces.entity_version_id,
  rces.version_number,
  rces.valid_from,
  rces.valid_to,
  rces.data,
  rces.name,
  rces.created_at,
  rces.updated_at,
  rces.data ->> 'description' as description,
  nullif(rces.data ->> 'effective_from', '')::date as effective_from,
  nullif(rces.data ->> 'effective_to', '')::date as effective_to,
  nullif(rces.data ->> 'rate_plan_id', '')::uuid as rate_plan_id,
  coalesce(
    case
      when jsonb_typeof(rces.data -> 'pricing_override') = 'object' then rces.data -> 'pricing_override'
      else null
    end,
    '{}'::jsonb
  ) as pricing_override
from rental_current_entity_state rces
where rces.entity_type = 'inventory_kit';

create or replace view public.rental_inventory_kit_components_current
with (security_invoker = true) as
-- Keep a tiny positive floor so downstream availability division never hits zero.
select
  rel.id as relationship_id,
  kits.entity_id as kit_id,
  kits.name as kit_name,
  rel.relationship_type,
  rel.child_id as component_id,
  component.entity_type as component_entity_type,
  component.name as component_name,
  coalesce(nullif(rel.metadata ->> 'component_name', ''), component.name) as component_label,
  greatest(coalesce((nullif(rel.metadata ->> 'quantity', ''))::numeric, 1), 0.000001) as quantity,
  coalesce((nullif(rel.metadata ->> 'is_required', ''))::boolean, true) as is_required,
  coalesce((nullif(rel.metadata ->> 'is_default', ''))::boolean, false) as is_default,
  nullif(rel.metadata ->> 'effective_from', '')::date as effective_from,
  nullif(rel.metadata ->> 'effective_to', '')::date as effective_to,
  rel.metadata
from relationships_v2 rel
join rental_current_inventory_kits kits
  on kits.entity_id = rel.parent_id
join rental_current_entity_state component
  on component.entity_id = rel.child_id
where rel.is_current
  and rel.relationship_type in ('kit_has_asset', 'kit_has_asset_category', 'kit_has_stock_item');

grant select on public.rental_current_inventory_kits to authenticated, service_role;
grant select on public.rental_inventory_kit_components_current to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Admin RPC: create/update kit definitions and component composition
-- ---------------------------------------------------------------------------

drop function if exists public.staff_upsert_inventory_kit(uuid, text, text, date, date, uuid, jsonb, jsonb);

create function public.staff_upsert_inventory_kit(
  p_kit_id uuid default null,
  p_name text default null,
  p_description text default null,
  p_effective_from date default null,
  p_effective_to date default null,
  p_rate_plan_id uuid default null,
  p_pricing_override jsonb default '{}'::jsonb,
  p_components jsonb default '[]'::jsonb
)
returns table (
  kit_id uuid,
  entity_version_id uuid,
  version_number bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role text;
  v_kit_id uuid;
  v_component jsonb;
  v_component_id uuid;
  v_component_type text;
  v_relationship_type text;
  v_quantity numeric;
  v_min_component_qty constant numeric := 0.000001;
begin
  v_app_role := public.ops_claim_app_role();
  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'staff_upsert_inventory_kit: access denied'
      using errcode = '42501';
  end if;

  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'staff_upsert_inventory_kit: name is required'
      using errcode = '22023';
  end if;

  if p_effective_from is not null
     and p_effective_to is not null
     and p_effective_to < p_effective_from then
    raise exception 'staff_upsert_inventory_kit: effective_to must be >= effective_from'
      using errcode = '22023';
  end if;

  select upserted.entity_id
    into v_kit_id
  from rental_upsert_entity_current_state(
    p_entity_type => 'inventory_kit',
    p_entity_id => p_kit_id,
    p_data => jsonb_build_object(
      'name', trim(p_name),
      'description', nullif(trim(coalesce(p_description, '')), ''),
      'effective_from', p_effective_from,
      'effective_to', p_effective_to,
      'rate_plan_id', p_rate_plan_id,
      'pricing_override', coalesce(p_pricing_override, '{}'::jsonb)
    )
  ) as upserted;

  update relationships_v2
     set is_current = false,
         valid_to = now(),
         updated_at = now()
   where parent_id = v_kit_id
     and is_current
     and relationship_type in ('kit_has_asset', 'kit_has_asset_category', 'kit_has_stock_item');

  for v_component in
    select *
    from jsonb_array_elements(coalesce(p_components, '[]'::jsonb))
  loop
    v_component_type := lower(coalesce(v_component ->> 'component_type', ''));
    v_component_id := nullif(v_component ->> 'component_id', '')::uuid;
    v_quantity := greatest(coalesce((nullif(v_component ->> 'quantity', ''))::numeric, 1), v_min_component_qty);

    if v_component_id is null then
      raise exception 'staff_upsert_inventory_kit: component_id is required for every component'
        using errcode = '22023';
    end if;

    if v_component_type = 'asset' then
      v_relationship_type := 'kit_has_asset';
    elsif v_component_type = 'asset_category' then
      v_relationship_type := 'kit_has_asset_category';
    elsif v_component_type = 'stock_item' then
      v_relationship_type := 'kit_has_stock_item';
    else
      raise exception 'staff_upsert_inventory_kit: invalid component_type "%"', v_component_type
        using errcode = '22023';
    end if;

    perform 1
    from entities
    where id = v_component_id
      and entity_type = v_component_type;

    if not found then
      raise exception 'staff_upsert_inventory_kit: component % is not an entity of type %', v_component_id, v_component_type
        using errcode = '22023';
    end if;

    perform rental_upsert_relationship(
      p_relationship_type => v_relationship_type,
      p_parent_id => v_kit_id,
      p_child_id => v_component_id,
      p_metadata => jsonb_build_object(
        'component_type', v_component_type,
        'component_name', nullif(v_component ->> 'component_name', ''),
        'quantity', v_quantity,
        'is_required', coalesce((nullif(v_component ->> 'is_required', ''))::boolean, true),
        'is_default', coalesce((nullif(v_component ->> 'is_default', ''))::boolean, false),
        'effective_from', nullif(v_component ->> 'effective_from', '')::date,
        'effective_to', nullif(v_component ->> 'effective_to', '')::date
      )
    );
  end loop;

  return query
  select
    v_kit_id,
    ev.id,
    ev.version_number::bigint
  from entity_versions ev
  where ev.entity_id = v_kit_id
    and ev.is_current;
end;
$$;

revoke execute on function public.staff_upsert_inventory_kit(uuid, text, text, date, date, uuid, jsonb, jsonb)
  from public, anon;
grant execute on function public.staff_upsert_inventory_kit(uuid, text, text, date, date, uuid, jsonb, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Availability projection for kit/bundle definitions
-- ---------------------------------------------------------------------------

create or replace function public.rental_kit_availability(
  p_kit_id uuid,
  p_branch_id uuid default null,
  p_start_date date default null,
  p_end_date date default null,
  p_quantity int default 1
)
returns table (
  kit_id uuid,
  requested_quantity int,
  available_quantity bigint,
  is_available boolean,
  shortage_quantity bigint,
  blocking_components jsonb
)
language plpgsql
stable
as $$
declare
  v_component record;
  v_component_available numeric;
  v_component_required numeric;
  v_component_max_kits bigint;
  v_requested int := greatest(coalesce(p_quantity, 1), 1);
  v_policy record;
  v_blockers jsonb := '[]'::jsonb;
  v_min_component_qty constant numeric := 0.000001;
  v_unbounded_kits constant bigint := 9223372036854775807;
  v_kit_max bigint := v_unbounded_kits;
begin
  if p_kit_id is null then
    raise exception 'rental_kit_availability requires p_kit_id'
      using errcode = '22023';
  end if;

  if p_start_date is not null and p_end_date is not null and p_end_date < p_start_date then
    raise exception 'rental_kit_availability received invalid date range'
      using errcode = '22023';
  end if;

  for v_component in
    select *
    from rental_inventory_kit_components_current components
    where components.kit_id = p_kit_id
      and (
        components.effective_from is null
        or p_end_date is null
        or components.effective_from <= p_end_date
      )
      and (
        components.effective_to is null
        or p_start_date is null
        or components.effective_to >= p_start_date
      )
  loop
    v_component_required := greatest(coalesce(v_component.quantity, 1), v_min_component_qty);
    v_component_available := 0;

    if v_component.component_entity_type = 'asset_category' then
      if p_branch_id is null then
        v_component_available := 0;
      else
        select *
          into v_policy
        from rental_quote_line_availability_policy(
          p_branch_id,
          v_component.component_id,
          ceil(v_component_required)::int,
          p_start_date,
          p_end_date
        );

        v_component_available := coalesce(v_policy.available_quantity, 0);
      end if;
    elsif v_component.component_entity_type = 'asset' then
      select case
        when rc.entity_id is null then 0
        when coalesce(rc.operational_status, '') <> 'available' then 0
        when p_branch_id is not null and rc.current_branch_id is distinct from p_branch_id then 0
        when exists (
          select 1
          from v_rental_contract_line_current cl
          where cl.status in ('pending', 'checked_out')
            and cl.asset_id = rc.entity_id::text
            and rental_dates_overlap(
              coalesce(nullif(cl.actual_start, '')::date, nullif(cl.data->>'planned_start', '')::date),
              coalesce(nullif(cl.actual_end, '')::date, nullif(cl.data->>'planned_end', '')::date),
              p_start_date,
              p_end_date
            )
        ) then 0
        when exists (
          select 1
          from v_rental_order_line_current ol
          join v_rental_order_current ro
            on ro.entity_id::text = ol.order_id
          where ro.status = 'approved'
            and nullif(ol.data->>'asset_id', '')::uuid = rc.entity_id
            and ol.status <> 'cancelled'
            and rental_dates_overlap(ol.planned_start, ol.planned_end, p_start_date, p_end_date)
        ) then 0
        else 1
      end
      into v_component_available
      from rental_current_assets rc
      where rc.entity_id = v_component.component_id;

      v_component_available := coalesce(v_component_available, 0);
    elsif v_component.component_entity_type = 'stock_item' then
      select
        case
          when stock_item.entity_id is null then 0
          when coalesce(stock_item.operational_status, '') in ('discontinued', 'maintenance') then 0
          when p_branch_id is not null and stock_item.current_branch_id is distinct from p_branch_id then 0
          else greatest(
            coalesce(sum((nullif(tsp.data_payload ->> 'quantity', ''))::numeric), 0),
            0
          )
        end
      into v_component_available
      from rental_current_inventory_records stock_item
      left join time_series_points tsp
        on tsp.entity_id = stock_item.entity_id
      left join fact_types ft
        on ft.id = tsp.fact_type_id
       and ft.key in ('stock_opening_balance', 'stock_quantity_adjustment')
      where stock_item.entity_id = v_component.component_id
        and stock_item.entity_type = 'stock_item'
        and (
          tsp.id is null
          or p_end_date is null
          or tsp.observed_at::date <= p_end_date
        )
      group by stock_item.entity_id, stock_item.operational_status, stock_item.current_branch_id;

      v_component_available := coalesce(v_component_available, 0);
    end if;

    v_component_max_kits := floor(v_component_available / v_component_required);

    if coalesce(v_component.is_required, true) then
      v_kit_max := least(v_kit_max, greatest(v_component_max_kits, 0));
    end if;

    if coalesce(v_component.is_required, true) and v_component_max_kits < v_requested then
      v_blockers := v_blockers || jsonb_build_array(
        jsonb_build_object(
          'relationship_id', v_component.relationship_id,
          'component_id', v_component.component_id,
          'component_type', v_component.component_entity_type,
          'component_name', v_component.component_label,
          'required_per_kit', v_component_required,
          'available_units', v_component_available,
          'max_kits_from_component', greatest(v_component_max_kits, 0)
        )
      );
    end if;
  end loop;

  if v_kit_max = v_unbounded_kits then
    v_kit_max := 0;
    v_blockers := v_blockers || jsonb_build_array(
      jsonb_build_object(
        'reason', 'kit_has_no_active_components'
      )
    );
  end if;

  kit_id := p_kit_id;
  requested_quantity := v_requested;
  available_quantity := greatest(v_kit_max, 0);
  is_available := available_quantity >= requested_quantity;
  shortage_quantity := greatest(requested_quantity - available_quantity, 0);
  blocking_components := v_blockers;
  return next;
end;
$$;

alter function public.rental_kit_availability(uuid, uuid, date, date, int) owner to postgres;
revoke execute on function public.rental_kit_availability(uuid, uuid, date, date, int) from public, anon;
grant execute on function public.rental_kit_availability(uuid, uuid, date, date, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Quote/order save RPC update: persist kit linkage on order lines
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
  v_app_role           text;
  v_user_id            uuid;
  v_order_id           uuid;
  v_order_number       text;
  v_line               jsonb;
  v_line_id            uuid;
  v_cancel_id          text;
  v_cancel_data        jsonb;
  v_saved_lines        jsonb := '[]'::jsonb;
  v_kit_id             uuid;
  v_kit_component_snapshot jsonb;
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
          or nullif(v_line->>'end_date', '')::date is null
          or components.effective_from <= nullif(v_line->>'end_date', '')::date
        )
        and (
          components.effective_to is null
          or nullif(v_line->>'start_date', '')::date is null
          or components.effective_to >= nullif(v_line->>'start_date', '')::date
        );
    end if;

    select upserted.entity_id
      into v_line_id
    from rental_upsert_entity_current_state(
      p_entity_type => 'rental_order_line',
      p_entity_id   => v_line_id,
      p_data        => jsonb_build_object(
        'order_id',      v_order_id,
        'status',        'draft',
        'kit_id',        v_kit_id,
        'kit_component_snapshot', v_kit_component_snapshot,
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
