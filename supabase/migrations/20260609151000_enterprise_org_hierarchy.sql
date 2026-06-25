-- Enterprise org hierarchy: company → region → branch
--
-- Adds company and region entity/relationship types, an org_scope_id column on
-- entities, a closure table (org_scope_closure) for ancestor/descendant lookups,
-- triggers to maintain the closure and propagate scope, views for hierarchy
-- traversal and per-scope config resolution, and a backfill for existing data.
--
-- Design: additive only; no existing branch-centric read paths are broken.

-- ---------------------------------------------------------------------------
-- 1. Extend entity-type and relationship-type catalogs (additive only)
--    Includes all pre-existing types plus new company/region org-hierarchy types.
-- ---------------------------------------------------------------------------
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
    ('maintenance_record'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line'),
    ('agent_config')
) as rental_entity_types(entity_type);

create or replace view rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company_has_region',            'company',        'region'),
    ('region_has_branch',             'region',         'branch'),
    ('customer_has_billing_account',  'customer',       'billing_account'),
    ('customer_has_contact',          'customer',       'contact'),
    ('customer_has_job_site',         'customer',       'job_site'),
    ('branch_has_asset',              'branch',         'asset'),
    ('asset_category_has_asset',      'asset_category', 'asset'),
    ('asset_has_maintenance_record',  'asset',          'maintenance_record'),
    ('asset_has_inspection',          'asset',          'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

-- ---------------------------------------------------------------------------
-- 2. Add org_scope_id to entities
--    For org-scope entities (company/region/branch): points to themselves.
--    For operational entities: points to the branch that owns them.
--    Additive and nullable; existing rows get backfilled below.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'entities'
      and column_name  = 'org_scope_id'
  ) then
    alter table public.entities
      add column org_scope_id uuid references public.entities(id) on delete set null;
  end if;
end;
$$;

create index if not exists idx_entities_org_scope_id
  on public.entities (org_scope_id)
  where org_scope_id is not null;

-- ---------------------------------------------------------------------------
-- 3. org_scope_closure: standard closure-table for hierarchy traversal
--    Rows: (ancestor_id, descendant_id, depth)
--    Each scope entity has a self-row at depth=0.
--    When a parent→child relationship is added the trigger inserts all
--    (ancestor-of-parent, descendant-of-child) pairs.
-- ---------------------------------------------------------------------------
create table if not exists public.org_scope_closure (
  ancestor_id   uuid not null references public.entities(id) on delete cascade,
  descendant_id uuid not null references public.entities(id) on delete cascade,
  depth         int  not null default 0,
  created_at    timestamptz not null default now(),
  constraint pk_org_scope_closure primary key (ancestor_id, descendant_id),
  constraint chk_org_scope_closure_depth check (depth >= 0)
);

create index if not exists idx_org_scope_closure_descendant
  on public.org_scope_closure (descendant_id);

-- ---------------------------------------------------------------------------
-- 4. RLS and permissions for org_scope_closure
--    anon has no access; authenticated callers must hold a valid app role AND
--    may only read rows whose ancestor entity belongs to their own tenant's
--    company subtree (tenant claim from JWT app_metadata.tenant).
-- ---------------------------------------------------------------------------
alter table public.org_scope_closure enable row level security;

revoke all on table public.org_scope_closure from public, anon;
revoke select on table public.org_scope_closure from anon;
grant select on table public.org_scope_closure to authenticated;
grant select, insert, update, delete on table public.org_scope_closure to service_role;

-- Remove any previously created anon policy (replay safety).
drop policy if exists org_scope_closure_anon_read on public.org_scope_closure;

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

drop policy if exists org_scope_closure_service_role_all on public.org_scope_closure;
create policy org_scope_closure_service_role_all
  on public.org_scope_closure
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- 5. Trigger: when a company/region/branch entity is inserted,
--    (a) set org_scope_id = NEW.id (BEFORE), and
--    (b) insert the self-row into org_scope_closure (AFTER).
-- ---------------------------------------------------------------------------
create or replace function fn_entities_set_org_scope_self()
returns trigger as $$
begin
  if new.entity_type in ('company', 'region', 'branch') then
    new.org_scope_id := new.id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_entities_set_org_scope_self on public.entities;
create trigger trg_entities_set_org_scope_self
  before insert on public.entities
  for each row execute function fn_entities_set_org_scope_self();

create or replace function fn_entities_org_scope_closure_self()
returns trigger as $$
begin
  if new.entity_type in ('company', 'region', 'branch') then
    insert into public.org_scope_closure (ancestor_id, descendant_id, depth)
    values (new.id, new.id, 0)
    on conflict (ancestor_id, descendant_id) do nothing;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_entities_org_scope_closure_self on public.entities;
create trigger trg_entities_org_scope_closure_self
  after insert on public.entities
  for each row execute function fn_entities_org_scope_closure_self();

-- ---------------------------------------------------------------------------
-- 6. Trigger: when a company_has_region or region_has_branch relationship
--    is inserted, expand the closure table for the new edge.
-- ---------------------------------------------------------------------------
create or replace function fn_relationships_v2_org_scope_closure()
returns trigger as $$
begin
  if new.relationship_type in ('company_has_region', 'region_has_branch') then
    -- Insert (ancestor-of-parent, descendant-of-child, combined-depth) pairs.
    insert into public.org_scope_closure (ancestor_id, descendant_id, depth)
    select a.ancestor_id, d.descendant_id, a.depth + d.depth + 1
    from public.org_scope_closure a
    join public.org_scope_closure d on true
    where a.descendant_id = new.parent_id
      and d.ancestor_id   = new.child_id
    on conflict (ancestor_id, descendant_id) do nothing;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_relationships_v2_org_scope_closure on public.relationships_v2;
create trigger trg_relationships_v2_org_scope_closure
  after insert on public.relationships_v2
  for each row
  when (new.relationship_type in ('company_has_region', 'region_has_branch'))
  execute function fn_relationships_v2_org_scope_closure();

-- ---------------------------------------------------------------------------
-- 7. Trigger: when branch_has_asset is inserted, propagate the branch's
--    org_scope_id to the asset entity.
-- ---------------------------------------------------------------------------
create or replace function fn_relationships_v2_asset_org_scope()
returns trigger as $$
begin
  if new.relationship_type = 'branch_has_asset' and new.is_current then
    update public.entities
       set org_scope_id = new.parent_id
     where id = new.child_id;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_relationships_v2_asset_org_scope on public.relationships_v2;
create trigger trg_relationships_v2_asset_org_scope
  after insert on public.relationships_v2
  for each row
  when (new.relationship_type = 'branch_has_asset')
  execute function fn_relationships_v2_asset_org_scope();

-- ---------------------------------------------------------------------------
-- 8. Views
-- ---------------------------------------------------------------------------

-- v_org_scope_hierarchy: full closure with name/type annotations
create or replace view v_org_scope_hierarchy
with (security_invoker = true) as
select
  osc.ancestor_id,
  ae.entity_type  as ancestor_entity_type,
  aev.data ->> 'name' as ancestor_name,
  osc.descendant_id,
  de.entity_type  as descendant_entity_type,
  dev.data ->> 'name' as descendant_name,
  osc.depth
from public.org_scope_closure osc
join public.entities ae  on ae.id  = osc.ancestor_id
join public.entity_versions aev
     on aev.entity_id = ae.id and aev.is_current
join public.entities de  on de.id  = osc.descendant_id
join public.entity_versions dev
     on dev.entity_id = de.id and dev.is_current;

revoke all on table public.v_org_scope_hierarchy from public, anon;
grant select on table public.v_org_scope_hierarchy to authenticated, service_role;

-- v_org_scope_config: raw per-scope config values from entity_versions.data,
-- scoped to the caller's tenant via org_scope_closure.
create or replace view v_org_scope_config
with (security_invoker = true) as
select
  e.id    as scope_id,
  e.entity_type,
  ev.data ->> 'name'                  as name,
  ev.data ->> 'default_currency_code' as default_currency_code,
  ev.data ->> 'locale_code'           as locale_code,
  ev.data ->> 'tax_region_code'       as tax_region_code,
  ev.data ->> 'timezone'              as timezone,
  ev.data                             as full_config
from public.entities e
join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
where e.entity_type in ('company', 'region', 'branch')
  -- Limit to entities reachable from the caller's visible closure rows.
  -- org_scope_closure RLS (security_invoker) enforces the tenant boundary.
  and exists (
    select 1 from public.org_scope_closure osc
    where osc.descendant_id = e.id
  );

revoke all on table public.v_org_scope_config from public, anon;
grant select on table public.v_org_scope_config to authenticated, service_role;

-- rental_current_companies: convenience current-state view for company entities,
-- scoped to the caller's tenant via org_scope_closure.
create or replace view rental_current_companies
with (security_invoker = true) as
select rce.*
from rental_current_entity_state rce
where rce.entity_type = 'company'
  and exists (
    select 1 from public.org_scope_closure osc
    where osc.descendant_id = rce.entity_id
  );

revoke all on table public.rental_current_companies from public, anon;
grant select on table public.rental_current_companies to authenticated, service_role;

-- rental_current_regions: convenience current-state view for region entities,
-- scoped to the caller's tenant via org_scope_closure.
create or replace view rental_current_regions
with (security_invoker = true) as
select rce.*
from rental_current_entity_state rce
where rce.entity_type = 'region'
  and exists (
    select 1 from public.org_scope_closure osc
    where osc.descendant_id = rce.entity_id
  );

revoke all on table public.rental_current_regions from public, anon;
grant select on table public.rental_current_regions to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. org_scope_effective_config: resolves inherited config for a given scope.
--    For each config key the value at the lowest depth (self first) wins.
-- ---------------------------------------------------------------------------
create or replace function org_scope_effective_config(p_scope_id uuid)
returns table (
  default_currency_code text,
  locale_code           text,
  tax_region_code       text,
  timezone              text
) as $$
  select
    (
      select ev.data ->> 'default_currency_code'
      from   public.org_scope_closure osc
      join   public.entity_versions ev
             on ev.entity_id = osc.ancestor_id and ev.is_current
      where  osc.descendant_id = p_scope_id
        and  ev.data ->> 'default_currency_code' is not null
      order  by osc.depth asc
      limit  1
    ) as default_currency_code,
    (
      select ev.data ->> 'locale_code'
      from   public.org_scope_closure osc
      join   public.entity_versions ev
             on ev.entity_id = osc.ancestor_id and ev.is_current
      where  osc.descendant_id = p_scope_id
        and  ev.data ->> 'locale_code' is not null
      order  by osc.depth asc
      limit  1
    ) as locale_code,
    (
      select ev.data ->> 'tax_region_code'
      from   public.org_scope_closure osc
      join   public.entity_versions ev
             on ev.entity_id = osc.ancestor_id and ev.is_current
      where  osc.descendant_id = p_scope_id
        and  ev.data ->> 'tax_region_code' is not null
      order  by osc.depth asc
      limit  1
    ) as tax_region_code,
    (
      select ev.data ->> 'timezone'
      from   public.org_scope_closure osc
      join   public.entity_versions ev
             on ev.entity_id = osc.ancestor_id and ev.is_current
      where  osc.descendant_id = p_scope_id
        and  ev.data ->> 'timezone' is not null
      order  by osc.depth asc
      limit  1
    ) as timezone;
$$ language sql;

-- ---------------------------------------------------------------------------
-- 10. Backfill existing data
-- ---------------------------------------------------------------------------

-- 10a. Self-rows in org_scope_closure for existing scope entities
insert into public.org_scope_closure (ancestor_id, descendant_id, depth)
select id, id, 0
from   public.entities
where  entity_type in ('company', 'region', 'branch')
on conflict (ancestor_id, descendant_id) do nothing;

-- 10b. org_scope_id = self for existing branch/region/company entities
update public.entities
   set org_scope_id = id
 where entity_type in ('company', 'region', 'branch')
   and org_scope_id is distinct from id;

-- 10c. org_scope_id for assets: use their current branch via branch_has_asset
update public.entities e
   set org_scope_id = r.parent_id
  from public.relationships_v2 r
 where r.child_id          = e.id
   and r.relationship_type = 'branch_has_asset'
   and r.is_current
   and e.org_scope_id is distinct from r.parent_id;

-- 10d. Backfill tenant claim on existing company entity versions.
--      Only companies whose current version has no 'tenant' key are updated
--      (the is null guard prevents overwriting any explicitly-set tenant).
--      In the current single-tenant deployment all pre-existing companies
--      belong to 'default'; multi-tenant environments should create companies
--      with an explicit 'tenant' value in p_data so this backfill is a no-op.
--      The RLS policy for org_scope_closure requires
--      entity_versions.data->>'tenant' to match the caller's JWT tenant claim,
--      so any company without this field would be invisible to authenticated
--      users even after the app role check passes.
update public.entity_versions ev
   set data = ev.data || jsonb_build_object('tenant', 'default')
  from public.entities e
 where e.id             = ev.entity_id
   and e.entity_type    = 'company'
   and ev.is_current
   and ev.data ->> 'tenant' is null;
