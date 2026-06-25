-- ---------------------------------------------------------------------------
-- Caterpillar VisionLink observability, reconciliation, and operator controls
--
-- Adds tenant-scoped sync event telemetry, dead-letter controls, disable controls,
-- and reconciliation diagnostics for VisionLink-supported telematics signals.
--
-- Depends on: shared tenants table, ops_claim_app_role(), ops_tenant_match()
-- Related issues: #1159, #892, #442, #478
-- ---------------------------------------------------------------------------

create table if not exists public.visionlink_sync_events (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  provider_name         text          not null default 'visionlink',
  sync_run_id           text,
  asset_id              uuid,
  asset_external_id     text          not null,
  signal_type           text          not null,
  direction             text          not null default 'inbound',
  sync_status           text          not null default 'attempted',
  failure_class         text,
  failure_code          text,
  failure_message       text,
  retry_count           integer       not null default 0,
  max_retries           integer       not null default 3,
  lag_seconds           integer       not null default 0,
  source_system         text          not null default 'visionlink',
  source_event_id       text          not null,
  correlation_id        text,
  operator_notes        text,
  replayed_from_id      uuid          references public.visionlink_sync_events(id),
  occurred_at           timestamptz   not null default now(),
  resolved_at           timestamptz,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint visionlink_sync_events_direction_chk
    check (direction in ('inbound', 'outbound')),

  constraint visionlink_sync_events_signal_type_chk
    check (signal_type in (
      'route_position',
      'gps_status',
      'eld_duty_status',
      'compliance_state'
    )),

  constraint visionlink_sync_events_status_chk
    check (sync_status in (
      'attempted',
      'synced',
      'retrying',
      'dead_lettered',
      'quarantined',
      'disabled',
      'replayed'
    )),

  constraint visionlink_sync_events_failure_class_chk
    check (failure_class is null or failure_class in (
      'auth',
      'mapping',
      'provider_policy',
      'rate_limit',
      'timeout',
      'schema_validation',
      'unknown'
    )),

  constraint visionlink_sync_events_lag_seconds_chk
    check (lag_seconds >= 0),

  constraint visionlink_sync_events_retry_count_chk
    check (retry_count >= 0 and max_retries >= 0 and retry_count <= max_retries),

  constraint visionlink_sync_events_delivered_dedupe_uniq
    unique nulls not distinct (tenant_id, source_system, source_event_id, asset_external_id, signal_type)
);

create index if not exists idx_visionlink_sync_events_tenant_status
  on public.visionlink_sync_events (tenant_id, sync_status, occurred_at desc);

create index if not exists idx_visionlink_sync_events_asset_signal
  on public.visionlink_sync_events (tenant_id, asset_external_id, signal_type, occurred_at desc);

create trigger trg_visionlink_sync_events_updated_at
  before update on public.visionlink_sync_events
  for each row execute function update_updated_at();

revoke all on table public.visionlink_sync_events from anon, authenticated;
grant select on table public.visionlink_sync_events to authenticated;
grant all on table public.visionlink_sync_events to service_role;

alter table public.visionlink_sync_events enable row level security;

drop policy if exists "visionlink_sync_events_ops_read" on public.visionlink_sync_events;
drop policy if exists "visionlink_sync_events_service_role" on public.visionlink_sync_events;

create policy "visionlink_sync_events_ops_read"
  on public.visionlink_sync_events
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "visionlink_sync_events_service_role"
  on public.visionlink_sync_events
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

create table if not exists public.visionlink_dead_letter_queue (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  sync_event_id         uuid          not null references public.visionlink_sync_events(id),
  provider_name         text          not null default 'visionlink',
  asset_external_id     text          not null,
  signal_type           text          not null,
  failure_class         text          not null default 'unknown',
  failure_code          text,
  failure_message       text          not null,
  retry_count           integer       not null default 0,
  quarantine_reason     text          not null,
  quarantined_by        text,
  replay_eligible       boolean       not null default false,
  replayed_at           timestamptz,
  replayed_by           text,
  replay_sync_event_id  uuid          references public.visionlink_sync_events(id),
  resolved_at           timestamptz,
  resolved_by           text,
  resolution_note       text,
  payload_snapshot      jsonb         not null default '{}'::jsonb,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint visionlink_dlq_failure_class_chk
    check (failure_class in (
      'auth',
      'mapping',
      'provider_policy',
      'rate_limit',
      'timeout',
      'schema_validation',
      'unknown'
    )),

  constraint visionlink_dlq_signal_type_chk
    check (signal_type in (
      'route_position',
      'gps_status',
      'eld_duty_status',
      'compliance_state'
    )),

  constraint visionlink_dlq_sync_event_uniq
    unique (sync_event_id)
);

create index if not exists idx_visionlink_dlq_tenant_asset_signal
  on public.visionlink_dead_letter_queue (tenant_id, asset_external_id, signal_type, created_at desc);

create index if not exists idx_visionlink_dlq_tenant_replay_eligible
  on public.visionlink_dead_letter_queue (tenant_id, replay_eligible, created_at desc)
  where replay_eligible = true and replayed_at is null and resolved_at is null;

create trigger trg_visionlink_dlq_updated_at
  before update on public.visionlink_dead_letter_queue
  for each row execute function update_updated_at();

revoke all on table public.visionlink_dead_letter_queue from anon, authenticated;
grant select on table public.visionlink_dead_letter_queue to authenticated;
grant all on table public.visionlink_dead_letter_queue to service_role;

alter table public.visionlink_dead_letter_queue enable row level security;

drop policy if exists "visionlink_dlq_ops_read" on public.visionlink_dead_letter_queue;
drop policy if exists "visionlink_dlq_service_role" on public.visionlink_dead_letter_queue;

create policy "visionlink_dlq_ops_read"
  on public.visionlink_dead_letter_queue
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "visionlink_dlq_service_role"
  on public.visionlink_dead_letter_queue
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

create table if not exists public.visionlink_sync_controls (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  provider_name         text          not null default 'visionlink',
  asset_external_id     text          not null,
  signal_type           text          not null,
  source_system         text          not null default 'visionlink',
  control_status        text          not null default 'enabled',
  disabled_reason       text,
  disabled_at           timestamptz,
  disabled_by           text,
  enabled_at            timestamptz,
  enabled_by            text,
  operator_notes        text,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint visionlink_sync_controls_signal_type_chk
    check (signal_type in (
      'route_position',
      'gps_status',
      'eld_duty_status',
      'compliance_state'
    )),

  constraint visionlink_sync_controls_status_chk
    check (control_status in ('enabled', 'disabled')),

  constraint visionlink_sync_controls_scope_uniq
    unique (tenant_id, provider_name, asset_external_id, signal_type, source_system)
);

create trigger trg_visionlink_sync_controls_updated_at
  before update on public.visionlink_sync_controls
  for each row execute function update_updated_at();

revoke all on table public.visionlink_sync_controls from anon, authenticated;
grant select on table public.visionlink_sync_controls to authenticated;
grant all on table public.visionlink_sync_controls to service_role;

alter table public.visionlink_sync_controls enable row level security;

drop policy if exists "visionlink_sync_controls_ops_read" on public.visionlink_sync_controls;
drop policy if exists "visionlink_sync_controls_service_role" on public.visionlink_sync_controls;

create policy "visionlink_sync_controls_ops_read"
  on public.visionlink_sync_controls
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "visionlink_sync_controls_service_role"
  on public.visionlink_sync_controls
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

create table if not exists public.visionlink_reconciliation_results (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  provider_name         text          not null default 'visionlink',
  asset_external_id     text          not null,
  signal_type           text          not null,
  drift_status          text          not null,
  lag_seconds           integer       not null default 0,
  dia_value           jsonb         not null default '{}'::jsonb,
  provider_value        jsonb         not null default '{}'::jsonb,
  diagnostic_summary    text,
  compared_at           timestamptz   not null default now(),
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint visionlink_recon_signal_type_chk
    check (signal_type in (
      'route_position',
      'gps_status',
      'eld_duty_status',
      'compliance_state'
    )),

  constraint visionlink_recon_drift_status_chk
    check (drift_status in (
      'in_sync',
      'lagging',
      'mismatch',
      'missing_in_provider',
      'missing_in_dia'
    )),

  constraint visionlink_recon_lag_seconds_chk
    check (lag_seconds >= 0)
);

create index if not exists idx_visionlink_recon_tenant_asset_signal
  on public.visionlink_reconciliation_results (tenant_id, asset_external_id, signal_type, compared_at desc);

create trigger trg_visionlink_reconciliation_results_updated_at
  before update on public.visionlink_reconciliation_results
  for each row execute function update_updated_at();

revoke all on table public.visionlink_reconciliation_results from anon, authenticated;
grant select on table public.visionlink_reconciliation_results to authenticated;
grant all on table public.visionlink_reconciliation_results to service_role;

alter table public.visionlink_reconciliation_results enable row level security;

drop policy if exists "visionlink_reconciliation_ops_read" on public.visionlink_reconciliation_results;
drop policy if exists "visionlink_reconciliation_service_role" on public.visionlink_reconciliation_results;

create policy "visionlink_reconciliation_ops_read"
  on public.visionlink_reconciliation_results
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "visionlink_reconciliation_service_role"
  on public.visionlink_reconciliation_results
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

create or replace function public.visionlink_quarantine_sync_event(
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
  v_role      text;
  v_event     public.visionlink_sync_events%rowtype;
  v_dlq_id    uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'visionlink_quarantine_sync_event: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.visionlink_sync_events
  where id = p_sync_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'visionlink_quarantine_sync_event: sync event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if v_event.sync_status = 'quarantined' then
    raise exception 'visionlink_quarantine_sync_event: event already quarantined'
      using errcode = 'check_violation';
  end if;

  update public.visionlink_sync_events
  set sync_status = 'quarantined',
      operator_notes = coalesce(p_operator_notes, operator_notes),
      updated_at = now()
  where id = p_sync_event_id;

  insert into public.visionlink_dead_letter_queue (
    tenant_id,
    sync_event_id,
    provider_name,
    asset_external_id,
    signal_type,
    failure_class,
    failure_code,
    failure_message,
    retry_count,
    quarantine_reason,
    quarantined_by,
    replay_eligible,
    payload_snapshot,
    metadata
  ) values (
    v_event.tenant_id,
    v_event.id,
    v_event.provider_name,
    v_event.asset_external_id,
    v_event.signal_type,
    coalesce(v_event.failure_class, 'unknown'),
    v_event.failure_code,
    coalesce(v_event.failure_message, 'quarantined by operator'),
    v_event.retry_count,
    p_quarantine_reason,
    v_role,
    p_replay_eligible,
    v_event.metadata,
    jsonb_build_object(
      'quarantined_at', now(),
      'original_status', v_event.sync_status,
      'operator_notes', p_operator_notes
    )
  )
  on conflict (sync_event_id) do update
    set quarantine_reason = excluded.quarantine_reason,
        replay_eligible = excluded.replay_eligible,
        updated_at = now()
  returning id into v_dlq_id;

  return v_dlq_id;
end;
$$;

revoke all on function public.visionlink_quarantine_sync_event(uuid, text, boolean, text) from public, anon;
grant execute on function public.visionlink_quarantine_sync_event(uuid, text, boolean, text)
  to authenticated, service_role;

create or replace function public.visionlink_mark_replayed(
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
  v_role             text;
  v_dlq              public.visionlink_dead_letter_queue%rowtype;
  v_original_event   public.visionlink_sync_events%rowtype;
  v_replay_event_id  uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'visionlink_mark_replayed: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_dlq
  from public.visionlink_dead_letter_queue
  where id = p_dlq_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'visionlink_mark_replayed: DLQ row not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if not v_dlq.replay_eligible then
    raise exception 'visionlink_mark_replayed: DLQ row is not replay eligible'
      using errcode = 'check_violation';
  end if;

  if v_dlq.replayed_at is not null then
    raise exception 'visionlink_mark_replayed: DLQ row already replayed'
      using errcode = 'check_violation';
  end if;

  select * into v_original_event
  from public.visionlink_sync_events
  where id = v_dlq.sync_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'visionlink_mark_replayed: original sync event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  insert into public.visionlink_sync_events (
    tenant_id,
    provider_name,
    sync_run_id,
    asset_id,
    asset_external_id,
    signal_type,
    direction,
    sync_status,
    retry_count,
    max_retries,
    lag_seconds,
    source_system,
    source_event_id,
    correlation_id,
    operator_notes,
    replayed_from_id,
    occurred_at,
    metadata
  ) values (
    v_original_event.tenant_id,
    v_original_event.provider_name,
    v_original_event.sync_run_id,
    v_original_event.asset_id,
    v_original_event.asset_external_id,
    v_original_event.signal_type,
    v_original_event.direction,
    'replayed',
    0,
    v_original_event.max_retries,
    v_original_event.lag_seconds,
    v_original_event.source_system,
    concat(v_original_event.source_event_id, ':replay:', extract(epoch from now())::bigint),
    v_original_event.correlation_id,
    coalesce(p_operator_notes, v_original_event.operator_notes),
    v_original_event.id,
    now(),
    coalesce(v_original_event.metadata, '{}'::jsonb) || jsonb_build_object('replay_actor', p_replay_actor)
  ) returning id into v_replay_event_id;

  update public.visionlink_dead_letter_queue
  set replayed_at = now(),
      replayed_by = p_replay_actor,
      replay_sync_event_id = v_replay_event_id,
      resolved_at = now(),
      resolved_by = p_replay_actor,
      resolution_note = coalesce(p_operator_notes, resolution_note),
      updated_at = now()
  where id = p_dlq_id;

  update public.visionlink_sync_events
  set resolved_at = now(),
      updated_at = now()
  where id = v_original_event.id;

  return v_replay_event_id;
end;
$$;

revoke all on function public.visionlink_mark_replayed(uuid, text, text) from public, anon;
grant execute on function public.visionlink_mark_replayed(uuid, text, text)
  to authenticated, service_role;

create or replace function public.visionlink_disable_sync_scope(
  p_sync_event_id      uuid,
  p_disable_reason     text,
  p_operator_notes     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_event       public.visionlink_sync_events%rowtype;
  v_control_id  uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'visionlink_disable_sync_scope: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.visionlink_sync_events
  where id = p_sync_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'visionlink_disable_sync_scope: sync event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  insert into public.visionlink_sync_controls (
    tenant_id,
    provider_name,
    asset_external_id,
    signal_type,
    source_system,
    control_status,
    disabled_reason,
    disabled_at,
    disabled_by,
    operator_notes,
    metadata
  ) values (
    v_event.tenant_id,
    v_event.provider_name,
    v_event.asset_external_id,
    v_event.signal_type,
    v_event.source_system,
    'disabled',
    p_disable_reason,
    now(),
    v_role,
    p_operator_notes,
    jsonb_build_object('disabled_from_event_id', v_event.id)
  )
  on conflict (tenant_id, provider_name, asset_external_id, signal_type, source_system)
  do update
    set control_status = 'disabled',
        disabled_reason = excluded.disabled_reason,
        disabled_at = excluded.disabled_at,
        disabled_by = excluded.disabled_by,
        operator_notes = excluded.operator_notes,
        updated_at = now()
  returning id into v_control_id;

  update public.visionlink_sync_events
  set sync_status = 'disabled',
      operator_notes = coalesce(p_operator_notes, operator_notes),
      updated_at = now()
  where id = v_event.id;

  return v_control_id;
end;
$$;

revoke all on function public.visionlink_disable_sync_scope(uuid, text, text) from public, anon;
grant execute on function public.visionlink_disable_sync_scope(uuid, text, text)
  to authenticated, service_role;

create or replace view public.v_visionlink_sync_dashboard
  with (security_invoker = true) as
select
  e.tenant_id,
  e.provider_name,
  e.signal_type,
  e.direction,
  count(*)                                                              as total_attempts,
  count(*) filter (where e.sync_status = 'synced')                      as synced_count,
  count(*) filter (where e.sync_status = 'retrying')                    as retrying_count,
  count(*) filter (where e.sync_status = 'dead_lettered')               as dead_lettered_count,
  count(*) filter (where e.sync_status = 'quarantined')                 as quarantined_count,
  count(*) filter (where e.sync_status = 'disabled')                    as disabled_count,
  count(*) filter (where e.sync_status = 'replayed')                    as replayed_count,
  max(e.retry_count)                                                    as max_retry_count,
  max(e.lag_seconds)                                                    as max_lag_seconds,
  avg(e.lag_seconds)::numeric(12,2)                                     as avg_lag_seconds,
  max(e.occurred_at)                                                    as last_event_at
from public.visionlink_sync_events e
group by e.tenant_id, e.provider_name, e.signal_type, e.direction;

revoke all on table public.v_visionlink_sync_dashboard from anon;
grant select on table public.v_visionlink_sync_dashboard to authenticated, service_role;

create or replace view public.v_visionlink_failed_work
  with (security_invoker = true) as
select
  e.id,
  e.tenant_id,
  e.provider_name,
  e.asset_external_id,
  e.asset_id,
  e.signal_type,
  e.direction,
  e.sync_status,
  e.failure_class,
  e.failure_code,
  e.failure_message,
  e.retry_count,
  e.max_retries,
  e.lag_seconds,
  e.source_system,
  e.source_event_id,
  e.correlation_id,
  e.operator_notes,
  e.occurred_at,
  e.updated_at,
  dlq.id                 as dlq_id,
  dlq.replay_eligible,
  dlq.replayed_at,
  dlq.quarantine_reason,
  dlq.replay_sync_event_id,
  ctrl.id                as control_id,
  ctrl.control_status,
  ctrl.disabled_reason,
  ctrl.disabled_at
from public.visionlink_sync_events e
left join public.visionlink_dead_letter_queue dlq
  on dlq.sync_event_id = e.id
left join public.visionlink_sync_controls ctrl
  on ctrl.tenant_id = e.tenant_id
 and ctrl.provider_name = e.provider_name
 and ctrl.asset_external_id = e.asset_external_id
 and ctrl.signal_type = e.signal_type
 and ctrl.source_system = e.source_system
 and ctrl.control_status = 'disabled'
where e.sync_status in ('retrying', 'dead_lettered', 'quarantined', 'disabled')
  and e.resolved_at is null;

revoke all on table public.v_visionlink_failed_work from anon;
grant select on table public.v_visionlink_failed_work to authenticated, service_role;

create or replace view public.v_visionlink_reconciliation_drift
  with (security_invoker = true) as
select
  r.id,
  r.tenant_id,
  r.provider_name,
  r.asset_external_id,
  r.signal_type,
  r.drift_status,
  r.lag_seconds,
  r.dia_value,
  r.provider_value,
  r.diagnostic_summary,
  r.compared_at,
  r.updated_at
from public.visionlink_reconciliation_results r
where r.drift_status <> 'in_sync';

revoke all on table public.v_visionlink_reconciliation_drift from anon;
grant select on table public.v_visionlink_reconciliation_drift to authenticated, service_role;

create or replace view public.v_visionlink_reconciliation_summary
  with (security_invoker = true) as
select
  r.tenant_id,
  r.provider_name,
  r.signal_type,
  r.drift_status,
  count(*)::bigint           as drift_count,
  max(r.compared_at)         as last_compared_at,
  max(r.lag_seconds)         as max_lag_seconds
from public.visionlink_reconciliation_results r
group by r.tenant_id, r.provider_name, r.signal_type, r.drift_status;

revoke all on table public.v_visionlink_reconciliation_summary from anon;
grant select on table public.v_visionlink_reconciliation_summary to authenticated, service_role;
