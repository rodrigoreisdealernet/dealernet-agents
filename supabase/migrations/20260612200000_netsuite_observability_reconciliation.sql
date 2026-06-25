-- ---------------------------------------------------------------------------
-- NetSuite observability, reconciliation, and operator controls
--
-- Adds tenant-scoped sync event telemetry, dead-letter controls, disable
-- controls, and reconciliation diagnostics for NetSuite ERP syncs.
--
-- Supported scopes: customer, invoice, journal_entry
-- Failure classes: auth, transport, rate_limit, invalid_payload, validation,
--                  duplicate, unknown
--
-- Depends on: shared tenants table, ops_claim_app_role(), ops_tenant_match()
-- Related issues: #1350, #464
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Sync events — append-only telemetry per sync execution or inbound event
-- ---------------------------------------------------------------------------

create table if not exists public.netsuite_sync_events (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  provider_name         text          not null default 'netsuite',
  sync_run_id           text,
  object_type           text          not null,
  object_key            text          not null,
  internal_record_id    text,
  netsuite_record_id    text,
  direction             text          not null default 'outbound',
  sync_status           text          not null default 'attempted',
  failure_class         text,
  failure_code          text,
  failure_message       text,
  retry_count           integer       not null default 0,
  max_retries           integer       not null default 3,
  idempotency_key       text,
  source_system         text          not null default 'netsuite',
  source_event_id       text          not null,
  correlation_id        text,
  payload_digest        text,
  operator_notes        text,
  replayed_from_id      uuid          references public.netsuite_sync_events(id),
  occurred_at           timestamptz   not null default now(),
  resolved_at           timestamptz,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint netsuite_sync_events_provider_name_chk
    check (provider_name = 'netsuite'),

  constraint netsuite_sync_events_object_type_chk
    check (object_type in ('customer', 'invoice', 'journal_entry')),

  constraint netsuite_sync_events_direction_chk
    check (direction in ('inbound', 'outbound')),

  constraint netsuite_sync_events_sync_status_chk
    check (sync_status in (
      'attempted',
      'synced',
      'retrying',
      'dead_lettered',
      'quarantined',
      'replayed',
      'disabled'
    )),

  constraint netsuite_sync_events_failure_class_chk
    check (failure_class is null or failure_class in (
      'auth',
      'transport',
      'rate_limit',
      'invalid_payload',
      'validation',
      'duplicate',
      'unknown'
    )),

  constraint netsuite_sync_events_retry_count_chk
    check (retry_count >= 0 and max_retries >= 0 and retry_count <= max_retries),

  constraint netsuite_sync_events_dedupe_uniq
    unique nulls not distinct (
      tenant_id,
      provider_name,
      source_system,
      source_event_id,
      object_type,
      idempotency_key
    )
);

create index if not exists idx_netsuite_sync_events_tenant_object_status
  on public.netsuite_sync_events (tenant_id, object_type, sync_status, occurred_at desc);

create index if not exists idx_netsuite_sync_events_tenant_object_key
  on public.netsuite_sync_events (tenant_id, object_type, object_key, occurred_at desc);

create index if not exists idx_netsuite_sync_events_failure_class
  on public.netsuite_sync_events (tenant_id, failure_class, occurred_at desc)
  where failure_class is not null;

create trigger trg_netsuite_sync_events_updated_at
  before update on public.netsuite_sync_events
  for each row execute function update_updated_at();

revoke all on table public.netsuite_sync_events from anon, authenticated;
grant select on table public.netsuite_sync_events to authenticated;
grant all on table public.netsuite_sync_events to service_role;

alter table public.netsuite_sync_events enable row level security;

drop policy if exists "netsuite_sync_events_ops_read" on public.netsuite_sync_events;
drop policy if exists "netsuite_sync_events_service_role" on public.netsuite_sync_events;

create policy "netsuite_sync_events_ops_read"
  on public.netsuite_sync_events
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "netsuite_sync_events_service_role"
  on public.netsuite_sync_events
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- 2. Dead-letter queue — quarantine sink for unrecoverable / operator-held events
-- ---------------------------------------------------------------------------

create table if not exists public.netsuite_dead_letter_queue (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  sync_event_id         uuid          not null references public.netsuite_sync_events(id),
  provider_name         text          not null default 'netsuite',
  object_type           text          not null,
  object_key            text          not null,
  internal_record_id    text,
  netsuite_record_id    text,
  failure_class         text          not null default 'unknown',
  failure_code          text,
  failure_message       text          not null,
  retry_count           integer       not null default 0,
  quarantine_reason     text          not null,
  quarantined_by        text,
  replay_eligible       boolean       not null default false,
  replayed_at           timestamptz,
  replayed_by           text,
  replay_sync_event_id  uuid          references public.netsuite_sync_events(id),
  resolved_at           timestamptz,
  resolved_by           text,
  resolution_note       text,
  payload_snapshot      jsonb         not null default '{}'::jsonb,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint netsuite_dlq_failure_class_chk
    check (failure_class in (
      'auth',
      'transport',
      'rate_limit',
      'invalid_payload',
      'validation',
      'duplicate',
      'unknown'
    )),

  constraint netsuite_dlq_object_type_chk
    check (object_type in ('customer', 'invoice', 'journal_entry')),

  constraint netsuite_dlq_sync_event_uniq
    unique (sync_event_id)
);

create index if not exists idx_netsuite_dlq_tenant_object_type
  on public.netsuite_dead_letter_queue (tenant_id, object_type, created_at desc);

create index if not exists idx_netsuite_dlq_tenant_replay_eligible
  on public.netsuite_dead_letter_queue (tenant_id, replay_eligible, created_at desc)
  where replay_eligible = true and replayed_at is null and resolved_at is null;

create trigger trg_netsuite_dlq_updated_at
  before update on public.netsuite_dead_letter_queue
  for each row execute function update_updated_at();

revoke all on table public.netsuite_dead_letter_queue from anon, authenticated;
grant select on table public.netsuite_dead_letter_queue to authenticated;
grant all on table public.netsuite_dead_letter_queue to service_role;

alter table public.netsuite_dead_letter_queue enable row level security;

drop policy if exists "netsuite_dlq_ops_read" on public.netsuite_dead_letter_queue;
drop policy if exists "netsuite_dlq_service_role" on public.netsuite_dead_letter_queue;

create policy "netsuite_dlq_ops_read"
  on public.netsuite_dead_letter_queue
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "netsuite_dlq_service_role"
  on public.netsuite_dead_letter_queue
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- 3. Sync controls — per-object disable / re-enable gate
-- ---------------------------------------------------------------------------

create table if not exists public.netsuite_sync_controls (
  id              uuid          primary key default gen_random_uuid(),
  tenant_id       uuid          not null references public.tenants(id) on delete restrict,
  provider_name   text          not null default 'netsuite',
  object_type     text          not null,
  object_key      text          not null,
  source_system   text          not null default 'netsuite',
  control_status  text          not null default 'active',
  disabled_reason text,
  disabled_by     text,
  disabled_at     timestamptz,
  reenabled_at    timestamptz,
  reenabled_by    text,
  operator_notes  text,
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),

  constraint netsuite_sync_controls_provider_name_chk
    check (provider_name = 'netsuite'),

  constraint netsuite_sync_controls_object_type_chk
    check (object_type in ('customer', 'invoice', 'journal_entry')),

  constraint netsuite_sync_controls_status_chk
    check (control_status in ('active', 'disabled')),

  constraint netsuite_sync_controls_scope_uniq
    unique (tenant_id, provider_name, object_type, object_key, source_system)
);

create trigger trg_netsuite_sync_controls_updated_at
  before update on public.netsuite_sync_controls
  for each row execute function update_updated_at();

revoke all on table public.netsuite_sync_controls from anon, authenticated;
grant select on table public.netsuite_sync_controls to authenticated;
grant all on table public.netsuite_sync_controls to service_role;

alter table public.netsuite_sync_controls enable row level security;

drop policy if exists "netsuite_sync_controls_ops_read" on public.netsuite_sync_controls;
drop policy if exists "netsuite_sync_controls_service_role" on public.netsuite_sync_controls;

create policy "netsuite_sync_controls_ops_read"
  on public.netsuite_sync_controls
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "netsuite_sync_controls_service_role"
  on public.netsuite_sync_controls
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- 4. Reconciliation results — drift detection per object
-- ---------------------------------------------------------------------------

create table if not exists public.netsuite_reconciliation_results (
  id                  uuid          primary key default gen_random_uuid(),
  tenant_id           uuid          not null references public.tenants(id) on delete restrict,
  provider_name       text          not null default 'netsuite',
  object_type         text          not null,
  object_key          text          not null,
  internal_record_id  text,
  netsuite_record_id    text,
  drift_status        text          not null default 'unknown',
  internal_digest     text,
  netsuite_digest       text,
  compared_fields     jsonb         not null default '[]'::jsonb,
  diagnostic_summary  text,
  last_sync_event_id  uuid          references public.netsuite_sync_events(id),
  checked_at          timestamptz   not null default now(),
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),

  constraint netsuite_recon_object_type_chk
    check (object_type in ('customer', 'invoice', 'journal_entry')),

  constraint netsuite_recon_drift_status_chk
    check (drift_status in ('in_sync', 'drifted', 'missing_internal', 'missing_netsuite', 'unknown')),

  constraint netsuite_recon_dedupe_uniq
    unique (tenant_id, provider_name, object_type, object_key)
);

create index if not exists idx_netsuite_recon_tenant_object_drift
  on public.netsuite_reconciliation_results (tenant_id, object_type, drift_status, checked_at desc);

create trigger trg_netsuite_recon_updated_at
  before update on public.netsuite_reconciliation_results
  for each row execute function update_updated_at();

revoke all on table public.netsuite_reconciliation_results from anon, authenticated;
grant select on table public.netsuite_reconciliation_results to authenticated;
grant all on table public.netsuite_reconciliation_results to service_role;

alter table public.netsuite_reconciliation_results enable row level security;

drop policy if exists "netsuite_recon_ops_read" on public.netsuite_reconciliation_results;
drop policy if exists "netsuite_recon_service_role" on public.netsuite_reconciliation_results;

create policy "netsuite_recon_ops_read"
  on public.netsuite_reconciliation_results
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "netsuite_recon_service_role"
  on public.netsuite_reconciliation_results
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- 5. Operator functions — quarantine, replay, disable, re-enable
-- ---------------------------------------------------------------------------

create or replace function public.netsuite_quarantine_sync_event(
  p_sync_event_id     uuid,
  p_quarantine_reason text,
  p_replay_eligible   boolean default false,
  p_operator_notes    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_event   public.netsuite_sync_events%rowtype;
  v_dlq_id  uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'netsuite_quarantine_sync_event: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.netsuite_sync_events
  where id = p_sync_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'netsuite_quarantine_sync_event: sync event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if v_event.sync_status = 'quarantined' then
    raise exception 'netsuite_quarantine_sync_event: sync event is already quarantined'
      using errcode = 'check_violation';
  end if;

  update public.netsuite_sync_events
  set
    sync_status    = 'quarantined',
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now()
  where id = p_sync_event_id;

  insert into public.netsuite_dead_letter_queue (
    tenant_id,
    sync_event_id,
    provider_name,
    object_type,
    object_key,
    internal_record_id,
    netsuite_record_id,
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
    v_event.provider_name,
    v_event.object_type,
    v_event.object_key,
    v_event.internal_record_id,
    v_event.netsuite_record_id,
    coalesce(v_event.failure_class, 'unknown'),
    v_event.failure_code,
    coalesce(v_event.failure_message, 'quarantined by operator'),
    v_event.retry_count,
    p_quarantine_reason,
    v_role,
    p_replay_eligible,
    v_event.metadata,
    jsonb_build_object(
      'quarantined_at',  now(),
      'original_status', v_event.sync_status,
      'operator_notes',  p_operator_notes
    )
  )
  on conflict (sync_event_id) do update
    set
      quarantine_reason = excluded.quarantine_reason,
      replay_eligible   = excluded.replay_eligible,
      updated_at        = now()
  returning id into v_dlq_id;

  return v_dlq_id;
end;
$$;

revoke all on function public.netsuite_quarantine_sync_event(uuid, text, boolean, text) from anon;
grant execute on function public.netsuite_quarantine_sync_event(uuid, text, boolean, text)
  to authenticated, service_role;

create or replace function public.netsuite_mark_replayed(
  p_dlq_id         uuid,
  p_replay_actor   text,
  p_operator_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role          text;
  v_dlq           public.netsuite_dead_letter_queue%rowtype;
  v_source_event  public.netsuite_sync_events%rowtype;
  v_replay_id     uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'netsuite_mark_replayed: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_dlq
  from public.netsuite_dead_letter_queue
  where id = p_dlq_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'netsuite_mark_replayed: DLQ entry not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if not v_dlq.replay_eligible then
    raise exception 'netsuite_mark_replayed: DLQ entry is not marked replay-eligible'
      using errcode = 'check_violation';
  end if;

  if v_dlq.replayed_at is not null then
    raise exception 'netsuite_mark_replayed: DLQ entry has already been replayed at %',
      v_dlq.replayed_at
      using errcode = 'check_violation';
  end if;

  select * into v_source_event
  from public.netsuite_sync_events
  where id = v_dlq.sync_event_id;

  insert into public.netsuite_sync_events (
    tenant_id,
    provider_name,
    sync_run_id,
    object_type,
    object_key,
    internal_record_id,
    netsuite_record_id,
    direction,
    sync_status,
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
    v_source_event.provider_name,
    v_source_event.sync_run_id,
    v_source_event.object_type,
    v_source_event.object_key,
    v_source_event.internal_record_id,
    v_source_event.netsuite_record_id,
    v_source_event.direction,
    'replayed',
    v_source_event.source_system,
    v_source_event.source_event_id,
    v_source_event.correlation_id,
    v_source_event.payload_digest,
    null,
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

  update public.netsuite_dead_letter_queue
  set
    replayed_at          = now(),
    replayed_by          = coalesce(p_replay_actor, v_role),
    replay_sync_event_id = v_replay_id,
    resolved_at          = now(),
    resolved_by          = coalesce(p_replay_actor, v_role),
    resolution_note      = coalesce(p_operator_notes, resolution_note),
    updated_at           = now()
  where id = p_dlq_id;

  update public.netsuite_sync_events
  set
    resolved_at = now(),
    updated_at  = now()
  where id = v_source_event.id;

  return v_replay_id;
end;
$$;

revoke all on function public.netsuite_mark_replayed(uuid, text, text) from anon;
grant execute on function public.netsuite_mark_replayed(uuid, text, text)
  to authenticated, service_role;

create or replace function public.netsuite_disable_sync_scope(
  p_sync_event_id  uuid,
  p_disable_reason text,
  p_operator_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_event       public.netsuite_sync_events%rowtype;
  v_control_id  uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'netsuite_disable_sync_scope: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.netsuite_sync_events
  where id = p_sync_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'netsuite_disable_sync_scope: sync event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  insert into public.netsuite_sync_controls (
    tenant_id,
    provider_name,
    object_type,
    object_key,
    source_system,
    control_status,
    disabled_reason,
    disabled_by,
    disabled_at,
    operator_notes,
    metadata
  )
  values (
    v_event.tenant_id,
    v_event.provider_name,
    v_event.object_type,
    v_event.object_key,
    v_event.source_system,
    'disabled',
    p_disable_reason,
    v_role,
    now(),
    p_operator_notes,
    jsonb_build_object(
      'sync_event_id', v_event.id,
      'disabled_at',   now()
    )
  )
  on conflict (tenant_id, provider_name, object_type, object_key, source_system) do update
    set
      control_status  = 'disabled',
      disabled_reason = excluded.disabled_reason,
      disabled_by     = excluded.disabled_by,
      disabled_at     = now(),
      reenabled_at    = null,
      reenabled_by    = null,
      operator_notes  = coalesce(excluded.operator_notes, public.netsuite_sync_controls.operator_notes),
      updated_at      = now()
  returning id into v_control_id;

  update public.netsuite_sync_events
  set
    sync_status    = 'disabled',
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now(),
    metadata       = metadata || jsonb_build_object('disabled_control_id', v_control_id)
  where id = p_sync_event_id;

  return v_control_id;
end;
$$;

revoke all on function public.netsuite_disable_sync_scope(uuid, text, text) from anon;
grant execute on function public.netsuite_disable_sync_scope(uuid, text, text)
  to authenticated, service_role;

create or replace function public.netsuite_enable_sync_scope(
  p_control_id     uuid,
  p_reenable_actor text default null,
  p_operator_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_control public.netsuite_sync_controls%rowtype;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'netsuite_enable_sync_scope: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_control
  from public.netsuite_sync_controls
  where id = p_control_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'netsuite_enable_sync_scope: sync control not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  update public.netsuite_sync_controls
  set
    control_status = 'active',
    reenabled_at   = now(),
    reenabled_by   = coalesce(p_reenable_actor, v_role),
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now()
  where id = p_control_id;

  update public.netsuite_sync_events
  set
    resolved_at = now(),
    updated_at  = now()
  where tenant_id = v_control.tenant_id
    and provider_name = v_control.provider_name
    and object_type = v_control.object_type
    and object_key = v_control.object_key
    and source_system = v_control.source_system
    and sync_status = 'disabled'
    and resolved_at is null;

  return p_control_id;
end;
$$;

revoke all on function public.netsuite_enable_sync_scope(uuid, text, text) from anon;
grant execute on function public.netsuite_enable_sync_scope(uuid, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Operator views — dashboard, failed work, reconciliation drift
-- ---------------------------------------------------------------------------

create or replace view public.v_netsuite_sync_dashboard
  with (security_invoker = true) as
select
  e.tenant_id,
  e.provider_name,
  e.object_type,
  e.direction,
  count(*)                                                              as total_attempts,
  count(*) filter (where e.sync_status = 'synced')                      as synced_count,
  count(*) filter (where e.sync_status = 'retrying')                    as retrying_count,
  count(*) filter (where e.sync_status = 'dead_lettered')               as dead_lettered_count,
  count(*) filter (where e.sync_status = 'quarantined')                 as quarantined_count,
  count(*) filter (where e.sync_status = 'replayed')                    as replayed_count,
  count(*) filter (where e.sync_status = 'disabled')                    as disabled_count,
  count(*) filter (where e.failure_class = 'auth')                      as auth_failure_count,
  count(*) filter (where e.failure_class = 'transport')                 as transport_failure_count,
  count(*) filter (where e.failure_class = 'rate_limit')                as rate_limit_failure_count,
  count(*) filter (where e.failure_class = 'invalid_payload')           as invalid_payload_failure_count,
  max(e.occurred_at)                                                    as last_attempt_at,
  max(e.occurred_at) filter (where e.sync_status = 'synced')            as last_synced_at,
  max(e.occurred_at) filter (
    where e.sync_status in ('dead_lettered', 'quarantined', 'disabled')
  )                                                                     as last_failure_at
from public.netsuite_sync_events e
group by e.tenant_id, e.provider_name, e.object_type, e.direction;

revoke all on table public.v_netsuite_sync_dashboard from anon;
grant select on table public.v_netsuite_sync_dashboard to authenticated, service_role;

create or replace view public.v_netsuite_failed_sync_work
  with (security_invoker = true) as
select
  e.id,
  e.tenant_id,
  e.provider_name,
  e.object_type,
  e.object_key,
  e.internal_record_id,
  e.netsuite_record_id,
  e.direction,
  e.sync_status,
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
  dlq.id                   as dlq_id,
  dlq.replay_eligible,
  dlq.replayed_at,
  dlq.quarantine_reason,
  ctrl.id                  as control_id,
  ctrl.control_status,
  ctrl.disabled_reason,
  ctrl.disabled_at
from public.netsuite_sync_events e
left join public.netsuite_dead_letter_queue dlq
  on dlq.sync_event_id = e.id
left join public.netsuite_sync_controls ctrl
  on ctrl.tenant_id = e.tenant_id
 and ctrl.provider_name = e.provider_name
 and ctrl.object_type = e.object_type
 and ctrl.object_key = e.object_key
 and ctrl.source_system = e.source_system
 and ctrl.control_status = 'disabled'
where e.sync_status in ('retrying', 'dead_lettered', 'quarantined', 'disabled')
  and e.resolved_at is null;

revoke all on table public.v_netsuite_failed_sync_work from anon;
grant select on table public.v_netsuite_failed_sync_work to authenticated, service_role;

create or replace view public.v_netsuite_reconciliation_drift
  with (security_invoker = true) as
select
  r.id,
  r.tenant_id,
  r.provider_name,
  r.object_type,
  r.object_key,
  r.internal_record_id,
  r.netsuite_record_id,
  r.drift_status,
  r.internal_digest,
  r.netsuite_digest,
  r.compared_fields,
  r.diagnostic_summary,
  r.last_sync_event_id,
  r.checked_at,
  ctrl.id                as control_id,
  ctrl.control_status,
  ctrl.disabled_reason,
  dlq.id                 as dlq_id,
  dlq.quarantine_reason,
  dlq.replay_eligible
from public.netsuite_reconciliation_results r
left join public.netsuite_sync_controls ctrl
  on ctrl.tenant_id = r.tenant_id
 and ctrl.provider_name = r.provider_name
 and ctrl.object_type = r.object_type
 and ctrl.object_key = r.object_key
 and ctrl.control_status = 'disabled'
left join public.netsuite_dead_letter_queue dlq
  on dlq.tenant_id = r.tenant_id
 and dlq.provider_name = r.provider_name
 and dlq.object_type = r.object_type
 and dlq.object_key = r.object_key
 and dlq.resolved_at is null
where r.drift_status <> 'in_sync';

revoke all on table public.v_netsuite_reconciliation_drift from anon;
grant select on table public.v_netsuite_reconciliation_drift to authenticated, service_role;

create or replace view public.v_netsuite_reconciliation_summary
  with (security_invoker = true) as
select
  r.tenant_id,
  r.provider_name,
  r.object_type,
  r.drift_status,
  count(*)           as object_count,
  max(r.checked_at)  as last_checked_at
from public.netsuite_reconciliation_results r
group by r.tenant_id, r.provider_name, r.object_type, r.drift_status;

revoke all on table public.v_netsuite_reconciliation_summary from anon;
grant select on table public.v_netsuite_reconciliation_summary to authenticated, service_role;
