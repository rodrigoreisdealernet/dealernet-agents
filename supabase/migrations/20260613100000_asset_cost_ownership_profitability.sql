-- Asset cost-of-ownership and profitability reporting
-- Issue #1259
--
-- Exposes total cost-of-ownership and profitability analytics by equipment type
-- (asset category) by aggregating depreciation, recapitalization, disposal,
-- maintenance costs, and sale outcomes from posted accounting events.
--
-- Changes:
--   1. Extend journal_entries and accounting_posting_rules event-type constraints
--      to accept asset lifecycle event types: asset_depreciation, asset_recapitalization,
--      asset_disposal, asset_sale.
--   2. v_asset_lifecycle_accounting_events — per-event-line reconciliation view.
--   3. v_equipment_type_cost_ownership — cost-of-ownership rollup by asset category
--      with component-level breakdown and source lineage.
--   4. v_equipment_type_profitability — profitability view by equipment type combining
--      revenue, costs, and disposal/sale outcomes.
--   5. finance_get_equipment_cost_ownership() — guarded RPC for finance audience.
--
-- Rollback:
--   drop function if exists public.finance_get_equipment_cost_ownership(uuid,date,date,text,int,int);
--   drop view if exists public.v_equipment_type_profitability;
--   drop view if exists public.v_equipment_type_cost_ownership;
--   drop view if exists public.v_asset_lifecycle_accounting_events;
--   alter table public.journal_entries drop constraint if exists chk_journal_entries_source_event_type;
--   alter table public.journal_entries add constraint chk_journal_entries_source_event_type check (
--     source_event_type in ('invoice_issued','invoice_void','payment_applied','payment_refund','fee_charged','credit_applied')
--   );
--   alter table public.accounting_posting_rules drop constraint if exists chk_accounting_posting_rules_event_type;
--   alter table public.accounting_posting_rules add constraint chk_accounting_posting_rules_event_type check (
--     event_type in ('invoice_issued','invoice_void','payment_applied','payment_refund','fee_charged','credit_applied')
--   );

-- ---------------------------------------------------------------------------
-- 1. Extend event-type check constraints to include asset lifecycle types
-- ---------------------------------------------------------------------------

alter table public.journal_entries
  drop constraint if exists chk_journal_entries_source_event_type;

alter table public.journal_entries
  add constraint chk_journal_entries_source_event_type check (
    source_event_type in (
      'invoice_issued',
      'invoice_void',
      'payment_applied',
      'payment_refund',
      'fee_charged',
      'credit_applied',
      'asset_depreciation',
      'asset_recapitalization',
      'asset_disposal',
      'asset_sale'
    )
  );

alter table public.accounting_posting_rules
  drop constraint if exists chk_accounting_posting_rules_event_type;

alter table public.accounting_posting_rules
  add constraint chk_accounting_posting_rules_event_type check (
    event_type in (
      'invoice_issued',
      'invoice_void',
      'payment_applied',
      'payment_refund',
      'fee_charged',
      'credit_applied',
      'asset_depreciation',
      'asset_recapitalization',
      'asset_disposal',
      'asset_sale'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. v_asset_lifecycle_accounting_events
--    Per-journal-entry-line view for asset lifecycle events. Provides full
--    source lineage (journal_entry_id, source_event_id, source_event_type)
--    for downstream reconciliation so every cost component traces back to
--    a posted journal entry without hidden adjustments.
--
--    Finance-only: accessible to admin + branch_manager and service_role.
--    security_invoker = true ensures underlying RLS (journal_entries,
--    journal_entry_lines, rental_current_assets) applies to the caller.
-- ---------------------------------------------------------------------------

create or replace view public.v_asset_lifecycle_accounting_events
with (security_invoker = true) as
with request_context as (
  select
    coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') as request_role,
    public.ops_claim_app_role()                                                as app_role
),
-- Finance-access gate: returns 1 row for service_role or admin/branch_manager,
-- 0 rows for every other role. INNER JOIN enforces finance-only access on all
-- direct view paths — including queries that bypass the RPC entry point.
finance_access_gate as (
  select 1 as ok
  from request_context req
  where req.request_role = 'service_role'
     or req.app_role in ('admin', 'branch_manager')
)
select
  je.id                                       as journal_entry_id,
  je.source_event_id,
  je.source_event_type,
  je.posting_date,
  je.posting_basis,
  je.tenant_id,
  je.branch_id,
  je.is_reversal,
  je.reverses_entry_id,
  je.source_record_id                         as asset_id,
  assets.name                                 as asset_name,
  assets.current_asset_category_id            as asset_category_id,
  assets.current_asset_category_name          as asset_category_name,
  jl.id                                       as journal_entry_line_id,
  jl.line_sequence,
  jl.side,
  jl.account_code,
  jl.account_name,
  jl.amount,
  je.currency_code
from public.journal_entries je
join public.journal_entry_lines jl
  on jl.journal_entry_id = je.id
left join public.rental_current_assets assets
  on assets.entity_id = je.source_record_id
inner join finance_access_gate on true
where je.source_event_type in (
    'asset_depreciation',
    'asset_recapitalization',
    'asset_disposal',
    'asset_sale'
  )
  and je.posting_status = 'posted';

revoke all on public.v_asset_lifecycle_accounting_events from public, anon;
grant select on public.v_asset_lifecycle_accounting_events to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. v_equipment_type_cost_ownership
--    Cost-of-ownership rollup by equipment type (asset category).
--
--    Component columns and their sources (formula_reference documents each):
--      total_acquisition_cost   — sum of cost_basis from rental_current_assets.data
--      total_accumulated_depreciation — sum of je.total_debit for asset_depreciation events
--      total_recapitalization_cost    — sum of je.total_debit for asset_recapitalization events
--      total_maintenance_cost         — sum of maintenance_cost_lines.cost_total per category
--      total_disposal_proceeds        — sum of je.total_debit for asset_disposal events
--      total_sale_proceeds            — sum of je.total_debit for asset_sale events
--      net_book_value                 — acquisition_cost - accumulated_depreciation + recapitalization
--      owned_asset_count              — distinct assets with entity_type = 'asset' in category
--      event_posting_count            — number of posted lifecycle journal entries
--
--    Finance-only: admin + branch_manager + service_role.
-- ---------------------------------------------------------------------------

create or replace view public.v_equipment_type_cost_ownership
with (security_invoker = true) as
with request_context as (
  select
    coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') as request_role,
    public.ops_claim_app_role()                                                as app_role,
    public.get_my_tenant()                                                     as request_tenant
),
-- Finance-access gate: returns 1 row for service_role or admin/branch_manager,
-- 0 rows for every other role. INNER JOIN into every table-scanning CTE below
-- to enforce finance-only access on all direct view paths without exception.
finance_access_gate as (
  select 1 as ok
  from request_context req
  where req.request_role = 'service_role'
     or req.app_role in ('admin', 'branch_manager')
),
-- Assets in scope with their cost basis
scoped_assets as (
  select
    assets.entity_id                                                    as asset_id,
    assets.name                                                         as asset_name,
    coalesce(nullif(assets.data ->> 'tenant', ''), 'default')          as asset_tenant,
    assets.current_asset_category_id                                    as asset_category_id,
    assets.current_asset_category_name                                  as asset_category_name,
    case
      when coalesce(nullif(assets.data ->> 'acquisition_cost', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
        then (assets.data ->> 'acquisition_cost')::numeric
      when coalesce(nullif(assets.data ->> 'book_cost', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
        then (assets.data ->> 'book_cost')::numeric
      when coalesce(nullif(assets.data ->> 'cost_basis', ''), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
        then (assets.data ->> 'cost_basis')::numeric
      else null
    end                                                                 as cost_basis
  from public.rental_current_assets assets
  inner join finance_access_gate on true
  cross join request_context req
  where req.request_role = 'service_role'
     or coalesce(nullif(assets.data ->> 'tenant', ''), 'default')
        = coalesce(nullif(req.request_tenant, ''), 'default')
),
-- Lifecycle journal entries per asset
lifecycle_events as (
  select
    je.source_record_id                  as asset_id,
    je.source_event_type,
    je.total_debit                       as event_amount,
    je.posting_basis
  from public.journal_entries je
  inner join finance_access_gate on true
  where je.source_event_type in (
      'asset_depreciation',
      'asset_recapitalization',
      'asset_disposal',
      'asset_sale'
    )
    and je.posting_status = 'posted'
),
-- Maintenance internal costs per asset (non-billable internal cost_total)
maintenance_costs as (
  select
    (ev.data ->> 'asset_id')::uuid    as asset_id,
    sum(mcl.cost_total)               as total_maintenance_cost
  from public.entities e
  inner join finance_access_gate on true
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  join public.maintenance_cost_lines mcl
    on mcl.maintenance_record_id = e.id
  where e.entity_type = 'maintenance_record'
    and coalesce(nullif(ev.data ->> 'asset_id', ''), '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  group by ev.data ->> 'asset_id'
),
-- Per-asset aggregation
asset_rollup as (
  select
    a.asset_category_id,
    a.asset_category_name,
    a.asset_id,
    coalesce(a.cost_basis, 0)                                                   as cost_basis,
    coalesce(mc.total_maintenance_cost, 0)                                      as maintenance_cost,
    coalesce(sum(le.event_amount) filter (where le.source_event_type = 'asset_depreciation'),    0) as accumulated_depreciation,
    coalesce(sum(le.event_amount) filter (where le.source_event_type = 'asset_recapitalization'), 0) as recapitalization_cost,
    coalesce(sum(le.event_amount) filter (where le.source_event_type = 'asset_disposal'),        0) as disposal_proceeds,
    coalesce(sum(le.event_amount) filter (where le.source_event_type = 'asset_sale'),            0) as sale_proceeds,
    count(le.asset_id)                                                           as lifecycle_event_count
  from scoped_assets a
  left join lifecycle_events le
    on le.asset_id = a.asset_id
  left join maintenance_costs mc
    on mc.asset_id = a.asset_id
  group by
    a.asset_category_id,
    a.asset_category_name,
    a.asset_id,
    a.cost_basis,
    mc.total_maintenance_cost
)
select
  ar.asset_category_id,
  ar.asset_category_name,
  count(ar.asset_id)                                          as owned_asset_count,
  sum(ar.cost_basis)                                          as total_acquisition_cost,
  sum(ar.accumulated_depreciation)                            as total_accumulated_depreciation,
  sum(ar.recapitalization_cost)                               as total_recapitalization_cost,
  sum(ar.maintenance_cost)                                    as total_maintenance_cost,
  sum(ar.disposal_proceeds)                                   as total_disposal_proceeds,
  sum(ar.sale_proceeds)                                       as total_sale_proceeds,
  sum(ar.cost_basis)
    - sum(ar.accumulated_depreciation)
    + sum(ar.recapitalization_cost)                           as net_book_value,
  sum(ar.lifecycle_event_count)::bigint                       as event_posting_count,
  'acquisition_cost: rental_current_assets.data(acquisition_cost|book_cost|cost_basis); '
    || 'accumulated_depreciation: journal_entries WHERE source_event_type=asset_depreciation; '
    || 'recapitalization_cost: journal_entries WHERE source_event_type=asset_recapitalization; '
    || 'maintenance_cost: maintenance_cost_lines.cost_total (internal, non-billable); '
    || 'disposal_proceeds: journal_entries WHERE source_event_type=asset_disposal; '
    || 'sale_proceeds: journal_entries WHERE source_event_type=asset_sale; '
    || 'net_book_value: acquisition_cost - accumulated_depreciation + recapitalization_cost'
                                                              as formula_reference
from asset_rollup ar
group by
  ar.asset_category_id,
  ar.asset_category_name;

revoke all on public.v_equipment_type_cost_ownership from public, anon;
grant select on public.v_equipment_type_cost_ownership to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. v_equipment_type_profitability
--    Profitability by equipment type combining lifetime revenue (from posted
--    invoice facts) with total ownership costs and disposal/sale outcomes.
--
--    Columns:
--      total_lifetime_revenue   — from entity_facts (asset_lifetime_revenue) per category
--      total_ownership_cost     — depreciation + recapitalization + maintenance
--      total_realised_proceeds  — disposal + sale proceeds
--      gross_profit             — lifetime_revenue + realised_proceeds - ownership_cost
--      gross_margin_pct         — gross_profit / (lifetime_revenue + realised_proceeds) * 100
--      profitability_status     — 'profitable' | 'breakeven' | 'unprofitable' | 'insufficient_data'
--
--    Finance-only: admin + branch_manager + service_role.
-- ---------------------------------------------------------------------------

create or replace view public.v_equipment_type_profitability
with (security_invoker = true) as
with request_context as (
  select
    coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') as request_role,
    public.ops_claim_app_role()                                                as app_role,
    public.get_my_tenant()                                                     as request_tenant
),
-- Finance-access gate: returns 1 row for service_role or admin/branch_manager,
-- 0 rows for every other role. INNER JOIN into every table-scanning CTE below
-- to enforce finance-only access on all direct view paths without exception.
finance_access_gate as (
  select 1 as ok
  from request_context req
  where req.request_role = 'service_role'
     or req.app_role in ('admin', 'branch_manager')
),
-- Lifetime revenue facts per asset (from entity_facts)
revenue_facts as (
  select
    ef.entity_id  as asset_id,
    ef.value      as lifetime_revenue
  from public.entity_facts ef
  inner join finance_access_gate on true
  join public.fact_types ft
    on ft.id = ef.fact_type_id
  where ft.key = 'asset_lifetime_revenue'
),
-- Base cost-ownership data (reuse logic from v_equipment_type_cost_ownership)
scoped_assets as (
  select
    assets.entity_id                                                    as asset_id,
    coalesce(nullif(assets.data ->> 'tenant', ''), 'default')          as asset_tenant,
    assets.current_asset_category_id                                    as asset_category_id,
    assets.current_asset_category_name                                  as asset_category_name
  from public.rental_current_assets assets
  inner join finance_access_gate on true
  cross join request_context req
  where req.request_role = 'service_role'
     or coalesce(nullif(assets.data ->> 'tenant', ''), 'default')
        = coalesce(nullif(req.request_tenant, ''), 'default')
),
lifecycle_events as (
  select
    je.source_record_id   as asset_id,
    je.source_event_type,
    je.total_debit        as event_amount
  from public.journal_entries je
  inner join finance_access_gate on true
  where je.source_event_type in (
      'asset_depreciation',
      'asset_recapitalization',
      'asset_disposal',
      'asset_sale'
    )
    and je.posting_status = 'posted'
),
maintenance_costs as (
  select
    (ev.data ->> 'asset_id')::uuid   as asset_id,
    sum(mcl.cost_total)              as total_maintenance_cost
  from public.entities e
  inner join finance_access_gate on true
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  join public.maintenance_cost_lines mcl
    on mcl.maintenance_record_id = e.id
  where e.entity_type = 'maintenance_record'
    and coalesce(nullif(ev.data ->> 'asset_id', ''), '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  group by ev.data ->> 'asset_id'
),
asset_profitability as (
  select
    a.asset_category_id,
    a.asset_category_name,
    a.asset_id,
    coalesce(rf.lifetime_revenue,    0)                                              as lifetime_revenue,
    coalesce(mc.total_maintenance_cost, 0)                                           as maintenance_cost,
    coalesce(sum(le.event_amount) filter (where le.source_event_type = 'asset_depreciation'),    0) as accumulated_depreciation,
    coalesce(sum(le.event_amount) filter (where le.source_event_type = 'asset_recapitalization'), 0) as recapitalization_cost,
    coalesce(sum(le.event_amount) filter (where le.source_event_type = 'asset_disposal'),        0) as disposal_proceeds,
    coalesce(sum(le.event_amount) filter (where le.source_event_type = 'asset_sale'),            0) as sale_proceeds
  from scoped_assets a
  left join lifecycle_events le
    on le.asset_id = a.asset_id
  left join maintenance_costs mc
    on mc.asset_id = a.asset_id
  left join revenue_facts rf
    on rf.asset_id = a.asset_id
  group by
    a.asset_category_id,
    a.asset_category_name,
    a.asset_id,
    rf.lifetime_revenue,
    mc.total_maintenance_cost
)
select
  ap.asset_category_id,
  ap.asset_category_name,
  count(ap.asset_id)                                                  as owned_asset_count,
  sum(ap.lifetime_revenue)                                            as total_lifetime_revenue,
  sum(ap.accumulated_depreciation)                                    as total_accumulated_depreciation,
  sum(ap.recapitalization_cost)                                       as total_recapitalization_cost,
  sum(ap.maintenance_cost)                                            as total_maintenance_cost,
  sum(ap.accumulated_depreciation)
    + sum(ap.recapitalization_cost)
    + sum(ap.maintenance_cost)                                        as total_ownership_cost,
  sum(ap.disposal_proceeds) + sum(ap.sale_proceeds)                  as total_realised_proceeds,
  sum(ap.lifetime_revenue)
    + sum(ap.disposal_proceeds)
    + sum(ap.sale_proceeds)
    - sum(ap.accumulated_depreciation)
    - sum(ap.recapitalization_cost)
    - sum(ap.maintenance_cost)                                        as gross_profit,
  case
    when (sum(ap.lifetime_revenue) + sum(ap.disposal_proceeds) + sum(ap.sale_proceeds)) > 0
      then round(
        (
          sum(ap.lifetime_revenue)
            + sum(ap.disposal_proceeds)
            + sum(ap.sale_proceeds)
            - sum(ap.accumulated_depreciation)
            - sum(ap.recapitalization_cost)
            - sum(ap.maintenance_cost)
        )
        / nullif(sum(ap.lifetime_revenue) + sum(ap.disposal_proceeds) + sum(ap.sale_proceeds), 0)
        * 100,
        2
      )
    else null
  end                                                                 as gross_margin_pct,
  case
    when sum(ap.lifetime_revenue) = 0
      and sum(ap.disposal_proceeds) = 0
      and sum(ap.sale_proceeds) = 0
      and sum(ap.accumulated_depreciation) = 0
      and sum(ap.recapitalization_cost) = 0
      and sum(ap.maintenance_cost) = 0
      then 'insufficient_data'
    when (
      sum(ap.lifetime_revenue)
        + sum(ap.disposal_proceeds)
        + sum(ap.sale_proceeds)
        - sum(ap.accumulated_depreciation)
        - sum(ap.recapitalization_cost)
        - sum(ap.maintenance_cost)
    ) > 0
      then 'profitable'
    when (
      sum(ap.lifetime_revenue)
        + sum(ap.disposal_proceeds)
        + sum(ap.sale_proceeds)
        - sum(ap.accumulated_depreciation)
        - sum(ap.recapitalization_cost)
        - sum(ap.maintenance_cost)
    ) = 0
      then 'breakeven'
    else 'unprofitable'
  end                                                                 as profitability_status,
  'total_lifetime_revenue: entity_facts(asset_lifetime_revenue); '
    || 'total_ownership_cost: depreciation + recapitalization + maintenance_cost; '
    || 'total_realised_proceeds: disposal_proceeds + sale_proceeds from journal_entries; '
    || 'gross_profit: total_lifetime_revenue + total_realised_proceeds - total_ownership_cost; '
    || 'all cost components trace to posted journal_entries or maintenance_cost_lines'
                                                                      as formula_reference
from asset_profitability ap
group by
  ap.asset_category_id,
  ap.asset_category_name;

revoke all on public.v_equipment_type_profitability from public, anon;
grant select on public.v_equipment_type_profitability to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. finance_get_equipment_cost_ownership
--    Guarded RPC for finance audience (admin + branch_manager).
--    Supports optional filter by asset_category_id.
--    Returns cost-of-ownership rows from v_equipment_type_cost_ownership.
-- ---------------------------------------------------------------------------

create or replace function public.finance_get_equipment_cost_ownership(
  p_asset_category_id uuid    default null,
  p_limit             integer default 100,
  p_offset            integer default 0
)
returns table (
  asset_category_id              uuid,
  asset_category_name            text,
  owned_asset_count              bigint,
  total_acquisition_cost         numeric,
  total_accumulated_depreciation numeric,
  total_recapitalization_cost    numeric,
  total_maintenance_cost         numeric,
  total_disposal_proceeds        numeric,
  total_sale_proceeds            numeric,
  net_book_value                 numeric,
  event_posting_count            bigint,
  formula_reference              text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_app_role     text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_app_role := coalesce(
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb
      -> 'app_metadata' ->> 'role',
    ''
  );

  if not (
    v_request_role = 'service_role'
    or (v_request_role = 'authenticated' and v_app_role in ('admin', 'branch_manager'))
  ) then
    raise exception 'finance_get_equipment_cost_ownership requires finance read access (admin or branch_manager)'
      using errcode = '42501';
  end if;

  return query
  select
    coo.asset_category_id,
    coo.asset_category_name,
    coo.owned_asset_count,
    coo.total_acquisition_cost,
    coo.total_accumulated_depreciation,
    coo.total_recapitalization_cost,
    coo.total_maintenance_cost,
    coo.total_disposal_proceeds,
    coo.total_sale_proceeds,
    coo.net_book_value,
    coo.event_posting_count,
    coo.formula_reference
  from public.v_equipment_type_cost_ownership coo
  where (p_asset_category_id is null or coo.asset_category_id = p_asset_category_id)
  order by coo.asset_category_name
  limit  coalesce(p_limit, 100)
  offset coalesce(p_offset, 0);
end;
$$;

revoke all on function public.finance_get_equipment_cost_ownership(uuid,integer,integer) from public, anon;
revoke execute on function public.finance_get_equipment_cost_ownership(uuid,integer,integer) from authenticated;
grant execute on function public.finance_get_equipment_cost_ownership(uuid,integer,integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Indexes to support lifecycle event aggregation queries
-- ---------------------------------------------------------------------------

create index if not exists idx_journal_entries_lifecycle_event_type
  on public.journal_entries (source_event_type, posting_status)
  where source_event_type in (
    'asset_depreciation',
    'asset_recapitalization',
    'asset_disposal',
    'asset_sale'
  );

create index if not exists idx_journal_entries_lifecycle_source_record
  on public.journal_entries (source_record_id, source_event_type)
  where source_event_type in (
    'asset_depreciation',
    'asset_recapitalization',
    'asset_disposal',
    'asset_sale'
  );
