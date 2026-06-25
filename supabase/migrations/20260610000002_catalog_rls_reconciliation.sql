-- Catalog and RLS reconciliation
--
-- Two migrations share timestamp 20260609150000, so alphabetical ordering
-- causes enterprise_org_hierarchy to run after crm_customer_profile_model
-- and overwrite rental_entity_type_catalog / rental_relationship_type_catalog
-- without carrying forward 'note', 'document', and the CRM relationship types.
-- Additionally, 20260609153000_enterprise_reporting_org_hierarchy used
-- USING (true) on org_scope_closure_authenticated_read, breaking the
-- cross-tenant isolation guarantee.
--
-- This migration is replay-safe (create or replace / drop ... if exists):
--   - Restores the full merged entity-type and relationship-type catalogs.
--   - Replaces org_scope_closure_authenticated_read with the correct
--     tenant-scoped policy body.
--
-- Design: additive-only; no tables, columns, or data are removed.

-- ---------------------------------------------------------------------------
-- 1. Reconcile rental_entity_type_catalog
--    Full union of every entity type introduced by prior migrations:
--      core rental types, CRM types (document, note),
--      enterprise org types (company, region),
--      financial types (invoice, invoice_line, transfer, rate_card), and
--      agent_config.
-- ---------------------------------------------------------------------------
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
    ('maintenance_record'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line'),
    ('invoice'),
    ('invoice_line'),
    ('document'),
    ('note'),
    ('transfer'),
    ('rate_card'),
    ('agent_config')
) as rental_entity_types(entity_type);

-- ---------------------------------------------------------------------------
-- 2. Reconcile rental_relationship_type_catalog
--    Full union of every relationship type introduced by prior migrations,
--    including the CRM customer_has_document / customer_has_note types that
--    were dropped when enterprise_org_hierarchy overwrote this view.
-- ---------------------------------------------------------------------------
create or replace view public.rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company_has_region',            'company',        'region'),
    ('region_has_branch',             'region',         'branch'),
    ('customer_has_billing_account',  'customer',       'billing_account'),
    ('customer_has_contact',          'customer',       'contact'),
    ('customer_has_job_site',         'customer',       'job_site'),
    ('customer_has_document',         'customer',       'document'),
    ('customer_has_note',             'customer',       'note'),
    ('branch_has_asset',              'branch',         'asset'),
    ('asset_category_has_asset',      'asset_category', 'asset'),
    ('asset_has_maintenance_record',  'asset',          'maintenance_record'),
    ('asset_has_inspection',          'asset',          'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

-- ---------------------------------------------------------------------------
-- 3. Restore the tenant-scoped RLS policy on org_scope_closure
--    20260609153000_enterprise_reporting_org_hierarchy replaced the correct
--    USING clause with USING (true), removing all cross-tenant isolation.
--    This block drops that bare policy and recreates it with the full
--    tenant/role guard originally defined in 20260609150000_enterprise_org_hierarchy.
-- ---------------------------------------------------------------------------
drop policy if exists org_scope_closure_authenticated_read on public.org_scope_closure;
create policy org_scope_closure_authenticated_read
  on public.org_scope_closure
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    -- Enforce the caller's tenant/org boundary.
    -- Walk relationships_v2 upward (max 2 hops: branch→region→company or
    -- region→company or company self) to find the root company for this row's
    -- ancestor, then check entity_versions.data->>'tenant' against the caller's
    -- JWT app_metadata.tenant claim (get_my_tenant()).  Rows whose ancestor
    -- cannot be traced to a company the caller owns are invisible.
    and exists (
      select 1
      from   public.entities       company_e
      join   public.entity_versions company_ev
               on company_ev.entity_id = company_e.id and company_ev.is_current
      where  company_e.entity_type          = 'company'
        and  company_ev.data ->> 'tenant'   = public.get_my_tenant()
        and  (
               -- The row's ancestor IS the company (self-row at depth=0).
               company_e.id = org_scope_closure.ancestor_id
               -- The row's ancestor is a region directly under this company.
               or exists (
                 select 1 from public.relationships_v2 r
                 where  r.relationship_type = 'company_has_region'
                   and  r.parent_id         = company_e.id
                   and  r.child_id          = org_scope_closure.ancestor_id
                   and  r.is_current
               )
               -- The row's ancestor is a branch two hops from the company via region.
               or exists (
                 select 1
                 from   public.relationships_v2 r_rb
                 join   public.relationships_v2 r_cr
                          on r_cr.relationship_type = 'company_has_region'
                         and r_cr.parent_id         = company_e.id
                         and r_cr.is_current
                 where  r_rb.relationship_type = 'region_has_branch'
                   and  r_rb.parent_id         = r_cr.child_id
                   and  r_rb.child_id          = org_scope_closure.ancestor_id
                   and  r_rb.is_current
               )
             )
    )
  );
