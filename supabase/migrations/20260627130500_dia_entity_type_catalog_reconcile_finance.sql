-- Reconcile rental_entity_type_catalog after adding DIA finance mirror types (#82).
-- This is the authoritative catalog re-creation for receivable/collection_contact.

create or replace view public.rental_entity_type_catalog
with (security_invoker = true) as
select entity_type
from (
  values
    ('company'), ('region'), ('branch'), ('project'),
    ('project_equipment_assignment'), ('customer'), ('billing_account'),
    ('contact'), ('job_site'), ('asset_category'), ('asset'), ('stock_item'),
    ('inventory_kit'), ('maintenance_record'), ('inspection'), ('rental_order'),
    ('rental_order_line'), ('rental_contract'), ('rental_contract_line'),
    ('invoice'), ('invoice_line'), ('transfer'), ('rate_card'), ('document'),
    ('note'), ('agent_config'), ('customer_issue'), ('requisition'),
    ('supplier'), ('purchase_order'),
    -- DIA dealership domain (batch issues #4/#5/#7/#8/#10)
    ('vehicle'), ('brand'), ('service_order'), ('part'), ('part_sale'),
    ('receivable'), ('collection_contact')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;
