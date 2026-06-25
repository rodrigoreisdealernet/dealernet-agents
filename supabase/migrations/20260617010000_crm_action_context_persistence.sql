-- CRM operator action context persistence.
-- Fixes two gaps preventing escalation and interaction-timeline from surviving
-- page reloads on the /crm/customers detail surface:
--
--   1. crm_entity_visible_to_caller returned false for CRM-created customers
--      that have no org_scope_id (not yet linked to a branch/org hierarchy).
--      This caused crm_customer_communication_timeline and
--      crm_customer_issue_current to return zero rows for those customers,
--      hiding timeline events and issue context from operators after reload.
--
--   2. crm_upsert_customer_profile stored last_interaction_type /
--      last_interaction_summary only in the entity version snapshot.
--      The crm_customer_communication_timeline view reads from
--      time_series_points, so logged interactions were never surfaced in the
--      timeline and did not persist across reloads.
--
-- Both fixes align with crm_customer_profile_current, which already exposes
-- customers with null org_scope_id to authenticated operators.

-- ---------------------------------------------------------------------------
-- 1. crm_entity_visible_to_caller: allow null org_scope_id.
--    CRM-only customers created without a branch/org context carry a null
--    org_scope_id.  They should be visible to all authenticated operators,
--    consistent with how crm_customer_profile_current handles the same class.
-- ---------------------------------------------------------------------------
create or replace function public.crm_entity_visible_to_caller(p_entity_id uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_org_scope_id uuid;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );

  if v_request_role = 'service_role' then
    return true;
  end if;

  select e.org_scope_id
    into v_org_scope_id
  from public.entities e
  where e.id = p_entity_id;

  -- Entities with no org_scope_id are CRM-only records not yet linked to a
  -- branch; treat them as visible to all authenticated callers, consistent
  -- with how crm_customer_profile_current handles the same case.
  if v_org_scope_id is null then
    return true;
  end if;

  return exists (
    select 1
    from public.entities company_e
    join public.entity_versions company_ev
      on company_ev.entity_id = company_e.id
     and company_ev.is_current
    join public.org_scope_closure osc
      on osc.ancestor_id = company_e.id
     and osc.descendant_id = v_org_scope_id
    where company_e.entity_type = 'company'
      and company_ev.data ->> 'tenant' = public.get_my_tenant()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. crm_upsert_customer_profile: persist interactions to time_series_points.
--    When p_data carries last_interaction_type and last_interaction_summary,
--    write a time_series_points entry so the communication timeline view
--    surfaces the event durably (survives page reload).
--    Interaction-type to fact-type key mapping:
--      email   → customer_email_sent
--      sms     → customer_sms_sent
--      call    → customer_call_logged   (default)
--      meeting → customer_call_logged
--      note    → customer_call_logged
-- ---------------------------------------------------------------------------
create or replace function crm_upsert_customer_profile(
  p_source_record_id text,
  p_data             jsonb     default '{}'::jsonb,
  p_enrich_only      boolean   default false
)
returns table (
  entity_id         uuid,
  entity_version_id uuid,
  version_number    int,
  data              jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_id           uuid;
  v_entity_version_id   uuid;
  v_version_number      int;
  v_current_data        jsonb;
  v_merged_data         jsonb;
  v_request_role        text;
  v_interaction_type    text;
  v_interaction_summary text;
  v_fact_type_key       text;
  v_fact_type_id        uuid;
  v_now                 timestamptz := now();
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager', 'field_operator')
    )
  ) then
    raise exception 'crm_upsert_customer_profile requires authenticated write access'
      using errcode = '42501';
  end if;

  -- Look up existing customer by stable key.
  select e.id
    into v_entity_id
  from entities e
  where e.entity_type = 'customer'
    and e.source_record_id = p_source_record_id;

  if v_entity_id is null then
    -- New customer: delegate to the shared create helper.
    select created.entity_id, created.entity_version_id, created.version_number
      into v_entity_id, v_entity_version_id, v_version_number
    from create_entity_with_version(
      p_entity_type      => 'customer',
      p_data             => coalesce(p_data, '{}'::jsonb),
      p_source_record_id => p_source_record_id
    ) as created;

    entity_id         := v_entity_id;
    entity_version_id := v_entity_version_id;
    version_number    := v_version_number;
    data              := coalesce(p_data, '{}'::jsonb);
    return next;
    return;
  end if;

  -- Existing customer: read current snapshot.
  select ev.data
    into v_current_data
  from entity_versions ev
  where ev.entity_id = v_entity_id
    and ev.is_current;

  if p_enrich_only then
    -- Merge: existing fields preserved; incoming non-null values win.
    v_merged_data := coalesce(v_current_data, '{}'::jsonb) || coalesce(p_data, '{}'::jsonb);
  else
    v_merged_data := coalesce(p_data, '{}'::jsonb);
  end if;

  -- Write a new SCD2 version only if the payload has actually changed.
  if v_merged_data is distinct from coalesce(v_current_data, '{}'::jsonb) then
    select coalesce(max(ev.version_number), 0) + 1
      into v_version_number
    from entity_versions ev
    where ev.entity_id = v_entity_id;

    insert into entity_versions (entity_id, version_number, data)
    values (v_entity_id, v_version_number, v_merged_data)
    returning id into v_entity_version_id;
  else
    -- No change: return current version metadata without writing.
    select ev.id, ev.version_number
      into v_entity_version_id, v_version_number
    from entity_versions ev
    where ev.entity_id = v_entity_id
      and ev.is_current;
  end if;

  entity_id         := v_entity_id;
  entity_version_id := v_entity_version_id;
  version_number    := v_version_number;
  data              := v_merged_data;
  return next;

  -- Persist a time_series_points entry when an interaction was logged, so
  -- crm_customer_communication_timeline surfaces it after reload.
  v_interaction_type    := nullif(trim(p_data ->> 'last_interaction_type'), '');
  v_interaction_summary := nullif(trim(p_data ->> 'last_interaction_summary'), '');

  if v_interaction_type is not null and v_interaction_summary is not null then
    v_fact_type_key := case v_interaction_type
      when 'email' then 'customer_email_sent'
      when 'sms'   then 'customer_sms_sent'
      else              'customer_call_logged'
    end;

    select id into v_fact_type_id
    from public.fact_types
    where key = v_fact_type_key;

    if v_fact_type_id is not null then
      insert into public.time_series_points
        (entity_id, fact_type_id, observed_at, data_payload, source_id)
      values (
        v_entity_id,
        v_fact_type_id,
        v_now,
        jsonb_build_object(
          'summary',          v_interaction_summary,
          'interaction_type', v_interaction_type
        ),
        p_source_record_id
      );
    end if;
  end if;
end;
$$;

grant execute on function crm_upsert_customer_profile(text, jsonb, boolean) to authenticated;
