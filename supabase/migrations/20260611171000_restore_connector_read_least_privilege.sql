-- Keep shared connector config surfaces aligned with the operator control plane.

drop policy if exists ops_integration_config_authenticated_read on public.integration_config;
create policy ops_integration_config_authenticated_read
  on public.integration_config
  for select
  to authenticated
  using (
    coalesce(public.ops_claim_app_role(), '') in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );

drop policy if exists ops_integration_config_audit_authenticated_read on public.integration_config_audit;
create policy ops_integration_config_audit_authenticated_read
  on public.integration_config_audit
  for select
  to authenticated
  using (
    coalesce(public.ops_claim_app_role(), '') in ('admin', 'branch_manager')
    and public.ops_tenant_match(tenant_id)
  );
