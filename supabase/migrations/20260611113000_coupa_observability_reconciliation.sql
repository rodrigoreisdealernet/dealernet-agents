-- ---------------------------------------------------------------------------
-- Coupa sync observability, reconciliation, and operator recovery controls
--
-- Adds tenant-scoped tables and operator tooling for Coupa procurement syncs,
-- covering:
--   - sync status, retry state, and dead-letter outcomes per supported object
--   - operator-controlled replay, disable, and re-enable controls
--   - reconciliation diagnostics for requisitions, purchase orders, suppliers,
--     and invoices
--
-- Depends on: shared tenants table, ops_claim_app_role(), ops_tenant_match()
-- Related issues: #1145, #892, #483
-- ---------------------------------------------------------------------------

create table if not exists public.coupa_sync_events (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  provider_name         text          not null default 'coupa',
  sync_run_id           text,
  object_type           text          not null,
  object_key            text          not null,
  internal_record_id    text,
  coupa_record_id       text,
  direction             text          not null default 'outbound',
  sync_status           text          not null default 'attempted',
  failure_class         text,
  failure_code          text,
  failure_message       text,
  retry_count           integer       not null default 0,
  max_retries           integer       not null default 3,
  idempotency_key       text,
  source_system         text          not null default 'coupa',
  source_event_id       text          not null,
  correlation_id        text,
  payload_digest        text,
  operator_notes        text,
  replayed_from_id      uuid          references public.coupa_sync_events(id),
  occurred_at           timestamptz   not null default now(),
  resolved_at           timestamptz,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint coupa_sync_events_provider_name_chk
    check (provider_name = 'coupa'),

  constraint coupa_sync_events_object_type_chk
    check (object_type in ('requisition', 'purchase_order', 'supplier', 'invoice')),

  constraint coupa_sync_events_direction_chk
    check (direction in ('inbound', 'outbound')),

  constraint coupa_sync_events_sync_status_chk
    check (sync_status in (
      'attempted',
      'synced',
      'retrying',
      'dead_lettered',
      'quarantined',
      'replayed',
      'disabled'
    )),

  constraint coupa_sync_events_failure_class_chk
    check (failure_class is null or failure_class in (
      'auth',
      'mapping',
      'provider_policy',
      'rate_limit',
      'timeout',
      'duplicate',
      'validation',
      'workflow',
      'unknown'
    )),

  constraint coupa_sync_events_dedupe_uniq
    unique nulls not distinct (
      tenant_id,
      provider_name,
      source_system,
      source_event_id,
      object_type,
      idempotency_key
    )
);

create index if not exists idx_coupa_sync_events_tenant_object_status
  on public.coupa_sync_events (tenant_id, object_type, sync_status, occurred_at desc);

create index if not exists idx_coupa_sync_events_tenant_object_key
  on public.coupa_sync_events (tenant_id, object_type, object_key, occurred_at desc);

create index if not exists idx_coupa_sync_events_failure_class
  on public.coupa_sync_events (tenant_id, failure_class, occurred_at desc)
  where failure_class is not null;

create trigger trg_coupa_sync_events_updated_at
  before update on public.coupa_sync_events
  for each row execute function update_updated_at();

revoke all on table public.coupa_sync_events from anon, authenticated;
grant select on table public.coupa_sync_events to authenticated;
grant all on table public.coupa_sync_events to service_role;

alter table public.coupa_sync_events enable row level security;

drop policy if exists "coupa_sync_events_ops_read" on public.coupa_sync_events;
drop policy if exists "coupa_sync_events_service_role" on public.coupa_sync_events;

create policy "coupa_sync_events_ops_read"
  on public.coupa_sync_events
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "coupa_sync_events_service_role"
  on public.coupa_sync_events
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

create table if not exists public.coupa_dead_letter_queue (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  sync_event_id         uuid          not null references public.coupa_sync_events(id),
  provider_name         text          not null default 'coupa',
  object_type           text          not null,
  object_key            text          not null,
  internal_record_id    text,
  coupa_record_id       text,
  failure_class         text          not null default 'unknown',
  failure_code          text,
  failure_message       text          not null,
  retry_count           integer       not null default 0,
  quarantine_reason     text          not null,
  quarantined_by        text,
  replay_eligible       boolean       not null default false,
  replayed_at           timestamptz,
  replayed_by           text,
  replay_sync_event_id  uuid          references public.coupa_sync_events(id),
  resolved_at           timestamptz,
  resolved_by           text,
  resolution_note       text,
  payload_snapshot      jsonb         not null default '{}'::jsonb,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint coupa_dead_letter_provider_name_chk
    check (provider_name = 'coupa'),

  constraint coupa_dead_letter_object_type_chk
    check (object_type in ('requisition', 'purchase_order', 'supplier', 'invoice')),

  constraint coupa_dead_letter_failure_class_chk
    check (failure_class in (
      'auth',
      'mapping',
      'provider_policy',
      'rate_limit',
      'timeout',
      'duplicate',
      'validation',
      'workflow',
      'unknown'
    )),

  constraint coupa_dead_letter_sync_event_uniq
    unique (sync_event_id)
);

create index if not exists idx_coupa_dlq_tenant_object
  on public.coupa_dead_letter_queue (tenant_id, object_type, created_at desc);

create index if not exists idx_coupa_dlq_replay_eligible
  on public.coupa_dead_letter_queue (tenant_id, replay_eligible, created_at desc)
  where replay_eligible = true and replayed_at is null and resolved_at is null;

create trigger trg_coupa_dead_letter_queue_updated_at
  before update on public.coupa_dead_letter_queue
  for each row execute function update_updated_at();

revoke all on table public.coupa_dead_letter_queue from anon, authenticated;
grant select on table public.coupa_dead_letter_queue to authenticated;
grant all on table public.coupa_dead_letter_queue to service_role;

alter table public.coupa_dead_letter_queue enable row level security;

drop policy if exists "coupa_dead_letter_queue_ops_read" on public.coupa_dead_letter_queue;
drop policy if exists "coupa_dead_letter_queue_service_role" on public.coupa_dead_letter_queue;

create policy "coupa_dead_letter_queue_ops_read"
  on public.coupa_dead_letter_queue
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "coupa_dead_letter_queue_service_role"
  on public.coupa_dead_letter_queue
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

create table if not exists public.coupa_sync_controls (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  provider_name         text          not null default 'coupa',
  object_type           text          not null,
  object_key            text          not null,
  source_system         text          not null default 'coupa',
  control_status        text          not null default 'disabled',
  disabled_reason       text,
  disabled_by           text,
  disabled_at           timestamptz,
  reenabled_at          timestamptz,
  reenabled_by          text,
  operator_notes        text,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint coupa_sync_controls_provider_name_chk
    check (provider_name = 'coupa'),

  constraint coupa_sync_controls_object_type_chk
    check (object_type in ('requisition', 'purchase_order', 'supplier', 'invoice')),

  constraint coupa_sync_controls_status_chk
    check (control_status in ('disabled', 'active')),

  constraint coupa_sync_controls_scope_uniq
    unique (tenant_id, provider_name, object_type, object_key, source_system)
);

create index if not exists idx_coupa_sync_controls_active
  on public.coupa_sync_controls (tenant_id, object_type, control_status, updated_at desc);

create trigger trg_coupa_sync_controls_updated_at
  before update on public.coupa_sync_controls
  for each row execute function update_updated_at();

revoke all on table public.coupa_sync_controls from anon, authenticated;
grant select on table public.coupa_sync_controls to authenticated;
grant all on table public.coupa_sync_controls to service_role;

alter table public.coupa_sync_controls enable row level security;

drop policy if exists "coupa_sync_controls_ops_read" on public.coupa_sync_controls;
drop policy if exists "coupa_sync_controls_service_role" on public.coupa_sync_controls;

create policy "coupa_sync_controls_ops_read"
  on public.coupa_sync_controls
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "coupa_sync_controls_service_role"
  on public.coupa_sync_controls
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

create table if not exists public.coupa_reconciliation_results (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  provider_name         text          not null default 'coupa',
  object_type           text          not null,
  object_key            text          not null,
  internal_record_id    text,
  coupa_record_id       text,
  drift_status          text          not null,
  internal_digest       text,
  coupa_digest          text,
  compared_fields       jsonb         not null default '[]'::jsonb,
  diagnostic_summary    text,
  last_sync_event_id    uuid          references public.coupa_sync_events(id),
  checked_at            timestamptz   not null default now(),
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint coupa_reconciliation_provider_name_chk
    check (provider_name = 'coupa'),

  constraint coupa_reconciliation_object_type_chk
    check (object_type in ('requisition', 'purchase_order', 'supplier', 'invoice')),

  constraint coupa_reconciliation_drift_status_chk
    check (drift_status in (
      'in_sync',
      'missing_in_coupa',
      'missing_in_wynne',
      'field_mismatch',
      'quarantined',
      'disabled'
    )),

  constraint coupa_reconciliation_scope_uniq
    unique (tenant_id, provider_name, object_type, object_key)
);

create index if not exists idx_coupa_reconciliation_tenant_object
  on public.coupa_reconciliation_results (tenant_id, object_type, drift_status, checked_at desc);

create trigger trg_coupa_reconciliation_results_updated_at
  before update on public.coupa_reconciliation_results
  for each row execute function update_updated_at();

revoke all on table public.coupa_reconciliation_results from anon, authenticated;
grant select on table public.coupa_reconciliation_results to authenticated;
grant all on table public.coupa_reconciliation_results to service_role;

alter table public.coupa_reconciliation_results enable row level security;

drop policy if exists "coupa_reconciliation_results_ops_read" on public.coupa_reconciliation_results;
drop policy if exists "coupa_reconciliation_results_service_role" on public.coupa_reconciliation_results;

create policy "coupa_reconciliation_results_ops_read"
  on public.coupa_reconciliation_results
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "coupa_reconciliation_results_service_role"
  on public.coupa_reconciliation_results
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

create or replace function public.coupa_quarantine_sync_event(
  p_sync_event_id       uuid,
  p_quarantine_reason   text,
  p_replay_eligible     boolean default false,
  p_operator_notes      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_event       public.coupa_sync_events%rowtype;
  v_dlq_id      uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'coupa_quarantine_sync_event: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.coupa_sync_events
  where id = p_sync_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'coupa_quarantine_sync_event: sync event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if v_event.sync_status = 'quarantined' then
    raise exception 'coupa_quarantine_sync_event: sync event is already quarantined'
      using errcode = 'check_violation';
  end if;

  update public.coupa_sync_events
  set
    sync_status    = 'quarantined',
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now()
  where id = p_sync_event_id;

  insert into public.coupa_dead_letter_queue (
    tenant_id,
    sync_event_id,
    provider_name,
    object_type,
    object_key,
    internal_record_id,
    coupa_record_id,
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
    v_event.coupa_record_id,
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

revoke all on function public.coupa_quarantine_sync_event(uuid, text, boolean, text) from anon;
grant execute on function public.coupa_quarantine_sync_event(uuid, text, boolean, text)
  to authenticated, service_role;

create or replace function public.coupa_mark_replayed(
  p_dlq_id             uuid,
  p_replay_actor       text,
  p_operator_notes     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role          text;
  v_dlq           public.coupa_dead_letter_queue%rowtype;
  v_source_event  public.coupa_sync_events%rowtype;
  v_replay_id     uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'coupa_mark_replayed: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_dlq
  from public.coupa_dead_letter_queue
  where id = p_dlq_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'coupa_mark_replayed: DLQ entry not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if not v_dlq.replay_eligible then
    raise exception 'coupa_mark_replayed: DLQ entry is not marked replay-eligible'
      using errcode = 'check_violation';
  end if;

  if v_dlq.replayed_at is not null then
    raise exception 'coupa_mark_replayed: DLQ entry has already been replayed at %',
      v_dlq.replayed_at
      using errcode = 'check_violation';
  end if;

  select * into v_source_event
  from public.coupa_sync_events
  where id = v_dlq.sync_event_id;

  insert into public.coupa_sync_events (
    tenant_id,
    provider_name,
    sync_run_id,
    object_type,
    object_key,
    internal_record_id,
    coupa_record_id,
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
    v_source_event.coupa_record_id,
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

  update public.coupa_dead_letter_queue
  set
    replayed_at          = now(),
    replayed_by          = coalesce(p_replay_actor, v_role),
    replay_sync_event_id = v_replay_id,
    resolved_at          = now(),
    resolved_by          = coalesce(p_replay_actor, v_role),
    resolution_note      = coalesce(p_operator_notes, resolution_note),
    updated_at           = now()
  where id = p_dlq_id;

  update public.coupa_sync_events
  set
    resolved_at = now(),
    updated_at  = now()
  where id = v_source_event.id;

  return v_replay_id;
end;
$$;

revoke all on function public.coupa_mark_replayed(uuid, text, text) from anon;
grant execute on function public.coupa_mark_replayed(uuid, text, text)
  to authenticated, service_role;

create or replace function public.coupa_disable_sync_scope(
  p_sync_event_id       uuid,
  p_disable_reason      text,
  p_operator_notes      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_event       public.coupa_sync_events%rowtype;
  v_control_id  uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'coupa_disable_sync_scope: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.coupa_sync_events
  where id = p_sync_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'coupa_disable_sync_scope: sync event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  insert into public.coupa_sync_controls (
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
      operator_notes  = coalesce(excluded.operator_notes, public.coupa_sync_controls.operator_notes),
      updated_at      = now()
  returning id into v_control_id;

  update public.coupa_sync_events
  set
    sync_status    = 'disabled',
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now(),
    metadata       = metadata || jsonb_build_object('disabled_control_id', v_control_id)
  where id = p_sync_event_id;

  return v_control_id;
end;
$$;

revoke all on function public.coupa_disable_sync_scope(uuid, text, text) from anon;
grant execute on function public.coupa_disable_sync_scope(uuid, text, text)
  to authenticated, service_role;

create or replace function public.coupa_enable_sync_scope(
  p_control_id          uuid,
  p_reenable_actor      text default null,
  p_operator_notes      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role     text;
  v_control  public.coupa_sync_controls%rowtype;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'coupa_enable_sync_scope: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_control
  from public.coupa_sync_controls
  where id = p_control_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'coupa_enable_sync_scope: sync control not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  update public.coupa_sync_controls
  set
    control_status = 'active',
    reenabled_at   = now(),
    reenabled_by   = coalesce(p_reenable_actor, v_role),
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now()
  where id = p_control_id;

  update public.coupa_sync_events
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

revoke all on function public.coupa_enable_sync_scope(uuid, text, text) from anon;
grant execute on function public.coupa_enable_sync_scope(uuid, text, text)
  to authenticated, service_role;

create or replace view public.v_coupa_sync_dashboard
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
  count(*) filter (where e.failure_class = 'mapping')                   as mapping_failure_count,
  count(*) filter (where e.failure_class = 'provider_policy')           as provider_policy_failure_count,
  count(*) filter (where e.failure_class = 'rate_limit')                as rate_limit_failure_count,
  max(e.occurred_at)                                                    as last_attempt_at,
  max(e.occurred_at) filter (where e.sync_status = 'synced')            as last_synced_at,
  max(e.occurred_at) filter (
    where e.sync_status in ('dead_lettered', 'quarantined', 'disabled')
  )                                                                     as last_failure_at
from public.coupa_sync_events e
group by e.tenant_id, e.provider_name, e.object_type, e.direction;

revoke all on table public.v_coupa_sync_dashboard from anon;
grant select on table public.v_coupa_sync_dashboard to authenticated, service_role;

create or replace view public.v_coupa_failed_sync_work
  with (security_invoker = true) as
select
  e.id,
  e.tenant_id,
  e.provider_name,
  e.object_type,
  e.object_key,
  e.internal_record_id,
  e.coupa_record_id,
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
from public.coupa_sync_events e
left join public.coupa_dead_letter_queue dlq
  on dlq.sync_event_id = e.id
left join public.coupa_sync_controls ctrl
  on ctrl.tenant_id = e.tenant_id
 and ctrl.provider_name = e.provider_name
 and ctrl.object_type = e.object_type
 and ctrl.object_key = e.object_key
 and ctrl.source_system = e.source_system
 and ctrl.control_status = 'disabled'
where e.sync_status in ('retrying', 'dead_lettered', 'quarantined', 'disabled')
  and e.resolved_at is null;

revoke all on table public.v_coupa_failed_sync_work from anon;
grant select on table public.v_coupa_failed_sync_work to authenticated, service_role;

create or replace view public.v_coupa_reconciliation_drift
  with (security_invoker = true) as
select
  r.id,
  r.tenant_id,
  r.provider_name,
  r.object_type,
  r.object_key,
  r.internal_record_id,
  r.coupa_record_id,
  r.drift_status,
  r.internal_digest,
  r.coupa_digest,
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
from public.coupa_reconciliation_results r
left join public.coupa_sync_controls ctrl
  on ctrl.tenant_id = r.tenant_id
 and ctrl.provider_name = r.provider_name
 and ctrl.object_type = r.object_type
 and ctrl.object_key = r.object_key
 and ctrl.control_status = 'disabled'
left join public.coupa_dead_letter_queue dlq
  on dlq.tenant_id = r.tenant_id
 and dlq.provider_name = r.provider_name
 and dlq.object_type = r.object_type
 and dlq.object_key = r.object_key
 and dlq.resolved_at is null
where r.drift_status <> 'in_sync';

revoke all on table public.v_coupa_reconciliation_drift from anon;
grant select on table public.v_coupa_reconciliation_drift to authenticated, service_role;

create or replace view public.v_coupa_reconciliation_summary
  with (security_invoker = true) as
select
  r.tenant_id,
  r.provider_name,
  r.object_type,
  r.drift_status,
  count(*)            as object_count,
  max(r.checked_at)   as last_checked_at
from public.coupa_reconciliation_results r
group by r.tenant_id, r.provider_name, r.object_type, r.drift_status;

revoke all on table public.v_coupa_reconciliation_summary from anon;
grant select on table public.v_coupa_reconciliation_summary to authenticated, service_role;
