-- Catalog and portal-schedule reconciliation
--
-- Two pre-existing defects on main block CI:
--
-- 1. rental_entity_type_catalog / rental_relationship_type_catalog
--    Both 20260609150000_enterprise_org_hierarchy.sql and
--    20260609153000_enterprise_reporting_org_hierarchy.sql redefined these
--    views without carrying forward 'document', 'note', and the CRM
--    relationship types added by 20260609150000_crm_customer_profile_model.sql
--    (alphabetically earlier, so it runs first despite the same timestamp).
--    Symptom: "Unsupported rental entity type: note" during seed/tests.
--
-- 2. portal_get_contract_schedule uuid cast
--    v_current_assets.asset_id is uuid; v_rental_contract_line_current.asset_id
--    is text.  The LEFT JOIN used an uncast equality, producing
--    "operator does not exist: uuid = text" at runtime.
--
-- This migration uses timestamp 20260610010100 to follow the companion
-- catalog fix migration (20260610000100_fix_entity_catalog_and_schedule_join.sql).
-- All operations (CREATE OR REPLACE VIEW, DROP FUNCTION IF EXISTS,
-- CREATE OR REPLACE FUNCTION, REVOKE/GRANT) are idempotent on replay.
--
-- Rollback: re-apply 20260609200000_portal_schedule_access.sql (portal
-- function) and 20260609150000_enterprise_org_hierarchy.sql (catalog views).
-- No data is destroyed; both functions are read-only.

-- ---------------------------------------------------------------------------
-- 1. Reconcile rental_entity_type_catalog
--    Full union of every entity type introduced by prior migrations.
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
--    Full union including customer_has_document / customer_has_note that were
--    dropped when enterprise_org_hierarchy overwrote this view.
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
-- 3. Fix portal_get_contract_schedule uuid cast
--    The LEFT JOIN between v_current_assets.asset_id (uuid) and
--    v_rental_contract_line_current.asset_id (text) requires an explicit cast.
--    Also adds 'extensions' to search_path so that digest() (from pgcrypto,
--    which Supabase installs in the extensions schema) is resolvable inside
--    security-definer functions on both bare-postgres and Supabase stacks.
--    Safe to drop and recreate: function is read-only, no data is lost.
-- ---------------------------------------------------------------------------
drop function if exists public.portal_get_contract_schedule(uuid, text);

create or replace function public.portal_get_contract_schedule(
  p_contract_id uuid,
  p_scope_token text
)
returns table (
  contract_entity_id  text,
  contract_status     text,
  contract_number     text,
  line_entity_id      text,
  line_status         text,
  line_contract_id    text,
  line_asset_id       text,
  line_actual_start   text,
  line_actual_end     text,
  line_data           jsonb,
  asset_name          text,
  asset_status        text
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
begin
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'portal_get_contract_schedule requires anon, authenticated, or service_role access'
      using errcode = '42501';
  end if;

  if v_request_role <> 'service_role' then
    if nullif(btrim(coalesce(p_scope_token, '')), '') is null then
      raise exception 'Portal scope token is required'
        using errcode = '42501';
    end if;

    if not exists (
      select 1
      from public.portal_contract_scope_tokens s
      where s.contract_id = p_contract_id
        and s.token_hash = encode(digest(p_scope_token, 'sha256'), 'hex')
    ) then
      raise exception 'Portal scope token is invalid for this contract'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    c.entity_id::text                    as contract_entity_id,
    c.status                             as contract_status,
    c.contract_number                    as contract_number,
    l.entity_id::text                    as line_entity_id,
    l.status                             as line_status,
    l.contract_id::text                  as line_contract_id,
    l.asset_id::text                     as line_asset_id,
    l.actual_start                       as line_actual_start,
    l.actual_end                         as line_actual_end,
    l.data                               as line_data,
    a.name                               as asset_name,
    a.status                             as asset_status
  from public.v_rental_contract_current c
  left join public.v_rental_contract_line_current l
    on l.contract_id = c.entity_id::text
  left join public.v_current_assets a
    on a.asset_id::text = l.asset_id
  where c.entity_id = p_contract_id;
end;
$$;

revoke all on function public.portal_get_contract_schedule(uuid, text) from public;
grant execute on function public.portal_get_contract_schedule(uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Fix portal_get_demo_portal_url search_path
--    In Supabase's hosted/Docker stack pgcrypto is installed in the
--    'extensions' schema, not 'public'.  Security-definer functions with
--    set search_path = public, pg_temp cannot resolve digest() there.
--    Recreating with 'extensions' in the path fixes the Supabase CI
--    environment while remaining a no-op in bare-postgres stacks (missing
--    schema entries in search_path are silently ignored by PostgreSQL).
--    This function is read-only; no data is lost on recreate.
-- ---------------------------------------------------------------------------
create or replace function public.portal_get_demo_portal_url()
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_contract_id uuid;
  v_token_hash  text;
  v_demo_token  constant text := 'dia-demo-portal-scope-001';
begin
  -- Look up the demo contract entity ID
  select e.id
    into v_contract_id
  from public.entities e
  where e.entity_type = 'rental_contract'
    and e.source_record_id = 'demo-baseline-rental-contract-002'
  limit 1;

  if v_contract_id is null then
    return null;
  end if;

  -- Verify the demo scope token is registered for this contract
  select s.token_hash
    into v_token_hash
  from public.portal_contract_scope_tokens s
  where s.contract_id = v_contract_id
    and s.token_hash = encode(digest(v_demo_token, 'sha256'), 'hex');

  if not found then
    return null;
  end if;

  return format('/portal/schedule/%s?scope=%s', v_contract_id::text, v_demo_token);
end;
$$;

revoke all on function public.portal_get_demo_portal_url() from public;
grant execute on function public.portal_get_demo_portal_url() to service_role;
