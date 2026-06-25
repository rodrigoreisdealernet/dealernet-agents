-- Sage Intacct accounting connector registration (ADR-0052).
-- Registers the `sage_intacct` connector_key in the shared integration framework (ADR-0037).
-- Pinned variant: Sage Intacct REST API with OAuth 2.0 client_credentials auth.
-- Supported scopes: general_ledger, accounts_payable, accounts_receivable, cash_management.
-- Configuration is stored in the shared integration_config table created by prior migrations.
-- Secret references (OAuth client_id, client_secret) are stored in secret_refs only;
-- raw credentials are never written to Postgres.
-- The shared audit trigger (integration_config_audit_trigger) captures all configuration
-- changes automatically; no additional trigger setup is required for this provider.

comment on table public.integration_config is
  'Tenant-scoped non-secret connector configuration. '
  'Supported connector_key values include: descartes, samsara, billtrust, sage_intacct. '
  'Secret values are stored only as opaque references in the secret_refs column.';

create index if not exists idx_integration_config_sage_intacct_tenant
  on public.integration_config (tenant_id)
  where connector_key = 'sage_intacct';
