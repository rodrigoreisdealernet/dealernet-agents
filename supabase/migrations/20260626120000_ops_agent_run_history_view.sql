-- Per-agent run history view (issue #128, unit U5 — observability).
-- Exposes one readable row per workflow run so the Operations Dashboard can show
-- the last N executions of each DIA agent: start, finish/duration, status and the
-- number of findings emitted by that run. Data already lives in
-- public.ops_workflow_run (the agent column is workflow_key) and public.finding
-- (joined by run_id); this view only reshapes it for read consumption.
--
-- security_invoker = true so the caller's tenant RLS on ops_workflow_run/finding
-- applies (each dealership sees only its own runs). The agent column is aliased
-- as agent_key for API consistency with the other ops agent surfaces.

create or replace view public.ops_agent_run_history_view
with (security_invoker = true)
as
select
  r.run_id,
  r.tenant_id,
  r.workflow_key as agent_key,
  r.started_at,
  r.finished_at,
  (r.finished_at - r.started_at) as duration,
  r.status,
  coalesce(fc.findings_emitted, 0) as findings_emitted
from public.ops_workflow_run r
left join lateral (
  select count(*) as findings_emitted
  from public.finding f
  where f.run_id = r.run_id
    and f.tenant_id = r.tenant_id
) as fc on true;

revoke all on table public.ops_agent_run_history_view from anon;
grant select on table public.ops_agent_run_history_view to authenticated, service_role;
