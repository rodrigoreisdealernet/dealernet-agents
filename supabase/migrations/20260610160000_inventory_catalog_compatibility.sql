-- Restore inventory catalog compatibility after seed-catalog reconciliations.
--
-- Later catalog reconciliations redefined rental_entity_type_catalog and
-- rental_relationship_type_catalog without stock-item entries. The inventory
-- projection path and guard contracts require stock_item plus stock-item
-- relationship types to remain present.

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
    ('agent_config')
) as rental_entity_types(entity_type);

create or replace view public.rental_relationship_type_catalog
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
