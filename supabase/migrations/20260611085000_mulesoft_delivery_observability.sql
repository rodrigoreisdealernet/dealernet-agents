-- ---------------------------------------------------------------------------
-- MuleSoft delivery observability, diagnostics, and operator recovery controls
--
-- Adds tenant-scoped tables and operator tooling for MuleSoft API exchange
-- delivery observability, covering:
--   - delivery status, retry state, and dead-letter outcomes per exchange
--   - operator-controlled replay and quarantine of failed exchanges
--   - reconciliation views for detecting drift or dropped exchanges
--
-- Depends on: shared tenants table, ops_claim_app_role(), ops_tenant_match()
-- Related issues: #1151, #892, #485
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- mulesoft_delivery_events
-- One row per delivery attempt.  A single logical exchange may produce
-- multiple rows as it moves through attempted → retrying → delivered / dead_lettered.
-- ---------------------------------------------------------------------------

create table if not exists public.mulesoft_delivery_events (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  exchange_id           text          not null,
  flow_name             text          not null,
  direction             text          not null default 'inbound',
  delivery_status       text          not null default 'attempted',
  failure_class         text,
  failure_code          text,
  failure_message       text,
  retry_count           integer       not null default 0,
  max_retries           integer       not null default 3,
  idempotency_key       text,
  source_system         text          not null,
  source_event_id       text          not null,
  correlation_id        text,
  payload_digest        text,
  operator_notes        text,
  replayed_from_id      uuid          references public.mulesoft_delivery_events(id),
  occurred_at           timestamptz   not null default now(),
  resolved_at           timestamptz,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint mulesoft_delivery_events_direction_chk
    check (direction in ('inbound', 'outbound')),

  constraint mulesoft_delivery_events_delivery_status_chk
    check (delivery_status in (
      'attempted',
      'delivered',
      'retrying',
      'dead_lettered',
      'quarantined',
      'replayed'
    )),

  constraint mulesoft_delivery_events_failure_class_chk
    check (failure_class is null or failure_class in (
      'auth',
      'signature',
      'mapping',
      'provider_policy',
      'rate_limit',
      'timeout',
      'duplicate',
      'schema_validation',
      'unknown'
    )),

  -- Deduplicate: same tenant/source/event/flow cannot produce two delivered rows.
  -- A replay produces a new row with replayed_from_id set, so it is not covered by this
  -- constraint; replays intentionally create additional rows.
  constraint mulesoft_delivery_events_delivered_dedupe_uniq
    unique nulls not distinct (tenant_id, source_system, source_event_id, flow_name, idempotency_key)
);

create index if not exists idx_mulesoft_delivery_tenant_flow_status
  on public.mulesoft_delivery_events (tenant_id, flow_name, delivery_status, occurred_at desc);

create index if not exists idx_mulesoft_delivery_exchange
  on public.mulesoft_delivery_events (tenant_id, exchange_id, occurred_at desc);

create index if not exists idx_mulesoft_delivery_failure_class
  on public.mulesoft_delivery_events (tenant_id, failure_class, occurred_at desc)
  where failure_class is not null;

create trigger trg_mulesoft_delivery_events_updated_at
  before update on public.mulesoft_delivery_events
  for each row execute function update_updated_at();

revoke all on table public.mulesoft_delivery_events from anon, authenticated;
grant select on table public.mulesoft_delivery_events to authenticated;
grant all on table public.mulesoft_delivery_events to service_role;

alter table public.mulesoft_delivery_events enable row level security;

drop policy if exists "mulesoft_delivery_events_ops_read" on public.mulesoft_delivery_events;
drop policy if exists "mulesoft_delivery_events_service_role" on public.mulesoft_delivery_events;

create policy "mulesoft_delivery_events_ops_read"
  on public.mulesoft_delivery_events
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "mulesoft_delivery_events_service_role"
  on public.mulesoft_delivery_events
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- mulesoft_dead_letter_queue
-- Quarantine store for exchanges that have exhausted retries or been manually
-- quarantined by an operator.  Operators can inspect, annotate, and selectively
-- replay rows from this table.
-- ---------------------------------------------------------------------------

create table if not exists public.mulesoft_dead_letter_queue (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  delivery_event_id     uuid          not null references public.mulesoft_delivery_events(id),
  exchange_id           text          not null,
  flow_name             text          not null,
  failure_class         text          not null default 'unknown',
  failure_code          text,
  failure_message       text          not null,
  retry_count           integer       not null default 0,
  quarantine_reason     text          not null,
  quarantined_by        text,
  replay_eligible       boolean       not null default false,
  replayed_at           timestamptz,
  replayed_by           text,
  replay_delivery_id    uuid          references public.mulesoft_delivery_events(id),
  resolved_at           timestamptz,
  resolved_by           text,
  resolution_note       text,
  payload_snapshot      jsonb         not null default '{}'::jsonb,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint mulesoft_dlq_failure_class_chk
    check (failure_class in (
      'auth',
      'signature',
      'mapping',
      'provider_policy',
      'rate_limit',
      'timeout',
      'duplicate',
      'schema_validation',
      'unknown'
    )),

  constraint mulesoft_dlq_delivery_event_uniq
    unique (delivery_event_id)
);

create index if not exists idx_mulesoft_dlq_tenant_flow
  on public.mulesoft_dead_letter_queue (tenant_id, flow_name, created_at desc);

create index if not exists idx_mulesoft_dlq_tenant_replay_eligible
  on public.mulesoft_dead_letter_queue (tenant_id, replay_eligible, created_at desc)
  where replay_eligible = true and replayed_at is null and resolved_at is null;

create trigger trg_mulesoft_dlq_updated_at
  before update on public.mulesoft_dead_letter_queue
  for each row execute function update_updated_at();

revoke all on table public.mulesoft_dead_letter_queue from anon, authenticated;
grant select on table public.mulesoft_dead_letter_queue to authenticated;
grant all on table public.mulesoft_dead_letter_queue to service_role;

alter table public.mulesoft_dead_letter_queue enable row level security;

drop policy if exists "mulesoft_dlq_ops_read" on public.mulesoft_dead_letter_queue;
drop policy if exists "mulesoft_dlq_service_role" on public.mulesoft_dead_letter_queue;

create policy "mulesoft_dlq_ops_read"
  on public.mulesoft_dead_letter_queue
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "mulesoft_dlq_service_role"
  on public.mulesoft_dead_letter_queue
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- Operator control: quarantine a failed exchange
-- Moves a delivery event to the dead letter queue and marks it quarantined.
-- Only admin/branch_manager roles may call this via the authenticated path.
-- ---------------------------------------------------------------------------

create or replace function public.mulesoft_quarantine_exchange(
  p_delivery_event_id  uuid,
  p_quarantine_reason  text,
  p_replay_eligible    boolean default false,
  p_operator_notes     text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_event       public.mulesoft_delivery_events%rowtype;
  v_dlq_id      uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'mulesoft_quarantine_exchange: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.mulesoft_delivery_events
  where id = p_delivery_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'mulesoft_quarantine_exchange: delivery event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if v_event.delivery_status = 'quarantined' then
    raise exception 'mulesoft_quarantine_exchange: exchange is already quarantined'
      using errcode = 'check_violation';
  end if;

  update public.mulesoft_delivery_events
  set
    delivery_status = 'quarantined',
    operator_notes  = coalesce(p_operator_notes, operator_notes),
    resolved_at     = now(),
    updated_at      = now()
  where id = p_delivery_event_id;

  insert into public.mulesoft_dead_letter_queue (
    tenant_id,
    delivery_event_id,
    exchange_id,
    flow_name,
    failure_class,
    failure_code,
    failure_message,
    retry_count,
    quarantine_reason,
    quarantined_by,
    replay_eligible,
    payload_snapshot,
    metadata
  )
  values (
    v_event.tenant_id,
    v_event.id,
    v_event.exchange_id,
    v_event.flow_name,
    coalesce(v_event.failure_class, 'unknown'),
    v_event.failure_code,
    coalesce(v_event.failure_message, 'quarantined by operator'),
    v_event.retry_count,
    p_quarantine_reason,
    v_role,
    p_replay_eligible,
    v_event.metadata,
    jsonb_build_object(
      'quarantined_at',     now(),
      'original_status',    v_event.delivery_status,
      'operator_notes',     p_operator_notes
    )
  )
  on conflict (delivery_event_id) do update
    set
      quarantine_reason = excluded.quarantine_reason,
      replay_eligible   = excluded.replay_eligible,
      updated_at        = now()
  returning id into v_dlq_id;

  return v_dlq_id;
end;
$$;

revoke all on function public.mulesoft_quarantine_exchange(uuid, text, boolean, text) from anon;
grant execute on function public.mulesoft_quarantine_exchange(uuid, text, boolean, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Operator control: mark a DLQ entry as replayed
-- Records the replay delivery event ID against the DLQ row and produces a new
-- delivery event row for the replayed attempt.
-- ---------------------------------------------------------------------------

create or replace function public.mulesoft_mark_replayed(
  p_dlq_id            uuid,
  p_replay_actor      text,
  p_operator_notes    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role          text;
  v_dlq           public.mulesoft_dead_letter_queue%rowtype;
  v_source_event  public.mulesoft_delivery_events%rowtype;
  v_replay_id     uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'mulesoft_mark_replayed: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_dlq
  from public.mulesoft_dead_letter_queue
  where id = p_dlq_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'mulesoft_mark_replayed: DLQ entry not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if not v_dlq.replay_eligible then
    raise exception 'mulesoft_mark_replayed: DLQ entry is not marked replay-eligible'
      using errcode = 'check_violation';
  end if;

  if v_dlq.replayed_at is not null then
    raise exception 'mulesoft_mark_replayed: DLQ entry has already been replayed at %',
      v_dlq.replayed_at
      using errcode = 'check_violation';
  end if;

  select * into v_source_event
  from public.mulesoft_delivery_events
  where id = v_dlq.delivery_event_id;

  -- Insert a new delivery event row representing the replay attempt.
  insert into public.mulesoft_delivery_events (
    tenant_id,
    exchange_id,
    flow_name,
    direction,
    delivery_status,
    failure_class,
    source_system,
    source_event_id,
    correlation_id,
    payload_digest,
    idempotency_key,
    operator_notes,
    replayed_from_id,
    metadata
  )
  values (
    v_source_event.tenant_id,
    v_source_event.exchange_id,
    v_source_event.flow_name,
    v_source_event.direction,
    'replayed',
    null,
    v_source_event.source_system,
    v_source_event.source_event_id,
    v_source_event.correlation_id,
    v_source_event.payload_digest,
    null,   -- new idempotency key will be generated by the connector on actual delivery
    coalesce(p_operator_notes, 'replayed from DLQ by operator'),
    v_source_event.id,
    jsonb_build_object(
      'replayed_at',       now(),
      'replayed_by',       coalesce(p_replay_actor, v_role),
      'dlq_id',            p_dlq_id,
      'original_event_id', v_source_event.id
    )
  )
  returning id into v_replay_id;

  update public.mulesoft_dead_letter_queue
  set
    replayed_at         = now(),
    replayed_by         = coalesce(p_replay_actor, v_role),
    replay_delivery_id  = v_replay_id,
    updated_at          = now()
  where id = p_dlq_id;

  return v_replay_id;
end;
$$;

revoke all on function public.mulesoft_mark_replayed(uuid, text, text) from anon;
grant execute on function public.mulesoft_mark_replayed(uuid, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- View: v_mulesoft_delivery_dashboard
-- Tenant-scoped per-flow delivery health summary for operator dashboards.
-- ---------------------------------------------------------------------------

create or replace view public.v_mulesoft_delivery_dashboard
  with (security_invoker = true) as
select
  e.tenant_id,
  e.flow_name,
  e.direction,
  count(*)                                                                as total_attempts,
  count(*) filter (where e.delivery_status = 'delivered')                as delivered_count,
  count(*) filter (where e.delivery_status = 'retrying')                 as retrying_count,
  count(*) filter (where e.delivery_status = 'dead_lettered')            as dead_lettered_count,
  count(*) filter (where e.delivery_status = 'quarantined')              as quarantined_count,
  count(*) filter (where e.delivery_status = 'replayed')                 as replayed_count,
  count(*) filter (where e.failure_class = 'auth')                       as auth_failure_count,
  count(*) filter (where e.failure_class = 'signature')                  as signature_failure_count,
  count(*) filter (where e.failure_class = 'mapping')                    as mapping_failure_count,
  count(*) filter (where e.failure_class = 'provider_policy')            as provider_policy_failure_count,
  max(e.occurred_at)                                                      as last_attempt_at,
  max(e.occurred_at) filter (where e.delivery_status = 'delivered')      as last_delivered_at,
  max(e.occurred_at) filter (
    where e.delivery_status in ('dead_lettered', 'quarantined')
  )                                                                       as last_failure_at
from public.mulesoft_delivery_events e
group by e.tenant_id, e.flow_name, e.direction;

revoke all on table public.v_mulesoft_delivery_dashboard from anon;
grant select on table public.v_mulesoft_delivery_dashboard to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- View: v_mulesoft_failed_exchanges
-- Operator-facing list of exchanges needing attention (non-delivered, active).
-- ---------------------------------------------------------------------------

create or replace view public.v_mulesoft_failed_exchanges
  with (security_invoker = true) as
select
  e.id,
  e.tenant_id,
  e.exchange_id,
  e.flow_name,
  e.direction,
  e.delivery_status,
  e.failure_class,
  e.failure_code,
  e.failure_message,
  e.retry_count,
  e.max_retries,
  e.source_system,
  e.source_event_id,
  e.correlation_id,
  e.operator_notes,
  e.occurred_at,
  e.updated_at,
  dlq.id                  as dlq_id,
  dlq.replay_eligible,
  dlq.replayed_at,
  dlq.quarantine_reason
from public.mulesoft_delivery_events e
left join public.mulesoft_dead_letter_queue dlq
  on dlq.delivery_event_id = e.id
where e.delivery_status in ('retrying', 'dead_lettered', 'quarantined')
  and e.resolved_at is null;

revoke all on table public.v_mulesoft_failed_exchanges from anon;
grant select on table public.v_mulesoft_failed_exchanges to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- View: v_mulesoft_reconciliation_summary
-- Per-flow, per-day delivery/failure counts for reconciliation gap detection.
-- Operators use this to identify dropped or drifted exchanges across time windows.
-- ---------------------------------------------------------------------------

create or replace view public.v_mulesoft_reconciliation_summary
  with (security_invoker = true) as
select
  e.tenant_id,
  e.flow_name,
  e.source_system,
  date_trunc('day', e.occurred_at)                                        as period_day,
  count(distinct e.exchange_id)                                           as unique_exchanges,
  count(*)                                                                as total_attempts,
  count(*) filter (where e.delivery_status = 'delivered')                as delivered_count,
  count(*) filter (
    where e.delivery_status in ('dead_lettered', 'quarantined')
  )                                                                       as failure_count,
  count(*) filter (where e.delivery_status = 'replayed')                 as replay_count,
  round(
    100.0
    * count(*) filter (where e.delivery_status = 'delivered')
    / nullif(count(*), 0),
    1
  )                                                                       as delivery_success_pct,
  min(e.occurred_at)                                                      as first_event_at,
  max(e.occurred_at)                                                      as last_event_at
from public.mulesoft_delivery_events e
group by e.tenant_id, e.flow_name, e.source_system, date_trunc('day', e.occurred_at);

revoke all on table public.v_mulesoft_reconciliation_summary from anon;
grant select on table public.v_mulesoft_reconciliation_summary to authenticated, service_role;
