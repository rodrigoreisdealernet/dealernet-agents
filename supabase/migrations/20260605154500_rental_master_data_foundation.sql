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
    ('inspection')
) as rental_entity_types(entity_type);

create or replace view rental_relationship_type_catalog as
select *
from (
  values
    ('customer_has_billing_account', 'customer', 'billing_account'),
    ('customer_has_contact', 'customer', 'contact'),
    ('customer_has_job_site', 'customer', 'job_site'),
    ('branch_has_asset', 'branch', 'asset'),
    ('asset_category_has_asset', 'asset_category', 'asset'),
    ('asset_has_maintenance_record', 'asset', 'maintenance_record'),
    ('asset_has_inspection', 'asset', 'inspection')
) as rental_relationship_types(relationship_type, parent_entity_type, child_entity_type);

create or replace function rental_assert_entity_type(p_entity_type text)
returns void as $$
begin
  if not exists (
    select 1
    from rental_entity_type_catalog
    where entity_type = p_entity_type
  ) then
    raise exception 'Unsupported rental entity type: %', p_entity_type
      using errcode = '22023';
  end if;
end;
$$ language plpgsql;

create or replace function rental_assert_relationship(
  p_relationship_type text,
  p_parent_id uuid,
  p_child_id uuid
)
returns void as $$
declare
  v_parent_entity_type text;
  v_child_entity_type text;
begin
  select entity_type
    into v_parent_entity_type
  from entities
  where id = p_parent_id;

  if not found then
    raise exception 'Unknown relationship parent entity: %', p_parent_id
      using errcode = '22023';
  end if;

  select entity_type
    into v_child_entity_type
  from entities
  where id = p_child_id;

  if not found then
    raise exception 'Unknown relationship child entity: %', p_child_id
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from rental_relationship_type_catalog
    where relationship_type = p_relationship_type
      and parent_entity_type = v_parent_entity_type
      and child_entity_type = v_child_entity_type
  ) then
    raise exception
      'Unsupported rental relationship % for parent type % and child type %',
      p_relationship_type,
      v_parent_entity_type,
      v_child_entity_type
      using errcode = '22023';
  end if;
end;
$$ language plpgsql;

create or replace function create_entity_with_version(
  p_entity_type text,
  p_data jsonb default '{}'::jsonb,
  p_source_record_id text default null
)
returns table (
  entity_id uuid,
  entity_version_id uuid,
  version_number int
) as $$
declare
  v_entity_id uuid;
  v_entity_version_id uuid;
  v_version_number int;
begin
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
$$ language plpgsql;

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
) as $$
declare
  v_entity_id uuid;
  v_entity_type text;
  v_entity_version_id uuid;
  v_version_number int;
begin
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
$$ language plpgsql;

create or replace function rental_upsert_relationship(
  p_relationship_type text,
  p_parent_id uuid,
  p_child_id uuid,
  p_metadata jsonb default '{}'::jsonb,
  p_valid_from timestamptz default now()
)
returns uuid as $$
declare
  v_relationship_id uuid;
begin
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
$$ language plpgsql;

create or replace function rental_enforce_single_asset_assignment()
returns trigger as $$
begin
  if new.relationship_type in ('branch_has_asset', 'asset_category_has_asset') then
    update relationships_v2
       set is_current = false,
           valid_to = coalesce(new.valid_from, now())
     where relationship_type = new.relationship_type
       and child_id = new.child_id
       and is_current = true
       and id <> new.id;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_relationships_v2_rental_single_asset_assignment on relationships_v2;

create trigger trg_relationships_v2_rental_single_asset_assignment
before insert on relationships_v2
for each row
when (new.relationship_type in ('branch_has_asset', 'asset_category_has_asset'))
execute function rental_enforce_single_asset_assignment();

create unique index if not exists uq_relationships_current_branch_has_asset
  on relationships_v2 (child_id)
  where relationship_type = 'branch_has_asset'
    and is_current;

create unique index if not exists uq_relationships_current_asset_category_has_asset
  on relationships_v2 (child_id)
  where relationship_type = 'asset_category_has_asset'
    and is_current;

create or replace view rental_current_entity_state as
select
  entities.id as entity_id,
  entities.entity_type,
  entities.source_record_id,
  entity_versions.id as entity_version_id,
  entity_versions.version_number,
  entity_versions.valid_from,
  entity_versions.valid_to,
  entity_versions.data,
  entity_versions.data ->> 'name' as name,
  entity_versions.created_at,
  entity_versions.updated_at
from entities
join entity_versions
  on entity_versions.entity_id = entities.id
 and entity_versions.is_current
where exists (
  select 1
  from rental_entity_type_catalog
  where rental_entity_type_catalog.entity_type = entities.entity_type
);

create or replace view rental_current_branches as
select *
from rental_current_entity_state
where entity_type = 'branch';

create or replace view rental_current_customers as
select *
from rental_current_entity_state
where entity_type = 'customer';

create or replace view rental_current_billing_accounts as
select *
from rental_current_entity_state
where entity_type = 'billing_account';

create or replace view rental_current_contacts as
select *
from rental_current_entity_state
where entity_type = 'contact';

create or replace view rental_current_job_sites as
select *
from rental_current_entity_state
where entity_type = 'job_site';

create or replace view rental_current_asset_categories as
select *
from rental_current_entity_state
where entity_type = 'asset_category';

create or replace view rental_current_relationships as
select
  relationships_v2.id as relationship_id,
  relationships_v2.relationship_type,
  relationships_v2.parent_id,
  parent_entities.entity_type as parent_entity_type,
  parent_entities.name as parent_name,
  relationships_v2.child_id,
  child_entities.entity_type as child_entity_type,
  child_entities.name as child_name,
  relationships_v2.metadata,
  relationships_v2.valid_from,
  relationships_v2.valid_to
from relationships_v2
join rental_current_entity_state as parent_entities
  on parent_entities.entity_id = relationships_v2.parent_id
join rental_current_entity_state as child_entities
  on child_entities.entity_id = relationships_v2.child_id
where relationships_v2.is_current
  and exists (
    select 1
    from rental_relationship_type_catalog
    where rental_relationship_type_catalog.relationship_type = relationships_v2.relationship_type
      and rental_relationship_type_catalog.parent_entity_type = parent_entities.entity_type
      and rental_relationship_type_catalog.child_entity_type = child_entities.entity_type
  );

create or replace view rental_current_assets as
with base_assets as (
  select *
  from rental_current_entity_state
  where entity_type = 'asset'
),
current_assets as (
  select
    base_assets.*,
    nullif(base_assets.data ->> 'maintenance_due_at', '')::timestamptz as maintenance_due_at
  from base_assets
),
maintenance_rules as (
  select interval '14 days' as due_window
),
current_branch_assignments as (
  select
    relationships_v2.parent_id as branch_id,
    relationships_v2.child_id as asset_id
  from relationships_v2
  where relationships_v2.relationship_type = 'branch_has_asset'
    and relationships_v2.is_current
),
current_category_assignments as (
  select
    relationships_v2.parent_id as asset_category_id,
    relationships_v2.child_id as asset_id
  from relationships_v2
  where relationships_v2.relationship_type = 'asset_category_has_asset'
    and relationships_v2.is_current
)
select
  current_assets.entity_id,
  current_assets.entity_type,
  current_assets.source_record_id,
  current_assets.entity_version_id,
  current_assets.version_number,
  current_assets.valid_from,
  current_assets.valid_to,
  current_assets.data,
  current_assets.name,
  current_assets.created_at,
  current_assets.updated_at,
  current_branch_assignments.branch_id as current_branch_id,
  rental_current_branches.name as current_branch_name,
  current_category_assignments.asset_category_id as current_asset_category_id,
  rental_current_asset_categories.name as current_asset_category_name,
  current_assets.data ->> 'ownership_type' as ownership_type,
  current_assets.data ->> 'operational_status' as operational_status,
  current_assets.maintenance_due_at as maintenance_due_at,
  case
    when current_assets.maintenance_due_at is null then 'none'
    when current_assets.maintenance_due_at < now() then 'overdue'
    when current_assets.maintenance_due_at <= now() + maintenance_rules.due_window then 'due'
    else 'not_due'
  end as maintenance_due_status
from current_assets
cross join maintenance_rules
left join current_branch_assignments
  on current_branch_assignments.asset_id = current_assets.entity_id
left join rental_current_branches
  on rental_current_branches.entity_id = current_branch_assignments.branch_id
left join current_category_assignments
  on current_category_assignments.asset_id = current_assets.entity_id
left join rental_current_asset_categories
  on rental_current_asset_categories.entity_id = current_category_assignments.asset_category_id;

create or replace view rental_asset_availability_current as
select
  rental_current_assets.current_branch_id as branch_id,
  rental_current_assets.current_branch_name as branch_name,
  rental_current_assets.current_asset_category_id as asset_category_id,
  rental_current_assets.current_asset_category_name as asset_category_name,
  count(*) as total_assets,
  count(*) filter (where coalesce(rental_current_assets.operational_status, '') = 'available') as available_assets,
  count(*) filter (where coalesce(rental_current_assets.operational_status, '') <> 'available') as unavailable_assets,
  count(*) filter (where rental_current_assets.maintenance_due_status = 'due') as maintenance_due_assets,
  count(*) filter (where rental_current_assets.maintenance_due_status = 'overdue') as maintenance_overdue_assets
from rental_current_assets
where rental_current_assets.current_branch_id is not null
  and rental_current_assets.current_asset_category_id is not null
group by
  rental_current_assets.current_branch_id,
  rental_current_assets.current_branch_name,
  rental_current_assets.current_asset_category_id,
  rental_current_assets.current_asset_category_name;

create or replace function rental_asset_availability(
  p_branch_id uuid default null,
  p_asset_category_id uuid default null
)
returns table (
  branch_id uuid,
  branch_name text,
  asset_category_id uuid,
  asset_category_name text,
  total_assets bigint,
  available_assets bigint,
  unavailable_assets bigint,
  maintenance_due_assets bigint,
  maintenance_overdue_assets bigint
) as $$
  select
    rental_asset_availability_current.branch_id,
    rental_asset_availability_current.branch_name,
    rental_asset_availability_current.asset_category_id,
    rental_asset_availability_current.asset_category_name,
    rental_asset_availability_current.total_assets,
    rental_asset_availability_current.available_assets,
    rental_asset_availability_current.unavailable_assets,
    rental_asset_availability_current.maintenance_due_assets,
    rental_asset_availability_current.maintenance_overdue_assets
  from rental_asset_availability_current
  where (p_branch_id is null or rental_asset_availability_current.branch_id = p_branch_id)
    and (p_asset_category_id is null or rental_asset_availability_current.asset_category_id = p_asset_category_id)
  order by
    rental_asset_availability_current.branch_name,
    rental_asset_availability_current.asset_category_name;
$$ language sql stable;
