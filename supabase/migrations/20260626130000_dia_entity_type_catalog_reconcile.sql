-- ===========================================================================
-- Reconcile rental_entity_type_catalog after the DIA batch (issues #5/#7/#8/#10).
--
-- WHY: the catalog is a security_invoker VALUES view, and every entity-CRUD
-- migration re-creates the WHOLE view with a hard-coded list. Those migrations
-- were authored in parallel (isolated worktrees), so each only listed the base
-- types plus its own. Applied in timestamp order, the LAST one (part_sale,
-- 20260626120000) won and silently dropped 'brand' (#5) and 'service_order' (#7)
-- from the catalog — their current-state views then returned nothing.
--
-- FIX: re-create the catalog ONE more time, last, with the COMPLETE union of all
-- base types plus every type the batch added: brand, service_order, part,
-- part_sale. Keep this migration last so it is the authoritative definition.
-- ===========================================================================

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
    ('vehicle'), ('brand'), ('service_order'), ('part'), ('part_sale')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;
