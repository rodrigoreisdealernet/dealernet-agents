# Spec — feat(ops): próxima execução real dos agentes DIA no dashboard [U1]

**Issue:** #124
**Unit:** U1 (foundation / pilot)
**Status:** APPROVED (via `/ship-issue 124 --approved`)
**Reference:** aidlc-docs/inception/requirements/design-spec.md §3 RF-2

## Overview

The Agents (DIA) operations dashboard should show, for each of the four DIA
agents, the **real next execution time** derived from that agent's scheduled
cron — not a static placeholder. Today the dashboard does not display a next-run
value at all, and the underlying data field is read from a static field rather
than computed from the cron. This change makes the dashboard surface a truthful
"next run" so operators can trust when each agent will run again.

## Problem / Context

The four DIA agents (`vehicle-aging-analyst`, `collections-prioritizer`,
`parts-inventory-advisor`, `service-estimate-rescue`) run as Temporal Schedules
configured from `ops_agent_config.schedule.cron`.

- `ops_agent_status_view.next_run_at` is currently derived from a **static**
  `schedule ->> 'next_run_at'` value, so it does not reflect the agent's actual
  cron and goes stale.
- The worker reconciliation loop already calls `schedule_handle.describe()` (which
  exposes the schedule's real upcoming fire times) but **never persists** that
  information back to the agent config.
- The frontend (`agentsApi.ts`) already carries `next_run_at` in its type and
  query, but `AgentsDashboard.tsx` **does not render it**.

Net effect: operators cannot see a reliable "next execution" for any DIA agent.

## Acceptance Criteria

- [ ] **AC1 — Next run is visible per agent.** On the Agents dashboard, each of
  the four DIA agents displays a "Próxima execução / Next run" value alongside
  its existing "Último run / Last run" line, plus a human-readable cadence
  (e.g. "dias úteis às 06:00" / "weekdays at 06:00").
- [ ] **AC2 — Value is cron-derived, not static.** The displayed next run is
  computed from the agent's configured cron schedule (as reported by the Temporal
  Schedule's `next_action_times`), so for an agent enabled with cron
  `0 6 * * 1-5` the dashboard shows a coherent next execution date/time.
- [ ] **AC3 — Persisted by the worker.** During reconciliation (and after
  `run_now`), the worker captures the schedule's real next fire time from
  `schedule_handle.describe()` (`desc.info.next_action_times[0]`) and persists it
  into `ops_agent_config.schedule.next_run_at` via PostgREST PATCH, so the view
  and dashboard reflect it on refresh.
- [ ] **AC4 — Disabled / unscheduled agents are unambiguous.** When an agent is
  disabled, paused, or has no valid cron, the dashboard shows a clear
  "sem execução agendada" / "no scheduled run" state instead of a stale or
  misleading time.
- [ ] **AC5 — Robust fallback, no breakage.** If Temporal / `next_action_times`
  is unavailable, the system does not break: it degrades to empty or uses a pure
  Python 5-field cron next-occurrence calculation as a fallback (no heavy new
  dependency; `croniter` would require an ADR). A `null` next-run never breaks
  the view.
- [ ] **AC6 — Localized, no regressions.** The next-run label/value and cadence
  are localized in pt-BR and en-US via `use-intl` (never a raw key), rendered
  with the existing date/time formatting; the other dashboard columns (health,
  rate, runs, delta, last run) are unchanged.

## Non-Goals

- Editing or configuring an agent's cron from the UI.
- Triggering, pausing, or resuming schedules from this feature (the existing
  "Run now" action is unchanged).
- Adding history or a list of multiple upcoming runs — only the single next run.
- Changing the agents that exist or their scheduling mechanism.

## Out-of-Scope

- Editing cron via UI (explicitly excluded by the issue).
- Changing the structure/contract of `ops_agent_status_view` (explicitly
  excluded by the issue). The next-run value must flow through the existing view
  field, not a schema redesign of the view.
- Legacy `frontend/` JSON-engine screens — only the real portal
  (`frontend-portal/`) is in scope.
