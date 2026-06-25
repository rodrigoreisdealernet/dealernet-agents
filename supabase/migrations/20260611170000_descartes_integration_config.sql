-- Tenant-scoped connector configuration for shared integration framework.
-- First provider: Descartes (logistics route/shipment/compliance).

create table if not exists public.integration_config (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_key text not null,
  enabled boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  mappings jsonb not null default '{}'::jsonb,
  secret_refs jsonb not null default '{}'::jsonb,
  schedule jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_config_connector_key_chk check (connector_key ~ '^[a-z0-9_]+$'),
  constraint integration_config_settings_object_chk check (jsonb_typeof(settings) = 'object'),
  constraint integration_config_mappings_object_chk check (jsonb_typeof(mappings) = 'object'),
  constraint integration_config_secret_refs_object_chk check (jsonb_typeof(secret_refs) = 'object'),
  constraint integration_config_schedule_object_chk check (jsonb_typeof(schedule) = 'object')
);

alter table public.integration_config add column if not exists connector_key text;
alter table public.integration_config add column if not exists enabled boolean;
alter table public.integration_config add column if not exists settings jsonb;
alter table public.integration_config add column if not exists mappings jsonb;
alter table public.integration_config add column if not exists secret_refs jsonb;
alter table public.integration_config add column if not exists schedule jsonb;
alter table public.integration_config add column if not exists created_at timestamptz;
alter table public.integration_config add column if not exists updated_at timestamptz;
-- Compatibility backfill for branches that created integration_config with provider-specific columns.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'integration_config'
      and column_name = 'provider_key'
  ) then
    execute 'update public.integration_config
               set connector_key = provider_key
             where connector_key is null
               and provider_key is not null';
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'integration_config'
      and column_name = 'provider'
  ) then
    execute 'update public.integration_config
               set connector_key = lower(regexp_replace(provider, ''[^a-zA-Z0-9_]+'', ''_'', ''g''))
             where connector_key is null
               and nullif(btrim(provider), '''') is not null';
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'integration_config'
      and column_name = 'endpoint_base_url'
  ) then
    execute 'update public.integration_config
               set settings = settings || jsonb_build_object(''endpoint_base_url'', endpoint_base_url)
             where endpoint_base_url is not null';
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'integration_config'
      and column_name = 'enabled_scopes'
  ) then
    execute 'update public.integration_config
               set settings = settings || jsonb_build_object(''enabled_scopes'', enabled_scopes)
             where enabled_scopes is not null';
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'integration_config'
      and column_name = 'config'
  ) then
    execute 'update public.integration_config
               set mappings = mappings || config
             where config is not null';
  end if;
end;
$$;

update public.integration_config set enabled = true where enabled is null;
update public.integration_config set settings = '{}'::jsonb where settings is null;
update public.integration_config set mappings = '{}'::jsonb where mappings is null;
update public.integration_config set secret_refs = '{}'::jsonb where secret_refs is null;
update public.integration_config set schedule = '{}'::jsonb where schedule is null;
update public.integration_config set created_at = now() where created_at is null;
update public.integration_config set updated_at = now() where updated_at is null;

alter table public.integration_config alter column enabled set default true;
alter table public.integration_config alter column settings set default '{}'::jsonb;
alter table public.integration_config alter column mappings set default '{}'::jsonb;
alter table public.integration_config alter column secret_refs set default '{}'::jsonb;
alter table public.integration_config alter column schedule set default '{}'::jsonb;
alter table public.integration_config alter column created_at set default now();
alter table public.integration_config alter column updated_at set default now();

alter table public.integration_config alter column connector_key set not null;
alter table public.integration_config alter column enabled set not null;
alter table public.integration_config alter column settings set not null;
alter table public.integration_config alter column mappings set not null;
alter table public.integration_config alter column secret_refs set not null;
alter table public.integration_config alter column schedule set not null;
alter table public.integration_config alter column created_at set not null;
alter table public.integration_config alter column updated_at set not null;

alter table public.integration_config
  drop constraint if exists integration_config_connector_key_chk;
alter table public.integration_config
  add constraint integration_config_connector_key_chk
  check (connector_key ~ '^[a-z0-9_]+$');

alter table public.integration_config
  drop constraint if exists integration_config_settings_object_chk;
alter table public.integration_config
  add constraint integration_config_settings_object_chk
  check (jsonb_typeof(settings) = 'object');

alter table public.integration_config
  drop constraint if exists integration_config_mappings_object_chk;
alter table public.integration_config
  add constraint integration_config_mappings_object_chk
  check (jsonb_typeof(mappings) = 'object');

alter table public.integration_config
  drop constraint if exists integration_config_secret_refs_object_chk;
alter table public.integration_config
  add constraint integration_config_secret_refs_object_chk
  check (jsonb_typeof(secret_refs) = 'object');

alter table public.integration_config
  drop constraint if exists integration_config_schedule_object_chk;
alter table public.integration_config
  add constraint integration_config_schedule_object_chk
  check (jsonb_typeof(schedule) = 'object');

create unique index if not exists idx_integration_config_tenant_connector
  on public.integration_config (tenant_id, connector_key);

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'integration_config'
      and c.contype = 'p'
  ) then
    alter table public.integration_config
      add constraint integration_config_pk
      primary key using index idx_integration_config_tenant_connector;
  end if;
end;
$$;

create index if not exists idx_integration_config_tenant_connector_enabled
  on public.integration_config (tenant_id, connector_key, enabled);

drop trigger if exists trg_integration_config_updated_at on public.integration_config;
create trigger trg_integration_config_updated_at
  before update on public.integration_config
  for each row execute function update_updated_at();

revoke all on table public.integration_config from anon, authenticated;
grant select, insert, update on table public.integration_config to authenticated;
grant select, insert, update, delete on table public.integration_config to service_role;

alter table public.integration_config enable row level security;

drop policy if exists ops_integration_config_authenticated_read on public.integration_config;
drop policy if exists ops_integration_config_authenticated_write on public.integration_config;
drop policy if exists ops_integration_config_authenticated_write_update on public.integration_config;
drop policy if exists ops_integration_config_service_role_all on public.integration_config;

create policy ops_integration_config_authenticated_read
  on public.integration_config
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

create policy ops_integration_config_authenticated_write
  on public.integration_config
  for insert
  to authenticated
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

create policy ops_integration_config_authenticated_write_update
  on public.integration_config
  for update
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  )
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

create policy ops_integration_config_service_role_all
  on public.integration_config
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.integration_config_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connector_key text not null,
  action text not null,
  actor jsonb not null default '{}'::jsonb,
  changed_at timestamptz not null default now(),
  old_row jsonb,
  new_row jsonb,
  constraint integration_config_audit_action_chk check (action in ('insert', 'update', 'delete'))
);

alter table public.integration_config_audit add column if not exists connector_key text;
alter table public.integration_config_audit add column if not exists actor jsonb;
alter table public.integration_config_audit add column if not exists changed_at timestamptz;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'integration_config_audit'
      and column_name = 'provider_key'
  ) then
    execute 'update public.integration_config_audit
               set connector_key = provider_key
             where connector_key is null
               and provider_key is not null';
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'integration_config_audit'
      and column_name = 'provider'
  ) then
    execute 'update public.integration_config_audit
               set connector_key = lower(regexp_replace(provider, ''[^a-zA-Z0-9_]+'', ''_'', ''g''))
             where connector_key is null
               and nullif(btrim(provider), '''') is not null';
  end if;
end;
$$;

update public.integration_config_audit set actor = '{}'::jsonb where actor is null;
update public.integration_config_audit set changed_at = now() where changed_at is null;

alter table public.integration_config_audit alter column connector_key set not null;
alter table public.integration_config_audit alter column actor set default '{}'::jsonb;
alter table public.integration_config_audit alter column actor set not null;
alter table public.integration_config_audit alter column changed_at set default now();
alter table public.integration_config_audit alter column changed_at set not null;

create index if not exists idx_integration_config_audit_tenant_connector_changed
  on public.integration_config_audit (tenant_id, connector_key, changed_at desc);

revoke all on table public.integration_config_audit from anon, authenticated;
grant select on table public.integration_config_audit to authenticated;
grant select, insert on table public.integration_config_audit to service_role;

alter table public.integration_config_audit enable row level security;

drop policy if exists ops_integration_config_audit_authenticated_read on public.integration_config_audit;
drop policy if exists ops_integration_config_audit_service_role_all on public.integration_config_audit;

create policy ops_integration_config_audit_authenticated_read
  on public.integration_config_audit
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and public.ops_tenant_match(tenant_id)
  );

create policy ops_integration_config_audit_service_role_all
  on public.integration_config_audit
  for all
  to service_role
  using (true)
  with check (true);

create or replace function public.integration_claims_json()
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  v_claims_text text;
  v_claims_json jsonb;
begin
  v_claims_text := nullif(current_setting('request.jwt.claims', true), '');
  if v_claims_text is null then
    return '{}'::jsonb;
  end if;

  begin
    v_claims_json := v_claims_text::jsonb;
  exception
    when others then
      return '{}'::jsonb;
  end;
  return coalesce(v_claims_json, '{}'::jsonb);
end;
$$;

create or replace function public.integration_config_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_connector_key text;
begin
  v_tenant_id := coalesce(new.tenant_id, old.tenant_id);
  v_connector_key := coalesce(new.connector_key, old.connector_key);

  insert into public.integration_config_audit (
    tenant_id,
    connector_key,
    action,
    actor,
    old_row,
    new_row
  ) values (
    v_tenant_id,
    v_connector_key,
    lower(tg_op),
    public.integration_claims_json(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_integration_config_audit on public.integration_config;
create trigger trg_integration_config_audit
  after insert or update or delete on public.integration_config
  for each row execute function public.integration_config_audit_trigger();
