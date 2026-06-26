# Spec — Redesenhar Painel de Agentes como console de observabilidade (Issue #95)

## Overview
Redesign the **Agents Dashboard** (`agents-dashboard`) from a basic 4-KPI + agent-card view into a production-grade **observability console**. The change is presentation-only: it reads the existing `ops_agent_status_view` and `ops_finding_kpis` data (via `getAgentStatus` / `getFindingKpis`) and presents agent health, prioritization, and clear loading/error/empty states using existing design-system components.

## Problem / Context
Operators today cannot tell at a glance which agents are healthy, failing, or need attention. The screen shows runs as raw text (`12 (10✓/2✗)`), surfaces no success-rate or health indicator, lists agents in a fixed order, and renders only plain "loading…" text with no skeletons. The "Executar agora" action and the 10s polling can make the UI flicker or feel unresponsive. All the data needed for health (success/fail counts, last-run status/time, pending findings, enabled flag) already exists in the read-only views, and the design system already ships `KpiCard`, `TrendBadge`, `Sparkline`, `ProgressBar`, and `Badge`. This is a UX/observability gap, not a data gap.

## Acceptance Criteria
- [ ] **Scannable agent health.** Each agent card shows its success rate (succeeded ÷ total runs), the failure count emphasized when greater than zero, the last-run status and timestamp, and a single visual health indicator (badge/color) classifying the agent as **healthy / attention / failing**.
- [ ] **Disabled agents are explicit.** An agent that is not enabled is visually marked as disabled, and its "Executar agora" action is unavailable for it.
- [ ] **Useful ordering/prioritization.** The agent list is ordered so that agents needing attention surface first (e.g., agents with a recent failure or with pending findings appear before healthy/idle ones), and this ordering is observable in the rendered list.
- [ ] **Loading, error, and empty states.** The screen renders dedicated loading (skeleton/placeholder rather than plain text), error, and empty states, and the 10s refresh does not blank the screen, cause flicker, or drop user clicks.
- [ ] **Clear "Executar agora" feedback.** Triggering a run shows distinct running / success / error feedback for that agent without freezing the rest of the UI, and an error message is surfaced to the user.
- [ ] **Production KPI hierarchy.** The top KPIs present a clear label + value hierarchy (with an optional micro-trend/variation indicator where data is available) while preserving the existing "Valores em R$" legend.
- [ ] **Verification + build.** A `frontend-portal/scripts/verify-*.mjs` script asserts the new screen's source contains the health, state-handling, and ordering behavior, and `npm run build` passes.

## Non-Goals
- Adding, changing, or migrating any backend tables, views, or APIs — the screen remains read-only over `ops_agent_status_view` and `ops_finding_kpis`.
- Introducing new historical/time-series data; per-agent and KPI history do not exist in the current views, so any "trend/sparkline" is best-effort using already-available fields and may be omitted where no data supports it.
- Changing what clicking an agent does — it continues to open the findings queue filtered by that agent.
- Adding new color tokens or hardcoded colors; only existing `tokens.css` / `ui.tsx` design-system primitives are used.

## Out-of-Scope
- The findings queue itself (epic story S3) and the finding detail view (S4).
- Any change to `runAgentNow` execution semantics on the Ops API beyond surfacing its existing result states.
- Internationalization changes beyond strings required by the new states/labels on this screen.
