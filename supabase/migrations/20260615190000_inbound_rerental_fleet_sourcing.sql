-- Inbound re-rental fleet sourcing model
-- Closes #1275

create table if not exists public.dim_inbound_rerental_custody_status (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  description text,
  sort_order int not null default 0,
  is_terminal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_dim_inbound_rerental_custody_status_updated_at
before update on public.dim_inbound_rerental_custody_status
for each row execute function public.update_updated_at();

insert into public.dim_inbound_rerental_custody_status (key, label, description, sort_order, is_terminal)
values
  ('inbound_requested',        'Inbound Requested',        'Third-party unit requested and agreement recorded',                         1, false),
  ('inbound_received',         'Inbound Received',         'Third-party unit received into Wynne custody',                               2, false),
  ('deployed_on_contract',     'Deployed On Contract',     'Third-party unit is fulfilling a customer contract line',                    3, false),
  ('off_hired_pending_return', 'Off-Hired Pending Return', 'Customer off-hire complete; unit awaiting physical return to owner',        4, false),
  ('returned_to_owner',        'Returned To Owner',        'Unit returned to third-party owner and custody closed',                     5, true)
on conflict (key) do nothing;

create table if not exists public.dim_inbound_rerental_valid_transition (
  from_status text not null references public.dim_inbound_rerental_custody_status(key),
  to_status text not null references public.dim_inbound_rerental_custody_status(key),
  primary key (from_status, to_status)
);

insert into public.dim_inbound_rerental_valid_transition (from_status, to_status)
values
  ('inbound_requested', 'inbound_received'),
  ('inbound_requested', 'deployed_on_contract'),
  ('inbound_received', 'deployed_on_contract'),
  ('deployed_on_contract', 'off_hired_pending_return'),
  ('off_hired_pending_return', 'returned_to_owner')
on conflict (from_status, to_status) do nothing;

create table if not exists public.inbound_rerental_supply (
  id uuid primary key default gen_random_uuid(),
  contract_line_id uuid not null references public.entities(id) on delete cascade,
  order_line_id uuid references public.entities(id) on delete set null,
  asset_id uuid references public.entities(id) on delete set null,
  counterparty_id uuid not null references public.entities(id),
  agreement_id uuid references public.entities(id) on delete set null,
  source_provenance text not null default 'third_party_owned',
  ownership_type text not null default 'external_rental'
    check (ownership_type in ('external_rental', 'leased', 'rented')),
  custody_status text not null references public.dim_inbound_rerental_custody_status(key)
    default 'inbound_requested',
  return_completed_at timestamptz,
  tenant text not null default 'default',
  created_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_line_id)
);

create index if not exists idx_inbound_rerental_supply_tenant
  on public.inbound_rerental_supply (tenant, custody_status, created_at desc);

create trigger trg_inbound_rerental_supply_updated_at
before update on public.inbound_rerental_supply
for each row execute function public.update_updated_at();

create table if not exists public.inbound_rerental_custody_log (
  id uuid primary key default gen_random_uuid(),
  supply_id uuid not null references public.inbound_rerental_supply(id) on delete cascade,
  from_status text references public.dim_inbound_rerental_custody_status(key),
  to_status text not null references public.dim_inbound_rerental_custody_status(key),
  changed_by text not null default 'system',
  note text,
  tenant text not null default 'default',
  changed_at timestamptz not null default now()
);

create index if not exists idx_inbound_rerental_custody_log_supply
  on public.inbound_rerental_custody_log (supply_id, changed_at desc);

create table if not exists public.inbound_rerental_payable_event (
  id uuid primary key default gen_random_uuid(),
  supply_id uuid not null references public.inbound_rerental_supply(id) on delete cascade,
  payable_event_type text not null
    check (payable_event_type in ('hire_start', 'hire_stop', 'return_charge', 'vendor_invoice_registered', 'status_update')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  invoice_line_id uuid references public.entities(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  tenant text not null default 'default',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_inbound_rerental_payable_event_supply
  on public.inbound_rerental_payable_event (supply_id, occurred_at desc);

alter table public.inbound_rerental_supply enable row level security;
alter table public.inbound_rerental_custody_log enable row level security;
alter table public.inbound_rerental_payable_event enable row level security;

drop policy if exists inbound_rerental_supply_select_tenant on public.inbound_rerental_supply;
create policy inbound_rerental_supply_select_tenant
  on public.inbound_rerental_supply
  for select
  to authenticated
  using (tenant = public.get_my_tenant());

drop policy if exists inbound_rerental_supply_service_role on public.inbound_rerental_supply;
create policy inbound_rerental_supply_service_role
  on public.inbound_rerental_supply
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists inbound_rerental_custody_log_select_tenant on public.inbound_rerental_custody_log;
create policy inbound_rerental_custody_log_select_tenant
  on public.inbound_rerental_custody_log
  for select
  to authenticated
  using (tenant = public.get_my_tenant());

drop policy if exists inbound_rerental_custody_log_service_role on public.inbound_rerental_custody_log;
create policy inbound_rerental_custody_log_service_role
  on public.inbound_rerental_custody_log
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists inbound_rerental_payable_event_select_tenant on public.inbound_rerental_payable_event;
create policy inbound_rerental_payable_event_select_tenant
  on public.inbound_rerental_payable_event
  for select
  to authenticated
  using (tenant = public.get_my_tenant());

drop policy if exists inbound_rerental_payable_event_service_role on public.inbound_rerental_payable_event;
create policy inbound_rerental_payable_event_service_role
  on public.inbound_rerental_payable_event
  for all
  to service_role
  using (true)
  with check (true);

grant select on public.inbound_rerental_supply, public.inbound_rerental_custody_log, public.inbound_rerental_payable_event
  to authenticated, service_role;

create or replace function public.rental_create_inbound_rerental_supply(
  p_contract_line_id uuid,
  p_counterparty_id uuid,
  p_agreement_source_record_id text,
  p_agreement_data jsonb default '{}'::jsonb,
  p_source_provenance text default 'third_party_owned',
  p_expected_return_at timestamptz default null,
  p_initial_payable_amount_minor bigint default null,
  p_currency_code text default 'USD',
  p_created_by text default 'system'
)
returns table (
  supply_id uuid,
  agreement_id uuid,
  payable_event_id uuid,
  contract_line_version_id uuid,
  contract_line_version_number int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_app_role text;
  v_contract_line_type text;
  v_contract_line_data jsonb;
  v_contract_line_version int;
  v_contract_line_contract_id uuid;
  v_contract_line_order_line_id uuid;
  v_contract_line_asset_id uuid;
  v_tenant text;
  v_agreement_id uuid;
  v_agreement_version int;
  v_supply_id uuid;
  v_payable_event_id uuid;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );
  v_app_role := coalesce(public.get_my_role()::text, '');

  if v_request_role <> 'service_role'
    and v_app_role not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'rental_create_inbound_rerental_supply: role "%" not authorized', v_app_role
      using errcode = '42501';
  end if;

  select e.entity_type
    into v_contract_line_type
  from public.entities e
  where e.id = p_contract_line_id;

  if v_contract_line_type is distinct from 'rental_contract_line' then
    raise exception 'rental_create_inbound_rerental_supply: contract_line_id % is not a rental_contract_line', p_contract_line_id
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.entities e where e.id = p_counterparty_id) then
    raise exception 'rental_create_inbound_rerental_supply: unknown counterparty_id %', p_counterparty_id
      using errcode = '22023';
  end if;

  select ev.data, ev.version_number
    into v_contract_line_data, v_contract_line_version
  from public.entity_versions ev
  where ev.entity_id = p_contract_line_id
    and ev.is_current = true;

  if not found then
    raise exception 'rental_create_inbound_rerental_supply: contract line % has no current version', p_contract_line_id
      using errcode = '22023';
  end if;

  v_tenant := coalesce(
    nullif(v_contract_line_data ->> 'tenant', ''),
    nullif(public.get_my_tenant(), ''),
    'default'
  );

  v_contract_line_contract_id := public.parse_uuid_or_null(v_contract_line_data ->> 'contract_id');
  v_contract_line_order_line_id := public.parse_uuid_or_null(v_contract_line_data ->> 'order_line_id');
  v_contract_line_asset_id := public.parse_uuid_or_null(v_contract_line_data ->> 'asset_id');

  if nullif(btrim(coalesce(p_agreement_source_record_id, '')), '') is null then
    insert into public.entities (entity_type)
    values ('counterparty_agreement')
    returning id into v_agreement_id;
  else
    insert into public.entities (entity_type, source_record_id)
    values ('counterparty_agreement', btrim(p_agreement_source_record_id))
    on conflict (entity_type, source_record_id)
    do update set updated_at = now()
    returning id into v_agreement_id;
  end if;

  select coalesce(max(ev.version_number), 0) + 1
    into v_agreement_version
  from public.entity_versions ev
  where ev.entity_id = v_agreement_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_agreement_id,
    v_agreement_version,
    jsonb_strip_nulls(
      coalesce(p_agreement_data, '{}'::jsonb)
      || jsonb_build_object(
        'counterparty_id', p_counterparty_id::text,
        'contract_line_id', p_contract_line_id::text,
        'contract_id', v_contract_line_contract_id::text,
        'source_provenance', coalesce(nullif(btrim(coalesce(p_source_provenance, '')), ''), 'third_party_owned'),
        'expected_return_at', p_expected_return_at,
        'tenant', v_tenant
      )
    )
  );

  insert into public.inbound_rerental_supply (
    contract_line_id,
    order_line_id,
    asset_id,
    counterparty_id,
    agreement_id,
    source_provenance,
    ownership_type,
    custody_status,
    tenant,
    created_by
  ) values (
    p_contract_line_id,
    v_contract_line_order_line_id,
    v_contract_line_asset_id,
    p_counterparty_id,
    v_agreement_id,
    coalesce(nullif(btrim(coalesce(p_source_provenance, '')), ''), 'third_party_owned'),
    'external_rental',
    'inbound_requested',
    v_tenant,
    coalesce(nullif(btrim(coalesce(p_created_by, '')), ''), 'system')
  )
  returning id into v_supply_id;

  insert into public.inbound_rerental_custody_log (
    supply_id,
    from_status,
    to_status,
    changed_by,
    note,
    tenant
  ) values (
    v_supply_id,
    null,
    'inbound_requested',
    coalesce(nullif(btrim(coalesce(p_created_by, '')), ''), 'system'),
    'Inbound re-rental created',
    v_tenant
  );

  if p_initial_payable_amount_minor is not null then
    insert into public.inbound_rerental_payable_event (
      supply_id,
      payable_event_type,
      amount_minor,
      currency_code,
      metadata,
      tenant
    ) values (
      v_supply_id,
      'hire_start',
      p_initial_payable_amount_minor,
      upper(coalesce(nullif(btrim(coalesce(p_currency_code, '')), ''), 'USD')),
      jsonb_build_object('source', 'rental_create_inbound_rerental_supply'),
      v_tenant
    )
    returning id into v_payable_event_id;
  end if;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    p_contract_line_id,
    v_contract_line_version + 1,
    v_contract_line_data
      || jsonb_build_object(
        'rental_type', 'external',
        'ownership_type', 'external_rental',
        'inbound_rerental_supply_id', v_supply_id::text,
        'inbound_rerental_counterparty_id', p_counterparty_id::text,
        'inbound_rerental_agreement_id', v_agreement_id::text,
        'inbound_rerental_source_provenance', coalesce(nullif(btrim(coalesce(p_source_provenance, '')), ''), 'third_party_owned'),
        'inbound_rerental_custody_status', 'inbound_requested'
      )
  )
  returning id, version_number into contract_line_version_id, contract_line_version_number;

  supply_id := v_supply_id;
  agreement_id := v_agreement_id;
  payable_event_id := v_payable_event_id;
  return next;
end;
$$;

revoke all on function public.rental_create_inbound_rerental_supply(uuid, uuid, text, jsonb, text, timestamptz, bigint, text, text) from public;
grant execute on function public.rental_create_inbound_rerental_supply(uuid, uuid, text, jsonb, text, timestamptz, bigint, text, text)
  to authenticated, service_role;

create or replace function public.rental_transition_inbound_rerental_custody(
  p_supply_id uuid,
  p_to_status text,
  p_changed_by text default 'system',
  p_note text default null,
  p_invoice_line_id uuid default null,
  p_payable_amount_minor bigint default null,
  p_currency_code text default 'USD'
)
returns table (
  log_id uuid,
  payable_event_id uuid,
  new_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_app_role text;
  v_from_status text;
  v_tenant text;
  v_contract_line_id uuid;
  v_contract_line_data jsonb;
  v_contract_line_version int;
  v_log_id uuid;
  v_payable_event_id uuid;
  v_event_type text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );
  v_app_role := coalesce(public.get_my_role()::text, '');

  if v_request_role <> 'service_role'
    and v_app_role not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'rental_transition_inbound_rerental_custody: role "%" not authorized', v_app_role
      using errcode = '42501';
  end if;

  select s.custody_status, s.tenant, s.contract_line_id
    into v_from_status, v_tenant, v_contract_line_id
  from public.inbound_rerental_supply s
  where s.id = p_supply_id;

  if not found then
    raise exception 'rental_transition_inbound_rerental_custody: unknown supply_id %', p_supply_id
      using errcode = '22023';
  end if;

  if v_request_role <> 'service_role'
    and coalesce(nullif(public.get_my_tenant(), ''), 'default') <> v_tenant then
    raise exception 'rental_transition_inbound_rerental_custody: cross-tenant access denied'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.dim_inbound_rerental_custody_status d
    where d.key = btrim(coalesce(p_to_status, ''))
  ) then
    raise exception 'rental_transition_inbound_rerental_custody: unknown target status "%"', p_to_status
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.dim_inbound_rerental_custody_status d
    where d.key = v_from_status and d.is_terminal
  ) then
    raise exception 'rental_transition_inbound_rerental_custody: status "%" is terminal', v_from_status
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.dim_inbound_rerental_valid_transition t
    where t.from_status = v_from_status
      and t.to_status = btrim(p_to_status)
  ) then
    raise exception 'rental_transition_inbound_rerental_custody: transition from "%" to "%" is not allowed', v_from_status, p_to_status
      using errcode = '23514';
  end if;

  update public.inbound_rerental_supply s
     set custody_status = btrim(p_to_status),
         return_completed_at = case
           when btrim(p_to_status) = 'returned_to_owner' then coalesce(s.return_completed_at, now())
           else s.return_completed_at
         end
   where s.id = p_supply_id;

  insert into public.inbound_rerental_custody_log (
    supply_id,
    from_status,
    to_status,
    changed_by,
    note,
    tenant
  ) values (
    p_supply_id,
    v_from_status,
    btrim(p_to_status),
    coalesce(nullif(btrim(coalesce(p_changed_by, '')), ''), 'system'),
    p_note,
    v_tenant
  )
  returning id into v_log_id;

  if p_payable_amount_minor is not null then
    v_event_type := case btrim(p_to_status)
      when 'deployed_on_contract' then 'hire_start'
      when 'off_hired_pending_return' then 'hire_stop'
      when 'returned_to_owner' then 'return_charge'
      else 'status_update'
    end;

    insert into public.inbound_rerental_payable_event (
      supply_id,
      payable_event_type,
      amount_minor,
      currency_code,
      invoice_line_id,
      metadata,
      tenant
    ) values (
      p_supply_id,
      v_event_type,
      p_payable_amount_minor,
      upper(coalesce(nullif(btrim(coalesce(p_currency_code, '')), ''), 'USD')),
      p_invoice_line_id,
      jsonb_build_object('source', 'rental_transition_inbound_rerental_custody', 'to_status', btrim(p_to_status)),
      v_tenant
    )
    returning id into v_payable_event_id;
  end if;

  select ev.data, ev.version_number
    into v_contract_line_data, v_contract_line_version
  from public.entity_versions ev
  where ev.entity_id = v_contract_line_id
    and ev.is_current = true;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_contract_line_id,
    v_contract_line_version + 1,
    v_contract_line_data
      || jsonb_strip_nulls(
        jsonb_build_object(
          'inbound_rerental_custody_status', btrim(p_to_status),
          'inbound_rerental_last_transition_at', now(),
          'inbound_rerental_returned_to_owner_at',
            case when btrim(p_to_status) = 'returned_to_owner' then now() else null end
        )
      )
  );

  log_id := v_log_id;
  payable_event_id := v_payable_event_id;
  new_status := btrim(p_to_status);
  return next;
end;
$$;

revoke all on function public.rental_transition_inbound_rerental_custody(uuid, text, text, text, uuid, bigint, text) from public;
grant execute on function public.rental_transition_inbound_rerental_custody(uuid, text, text, text, uuid, bigint, text)
  to authenticated, service_role;

create or replace view public.v_inbound_rerental_supply_current
with (security_invoker = true) as
with invoice_links as (
  select
    e.id as invoice_line_id,
    ev.data ->> 'invoice_id' as invoice_id,
    ev.data ->> 'contract_line_id' as contract_line_id
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.entity_type = 'invoice_line'
)
select
  s.id as supply_id,
  s.contract_line_id,
  cl.contract_id as contract_id,
  s.order_line_id,
  s.asset_id,
  s.counterparty_id,
  s.agreement_id,
  s.source_provenance,
  s.ownership_type,
  s.custody_status,
  s.return_completed_at,
  il.invoice_line_id,
  public.parse_uuid_or_null(il.invoice_id) as invoice_id,
  s.tenant,
  s.created_by,
  s.created_at,
  s.updated_at
from public.inbound_rerental_supply s
join public.v_rental_contract_line_current cl
  on cl.entity_id = s.contract_line_id
left join invoice_links il
  on il.contract_line_id = s.contract_line_id::text
where coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') = 'service_role'
   or s.tenant = coalesce(nullif(public.get_my_tenant(), ''), 'default');

grant select on public.v_inbound_rerental_supply_current to authenticated, service_role;
revoke all on public.v_inbound_rerental_supply_current from anon;

-- Fact type registration only: downstream workflows/services emit entity_facts as payable/custody events occur.
insert into public.fact_types (key, label, description, unit)
values
  ('inbound_rerental_custody_transition', 'Inbound Re-rental Custody Transition', 'Audit event for inbound re-rental custody transition', 'event'),
  ('inbound_rerental_payable_obligation_event', 'Inbound Re-rental Payable Obligation Event', 'Payable obligation event for inbound re-rental supply', 'event')
on conflict (key) do nothing;
