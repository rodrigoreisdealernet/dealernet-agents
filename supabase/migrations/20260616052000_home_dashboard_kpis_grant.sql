-- Grant authenticated access to home dashboard KPI views
-- The v_home_dashboard_kpis view was created on 2026-06-06 without a
-- GRANT SELECT statement, so PostgREST returned a permission error for
-- authenticated users, causing all dashboard StatCard values to display
-- as zero.  ops_finding_kpis (security_invoker) had the same gap.
-- Fixes: #1856

revoke all on public.v_home_dashboard_kpis from anon;
grant select on public.v_home_dashboard_kpis to authenticated, service_role;

revoke all on public.ops_finding_kpis from anon;
grant select on public.ops_finding_kpis to authenticated, service_role;
