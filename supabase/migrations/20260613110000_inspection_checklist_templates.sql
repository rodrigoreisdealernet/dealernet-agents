-- ---------------------------------------------------------------------------
-- Migration: inspection_checklist_templates
-- Purpose:   Provides tenant-configurable inspection checklist items that
--            extend the default frontend templates per equipment category and
--            inspection intent (pickup / return / both).
--
-- Design:
--   - tenant_id NULL  → applies to every tenant (system defaults).
--   - tenant_id set   → tenant-level customisation; merged with defaults at
--                       query time by the caller.
--   - Rows are additive; the frontend `applyChecklistTemplate` function merges
--     DB items with its built-in defaults, deduplicating by item_key.
-- ---------------------------------------------------------------------------

create table if not exists public.inspection_checklist_templates (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid,
  equipment_category  text        not null,
  inspection_intent   text        not null
                        check (inspection_intent in ('pickup', 'return', 'both')),
  item_key            text        not null,
  label               text        not null,
  section             text        not null default 'General',
  is_required         boolean     not null default false,
  sort_order          integer     not null default 0,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, equipment_category, inspection_intent, item_key)
);

comment on table public.inspection_checklist_templates is
  'Tenant-configurable checklist items that extend the built-in category templates. '
  'Rows with tenant_id NULL are system-wide defaults; tenant rows override or extend them.';

comment on column public.inspection_checklist_templates.tenant_id is
  'NULL = applies to all tenants. Set to a tenant entity_id for a tenant-specific item.';

comment on column public.inspection_checklist_templates.equipment_category is
  'Free-text category name matched case-insensitively against the asset category name '
  '(e.g. ''Excavators'', ''Forklifts''). Use ''*'' for items that apply to every category.';

comment on column public.inspection_checklist_templates.inspection_intent is
  'pickup = pre-hire checkout inspection; return = post-hire return inspection; both = either.';

comment on column public.inspection_checklist_templates.item_key is
  'Stable snake_case key used to deduplicate against the frontend built-in items.';

-- ---------------------------------------------------------------------------
-- Index: efficient per-tenant, per-category lookups
-- ---------------------------------------------------------------------------
create index if not exists idx_checklist_templates_lookup
  on public.inspection_checklist_templates (equipment_category, inspection_intent)
  where is_active;

create index if not exists idx_checklist_templates_tenant
  on public.inspection_checklist_templates (tenant_id, equipment_category)
  where is_active;

-- ---------------------------------------------------------------------------
-- Trigger: keep updated_at current
-- ---------------------------------------------------------------------------
create or replace function public.set_checklist_template_updated_at()
  returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_checklist_templates_updated_at
  on public.inspection_checklist_templates;

create trigger trg_checklist_templates_updated_at
  before update on public.inspection_checklist_templates
  for each row execute procedure public.set_checklist_template_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: authenticated users can read active templates scoped to their tenant
--      plus system-wide defaults (tenant_id IS NULL).
--      Only service_role may write (insert / update / delete).
-- ---------------------------------------------------------------------------
alter table public.inspection_checklist_templates enable row level security;

drop policy if exists "checklist_templates_read_authenticated"
  on public.inspection_checklist_templates;

-- Authenticated callers may read:
--   1. System-wide defaults (tenant_id IS NULL), AND
--   2. Rows that belong to their own tenant (matched via ops_tenant_match).
-- Inactive rows are excluded unconditionally.
create policy "checklist_templates_read_authenticated"
  on public.inspection_checklist_templates
  for select
  to authenticated
  using (
    is_active
    and (
      tenant_id is null
      or public.ops_tenant_match(tenant_id)
    )
  );

-- service_role may perform all write operations (used by admin migrations /
-- seed pipelines only — no authenticated insert/update/delete is exposed).
drop policy if exists "checklist_templates_write_service_role"
  on public.inspection_checklist_templates;

create policy "checklist_templates_write_service_role"
  on public.inspection_checklist_templates
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- View: v_checklist_template_items
--   Returns merged system-default + tenant items ready for the client.
--   Callers should filter by equipment_category and inspection_intent.
-- ---------------------------------------------------------------------------
create or replace view public.v_checklist_template_items
  with (security_invoker = true)
as
select
  t.id,
  t.tenant_id,
  t.equipment_category,
  t.inspection_intent,
  t.item_key,
  t.label,
  t.section,
  t.is_required,
  t.sort_order,
  t.is_active,
  t.created_at,
  t.updated_at
from public.inspection_checklist_templates t
where t.is_active
order by t.equipment_category, t.inspection_intent, t.sort_order, t.item_key;

comment on view public.v_checklist_template_items is
  'Active checklist template items, ordered for display. '
  'Filter by equipment_category and inspection_intent (or ''both'') when querying for a specific inspection.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Revoke broad defaults first to avoid accidental anon access.
revoke all on public.inspection_checklist_templates from anon;
revoke all on public.v_checklist_template_items    from anon;

-- Authenticated callers read via RLS-enforced policy above.
grant select on public.inspection_checklist_templates to authenticated;
grant select on public.v_checklist_template_items    to authenticated;

-- service_role gets full DML so seed pipelines and admin tooling can manage rows.
grant select, insert, update, delete on public.inspection_checklist_templates to service_role;
grant select                         on public.v_checklist_template_items    to service_role;
