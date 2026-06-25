-- Samsara telematics connector registration.
-- Registers the `samsara` connector_key in the shared integration framework (ADR-0037).
-- Supported scopes: gps, hours, eld, dashcam_events.
-- Configuration is stored in the shared integration_config table created by prior migrations.
-- Secret references are stored in secret_refs; raw credentials are never written to Postgres.
-- The shared audit trigger (integration_config_audit_trigger) captures all configuration
-- changes automatically; no additional trigger setup is required for this provider.

comment on table public.integration_config is
  'Tenant-scoped non-secret connector configuration. '
  'Supported connector_key values include: descartes, samsara. '
  'Secret values are stored only as opaque references in the secret_refs column.';

create index if not exists idx_integration_config_samsara_tenant
  on public.integration_config (tenant_id)
  where connector_key = 'samsara';
