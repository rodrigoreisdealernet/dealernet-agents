-- ---------------------------------------------------------------------------
-- Sage observability, reconciliation, and operator controls
--
-- Adds tenant-scoped sync event telemetry, dead-letter controls, disable
-- controls, and reconciliation diagnostics for Sage ERP syncs.
--
-- Supported scopes: general_ledger, invoice, accounts_payable, accounts_receivable
-- Failure classes: auth, transport, rate_limit, validation, reconciliation,
--                  duplicate, unknown
--
-- Depends on: shared tenants table, ops_claim_app_role(), ops_tenant_match()
-- Related issues: #1368, #463
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Sync events — append-only telemetry per sync execution or inbound event
-- ---------------------------------------------------------------------------

create table if not exists public.sage_sync_events (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  provider_name         text          not null default 'sage',
  sync_run_id           text,
  object_type           text          not null,
  object_key            text          not null,
  internal_record_id    text,
  sage_record_id        text,
  direction             text          not null default 'outbound',
  sync_status           text          not null default 'attempted',
  failure_class         text,
  failure_code          text,
  failure_message       text,
  retry_count           integer       not null default 0,
  max_retries           integer       not null default 3,
  idempotency_key       text,
  source_system         text          not null default 'sage',
  source_event_id       text          not null,
  correlation_id        text,
  payload_digest        text,
  operator_notes        text,
  replayed_from_id      uuid          references public.sage_sync_events(id),
  occurred_at           timestamptz   not null default now(),
  resolved_at           timestamptz,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint sage_sync_events_provider_name_chk
    check (provider_name = 'sage'),

  constraint sage_sync_events_object_type_chk
    check (object_type in ('general_ledger', 'invoice', 'accounts_payable', 'accounts_receivable')),

  constraint sage_sync_events_direction_chk
    check (direction in ('inbound', 'outbound')),

  constraint sage_sync_events_sync_status_chk
    check (sync_status in (
      'attempted',
      'synced',
      'retrying',
      'dead_lettered',
      'quarantined',
      'replayed',
      'disabled'
    )),

  constraint sage_sync_events_failure_class_chk
    check (failure_class is null or failure_class in (
      'auth',
      'transport',
      'rate_limit',
      'validation',
      'reconciliation',
      'duplicate',
      'unknown'
    )),

  constraint sage_sync_events_retry_count_chk
    check (retry_count >= 0 and max_retries >= 0 and retry_count <= max_retries),

  constraint sage_sync_events_dedupe_uniq
    unique nulls not distinct (
      tenant_id,
      provider_name,
      source_system,
      source_event_id,
      object_type,
      idempotency_key
    )
);

create index if not exists idx_sage_sync_events_tenant_object_status
  on public.sage_sync_events (tenant_id, object_type, sync_status, occurred_at desc);

create index if not exists idx_sage_sync_events_tenant_object_key
  on public.sage_sync_events (tenant_id, object_type, object_key, occurred_at desc);

create index if not exists idx_sage_sync_events_failure_class
  on public.sage_sync_events (tenant_id, failure_class, occurred_at desc)
  where failure_class is not null;

create trigger trg_sage_sync_events_updated_at
  before update on public.sage_sync_events
  for each row execute function update_updated_at();

revoke all on table public.sage_sync_events from anon, authenticated;
grant select on table public.sage_sync_events to authenticated;
grant all on table public.sage_sync_events to service_role;

alter table public.sage_sync_events enable row level security;

drop policy if exists "sage_sync_events_ops_read" on public.sage_sync_events;
drop policy if exists "sage_sync_events_service_role" on public.sage_sync_events;

create policy "sage_sync_events_ops_read"
  on public.sage_sync_events
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "sage_sync_events_service_role"
  on public.sage_sync_events
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

create table if not exists public.sage_dead_letter_queue (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete restrict,
  sync_event_id         uuid          not null references public.sage_sync_events(id),
  provider_name         text          not null default 'sage',
  object_type           text          not null,
  object_key            text          not null,
  internal_record_id    text,
  sage_record_id        text,
  failure_class         text          not null default 'unknown',
  failure_code          text,
  failure_message       text          not null,
  retry_count           integer       not null default 0,
  quarantine_reason     text          not null,
  quarantined_by        text,
  replay_eligible       boolean       not null default false,
  replayed_at           timestamptz,
  replayed_by           text,
  replay_sync_event_id  uuid          references public.sage_sync_events(id),
  resolved_at           timestamptz,
  resolved_by           text,
  resolution_note       text,
  payload_snapshot      jsonb         not null default '{}'::jsonb,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint sage_dlq_failure_class_chk
    check (failure_class in (
      'auth',
      'transport',
      'rate_limit',
      'validation',
      'reconciliation',
      'duplicate',
      'unknown'
    )),

  constraint sage_dlq_object_type_chk
    check (object_type in ('general_ledger', 'invoice', 'accounts_payable', 'accounts_receivable')),

  constraint sage_dlq_sync_event_uniq
    unique (sync_event_id)
);

create index if not exists idx_sage_dlq_tenant_object_type
  on public.sage_dead_letter_queue (tenant_id, object_type, created_at desc);

create index if not exists idx_sage_dlq_tenant_replay_eligible
  on public.sage_dead_letter_queue (tenant_id, replay_eligible, created_at desc)
  where replay_eligible = true and replayed_at is null and resolved_at is null;

create trigger trg_sage_dlq_updated_at
  before update on public.sage_dead_letter_queue
  for each row execute function update_updated_at();

revoke all on table public.sage_dead_letter_queue from anon, authenticated;
grant select on table public.sage_dead_letter_queue to authenticated;
grant all on table public.sage_dead_letter_queue to service_role;

alter table public.sage_dead_letter_queue enable row level security;

drop policy if exists "sage_dlq_ops_read" on public.sage_dead_letter_queue;
drop policy if exists "sage_dlq_service_role" on public.sage_dead_letter_queue;

create policy "sage_dlq_ops_read"
  on public.sage_dead_letter_queue
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "sage_dlq_service_role"
  on public.sage_dead_letter_queue
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

create table if not exists public.sage_sync_controls (
  id              uuid          primary key default gen_random_uuid(),
  tenant_id       uuid          not null references public.tenants(id) on delete restrict,
  provider_name   text          not null default 'sage',
  object_type     text          not null,
  object_key      text          not null,
  source_system   text          not null default 'sage',
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

  constraint sage_sync_controls_provider_name_chk
    check (provider_name = 'sage'),

  constraint sage_sync_controls_object_type_chk
    check (object_type in ('general_ledger', 'invoice', 'accounts_payable', 'accounts_receivable')),

  constraint sage_sync_controls_status_chk
    check (control_status in ('active', 'disabled')),

  constraint sage_sync_controls_scope_uniq
    unique (tenant_id, provider_name, object_type, object_key, source_system)
);

create trigger trg_sage_sync_controls_updated_at
  before update on public.sage_sync_controls
  for each row execute function update_updated_at();

revoke all on table public.sage_sync_controls from anon, authenticated;
grant select on table public.sage_sync_controls to authenticated;
grant all on table public.sage_sync_controls to service_role;

alter table public.sage_sync_controls enable row level security;

drop policy if exists "sage_sync_controls_ops_read" on public.sage_sync_controls;
drop policy if exists "sage_sync_controls_service_role" on public.sage_sync_controls;

create policy "sage_sync_controls_ops_read"
  on public.sage_sync_controls
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "sage_sync_controls_service_role"
  on public.sage_sync_controls
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

create table if not exists public.sage_reconciliation_results (
  id                  uuid          primary key default gen_random_uuid(),
  tenant_id           uuid          not null references public.tenants(id) on delete restrict,
  provider_name       text          not null default 'sage',
  object_type         text          not null,
  object_key          text          not null,
  internal_record_id  text,
  sage_record_id      text,
  drift_status        text          not null default 'unknown',
  internal_digest     text,
  sage_digest         text,
  compared_fields     jsonb         not null default '[]'::jsonb,
  diagnostic_summary  text,
  last_sync_event_id  uuid          references public.sage_sync_events(id),
  checked_at          timestamptz   not null default now(),
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),

  constraint sage_recon_object_type_chk
    check (object_type in ('general_ledger', 'invoice', 'accounts_payable', 'accounts_receivable')),

  constraint sage_recon_drift_status_chk
    check (drift_status in ('in_sync', 'drifted', 'missing_internal', 'missing_sage', 'unknown')),

  constraint sage_recon_dedupe_uniq
    unique (tenant_id, provider_name, object_type, object_key)
);

create index if not exists idx_sage_recon_tenant_object_drift
  on public.sage_reconciliation_results (tenant_id, object_type, drift_status, checked_at desc);

create trigger trg_sage_recon_updated_at
  before update on public.sage_reconciliation_results
  for each row execute function update_updated_at();

revoke all on table public.sage_reconciliation_results from anon, authenticated;
grant select on table public.sage_reconciliation_results to authenticated;
grant all on table public.sage_reconciliation_results to service_role;

alter table public.sage_reconciliation_results enable row level security;

drop policy if exists "sage_recon_ops_read" on public.sage_reconciliation_results;
drop policy if exists "sage_recon_service_role" on public.sage_reconciliation_results;

create policy "sage_recon_ops_read"
  on public.sage_reconciliation_results
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "sage_recon_service_role"
  on public.sage_reconciliation_results
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

-- ---------------------------------------------------------------------------
-- 5. Checkpoint audit — restart/recovery telemetry for interrupted sync scopes
-- ---------------------------------------------------------------------------

create table if not exists public.sage_sync_checkpoint_audit (
  id                         uuid          primary key default gen_random_uuid(),
  integration_sync_state_id  uuid          not null references public.integration_sync_state(id) on delete cascade,
  integration_id             uuid          not null references public.integration_config(id) on delete cascade,
  tenant_id                  uuid          not null references public.tenants(id) on delete restrict,
  provider_name              text          not null default 'sage',
  object_type                text          not null,
  object_key                 text          not null,
  direction                  text          not null,
  scope_key                  text          not null,
  cursor_value               text,
  checkpoint_status          text          not null default 'healthy',
  recovery_state             jsonb         not null default '{}'::jsonb,
  recorded_at                timestamptz   not null default now(),
  created_at                 timestamptz   not null default now(),

  constraint sage_checkpoint_provider_name_chk
    check (provider_name = 'sage'),

  constraint sage_checkpoint_object_type_chk
    check (object_type in ('general_ledger', 'invoice', 'accounts_payable', 'accounts_receivable')),

  constraint sage_checkpoint_direction_chk
    check (direction in ('inbound', 'outbound')),

  constraint sage_checkpoint_status_chk
    check (checkpoint_status in ('healthy', 'interrupted', 'recovered', 'replayed'))
);

create index if not exists idx_sage_checkpoint_audit_tenant_object_time
  on public.sage_sync_checkpoint_audit (tenant_id, object_type, object_key, recorded_at desc);

create index if not exists idx_sage_checkpoint_audit_sync_state
  on public.sage_sync_checkpoint_audit (integration_sync_state_id, recorded_at desc);

revoke all on table public.sage_sync_checkpoint_audit from anon, authenticated;
grant select on table public.sage_sync_checkpoint_audit to authenticated;
grant all on table public.sage_sync_checkpoint_audit to service_role;

alter table public.sage_sync_checkpoint_audit enable row level security;

drop policy if exists "sage_checkpoint_audit_ops_read" on public.sage_sync_checkpoint_audit;
drop policy if exists "sage_checkpoint_audit_service_role" on public.sage_sync_checkpoint_audit;

create policy "sage_checkpoint_audit_ops_read"
  on public.sage_sync_checkpoint_audit
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and tenant_id is not null
    and public.ops_tenant_match(tenant_id)
  );

create policy "sage_checkpoint_audit_service_role"
  on public.sage_sync_checkpoint_audit
  for all
  to service_role
  using (true)
  with check (
    tenant_id is not null
    and exists (select 1 from public.tenants t where t.id = tenant_id)
  );

create or replace function public.sage_upsert_sync_checkpoint(
  p_integration_id       uuid,
  p_tenant_id            uuid,
  p_object_type          text,
  p_object_key           text,
  p_direction            text,
  p_cursor_value         text,
  p_checkpoint_status    text default 'healthy',
  p_recovery_state       jsonb default '{}'::jsonb,
  p_recorded_at          timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_role  text;
  v_scope_key     text;
  v_state_id      uuid;
  v_recorded_at   timestamptz;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(public.ops_claims_json() ->> 'role', '')
  );

  if v_request_role is distinct from 'service_role' then
    raise exception 'sage_upsert_sync_checkpoint requires service_role'
      using errcode = 'insufficient_privilege';
  end if;

  if p_object_type not in ('general_ledger', 'invoice', 'accounts_payable', 'accounts_receivable') then
    raise exception 'sage_upsert_sync_checkpoint: unsupported object_type %', p_object_type
      using errcode = 'check_violation';
  end if;

  if p_direction not in ('inbound', 'outbound') then
    raise exception 'sage_upsert_sync_checkpoint: unsupported direction %', p_direction
      using errcode = 'check_violation';
  end if;

  if p_checkpoint_status not in ('healthy', 'interrupted', 'recovered', 'replayed') then
    raise exception 'sage_upsert_sync_checkpoint: unsupported checkpoint_status %', p_checkpoint_status
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1
    from public.integration_config c
    where c.id = p_integration_id
      and c.tenant_id = p_tenant_id
      and coalesce(c.connector_key, c.provider_key, c.provider) = 'sage'
  ) then
    raise exception 'sage_upsert_sync_checkpoint: integration % is not a Sage connector for tenant %',
      p_integration_id,
      p_tenant_id
      using errcode = 'no_data_found';
  end if;

  v_scope_key := format('sage:%s:%s:%s', p_object_type, p_direction, p_object_key);
  v_recorded_at := coalesce(p_recorded_at, now());

  insert into public.integration_sync_state (
    integration_id,
    tenant_id,
    connector_key,
    exchange_key,
    scope_key,
    source_of_truth,
    direction,
    cursor,
    cursor_value,
    last_success_at,
    last_synced_at,
    state,
    metadata
  )
  values (
    p_integration_id,
    p_tenant_id,
    'sage',
    'erp_finance',
    v_scope_key,
    case when p_direction = 'inbound' then 'provider' else 'wynne' end,
    p_direction,
    p_cursor_value,
    p_cursor_value,
    case when p_checkpoint_status = 'healthy' then v_recorded_at else null end,
    v_recorded_at,
    coalesce(p_recovery_state, '{}'::jsonb),
    jsonb_build_object(
      'provider_name', 'sage',
      'object_type', p_object_type,
      'object_key', p_object_key,
      'checkpoint_status', p_checkpoint_status
    )
  )
  on conflict (integration_id, scope_key) do update
    set
      connector_key = 'sage',
      exchange_key = 'erp_finance',
      source_of_truth = case when p_direction = 'inbound' then 'provider' else 'wynne' end,
      direction = p_direction,
      cursor = p_cursor_value,
      cursor_value = p_cursor_value,
      last_success_at = case
        when p_checkpoint_status = 'healthy' then v_recorded_at
        else public.integration_sync_state.last_success_at
      end,
      last_synced_at = v_recorded_at,
      state = coalesce(p_recovery_state, '{}'::jsonb),
      metadata = coalesce(public.integration_sync_state.metadata, '{}'::jsonb) || jsonb_build_object(
        'provider_name', 'sage',
        'object_type', p_object_type,
        'object_key', p_object_key,
        'checkpoint_status', p_checkpoint_status
      ),
      updated_at = now()
  returning id into v_state_id;

  insert into public.sage_sync_checkpoint_audit (
    integration_sync_state_id,
    integration_id,
    tenant_id,
    provider_name,
    object_type,
    object_key,
    direction,
    scope_key,
    cursor_value,
    checkpoint_status,
    recovery_state,
    recorded_at
  )
  values (
    v_state_id,
    p_integration_id,
    p_tenant_id,
    'sage',
    p_object_type,
    p_object_key,
    p_direction,
    v_scope_key,
    p_cursor_value,
    p_checkpoint_status,
    coalesce(p_recovery_state, '{}'::jsonb),
    v_recorded_at
  );

  return v_state_id;
end;
$$;

revoke all on function public.sage_upsert_sync_checkpoint(uuid, uuid, text, text, text, text, text, jsonb, timestamptz) from anon, authenticated;
grant execute on function public.sage_upsert_sync_checkpoint(uuid, uuid, text, text, text, text, text, jsonb, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. Operator functions — quarantine, replay, disable, re-enable
-- ---------------------------------------------------------------------------

create or replace function public.sage_quarantine_sync_event(
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
  v_event   public.sage_sync_events%rowtype;
  v_dlq_id  uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'sage_quarantine_sync_event: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.sage_sync_events
  where id = p_sync_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'sage_quarantine_sync_event: sync event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if v_event.sync_status = 'quarantined' then
    raise exception 'sage_quarantine_sync_event: sync event is already quarantined'
      using errcode = 'check_violation';
  end if;

  update public.sage_sync_events
  set
    sync_status    = 'quarantined',
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now()
  where id = p_sync_event_id;

  insert into public.sage_dead_letter_queue (
    tenant_id,
    sync_event_id,
    provider_name,
    object_type,
    object_key,
    internal_record_id,
    sage_record_id,
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
    v_event.sage_record_id,
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

revoke all on function public.sage_quarantine_sync_event(uuid, text, boolean, text) from anon;
grant execute on function public.sage_quarantine_sync_event(uuid, text, boolean, text)
  to authenticated, service_role;

create or replace function public.sage_mark_replayed(
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
  v_dlq           public.sage_dead_letter_queue%rowtype;
  v_source_event  public.sage_sync_events%rowtype;
  v_replay_id     uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'sage_mark_replayed: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_dlq
  from public.sage_dead_letter_queue
  where id = p_dlq_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'sage_mark_replayed: DLQ entry not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  if not v_dlq.replay_eligible then
    raise exception 'sage_mark_replayed: DLQ entry is not marked replay-eligible'
      using errcode = 'check_violation';
  end if;

  if v_dlq.replayed_at is not null then
    raise exception 'sage_mark_replayed: DLQ entry has already been replayed at %',
      v_dlq.replayed_at
      using errcode = 'check_violation';
  end if;

  select * into v_source_event
  from public.sage_sync_events
  where id = v_dlq.sync_event_id;

  insert into public.sage_sync_events (
    tenant_id,
    provider_name,
    sync_run_id,
    object_type,
    object_key,
    internal_record_id,
    sage_record_id,
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
    v_source_event.sage_record_id,
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

  update public.sage_dead_letter_queue
  set
    replayed_at          = now(),
    replayed_by          = coalesce(p_replay_actor, v_role),
    replay_sync_event_id = v_replay_id,
    resolved_at          = now(),
    resolved_by          = coalesce(p_replay_actor, v_role),
    resolution_note      = coalesce(p_operator_notes, resolution_note),
    updated_at           = now()
  where id = p_dlq_id;

  update public.sage_sync_events
  set
    resolved_at = now(),
    updated_at  = now()
  where id = v_source_event.id;

  return v_replay_id;
end;
$$;

revoke all on function public.sage_mark_replayed(uuid, text, text) from anon;
grant execute on function public.sage_mark_replayed(uuid, text, text)
  to authenticated, service_role;

create or replace function public.sage_disable_sync_scope(
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
  v_event       public.sage_sync_events%rowtype;
  v_control_id  uuid;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'sage_disable_sync_scope: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.sage_sync_events
  where id = p_sync_event_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'sage_disable_sync_scope: sync event not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  insert into public.sage_sync_controls (
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
      operator_notes  = coalesce(excluded.operator_notes, public.sage_sync_controls.operator_notes),
      updated_at      = now()
  returning id into v_control_id;

  update public.sage_sync_events
  set
    sync_status    = 'disabled',
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now(),
    metadata       = metadata || jsonb_build_object('disabled_control_id', v_control_id)
  where id = p_sync_event_id;

  return v_control_id;
end;
$$;

revoke all on function public.sage_disable_sync_scope(uuid, text, text) from anon;
grant execute on function public.sage_disable_sync_scope(uuid, text, text)
  to authenticated, service_role;

create or replace function public.sage_enable_sync_scope(
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
  v_control public.sage_sync_controls%rowtype;
begin
  v_role := public.ops_claim_app_role();
  if v_role not in ('admin', 'branch_manager') then
    raise exception 'sage_enable_sync_scope: insufficient role %', v_role
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_control
  from public.sage_sync_controls
  where id = p_control_id
    and public.ops_tenant_match(tenant_id);

  if not found then
    raise exception 'sage_enable_sync_scope: sync control not found or not accessible'
      using errcode = 'no_data_found';
  end if;

  update public.sage_sync_controls
  set
    control_status = 'active',
    reenabled_at   = now(),
    reenabled_by   = coalesce(p_reenable_actor, v_role),
    operator_notes = coalesce(p_operator_notes, operator_notes),
    updated_at     = now()
  where id = p_control_id;

  update public.sage_sync_events
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

revoke all on function public.sage_enable_sync_scope(uuid, text, text) from anon;
grant execute on function public.sage_enable_sync_scope(uuid, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Operator views — dashboard, failed work, reconciliation drift, audit history
-- ---------------------------------------------------------------------------

create or replace view public.v_sage_sync_dashboard
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
  count(*) filter (where e.failure_class = 'validation')                as validation_failure_count,
  count(*) filter (where e.failure_class = 'reconciliation')            as reconciliation_failure_count,
  count(*) filter (where e.sync_status = 'retrying')                    as retryable_failure_count,
  count(*) filter (where e.sync_status in ('dead_lettered', 'quarantined', 'disabled')) as terminal_failure_count,
  max(e.occurred_at)                                                    as last_attempt_at,
  max(e.occurred_at) filter (where e.sync_status = 'synced')            as last_synced_at,
  max(e.occurred_at) filter (
    where e.sync_status in ('dead_lettered', 'quarantined', 'disabled')
  )                                                                     as last_failure_at
from public.sage_sync_events e
group by e.tenant_id, e.provider_name, e.object_type, e.direction;

revoke all on table public.v_sage_sync_dashboard from anon;
grant select on table public.v_sage_sync_dashboard to authenticated, service_role;

create or replace view public.v_sage_failed_sync_work
  with (security_invoker = true) as
select
  e.id,
  e.tenant_id,
  e.provider_name,
  e.object_type,
  e.object_key,
  e.internal_record_id,
  e.sage_record_id,
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
  ctrl.disabled_at,
  case
    when e.sync_status = 'retrying' then 'retryable'
    else 'terminal'
  end                     as failure_disposition,
  (e.sync_status = 'retrying') as is_retryable_failure,
  (e.sync_status in ('dead_lettered', 'quarantined', 'disabled')) as is_terminal_failure,
  chk.checkpoint_status,
  chk.cursor_value         as checkpoint_cursor_value,
  chk.recorded_at          as checkpoint_recorded_at,
  chk.recovery_state       as checkpoint_recovery_state
from public.sage_sync_events e
left join public.sage_dead_letter_queue dlq
  on dlq.sync_event_id = e.id
left join public.sage_sync_controls ctrl
  on ctrl.tenant_id = e.tenant_id
 and ctrl.provider_name = e.provider_name
 and ctrl.object_type = e.object_type
 and ctrl.object_key = e.object_key
 and ctrl.source_system = e.source_system
 and ctrl.control_status = 'disabled'
left join lateral (
 select
   c.checkpoint_status,
   c.cursor_value,
   c.recorded_at,
   c.recovery_state
 from public.sage_sync_checkpoint_audit c
 where c.tenant_id = e.tenant_id
   and c.object_type = e.object_type
   and c.object_key = e.object_key
   and c.direction = e.direction
 order by c.recorded_at desc, c.created_at desc
 limit 1
) chk on true
where e.sync_status in ('retrying', 'dead_lettered', 'quarantined', 'disabled')
 and e.resolved_at is null;

revoke all on table public.v_sage_failed_sync_work from anon;
grant select on table public.v_sage_failed_sync_work to authenticated, service_role;

create or replace view public.v_sage_reconciliation_drift
  with (security_invoker = true) as
select
  r.id,
  r.tenant_id,
  r.provider_name,
  r.object_type,
  r.object_key,
  r.internal_record_id,
  r.sage_record_id,
  r.drift_status,
  r.internal_digest,
  r.sage_digest,
  r.compared_fields,
  r.diagnostic_summary,
  r.last_sync_event_id,
  r.checked_at,
  ctrl.id                as control_id,
  ctrl.control_status,
  ctrl.disabled_reason,
  dlq.id                 as dlq_id,
  dlq.quarantine_reason,
  dlq.replay_eligible,
  chk.checkpoint_status,
  chk.cursor_value       as checkpoint_cursor_value,
  chk.recorded_at        as checkpoint_recorded_at,
  chk.recovery_state     as checkpoint_recovery_state
from public.sage_reconciliation_results r
left join public.sage_sync_controls ctrl
  on ctrl.tenant_id = r.tenant_id
 and ctrl.provider_name = r.provider_name
 and ctrl.object_type = r.object_type
 and ctrl.object_key = r.object_key
 and ctrl.control_status = 'disabled'
left join public.sage_dead_letter_queue dlq
  on dlq.tenant_id = r.tenant_id
 and dlq.provider_name = r.provider_name
 and dlq.object_type = r.object_type
 and dlq.object_key = r.object_key
 and dlq.resolved_at is null
left join lateral (
  select
    c.checkpoint_status,
    c.cursor_value,
    c.recorded_at,
    c.recovery_state
  from public.sage_sync_checkpoint_audit c
  where c.tenant_id = r.tenant_id
    and c.object_type = r.object_type
    and c.object_key = r.object_key
  order by c.recorded_at desc, c.created_at desc
  limit 1
) chk on true
where r.drift_status <> 'in_sync';

revoke all on table public.v_sage_reconciliation_drift from anon;
grant select on table public.v_sage_reconciliation_drift to authenticated, service_role;

create or replace view public.v_sage_reconciliation_summary
  with (security_invoker = true) as
select
  r.tenant_id,
  r.provider_name,
  r.object_type,
  r.drift_status,
  count(*)           as object_count,
  max(r.checked_at)  as last_checked_at
from public.sage_reconciliation_results r
group by r.tenant_id, r.provider_name, r.object_type, r.drift_status;

revoke all on table public.v_sage_reconciliation_summary from anon;
grant select on table public.v_sage_reconciliation_summary to authenticated, service_role;

create or replace view public.v_sage_sync_audit_history
  with (security_invoker = true) as
select
  e.tenant_id,
  e.provider_name,
  e.object_type,
  e.object_key,
  e.direction,
  'sync_event'::text      as event_kind,
  e.id                    as event_id,
  e.sync_status           as event_status,
  case
    when e.sync_status = 'retrying' then 'retryable'
    when e.sync_status in ('dead_lettered', 'quarantined', 'disabled') then 'terminal'
    else null
  end                     as failure_disposition,
  e.failure_class,
  e.failure_code,
  e.failure_message,
  e.retry_count,
  e.max_retries,
  null::text              as checkpoint_cursor_value,
  null::text              as checkpoint_status,
  null::jsonb             as checkpoint_recovery_state,
  e.operator_notes,
  e.occurred_at
from public.sage_sync_events e

union all

select
  c.tenant_id,
  c.provider_name,
  c.object_type,
  c.object_key,
  c.direction,
  'checkpoint'::text      as event_kind,
  c.id                    as event_id,
  c.checkpoint_status     as event_status,
  null::text              as failure_disposition,
  null::text              as failure_class,
  null::text              as failure_code,
  null::text              as failure_message,
  null::integer           as retry_count,
  null::integer           as max_retries,
  c.cursor_value          as checkpoint_cursor_value,
  c.checkpoint_status,
  c.recovery_state        as checkpoint_recovery_state,
  null::text              as operator_notes,
  c.recorded_at           as occurred_at
from public.sage_sync_checkpoint_audit c;

revoke all on table public.v_sage_sync_audit_history from anon;
grant select on table public.v_sage_sync_audit_history to authenticated, service_role;
