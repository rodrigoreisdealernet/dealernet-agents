-- Enforce one handoff draft per finding so workflow activity retries are idempotent.
create unique index if not exists uq_fleet_disposition_handoff_draft_finding_id
  on public.fleet_disposition_handoff_draft (finding_id);
