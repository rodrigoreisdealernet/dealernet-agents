-- Grant read access on ops_audit_trail_view and ops_findings_view to authenticated
-- and service_role so PostgREST can expose them via the REST API.
--
-- Both views were created in 20260607170000_ops_factory_persistence.sql (with
-- ops_audit_trail_view re-created in 20260614000000_ops_audit_trail_view_row_id.sql)
-- but neither received explicit SELECT grants, causing PostgREST to return 0 rows
-- silently for authenticated callers — the same symptom as an empty table.
-- See ops_agent_status_view in 20260607202000 for the established grant pattern.

grant select on public.ops_audit_trail_view to authenticated, service_role;
grant select on public.ops_findings_view to authenticated, service_role;
