-- Enterprise org hierarchy + consolidated financial reporting helpers.
-- Adds company -> region -> branch scope closure, effective branch scoping for
-- operational entities, and shared reporting views for consolidated + drill-down
-- enterprise financial reporting.

alter table public.entities
  add column if not exists org_scope_id uuid references public.entities(id) on delete set null;

create index if not exists idx_entities_org_scope_id
  on public.entities (org_scope_id);

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
    ('invoice_line')
) as rental_entity_types(entity_type);

create or replace view public.rental_relationship_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company_has_region', 'company', 'region'),
    ('region_has_branch', 'region', 'branch'),
    ('customer_has_billing_account', 'customer', 'billing_account'),
    ('customer_has_contact', 'customer', 'contact'),
    ('customer_has_job_site', 'customer', 'job_site'),
    ('branch_has_asset', 'branch', 'asset'),
    ('asset_category_has_asset', 'asset_category', 'asset'),
    ('asset_has_maintenance_record', 'asset', 'maintenance_record'),
    ('asset_has_inspection', 'asset', 'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

create or replace function public.parse_uuid_or_null(p_value text)
returns uuid
language plpgsql
immutable
as $$
begin
  if coalesce(p_value, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return p_value::uuid;
  end if;
  return null;
end;
$$;

create or replace function public.parse_numeric_or_null(p_value text)
returns numeric
language plpgsql
immutable
as $$
begin
  if coalesce(p_value, '') ~ '^-?[0-9]+(\.[0-9]+)?$' then
    return p_value::numeric;
  end if;
  return null;
end;
$$;

create or replace function public.parse_date_or_null(p_value text)
returns date
language plpgsql
immutable
as $$
begin
  if coalesce(p_value, '') ~ '^\d{4}-\d{2}-\d{2}$' then
    return p_value::date;
  end if;
  return null;
end;
$$;

create table if not exists public.org_scope_closure (
  ancestor_id uuid not null references public.entities(id) on delete cascade,
  descendant_id uuid not null references public.entities(id) on delete cascade,
  depth int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_scope_closure_pkey primary key (ancestor_id, descendant_id),
  constraint chk_org_scope_closure_depth_non_negative check (depth >= 0)
);

alter table public.org_scope_closure
  add column if not exists updated_at timestamptz not null default now();

alter table public.org_scope_closure
  enable row level security;

revoke all on table public.org_scope_closure from public, anon, authenticated;
grant select on table public.org_scope_closure to authenticated;
grant select, insert, update, delete on table public.org_scope_closure to service_role;

drop policy if exists org_scope_closure_anon_read on public.org_scope_closure;
drop policy if exists org_scope_closure_authenticated_read on public.org_scope_closure;
create policy org_scope_closure_authenticated_read
  on public.org_scope_closure
  for select
  to authenticated
  using (true);

drop policy if exists org_scope_closure_service_role_all on public.org_scope_closure;
create policy org_scope_closure_service_role_all
  on public.org_scope_closure
  for all
  to service_role
  using (true)
  with check (true);

drop trigger if exists trg_org_scope_closure_updated_at on public.org_scope_closure;
create trigger trg_org_scope_closure_updated_at
  before update on public.org_scope_closure
  for each row execute function public.update_updated_at();

create index if not exists idx_org_scope_closure_descendant
  on public.org_scope_closure (descendant_id, ancestor_id, depth);

create or replace function public.derive_entity_org_scope_id(
  p_entity_type text,
  p_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate_id uuid;
  v_scope_id uuid;
  v_key text;
begin
  if p_entity_type in ('company', 'region', 'branch') then
    return null;
  end if;

  v_candidate_id := public.parse_uuid_or_null(coalesce(p_data ->> 'branch_id', ''));
  if v_candidate_id is not null
     and exists (
       select 1
       from public.entities
       where id = v_candidate_id
         and entity_type = 'branch'
     ) then
    return v_candidate_id;
  end if;

  foreach v_key in array array[
    'org_scope_id',
    'contract_id',
    'rental_contract_id',
    'order_id',
    'rental_order_id',
    'line_item_id',
    'rental_contract_line_id',
    'rental_order_line_id',
    'invoice_id',
    'asset_id'
  ]
  loop
    v_candidate_id := public.parse_uuid_or_null(coalesce(p_data ->> v_key, ''));
    if v_candidate_id is null then
      continue;
    end if;

    select e.org_scope_id
      into v_scope_id
    from public.entities e
    where e.id = v_candidate_id;

    if v_scope_id is not null then
      return v_scope_id;
    end if;

    if v_key = 'org_scope_id'
       and exists (
         select 1
         from public.entities
         where id = v_candidate_id
           and entity_type = 'branch'
       ) then
      return v_candidate_id;
    end if;
  end loop;

  return null;
end;
$$;

create or replace function public.refresh_org_scope_closure()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.org_scope_closure;

  insert into public.org_scope_closure (
    ancestor_id,
    descendant_id,
    depth
  )
  with recursive scope_entities as (
    select e.id
    from public.entities e
    where e.entity_type in ('company', 'region', 'branch')
  ), scope_edges as (
    select
      r.parent_id as ancestor_id,
      r.child_id as descendant_id
    from public.relationships_v2 r
    where r.is_current
      and r.relationship_type in ('company_has_region', 'region_has_branch')
  ), closure as (
    select
      se.id as ancestor_id,
      se.id as descendant_id,
      0 as depth
    from scope_entities se
    union all
    select
      c.ancestor_id,
      e.descendant_id,
      c.depth + 1
    from closure c
    join scope_edges e
      on e.ancestor_id = c.descendant_id
  )
  select
    ancestor_id,
    descendant_id,
    min(depth) as depth
  from closure
  group by ancestor_id, descendant_id;
end;
$$;

create or replace function public.refresh_entity_org_scopes()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_iteration int;
begin
  -- Four passes are enough for the current reporting graph:
  -- 1) scope entities self-resolve, 2) branch-owned rows resolve directly,
  -- 3) contract/order rows inherit from branch-scoped parents, and
  -- 4) invoice/detail rows inherit from those scoped operational parents.
  for v_iteration in 1..4 loop
    update public.entities e
       set org_scope_id = resolved.org_scope_id
      from (
        select
          ent.id,
          case
            when ent.entity_type in ('company', 'region', 'branch') then ent.id
            else coalesce(
              public.derive_entity_org_scope_id(ent.entity_type, coalesce(ev.data, '{}'::jsonb)),
              -- Assets can resolve scope from their current branch relationship
              -- even when the branch is not duplicated into the asset payload.
              branch_rel.branch_id
            )
          end as org_scope_id
        from public.entities ent
        left join public.entity_versions ev
          on ev.entity_id = ent.id
         and ev.is_current
        left join lateral (
          select r.parent_id as branch_id
          from public.relationships_v2 r
          where r.is_current
            and r.relationship_type = 'branch_has_asset'
            and r.child_id = ent.id
          order by r.valid_from desc
          limit 1
        ) branch_rel on true
      ) resolved
     where e.id = resolved.id
       and e.org_scope_id is distinct from resolved.org_scope_id;

    exit when not found;
  end loop;
end;
$$;

create or replace function public.create_entity_with_version(
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
  v_org_scope_id uuid;
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
    raise exception 'create_entity_with_version requires an authenticated user with write access'
      using errcode = '42501';
  end if;

  v_entity_id := gen_random_uuid();
  v_org_scope_id := case
    when p_entity_type in ('company', 'region', 'branch') then v_entity_id
    else public.derive_entity_org_scope_id(p_entity_type, coalesce(p_data, '{}'::jsonb))
  end;

  insert into public.entities (id, entity_type, source_record_id, org_scope_id)
  values (v_entity_id, p_entity_type, p_source_record_id, v_org_scope_id);

  insert into public.entity_versions (entity_id, version_number, data)
  values (v_entity_id, 1, coalesce(p_data, '{}'::jsonb))
  returning id, entity_versions.version_number
    into v_entity_version_id, v_version_number;

  entity_id := v_entity_id;
  entity_version_id := v_entity_version_id;
  version_number := v_version_number;
  return next;
end;
$$;

create or replace function public.rental_upsert_entity_current_state(
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
          and p_entity_type in ('inspection', 'maintenance_record', 'rental_contract_line')
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
$$;

create or replace function public.rental_upsert_relationship(
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
    raise exception 'rental_upsert_relationship requires authenticated manager write access'
      using errcode = '42501';
  end if;

  perform public.rental_assert_relationship(
    p_relationship_type => p_relationship_type,
    p_parent_id => p_parent_id,
    p_child_id => p_child_id
  );

  insert into public.relationships_v2 (
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

  if p_relationship_type in ('company_has_region', 'region_has_branch') then
    perform public.refresh_org_scope_closure();
    perform public.refresh_entity_org_scopes();
  elsif p_relationship_type = 'branch_has_asset' then
    update public.entities
       set org_scope_id = p_parent_id
     where id = p_child_id
       and org_scope_id is distinct from p_parent_id;
  end if;

  return v_relationship_id;
end;
$$;

create or replace view public.v_org_scope_dimension
with (security_invoker = true) as
select
  e.id as scope_id,
  e.entity_type as scope_type,
  coalesce(nullif(ev.data ->> 'name', ''), e.source_record_id, e.id::text) as scope_name,
  upper(coalesce(nullif(ev.data ->> 'default_currency_code', ''), 'USD')) as default_currency_code,
  nullif(ev.data ->> 'locale_code', '') as locale_code,
  nullif(ev.data ->> 'tax_region_code', '') as tax_region_code,
  nullif(ev.data ->> 'timezone', '') as timezone
from public.entities e
join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
where e.entity_type in ('company', 'region', 'branch');

revoke all on table public.v_org_scope_dimension from public, anon;
grant select on table public.v_org_scope_dimension to authenticated, service_role;

create or replace view public.v_enterprise_financial_reporting_lines
with (security_invoker = true) as
with base_documents as (
  select
    e.id as source_entity_id,
    e.source_record_id,
    e.entity_type as source_entity_type,
    e.org_scope_id as branch_scope_id,
    s.document_number,
    s.document_status,
    s.transaction_currency_code,
    s.reporting_currency_code,
    s.fx_rate_applied,
    s.fx_rate_effective_at,
    s.valid_from,
    s.document_data
  from public.v_commercial_document_currency_snapshots s
  join public.entities e
    on e.id = s.entity_id
  where e.org_scope_id is not null
), parsed_documents as (
  select
    d.*,
    coalesce(public.parse_numeric_or_null(d.document_data ->> 'total'), 0::numeric) as transaction_total_amount,
    coalesce(
      public.parse_date_or_null(d.document_data ->> 'billing_period_start'),
      public.parse_date_or_null(d.document_data ->> 'planned_start'),
      public.parse_date_or_null(d.document_data ->> 'start_date')
    ) as period_start,
    coalesce(
      public.parse_date_or_null(d.document_data ->> 'billing_period_end'),
      public.parse_date_or_null(d.document_data ->> 'invoice_date'),
      public.parse_date_or_null(d.document_data ->> 'planned_end'),
      public.parse_date_or_null(d.document_data ->> 'end_date'),
      public.parse_date_or_null(d.document_data ->> 'planned_start'),
      d.valid_from::date
    ) as document_date
  from base_documents d
), enriched_documents as (
  select
    d.*,
    fx.rate as fx_rate_lookup
  from parsed_documents d
  left join lateral (
    select fr.rate
    from public.fx_rates fr
    where fr.base_currency_code = d.transaction_currency_code
      and fr.quote_currency_code = d.reporting_currency_code
      and fr.effective_at <= coalesce(d.fx_rate_effective_at, d.valid_from, now())
    order by fr.effective_at desc
    limit 1
  ) fx on true
), amount_documents as (
  select
    d.*,
    case
      when d.reporting_currency_code = d.transaction_currency_code then 1::numeric
      when d.fx_rate_applied is not null then d.fx_rate_applied
      else d.fx_rate_lookup
    end as fx_rate_used,
    case
      when d.reporting_currency_code = d.transaction_currency_code then 'identity'
      when d.fx_rate_applied is not null then 'snapshot'
      when d.fx_rate_lookup is not null then 'lookup'
      else 'missing'
    end as fx_rate_source,
    round(
      d.transaction_total_amount * coalesce(
        case
          when d.reporting_currency_code = d.transaction_currency_code then 1::numeric
          when d.fx_rate_applied is not null then d.fx_rate_applied
          else d.fx_rate_lookup
        end,
        0::numeric
      ),
      2
    ) as reporting_total_amount
  from enriched_documents d
)
select
  d.source_entity_id,
  d.source_record_id,
  d.source_entity_type,
  d.document_number,
  d.document_status,
  d.document_date,
  d.period_start,
  d.document_date as period_end,
  d.branch_scope_id as originating_scope_id,
  branch_scope.scope_name as originating_scope_name,
  branch_scope.scope_id as branch_scope_id,
  branch_scope.scope_name as branch_scope_name,
  region_scope.scope_id as region_scope_id,
  region_scope.scope_name as region_scope_name,
  company_scope.scope_id as company_scope_id,
  company_scope.scope_name as company_scope_name,
  d.transaction_currency_code,
  d.reporting_currency_code,
  d.transaction_total_amount,
  d.reporting_total_amount,
  d.fx_rate_used,
  d.fx_rate_source,
  d.fx_rate_effective_at
from amount_documents d
left join public.v_org_scope_dimension branch_scope
  on branch_scope.scope_id = d.branch_scope_id
 and branch_scope.scope_type = 'branch'
left join lateral (
  select dim.scope_id, dim.scope_name
  from public.org_scope_closure osc
  join public.v_org_scope_dimension dim
    on dim.scope_id = osc.ancestor_id
  where osc.descendant_id = d.branch_scope_id
    and dim.scope_type = 'region'
  order by osc.depth asc
  limit 1
) region_scope on true
left join lateral (
  select dim.scope_id, dim.scope_name
  from public.org_scope_closure osc
  join public.v_org_scope_dimension dim
    on dim.scope_id = osc.ancestor_id
  where osc.descendant_id = d.branch_scope_id
    and dim.scope_type = 'company'
  order by osc.depth asc
  limit 1
) company_scope on true;

revoke all on table public.v_enterprise_financial_reporting_lines from public, anon;
grant select on table public.v_enterprise_financial_reporting_lines to authenticated, service_role;

create or replace view public.v_enterprise_financial_reporting_rollups
with (security_invoker = true) as
select
  'company'::text as scope_type,
  company_scope_id as scope_id,
  company_scope_name as scope_name,
  source_entity_type,
  transaction_currency_code,
  reporting_currency_code,
  count(*) as document_count,
  round(sum(transaction_total_amount), 2) as transaction_total_amount,
  round(sum(reporting_total_amount), 2) as reporting_total_amount
from public.v_enterprise_financial_reporting_lines
where company_scope_id is not null
group by company_scope_id, company_scope_name, source_entity_type, transaction_currency_code, reporting_currency_code

union all

select
  'region'::text as scope_type,
  region_scope_id as scope_id,
  region_scope_name as scope_name,
  source_entity_type,
  transaction_currency_code,
  reporting_currency_code,
  count(*) as document_count,
  round(sum(transaction_total_amount), 2) as transaction_total_amount,
  round(sum(reporting_total_amount), 2) as reporting_total_amount
from public.v_enterprise_financial_reporting_lines
where region_scope_id is not null
group by region_scope_id, region_scope_name, source_entity_type, transaction_currency_code, reporting_currency_code

union all

select
  'branch'::text as scope_type,
  branch_scope_id as scope_id,
  branch_scope_name as scope_name,
  source_entity_type,
  transaction_currency_code,
  reporting_currency_code,
  count(*) as document_count,
  round(sum(transaction_total_amount), 2) as transaction_total_amount,
  round(sum(reporting_total_amount), 2) as reporting_total_amount
from public.v_enterprise_financial_reporting_lines
where branch_scope_id is not null
group by branch_scope_id, branch_scope_name, source_entity_type, transaction_currency_code, reporting_currency_code;

revoke all on table public.v_enterprise_financial_reporting_rollups from public, anon;
grant select on table public.v_enterprise_financial_reporting_rollups to authenticated, service_role;

select public.refresh_org_scope_closure();
select public.refresh_entity_org_scopes();
