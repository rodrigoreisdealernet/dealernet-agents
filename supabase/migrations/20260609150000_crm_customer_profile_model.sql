-- ---------------------------------------------------------------------------
-- CRM: Customer profile model
--
-- Extends the entity graph with:
--   - entity types: document, note
--   - relationship types: customer_has_document, customer_has_note
--     (customer_has_contact and customer_has_billing_account already exist)
--   - fact type registrations for customer numeric rollups
--   - crm_upsert_customer_profile: idempotent profile upsert keyed by
--     source_record_id (deduplicates transaction-driven creates)
--   - crm_customer_profile_current: read-model view joining entity +
--     current version + facts for the CRM profile surface
--
-- Design constraints:
--   - No raw PAN, bank-account, or payment-processor secrets; only masked
--     metadata and external provider references are stored in entity data.
--   - Compliance documents store metadata and storage references only.
--   - Follows the generic entity/SCD2 model from DATABASE.md.
-- ---------------------------------------------------------------------------

-- 1. Extend the entity type catalog with CRM-specific child record types.
create or replace view rental_entity_type_catalog
with (security_invoker = true) as
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
    ('rental_contract_line'),
    ('document'),
    ('note')
) as rental_entity_types(entity_type);

-- 2. Extend the relationship type catalog with CRM relationship types.
create or replace view rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('customer_has_billing_account', 'customer',  'billing_account'),
    ('customer_has_contact',         'customer',  'contact'),
    ('customer_has_job_site',        'customer',  'job_site'),
    ('customer_has_document',        'customer',  'document'),
    ('customer_has_note',            'customer',  'note'),
    ('branch_has_asset',             'branch',    'asset'),
    ('asset_category_has_asset',     'asset_category', 'asset'),
    ('asset_has_maintenance_record', 'asset',     'maintenance_record'),
    ('asset_has_inspection',         'asset',     'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

-- 3. Register CRM fact types for customer numeric rollups.
--    These are upserted idempotently so re-running the migration is safe.
insert into fact_types (key, label, description, unit)
values
  ('customer_balance',           'Customer Balance',          'Outstanding balance owed by the customer',     'USD'),
  ('customer_credit_limit',      'Customer Credit Limit',     'Approved credit limit for the customer',       'USD'),
  ('customer_avg_days_to_pay',   'Avg Days to Pay',           'Rolling average days between invoice and payment', 'days'),
  ('customer_payment_issue_flag','Payment Issue Flag',        '1 if customer has an active payment issue, 0 otherwise', 'flag')
on conflict (key) do nothing;

-- 4. crm_upsert_customer_profile
--    Idempotent upsert keyed by source_record_id.
--
--    When p_enrich_only is TRUE the function merges p_data on top of the
--    current version data (existing keys are preserved; incoming keys win for
--    non-null values).  This lets quote/order workflows enrich a profile
--    (e.g. add a phone number) without wiping fields set by another path.
--
--    When p_enrich_only is FALSE (default) the full p_data payload replaces
--    the current version snapshot, creating a new SCD2 version row.
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
  v_entity_id         uuid;
  v_entity_version_id uuid;
  v_version_number    int;
  v_current_data      jsonb;
  v_merged_data       jsonb;
  v_request_role      text;
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
end;
$$;

grant execute on function crm_upsert_customer_profile(text, jsonb, boolean) to authenticated;

-- 5. crm_customer_profile_current: read-model view for the CRM profile surface.
--
--    Surfaces the current entity snapshot plus aggregated fact rollups so the
--    CRM list/detail pages can read the profile without bespoke joins outside
--    the entity graph.
create or replace view crm_customer_profile_current
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
  max(case when ft.key = 'customer_balance'
           then ef.value end)                                     as balance,
  max(case when ft.key = 'customer_credit_limit'
           then ef.value end)                                     as credit_limit,
  max(case when ft.key = 'customer_avg_days_to_pay'
           then ef.value end)                                     as avg_days_to_pay,
  max(case when ft.key = 'customer_payment_issue_flag'
           then ef.value end)                                     as payment_issue_flag
from entities e
join entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
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
group by
  e.id,
  e.source_record_id,
  e.created_at,
  ev.id,
  ev.version_number,
  ev.valid_from,
  ev.data;

-- 6. Expose the new view to authenticated sessions only.
--    anon is intentionally excluded: crm_customer_profile_current surfaces
--    customer financial data (balance, credit limit, payment issues) that
--    must remain behind an authenticated-role boundary.  The view uses
--    security_invoker = true so it also enforces base-table RLS on the caller.
grant select on crm_customer_profile_current to authenticated;
