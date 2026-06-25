-- ---------------------------------------------------------------------------
-- Restore transfer relationship types in rental_relationship_type_catalog
--
-- The three transfer relationship types (branch_has_transfer,
-- project_has_transfer, transfer_has_asset) introduced in migration
-- 20260613170000_cross_project_branch_transfers.sql were dropped from the
-- catalog by subsequent full rewrites in:
--   20260613212000_project_compliance_readiness_tracking.sql
--   20260614180000_project_hierarchy_mixed_fleet_allocation.sql
--
-- This migration recreates the view idempotently with all current relationship
-- types, including the three transfer types.
-- ---------------------------------------------------------------------------

create or replace view public.rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company_has_region',                         'company',                    'region'),
    ('region_has_branch',                          'region',                     'branch'),
    ('branch_has_project',                         'branch',                     'project'),
    ('project_inherits_requirements_from_project', 'project',                    'project'),
    ('project_has_asset',                          'project',                    'asset'),
    ('project_has_equipment_assignment',           'project',                    'project_equipment_assignment'),
    ('equipment_assignment_has_asset',             'project_equipment_assignment','asset'),
    ('branch_has_equipment_assignment',            'branch',                     'project_equipment_assignment'),
    ('customer_has_billing_account',               'customer',                   'billing_account'),
    ('customer_has_contact',                       'customer',                   'contact'),
    ('customer_has_job_site',                      'customer',                   'job_site'),
    ('customer_has_document',                      'customer',                   'document'),
    ('customer_has_note',                          'customer',                   'note'),
    ('customer_has_issue',                         'customer',                   'customer_issue'),
    ('billing_account_has_issue',                  'billing_account',            'customer_issue'),
    ('branch_has_asset',                           'branch',                     'asset'),
    ('asset_category_has_asset',                   'asset_category',             'asset'),
    ('branch_has_stock_item',                      'branch',                     'stock_item'),
    ('asset_category_has_stock_item',              'asset_category',             'stock_item'),
    ('kit_has_asset',                              'inventory_kit',              'asset'),
    ('kit_has_asset_category',                     'inventory_kit',              'asset_category'),
    ('kit_has_stock_item',                         'inventory_kit',              'stock_item'),
    ('asset_has_maintenance_record',               'asset',                      'maintenance_record'),
    ('asset_has_inspection',                       'asset',                      'inspection'),
    -- Transfer relationships (from 20260613170000_cross_project_branch_transfers)
    ('branch_has_transfer',                        'branch',                     'transfer'),
    ('project_has_transfer',                       'project',                    'transfer'),
    ('transfer_has_asset',                         'transfer',                   'asset')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);
