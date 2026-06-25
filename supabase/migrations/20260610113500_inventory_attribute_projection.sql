-- Inventory attribute projection and stock-item relationship assignments.
-- Additive extension over rental master-data model.

insert into fact_types (key, label, description, unit)
values (
  'inventory_condition_observation',
  'Inventory Condition Observation',
  'Append-only condition observations for inventory records',
  'condition_state'
)
on conflict (key) do nothing;

create or replace view rental_entity_type_catalog
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
    ('maintenance_record'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line'),
    ('transfer'),
    ('rate_card'),
    ('document'),
    ('note'),
    ('invoice'),
    ('invoice_line'),
    ('agent_config')
) as rental_entity_types(entity_type);

create or replace view rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company_has_region', 'company', 'region'),
    ('region_has_branch', 'region', 'branch'),
    ('customer_has_billing_account', 'customer', 'billing_account'),
    ('customer_has_contact', 'customer', 'contact'),
    ('customer_has_job_site', 'customer', 'job_site'),
    ('customer_has_document', 'customer', 'document'),
    ('customer_has_note', 'customer', 'note'),
    ('branch_has_asset', 'branch', 'asset'),
    ('asset_category_has_asset', 'asset_category', 'asset'),
    ('branch_has_stock_item', 'branch', 'stock_item'),
    ('asset_category_has_stock_item', 'asset_category', 'stock_item'),
    ('asset_has_maintenance_record', 'asset', 'maintenance_record'),
    ('asset_has_inspection', 'asset', 'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

create or replace function rental_enforce_single_asset_assignment()
returns trigger as $$
begin
  if new.relationship_type in (
    'branch_has_asset',
    'asset_category_has_asset',
    'branch_has_stock_item',
    'asset_category_has_stock_item'
  ) then
    update relationships_v2
       set is_current = false,
           valid_to = coalesce(new.valid_from, now())
     where relationship_type = new.relationship_type
       and child_id = new.child_id
       and is_current = true
       and id <> new.id;
  end if;

  return new;
end;
$$ language plpgsql;

-- Rollback plan (DROP safety): this migration recreates the trigger immediately
-- below; to revert behavior, restore the prior trigger definition from the
-- previous migration state in 20260605154500_rental_master_data_foundation.sql.
drop trigger if exists trg_relationships_v2_rental_single_asset_assignment on relationships_v2;

create trigger trg_relationships_v2_rental_single_asset_assignment
before insert on relationships_v2
for each row
when (
  new.relationship_type in (
    'branch_has_asset',
    'asset_category_has_asset',
    'branch_has_stock_item',
    'asset_category_has_stock_item'
  )
)
execute function rental_enforce_single_asset_assignment();

create unique index if not exists uq_relationships_current_branch_has_stock_item
  on relationships_v2 (child_id)
  where relationship_type = 'branch_has_stock_item'
    and is_current;

create unique index if not exists uq_relationships_current_asset_category_has_stock_item
  on relationships_v2 (child_id)
  where relationship_type = 'asset_category_has_stock_item'
    and is_current;

create or replace view rental_current_stock_items
with (security_invoker = true) as
select *
from rental_current_entity_state
where entity_type = 'stock_item';

create or replace view rental_current_inventory_records
with (security_invoker = true) as
with inventory_entities as (
  select *
  from rental_current_entity_state
  where entity_type in ('asset', 'stock_item')
),
current_branch_assignments as (
  select
    relationships_v2.child_id as inventory_id,
    relationships_v2.parent_id as branch_id
  from relationships_v2
  where relationships_v2.is_current
    and relationships_v2.relationship_type in ('branch_has_asset', 'branch_has_stock_item')
),
current_category_assignments as (
  select
    relationships_v2.child_id as inventory_id,
    relationships_v2.parent_id as asset_category_id
  from relationships_v2
  where relationships_v2.is_current
    and relationships_v2.relationship_type in ('asset_category_has_asset', 'asset_category_has_stock_item')
),
latest_meter_observation as (
  select distinct on (tsp.entity_id)
    tsp.entity_id,
    tsp.observed_at,
    tsp.data_payload
  from time_series_points tsp
  join fact_types ft on ft.id = tsp.fact_type_id
  where ft.key = 'asset_meter_reading'
  order by tsp.entity_id, tsp.observed_at desc, tsp.created_at desc
),
latest_condition_observation as (
  select distinct on (tsp.entity_id)
    tsp.entity_id,
    tsp.observed_at,
    tsp.data_payload
  from time_series_points tsp
  join fact_types ft on ft.id = tsp.fact_type_id
  where ft.key = 'inventory_condition_observation'
  order by tsp.entity_id, tsp.observed_at desc, tsp.created_at desc
)
select
  inventory_entities.entity_id,
  inventory_entities.entity_type,
  inventory_entities.source_record_id,
  inventory_entities.entity_version_id,
  inventory_entities.version_number,
  inventory_entities.valid_from,
  inventory_entities.valid_to,
  inventory_entities.data,
  inventory_entities.name,
  inventory_entities.created_at,
  inventory_entities.updated_at,
  current_branch_assignments.branch_id as current_branch_id,
  rental_current_branches.name as current_branch_name,
  current_category_assignments.asset_category_id as current_asset_category_id,
  rental_current_asset_categories.name as current_asset_category_name,
  case
    when inventory_entities.entity_type = 'asset' then coalesce(nullif(inventory_entities.data ->> 'inventory_kind', ''), 'serialized')
    else coalesce(nullif(inventory_entities.data ->> 'inventory_kind', ''), 'bulk')
  end as inventory_kind,
  inventory_entities.data ->> 'make' as make,
  inventory_entities.data ->> 'model' as model,
  inventory_entities.data ->> 'fuel_type' as fuel_type,
  inventory_entities.data ->> 'meter_type' as meter_type,
  coalesce(
    latest_meter_observation.data_payload,
    case
      when nullif(inventory_entities.data ->> 'latest_meter_value', '') is null then null
      else jsonb_build_object(
        'reading_value', nullif(inventory_entities.data ->> 'latest_meter_value', ''),
        'reading_unit', nullif(inventory_entities.data ->> 'latest_meter_unit', ''),
        'observed_at', nullif(inventory_entities.data ->> 'latest_meter_observed_at', '')
      )
    end
  ) as latest_meter_metadata,
  coalesce(
    latest_condition_observation.data_payload ->> 'condition',
    nullif(inventory_entities.data ->> 'condition', '')
  ) as condition,
  coalesce(
    case
      when jsonb_typeof(inventory_entities.data -> 'specs') = 'object' then inventory_entities.data -> 'specs'
      else null
    end,
    '{}'::jsonb
  ) as specs,
  coalesce(
    case
      when jsonb_typeof(inventory_entities.data -> 'tags') = 'array' then inventory_entities.data -> 'tags'
      else null
    end,
    '[]'::jsonb
  ) as tags,
  inventory_entities.data ->> 'operational_status' as operational_status,
  coalesce(latest_condition_observation.observed_at, latest_meter_observation.observed_at) as latest_observed_at
from inventory_entities
left join current_branch_assignments
  on current_branch_assignments.inventory_id = inventory_entities.entity_id
left join rental_current_branches
  on rental_current_branches.entity_id = current_branch_assignments.branch_id
left join current_category_assignments
  on current_category_assignments.inventory_id = inventory_entities.entity_id
left join rental_current_asset_categories
  on rental_current_asset_categories.entity_id = current_category_assignments.asset_category_id
left join latest_meter_observation
  on latest_meter_observation.entity_id = inventory_entities.entity_id
left join latest_condition_observation
  on latest_condition_observation.entity_id = inventory_entities.entity_id;
