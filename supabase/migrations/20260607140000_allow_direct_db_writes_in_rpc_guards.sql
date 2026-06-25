-- Fix: allow direct/no-JWT superuser DB connections (seed, migrations, bootstrap
-- job) to call the hardened write RPCs. 20260607133000 hardened them to require
-- request.jwt.claim.role = service_role | authenticated+role, but the demo-baseline
-- seed and rental test harness call these RPCs as supabase_admin/postgres over a
-- DIRECT connection (no PostgREST JWT, so request.jwt.claim.role = ''), which was
-- rejected -> seed/temporal validation failed and main went red. A direct DB
-- connection is already fully privileged (requires DB creds), so '' is a trusted
-- context. anon API requests carry role='anon' (not ''), so they remain blocked.
-- Regenerates the 3 functions identically to 20260607133000 with that one change.

-- Harden authenticated write path for UI and mobile workflows.
--
-- 1) Expand rental entity-type catalog to include rental order/contract workflow entities
--    used by authenticated write RPCs.
-- 2) Grant authenticated INSERT/UPDATE privileges on core write tables; RLS remains the
--    authoritative gate via role-aware policies from 20260607120000_user_roles_profiles.sql.
-- 3) Harden write RPCs as SECURITY DEFINER with pinned search_path and explicit caller
--    authorization checks to prevent anon/read_only privilege escalation.
-- 4) Tenant-claim scoping for these core entity read/write paths remains intentionally
--    deferred to #120/#110 (see ADR-0019). This migration preserves current single-tenant
--    semantics while closing authenticated-write auth bypass risks.
--
-- Rollback notes (manual):
--   A) Restore pre-hardening function/view definitions from
--      20260605154500_rental_master_data_foundation.sql
--   B) Revoke INSERT/UPDATE grants to authenticated on the write tables listed below
--   C) Restore prior function execute grants as needed for the target environment

create or replace view rental_entity_type_catalog as
select *
from (
  values
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
    ('rental_contract_line')
) as rental_entity_types(entity_type);

DO $$
DECLARE
  v_table text;
  v_write_tables constant text[] := ARRAY[
    'entities',
    'entity_versions',
    'relationships_v2',
    'fact_types',
    'entity_facts',
    'time_series_points'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_write_tables LOOP
    EXECUTE format('GRANT INSERT, UPDATE ON TABLE public.%I TO authenticated', v_table);
  END LOOP;
END;
$$;

create or replace function create_entity_with_version(
  p_entity_type text,
  p_data jsonb default '{}'::jsonb,
  p_source_record_id text default null
)
returns table (
  entity_id uuid,
  entity_version_id uuid,
  version_number int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_id uuid;
  v_entity_version_id uuid;
  v_version_number int;
  v_request_role text;
begin
  v_request_role := coalesce(current_setting('request.jwt.claim.role', true), '');

  if not (
    v_request_role in ('', 'service_role')
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager', 'field_operator')
    )
  ) then
    raise exception 'create_entity_with_version requires an authenticated user with write access'
      using errcode = '42501';
  end if;

  insert into entities (entity_type, source_record_id)
  values (p_entity_type, p_source_record_id)
  returning id into v_entity_id;

  insert into entity_versions (entity_id, version_number, data)
  values (v_entity_id, 1, coalesce(p_data, '{}'::jsonb))
  returning id, entity_versions.version_number
  into v_entity_version_id, v_version_number;

  entity_id := v_entity_id;
  entity_version_id := v_entity_version_id;
  version_number := v_version_number;
  return next;
end;
$$;

create or replace function rental_upsert_entity_current_state(
  p_entity_type text,
  p_data jsonb default '{}'::jsonb,
  p_entity_id uuid default null,
  p_source_record_id text default null
)
returns table (
  entity_id uuid,
  entity_version_id uuid,
  entity_type text,
  version_number int,
  data jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_id uuid;
  v_entity_type text;
  v_entity_version_id uuid;
  v_version_number int;
  v_request_role text;
  v_app_role public.app_role;
begin
  v_request_role := coalesce(current_setting('request.jwt.claim.role', true), '');
  v_app_role := public.get_my_role();

  if not (
    v_request_role in ('', 'service_role')
    or (
      v_request_role = 'authenticated'
      and (
        v_app_role in ('admin', 'branch_manager')
        or (
          v_app_role = 'field_operator'
          and p_entity_type in ('inspection', 'maintenance_record', 'rental_contract_line')
        )
      )
    )
  ) then
    raise exception 'rental_upsert_entity_current_state requires authenticated write access for this entity type'
      using errcode = '42501';
  end if;

  perform rental_assert_entity_type(p_entity_type);

  if p_entity_id is not null then
    v_entity_id := p_entity_id;
  elsif p_source_record_id is not null then
    select entities.id
      into v_entity_id
    from entities
    where entities.entity_type = p_entity_type
      and entities.source_record_id = p_source_record_id;
  end if;

  if v_entity_id is null then
    select created.entity_id, created.entity_version_id, created.version_number
      into v_entity_id, v_entity_version_id, v_version_number
    from create_entity_with_version(
      p_entity_type => p_entity_type,
      p_data => coalesce(p_data, '{}'::jsonb),
      p_source_record_id => p_source_record_id
    ) as created;
  else
    select entities.entity_type
      into v_entity_type
    from entities
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
    from entity_versions
    where entity_versions.entity_id = v_entity_id;

    insert into entity_versions (entity_id, version_number, data)
    values (v_entity_id, v_version_number, coalesce(p_data, '{}'::jsonb))
    returning id into v_entity_version_id;
  end if;

  entity_id := v_entity_id;
  entity_version_id := v_entity_version_id;
  entity_type := p_entity_type;
  version_number := v_version_number;
  data := coalesce(p_data, '{}'::jsonb);
  return next;
end;
$$;

create or replace function rental_upsert_relationship(
  p_relationship_type text,
  p_parent_id uuid,
  p_child_id uuid,
  p_metadata jsonb default '{}'::jsonb,
  p_valid_from timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_relationship_id uuid;
  v_request_role text;
begin
  v_request_role := coalesce(current_setting('request.jwt.claim.role', true), '');

  if not (
    v_request_role in ('', 'service_role')
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'rental_upsert_relationship requires authenticated manager write access'
      using errcode = '42501';
  end if;

  perform rental_assert_relationship(
    p_relationship_type => p_relationship_type,
    p_parent_id => p_parent_id,
    p_child_id => p_child_id
  );

  insert into relationships_v2 (
    relationship_type,
    parent_id,
    child_id,
    metadata,
    valid_from
  )
  values (
    p_relationship_type,
    p_parent_id,
    p_child_id,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_valid_from, now())
  )
  returning id into v_relationship_id;

  return v_relationship_id;
end;
$$;

revoke execute on function public.create_entity_with_version(text, jsonb, text) from public, anon;
revoke execute on function public.rental_upsert_entity_current_state(text, jsonb, uuid, text) from public, anon;
revoke execute on function public.rental_upsert_relationship(text, uuid, uuid, jsonb, timestamptz) from public, anon;

grant execute on function public.create_entity_with_version(text, jsonb, text) to authenticated, service_role;
grant execute on function public.rental_upsert_entity_current_state(text, jsonb, uuid, text) to authenticated, service_role;
grant execute on function public.rental_upsert_relationship(text, uuid, uuid, jsonb, timestamptz) to authenticated, service_role;
