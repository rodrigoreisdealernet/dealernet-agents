-- Coupa procurement connector registration (Story #1143).
-- Registers `coupa` in the shared integration_config contract (ADR-0037).
-- Supported scopes: requisitions, purchase_orders, suppliers, invoices.
-- Non-secret config lives in settings/mappings; credentials stay in secret_refs only.
-- Tenant audit events are emitted via the shared integration_config_audit_trigger.

comment on table public.integration_config is
  'Tenant-scoped non-secret connector configuration. '
  'Supported connector_key values include: descartes, samsara, billtrust, sage_intacct, coupa. '
  'Secret values are stored only as opaque references in the secret_refs column.';

create index if not exists idx_integration_config_coupa_tenant
  on public.integration_config (tenant_id)
  where connector_key = 'coupa';
