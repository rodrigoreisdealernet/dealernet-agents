-- Ensure frontend-facing views run with caller permissions so base-table RLS
-- remains authoritative for anon/authenticated access.

alter view if exists public.v_rental_order_current set (security_invoker = true);
alter view if exists public.v_rental_contract_current set (security_invoker = true);
alter view if exists public.v_rental_contract_line_current set (security_invoker = true);
alter view if exists public.v_current_assets set (security_invoker = true);
alter view if exists public.v_asset_downtime_history set (security_invoker = true);
alter view if exists public.v_branch_utilization set (security_invoker = true);
alter view if exists public.v_asset_latest_meter set (security_invoker = true);
alter view if exists public.rental_entity_type_catalog set (security_invoker = true);
alter view if exists public.rental_relationship_type_catalog set (security_invoker = true);
alter view if exists public.rental_current_entity_state set (security_invoker = true);
alter view if exists public.rental_current_branches set (security_invoker = true);
alter view if exists public.rental_current_customers set (security_invoker = true);
alter view if exists public.rental_current_billing_accounts set (security_invoker = true);
alter view if exists public.rental_current_contacts set (security_invoker = true);
alter view if exists public.rental_current_job_sites set (security_invoker = true);
alter view if exists public.rental_current_asset_categories set (security_invoker = true);
alter view if exists public.rental_current_relationships set (security_invoker = true);
alter view if exists public.rental_current_assets set (security_invoker = true);
alter view if exists public.rental_asset_availability_current set (security_invoker = true);
alter view if exists public.v_home_dashboard_kpis set (security_invoker = true);
