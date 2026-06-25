# ADR-0007: Copilot cloud agent implements; SDK agents orchestrate

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect

## Context
A single agentic system that both writes code and governs the pipeline has a conflict of interest — it would review and merge its own work. The factory (ADR-0006) needs a clean separation between authoring code and orchestrating the lifecycle.

## Decision
The **GitHub Copilot cloud agent** (`copilot-swe-agent[bot]`) is the implementation worker: the Project Manager assigns it `ready-for-dev` issues and it opens PRs. The **SDK agents** (ADR-0006) form the control plane: they triage, design, assign, review, QA, merge, and monitor — but never author feature code. Assignment uses GraphQL mutations for stable bot/repo IDs. Concurrency is capped at `max_open_copilot_prs: 3`.

## Consequences
- No agent reviews its own code; the Tech Reviewer is independent of the author.
- The factory must monitor Copilot PRs and nudge when stuck (documented failure modes in `MONITORING.md`, e.g. `action_required` CI, reassign-after-close).
- Copilot cadence/availability is external and org-dependent.

## Alternatives considered
- **SDK agent writes code directly** — rejected: weaker iteration/quality control and the self-review conflict.
- **Manual assignment** — rejected: not autonomous.

## Evidence
- `.github/factory.yml` (`max_open_copilot_prs: 3`); `.github/agents/project-manager.agent.md`
- `.github/copilot-instructions.md` (scope rules + ticket-readiness gate for Copilot PRs)
- `MONITORING.md` (Copilot PR failure modes and remedies)
