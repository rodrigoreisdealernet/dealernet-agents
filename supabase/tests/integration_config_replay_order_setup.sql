insert into public.tenants (id, tenant_key, name)
values ('11111111-1111-1111-1111-111111111111', 'tenant-replay', 'Tenant Replay')
on conflict (tenant_key) do update set name = excluded.name;

create table public.integration_config (
  tenant_id uuid not null,
  provider text,
  provider_key text,
  enabled boolean,
  endpoint_base_url text,
  enabled_scopes jsonb,
  config jsonb,
  secret_refs jsonb,
  schedule jsonb,
  created_at timestamptz,
  updated_at timestamptz
);

insert into public.integration_config (
  tenant_id,
  provider,
  provider_key,
  enabled,
  endpoint_base_url,
  enabled_scopes,
  config,
  secret_refs,
  schedule,
  created_at,
  updated_at
) values
(
  '11111111-1111-1111-1111-111111111111',
  null,
  'descartes_pk',
  true,
  'https://api.descartes.example',
  '["route"]'::jsonb,
  '{"route_mapping_profile":{"route_id_field":"routeNumber"}}'::jsonb,
  '{"auth_secret_ref":"secret://integrations/descartes/token-pk"}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
),
(
  '11111111-1111-1111-1111-111111111111',
  'Descartes Provider',
  null,
  true,
  'https://api.descartes.provider',
  '["shipment"]'::jsonb,
  '{"shipment_mapping_profile":{"shipment_id_field":"shipmentNumber"}}'::jsonb,
  '{"auth_secret_ref":"secret://integrations/descartes/token-provider"}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

create table public.integration_config_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  provider text,
  provider_key text,
  action text not null,
  old_row jsonb,
  new_row jsonb
);

insert into public.integration_config_audit (
  tenant_id,
  provider,
  provider_key,
  action,
  old_row,
  new_row
) values
(
  '11111111-1111-1111-1111-111111111111',
  null,
  'descartes_pk',
  'insert',
  null,
  '{}'::jsonb
),
(
  '11111111-1111-1111-1111-111111111111',
  'Descartes Provider',
  null,
  'update',
  '{}'::jsonb,
  '{}'::jsonb
);
