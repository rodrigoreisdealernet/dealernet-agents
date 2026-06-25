-- Restore CRM entity/relationship catalog entries required by demo seed,
-- and fix portal schedule asset join type alignment.

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
    ('note')
) as rental_entity_types(entity_type);

create or replace view public.rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company_has_region',          'company',       'region'),
    ('region_has_branch',           'region',        'branch'),
    ('customer_has_billing_account','customer',      'billing_account'),
    ('customer_has_contact',        'customer',      'contact'),
    ('customer_has_job_site',       'customer',      'job_site'),
    ('customer_has_document',       'customer',      'document'),
    ('customer_has_note',           'customer',      'note'),
    ('branch_has_asset',            'branch',        'asset'),
    ('asset_category_has_asset',    'asset_category','asset'),
    ('asset_has_maintenance_record','asset',         'maintenance_record'),
    ('asset_has_inspection',        'asset',         'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

drop policy if exists org_scope_closure_authenticated_read on public.org_scope_closure;
create policy org_scope_closure_authenticated_read
  on public.org_scope_closure
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and exists (
      select 1
      from public.entities company_e
      join public.entity_versions company_ev
        on company_ev.entity_id = company_e.id
       and company_ev.is_current
      where company_e.entity_type = 'company'
        and company_ev.data ->> 'tenant' = coalesce(
          nullif(public.ops_claim_tenant_key(), ''),
          public.get_my_tenant()
        )
        and (
          company_e.id = org_scope_closure.ancestor_id
          or exists (
            select 1
            from public.relationships_v2 r
            where r.relationship_type = 'company_has_region'
              and r.parent_id = company_e.id
              and r.child_id = org_scope_closure.ancestor_id
              and r.is_current
          )
          or exists (
            select 1
            from public.relationships_v2 r_rb
            join public.relationships_v2 r_cr
              on r_cr.relationship_type = 'company_has_region'
             and r_cr.parent_id = company_e.id
             and r_cr.is_current
            where r_rb.relationship_type = 'region_has_branch'
              and r_rb.parent_id = r_cr.child_id
              and r_rb.child_id = org_scope_closure.ancestor_id
              and r_rb.is_current
          )
        )
    )
  );

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
set search_path = public, pg_temp
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
