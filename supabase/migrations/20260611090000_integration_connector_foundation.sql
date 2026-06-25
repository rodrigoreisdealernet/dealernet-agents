-- Integration connector foundation tables (ADR-0037, epic #892)
--
-- Shared, tenant-scoped persistence layer for all third-party integration adapters.
-- Non-secret configuration lives here. Raw credentials and OAuth client secrets are
-- stored only as references to an approved external secret source (see constraint below).
--
-- Tables
--   integration_config       – connector registration, auth type, secret refs, schedules, mappings
--   integration_sync_state   – cursor/checkpoint/source-of-truth state per connector scope
--   external_id_map          – durable aliasing between Wynne entities and vendor identifiers
--   integration_delivery_log – webhook dedupe, outbound idempotency, and delivery history

-- ---------------------------------------------------------------------------
-- integration_config
-- ---------------------------------------------------------------------------
create table if not exists public.integration_config (
    id                  uuid primary key default gen_random_uuid(),
    tenant_id           uuid not null references public.tenants(id) on delete cascade,
    provider            text not null,                  -- e.g. 'mulesoft', 'salesforce'
    display_name        text not null default '',
    enabled             boolean not null default false,
    auth_type           text not null,                  -- 'client_credentials', 'basic', 'api_key', 'none'
    -- Non-secret connection parameters (base URL, org ID, env, etc.)
    connection_config   jsonb not null default '{}'::jsonb,
    -- Secret references only – resolved at runtime via platform secret delivery
    -- e.g. {"client_id_ref": "vault/tenants/acme/mulesoft/client_id", "client_secret_ref": "..."}
    secret_refs         jsonb not null default '{}'::jsonb,
    -- Provider-specific feature flags: enabled endpoints/flows, mapping profiles, policy inputs
    feature_config      jsonb not null default '{}'::jsonb,
    -- ISO-8601 schedule expression for polling sync (null = event-driven only)
    sync_schedule       text,
    -- Soft-delete / disable timestamp; null = active
    disabled_at         timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    -- Enforce one active config per tenant+provider (disabled rows may accumulate)
    constraint uq_integration_config_tenant_provider_active
        unique nulls not distinct (tenant_id, provider, disabled_at)
);

create index if not exists idx_integration_config_tenant_provider
    on public.integration_config (tenant_id, provider);

comment on table public.integration_config is
    'Tenant-scoped connector configuration. Secrets are stored as references only; '
    'raw credentials must not be inserted here.';
comment on column public.integration_config.secret_refs is
    'Path references to secrets in the approved platform secret source. '
    'Must not contain the secret value itself.';

-- ---------------------------------------------------------------------------
-- integration_sync_state
-- ---------------------------------------------------------------------------
create table if not exists public.integration_sync_state (
    id                  uuid primary key default gen_random_uuid(),
    integration_id      uuid not null references public.integration_config (id) on delete cascade,
    tenant_id           uuid not null references public.tenants(id) on delete cascade,
    scope_key           text not null,     -- stream / topic / entity-type being synced
    cursor_value        text,              -- opaque cursor, checkpoint, or watermark
    source_of_truth     text not null default 'wynne',  -- 'wynne' | 'provider' | 'bidirectional'
    last_synced_at      timestamptz,
    metadata            jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint uq_integration_sync_state_scope
        unique (integration_id, scope_key)
);

create index if not exists idx_integration_sync_state_integration
    on public.integration_sync_state (integration_id);
create index if not exists idx_integration_sync_state_tenant
    on public.integration_sync_state (tenant_id);

comment on table public.integration_sync_state is
    'Cursor, checkpoint, and source-of-truth state per connector stream or scope.';

-- ---------------------------------------------------------------------------
-- external_id_map
-- ---------------------------------------------------------------------------
create table if not exists public.external_id_map (
    id                  uuid primary key default gen_random_uuid(),
    tenant_id           uuid not null references public.tenants(id) on delete cascade,
    provider            text not null,
    entity_type         text not null,     -- e.g. 'asset', 'contract', 'customer'
    wynne_entity_id     uuid not null,
    external_id         text not null,
    external_system     text not null,     -- e.g. 'mulesoft', 'salesforce_org_001'
    metadata            jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint uq_external_id_map_wynne
        unique (tenant_id, provider, entity_type, wynne_entity_id, external_system),
    constraint uq_external_id_map_external
        unique (tenant_id, provider, entity_type, external_id, external_system)
);

create index if not exists idx_external_id_map_tenant_provider
    on public.external_id_map (tenant_id, provider);
create index if not exists idx_external_id_map_wynne_entity
    on public.external_id_map (tenant_id, entity_type, wynne_entity_id);

comment on table public.external_id_map is
    'Stable bidirectional aliasing between Wynne entity UUIDs and provider-assigned identifiers.';

-- ---------------------------------------------------------------------------
-- integration_delivery_log
-- ---------------------------------------------------------------------------
create table if not exists public.integration_delivery_log (
    id                  uuid primary key default gen_random_uuid(),
    integration_id      uuid not null references public.integration_config (id) on delete cascade,
    tenant_id           uuid not null references public.tenants(id) on delete cascade,
    direction           text not null,     -- 'outbound' | 'inbound'
    exchange_key        text not null,     -- e.g. 'rental_contract_snapshot', 'delivery_receipt'
    idempotency_key     text not null,
    entity_id           uuid,
    payload_hash        text,              -- SHA-256 of normalised payload (no PII/secrets)
    status              text not null default 'pending',  -- 'pending' | 'delivered' | 'failed' | 'skipped'
    attempt_count       int not null default 0,
    last_error          text,
    delivered_at        timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint uq_integration_delivery_log_idempotency
        unique (integration_id, direction, idempotency_key)
);

create index if not exists idx_integration_delivery_log_integration
    on public.integration_delivery_log (integration_id, direction, status);
create index if not exists idx_integration_delivery_log_tenant
    on public.integration_delivery_log (tenant_id, exchange_key);

comment on table public.integration_delivery_log is
    'Outbound idempotency tracking and inbound webhook deduplication log. '
    'Payload hash only – no business data or credentials stored here.';

-- ---------------------------------------------------------------------------
-- updated_at triggers (reuse update_updated_at() from core_entity_model)
-- ---------------------------------------------------------------------------
do $$
declare
    tbl text;
begin
    foreach tbl in array array[
        'integration_config',
        'integration_sync_state',
        'external_id_map',
        'integration_delivery_log'
    ] loop
        execute format(
            'create trigger trg_%s_updated_at
             before update on public.%I
             for each row execute function update_updated_at()',
            tbl, tbl
        );
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- anon has no access to any integration table
revoke all on public.integration_config       from anon, authenticated;
revoke all on public.integration_sync_state   from anon, authenticated;
revoke all on public.external_id_map          from anon, authenticated;
revoke all on public.integration_delivery_log from anon, authenticated;

-- authenticated may read (row-level policies enforce tenant and role scope)
grant select on public.integration_config       to authenticated;
grant select on public.integration_sync_state   to authenticated;
grant select on public.external_id_map          to authenticated;
grant select on public.integration_delivery_log to authenticated;

-- service_role has full access (Temporal worker write path)
grant select, insert, update, delete on public.integration_config       to service_role;
grant select, insert, update, delete on public.integration_sync_state   to service_role;
grant select, insert, update, delete on public.external_id_map          to service_role;
grant select, insert, update, delete on public.integration_delivery_log to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.integration_config       enable row level security;
alter table public.integration_sync_state   enable row level security;
alter table public.external_id_map          enable row level security;
alter table public.integration_delivery_log enable row level security;

-- integration_config

drop policy if exists integration_config_authenticated_read on public.integration_config;
create policy integration_config_authenticated_read
    on public.integration_config
    for select
    to authenticated
    using (
        public.ops_claim_app_role() in ('admin', 'branch_manager')
        and public.ops_tenant_match(tenant_id)
    );

drop policy if exists integration_config_service_role_read on public.integration_config;
create policy integration_config_service_role_read
    on public.integration_config
    for select
    to service_role
    using (public.ops_tenant_match(tenant_id));

drop policy if exists integration_config_service_role_insert on public.integration_config;
create policy integration_config_service_role_insert
    on public.integration_config
    for insert
    to service_role
    with check (true);

drop policy if exists integration_config_service_role_update on public.integration_config;
create policy integration_config_service_role_update
    on public.integration_config
    for update
    to service_role
    using (true)
    with check (true);

drop policy if exists integration_config_service_role_delete on public.integration_config;
create policy integration_config_service_role_delete
    on public.integration_config
    for delete
    to service_role
    using (true);

-- integration_sync_state

drop policy if exists integration_sync_state_authenticated_read on public.integration_sync_state;
create policy integration_sync_state_authenticated_read
    on public.integration_sync_state
    for select
    to authenticated
    using (
        public.ops_claim_app_role() in ('admin', 'branch_manager')
        and public.ops_tenant_match(tenant_id)
    );

drop policy if exists integration_sync_state_service_role_read on public.integration_sync_state;
create policy integration_sync_state_service_role_read
    on public.integration_sync_state
    for select
    to service_role
    using (public.ops_tenant_match(tenant_id));

drop policy if exists integration_sync_state_service_role_insert on public.integration_sync_state;
create policy integration_sync_state_service_role_insert
    on public.integration_sync_state
    for insert
    to service_role
    with check (true);

drop policy if exists integration_sync_state_service_role_update on public.integration_sync_state;
create policy integration_sync_state_service_role_update
    on public.integration_sync_state
    for update
    to service_role
    using (true)
    with check (true);

drop policy if exists integration_sync_state_service_role_delete on public.integration_sync_state;
create policy integration_sync_state_service_role_delete
    on public.integration_sync_state
    for delete
    to service_role
    using (true);

-- external_id_map

drop policy if exists external_id_map_authenticated_read on public.external_id_map;
create policy external_id_map_authenticated_read
    on public.external_id_map
    for select
    to authenticated
    using (
        public.ops_claim_app_role() in ('admin', 'branch_manager')
        and public.ops_tenant_match(tenant_id)
    );

drop policy if exists external_id_map_service_role_read on public.external_id_map;
create policy external_id_map_service_role_read
    on public.external_id_map
    for select
    to service_role
    using (public.ops_tenant_match(tenant_id));

drop policy if exists external_id_map_service_role_insert on public.external_id_map;
create policy external_id_map_service_role_insert
    on public.external_id_map
    for insert
    to service_role
    with check (true);

drop policy if exists external_id_map_service_role_update on public.external_id_map;
create policy external_id_map_service_role_update
    on public.external_id_map
    for update
    to service_role
    using (true)
    with check (true);

drop policy if exists external_id_map_service_role_delete on public.external_id_map;
create policy external_id_map_service_role_delete
    on public.external_id_map
    for delete
    to service_role
    using (true);

-- integration_delivery_log

drop policy if exists integration_delivery_log_authenticated_read on public.integration_delivery_log;
create policy integration_delivery_log_authenticated_read
    on public.integration_delivery_log
    for select
    to authenticated
    using (
        public.ops_claim_app_role() in ('admin', 'branch_manager')
        and public.ops_tenant_match(tenant_id)
    );

drop policy if exists integration_delivery_log_service_role_read on public.integration_delivery_log;
create policy integration_delivery_log_service_role_read
    on public.integration_delivery_log
    for select
    to service_role
    using (public.ops_tenant_match(tenant_id));

drop policy if exists integration_delivery_log_service_role_insert on public.integration_delivery_log;
create policy integration_delivery_log_service_role_insert
    on public.integration_delivery_log
    for insert
    to service_role
    with check (true);

drop policy if exists integration_delivery_log_service_role_update on public.integration_delivery_log;
create policy integration_delivery_log_service_role_update
    on public.integration_delivery_log
    for update
    to service_role
    using (true)
    with check (true);

drop policy if exists integration_delivery_log_service_role_delete on public.integration_delivery_log;
create policy integration_delivery_log_service_role_delete
    on public.integration_delivery_log
    for delete
    to service_role
    using (true);
