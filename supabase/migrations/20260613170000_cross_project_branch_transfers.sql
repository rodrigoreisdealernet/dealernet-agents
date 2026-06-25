-- Cross-project and cross-branch equipment transfer support (issue #1487).
--
-- Adds:
--   1. project entity type to rental_entity_type_catalog
--   2. Transfer-related relationship types (branch_has_transfer, project_has_transfer,
--      transfer_has_asset) so origin/destination branch or project and the asset
--      involved can be navigated via rental_current_relationships.
--   3. v_transfer_current — current state of every transfer entity with origin/
--      destination branch and project context, asset info, lifecycle status,
--      timestamps, and the responsible user who last acted.
--   4. v_transfer_history — one row per SCD2 version per transfer, providing a
--      full timeline of status transitions used by project-facing history views.

-- ---------------------------------------------------------------------------
-- 1. Entity type catalog: add project
-- ---------------------------------------------------------------------------

create or replace view public.rental_entity_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company'),
    ('region'),
    ('branch'),
    ('project'),
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
    ('customer_issue'),
    ('requisition'),
    ('supplier'),
    ('purchase_order')
) as rental_entity_types(entity_type);

-- ---------------------------------------------------------------------------
-- 2. Relationship type catalog: add transfer relationships
-- ---------------------------------------------------------------------------

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
    ('asset_has_inspection',          'asset',           'inspection'),
    -- Transfer relationships
    ('branch_has_transfer',           'branch',          'transfer'),
    ('project_has_transfer',          'project',         'transfer'),
    ('transfer_has_asset',            'transfer',        'asset')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

-- ---------------------------------------------------------------------------
-- 3. v_transfer_current
--
-- Current state of every transfer entity.  One row per transfer.
-- Columns:
--   transfer_entity_id, transfer_id, status, asset_id, asset_scope,
--   origin_branch_id, origin_branch_name, destination_branch_id, destination_branch_name,
--   origin_project_id, origin_project_name, destination_project_id, destination_project_name,
--   requested_by, approved_by, dispatched_by, received_by,
--   requested_ship_date, expected_receive_date, actual_ship_at, actual_receive_at,
--   sourcing_decision_id, internal_cost, transfer_exception_reason,
--   created_at, updated_at, data
-- ---------------------------------------------------------------------------

create or replace view public.v_transfer_current
with (security_invoker = true) as
select
  t.entity_id                                        as transfer_entity_id,
  t.source_record_id                                 as transfer_id,
  coalesce(t.data ->> 'status', 'requested')         as status,

  -- Asset
  t.data ->> 'asset_id'                              as asset_id,
  t.data ->> 'asset_scope'                           as asset_scope,

  -- Origin branch
  t.data ->> 'origin_branch_id'                      as origin_branch_id,
  ob.name                                            as origin_branch_name,

  -- Destination branch
  t.data ->> 'destination_branch_id'                 as destination_branch_id,
  db_branch.name                                     as destination_branch_name,

  -- Origin project (optional; null for branch-only transfers)
  t.data ->> 'origin_project_id'                     as origin_project_id,
  op.name                                            as origin_project_name,

  -- Destination project (optional)
  t.data ->> 'destination_project_id'                as destination_project_id,
  dp.name                                            as destination_project_name,

  -- Responsible users (stored in JSONB data by workflow activities)
  t.data ->> 'requested_by'                          as requested_by,
  t.data ->> 'approved_by'                           as approved_by,
  t.data ->> 'dispatched_by'                         as dispatched_by,
  t.data ->> 'received_by'                           as received_by,

  -- Dates / schedules
  nullif(t.data ->> 'requested_ship_date', '')       as requested_ship_date,
  nullif(t.data ->> 'expected_receive_date', '')     as expected_receive_date,
  nullif(t.data ->> 'actual_ship_at', '')::timestamptz as actual_ship_at,
  nullif(t.data ->> 'actual_receive_at', '')::timestamptz as actual_receive_at,

  -- Sourcing / costing
  t.data ->> 'sourcing_decision_id'                  as sourcing_decision_id,
  nullif(t.data ->> 'internal_cost', '')::numeric    as internal_cost,
  t.data ->> 'transfer_exception_reason'             as transfer_exception_reason,

  t.created_at,
  t.updated_at,
  t.data
from rental_current_entity_state t
left join rental_current_entity_state ob
  on ob.entity_id = nullif(t.data ->> 'origin_branch_id', '')::uuid
 and ob.entity_type = 'branch'
left join rental_current_entity_state db_branch
  on db_branch.entity_id = nullif(t.data ->> 'destination_branch_id', '')::uuid
 and db_branch.entity_type = 'branch'
left join rental_current_entity_state op
  on op.entity_id = nullif(t.data ->> 'origin_project_id', '')::uuid
 and op.entity_type = 'project'
left join rental_current_entity_state dp
  on dp.entity_id = nullif(t.data ->> 'destination_project_id', '')::uuid
 and dp.entity_type = 'project'
where t.entity_type = 'transfer';

-- ---------------------------------------------------------------------------
-- 4. v_transfer_history
--
-- All SCD2 versions of every transfer entity, providing a full timeline of
-- status transitions.  Each row represents one version (one lifecycle event).
-- Columns match v_transfer_current plus per-version metadata:
--   version_id, version_number, transitioned_at, valid_to, is_current.
-- Used by project-facing history panels.
-- ---------------------------------------------------------------------------

create or replace view public.v_transfer_history
with (security_invoker = true) as
select
  ev.entity_id                                         as transfer_entity_id,
  e.source_record_id                                   as transfer_id,
  ev.id                                                as version_id,
  ev.version_number,
  coalesce(ev.data ->> 'status', 'requested')          as status,
  ev.data ->> 'asset_id'                               as asset_id,
  ev.data ->> 'asset_scope'                            as asset_scope,
  ev.data ->> 'origin_branch_id'                       as origin_branch_id,
  ob.name                                              as origin_branch_name,
  ev.data ->> 'destination_branch_id'                  as destination_branch_id,
  db_branch.name                                       as destination_branch_name,
  ev.data ->> 'origin_project_id'                      as origin_project_id,
  op.name                                              as origin_project_name,
  ev.data ->> 'destination_project_id'                 as destination_project_id,
  dp.name                                              as destination_project_name,
  ev.data ->> 'requested_by'                           as requested_by,
  ev.data ->> 'approved_by'                            as approved_by,
  ev.data ->> 'dispatched_by'                          as dispatched_by,
  ev.data ->> 'received_by'                            as received_by,
  nullif(ev.data ->> 'requested_ship_date', '')        as requested_ship_date,
  nullif(ev.data ->> 'expected_receive_date', '')      as expected_receive_date,
  nullif(ev.data ->> 'actual_ship_at', '')::timestamptz as actual_ship_at,
  nullif(ev.data ->> 'actual_receive_at', '')::timestamptz as actual_receive_at,
  ev.data ->> 'sourcing_decision_id'                   as sourcing_decision_id,
  nullif(ev.data ->> 'internal_cost', '')::numeric     as internal_cost,
  ev.data ->> 'transfer_exception_reason'              as transfer_exception_reason,
  ev.valid_from                                        as transitioned_at,
  ev.valid_to,
  ev.is_current,
  ev.created_at,
  ev.data
from entity_versions ev
join entities e on e.id = ev.entity_id
join rental_entity_type_catalog etc on etc.entity_type = e.entity_type
left join rental_current_entity_state ob
  on ob.entity_id = nullif(ev.data ->> 'origin_branch_id', '')::uuid
 and ob.entity_type = 'branch'
left join rental_current_entity_state db_branch
  on db_branch.entity_id = nullif(ev.data ->> 'destination_branch_id', '')::uuid
 and db_branch.entity_type = 'branch'
left join rental_current_entity_state op
  on op.entity_id = nullif(ev.data ->> 'origin_project_id', '')::uuid
 and op.entity_type = 'project'
left join rental_current_entity_state dp
  on dp.entity_id = nullif(ev.data ->> 'destination_project_id', '')::uuid
 and dp.entity_type = 'project'
where e.entity_type = 'transfer'
order by ev.entity_id, ev.version_number;

-- ---------------------------------------------------------------------------
-- 5. Access control
--
-- Both views use security_invoker = true so they run under the caller's role
-- and honour the base-table RLS policies on rental_current_entity_state,
-- entity_versions, and entities.
-- anon must not be able to read transfer data through these views.
-- ---------------------------------------------------------------------------

revoke all on public.v_transfer_current  from anon;
revoke all on public.v_transfer_history  from anon;

grant select on public.v_transfer_current  to authenticated, service_role;
grant select on public.v_transfer_history  to authenticated, service_role;
