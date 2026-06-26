-- Issue #72 — allow the vehicle-aging worker to retire out-of-scope findings.
--
-- On a reseed, vehicle entities get new UUIDs, so vehicle-aging findings from a
-- previous run keep an old fingerprint and never dedupe against the new run;
-- they remain status='pending_approval' forever and inflate the Morning Queue.
--
-- The worker reconciles scope by marking such findings 'superseded' instead of
-- deleting them, preserving the audit trail. 'superseded' is a terminal,
-- non-pending status: the portal queue filters status='pending_approval' (see
-- frontend-portal getFindings) and ops_findings_view / ops_agent_status_view
-- only count/aggregate 'pending_approval' (+ 'approved' for recoverable_delta),
-- so superseded findings drop out of every operator surface without churn.
--
-- Extend finding_status_chk to accept 'superseded' (forward-compatible: the
-- previous four values stay valid).

alter table public.finding
  drop constraint if exists finding_status_chk;

alter table public.finding
  add constraint finding_status_chk
  check (status in ('pending_approval', 'approved', 'rejected', 'informational', 'superseded'));
