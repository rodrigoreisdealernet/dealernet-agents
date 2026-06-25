-- ---------------------------------------------------------------------------
-- Descartes sync observability + reconciliation controls
--
-- Adds tenant-scoped delivery telemetry + operator controls for retry/quarantine,
-- plus reconciliation diagnostics for route/shipment/compliance scopes.
--
-- Dependencies:
--   * fact_types/time_series_points from analytics foundation migration.
--   * v_dispatch_route_live from logistics_compliance_surface migration.
--
-- Rollback (high-level):
--   drop view if exists public.v_descartes_reconciliation_drift;
--   drop view if exists public.v_descartes_failed_work;
--   drop view if exists public.v_descartes_sync_dashboard;
--   drop trigger if exists trg_descartes_sync_delivery_audit on public.descartes_sync_delivery;
--   drop function if exists public.descartes_emit_sync_audit_event();
--   drop function if exists public.descartes_quarantine_delivery(uuid, text);
--   drop function if exists public.descartes_retry_delivery(uuid, text);
--   drop function if exists public.descartes_record_sync_delivery(uuid, text, uuid, uuid, text, text, boolean, text, text, jsonb, timestamptz);
--   drop table if exists public.descartes_sync_delivery;
-- ---------------------------------------------------------------------------

insert into public.fact_types (key, label, description, unit)
values (
  'integration_descartes_sync_event',
  'Descartes Sync Event',
  'Append-only Descartes sync/replay/quarantine telemetry events',
  'event'
)
on conflict (key) do nothing;

create table if not exists public.descartes_sync_delivery (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider_key text not null default 'descartes',
  scope text not null,
  contract_line_id uuid not null references public.entities(id) on delete cascade,
  route_id uuid references public.dispatch_routes(id) on delete set null,
  source_event_id text not null,
  sync_status text not null,
  retry_count integer not null default 0,
  is_retryable boolean not null default false,
  error_code text,
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  quarantine_reason text,
  quarantined_at timestamptz,
  replay_requested_at timestamptz,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint descartes_sync_delivery_scope_chk
    check (scope in ('route', 'shipment', 'compliance')),
  constraint descartes_sync_delivery_status_chk
    check (sync_status in (
      'succeeded',
      'retryable_failure',
      'non_retryable_failure',
      'replay_queued',
      'quarantined'
    )),
  constraint descartes_sync_delivery_source_uniq
    unique (tenant_id, provider_key, scope, source_event_id)
);

create index if not exists idx_descartes_sync_delivery_tenant_status_time
  on public.descartes_sync_delivery (tenant_id, sync_status, occurred_at desc);

create index if not exists idx_descartes_sync_delivery_scope_tenant
  on public.descartes_sync_delivery (scope, tenant_id, occurred_at desc);

create trigger trg_descartes_sync_delivery_updated_at
  before update on public.descartes_sync_delivery
  for each row execute function update_updated_at();

create or replace function public.descartes_emit_sync_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fact_type_id uuid;
  v_event_type text;
  v_prev_status text;
begin
  select id into v_fact_type_id
  from public.fact_types
  where key = 'integration_descartes_sync_event';

  if v_fact_type_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_event_type := 'sync_event';
    v_prev_status := null;
  else
    if new.sync_status = old.sync_status
       and new.retry_count = old.retry_count
       and coalesce(new.quarantine_reason, '') = coalesce(old.quarantine_reason, '')
       and coalesce(new.error_code, '') = coalesce(old.error_code, '')
       and coalesce(new.error_message, '') = coalesce(old.error_message, '')
       and new.replay_requested_at is not distinct from old.replay_requested_at then
      return new;
    end if;
    v_event_type := 'status_transition';
    v_prev_status := old.sync_status;
  end if;

  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id,
    metadata
  )
  values (
    new.contract_line_id,
    v_fact_type_id,
    coalesce(new.occurred_at, now()),
    jsonb_build_object(
      'event_type', v_event_type,
      'sync_status', new.sync_status,
      'previous_sync_status', v_prev_status,
      'retry_count', new.retry_count,
      'is_retryable', new.is_retryable,
      'error_code', new.error_code,
      'error_message', new.error_message,
      'quarantine_reason', new.quarantine_reason
    ),
    concat_ws(':', new.provider_key, new.scope, new.source_event_id, coalesce(v_event_type, 'sync_event')),
    jsonb_build_object(
      'tenant_id', new.tenant_id,
      'provider_key', new.provider_key,
      'scope', new.scope,
      'delivery_id', new.id,
      'route_id', new.route_id
    )
  );

  return new;
end;
$$;

drop trigger if exists trg_descartes_sync_delivery_audit on public.descartes_sync_delivery;
create trigger trg_descartes_sync_delivery_audit
  after insert or update on public.descartes_sync_delivery
  for each row execute function public.descartes_emit_sync_audit_event();

create or replace function public.descartes_record_sync_delivery(
  p_tenant_id uuid,
  p_scope text,
  p_contract_line_id uuid,
  p_route_id uuid,
  p_source_event_id text,
  p_sync_status text,
  p_is_retryable boolean default false,
  p_error_code text default null,
  p_error_message text default null,
  p_payload jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default now()
)
returns public.descartes_sync_delivery
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.descartes_sync_delivery;
  v_request_role text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(public.ops_claims_json() ->> 'role', '')
  );

  if v_request_role <> 'service_role' then
    raise exception 'descartes_record_sync_delivery requires service_role';
  end if;

  insert into public.descartes_sync_delivery (
    tenant_id,
    provider_key,
    scope,
    contract_line_id,
    route_id,
    source_event_id,
    sync_status,
    is_retryable,
    error_code,
    error_message,
    payload,
    occurred_at
  )
  values (
    p_tenant_id,
    'descartes',
    p_scope,
    p_contract_line_id,
    p_route_id,
    p_source_event_id,
    p_sync_status,
    coalesce(p_is_retryable, false),
    p_error_code,
    p_error_message,
    coalesce(p_payload, '{}'::jsonb),
    coalesce(p_occurred_at, now())
  )
  on conflict (tenant_id, provider_key, scope, source_event_id)
  do update set
    sync_status = excluded.sync_status,
    is_retryable = excluded.is_retryable,
    error_code = excluded.error_code,
    error_message = excluded.error_message,
    payload = excluded.payload,
    retry_count = greatest(public.descartes_sync_delivery.retry_count, excluded.retry_count),
    quarantine_reason = coalesce(public.descartes_sync_delivery.quarantine_reason, excluded.quarantine_reason),
    quarantined_at = coalesce(public.descartes_sync_delivery.quarantined_at, excluded.quarantined_at),
    replay_requested_at = coalesce(public.descartes_sync_delivery.replay_requested_at, excluded.replay_requested_at),
    occurred_at = greatest(public.descartes_sync_delivery.occurred_at, excluded.occurred_at),
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.descartes_retry_delivery(
  p_delivery_id uuid,
  p_requested_reason text default null
)
returns public.descartes_sync_delivery
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.descartes_sync_delivery;
  v_app_role text;
  v_request_role text;
begin
  select * into v_row
  from public.descartes_sync_delivery
  where id = p_delivery_id
  for update;

  if not found then
    raise exception 'Descartes delivery % not found', p_delivery_id;
  end if;

  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(public.ops_claims_json() ->> 'role', '')
  );

  if v_request_role <> 'service_role' then
    v_app_role := public.ops_claim_app_role();
    if v_app_role not in ('admin', 'branch_manager') or not public.ops_tenant_match(v_row.tenant_id) then
      raise exception 'Not authorized to retry delivery %', p_delivery_id
        using errcode = '42501';
    end if;
  end if;

  if v_row.sync_status = 'quarantined' then
    raise exception 'Quarantined delivery % cannot be retried', p_delivery_id;
  end if;

  if not v_row.is_retryable then
    raise exception 'Delivery % is not marked retryable', p_delivery_id;
  end if;

  update public.descartes_sync_delivery
  set sync_status = 'replay_queued',
      retry_count = retry_count + 1,
      replay_requested_at = now(),
      payload = jsonb_set(
        coalesce(payload, '{}'::jsonb),
        '{last_replay_reason}',
        to_jsonb(coalesce(nullif(trim(p_requested_reason), ''), 'operator_retry')),
        true
      ),
      updated_at = now()
  where id = p_delivery_id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.descartes_quarantine_delivery(
  p_delivery_id uuid,
  p_quarantine_reason text
)
returns public.descartes_sync_delivery
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.descartes_sync_delivery;
  v_app_role text;
  v_reason text;
  v_request_role text;
begin
  select * into v_row
  from public.descartes_sync_delivery
  where id = p_delivery_id
  for update;

  if not found then
    raise exception 'Descartes delivery % not found', p_delivery_id;
  end if;

  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(public.ops_claims_json() ->> 'role', '')
  );

  if v_request_role <> 'service_role' then
    v_app_role := public.ops_claim_app_role();
    if v_app_role not in ('admin', 'branch_manager') or not public.ops_tenant_match(v_row.tenant_id) then
      raise exception 'Not authorized to quarantine delivery %', p_delivery_id
        using errcode = '42501';
    end if;
  end if;

  v_reason := coalesce(nullif(trim(p_quarantine_reason), ''), 'operator_quarantine');

  update public.descartes_sync_delivery
  set sync_status = 'quarantined',
      is_retryable = false,
      quarantine_reason = v_reason,
      quarantined_at = now(),
      updated_at = now()
  where id = p_delivery_id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace view public.v_descartes_sync_dashboard
with (security_invoker = true)
as
select
  d.tenant_id,
  t.tenant_key,
  d.provider_key,
  d.scope,
  d.sync_status,
  count(*)::bigint as event_count,
  max(d.occurred_at) as last_event_at,
  max(d.retry_count) as max_retry_count
from public.descartes_sync_delivery d
join public.tenants t on t.id = d.tenant_id
group by
  d.tenant_id,
  t.tenant_key,
  d.provider_key,
  d.scope,
  d.sync_status;

create or replace view public.v_descartes_failed_work
with (security_invoker = true)
as
select
  d.id as delivery_id,
  d.tenant_id,
  t.tenant_key,
  d.provider_key,
  d.scope,
  d.contract_line_id,
  d.route_id,
  d.source_event_id,
  d.sync_status,
  d.retry_count,
  d.is_retryable,
  d.error_code,
  d.error_message,
  d.quarantine_reason,
  d.quarantined_at,
  d.replay_requested_at,
  d.payload,
  d.occurred_at,
  (d.sync_status = 'retryable_failure' and d.is_retryable and d.quarantined_at is null) as can_retry,
  (d.sync_status in ('non_retryable_failure', 'retryable_failure') and d.quarantined_at is null) as can_quarantine
from public.descartes_sync_delivery d
join public.tenants t on t.id = d.tenant_id
where d.sync_status in ('retryable_failure', 'non_retryable_failure', 'quarantined', 'replay_queued');

create or replace view public.v_descartes_reconciliation_drift
with (security_invoker = true)
as
with latest_by_scope as (
  select distinct on (d.tenant_id, d.scope, d.contract_line_id)
    d.id,
    d.tenant_id,
    d.provider_key,
    d.scope,
    d.contract_line_id,
    d.route_id,
    d.sync_status,
    d.payload,
    d.occurred_at
  from public.descartes_sync_delivery d
  order by d.tenant_id, d.scope, d.contract_line_id, d.occurred_at desc, d.updated_at desc
)
select
  l.id as delivery_id,
  l.tenant_id,
  t.tenant_key,
  l.provider_key,
  l.scope,
  l.contract_line_id,
  l.route_id,
  l.sync_status,
  l.occurred_at,
  dr.route_status as internal_route_status,
  dr.line_status as internal_shipment_status,
  dr.eld_compliance_status as internal_compliance_status,
  l.payload ->> 'provider_route_status' as provider_route_status,
  l.payload ->> 'provider_shipment_status' as provider_shipment_status,
  l.payload ->> 'provider_compliance_status' as provider_compliance_status,
  case
    when l.scope = 'route'
         and l.payload ? 'provider_route_status'
         and coalesce(l.payload ->> 'provider_route_status', '') <> coalesce(dr.route_status, '')
      then true
    when l.scope = 'shipment'
         and l.payload ? 'provider_shipment_status'
         and coalesce(l.payload ->> 'provider_shipment_status', '') <> coalesce(dr.line_status, '')
      then true
    when l.scope = 'compliance'
         and l.payload ? 'provider_compliance_status'
         and coalesce(l.payload ->> 'provider_compliance_status', '') <> coalesce(dr.eld_compliance_status, '')
      then true
    else false
  end as drift_detected,
  case
    when l.scope = 'route'
         and l.payload ? 'provider_route_status'
         and coalesce(l.payload ->> 'provider_route_status', '') <> coalesce(dr.route_status, '')
      then format('Route drift: provider=%s internal=%s', coalesce(l.payload ->> 'provider_route_status', 'null'), coalesce(dr.route_status, 'null'))
    when l.scope = 'shipment'
         and l.payload ? 'provider_shipment_status'
         and coalesce(l.payload ->> 'provider_shipment_status', '') <> coalesce(dr.line_status, '')
      then format('Shipment drift: provider=%s internal=%s', coalesce(l.payload ->> 'provider_shipment_status', 'null'), coalesce(dr.line_status, 'null'))
    when l.scope = 'compliance'
         and l.payload ? 'provider_compliance_status'
         and coalesce(l.payload ->> 'provider_compliance_status', '') <> coalesce(dr.eld_compliance_status, '')
      then format('Compliance drift: provider=%s internal=%s', coalesce(l.payload ->> 'provider_compliance_status', 'null'), coalesce(dr.eld_compliance_status, 'null'))
    else null
  end as drift_reason
from latest_by_scope l
join public.tenants t on t.id = l.tenant_id
left join public.v_dispatch_route_live dr on dr.line_id = l.contract_line_id;

revoke all on table public.descartes_sync_delivery from anon, authenticated;
grant select on table public.descartes_sync_delivery to authenticated;
grant all on table public.descartes_sync_delivery to service_role;

revoke all on table public.v_descartes_sync_dashboard from anon;
revoke all on table public.v_descartes_failed_work from anon;
revoke all on table public.v_descartes_reconciliation_drift from anon;
grant select on table public.v_descartes_sync_dashboard to authenticated, service_role;
grant select on table public.v_descartes_failed_work to authenticated, service_role;
grant select on table public.v_descartes_reconciliation_drift to authenticated, service_role;

revoke execute on function public.descartes_record_sync_delivery(
  uuid, text, uuid, uuid, text, text, boolean, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.descartes_record_sync_delivery(
  uuid, text, uuid, uuid, text, text, boolean, text, text, jsonb, timestamptz
) to service_role;

revoke execute on function public.descartes_retry_delivery(uuid, text) from public, anon;
revoke execute on function public.descartes_quarantine_delivery(uuid, text) from public, anon;
grant execute on function public.descartes_retry_delivery(uuid, text) to authenticated, service_role;
grant execute on function public.descartes_quarantine_delivery(uuid, text) to authenticated, service_role;

alter table public.descartes_sync_delivery enable row level security;

drop policy if exists descartes_sync_delivery_authenticated_read on public.descartes_sync_delivery;
create policy descartes_sync_delivery_authenticated_read
  on public.descartes_sync_delivery
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

drop policy if exists descartes_sync_delivery_service_role_all on public.descartes_sync_delivery;
create policy descartes_sync_delivery_service_role_all
  on public.descartes_sync_delivery
  for all
  to service_role
  using (true)
  with check (true);
