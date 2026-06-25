-- Per-asset analytics projection + stable analytics view.
-- Metrics are derived from live rental/invoice/maintenance events and surfaced
-- through entity_facts (current KPI snapshot) plus time_series_points history.

insert into public.fact_types (key, label, description, unit)
values
  ('asset_lifetime_revenue', 'Asset Lifetime Revenue', 'Invoice-recognized revenue attributed to a serialized asset over its lifetime', 'usd'),
  ('asset_utilization_pct', 'Asset Utilization Percent', 'Rental utilization percent derived from calendar minutes and included rental minutes', 'percent'),
  ('asset_downtime_pct', 'Asset Downtime Percent', 'Downtime percent derived from calendar minutes and downtime event minutes', 'percent'),
  ('asset_rental_frequency', 'Asset Rental Frequency', 'Distinct included rental contracts for the asset', 'count'),
  ('asset_roi_pct', 'Asset ROI Percent', 'ROI percent derived from lifetime revenue and asset cost basis when available', 'percent'),
  ('asset_last_order_epoch', 'Asset Last Order Epoch', 'Epoch seconds for the asset''s most recent rental start/order anchor', 'seconds'),
  ('asset_calendar_minutes', 'Asset Calendar Minutes', 'Elapsed calendar minutes used as denominator for utilization/downtime percentages', 'minutes'),
  ('asset_rental_minutes', 'Asset Rental Minutes', 'Included rental minutes used in utilization calculations', 'minutes'),
  ('asset_total_downtime_minutes', 'Asset Total Downtime Minutes', 'Total downtime minutes from asset downtime history', 'minutes')
on conflict (key) do nothing;

create or replace function public.rental_recompute_asset_analytics(
  p_asset_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_affected_count integer := 0;
  v_request_role text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );

  -- Trigger-driven refreshes run inside trusted database paths; enforce the
  -- service-role requirement only for direct RPC/manual invocation.
  if pg_trigger_depth() = 0 and v_request_role not in ('', 'service_role') then
    raise exception 'permission denied for function rental_recompute_asset_analytics'
      using errcode = '42501';
  end if;

  with target_assets as (
    select
      assets.entity_id as asset_id,
      assets.name as asset_name,
      assets.current_asset_category_id as asset_category_id,
      assets.current_asset_category_name as asset_category_name,
      assets.current_branch_id as branch_id,
      assets.current_branch_name as branch_name,
      coalesce(asset_entities.created_at, assets.created_at) as asset_created_at,
      assets.ownership_type as ownership_type,
      assets.data as asset_data,
      case
        when coalesce(nullif(assets.data ->> 'acquisition_cost', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (assets.data ->> 'acquisition_cost')::numeric
        when coalesce(nullif(assets.data ->> 'book_cost', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (assets.data ->> 'book_cost')::numeric
        when coalesce(nullif(assets.data ->> 'cost_basis', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (assets.data ->> 'cost_basis')::numeric
        else null
      end as cost_basis
    from public.rental_current_assets assets
    join public.entities asset_entities
      on asset_entities.id = assets.entity_id
    where p_asset_id is null or assets.entity_id = p_asset_id
  ),
  current_contract_lines as (
    select
      e.id as line_entity_id,
      ev.data as line_data,
      case
        when coalesce(nullif(ev.data ->> 'asset_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (ev.data ->> 'asset_id')::uuid
        else null
      end as asset_id,
      case
        when coalesce(nullif(ev.data ->> 'contract_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (ev.data ->> 'contract_id')::uuid
        else null
      end as contract_id,
      nullif(ev.data ->> 'rental_type', '') as rental_type,
      coalesce(
        nullif(ev.data ->> 'actual_start', '')::timestamptz,
        nullif(ev.data ->> 'planned_start', '')::timestamptz
      ) as started_at,
      coalesce(
        nullif(ev.data ->> 'actual_end', '')::timestamptz,
        now()
      ) as ended_at
    from public.entities e
    join public.entity_versions ev
      on ev.entity_id = e.id
     and ev.is_current
    where e.entity_type = 'rental_contract_line'
  ),
  filtered_contract_lines as (
    select
      lines.line_entity_id,
      lines.asset_id,
      lines.contract_id,
      lines.started_at,
      lines.ended_at,
      case
        when lines.started_at is null then 0::numeric
        when lines.ended_at < lines.started_at then 0::numeric
        else extract(epoch from (lines.ended_at - lines.started_at)) / 60.0
      end as rental_minutes,
      case
        when lower(coalesce(lines.rental_type, '')) in ('rerent', 're_rent', 're-rent') then true
        when coalesce(assets.ownership_type, 'owned') <> 'owned' then true
        else false
      end as is_rerent_excluded
    from current_contract_lines lines
    join target_assets assets
      on assets.asset_id = lines.asset_id
    where lines.asset_id is not null
  ),
  current_invoice_lines as (
    select
      case
        when coalesce(nullif(ev.data ->> 'line_item_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (ev.data ->> 'line_item_id')::uuid
        else null
      end as line_entity_id,
      case
        when coalesce(nullif(ev.data ->> 'invoice_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (ev.data ->> 'invoice_id')::uuid
        else null
      end as invoice_id,
      case
        when coalesce(nullif(ev.data ->> 'amount', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (ev.data ->> 'amount')::numeric
        else null
      end as amount
    from public.entities e
    join public.entity_versions ev
      on ev.entity_id = e.id
     and ev.is_current
    where e.entity_type = 'invoice_line'
  ),
  current_invoices as (
    select
      e.id as invoice_id,
      lower(coalesce(nullif(ev.data ->> 'status', ''), 'sent')) as invoice_status
    from public.entities e
    join public.entity_versions ev
      on ev.entity_id = e.id
     and ev.is_current
    where e.entity_type = 'invoice'
  ),
  line_revenue as (
    select
      il.line_entity_id,
      sum(il.amount) as revenue_amount
    from current_invoice_lines il
    left join current_invoices i
      on i.invoice_id = il.invoice_id
    where il.line_entity_id is not null
      and il.amount is not null
      and coalesce(i.invoice_status, 'sent') not in ('draft', 'void', 'cancelled')
    group by il.line_entity_id
  ),
  downtime_rollup as (
    select
      history.asset_id,
      coalesce(sum(history.downtime_minutes), 0)::numeric as total_downtime_minutes
    from public.v_asset_downtime_history history
    group by history.asset_id
  ),
  per_asset_metrics as (
    select
      assets.asset_id,
      assets.asset_name,
      assets.asset_category_id,
      assets.asset_category_name,
      assets.branch_id,
      assets.branch_name,
      assets.ownership_type,
      assets.cost_basis,
      coalesce(sum(coalesce(revenue.revenue_amount, 0)), 0)::numeric as lifetime_revenue,
      coalesce(
        sum(
          case
            when lines.is_rerent_excluded then 0
            else coalesce(revenue.revenue_amount, 0)
          end
        ),
        0
      )::numeric as roi_revenue,
      coalesce(
        sum(
          case
            when lines.is_rerent_excluded then 0
            else lines.rental_minutes
          end
        ),
        0
      )::numeric as included_rental_minutes,
      count(
        distinct case
          when lines.is_rerent_excluded then null
          else lines.contract_id
        end
      )::numeric as rental_frequency_count,
      max(lines.started_at) as last_order_at,
      coalesce(downtime.total_downtime_minutes, 0)::numeric as total_downtime_minutes,
      greatest(extract(epoch from (now() - coalesce(assets.asset_created_at, now()))) / 60.0, 1.0)::numeric as calendar_minutes
    from target_assets assets
    left join filtered_contract_lines lines
      on lines.asset_id = assets.asset_id
    left join line_revenue revenue
      on revenue.line_entity_id = lines.line_entity_id
    left join downtime_rollup downtime
      on downtime.asset_id = assets.asset_id
    group by
      assets.asset_id,
      assets.asset_name,
      assets.asset_category_id,
      assets.asset_category_name,
      assets.branch_id,
      assets.branch_name,
      assets.ownership_type,
      assets.cost_basis,
      downtime.total_downtime_minutes,
      assets.asset_created_at
  ),
  computed as (
    select
      metrics.*,
      round((metrics.included_rental_minutes / nullif(metrics.calendar_minutes, 0)) * 100.0, 4) as utilization_pct,
      round((metrics.total_downtime_minutes / nullif(metrics.calendar_minutes, 0)) * 100.0, 4) as downtime_pct,
      round((metrics.rental_frequency_count / nullif(metrics.calendar_minutes / (60 * 24 * 30.0), 0)), 4) as rental_frequency_per_30d,
      case
        when metrics.cost_basis is null or metrics.cost_basis <= 0 then null
        else round(((metrics.roi_revenue - metrics.cost_basis) / metrics.cost_basis) * 100.0, 4)
      end as roi_pct,
      case
        when metrics.last_order_at is null then null
        else extract(epoch from metrics.last_order_at)::numeric
      end as last_order_epoch
    from per_asset_metrics metrics
  ),
  fact_rows as (
    select
      computed.asset_id as entity_id,
      facts.id as fact_type_id,
      computed.lifetime_revenue as value,
      jsonb_build_object(
        'formula', 'sum(invoice_line.amount)',
        'source_of_truth', 'invoice_line current versions',
        'as_of', now()
      ) as metadata
    from computed
    join public.fact_types facts on facts.key = 'asset_lifetime_revenue'
    union all
    select
      computed.asset_id,
      facts.id,
      computed.utilization_pct,
      jsonb_build_object(
        'formula', 'included_rental_minutes / calendar_minutes * 100',
        'included_rental_minutes', computed.included_rental_minutes,
        'calendar_minutes', computed.calendar_minutes,
        'rerent_excluded_default', true,
        'as_of', now()
      )
    from computed
    join public.fact_types facts on facts.key = 'asset_utilization_pct'
    union all
    select
      computed.asset_id,
      facts.id,
      computed.downtime_pct,
      jsonb_build_object(
        'formula', 'total_downtime_minutes / calendar_minutes * 100',
        'total_downtime_minutes', computed.total_downtime_minutes,
        'calendar_minutes', computed.calendar_minutes,
        'source_of_truth', 'v_asset_downtime_history',
        'as_of', now()
      )
    from computed
    join public.fact_types facts on facts.key = 'asset_downtime_pct'
    union all
    select
      computed.asset_id,
      facts.id,
      computed.rental_frequency_count,
      jsonb_build_object(
        'formula', 'count(distinct contract_id excluding rerent lines)',
        'per_30d_frequency', computed.rental_frequency_per_30d,
        'as_of', now()
      )
    from computed
    join public.fact_types facts on facts.key = 'asset_rental_frequency'
    union all
    select
      computed.asset_id,
      facts.id,
      computed.calendar_minutes,
      jsonb_build_object('formula', 'max(now - asset_created_at, 1 minute)', 'as_of', now())
    from computed
    join public.fact_types facts on facts.key = 'asset_calendar_minutes'
    union all
    select
      computed.asset_id,
      facts.id,
      computed.included_rental_minutes,
      jsonb_build_object('formula', 'sum(active/returned rental contract line minutes excluding rerent lines)', 'as_of', now())
    from computed
    join public.fact_types facts on facts.key = 'asset_rental_minutes'
    union all
    select
      computed.asset_id,
      facts.id,
      computed.total_downtime_minutes,
      jsonb_build_object('formula', 'sum(v_asset_downtime_history.downtime_minutes)', 'as_of', now())
    from computed
    join public.fact_types facts on facts.key = 'asset_total_downtime_minutes'
    union all
    select
      computed.asset_id,
      facts.id,
      computed.roi_pct,
      jsonb_build_object(
        'formula', '(roi_revenue - cost_basis) / cost_basis * 100',
        'roi_revenue', computed.roi_revenue,
        'cost_basis', computed.cost_basis,
        'unavailable_when_missing_cost_basis', true,
        'as_of', now()
      )
    from computed
    join public.fact_types facts on facts.key = 'asset_roi_pct'
    where computed.roi_pct is not null
    union all
    select
      computed.asset_id,
      facts.id,
      computed.last_order_epoch,
      jsonb_build_object(
        'formula', 'max(contract_line.actual_start, contract_line.planned_start)',
        'as_of', now()
      )
    from computed
    join public.fact_types facts on facts.key = 'asset_last_order_epoch'
    where computed.last_order_epoch is not null
  ),
  upserted as (
    insert into public.entity_facts (
      entity_id,
      fact_type_id,
      value,
      source_id,
      metadata
    )
    select
      rows.entity_id,
      rows.fact_type_id,
      rows.value,
      'asset-analytics-projection-v1',
      rows.metadata
    from fact_rows rows
    on conflict (entity_id, fact_type_id, dimension_id)
    do update set
      value = excluded.value,
      source_id = excluded.source_id,
      metadata = excluded.metadata,
      updated_at = now()
    returning entity_id
  )
  select count(distinct entity_id) into v_affected_count
  from upserted;

  with computed as (
    select
      assets.entity_id as asset_id,
      case
        when coalesce(nullif(assets.data ->> 'acquisition_cost', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (assets.data ->> 'acquisition_cost')::numeric
        when coalesce(nullif(assets.data ->> 'book_cost', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (assets.data ->> 'book_cost')::numeric
        when coalesce(nullif(assets.data ->> 'cost_basis', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (assets.data ->> 'cost_basis')::numeric
        else null
      end as cost_basis,
      (
        select max(
          coalesce(
            nullif(line_versions.data ->> 'actual_start', '')::timestamptz,
            nullif(line_versions.data ->> 'planned_start', '')::timestamptz
          )
        )
        from public.entities line_entities
        join public.entity_versions line_versions
          on line_versions.entity_id = line_entities.id
         and line_versions.is_current
        where line_entities.entity_type = 'rental_contract_line'
          and line_versions.data ->> 'asset_id' = assets.entity_id::text
      ) as last_order_at
    from public.rental_current_assets assets
    where p_asset_id is null or assets.entity_id = p_asset_id
  ),
  roi_fact as (
    select id as fact_type_id from public.fact_types where key = 'asset_roi_pct'
  ),
  last_order_fact as (
    select id as fact_type_id from public.fact_types where key = 'asset_last_order_epoch'
  )
  -- Data-safety note: this cleanup removes stale ROI facts when cost basis is
  -- unavailable so downstream reads remain contract-correct (roi_status =
  -- unavailable). Rollback/recovery path: restore a valid cost basis and rerun
  -- public.rental_recompute_asset_analytics(asset_id) to repopulate.
  delete from public.entity_facts ef
  using computed, roi_fact
  where ef.entity_id = computed.asset_id
    and ef.fact_type_id = roi_fact.fact_type_id
    and (computed.cost_basis is null or computed.cost_basis <= 0);

  with computed as (
    select
      assets.entity_id as asset_id,
      (
        select max(
          coalesce(
            nullif(line_versions.data ->> 'actual_start', '')::timestamptz,
            nullif(line_versions.data ->> 'planned_start', '')::timestamptz
          )
        )
        from public.entities line_entities
        join public.entity_versions line_versions
          on line_versions.entity_id = line_entities.id
         and line_versions.is_current
        where line_entities.entity_type = 'rental_contract_line'
          and line_versions.data ->> 'asset_id' = assets.entity_id::text
      ) as last_order_at
    from public.rental_current_assets assets
    where p_asset_id is null or assets.entity_id = p_asset_id
  ),
  last_order_fact as (
    select id as fact_type_id from public.fact_types where key = 'asset_last_order_epoch'
  )
  -- Data-safety note: this cleanup removes stale last-order facts when an asset
  -- no longer has rental starts. Rollback/recovery path: reintroduce valid
  -- contract-line start data and rerun public.rental_recompute_asset_analytics(asset_id).
  delete from public.entity_facts ef
  using computed, last_order_fact
  where ef.entity_id = computed.asset_id
    and ef.fact_type_id = last_order_fact.fact_type_id
    and computed.last_order_at is null;

  return coalesce(v_affected_count, 0);
end;
$$;

revoke execute on function public.rental_recompute_asset_analytics(uuid) from public, anon, authenticated;
grant execute on function public.rental_recompute_asset_analytics(uuid) to service_role;

create or replace function public.trg_rental_asset_analytics_refresh()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_type text;
  v_asset_id uuid;
  v_line_item_id uuid;
  v_contract_id uuid;
  v_fact_key text;
begin
  if tg_table_name = 'time_series_points' then
    select ft.key
      into v_fact_key
    from public.fact_types ft
    where ft.id = new.fact_type_id;

    if v_fact_key = 'asset_downtime' and new.entity_id is not null then
      perform public.rental_recompute_asset_analytics(new.entity_id);
    end if;

    return new;
  end if;

  if tg_table_name <> 'entity_versions' then
    return new;
  end if;

  select e.entity_type
    into v_entity_type
  from public.entities e
  where e.id = new.entity_id;

  if v_entity_type = 'asset' then
    perform public.rental_recompute_asset_analytics(new.entity_id);
    return new;
  end if;

  if v_entity_type = 'rental_contract_line' then
    if coalesce(nullif(new.data ->> 'asset_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      v_asset_id := (new.data ->> 'asset_id')::uuid;
      perform public.rental_recompute_asset_analytics(v_asset_id);
    end if;
    return new;
  end if;

  if v_entity_type = 'invoice_line' then
    if coalesce(nullif(new.data ->> 'line_item_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      v_line_item_id := (new.data ->> 'line_item_id')::uuid;
      select
        case
          when coalesce(nullif(line_versions.data ->> 'asset_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then (line_versions.data ->> 'asset_id')::uuid
          else null
        end
        into v_asset_id
      from public.entity_versions line_versions
      where line_versions.entity_id = v_line_item_id
        and line_versions.is_current;

      if v_asset_id is not null then
        perform public.rental_recompute_asset_analytics(v_asset_id);
      end if;
    end if;
    return new;
  end if;

  if v_entity_type = 'invoice' then
    if coalesce(nullif(new.data ->> 'contract_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      v_contract_id := (new.data ->> 'contract_id')::uuid;
      for v_asset_id in
        select distinct
          case
            when coalesce(nullif(line_versions.data ->> 'asset_id', ''), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              then (line_versions.data ->> 'asset_id')::uuid
            else null
          end as asset_id
        from public.entities line_entities
        join public.entity_versions line_versions
          on line_versions.entity_id = line_entities.id
         and line_versions.is_current
        where line_entities.entity_type = 'rental_contract_line'
          and coalesce(nullif(line_versions.data ->> 'contract_id', ''), '') = v_contract_id::text
      loop
        if v_asset_id is not null then
          perform public.rental_recompute_asset_analytics(v_asset_id);
        end if;
      end loop;
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_entity_versions_asset_analytics_refresh on public.entity_versions;
create trigger trg_entity_versions_asset_analytics_refresh
after insert or update of data, is_current
on public.entity_versions
for each row
execute function public.trg_rental_asset_analytics_refresh();

drop trigger if exists trg_time_series_asset_analytics_refresh on public.time_series_points;
create trigger trg_time_series_asset_analytics_refresh
after insert or update of data_payload, metadata, fact_type_id, entity_id
on public.time_series_points
for each row
execute function public.trg_rental_asset_analytics_refresh();

select public.rental_recompute_asset_analytics(null);

create or replace view public.v_asset_analytics_current
with (security_invoker = true) as
with typed_facts as (
  select
    ef.entity_id,
    ft.key as fact_key,
    ef.value,
    ef.metadata,
    ef.updated_at
  from public.entity_facts ef
  join public.fact_types ft
    on ft.id = ef.fact_type_id
  where ft.key in (
    'asset_lifetime_revenue',
    'asset_utilization_pct',
    'asset_downtime_pct',
    'asset_rental_frequency',
    'asset_roi_pct',
    'asset_last_order_epoch',
    'asset_calendar_minutes',
    'asset_rental_minutes',
    'asset_total_downtime_minutes'
  )
),
facts_pivot as (
  select
    entity_id as asset_id,
    max(value) filter (where fact_key = 'asset_lifetime_revenue') as lifetime_revenue,
    max(value) filter (where fact_key = 'asset_utilization_pct') as utilization_pct,
    max(value) filter (where fact_key = 'asset_downtime_pct') as downtime_pct,
    max(value) filter (where fact_key = 'asset_rental_frequency') as rental_frequency,
    max(value) filter (where fact_key = 'asset_roi_pct') as roi_pct,
    max(value) filter (where fact_key = 'asset_last_order_epoch') as last_order_epoch,
    max(value) filter (where fact_key = 'asset_calendar_minutes') as calendar_minutes,
    max(value) filter (where fact_key = 'asset_rental_minutes') as rental_minutes,
    max(value) filter (where fact_key = 'asset_total_downtime_minutes') as total_downtime_minutes,
    max(updated_at) as analytics_updated_at
  from typed_facts
  group by entity_id
),
request_context as (
  select
    coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
      ''
    ) as request_role,
    public.get_my_tenant() as request_tenant
)
select
  assets.entity_id as asset_id,
  assets.name as asset_name,
  assets.current_asset_category_id as asset_category_id,
  assets.current_asset_category_name as asset_category_name,
  assets.current_branch_id as branch_id,
  assets.current_branch_name as branch_name,
  assets.ownership_type,
  case
    when coalesce(nullif(assets.data ->> 'acquisition_cost', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
      then (assets.data ->> 'acquisition_cost')::numeric
    when coalesce(nullif(assets.data ->> 'book_cost', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
      then (assets.data ->> 'book_cost')::numeric
    when coalesce(nullif(assets.data ->> 'cost_basis', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
      then (assets.data ->> 'cost_basis')::numeric
    else null
  end as cost_basis,
  coalesce(facts.lifetime_revenue, 0)::numeric as lifetime_revenue,
  coalesce(facts.utilization_pct, 0)::numeric as utilization_pct,
  coalesce(facts.downtime_pct, 0)::numeric as downtime_pct,
  coalesce(facts.total_downtime_minutes, 0)::numeric as total_downtime_minutes,
  coalesce(facts.rental_frequency, 0)::numeric as rental_frequency,
  facts.roi_pct::numeric as roi_pct,
  case
    when facts.roi_pct is null then 'unavailable'
    else 'available'
  end as roi_status,
  case
    when facts.last_order_epoch is null then null
    else to_timestamp(facts.last_order_epoch::double precision)
  end as last_order_at,
  coalesce(facts.calendar_minutes, greatest(extract(epoch from (now() - coalesce(assets.created_at, now()))) / 60.0, 1.0))::numeric as calendar_minutes,
  coalesce(facts.rental_minutes, 0)::numeric as rental_minutes,
  coalesce(facts.analytics_updated_at, assets.updated_at) as analytics_updated_at,
  'utilization_pct = rental_minutes / calendar_minutes * 100; downtime_pct = total_downtime_minutes / calendar_minutes * 100; roi_pct = (lifetime_revenue - cost_basis) / cost_basis * 100 (when cost_basis exists); rerent lines excluded by default for utilization/roi'::text as formula_reference
from public.rental_current_assets assets
cross join request_context req
left join facts_pivot facts
  on facts.asset_id = assets.entity_id
where req.request_role = 'service_role'
   or coalesce(nullif(assets.data ->> 'tenant', ''), 'default')
      = coalesce(nullif(req.request_tenant, ''), 'default');

grant select on public.v_asset_analytics_current to authenticated, service_role;
