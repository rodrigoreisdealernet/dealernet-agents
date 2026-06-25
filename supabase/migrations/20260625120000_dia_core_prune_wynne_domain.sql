-- DIA core prune — remove the inherited Wynne equipment-rental domain
-- Created: 2026-06-25
-- Purpose: the schema was seeded from the Wynne (RentalMan) equipment-rental
-- platform. The reusable asset for DIA (Dealernet Intelligence Agents) is NOT the
-- rental domain — it is the Operations Factory pattern over a generic entity model.
-- This migration prunes the schema to that core. See
-- docs/specs/supabase-schema-review-dia.md for the full review and rationale.
--
-- What is KEPT (the DIA platform):
--   * Generic entity model (SCD2): entities / entity_versions / relationships_v2
--   * Analytics: fact_types / entity_facts / time_series_points
--   * Operations Factory: tenants / ops_agent_config / ops_workflow_run / finding /
--     invoice_adjustment_draft / credit_change_proposal / ops_output_schema_registry
--   * Auth/roles: profiles ; portal scope tokens ; fx_rates
--   * The portal read-views (ops_* + v_home_dashboard_kpis) and the entity-model
--     views/RPCs they and the seed depend on.
--
-- What is DROPPED (~108 Wynne domain tables + their dedicated views/functions/
--   triggers): integration connectors (coupa/samsara/visionlink/netsuite/billtrust/
--   sage/powerbi/smartequip/mulesoft/descartes + framework), procurement, accounting/
--   ledger/tax, dispatch/logistics/field, maintenance, rerent, projects, compliance,
--   credit/lien, quoting, billing-update, storefront, CRM, org-scope hierarchy.
--
-- Strategy: allowlist-driven. Anything in `public` not on a keep list is dropped
-- (CASCADE). The few entity-model write RPCs that carried Wynne side-effects
-- (org-scope closure, rerent custody logging) are redefined clean afterwards so the
-- generic write-path keeps working. Idempotent and replayable on deployed dev/UAT.

do $$
declare
  -- DIA-core tables. Everything else in public is dropped.
  keep_tables constant text[] := array[
    'entities','entity_versions','relationships_v2',
    'fact_types','entity_facts','time_series_points',
    'profiles',
    'tenants','ops_agent_config','ops_workflow_run','finding',
    'invoice_adjustment_draft','credit_change_proposal','ops_output_schema_registry',
    'portal_contract_scope_tokens','portal_intake_scope_tokens','fx_rates'
  ];
  -- Views the portal reads + the entity-model views in their dependency closure
  -- (verified via pg_depend) + the two type catalogs the write RPCs assert against.
  keep_views constant text[] := array[
    'ops_findings_view','ops_finding_kpis','ops_agent_status_view',
    'ops_audit_trail_view','ops_agent_config_current','v_home_dashboard_kpis',
    'rental_current_assets','rental_current_asset_categories','rental_current_branches',
    'rental_current_entity_state','rental_entity_type_catalog','rental_relationship_type_catalog',
    'v_asset_active_down_state','v_rental_contract_line_current'
  ];
  -- Functions needed by the seed, the kept views, the kept triggers, RLS and auth.
  -- refresh_org_scope_closure / refresh_entity_org_scopes are retained here only so
  -- the drop succeeds; they are redefined as no-ops below.
  keep_funcs constant text[] := array[
    'create_entity_with_version','delete_entity','rental_upsert_entity_current_state',
    'rental_upsert_relationship','rental_assert_relationship','rental_assert_entity_type',
    'derive_entity_org_scope_id','refresh_org_scope_closure','refresh_entity_org_scopes',
    'set_entity_version_validity','set_relationship_current_flag','update_updated_at',
    'set_timestamp_entity_facts','set_timestamp_fact_types','set_timestamp_time_series_points',
    'get_my_role','get_my_tenant','handle_new_user','keycloak_groups_to_role',
    'ops_claims_json','ops_claim_tenant_key','ops_claim_app_role','ops_tenant_match',
    'parse_uuid_or_null','parse_date_or_null','parse_numeric_or_null'
  ];
  r record;
begin
  -- 1) Drop non-kept VIEWS first (kept views depend only on kept tables/views, so
  --    nothing on the keep list is collateral here).
  for r in
    select table_name
    from information_schema.views
    where table_schema = 'public'
      and not (table_name = any(keep_views))
  loop
    execute format('drop view if exists public.%I cascade', r.table_name);
  end loop;

  -- 2) Drop non-kept TABLES (CASCADE removes any remaining dependent objects).
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and not (tablename = any(keep_tables))
  loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;

  -- 3) Drop non-kept FUNCTIONS (CASCADE also removes the Wynne triggers they back
  --    on the kept core tables — org-scope-closure population, rental-analytics
  --    refresh, live-yard feed touches, single-asset-assignment enforcement).
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not (p.proname = any(keep_funcs))
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

-- 4) Decouple the retained entity-model write-path from the dropped Wynne tables.

-- The org-scope hierarchy (org_scope_closure + closure triggers) is gone. The
-- generic write RPCs still set entities.org_scope_id directly via
-- derive_entity_org_scope_id, so the closure-refresh helpers become no-ops rather
-- than being removed (callers and the seed still invoke them).
create or replace function public.refresh_org_scope_closure()
  returns void
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$ begin return; end; $$;

create or replace function public.refresh_entity_org_scopes()
  returns void
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$ begin return; end; $$;

-- Redefine the entity upsert RPC without the rerent custody-log side-effect
-- (rerent_unit_status_log was dropped). Body is identical to the shipped version
-- minus the trailing external-rerent block.
create or replace function public.rental_upsert_entity_current_state(
  p_entity_type text,
  p_data jsonb default '{}'::jsonb,
  p_entity_id uuid default null::uuid,
  p_source_record_id text default null::text
)
returns table(entity_id uuid, entity_version_id uuid, entity_type text, version_number integer, data jsonb)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_entity_id uuid;
  v_entity_type text;
  v_entity_version_id uuid;
  v_version_number int;
  v_request_role text;
  v_app_role public.app_role;
  v_org_scope_id uuid;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );
  v_app_role := public.get_my_role();

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and (
        v_app_role in ('admin', 'branch_manager')
        or (
          v_app_role = 'field_operator'
          and p_entity_type in ('asset', 'inspection', 'maintenance_record', 'rental_contract_line')
        )
      )
    )
  ) then
    raise exception 'rental_upsert_entity_current_state requires authenticated write access for this entity type'
      using errcode = '42501';
  end if;

  perform public.rental_assert_entity_type(p_entity_type);

  if p_entity_id is not null then
    v_entity_id := p_entity_id;
  elsif p_source_record_id is not null then
    select entities.id
      into v_entity_id
    from public.entities
    where entities.entity_type = p_entity_type
      and entities.source_record_id = p_source_record_id;
  end if;

  if v_entity_id is null then
    select created.entity_id, created.entity_version_id, created.version_number
      into v_entity_id, v_entity_version_id, v_version_number
    from public.create_entity_with_version(
      p_entity_type => p_entity_type,
      p_data => coalesce(p_data, '{}'::jsonb),
      p_source_record_id => p_source_record_id
    ) as created;
  else
    select entities.entity_type
      into v_entity_type
    from public.entities
    where entities.id = v_entity_id;

    if not found then
      raise exception 'Unknown rental entity: %', v_entity_id
        using errcode = '22023';
    end if;

    if v_entity_type <> p_entity_type then
      raise exception
        'Entity % has type % but % was requested',
        v_entity_id,
        v_entity_type,
        p_entity_type
        using errcode = '22023';
    end if;

    select coalesce(max(entity_versions.version_number), 0) + 1
      into v_version_number
    from public.entity_versions
    where entity_versions.entity_id = v_entity_id;

    insert into public.entity_versions (entity_id, version_number, data)
    values (v_entity_id, v_version_number, coalesce(p_data, '{}'::jsonb))
    returning id into v_entity_version_id;
  end if;

  v_org_scope_id := case
    when p_entity_type in ('company', 'region', 'branch') then v_entity_id
    else public.derive_entity_org_scope_id(p_entity_type, coalesce(p_data, '{}'::jsonb))
  end;

  update public.entities
     set org_scope_id = v_org_scope_id
   where id = v_entity_id
     and org_scope_id is distinct from v_org_scope_id;

  entity_id := v_entity_id;
  entity_version_id := v_entity_version_id;
  entity_type := p_entity_type;
  version_number := v_version_number;
  data := coalesce(p_data, '{}'::jsonb);
  return next;
end;
$function$;
