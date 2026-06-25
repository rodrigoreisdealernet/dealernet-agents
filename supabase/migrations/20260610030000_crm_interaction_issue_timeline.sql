-- CRM communication history + durable payment-issue surfacing.
-- Additive read models and write hook aligned to docs/specs/customer-management-rental-crm.md.

-- Keep the catalog additive across enterprise + CRM domains.
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
    ('agent_config'),
    ('customer_issue')
) as rental_entity_types(entity_type);

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
    ('customer_has_issue',            'customer',       'customer_issue'),
    ('billing_account_has_issue',     'billing_account','customer_issue'),
    ('branch_has_asset',              'branch',         'asset'),
    ('asset_category_has_asset',      'asset_category', 'asset'),
    ('asset_has_maintenance_record',  'asset',          'maintenance_record'),
    ('asset_has_inspection',          'asset',          'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

insert into public.fact_types (key, label, description, unit)
values
  ('customer_email_sent',      'Customer Email Sent',      'Communication event: outbound email sent to customer contact', 'event'),
  ('customer_sms_sent',        'Customer SMS Sent',        'Communication event: outbound SMS sent to customer contact',   'event'),
  ('customer_call_logged',     'Customer Call Logged',     'Communication event: customer call logged by operations',      'event'),
  ('customer_intake_submitted','Customer Intake Submitted','Communication event: customer intake submission recorded',      'event')
on conflict (key) do nothing;

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

  if v_org_scope_id is null then
    return false;
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

create or replace view public.crm_customer_issue_current
with (security_invoker = true) as
with issue_entities as (
  select
    e.id as issue_entity_id,
    e.source_record_id as issue_source_record_id,
    e.created_at as issue_created_at,
    ev.data as issue_data
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.entity_type = 'customer_issue'
),
issue_links as (
  select
    ie.issue_entity_id,
    ie.issue_source_record_id,
    ie.issue_created_at,
    ie.issue_data,
    c_rel.parent_id as customer_id,
    b_rel.parent_id as billing_account_id,
    ba_to_customer.parent_id as customer_id_via_billing
  from issue_entities ie
  left join public.relationships_v2 c_rel
    on c_rel.relationship_type = 'customer_has_issue'
   and c_rel.child_id = ie.issue_entity_id
   and c_rel.is_current
  left join public.relationships_v2 b_rel
    on b_rel.relationship_type = 'billing_account_has_issue'
   and b_rel.child_id = ie.issue_entity_id
   and b_rel.is_current
  left join public.relationships_v2 ba_to_customer
    on ba_to_customer.relationship_type = 'customer_has_billing_account'
   and ba_to_customer.child_id = b_rel.parent_id
   and ba_to_customer.is_current
)
select
  l.issue_entity_id,
  l.issue_source_record_id,
  coalesce(l.customer_id, l.customer_id_via_billing) as customer_id,
  l.billing_account_id,
  coalesce(l.issue_data ->> 'issue_type', 'payment_issue') as issue_type,
  coalesce(l.issue_data ->> 'status', 'open') as status,
  coalesce(l.issue_data ->> 'severity', 'medium') as severity,
  nullif(l.issue_data ->> 'owner', '') as owner,
  nullif(l.issue_data ->> 'resolution_notes', '') as resolution_notes,
  coalesce(
    nullif(l.issue_data ->> 'opened_at', '')::timestamptz,
    l.issue_created_at
  ) as opened_at,
  nullif(l.issue_data ->> 'resolved_at', '')::timestamptz as resolved_at,
  l.issue_data -> 'linked_records' as linked_records,
  l.issue_data as data,
  l.issue_created_at as created_at
from issue_links l
where coalesce(l.customer_id, l.customer_id_via_billing) is not null
  and public.crm_entity_visible_to_caller(coalesce(l.customer_id, l.customer_id_via_billing));

grant select on public.crm_customer_issue_current to authenticated, service_role;

create or replace view public.crm_customer_communication_timeline
with (security_invoker = true) as
with communication_events as (
  select
    tsp.id as timeline_event_id,
    case
      when e.entity_type = 'customer' then e.id
      else ba_to_customer.parent_id
    end as customer_id,
    case
      when e.entity_type = 'billing_account' then e.id
      else null::uuid
    end as billing_account_id,
    tsp.observed_at as occurred_at,
    ft.key as interaction_type,
    ft.label as interaction_label,
    coalesce(
      nullif(tsp.data_payload ->> 'summary', ''),
      nullif(tsp.data_payload ->> 'message', ''),
      ft.label
    ) as summary,
    tsp.data_payload,
    tsp.metadata
  from public.time_series_points tsp
  join public.fact_types ft
    on ft.id = tsp.fact_type_id
  join public.entities e
    on e.id = tsp.entity_id
  left join public.relationships_v2 ba_to_customer
    on ba_to_customer.relationship_type = 'customer_has_billing_account'
   and ba_to_customer.child_id = e.id
   and ba_to_customer.is_current
  where ft.key in (
      'customer_email_sent',
      'customer_sms_sent',
      'customer_call_logged',
      'customer_intake_submitted'
    )
    and (
      e.entity_type = 'customer'
      or (e.entity_type = 'billing_account' and ba_to_customer.parent_id is not null)
    )
)
select
  ce.timeline_event_id,
  ce.customer_id,
  ce.billing_account_id,
  ce.occurred_at,
  ce.interaction_type,
  ce.interaction_label,
  ce.summary,
  public.parse_uuid_or_null(
    coalesce(
      ce.metadata ->> 'linked_entity_id',
      ce.data_payload ->> 'linked_entity_id'
    )
  ) as linked_entity_id,
  coalesce(
    nullif(ce.metadata ->> 'linked_entity_type', ''),
    nullif(ce.data_payload ->> 'linked_entity_type', '')
  ) as linked_entity_type,
  ce.data_payload,
  ce.metadata
from communication_events ce
where ce.customer_id is not null
  and public.crm_entity_visible_to_caller(ce.customer_id);

grant select on public.crm_customer_communication_timeline to authenticated, service_role;

create or replace function public.crm_upsert_payment_issue(
  p_issue_source_record_id text,
  p_customer_id uuid default null,
  p_billing_account_id uuid default null,
  p_issue_type text default 'payment_issue',
  p_status text default 'open',
  p_severity text default 'high',
  p_owner text default null,
  p_resolution_notes text default null,
  p_linked_records jsonb default '[]'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  issue_entity_id uuid,
  customer_id uuid,
  payment_issue_flag numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_existing_issue_id uuid;
  v_effective_customer_id uuid;
  v_issue_status text;
  v_issue_payload jsonb;
  v_fact_type_id uuid;
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
      and public.get_my_role() in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'crm_upsert_payment_issue requires authenticated manager write access'
      using errcode = '42501';
  end if;

  if p_issue_source_record_id is null or btrim(p_issue_source_record_id) = '' then
    raise exception 'p_issue_source_record_id is required'
      using errcode = '22023';
  end if;

  if p_customer_id is null and p_billing_account_id is null then
    raise exception 'payment issue must target a customer and/or billing account'
      using errcode = '22023';
  end if;

  v_effective_customer_id := p_customer_id;
  if v_effective_customer_id is null and p_billing_account_id is not null then
    select rel.parent_id
      into v_effective_customer_id
    from public.relationships_v2 rel
    where rel.relationship_type = 'customer_has_billing_account'
      and rel.child_id = p_billing_account_id
      and rel.is_current
    order by rel.valid_from desc
    limit 1;
  end if;

  select e.id
    into v_existing_issue_id
  from public.entities e
  where e.entity_type = 'customer_issue'
    and e.source_record_id = p_issue_source_record_id;

  v_issue_status := lower(coalesce(p_status, 'open'));
  v_issue_payload := jsonb_build_object(
    'issue_type', coalesce(nullif(p_issue_type, ''), 'payment_issue'),
    'status', v_issue_status,
    'severity', coalesce(nullif(p_severity, ''), 'high'),
    'owner', nullif(p_owner, ''),
    'resolution_notes', nullif(p_resolution_notes, ''),
    'linked_records', coalesce(p_linked_records, '[]'::jsonb),
    'metadata', coalesce(p_metadata, '{}'::jsonb),
    'updated_at', now()
  );

  if v_issue_status in ('resolved', 'closed', 'cancelled') then
    v_issue_payload := v_issue_payload || jsonb_build_object('resolved_at', now()::text);
  end if;

  if v_existing_issue_id is null then
    v_issue_payload := v_issue_payload || jsonb_build_object('opened_at', now()::text);
  end if;

  select upserted.entity_id
    into issue_entity_id
  from public.rental_upsert_entity_current_state(
    p_entity_type => 'customer_issue',
    p_data => v_issue_payload,
    p_entity_id => v_existing_issue_id,
    p_source_record_id => p_issue_source_record_id
  ) as upserted;

  if v_effective_customer_id is not null
     and not exists (
       select 1
       from public.relationships_v2 rel
       where rel.relationship_type = 'customer_has_issue'
         and rel.parent_id = v_effective_customer_id
         and rel.child_id = issue_entity_id
         and rel.is_current
     ) then
    perform public.rental_upsert_relationship(
      'customer_has_issue',
      v_effective_customer_id,
      issue_entity_id
    );
  end if;

  if p_billing_account_id is not null
     and not exists (
       select 1
       from public.relationships_v2 rel
       where rel.relationship_type = 'billing_account_has_issue'
         and rel.parent_id = p_billing_account_id
         and rel.child_id = issue_entity_id
         and rel.is_current
     ) then
    perform public.rental_upsert_relationship(
      'billing_account_has_issue',
      p_billing_account_id,
      issue_entity_id
    );
  end if;

  if v_effective_customer_id is not null then
    select id
      into v_fact_type_id
    from public.fact_types
    where key = 'customer_payment_issue_flag';

    payment_issue_flag := case
      when v_issue_status in ('resolved', 'closed', 'cancelled') then 0
      else 1
    end;

    insert into public.entity_facts (entity_id, fact_type_id, value, source_id, metadata)
    values (
      v_effective_customer_id,
      v_fact_type_id,
      payment_issue_flag,
      'crm_upsert_payment_issue',
      jsonb_build_object('issue_entity_id', issue_entity_id)
    )
    on conflict (entity_id, fact_type_id, dimension_id)
    do update set
      value = excluded.value,
      source_id = excluded.source_id,
      metadata = excluded.metadata,
      updated_at = now();
  else
    payment_issue_flag := null;
  end if;

  customer_id := v_effective_customer_id;
  return next;
end;
$$;

grant execute on function public.crm_upsert_payment_issue(
  text,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb
) to authenticated, service_role;
