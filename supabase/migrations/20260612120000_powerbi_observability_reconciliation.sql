-- ---------------------------------------------------------------------------
-- Power BI connector observability, replay controls, and stale-refresh alerts
--
-- Adds tenant-scoped export-run telemetry, dead-letter controls, disable
-- controls, and stale-refresh alerting for Power BI dataset export operations.
--
-- Supported export scopes: dataset_push, dataset_refresh, report_embed
-- Failure classes: auth, rate_limit, transport, invalid_payload, config, unknown
--
-- Depends on: shared tenants table, ops_claim_app_role(), ops_tenant_match()
-- Related issues: #1118, #470, #502
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Export runs — append-only telemetry per export execution
-- ---------------------------------------------------------------------------

create table if not exists public.powerbi_export_runs (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  provider_name         text          not null default 'powerbi',
  export_run_id         text,
  workspace_id          text          not null,
  dataset_id            text          not null,
  export_scope          text          not null,
  direction             text          not null default 'outbound',
  export_status         text          not null default 'attempted',
  failure_class         text,
  failure_code          text,
  failure_message       text,
  retry_count           integer       not null default 0,
  max_retries           integer       not null default 3,
  idempotency_key       text,
  source_event_id       text          not null,
  correlation_id        text,
  payload_digest        text,
  operator_notes        text,
  replayed_from_id      uuid          references public.powerbi_export_runs(id),
  occurred_at           timestamptz   not null default now(),
  resolved_at           timestamptz,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint powerbi_export_runs_provider_name_chk
    check (provider_name = 'powerbi'),

  constraint powerbi_export_runs_export_scope_chk
    check (export_scope in ('dataset_push', 'dataset_refresh', 'report_embed')),

  constraint powerbi_export_runs_direction_chk
    check (direction in ('outbound')),

  constraint powerbi_export_runs_export_status_chk
    check (export_status in (
      'attempted',
      'succeeded',
      'retrying',
      'dead_lettered',
      'quarantined',
      'replayed',
      'disabled'
    )),

  constraint powerbi_export_runs_failure_class_chk
    check (failure_class is null or failure_class in (
      'auth',
      'rate_limit',
      'transport',
      'invalid_payload',
      'config',
      'unknown'
    )),

  constraint powerbi_export_runs_retry_count_chk
    check (retry_count >= 0 and max_retries >= 0 and retry_count <= max_retries),

  constraint powerbi_export_runs_dedupe_uniq
    unique nulls not distinct (
      tenant_id,
      provider_name,
      workspace_id,
      dataset_id,
      export_scope,
      source_event_id,
      idempotency_key
    )
);

create index if not exists idx_powerbi_export_runs_tenant_scope_status
  on public.powerbi_export_runs (tenant_id, export_scope, export_status, occurred_at desc);

create index if not exists idx_powerbi_export_runs_tenant_dataset
  on public.powerbi_export_runs (tenant_id, workspace_id, dataset_id, occurred_at desc);

create index if not exists idx_powerbi_export_runs_failure_class
  on public.powerbi_export_runs (tenant_id, failure_class, occurred_at desc)
  where failure_class is not null;

create trigger trg_powerbi_export_runs_updated_at
  before update on public.powerbi_export_runs
  for each row execute function update_updated_at();

revoke all on table public.powerbi_export_runs from anon, authenticated;
grant select on table public.powerbi_export_runs to authenticated;
grant all on table public.powerbi_export_runs to service_role;

alter table public.powerbi_export_runs enable row level security;

drop policy if exists "powerbi_export_runs_ops_read" on public.powerbi_export_runs;
drop policy if exists "powerbi_export_runs_service_role" on public.powerbi_export_runs;

create policy "powerbi_export_runs_ops_read"
  on public.powerbi_export_runs
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "powerbi_export_runs_service_role"
  on public.powerbi_export_runs
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- 2. Dead-letter queue — quarantine sink for unrecoverable / operator-held exports
-- ---------------------------------------------------------------------------

create table if not exists public.powerbi_dead_letter_queue (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  export_run_id         uuid          not null references public.powerbi_export_runs(id),
  provider_name         text          not null default 'powerbi',
  workspace_id          text          not null,
  dataset_id            text          not null,
  export_scope          text          not null,
  failure_class         text          not null default 'unknown',
  failure_code          text,
  failure_message       text          not null,
  retry_count           integer       not null default 0,
  quarantine_reason     text          not null,
  quarantined_by        text,
  replay_eligible       boolean       not null default false,
  replayed_at           timestamptz,
  replayed_by           text,
  replay_export_run_id  uuid          references public.powerbi_export_runs(id),
  resolved_at           timestamptz,
  resolved_by           text,
  resolution_note       text,
  payload_snapshot      jsonb         not null default '{}'::jsonb,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint powerbi_dlq_failure_class_chk
    check (failure_class in (
      'auth',
      'rate_limit',
      'transport',
      'invalid_payload',
      'config',
      'unknown'
    )),

  constraint powerbi_dlq_export_scope_chk
    check (export_scope in ('dataset_push', 'dataset_refresh', 'report_embed')),

  constraint powerbi_dlq_export_run_uniq
    unique (export_run_id)
);

create index if not exists idx_powerbi_dlq_tenant_scope
  on public.powerbi_dead_letter_queue (tenant_id, export_scope, created_at desc);

create index if not exists idx_powerbi_dlq_tenant_replay_eligible
  on public.powerbi_dead_letter_queue (tenant_id, replay_eligible, created_at desc)
  where replay_eligible = true and replayed_at is null and resolved_at is null;

create trigger trg_powerbi_dlq_updated_at
  before update on public.powerbi_dead_letter_queue
  for each row execute function update_updated_at();

revoke all on table public.powerbi_dead_letter_queue from anon, authenticated;
grant select on table public.powerbi_dead_letter_queue to authenticated;
grant all on table public.powerbi_dead_letter_queue to service_role;

alter table public.powerbi_dead_letter_queue enable row level security;

drop policy if exists "powerbi_dlq_ops_read" on public.powerbi_dead_letter_queue;
drop policy if exists "powerbi_dlq_service_role" on public.powerbi_dead_letter_queue;

create policy "powerbi_dlq_ops_read"
  on public.powerbi_dead_letter_queue
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "powerbi_dlq_service_role"
  on public.powerbi_dead_letter_queue
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- 3. Sync controls — per-dataset/scope disable / re-enable gate
-- ---------------------------------------------------------------------------

create table if not exists public.powerbi_sync_controls (
  id              uuid          primary key default gen_random_uuid(),
  tenant_id       uuid          not null references public.tenants(id) on delete restrict,
  provider_name   text          not null default 'powerbi',
  workspace_id    text          not null,
  dataset_id      text          not null,
  export_scope    text          not null,
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

  constraint powerbi_sync_controls_provider_name_chk
    check (provider_name = 'powerbi'),

  constraint powerbi_sync_controls_export_scope_chk
    check (export_scope in ('dataset_push', 'dataset_refresh', 'report_embed')),

  constraint powerbi_sync_controls_status_chk
    check (control_status in ('active', 'disabled')),

  constraint powerbi_sync_controls_scope_uniq
    unique (tenant_id, provider_name, workspace_id, dataset_id, export_scope)
);

create trigger trg_powerbi_sync_controls_updated_at
  before update on public.powerbi_sync_controls
  for each row execute function update_updated_at();

revoke all on table public.powerbi_sync_controls from anon, authenticated;
grant select on table public.powerbi_sync_controls to authenticated;
grant all on table public.powerbi_sync_controls to service_role;

alter table public.powerbi_sync_controls enable row level security;

drop policy if exists "powerbi_sync_controls_ops_read" on public.powerbi_sync_controls;
drop policy if exists "powerbi_sync_controls_service_role" on public.powerbi_sync_controls;

create policy "powerbi_sync_controls_ops_read"
  on public.powerbi_sync_controls
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "powerbi_sync_controls_service_role"
  on public.powerbi_sync_controls
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- 4. Stale refresh alerts — staleness state per tenant/workspace/dataset
-- ---------------------------------------------------------------------------

create table if not exists public.powerbi_stale_refresh_alerts (
  id                          uuid          primary key default gen_random_uuid(),
  tenant_id                   uuid          not null references public.tenants(id) on delete restrict,
  provider_name               text          not null default 'powerbi',
  workspace_id                text          not null,
  dataset_id                  text          not null,
  alert_status                text          not null default 'open',
  last_refreshed_at           timestamptz,
  last_refresh_status         text          not null default 'Unknown',
  stale_threshold_minutes     integer       not null default 120,
  age_minutes                 numeric,
  failure_class               text,
  diagnostic_summary          text,
  last_export_run_id          uuid          references public.powerbi_export_runs(id),
  acknowledged_at             timestamptz,
  acknowledged_by             text,
  resolved_at                 timestamptz,
  resolved_by                 text,
  resolution_note             text,
  operator_notes              text,
  checked_at                  timestamptz   not null default now(),
  created_at                  timestamptz   not null default now(),
  updated_at                  timestamptz   not null default now(),

  constraint powerbi_stale_alerts_provider_name_chk
    check (provider_name = 'powerbi'),

  constraint powerbi_stale_alerts_status_chk
    check (alert_status in ('open', 'acknowledged', 'resolved')),

  constraint powerbi_stale_alerts_failure_class_chk
    check (failure_class is null or failure_class in (
      'auth',
      'rate_limit',
      'transport',
      'invalid_payload',
      'config',
      'unknown'
    )),

  constraint powerbi_stale_alerts_scope_uniq
    unique (tenant_id, provider_name, workspace_id, dataset_id)
);

create index if not exists idx_powerbi_stale_alerts_tenant_status
  on public.powerbi_stale_refresh_alerts (tenant_id, alert_status, checked_at desc);

create index if not exists idx_powerbi_stale_alerts_open
  on public.powerbi_stale_refresh_alerts (tenant_id, workspace_id, dataset_id, checked_at desc)
  where alert_status = 'open';

create trigger trg_powerbi_stale_alerts_updated_at
  before update on public.powerbi_stale_refresh_alerts
  for each row execute function update_updated_at();

revoke all on table public.powerbi_stale_refresh_alerts from anon, authenticated;
grant select on table public.powerbi_stale_refresh_alerts to authenticated;
grant all on table public.powerbi_stale_refresh_alerts to service_role;

alter table public.powerbi_stale_refresh_alerts enable row level security;

drop policy if exists "powerbi_stale_alerts_ops_read" on public.powerbi_stale_refresh_alerts;
drop policy if exists "powerbi_stale_alerts_service_role" on public.powerbi_stale_refresh_alerts;

create policy "powerbi_stale_alerts_ops_read"
  on public.powerbi_stale_refresh_alerts
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "powerbi_stale_alerts_service_role"
  on public.powerbi_stale_refresh_alerts
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

create or replace function public.powerbi_quarantine_export_run(
  p_export_run_id     uuid,
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
  v_run     public.powerbi_export_runs%rowtype;
  v_dlq_id  uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'powerbi_quarantine_export_run: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_run
  from public.powerbi_export_runs
  where id = p_export_run_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'powerbi_quarantine_export_run: export run not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if v_run.export_status = 'quarantined' then
    raise exception 'powerbi_quarantine_export_run: export run is already quarantined'
      using errcode = 'check_violation';
  end if;

  update public.powerbi_export_runs
  set
    export_status  = 'quarantined',
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now()
  where id = p_export_run_id;

  insert into public.powerbi_dead_letter_queue (
    tenant_id,
    export_run_id,
    provider_name,
    workspace_id,
    dataset_id,
    export_scope,
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
    v_run.tenant_id,
    v_run.id,
    v_run.provider_name,
    v_run.workspace_id,
    v_run.dataset_id,
    v_run.export_scope,
    coalesce(v_run.failure_class, 'unknown'),
    v_run.failure_code,
    coalesce(v_run.failure_message, 'quarantined by operator'),
    v_run.retry_count,
    p_quarantine_reason,
    v_role,
    p_replay_eligible,
    v_run.metadata,
    jsonb_build_object(
      'quarantined_at',  now(),
      'original_status', v_run.export_status,
      'operator_notes',  p_operator_notes
    )
  )
  on conflict (export_run_id) do update
    set
      quarantine_reason = excluded.quarantine_reason,
      replay_eligible   = excluded.replay_eligible,
      updated_at        = now()
  returning id into v_dlq_id;

  return v_dlq_id;
end;
$$;

revoke all on function public.powerbi_quarantine_export_run(uuid, text, boolean, text) from anon;
grant execute on function public.powerbi_quarantine_export_run(uuid, text, boolean, text)
  to authenticated, service_role;

create or replace function public.powerbi_mark_replayed(
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
  v_role        text;
  v_dlq         public.powerbi_dead_letter_queue%rowtype;
  v_source_run  public.powerbi_export_runs%rowtype;
  v_replay_id   uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'powerbi_mark_replayed: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_dlq
  from public.powerbi_dead_letter_queue
  where id = p_dlq_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'powerbi_mark_replayed: DLQ entry not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if not v_dlq.replay_eligible then
    raise exception 'powerbi_mark_replayed: DLQ entry is not marked replay-eligible'
      using errcode = 'check_violation';
  end if;

  if v_dlq.replayed_at is not null then
    raise exception 'powerbi_mark_replayed: DLQ entry has already been replayed at %',
      v_dlq.replayed_at
      using errcode = 'check_violation';
  end if;

  select * into v_source_run
  from public.powerbi_export_runs
  where id = v_dlq.export_run_id;

  insert into public.powerbi_export_runs (
    tenant_id,
    provider_name,
    export_run_id,
    workspace_id,
    dataset_id,
    export_scope,
    direction,
    export_status,
    source_event_id,
    correlation_id,
    payload_digest,
    idempotency_key,
    operator_notes,
    replayed_from_id,
    metadata
  )
  values (
    v_source_run.tenant_id,
    v_source_run.provider_name,
    v_source_run.export_run_id,
    v_source_run.workspace_id,
    v_source_run.dataset_id,
    v_source_run.export_scope,
    v_source_run.direction,
    'replayed',
    v_source_run.source_event_id,
    v_source_run.correlation_id,
    v_source_run.payload_digest,
    null,
    coalesce(p_operator_notes, 'replayed from DLQ by operator'),
    v_source_run.id,
    jsonb_build_object(
      'replayed_at',        now(),
      'replayed_by',        coalesce(p_replay_actor, v_role),
      'dlq_id',             p_dlq_id,
      'original_run_id',    v_source_run.id
    )
  )
  returning id into v_replay_id;

  update public.powerbi_dead_letter_queue
  set
    replayed_at          = now(),
    replayed_by          = coalesce(p_replay_actor, v_role),
    replay_export_run_id = v_replay_id,
    resolved_at          = now(),
    resolved_by          = coalesce(p_replay_actor, v_role),
    resolution_note      = coalesce(p_operator_notes, resolution_note),
    updated_at           = now()
  where id = p_dlq_id;

  update public.powerbi_export_runs
  set
    resolved_at = now(),
    updated_at  = now()
  where id = v_source_run.id;

  return v_replay_id;
end;
$$;

revoke all on function public.powerbi_mark_replayed(uuid, text, text) from anon;
grant execute on function public.powerbi_mark_replayed(uuid, text, text)
  to authenticated, service_role;

create or replace function public.powerbi_disable_export_scope(
  p_export_run_id  uuid,
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
  v_run         public.powerbi_export_runs%rowtype;
  v_control_id  uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'powerbi_disable_export_scope: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_run
  from public.powerbi_export_runs
  where id = p_export_run_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'powerbi_disable_export_scope: export run not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  insert into public.powerbi_sync_controls (
    tenant_id,
    provider_name,
    workspace_id,
    dataset_id,
    export_scope,
    control_status,
    disabled_reason,
    disabled_by,
    disabled_at,
    operator_notes,
    metadata
  )
  values (
    v_run.tenant_id,
    v_run.provider_name,
    v_run.workspace_id,
    v_run.dataset_id,
    v_run.export_scope,
    'disabled',
    p_disable_reason,
    v_role,
    now(),
    p_operator_notes,
    jsonb_build_object(
      'export_run_id', v_run.id,
      'disabled_at',   now()
    )
  )
  on conflict (tenant_id, provider_name, workspace_id, dataset_id, export_scope) do update
    set
      control_status  = 'disabled',
      disabled_reason = excluded.disabled_reason,
      disabled_by     = excluded.disabled_by,
      disabled_at     = now(),
      reenabled_at    = null,
      reenabled_by    = null,
      operator_notes  = coalesce(excluded.operator_notes, public.powerbi_sync_controls.operator_notes),
      updated_at      = now()
  returning id into v_control_id;

  update public.powerbi_export_runs
  set
    export_status  = 'disabled',
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now(),
    metadata       = metadata || jsonb_build_object('disabled_control_id', v_control_id)
  where id = p_export_run_id;

  return v_control_id;
end;
$$;

revoke all on function public.powerbi_disable_export_scope(uuid, text, text) from anon;
grant execute on function public.powerbi_disable_export_scope(uuid, text, text)
  to authenticated, service_role;

create or replace function public.powerbi_enable_export_scope(
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
  v_control public.powerbi_sync_controls%rowtype;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'powerbi_enable_export_scope: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_control
  from public.powerbi_sync_controls
  where id = p_control_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'powerbi_enable_export_scope: sync control not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  update public.powerbi_sync_controls
  set
    control_status = 'active',
    reenabled_at   = now(),
    reenabled_by   = coalesce(p_reenable_actor, v_role),
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now()
  where id = p_control_id;

  update public.powerbi_export_runs
  set
    resolved_at = now(),
    updated_at  = now()
  where tenant_id    = v_control.tenant_id
    and provider_name = v_control.provider_name
    and workspace_id  = v_control.workspace_id
    and dataset_id    = v_control.dataset_id
    and export_scope  = v_control.export_scope
    and export_status = 'disabled'
    and resolved_at   is null;

  return p_control_id;
end;
$$;

revoke all on function public.powerbi_enable_export_scope(uuid, text, text) from anon;
grant execute on function public.powerbi_enable_export_scope(uuid, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Operator views — dashboard, failed exports, stale datasets
-- ---------------------------------------------------------------------------

create or replace view public.v_powerbi_export_dashboard
  with (security_invoker = true) as
select
  e.tenant_id,
  e.provider_name,
  e.workspace_id,
  e.dataset_id,
  e.export_scope,
  count(*)                                                                  as total_attempts,
  count(*) filter (where e.export_status = 'succeeded')                     as succeeded_count,
  count(*) filter (where e.export_status = 'retrying')                      as retrying_count,
  count(*) filter (where e.export_status = 'dead_lettered')                 as dead_lettered_count,
  count(*) filter (where e.export_status = 'quarantined')                   as quarantined_count,
  count(*) filter (where e.export_status = 'replayed')                      as replayed_count,
  count(*) filter (where e.export_status = 'disabled')                      as disabled_count,
  count(*) filter (where e.failure_class = 'auth')                          as auth_failure_count,
  count(*) filter (where e.failure_class = 'rate_limit')                    as rate_limit_failure_count,
  count(*) filter (where e.failure_class = 'transport')                     as transport_failure_count,
  count(*) filter (where e.failure_class = 'invalid_payload')               as invalid_payload_failure_count,
  count(*) filter (where e.failure_class = 'config')                        as config_failure_count,
  max(e.occurred_at)                                                        as last_attempt_at,
  max(e.occurred_at) filter (where e.export_status = 'succeeded')           as last_succeeded_at,
  max(e.occurred_at) filter (
    where e.export_status in ('dead_lettered', 'quarantined', 'disabled')
  )                                                                         as last_failure_at
from public.powerbi_export_runs e
group by e.tenant_id, e.provider_name, e.workspace_id, e.dataset_id, e.export_scope;

revoke all on table public.v_powerbi_export_dashboard from anon;
grant select on table public.v_powerbi_export_dashboard to authenticated, service_role;

create or replace view public.v_powerbi_failed_exports
  with (security_invoker = true) as
select
  e.id,
  e.tenant_id,
  e.provider_name,
  e.workspace_id,
  e.dataset_id,
  e.export_scope,
  e.export_status,
  e.failure_class,
  e.failure_code,
  e.failure_message,
  e.retry_count,
  e.max_retries,
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
from public.powerbi_export_runs e
left join public.powerbi_dead_letter_queue dlq
  on dlq.export_run_id = e.id
left join public.powerbi_sync_controls ctrl
  on ctrl.tenant_id    = e.tenant_id
 and ctrl.provider_name = e.provider_name
 and ctrl.workspace_id  = e.workspace_id
 and ctrl.dataset_id    = e.dataset_id
 and ctrl.export_scope  = e.export_scope
 and ctrl.control_status = 'disabled'
where e.export_status in ('retrying', 'dead_lettered', 'quarantined', 'disabled')
  and e.resolved_at is null;

revoke all on table public.v_powerbi_failed_exports from anon;
grant select on table public.v_powerbi_failed_exports to authenticated, service_role;

create or replace view public.v_powerbi_stale_datasets
  with (security_invoker = true) as
select
  a.id,
  a.tenant_id,
  a.provider_name,
  a.workspace_id,
  a.dataset_id,
  a.alert_status,
  a.last_refreshed_at,
  a.last_refresh_status,
  a.stale_threshold_minutes,
  a.age_minutes,
  a.failure_class,
  a.diagnostic_summary,
  a.last_export_run_id,
  a.acknowledged_at,
  a.acknowledged_by,
  a.operator_notes,
  a.checked_at,
  ctrl.id              as control_id,
  ctrl.control_status,
  ctrl.disabled_reason,
  ctrl.disabled_at,
  e.export_status      as last_export_status,
  e.failure_class      as last_export_failure_class,
  e.occurred_at        as last_export_occurred_at
from public.powerbi_stale_refresh_alerts a
left join public.powerbi_sync_controls ctrl
  on ctrl.tenant_id    = a.tenant_id
 and ctrl.provider_name = a.provider_name
 and ctrl.workspace_id  = a.workspace_id
 and ctrl.dataset_id    = a.dataset_id
 and ctrl.control_status = 'disabled'
left join public.powerbi_export_runs e
  on e.id = a.last_export_run_id
where a.alert_status in ('open', 'acknowledged');

revoke all on table public.v_powerbi_stale_datasets from anon;
grant select on table public.v_powerbi_stale_datasets to authenticated, service_role;
