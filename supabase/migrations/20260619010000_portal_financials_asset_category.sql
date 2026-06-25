-- Extend portal_get_financial_entities to include asset_category rows
-- so that portal-scoped (customer) views can resolve category names for
-- cost-allocation lines where no specific asset is assigned.
--
-- The authorized_category_ids CTE follows the same join pattern as
-- authorized_asset_ids: only categories referenced by lines on an
-- authorized contract are returned, keeping the response scoped.

create or replace function public.portal_get_financial_entities()
returns table (
  entity_type text,
  id uuid,
  created_at timestamptz,
  data jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims jsonb := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb, '{}'::jsonb);
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(v_claims ->> 'role', ''),
    ''
  );
  v_customer_ids text[];
  v_billing_account_ids text[];
  v_job_site_ids text[];
  v_contract_ids text[];
begin
  if v_request_role not in ('authenticated', 'service_role') then
    raise exception 'portal_get_financial_entities requires authenticated or service_role access'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct value), '{}'::text[])
    into v_customer_ids
  from (
    select nullif(btrim(v_claims ->> 'customer_id'), '') as value
    union all
    select nullif(btrim(v_claims -> 'app_metadata' ->> 'customer_id'), '')
    union all
    select nullif(btrim(value), '')
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_claims -> 'customer_ids') = 'array' then v_claims -> 'customer_ids' else '[]'::jsonb end
    ) as value
    union all
    select nullif(btrim(value), '')
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(v_claims -> 'app_metadata' -> 'customer_ids') = 'array'
          then v_claims -> 'app_metadata' -> 'customer_ids'
        else '[]'::jsonb
      end
    ) as value
  ) scope_values
  where value is not null;

  select coalesce(array_agg(distinct value), '{}'::text[])
    into v_billing_account_ids
  from (
    select nullif(btrim(v_claims ->> 'billing_account_id'), '') as value
    union all
    select nullif(btrim(v_claims -> 'app_metadata' ->> 'billing_account_id'), '')
    union all
    select nullif(btrim(value), '')
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(v_claims -> 'billing_account_ids') = 'array'
          then v_claims -> 'billing_account_ids'
        else '[]'::jsonb
      end
    ) as value
    union all
    select nullif(btrim(value), '')
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(v_claims -> 'app_metadata' -> 'billing_account_ids') = 'array'
          then v_claims -> 'app_metadata' -> 'billing_account_ids'
        else '[]'::jsonb
      end
    ) as value
  ) scope_values
  where value is not null;

  select coalesce(array_agg(distinct value), '{}'::text[])
    into v_job_site_ids
  from (
    select nullif(btrim(v_claims ->> 'job_site_id'), '') as value
    union all
    select nullif(btrim(v_claims -> 'app_metadata' ->> 'job_site_id'), '')
    union all
    select nullif(btrim(value), '')
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_claims -> 'job_site_ids') = 'array' then v_claims -> 'job_site_ids' else '[]'::jsonb end
    ) as value
    union all
    select nullif(btrim(value), '')
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(v_claims -> 'app_metadata' -> 'job_site_ids') = 'array'
          then v_claims -> 'app_metadata' -> 'job_site_ids'
        else '[]'::jsonb
      end
    ) as value
  ) scope_values
  where value is not null;

  select coalesce(array_agg(distinct value), '{}'::text[])
    into v_contract_ids
  from (
    select nullif(btrim(v_claims ->> 'contract_id'), '') as value
    union all
    select nullif(btrim(v_claims -> 'app_metadata' ->> 'contract_id'), '')
    union all
    select nullif(btrim(value), '')
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_claims -> 'contract_ids') = 'array' then v_claims -> 'contract_ids' else '[]'::jsonb end
    ) as value
    union all
    select nullif(btrim(value), '')
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(v_claims -> 'app_metadata' -> 'contract_ids') = 'array'
          then v_claims -> 'app_metadata' -> 'contract_ids'
        else '[]'::jsonb
      end
    ) as value
  ) scope_values
  where value is not null;

  if v_request_role <> 'service_role'
     and cardinality(v_customer_ids) = 0
     and cardinality(v_billing_account_ids) = 0
     and cardinality(v_job_site_ids) = 0
     and cardinality(v_contract_ids) = 0 then
    raise exception 'Portal financial scope claims are required'
      using errcode = '42501';
  end if;

  return query
  with current_entity_rows as (
    select
      e.entity_type,
      e.id,
      e.created_at,
      ev.data
    from public.entities e
    join public.entity_versions ev on ev.entity_id = e.id and ev.is_current = true
    where e.entity_type = any (array[
      'invoice',
      'payment',
      'rental_contract',
      'rental_contract_line',
      'asset',
      'asset_category',
      'document',
      'customer',
      'billing_account',
      'job_site'
    ])
  ),
  authorized_contracts as (
    select
      current_entity_rows.id,
      current_entity_rows.created_at,
      current_entity_rows.data
    from current_entity_rows
    where current_entity_rows.entity_type = 'rental_contract'
      and (
        v_request_role = 'service_role'
        or (
          (cardinality(v_customer_ids) = 0 or coalesce(current_entity_rows.data ->> 'customer_id', '') = any(v_customer_ids))
          and (
            cardinality(v_billing_account_ids) = 0
            or coalesce(current_entity_rows.data ->> 'billing_account_id', '') = any(v_billing_account_ids)
          )
          and (cardinality(v_job_site_ids) = 0 or coalesce(current_entity_rows.data ->> 'job_site_id', '') = any(v_job_site_ids))
          and (cardinality(v_contract_ids) = 0 or current_entity_rows.id::text = any(v_contract_ids))
        )
      )
  ),
  authorized_invoices as (
    select
      current_entity_rows.id,
      current_entity_rows.created_at,
      current_entity_rows.data
    from current_entity_rows
    where current_entity_rows.entity_type = 'invoice'
      and (
        v_request_role = 'service_role'
        or (
          (cardinality(v_customer_ids) = 0 or coalesce(current_entity_rows.data ->> 'customer_id', '') = any(v_customer_ids))
          and (
            cardinality(v_billing_account_ids) = 0
            or coalesce(current_entity_rows.data ->> 'billing_account_id', '') = any(v_billing_account_ids)
          )
          and (cardinality(v_job_site_ids) = 0 or coalesce(current_entity_rows.data ->> 'job_site_id', '') = any(v_job_site_ids))
          and (
            cardinality(v_contract_ids) = 0
            or coalesce(current_entity_rows.data ->> 'contract_id', '') = any(v_contract_ids)
          )
        )
      )
  ),
  authorized_contract_ids as (
    select distinct authorized_contracts.id::text as entity_id
    from authorized_contracts
  ),
  authorized_invoice_ids as (
    select distinct authorized_invoices.id::text as entity_id
    from authorized_invoices
  ),
  authorized_customer_ids as (
    select distinct customer_id
    from (
      select nullif(authorized_contracts.data ->> 'customer_id', '') as customer_id
      from authorized_contracts
      union all
      select nullif(authorized_invoices.data ->> 'customer_id', '')
      from authorized_invoices
    ) scoped_ids
    where customer_id is not null
  ),
  authorized_billing_account_ids as (
    select distinct billing_account_id
    from (
      select nullif(authorized_contracts.data ->> 'billing_account_id', '') as billing_account_id
      from authorized_contracts
      union all
      select nullif(authorized_invoices.data ->> 'billing_account_id', '')
      from authorized_invoices
    ) scoped_ids
    where billing_account_id is not null
  ),
  authorized_job_site_ids as (
    select distinct job_site_id
    from (
      select nullif(authorized_contracts.data ->> 'job_site_id', '') as job_site_id
      from authorized_contracts
      union all
      select nullif(authorized_invoices.data ->> 'job_site_id', '')
      from authorized_invoices
    ) scoped_ids
    where job_site_id is not null
  ),
  authorized_contract_lines as (
    select
      current_entity_rows.id,
      current_entity_rows.created_at,
      current_entity_rows.data
    from current_entity_rows
    join authorized_contract_ids on authorized_contract_ids.entity_id = coalesce(current_entity_rows.data ->> 'contract_id', '')
    where current_entity_rows.entity_type = 'rental_contract_line'
  ),
  authorized_asset_ids as (
    select distinct nullif(authorized_contract_lines.data ->> 'asset_id', '') as asset_id
    from authorized_contract_lines
    where nullif(authorized_contract_lines.data ->> 'asset_id', '') is not null
  ),
  authorized_category_ids as (
    -- Contract lines reference category under two field names depending on schema
    -- version: 'category_id' (current) and 'asset_category_id' (legacy/migrated).
    -- Both must be checked so portal customers can see all relevant category rows.
    select distinct category_id
    from (
      select nullif(authorized_contract_lines.data ->> 'category_id', '') as category_id
      from authorized_contract_lines
      union all
      select nullif(authorized_contract_lines.data ->> 'asset_category_id', '')
      from authorized_contract_lines
    ) scoped_ids
    where category_id is not null
  )
  select 'invoice'::text, authorized_invoices.id, authorized_invoices.created_at, authorized_invoices.data
  from authorized_invoices
  union all
  select 'payment'::text, current_entity_rows.id, current_entity_rows.created_at, current_entity_rows.data
  from current_entity_rows
  join authorized_invoice_ids on authorized_invoice_ids.entity_id = coalesce(current_entity_rows.data ->> 'invoice_id', '')
  where current_entity_rows.entity_type = 'payment'
  union all
  select 'rental_contract'::text, authorized_contracts.id, authorized_contracts.created_at, authorized_contracts.data
  from authorized_contracts
  union all
  select 'rental_contract_line'::text, authorized_contract_lines.id, authorized_contract_lines.created_at, authorized_contract_lines.data
  from authorized_contract_lines
  union all
  select 'asset'::text, current_entity_rows.id, current_entity_rows.created_at, current_entity_rows.data
  from current_entity_rows
  join authorized_asset_ids on authorized_asset_ids.asset_id = current_entity_rows.id::text
  where current_entity_rows.entity_type = 'asset'
  union all
  select 'asset_category'::text, current_entity_rows.id, current_entity_rows.created_at, current_entity_rows.data
  from current_entity_rows
  join authorized_category_ids on authorized_category_ids.category_id = current_entity_rows.id::text
  where current_entity_rows.entity_type = 'asset_category'
  union all
  select 'document'::text, current_entity_rows.id, current_entity_rows.created_at, current_entity_rows.data
  from current_entity_rows
  where current_entity_rows.entity_type = 'document'
    and (
      coalesce(current_entity_rows.data ->> 'invoice_id', '') in (select entity_id from authorized_invoice_ids)
      or coalesce(current_entity_rows.data ->> 'contract_id', '') in (select entity_id from authorized_contract_ids)
    )
  union all
  select 'customer'::text, current_entity_rows.id, current_entity_rows.created_at, current_entity_rows.data
  from current_entity_rows
  join authorized_customer_ids on authorized_customer_ids.customer_id = current_entity_rows.id::text
  where current_entity_rows.entity_type = 'customer'
  union all
  select 'billing_account'::text, current_entity_rows.id, current_entity_rows.created_at, current_entity_rows.data
  from current_entity_rows
  join authorized_billing_account_ids on authorized_billing_account_ids.billing_account_id = current_entity_rows.id::text
  where current_entity_rows.entity_type = 'billing_account'
  union all
  select 'job_site'::text, current_entity_rows.id, current_entity_rows.created_at, current_entity_rows.data
  from current_entity_rows
  join authorized_job_site_ids on authorized_job_site_ids.job_site_id = current_entity_rows.id::text
  where current_entity_rows.entity_type = 'job_site';
end;
$$;

revoke all on function public.portal_get_financial_entities() from public;
grant execute on function public.portal_get_financial_entities() to authenticated, service_role;
