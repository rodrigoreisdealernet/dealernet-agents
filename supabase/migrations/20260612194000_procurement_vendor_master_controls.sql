-- Procurement vendor master and purchasing controls.
--
-- Adds explicit vendor master write surfaces, approved purchasing contacts,
-- vendor-level authorization policy rules, and an evaluation function suitable
-- for approval-workflow orchestration.

create table if not exists public.procurement_authorization_policies (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.entities(id) on delete cascade,
  policy_code text not null,
  minimum_amount numeric(14,2) not null default 0,
  maximum_amount numeric(14,2),
  required_approval_role text not null,
  require_dual_approval boolean not null default false,
  auto_approve boolean not null default false,
  is_active boolean not null default true,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint procurement_authorization_policies_min_amount_chk
    check (minimum_amount >= 0),
  constraint procurement_authorization_policies_max_amount_chk
    check (maximum_amount is null or maximum_amount >= minimum_amount),
  constraint procurement_authorization_policies_required_role_chk
    check (required_approval_role in ('branch_manager', 'admin', 'procurement_manager', 'finance_manager', 'cfo')),
  constraint procurement_authorization_policies_effective_window_chk
    check (effective_to is null or effective_to > effective_from),
  constraint procurement_authorization_policies_code_chk
    check (nullif(btrim(policy_code), '') is not null)
);

create unique index if not exists procurement_authorization_policies_vendor_code_start_uq
  on public.procurement_authorization_policies (vendor_id, policy_code, effective_from);

create index if not exists procurement_authorization_policies_vendor_active_idx
  on public.procurement_authorization_policies (vendor_id, is_active, effective_from, minimum_amount);

create trigger trg_procurement_authorization_policies_updated_at
before update on public.procurement_authorization_policies
for each row execute function public.update_updated_at();

alter table public.procurement_authorization_policies enable row level security;

drop policy if exists procurement_authorization_policies_read_ops on public.procurement_authorization_policies;
create policy procurement_authorization_policies_read_ops
  on public.procurement_authorization_policies
  for select
  to authenticated
  using (
    public.get_my_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
  );

drop policy if exists procurement_authorization_policies_write_admin on public.procurement_authorization_policies;
create policy procurement_authorization_policies_write_admin
  on public.procurement_authorization_policies
  for all
  to authenticated
  using (public.get_my_role() in ('admin', 'branch_manager'))
  with check (public.get_my_role() in ('admin', 'branch_manager'));

drop policy if exists procurement_authorization_policies_service_role_all on public.procurement_authorization_policies;
create policy procurement_authorization_policies_service_role_all
  on public.procurement_authorization_policies
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.procurement_authorization_policies
  to authenticated, service_role;

create or replace function public.procurement_upsert_vendor_master(
  p_vendor_id uuid default null,
  p_name text default null,
  p_vendor_code text default null,
  p_is_active boolean default true,
  p_payment_terms text default null,
  p_currency_code text default 'USD',
  p_tax_identifier text default null,
  p_commercial_details jsonb default '{}'::jsonb
)
returns table (
  vendor_id uuid,
  entity_version_id uuid,
  version_number int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_vendor_id uuid;
  v_entity_version_id uuid;
  v_version_number int;
  v_request_role text;
  v_entity_type text;
  v_name text;
  v_currency text;
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
    raise exception 'procurement_upsert_vendor_master requires authenticated manager write access'
      using errcode = '42501';
  end if;

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    raise exception 'Vendor name is required' using errcode = '22023';
  end if;

  v_currency := upper(coalesce(nullif(btrim(coalesce(p_currency_code, '')), ''), 'USD'));
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'currency_code must be a 3-letter ISO-like uppercase code' using errcode = '22023';
  end if;

  if p_vendor_id is null then
    v_vendor_id := gen_random_uuid();
    insert into public.entities (id, entity_type, source_record_id)
    values (
      v_vendor_id,
      'vendor',
      nullif(btrim(coalesce(p_vendor_code, '')), '')
    );
    v_version_number := 1;
  else
    v_vendor_id := p_vendor_id;

    select entity_type
      into v_entity_type
    from public.entities
    where id = v_vendor_id;

    if not found then
      raise exception 'Unknown vendor entity %', v_vendor_id using errcode = '22023';
    end if;

    if v_entity_type <> 'vendor' then
      raise exception 'Entity % has type % but vendor was expected', v_vendor_id, v_entity_type
        using errcode = '22023';
    end if;

    select coalesce(max(ev.version_number), 0) + 1
      into v_version_number
    from public.entity_versions ev
    where ev.entity_id = v_vendor_id;

    update public.entities
       set source_record_id = nullif(btrim(coalesce(p_vendor_code, '')), '')
     where id = v_vendor_id;
  end if;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_vendor_id,
    v_version_number,
    jsonb_build_object(
      'name', v_name,
      'vendor_code', nullif(btrim(coalesce(p_vendor_code, '')), ''),
      'is_active', coalesce(p_is_active, true),
      'payment_terms', nullif(btrim(coalesce(p_payment_terms, '')), ''),
      'currency_code', v_currency,
      'tax_identifier', nullif(btrim(coalesce(p_tax_identifier, '')), ''),
      'commercial_details', coalesce(p_commercial_details, '{}'::jsonb)
    )
  )
  returning id into v_entity_version_id;

  vendor_id := v_vendor_id;
  entity_version_id := v_entity_version_id;
  version_number := v_version_number;
  return next;
end;
$$;

revoke all on function public.procurement_upsert_vendor_master(uuid, text, text, boolean, text, text, text, jsonb)
  from public;
grant execute on function public.procurement_upsert_vendor_master(uuid, text, text, boolean, text, text, text, jsonb)
  to authenticated, service_role;

create or replace function public.procurement_upsert_vendor_contact(
  p_vendor_id uuid,
  p_contact_id uuid default null,
  p_full_name text default null,
  p_email text default null,
  p_phone text default null,
  p_title text default null,
  p_is_active boolean default true,
  p_is_approved_purchasing_contact boolean default false,
  p_notes text default null
)
returns table (
  contact_id uuid,
  entity_version_id uuid,
  version_number int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_entity_version_id uuid;
  v_version_number int;
  v_request_role text;
  v_entity_type text;
  v_full_name text;
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
    raise exception 'procurement_upsert_vendor_contact requires authenticated manager write access'
      using errcode = '42501';
  end if;

  select entity_type
    into v_entity_type
  from public.entities
  where id = p_vendor_id;

  if not found or v_entity_type <> 'vendor' then
    raise exception 'Vendor % does not exist or is not a vendor entity', p_vendor_id
      using errcode = '22023';
  end if;

  v_full_name := nullif(btrim(coalesce(p_full_name, '')), '');
  if v_full_name is null then
    raise exception 'Contact full_name is required' using errcode = '22023';
  end if;

  if p_contact_id is null then
    v_contact_id := gen_random_uuid();
    insert into public.entities (id, entity_type)
    values (v_contact_id, 'vendor_contact');
    v_version_number := 1;
  else
    v_contact_id := p_contact_id;

    select entity_type
      into v_entity_type
    from public.entities
    where id = v_contact_id;

    if not found or v_entity_type <> 'vendor_contact' then
      raise exception 'Contact % does not exist or is not a vendor_contact entity', v_contact_id
        using errcode = '22023';
    end if;

    select coalesce(max(ev.version_number), 0) + 1
      into v_version_number
    from public.entity_versions ev
    where ev.entity_id = v_contact_id;
  end if;

  if not exists (
    select 1
    from public.relationships_v2 rv
    where rv.relationship_type = 'vendor_has_contact'
      and rv.parent_id = p_vendor_id
      and rv.child_id = v_contact_id
      and rv.is_current = true
  ) then
    insert into public.relationships_v2 (relationship_type, parent_id, child_id, metadata)
    values ('vendor_has_contact', p_vendor_id, v_contact_id, '{}'::jsonb);
  end if;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_contact_id,
    v_version_number,
    jsonb_build_object(
      'full_name', v_full_name,
      'email', nullif(btrim(coalesce(p_email, '')), ''),
      'phone', nullif(btrim(coalesce(p_phone, '')), ''),
      'title', nullif(btrim(coalesce(p_title, '')), ''),
      'is_active', coalesce(p_is_active, true),
      'is_approved_purchasing_contact', coalesce(p_is_approved_purchasing_contact, false),
      'notes', nullif(btrim(coalesce(p_notes, '')), '')
    )
  )
  returning id into v_entity_version_id;

  contact_id := v_contact_id;
  entity_version_id := v_entity_version_id;
  version_number := v_version_number;
  return next;
end;
$$;

revoke all on function public.procurement_upsert_vendor_contact(uuid, uuid, text, text, text, text, boolean, boolean, text)
  from public;
grant execute on function public.procurement_upsert_vendor_contact(uuid, uuid, text, text, text, text, boolean, boolean, text)
  to authenticated, service_role;

create or replace function public.procurement_evaluate_vendor_authorization(
  p_vendor_id uuid,
  p_purchase_amount numeric,
  p_evaluated_at timestamptz default now()
)
returns table (
  vendor_id uuid,
  vendor_is_active boolean,
  policy_id uuid,
  policy_code text,
  required_approval_role text,
  require_dual_approval boolean,
  auto_approve boolean,
  is_within_configured_limit boolean,
  authorization_status text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_vendor_is_active boolean;
  v_policy record;
begin
  if p_purchase_amount is null or p_purchase_amount < 0 then
    raise exception 'purchase_amount must be >= 0' using errcode = '22023';
  end if;

  select coalesce((ev.data ->> 'is_active')::boolean, true)
    into v_vendor_is_active
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.id = p_vendor_id
    and e.entity_type = 'vendor';

  if not found then
    return query
    select
      p_vendor_id,
      false,
      null::uuid,
      null::text,
      null::text,
      false,
      false,
      false,
      'vendor_not_found'::text;
    return;
  end if;

  if not coalesce(v_vendor_is_active, true) then
    return query
    select
      p_vendor_id,
      false,
      null::uuid,
      null::text,
      null::text,
      false,
      false,
      false,
      'vendor_inactive'::text;
    return;
  end if;

  select
    pap.id,
    pap.policy_code,
    pap.required_approval_role,
    pap.require_dual_approval,
    pap.auto_approve
  into v_policy
  from public.procurement_authorization_policies pap
  where pap.vendor_id = p_vendor_id
    and pap.is_active = true
    and pap.minimum_amount <= p_purchase_amount
    and (pap.maximum_amount is null or p_purchase_amount <= pap.maximum_amount)
    and pap.effective_from <= coalesce(p_evaluated_at, now())
    and (pap.effective_to is null or pap.effective_to > coalesce(p_evaluated_at, now()))
  order by pap.minimum_amount desc, pap.effective_from desc
  limit 1;

  if not found then
    return query
    select
      p_vendor_id,
      true,
      null::uuid,
      null::text,
      null::text,
      false,
      false,
      false,
      'no_matching_policy'::text;
    return;
  end if;

  return query
  select
    p_vendor_id,
    true,
    v_policy.id,
    v_policy.policy_code,
    v_policy.required_approval_role,
    v_policy.require_dual_approval,
    v_policy.auto_approve,
    true,
    case
      when v_policy.auto_approve then 'auto_approved'
      else 'approval_required'
    end;
end;
$$;

revoke all on function public.procurement_evaluate_vendor_authorization(uuid, numeric, timestamptz)
  from public;
grant execute on function public.procurement_evaluate_vendor_authorization(uuid, numeric, timestamptz)
  to authenticated, service_role;

create or replace view public.procurement_vendor_master_current
with (security_invoker = true) as
select
  e.id as vendor_id,
  coalesce(nullif(ev.data ->> 'name', ''), e.source_record_id, e.id::text) as vendor_name,
  nullif(ev.data ->> 'vendor_code', '') as vendor_code,
  coalesce((ev.data ->> 'is_active')::boolean, true) as is_active,
  nullif(ev.data ->> 'payment_terms', '') as payment_terms,
  nullif(ev.data ->> 'currency_code', '') as currency_code,
  nullif(ev.data ->> 'tax_identifier', '') as tax_identifier,
  coalesce(ev.data -> 'commercial_details', '{}'::jsonb) as commercial_details,
  ev.version_number,
  ev.valid_from,
  ev.valid_to,
  e.created_at,
  e.updated_at
from public.entities e
join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current = true
where e.entity_type = 'vendor';

grant select on public.procurement_vendor_master_current to authenticated, service_role;

create or replace view public.procurement_vendor_purchasing_contacts_current
with (security_invoker = true) as
select
  rv.parent_id as vendor_id,
  rv.child_id as contact_id,
  nullif(cev.data ->> 'full_name', '') as full_name,
  nullif(cev.data ->> 'email', '') as email,
  nullif(cev.data ->> 'phone', '') as phone,
  nullif(cev.data ->> 'title', '') as title,
  coalesce((cev.data ->> 'is_active')::boolean, true) as is_active,
  coalesce((cev.data ->> 'is_approved_purchasing_contact')::boolean, false) as is_approved_purchasing_contact,
  cev.version_number,
  cev.valid_from,
  cev.valid_to
from public.relationships_v2 rv
join public.entities ce
  on ce.id = rv.child_id
 and ce.entity_type = 'vendor_contact'
join public.entity_versions cev
  on cev.entity_id = ce.id
 and cev.is_current = true
where rv.relationship_type = 'vendor_has_contact'
  and rv.is_current = true;

grant select on public.procurement_vendor_purchasing_contacts_current to authenticated, service_role;
