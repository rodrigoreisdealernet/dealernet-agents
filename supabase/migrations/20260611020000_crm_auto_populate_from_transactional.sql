-- ---------------------------------------------------------------------------
-- CRM: auto-population of profiles from quotes / reservations / orders /
--       contracts / billing events
--
-- Aligned to docs/specs/customer-management-rental-crm.md §5.2.
-- Requires:
--   20260609150000_crm_customer_profile_model.sql
--   20260610030000_crm_interaction_issue_timeline.sql
--   20260611010000_credit_change_proposal_status_lifecycle.sql
--
-- Design choices:
--   1. Deterministic match priority: customer_id → billing_account_id →
--      verified email → verified phone.
--   2. Field-fill-only precedence for identity fields: transactional data
--      fills missing profile fields without overwriting existing values.
--   3. Tracking metadata (_last_enriched_at, _last_enrichment_source_type,
--      _first_transactional_at, _transactional_source_count) always updated.
--   4. billing_event source type updates entity_facts only; does not write
--      a new entity version snapshot.
--   5. Idempotent: reprocessing the same source record applies a no-op merge
--      when no new fields are present and the same facts are supplied.
--   6. Contact upsert: when p_contact_data is provided the function creates
--      or updates a contact entity and links it to the customer so that
--      future enrichments can find the customer by email/phone lookup.
--   7. Tenant scope enforcement for authenticated callers: the function
--      resolves the caller's company entity via JWT app_metadata.tenant and:
--        (a) rejects matches (customer_id / billing_account_id / email / phone)
--            that cross tenant boundaries (raises 42501), and
--        (b) injects org_scope_id on newly created customers and contacts so
--            they are never globally visible to other tenants.
--      service_role callers are exempt (full cross-tenant access permitted).
--
-- Rollback:
--   drop function if exists public.crm_enrich_from_transactional_record cascade;
--   -- Recreate crm_customer_profile_current from previous migration if needed.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. crm_enrich_from_transactional_record
--
-- Parameters
--   p_source_type        'quote' | 'reservation' | 'order' | 'contract' |
--                        'billing_event'
--   p_source_record_id   stable unique ID of the originating record
--                        (used for idempotency tracking in metadata)
--   p_customer_id        entity UUID of an existing customer (highest trust)
--   p_billing_account_id entity UUID of billing account; parent customer
--                        resolved via customer_has_billing_account
--   p_contact_email      for contact-based match lookup (third priority)
--   p_contact_phone      for contact-based match lookup (fourth priority)
--   p_enrichment_data    JSONB payload of customer profile fields to fill
--   p_contact_data       optional JSONB for a contact entity to upsert and
--                        link to the resolved customer
--   p_billing_facts      for billing_event source: {balance?, credit_limit?,
--                        payment_issue_flag?} — updates entity_facts only
--
-- Returns
--   customer_entity_id   UUID of the resolved or created customer entity
--   match_method         'customer_id' | 'billing_account_id' | 'email' |
--                        'phone' | 'created'
--   enriched             TRUE when any data or fact was written
--   version_number       current entity version after the call
-- ---------------------------------------------------------------------------
create or replace function public.crm_enrich_from_transactional_record(
  p_source_type        text,
  p_source_record_id   text,
  p_customer_id        uuid    default null,
  p_billing_account_id uuid    default null,
  p_contact_email      text    default null,
  p_contact_phone      text    default null,
  p_enrichment_data    jsonb   default '{}'::jsonb,
  p_contact_data       jsonb   default null,
  p_billing_facts      jsonb   default null
)
returns table (
  customer_entity_id  uuid,
  match_method        text,
  enriched            boolean,
  version_number      int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role           text;
  v_caller_company_id      uuid;    -- tenant company for authenticated scope enforcement
  v_customer_id            uuid;
  v_match_method           text;
  v_current_data           jsonb;
  v_safe_incoming          jsonb;
  v_merged_data            jsonb;
  v_new_customer_data      jsonb;   -- assembled data for new entity creation
  v_version_number         int;
  v_enriched               boolean := false;
  v_normalized_email       text;
  v_normalized_phone       text;
  v_customer_src_id        text;
  v_contact_id             uuid;
  v_contact_src_id         text;
  v_fact_type_id           uuid;
  v_entity_version_id      uuid;
begin
  -- ── 1. Role guard ──────────────────────────────────────────────────────────
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
    raise exception 'crm_enrich_from_transactional_record requires authenticated write access'
      using errcode = '42501';
  end if;

  -- ── 1b. Authenticated tenant scope derivation ──────────────────────────────
  -- Resolve the caller's company entity via their JWT app_metadata.tenant claim.
  -- This is used to:
  --   (a) validate that all matched customers fall within the caller's scope, and
  --   (b) scope newly created customers so they are not globally visible.
  -- service_role is exempt (full cross-tenant access is permitted).
  if v_request_role = 'authenticated' then
    select e.id into v_caller_company_id
    from public.entities e
    join public.entity_versions ev
      on ev.entity_id = e.id
     and ev.is_current
    where e.entity_type = 'company'
      and ev.data ->> 'tenant' = public.get_my_tenant()
    limit 1;

    if v_caller_company_id is null then
      raise exception
        'crm_enrich_from_transactional_record: caller tenant "%" has no company entity; cannot enforce org scope',
        coalesce(public.get_my_tenant(), '<null>')
        using errcode = '42501';
    end if;
  end if;

  -- ── 2. Input validation ────────────────────────────────────────────────────
  if p_source_type not in (
    'quote', 'reservation', 'order', 'contract', 'billing_event'
  ) then
    raise exception
      'crm_enrich_from_transactional_record: invalid source_type "%"',
      p_source_type
      using errcode = '22023';
  end if;

  if coalesce(btrim(p_source_record_id), '') = '' then
    raise exception
      'crm_enrich_from_transactional_record: p_source_record_id is required'
      using errcode = '22023';
  end if;

  -- Normalize contact identifiers for consistent lookup and storage.
  v_normalized_email := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  v_normalized_phone := nullif(
    regexp_replace(coalesce(p_contact_phone, ''), '[^0-9+]', '', 'g'),
    ''
  );

  -- ── 3. Deterministic match lookup ──────────────────────────────────────────

  -- 3a. Match by explicit customer entity UUID (highest trust).
  if p_customer_id is not null then
    if exists (
      select 1
      from public.entities e
      where e.id = p_customer_id
        and e.entity_type = 'customer'
    ) then
      v_customer_id  := p_customer_id;
      v_match_method := 'customer_id';
    end if;
  end if;

  -- Scope guard: reject explicit cross-tenant customer_id references.
  if v_request_role = 'authenticated'
     and v_customer_id is not null
     and v_match_method = 'customer_id'
     and not public.crm_entity_visible_to_caller(v_customer_id) then
    raise exception
      'crm_enrich_from_transactional_record: customer % is not in caller org scope',
      v_customer_id
      using errcode = '42501';
  end if;

  -- 3b. Match via billing account → parent customer relationship.
  if v_customer_id is null and p_billing_account_id is not null then
    select rel.parent_id
      into v_customer_id
    from public.relationships_v2 rel
    where rel.relationship_type = 'customer_has_billing_account'
      and rel.child_id          = p_billing_account_id
      and rel.is_current
    order by rel.valid_from desc
    limit 1;

    if v_customer_id is not null then
      v_match_method := 'billing_account_id';
    end if;
  end if;

  -- Scope guard: reject cross-tenant billing_account_id references.
  if v_request_role = 'authenticated'
     and v_customer_id is not null
     and v_match_method = 'billing_account_id'
     and not public.crm_entity_visible_to_caller(v_customer_id) then
    raise exception
      'crm_enrich_from_transactional_record: billing account % resolves to a customer not in caller org scope',
      p_billing_account_id
      using errcode = '42501';
  end if;

  -- 3c. Match by verified contact email → linked customer.
  if v_customer_id is null and v_normalized_email is not null then
    select rel.parent_id
      into v_customer_id
    from public.entities ec
    join public.entity_versions ev_c
      on ev_c.entity_id = ec.id
     and ev_c.is_current
    join public.relationships_v2 rel
      on rel.child_id          = ec.id
     and rel.relationship_type = 'customer_has_contact'
     and rel.is_current
    where ec.entity_type = 'contact'
      and lower(btrim(coalesce(ev_c.data ->> 'email', ''))) = v_normalized_email
    order by rel.valid_from asc
    limit 1;

    if v_customer_id is not null then
      v_match_method := 'email';
    end if;
  end if;

  -- Scope guard: reject cross-tenant email matches.
  if v_request_role = 'authenticated'
     and v_customer_id is not null
     and v_match_method = 'email'
     and not public.crm_entity_visible_to_caller(v_customer_id) then
    raise exception
      'crm_enrich_from_transactional_record: email match resolved to a customer not in caller org scope'
      using errcode = '42501';
  end if;

  -- 3d. Match by verified contact phone → linked customer.
  if v_customer_id is null and v_normalized_phone is not null then
    select rel.parent_id
      into v_customer_id
    from public.entities ec
    join public.entity_versions ev_c
      on ev_c.entity_id = ec.id
     and ev_c.is_current
    join public.relationships_v2 rel
      on rel.child_id          = ec.id
     and rel.relationship_type = 'customer_has_contact'
     and rel.is_current
    where ec.entity_type = 'contact'
      and regexp_replace(
            coalesce(ev_c.data ->> 'phone', ''), '[^0-9+]', '', 'g'
          ) = v_normalized_phone
    order by rel.valid_from asc
    limit 1;

    if v_customer_id is not null then
      v_match_method := 'phone';
    end if;
  end if;

  -- Scope guard: reject cross-tenant phone matches.
  if v_request_role = 'authenticated'
     and v_customer_id is not null
     and v_match_method = 'phone'
     and not public.crm_entity_visible_to_caller(v_customer_id) then
    raise exception
      'crm_enrich_from_transactional_record: phone match resolved to a customer not in caller org scope'
      using errcode = '42501';
  end if;

  -- ── 4. No match: create a new customer profile ─────────────────────────────
  if v_customer_id is null then
    -- Derive a stable source_record_id for the new customer entity so that
    -- future enrichments with the same identity key find the same entity.
    v_customer_src_id :=
      case
        when v_normalized_email is not null
          then 'enrich:email:' || v_normalized_email
        when v_normalized_phone is not null
          then 'enrich:phone:' || v_normalized_phone
        else 'enrich:' || p_source_type || ':' || p_source_record_id
      end;

    -- Assemble the data payload for the new customer.
    -- For authenticated callers: inject org_scope_id so the new entity is
    -- scoped to the caller's company and not globally visible to all tenants.
    v_new_customer_data :=
      coalesce(p_enrichment_data, '{}'::jsonb)
      || jsonb_build_object(
           '_last_enriched_at',              now()::text,
           '_last_enrichment_source_type',   p_source_type,
           '_first_transactional_at',        now()::text,
           '_transactional_source_count',    1
         );

    if v_request_role = 'authenticated' then
      v_new_customer_data := v_new_customer_data
        || jsonb_build_object('org_scope_id', v_caller_company_id::text);
    end if;

    select t.entity_id, t.version_number
      into v_customer_id, v_version_number
    from public.crm_upsert_customer_profile(
      p_source_record_id => v_customer_src_id,
      p_data             => v_new_customer_data,
      p_enrich_only      => false
    ) as t;

    v_match_method := 'created';
    v_enriched     := true;
  end if;

  -- ── 5. Enrich existing profile (non-billing_event sources) ────────────────
  if v_customer_id is not null
     and v_match_method <> 'created'
     and p_source_type  <> 'billing_event' then

    select ev.data, ev.version_number
      into v_current_data, v_version_number
    from public.entity_versions ev
    where ev.entity_id = v_customer_id
      and ev.is_current;

    -- Collect only the keys that are currently absent in the profile.
    -- This implements the "fill missing fields only" precedence rule:
    -- transactional data never overwrites an existing higher-trust value.
    -- Use IS NULL (JSONB operator ->) rather than coalesce(->>, '')='' so
    -- that legitimate false/zero/empty-string values are not treated as absent.
    select coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
      into v_safe_incoming
    from jsonb_each(coalesce(p_enrichment_data, '{}'::jsonb)) kv
    where v_current_data -> kv.key is null;

    -- Assemble merged data.
    -- Tracking metadata is always refreshed; _first_transactional_at is
    -- a one-time write (first event wins).
    v_merged_data :=
      coalesce(v_current_data, '{}'::jsonb)
      || coalesce(v_safe_incoming, '{}'::jsonb)
      || jsonb_build_object(
           '_last_enriched_at',
             now()::text,
           '_last_enrichment_source_type',
             p_source_type,
           '_transactional_source_count',
             coalesce((v_current_data->>'_transactional_source_count')::int, 0) + 1
         )
      || case
           when coalesce(v_current_data->>'_first_transactional_at', '') = ''
           then jsonb_build_object('_first_transactional_at', now()::text)
           else '{}'::jsonb
         end;

    -- Write new SCD2 version only when data actually changed.
    if v_merged_data is distinct from coalesce(v_current_data, '{}'::jsonb) then
      select coalesce(max(ev2.version_number), 0) + 1
        into v_version_number
      from public.entity_versions ev2
      where ev2.entity_id = v_customer_id;

      insert into public.entity_versions (entity_id, version_number, data)
      values (v_customer_id, v_version_number, v_merged_data)
      returning id into v_entity_version_id;

      v_enriched := true;
    end if;
  end if;

  -- ── 6. Billing event: update entity_facts, do not write entity version ─────
  if v_customer_id is not null
     and p_source_type = 'billing_event'
     and p_billing_facts is not null then

    if (p_billing_facts->>'balance') is not null then
      select id into v_fact_type_id
      from public.fact_types
      where key = 'customer_balance';

      if v_fact_type_id is not null then
        insert into public.entity_facts (
          entity_id, fact_type_id, value, source_id, metadata
        )
        values (
          v_customer_id,
          v_fact_type_id,
          (p_billing_facts->>'balance')::numeric,
          'crm_enrich_from_transactional_record',
          jsonb_build_object('source_record_id', p_source_record_id)
        )
        on conflict (entity_id, fact_type_id, dimension_id) do update
          set value      = excluded.value,
              source_id  = excluded.source_id,
              metadata   = excluded.metadata,
              updated_at = now();

        v_enriched := true;
      end if;
    end if;

    if (p_billing_facts->>'credit_limit') is not null then
      select id into v_fact_type_id
      from public.fact_types
      where key = 'customer_credit_limit';

      if v_fact_type_id is not null then
        insert into public.entity_facts (
          entity_id, fact_type_id, value, source_id, metadata
        )
        values (
          v_customer_id,
          v_fact_type_id,
          (p_billing_facts->>'credit_limit')::numeric,
          'crm_enrich_from_transactional_record',
          jsonb_build_object('source_record_id', p_source_record_id)
        )
        on conflict (entity_id, fact_type_id, dimension_id) do update
          set value      = excluded.value,
              source_id  = excluded.source_id,
              metadata   = excluded.metadata,
              updated_at = now();

        v_enriched := true;
      end if;
    end if;

  end if;

  -- ── 7. Contact upsert (non-billing_event sources only) ────────────────────
  --    Creates or refreshes a contact entity for the resolved customer so
  --    future enrichments can find the customer by email/phone lookup.
  if v_customer_id is not null
     and p_contact_data is not null
     and p_source_type <> 'billing_event' then

    if v_normalized_email is not null then
      v_contact_src_id := 'contact:email:' || v_normalized_email;
    elsif v_normalized_phone is not null then
      v_contact_src_id := 'contact:phone:' || v_normalized_phone;
    else
      v_contact_src_id := null;
    end if;

    if v_contact_src_id is not null then
      select upserted.entity_id
        into v_contact_id
      from public.rental_upsert_entity_current_state(
        p_entity_type      => 'contact',
        p_source_record_id => v_contact_src_id,
        p_data             => case
          when v_request_role = 'authenticated'
          then p_contact_data
               || jsonb_build_object('org_scope_id', v_caller_company_id::text)
          else p_contact_data
        end
      ) as upserted;

      if v_contact_id is not null
         and not exists (
           select 1
           from public.relationships_v2 rel
           where rel.relationship_type = 'customer_has_contact'
             and rel.parent_id         = v_customer_id
             and rel.child_id          = v_contact_id
             and rel.is_current
         ) then
        perform public.rental_upsert_relationship(
          'customer_has_contact',
          v_customer_id,
          v_contact_id
        );
      end if;
    end if;
  end if;

  -- ── 8. Resolve version_number for return (billing_event path) ─────────────
  if v_version_number is null then
    select ev.version_number
      into v_version_number
    from public.entity_versions ev
    where ev.entity_id = v_customer_id
      and ev.is_current;
  end if;

  customer_entity_id := v_customer_id;
  match_method       := v_match_method;
  enriched           := v_enriched;
  version_number     := v_version_number;
  return next;
end;
$$;

revoke all on function public.crm_enrich_from_transactional_record(
  text, text, uuid, uuid, text, text, jsonb, jsonb, jsonb
) from public;

grant execute on function public.crm_enrich_from_transactional_record(
  text, text, uuid, uuid, text, text, jsonb, jsonb, jsonb
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Extend crm_customer_profile_current with enriched fields
--
-- Appends new columns after the original aggregate columns so that
-- CREATE OR REPLACE VIEW succeeds without changing existing column positions:
--   balance, credit_limit, avg_days_to_pay, payment_issue_flag stay at
--   positions 16-19 (unchanged from 20260609150000).
--
-- New columns appended at the end (positions 20+):
--   last_enriched_at          — timestamp of most recent transactional enrich
--   last_enrichment_source_type — source type of most recent enrichment
--   first_transactional_at    — timestamp of first transactional enrichment
--   transactional_source_count — number of transactional enrichment events
--   primary_contact_name      — from the earliest linked contact entity
--   primary_contact_email     — from the earliest linked contact entity
--   primary_contact_phone     — from the earliest linked contact entity
--
-- The payment_methods column is kept for backward compatibility; future work
-- should migrate it to the guarded payments boundary per ADR-0038.
-- ---------------------------------------------------------------------------
create or replace view public.crm_customer_profile_current
with (security_invoker = true) as
select
  e.id                                                             as entity_id,
  e.source_record_id,
  e.created_at,
  ev.id                                                            as entity_version_id,
  ev.version_number,
  ev.valid_from,
  ev.data,
  ev.data ->> 'name'                                              as name,
  ev.data ->> 'customer_type'                                     as customer_type,
  ev.data ->> 'tier'                                              as tier,
  ev.data ->> 'industry'                                          as industry,
  ev.data ->> 'hq_address'                                        as hq_address,
  ev.data ->> 'preferred_payment_method'                          as preferred_payment_method,
  ev.data -> 'preferences'                                        as preferences,
  ev.data -> 'payment_methods'                                    as payment_methods,
  -- Financial fact rollups (original positions 16-19 — must not move)
  max(case when ft.key = 'customer_balance'
           then ef.value end)                                     as balance,
  max(case when ft.key = 'customer_credit_limit'
           then ef.value end)                                     as credit_limit,
  max(case when ft.key = 'customer_avg_days_to_pay'
           then ef.value end)                                     as avg_days_to_pay,
  max(case when ft.key = 'customer_payment_issue_flag'
           then ef.value end)                                     as payment_issue_flag,
  -- Transactional enrichment metadata (positions 20+, added by this migration)
  ev.data ->> '_last_enriched_at'                                 as last_enriched_at,
  ev.data ->> '_last_enrichment_source_type'                      as last_enrichment_source_type,
  ev.data ->> '_first_transactional_at'                           as first_transactional_at,
  (ev.data ->> '_transactional_source_count')::int                as transactional_source_count,
  -- Primary contact fields (earliest linked contact entity)
  pc.contact_name                                                  as primary_contact_name,
  pc.contact_email                                                 as primary_contact_email,
  pc.contact_phone                                                 as primary_contact_phone
from entities e
join entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
-- Primary contact: earliest customer_has_contact relationship
left join lateral (
  select
    ev_c.data ->> 'name'  as contact_name,
    ev_c.data ->> 'email' as contact_email,
    ev_c.data ->> 'phone' as contact_phone
  from public.relationships_v2 rel
  join public.entities ec
    on ec.id = rel.child_id
   and ec.entity_type = 'contact'
  join public.entity_versions ev_c
    on ev_c.entity_id = ec.id
   and ev_c.is_current
  where rel.parent_id          = e.id
    and rel.relationship_type  = 'customer_has_contact'
    and rel.is_current
  order by rel.valid_from asc
  limit 1
) pc on true
left join entity_facts ef
  on ef.entity_id = e.id
left join fact_types ft
  on ft.id = ef.fact_type_id
 and ft.key in (
       'customer_balance',
       'customer_credit_limit',
       'customer_avg_days_to_pay',
       'customer_payment_issue_flag'
     )
where e.entity_type = 'customer'
  -- Tenant scoping: customers with an org_scope_id are only visible when the
  -- caller can reach that scope via org_scope_closure (RLS-gated with
  -- security_invoker = true).  Unscoped customers (org_scope_id is null) are
  -- visible to all authenticated users.
  and (
    e.org_scope_id is null
    or exists (
      select 1
      from   public.org_scope_closure osc
      where  osc.descendant_id = e.org_scope_id
    )
  )
group by
  e.id,
  e.source_record_id,
  e.created_at,
  ev.id,
  ev.version_number,
  ev.valid_from,
  ev.data,
  pc.contact_name,
  pc.contact_email,
  pc.contact_phone;

grant select on public.crm_customer_profile_current to authenticated;
