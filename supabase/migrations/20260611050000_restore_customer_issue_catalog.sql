-- Restore customer_issue entity type and its relationship types to the catalog.
--
-- 20260610113000 replaced rental_entity_type_catalog without carrying forward
-- customer_issue (introduced in 20260610030000_crm_interaction_issue_timeline.sql).
-- 20260610160000_inventory_catalog_compatibility.sql (stock_item additions) ran
-- after the earlier restore attempt at 20260610132000 and dropped customer_issue
-- again.  This migration runs after all current main-branch catalog migrations
-- (latest: 20260611000000) and consolidates the final authoritative view.
--
-- This migration is replay-safe (create or replace); no tables or data are
-- modified.

-- Final consolidated entity type catalog: includes stock_item (from 20260610160000)
-- and customer_issue (from 20260610030000), plus all other established types.
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

-- Final consolidated relationship type catalog: includes stock-item relationships
-- (from 20260610160000) and CRM issue relationships (from 20260610030000).
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
    ('asset_has_maintenance_record',  'asset',           'maintenance_record'),
    ('asset_has_inspection',          'asset',           'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);
