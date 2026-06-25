-- Rental order-to-contract workflow schema
-- Created: 2025-12-10
-- Purpose: domain-specific dimension tables, fact_type seed rows, and helper
--          views for the equipment rental order/contract lifecycle.
--
-- Design notes:
--   * All business entities (rental_order, rental_order_line, rental_contract,
--     rental_contract_line, asset, asset_category) are stored as rows in the
--     core `entities` table with SCD2 snapshots in `entity_versions`.
--   * This migration adds only:
--       1. Dimension tables for stable lookup values (order status, contract
--          status, line item status, asset availability status, rate type,
--          rental type).
--       2. Seed rows for each dimension.
--       3. `fact_types` seed rows for the domain.
--       4. Indexes on `entities` to support efficient lookups by entity_type.
--       5. A helper view `v_rental_order_current` and
--          `v_rental_contract_current` for convenience.
--   * No new base tables are created; the core entity/SCD2 model is reused.

-- -------------------------------------------------------------------------
-- 1. Dimension: rental_order_status
-- -------------------------------------------------------------------------
create table if not exists dim_rental_order_status (
    id          uuid primary key default gen_random_uuid(),
    key         text not null unique,   -- e.g. 'draft', 'quoted', …
    label       text not null,
    description text,
    sort_order  int  not null default 0,
    is_terminal boolean not null default false,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create or replace function update_dim_rental_order_status_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_dim_rental_order_status_updated_at
    before update on dim_rental_order_status
    for each row execute function update_dim_rental_order_status_updated_at();

insert into dim_rental_order_status (key, label, description, sort_order, is_terminal)
values
    ('draft',     'Draft',     'Initial creation; editable, not committed',                    1, false),
    ('quoted',    'Quoted',    'Pricing calculated and sent to requester',                     2, false),
    ('approved',  'Approved',  'Approved for fulfilment; asset assignment can begin',          3, false),
    ('converted', 'Converted', 'Terminal state; a rental contract has been created',           4, true),
    ('cancelled', 'Cancelled', 'Voided before approval or conversion',                         5, true),
    ('expired',   'Expired',   'Quote period lapsed without approval',                         6, true)
on conflict (key) do nothing;

-- -------------------------------------------------------------------------
-- 2. Dimension: rental_contract_status
-- -------------------------------------------------------------------------
create table if not exists dim_rental_contract_status (
    id          uuid primary key default gen_random_uuid(),
    key         text not null unique,
    label       text not null,
    description text,
    sort_order  int  not null default 0,
    is_terminal boolean not null default false,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create or replace function update_dim_rental_contract_status_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_dim_rental_contract_status_updated_at
    before update on dim_rental_contract_status
    for each row execute function update_dim_rental_contract_status_updated_at();

insert into dim_rental_contract_status (key, label, description, sort_order, is_terminal)
values
    ('pending_execution', 'Pending Execution', 'Created from order conversion; awaiting checkout', 1, false),
    ('active',            'Active',            'At least one line item has been checked out',       2, false),
    ('closed',            'Closed',            'All line items returned; rental usage complete',    3, true),
    ('cancelled',         'Cancelled',         'Contract voided before or during execution',        4, true)
on conflict (key) do nothing;

-- -------------------------------------------------------------------------
-- 3. Dimension: rental_line_status  (shared by order lines and contract lines)
-- -------------------------------------------------------------------------
create table if not exists dim_rental_line_status (
    id          uuid primary key default gen_random_uuid(),
    key         text not null unique,
    label       text not null,
    description text,
    sort_order  int  not null default 0,
    is_terminal boolean not null default false,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create or replace function update_dim_rental_line_status_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_dim_rental_line_status_updated_at
    before update on dim_rental_line_status
    for each row execute function update_dim_rental_line_status_updated_at();

insert into dim_rental_line_status (key, label, description, sort_order, is_terminal)
values
    ('pending',      'Pending',      'Line created; awaiting checkout',             1, false),
    ('checked_out',  'Checked Out',  'Asset has been checked out',                  2, false),
    ('returned',     'Returned',     'Asset has been returned; usage period closed', 3, true),
    ('cancelled',    'Cancelled',    'Line was cancelled',                           4, true)
on conflict (key) do nothing;

-- -------------------------------------------------------------------------
-- 4. Dimension: asset_availability_status
-- -------------------------------------------------------------------------
create table if not exists dim_asset_availability_status (
    id             uuid primary key default gen_random_uuid(),
    key            text not null unique,
    label          text not null,
    description    text,
    blocks_checkout boolean not null default false,
    sort_order     int  not null default 0,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

create or replace function update_dim_asset_availability_status_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_dim_asset_availability_status_updated_at
    before update on dim_asset_availability_status
    for each row execute function update_dim_asset_availability_status_updated_at();

insert into dim_asset_availability_status (key, label, description, blocks_checkout, sort_order)
values
    ('available',             'Available',             'Asset is ready for checkout',                  false, 1),
    ('on_transfer',           'On Transfer',           'Asset is in transit between locations',        true,  2),
    ('in_maintenance',        'In Maintenance',        'Asset is undergoing maintenance',              true,  3),
    ('on_inspection_hold',    'On Inspection Hold',    'Asset held pending safety/compliance check',   true,  4),
    ('retired',               'Retired',               'Asset has been permanently decommissioned',    true,  5),
    ('lost',                  'Lost',                  'Asset has been reported lost or stolen',       true,  6),
    ('conflicting_assignment','Conflicting Assignment','Asset is already checked out on another line', true,  7)
on conflict (key) do nothing;

-- -------------------------------------------------------------------------
-- 5. Dimension: rental_rate_type
-- -------------------------------------------------------------------------
create table if not exists dim_rental_rate_type (
    id         uuid primary key default gen_random_uuid(),
    key        text not null unique,
    label      text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create or replace function update_dim_rental_rate_type_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_dim_rental_rate_type_updated_at
    before update on dim_rental_rate_type
    for each row execute function update_dim_rental_rate_type_updated_at();

insert into dim_rental_rate_type (key, label)
values
    ('daily',   'Daily'),
    ('weekly',  'Weekly'),
    ('monthly', 'Monthly'),
    ('fixed',   'Fixed')
on conflict (key) do nothing;

-- -------------------------------------------------------------------------
-- 6. Dimension: rental_type  (internal vs external)
-- -------------------------------------------------------------------------
create table if not exists dim_rental_type (
    id          uuid primary key default gen_random_uuid(),
    key         text not null unique,
    label       text not null,
    description text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create or replace function update_dim_rental_type_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_dim_rental_type_updated_at
    before update on dim_rental_type
    for each row execute function update_dim_rental_type_updated_at();

insert into dim_rental_type (key, label, description)
values
    ('internal', 'Internal', 'Asset moved between internal cost centres; no external invoice'),
    ('external', 'External', 'Asset rented to external customer; triggers downstream invoicing')
on conflict (key) do nothing;

-- -------------------------------------------------------------------------
-- 7. fact_types seed for rental domain
-- Prerequisite: 20251203090000_analytics_foundation.sql must have run first
-- (it creates the fact_types table used here).
-- -------------------------------------------------------------------------
insert into fact_types (key, label, description, unit)
values
    ('rental_order_count',    'Rental Order Count',    'Number of rental orders',    'count'),
    ('rental_contract_count', 'Rental Contract Count', 'Number of rental contracts', 'count'),
    ('rental_line_duration_days', 'Rental Line Duration (days)',
        'Actual rental duration in days for a contract line', 'days'),
    ('rental_line_rate_amount', 'Rental Line Rate Amount',
        'Rate amount in minor currency units for a contract line', 'minor_currency')
on conflict (key) do nothing;

-- -------------------------------------------------------------------------
-- 8. Index: fast lookup of entities by type  (additive; safe if exists)
-- -------------------------------------------------------------------------
create index if not exists idx_entities_type
    on entities (entity_type);

-- -------------------------------------------------------------------------
-- 9. Convenience views
-- -------------------------------------------------------------------------

-- Current state of all rental orders
create or replace view v_rental_order_current as
select
    e.id                                              as entity_id,
    ev.id                                             as version_id,
    ev.version_number,
    ev.data->>'status'                                as status,
    ev.data->>'order_number'                          as order_number,
    ev.data->>'rental_type'                           as rental_type,
    ev.data->>'requester_id'                          as requester_id,
    (ev.data->>'created_by')                          as created_by,
    ev.valid_from,
    ev.valid_to,
    ev.data                                           as data
from entities e
join entity_versions ev on ev.entity_id = e.id and ev.is_current
where e.entity_type = 'rental_order';

-- Current state of all rental contracts
create or replace view v_rental_contract_current as
select
    e.id                                              as entity_id,
    ev.id                                             as version_id,
    ev.version_number,
    ev.data->>'status'                                as status,
    ev.data->>'contract_number'                       as contract_number,
    ev.data->>'order_id'                              as order_id,
    ev.data->>'rental_type'                           as rental_type,
    ev.valid_from,
    ev.valid_to,
    ev.data                                           as data
from entities e
join entity_versions ev on ev.entity_id = e.id and ev.is_current
where e.entity_type = 'rental_contract';

-- Current state of all rental contract lines
create or replace view v_rental_contract_line_current as
select
    e.id                                              as entity_id,
    ev.id                                             as version_id,
    ev.version_number,
    ev.data->>'status'                                as status,
    ev.data->>'contract_id'                           as contract_id,
    ev.data->>'asset_id'                              as asset_id,
    ev.data->>'category_id'                           as category_id,
    ev.data->>'rental_type'                           as rental_type,
    ev.data->>'rate_type'                             as rate_type,
    (ev.data->>'rate_amount')::numeric                as rate_amount,
    ev.data->>'actual_start'                          as actual_start,
    ev.data->>'actual_end'                            as actual_end,
    ev.valid_from,
    ev.valid_to,
    ev.data                                           as data
from entities e
join entity_versions ev on ev.entity_id = e.id and ev.is_current
where e.entity_type = 'rental_contract_line';
