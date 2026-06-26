# Spec — #115: Revalidate `service-estimate-rescue` end-to-end & fix HTTP 409 on "Executar agora"

## Overview
The DIA ops agent **service-estimate-rescue** cannot be run on demand from the portal: clicking **"Executar agora"** returns `HTTP 409 — "Agent service-estimate-rescue is disabled or schedule not provisioned"`. This change makes the manual "run now" action start the agent's workflow directly for every DIA agent (not just the four currently hard-mapped), so an operator can trigger an immediate run regardless of whether a recurring schedule is provisioned, while keeping the agent's recurring schedule disabled (assist-only, off by default).

## Problem / Context
- In `temporal/src/ops_api/app.py`, `run_agent_now` only maps four agents (`revrec-analyst`, `vehicle-aging-analyst`, `credit-analyst`, `disposition-queue`) to a direct workflow start. For any other agent it falls back to `schedule.trigger()`.
- For `service-estimate-rescue` the schedule was seeded **disabled** (`supabase/seed.sql`) and the worker deletes disabled schedules, so the handle resolves to `NOT_FOUND` → `AgentScheduleNotProvisioned` → the endpoint returns **409**.
- The agent itself is healthy: `ServiceEstimateRescueWorkflow` exists and runs the full scope → assess → dedupe → record-findings pipeline, producing `pending_approval` findings. Its input `ServiceEstimateRescueWorkflowInput` requires only `tenant_id` (it does **not** accept `locale`).
- Operators need to validate and use this agent end-to-end (run → findings appear in the ops review queue → approve/reject) without enabling an always-on schedule, since the agent is assist-only and off by default.

## Acceptance Criteria
- [ ] Clicking **"Executar agora"** for `service-estimate-rescue` from the portal triggers an immediate run and returns a success response (HTTP 202 Accepted) instead of HTTP 409.
- [ ] A manual run starts the agent's workflow directly even when the agent's recurring schedule is not provisioned/disabled; the response identifies the started run (e.g. a workflow/run identifier and a "started" status).
- [ ] After a manual run that scopes eligible estimates, resulting findings are recorded as **`pending_approval`** and become visible in the ops findings review queue for the operator's tenant.
- [ ] Triggering `service-estimate-rescue` does **not** enable or re-provision its recurring schedule — it remains disabled (assist-only, off by default) before and after the manual run.
- [ ] Agents that already have a registered manual-run workflow (`revrec-analyst`, `vehicle-aging-analyst`, `credit-analyst`, `disposition-queue`) continue to run on demand exactly as before, with no regression.
- [ ] Requesting a manual run for an unknown `agent_key` still returns HTTP 404, and an agent that has neither a registered workflow nor a provisioned schedule still surfaces a clear, non-misleading error.

## Non-Goals
- Enabling, scheduling, or otherwise turning on the recurring/automatic execution of `service-estimate-rescue`.
- Adding auto-apply behavior — all findings remain human-approved (`pending_approval`); the agent stays assist-only.
- Changing the `service-estimate-rescue` workflow logic, its inputs (still `tenant_id`-only), or its findings/dedupe behavior.
- Adding a `locale` parameter to `ServiceEstimateRescueWorkflowInput`.

## Out-of-Scope
- Reworking the recurring-schedule provisioning/seed lifecycle for ops agents generally.
- UI/UX redesign of the "Executar agora" control or the findings review queue.
- Onboarding or re-validating other DIA agents beyond confirming no regression to the existing direct-start agents.
- The underlying LLM assessment quality of the service-estimate rescue recommendations.

---

**STATUS: DRAFT — requires human approval before any code is written.**
