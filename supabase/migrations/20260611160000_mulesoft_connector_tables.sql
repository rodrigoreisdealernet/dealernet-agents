-- Shared connector tables for MuleSoft exchange workflows.
-- Adds tenant-scoped config, alias, cursor/state, and delivery-log persistence aligned to ADR-0037.

create table if not exists public.integration_config (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_key text not null,
  provider text,
  provider_key text,
  display_name text not null default '',
  enabled boolean not null default true,
  auth_type text not null default 'none',
  settings jsonb not null default '{}'::jsonb,
  mappings jsonb not null default '{}'::jsonb,
  secret_refs jsonb not null default '{}'::jsonb,
  schedule jsonb not null default '{}'::jsonb,
  endpoint_base_url text,
  enabled_scopes jsonb not null default '[]'::jsonb,
  config jsonb not null default '{}'::jsonb,
  connection_config jsonb not null default '{}'::jsonb,
  feature_config jsonb not null default '{}'::jsonb,
  sync_schedule text,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Replay-safe additive backfill for environments where another open integration
-- migration created integration_config first with only part of the shared contract.
alter table public.integration_config add column if not exists id uuid default gen_random_uuid();
alter table public.integration_config add column if not exists connector_key text;
alter table public.integration_config add column if not exists provider text;
alter table public.integration_config add column if not exists provider_key text;
alter table public.integration_config add column if not exists display_name text not null default '';
alter table public.integration_config add column if not exists enabled boolean not null default true;
alter table public.integration_config add column if not exists auth_type text not null default 'none';
alter table public.integration_config add column if not exists settings jsonb not null default '{}'::jsonb;
alter table public.integration_config add column if not exists mappings jsonb not null default '{}'::jsonb;
alter table public.integration_config add column if not exists secret_refs jsonb not null default '{}'::jsonb;
alter table public.integration_config add column if not exists schedule jsonb not null default '{}'::jsonb;
alter table public.integration_config add column if not exists endpoint_base_url text;
alter table public.integration_config add column if not exists enabled_scopes jsonb not null default '[]'::jsonb;
alter table public.integration_config add column if not exists config jsonb not null default '{}'::jsonb;
alter table public.integration_config add column if not exists connection_config jsonb not null default '{}'::jsonb;
alter table public.integration_config add column if not exists feature_config jsonb not null default '{}'::jsonb;
alter table public.integration_config add column if not exists sync_schedule text;
alter table public.integration_config add column if not exists disabled_at timestamptz;
alter table public.integration_config add column if not exists created_at timestamptz not null default now();
alter table public.integration_config add column if not exists updated_at timestamptz not null default now();

update public.integration_config
   set id = coalesce(id, gen_random_uuid()),
       connector_key = coalesce(connector_key, provider_key, provider),
       provider = coalesce(provider, provider_key, connector_key),
       provider_key = coalesce(provider_key, provider, connector_key),
       connection_config = coalesce(connection_config, settings, '{}'::jsonb),
       feature_config = coalesce(feature_config, mappings, config, '{}'::jsonb),
       sync_schedule = coalesce(sync_schedule, schedule ->> 'cron')
 where id is null
    or connector_key is null
    or provider is null
    or provider_key is null
    or connection_config = '{}'::jsonb
    or feature_config = '{}'::jsonb
    or sync_schedule is null;

alter table public.integration_config alter column id set default gen_random_uuid();
alter table public.integration_config alter column id set not null;

create unique index if not exists idx_integration_config_id
  on public.integration_config (id);
alter table public.integration_config alter column connector_key set not null;
alter table public.integration_config alter column provider set not null;
alter table public.integration_config alter column provider_key set not null;
alter table public.integration_config alter column settings set default '{}'::jsonb;
alter table public.integration_config alter column mappings set default '{}'::jsonb;
alter table public.integration_config alter column secret_refs set default '{}'::jsonb;
alter table public.integration_config alter column schedule set default '{}'::jsonb;
alter table public.integration_config alter column enabled_scopes set default '[]'::jsonb;
alter table public.integration_config alter column config set default '{}'::jsonb;
alter table public.integration_config alter column connection_config set default '{}'::jsonb;
alter table public.integration_config alter column feature_config set default '{}'::jsonb;

create table if not exists public.integration_delivery_log (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid references public.integration_config(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_key text not null,
  exchange_key text not null,
  direction text not null,
  scope_key text not null,
  entity_type text,
  entity_id text,
  workflow_id text,
  source_of_truth text not null,
  replay_of_delivery_id uuid references public.integration_delivery_log(id) on delete set null,
  provider_delivery_id text,
  idempotency_key text not null,
  payload_hash text,
  status text not null,
  attempt_count integer not null default 0,
  http_status integer,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_message text,
  last_error text,
  received_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_delivery_log_direction_chk check (direction in ('inbound', 'outbound')),
  -- received/pending/failed/sent/processed are the existing MuleSoft workflow
  -- states already used by this branch; delivered/skipped keep compatibility
  -- with the shared connector contract introduced in the parallel connector PRs.
  constraint integration_delivery_log_status_chk check (
    status in ('received', 'pending', 'sent', 'failed', 'processed', 'delivered', 'skipped')
  )
);

alter table public.integration_delivery_log add column if not exists integration_id uuid references public.integration_config(id) on delete cascade;
alter table public.integration_delivery_log add column if not exists connector_key text;
alter table public.integration_delivery_log add column if not exists scope_key text;
alter table public.integration_delivery_log add column if not exists entity_type text;
alter table public.integration_delivery_log add column if not exists entity_id text;
alter table public.integration_delivery_log add column if not exists workflow_id text;
alter table public.integration_delivery_log add column if not exists source_of_truth text;
alter table public.integration_delivery_log add column if not exists replay_of_delivery_id uuid references public.integration_delivery_log(id) on delete set null;
alter table public.integration_delivery_log add column if not exists provider_delivery_id text;
alter table public.integration_delivery_log add column if not exists payload_hash text;
alter table public.integration_delivery_log add column if not exists attempt_count integer not null default 0;
alter table public.integration_delivery_log add column if not exists http_status integer;
alter table public.integration_delivery_log add column if not exists request_payload jsonb not null default '{}'::jsonb;
alter table public.integration_delivery_log add column if not exists response_payload jsonb not null default '{}'::jsonb;
alter table public.integration_delivery_log add column if not exists error_message text;
alter table public.integration_delivery_log add column if not exists last_error text;
alter table public.integration_delivery_log add column if not exists received_at timestamptz not null default now();
alter table public.integration_delivery_log add column if not exists delivered_at timestamptz;
alter table public.integration_delivery_log add column if not exists created_at timestamptz not null default now();
alter table public.integration_delivery_log add column if not exists updated_at timestamptz not null default now();

create table if not exists public.external_id_map (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_key text not null,
  provider text,
  exchange_key text,
  entity_type text not null,
  entity_id text not null,
  wynne_entity_id uuid,
  external_id text not null,
  external_system text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.external_id_map add column if not exists connector_key text;
alter table public.external_id_map add column if not exists provider text;
alter table public.external_id_map add column if not exists exchange_key text;
alter table public.external_id_map add column if not exists entity_type text;
alter table public.external_id_map add column if not exists entity_id text;
alter table public.external_id_map add column if not exists wynne_entity_id uuid;
alter table public.external_id_map add column if not exists external_system text;
alter table public.external_id_map add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.external_id_map add column if not exists created_at timestamptz not null default now();
alter table public.external_id_map add column if not exists updated_at timestamptz not null default now();

create table if not exists public.integration_sync_state (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid references public.integration_config(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_key text not null,
  exchange_key text,
  scope_key text not null,
  source_of_truth text not null,
  direction text not null,
  cursor text,
  cursor_value text,
  last_success_at timestamptz,
  last_synced_at timestamptz,
  state jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_sync_state_direction_chk check (direction in ('inbound', 'outbound'))
);

alter table public.integration_sync_state add column if not exists integration_id uuid references public.integration_config(id) on delete cascade;
alter table public.integration_sync_state add column if not exists connector_key text;
alter table public.integration_sync_state add column if not exists exchange_key text;
alter table public.integration_sync_state add column if not exists scope_key text;
alter table public.integration_sync_state add column if not exists source_of_truth text;
alter table public.integration_sync_state add column if not exists direction text;
alter table public.integration_sync_state add column if not exists cursor text;
alter table public.integration_sync_state add column if not exists cursor_value text;
alter table public.integration_sync_state add column if not exists last_success_at timestamptz;
alter table public.integration_sync_state add column if not exists last_synced_at timestamptz;
alter table public.integration_sync_state add column if not exists state jsonb not null default '{}'::jsonb;
alter table public.integration_sync_state add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.integration_sync_state add column if not exists created_at timestamptz not null default now();
alter table public.integration_sync_state add column if not exists updated_at timestamptz not null default now();

update public.external_id_map
   set connector_key = coalesce(connector_key, provider, external_system),
       provider = coalesce(provider, connector_key, external_system),
       external_system = coalesce(external_system, provider, connector_key)
 where connector_key is null
    or provider is null
    or external_system is null;

alter table public.external_id_map alter column connector_key set not null;
alter table public.external_id_map alter column provider set not null;
alter table public.external_id_map alter column external_system set not null;
alter table public.external_id_map alter column entity_type set not null;
alter table public.external_id_map alter column entity_id set not null;
alter table public.external_id_map alter column metadata set default '{}'::jsonb;

update public.integration_sync_state s
   set connector_key = coalesce(s.connector_key, c.connector_key, c.provider_key, c.provider),
       direction = coalesce(
         s.direction,
         case
           when coalesce(s.source_of_truth, 'wynne') in ('provider', 'mulesoft') then 'inbound'
           else 'outbound'
         end
       ),
       cursor = coalesce(s.cursor, s.cursor_value),
       cursor_value = coalesce(s.cursor_value, s.cursor),
       state = case
         when s.state = '{}'::jsonb then coalesce(nullif(s.metadata, '{}'::jsonb), '{}'::jsonb)
         else s.state
       end,
       metadata = case
         when s.metadata = '{}'::jsonb then coalesce(nullif(s.state, '{}'::jsonb), '{}'::jsonb)
         else s.metadata
       end
  from public.integration_config c
 where c.id = s.integration_id
   and (
     s.connector_key is null
     or s.direction is null
     or s.cursor is null
     or s.cursor_value is null
     or s.state = '{}'::jsonb
     or s.metadata = '{}'::jsonb
   );

alter table public.integration_sync_state alter column connector_key set not null;
alter table public.integration_sync_state alter column scope_key set not null;
alter table public.integration_sync_state alter column source_of_truth set not null;
alter table public.integration_sync_state alter column direction set not null;
alter table public.integration_sync_state alter column state set default '{}'::jsonb;
alter table public.integration_sync_state alter column metadata set default '{}'::jsonb;

create or replace function public.resolve_integration_config_id(
  p_tenant_id uuid,
  p_connector_key text,
  p_provider text default null,
  p_provider_key text default null
)
returns uuid
language sql
stable
security invoker
as $$
  select c.id
    from public.integration_config c
   where c.tenant_id = p_tenant_id
     and (
       (p_connector_key is not null and c.connector_key = p_connector_key)
       or (p_provider_key is not null and c.provider_key = p_provider_key)
       or (p_provider is not null and c.provider = p_provider)
     )
   order by
     case
       when p_connector_key is not null and c.connector_key = p_connector_key then 0
       when p_provider_key is not null and c.provider_key = p_provider_key then 1
       when p_provider is not null and c.provider = p_provider then 2
       else 3
     end,
     c.disabled_at nulls first,
     c.updated_at desc,
     c.created_at desc
   limit 1
$$;

create or replace function public.integration_config_normalize_keys()
returns trigger
language plpgsql
security invoker
as $$
begin
  -- Canonical precedence is connector_key -> provider_key -> provider so newer
  -- callers keep their exact connector identity while replay-safe backfills can
  -- still hydrate the shared contract from older provider-only rows.
  new.connector_key := coalesce(new.connector_key, new.provider_key, new.provider);
  new.provider := coalesce(new.provider, new.provider_key, new.connector_key);
  new.provider_key := coalesce(new.provider_key, new.provider, new.connector_key);
  new.connection_config := coalesce(new.connection_config, new.settings, '{}'::jsonb);
  new.feature_config := coalesce(new.feature_config, new.mappings, new.config, '{}'::jsonb);
  new.sync_schedule := coalesce(new.sync_schedule, new.schedule ->> 'cron');
  return new;
end;
$$;

create or replace function public.integration_delivery_log_normalize()
returns trigger
language plpgsql
security invoker
as $$
declare
  v_connector_key text;
begin
  if new.connector_key is null and new.integration_id is not null then
    select c.connector_key
      into v_connector_key
      from public.integration_config c
     where c.id = new.integration_id;
    new.connector_key := v_connector_key;
  end if;

  if new.integration_id is null and new.tenant_id is not null and new.connector_key is not null then
    new.integration_id := public.resolve_integration_config_id(new.tenant_id, new.connector_key);
  end if;

  new.request_payload := coalesce(new.request_payload, '{}'::jsonb);
  new.response_payload := coalesce(new.response_payload, '{}'::jsonb);
  new.last_error := coalesce(new.last_error, new.error_message);
  return new;
end;
$$;

create or replace function public.external_id_map_normalize()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.connector_key := coalesce(new.connector_key, new.provider, new.external_system);
  new.provider := coalesce(new.provider, new.connector_key, new.external_system);
  new.external_system := coalesce(new.external_system, new.provider, new.connector_key);
  new.metadata := coalesce(new.metadata, '{}'::jsonb);
  return new;
end;
$$;

create or replace function public.integration_sync_state_normalize()
returns trigger
language plpgsql
security invoker
as $$
declare
  v_connector_key text;
begin
  if new.connector_key is null and new.integration_id is not null then
    select c.connector_key
      into v_connector_key
      from public.integration_config c
     where c.id = new.integration_id;
    new.connector_key := v_connector_key;
  end if;

  if new.integration_id is null and new.tenant_id is not null and new.connector_key is not null then
    new.integration_id := public.resolve_integration_config_id(new.tenant_id, new.connector_key);
  end if;

  if new.direction is null then
    new.direction := case
      when coalesce(new.source_of_truth, 'wynne') in ('provider', 'mulesoft') then 'inbound'
      else 'outbound'
    end;
  end if;

  new.cursor := coalesce(new.cursor, new.cursor_value);
  new.cursor_value := coalesce(new.cursor_value, new.cursor);
  new.state := coalesce(nullif(new.state, '{}'::jsonb), nullif(new.metadata, '{}'::jsonb), '{}'::jsonb);
  new.metadata := coalesce(nullif(new.metadata, '{}'::jsonb), nullif(new.state, '{}'::jsonb), '{}'::jsonb);
  return new;
end;
$$;

drop trigger if exists trg_integration_config_normalize_keys on public.integration_config;
create trigger trg_integration_config_normalize_keys
  before insert or update on public.integration_config
  for each row execute function public.integration_config_normalize_keys();

drop trigger if exists trg_integration_delivery_log_normalize on public.integration_delivery_log;
create trigger trg_integration_delivery_log_normalize
  before insert or update on public.integration_delivery_log
  for each row execute function public.integration_delivery_log_normalize();

drop trigger if exists trg_external_id_map_normalize on public.external_id_map;
create trigger trg_external_id_map_normalize
  before insert or update on public.external_id_map
  for each row execute function public.external_id_map_normalize();

drop trigger if exists trg_integration_sync_state_normalize on public.integration_sync_state;
create trigger trg_integration_sync_state_normalize
  before insert or update on public.integration_sync_state
  for each row execute function public.integration_sync_state_normalize();

create unique index if not exists idx_integration_config_tenant_connector
  on public.integration_config (tenant_id, connector_key);

create unique index if not exists idx_integration_config_tenant_provider_key
  on public.integration_config (tenant_id, provider_key);

create unique index if not exists idx_integration_delivery_log_dedupe
  on public.integration_delivery_log (tenant_id, connector_key, direction, exchange_key, idempotency_key);

create unique index if not exists idx_integration_delivery_log_integration_dedupe
  on public.integration_delivery_log (integration_id, direction, idempotency_key);

create unique index if not exists idx_external_id_map_entity
  on public.external_id_map (tenant_id, connector_key, exchange_key, entity_type, entity_id);

create unique index if not exists idx_external_id_map_external
  on public.external_id_map (tenant_id, connector_key, exchange_key, external_id);

create unique index if not exists idx_external_id_map_wynne
  on public.external_id_map (tenant_id, provider, entity_type, wynne_entity_id, external_system)
  where wynne_entity_id is not null;

create unique index if not exists idx_external_id_map_provider_external
  on public.external_id_map (tenant_id, provider, entity_type, external_id, external_system);

create unique index if not exists idx_integration_sync_state_scope
  on public.integration_sync_state (tenant_id, connector_key, exchange_key, scope_key);

create unique index if not exists idx_integration_sync_state_integration_scope
  on public.integration_sync_state (integration_id, scope_key);

create index if not exists idx_integration_delivery_log_scope
  on public.integration_delivery_log (tenant_id, connector_key, exchange_key, scope_key, created_at desc);

create index if not exists idx_integration_delivery_log_provider_delivery
  on public.integration_delivery_log (tenant_id, connector_key, provider_delivery_id);

create index if not exists idx_integration_delivery_log_integration
  on public.integration_delivery_log (integration_id, direction, status);

create index if not exists idx_external_id_map_lookup
  on public.external_id_map (tenant_id, connector_key, exchange_key, entity_type, entity_id);

create index if not exists idx_external_id_map_provider_lookup
  on public.external_id_map (tenant_id, provider, entity_type, external_system, external_id);

create index if not exists idx_integration_sync_state_lookup
  on public.integration_sync_state (tenant_id, connector_key, exchange_key, scope_key);

create index if not exists idx_integration_sync_state_integration
  on public.integration_sync_state (integration_id);

revoke all on table public.integration_config from anon, authenticated;
grant select, insert, update on table public.integration_config to authenticated;
grant select, insert, update, delete on table public.integration_config to service_role;

revoke all on table public.integration_delivery_log from anon, authenticated;
grant select, insert, update on table public.integration_delivery_log to authenticated;
grant select, insert, update, delete on table public.integration_delivery_log to service_role;

revoke all on table public.external_id_map from anon, authenticated;
grant select, insert, update on table public.external_id_map to authenticated;
grant select, insert, update, delete on table public.external_id_map to service_role;

revoke all on table public.integration_sync_state from anon, authenticated;
grant select, insert, update on table public.integration_sync_state to authenticated;
grant select, insert, update, delete on table public.integration_sync_state to service_role;

alter table public.integration_config enable row level security;
alter table public.integration_delivery_log enable row level security;
alter table public.external_id_map enable row level security;
alter table public.integration_sync_state enable row level security;

do $$
declare
  v_table text;
  v_policy_read text;
  v_policy_insert text;
  v_policy_update text;
  v_policy_service text;
  v_tables constant text[] := array[
    'integration_config',
    'integration_delivery_log',
    'external_id_map',
    'integration_sync_state'
  ];
begin
  foreach v_table in array v_tables loop
    v_policy_read := format('%s_authenticated_read', v_table);
    v_policy_insert := format('%s_authenticated_insert', v_table);
    v_policy_update := format('%s_authenticated_update', v_table);
    v_policy_service := format('%s_service_role_all', v_table);

    execute format('drop policy if exists %I on public.%I', v_policy_read, v_table);
    execute format('drop policy if exists %I on public.%I', v_policy_insert, v_table);
    execute format('drop policy if exists %I on public.%I', v_policy_update, v_table);
    execute format('drop policy if exists %I on public.%I', v_policy_service, v_table);

    execute format(
      $policy$
      create policy %2$I
        on public.%1$I
        for select
        to authenticated
        using (
          public.ops_claim_app_role() in ('admin', 'branch_manager')
          and public.ops_tenant_match(tenant_id)
        )
      $policy$,
      v_table,
      v_policy_read
    );

    execute format(
      $policy$
      create policy %2$I
        on public.%1$I
        for insert
        to authenticated
        with check (
          public.ops_claim_app_role() in ('admin', 'branch_manager')
          and public.ops_tenant_match(tenant_id)
        )
      $policy$,
      v_table,
      v_policy_insert
    );

    execute format(
      $policy$
      create policy %2$I
        on public.%1$I
        for update
        to authenticated
        using (
          public.ops_claim_app_role() in ('admin', 'branch_manager')
          and public.ops_tenant_match(tenant_id)
        )
        with check (
          public.ops_claim_app_role() in ('admin', 'branch_manager')
          and public.ops_tenant_match(tenant_id)
        )
      $policy$,
      v_table,
      v_policy_update
    );

    execute format(
      $policy$
      create policy %2$I
        on public.%1$I
        for all
        to service_role
        using (true)
        with check (true)
      $policy$,
      v_table,
      v_policy_service
    );
  end loop;
end;
$$;
