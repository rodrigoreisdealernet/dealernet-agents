-- Expose operator-readable last interaction fields on CRM profile projection.
-- These are persisted by crm_upsert_customer_profile(p_enrich_only => true)
-- and consumed by the /crm/customers/:id timeline fallback state after reload.

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
  ev.data ->> 'name'                                               as name,
  ev.data ->> 'customer_type'                                      as customer_type,
  ev.data ->> 'tier'                                               as tier,
  ev.data ->> 'industry'                                           as industry,
  ev.data ->> 'hq_address'                                         as hq_address,
  ev.data ->> 'preferred_payment_method'                           as preferred_payment_method,
  ev.data -> 'preferences'                                         as preferences,
  ev.data -> 'payment_methods'                                     as payment_methods,
  max(case when ft.key = 'customer_balance'
           then ef.value end)                                      as balance,
  max(case when ft.key = 'customer_credit_limit'
           then ef.value end)                                      as credit_limit,
  max(case when ft.key = 'customer_avg_days_to_pay'
           then ef.value end)                                      as avg_days_to_pay,
  max(case when ft.key = 'customer_payment_issue_flag'
           then ef.value end)                                      as payment_issue_flag,
  ev.data ->> '_last_enriched_at'                                  as last_enriched_at,
  ev.data ->> '_last_enrichment_source_type'                       as last_enrichment_source_type,
  ev.data ->> '_first_transactional_at'                            as first_transactional_at,
  (ev.data ->> '_transactional_source_count')::int                 as transactional_source_count,
  pc.contact_name                                                  as primary_contact_name,
  pc.contact_email                                                 as primary_contact_email,
  pc.contact_phone                                                 as primary_contact_phone,
  ev.data ->> 'last_interaction_type'                              as last_interaction_type,
  ev.data ->> 'last_interaction_summary'                           as last_interaction_summary
from entities e
join entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
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
  where rel.parent_id = e.id
    and rel.relationship_type = 'customer_has_contact'
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
  and (
    e.org_scope_id is null
    or exists (
      select 1
      from public.org_scope_closure osc
      where osc.descendant_id = e.org_scope_id
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
