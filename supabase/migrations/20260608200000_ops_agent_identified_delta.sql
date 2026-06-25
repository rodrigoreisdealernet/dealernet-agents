-- Expose per-agent identified_delta in ops_agent_status_view so the Operations
-- Dashboard can display the total revenue opportunity surfaced by each workflow
-- (e.g. "$4,420" for revrec-analyst). This is the sum of all finding deltas for
-- the agent regardless of status (pending / approved / rejected), representing
-- the gross identified discrepancy rather than only the recoverable remainder.

create or replace view public.ops_agent_status_view
with (security_invoker = true)
as
select
  c.tenant_id,
  c.agent_key,
  c.enabled,
  c.auto_apply,
  last_run.run_id as last_run_id,
  last_run.started_at as last_run_started_at,
  last_run.finished_at as last_run_finished_at,
  last_run.status as last_run_status,
  case
    when coalesce(c.schedule ->> 'next_run_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
      or coalesce(c.schedule ->> 'next_run_at', '') ~ '^\d{4}-\d{2}-\d{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?$'
      then (c.schedule ->> 'next_run_at')::timestamptz
    else null
  end as next_run_at,
  run_counts.total_runs,
  run_counts.succeeded_runs,
  run_counts.failed_runs,
  pending.pending_findings,
  (pending.pending_findings > 0) as has_pending_badge,
  identified.identified_delta
from public.ops_agent_config_current c
left join lateral (
  select
    r.run_id,
    r.started_at,
    r.finished_at,
    r.status
  from public.ops_workflow_run r
  where r.tenant_id = c.tenant_id
    and r.workflow_key = c.agent_key
  order by r.started_at desc nulls last
  limit 1
) as last_run on true
left join lateral (
  select
    count(*) as total_runs,
    count(*) filter (where r.status = 'succeeded') as succeeded_runs,
    count(*) filter (where r.status = 'failed') as failed_runs
  from public.ops_workflow_run r
  where r.tenant_id = c.tenant_id
    and r.workflow_key = c.agent_key
) as run_counts on true
left join lateral (
  select
    count(*) as pending_findings
  from public.finding f
  where f.tenant_id = c.tenant_id
    and f.agent_key = c.agent_key
    and f.status = 'pending_approval'
) as pending on true
left join lateral (
  select
    coalesce(sum(f.delta), 0) as identified_delta
  from public.finding f
  where f.tenant_id = c.tenant_id
    and f.agent_key = c.agent_key
) as identified on true;

revoke all on table public.ops_agent_status_view from anon;
grant select on table public.ops_agent_status_view to authenticated, service_role;
