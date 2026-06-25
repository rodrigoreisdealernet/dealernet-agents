# ADR-0006: Autonomous software factory via GitHub Actions + file-based agents

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Maintainer, Factory Architect

> **Status atual (2026-06-25):** this ADR records the accepted design, but its GitHub Actions implementation is currently parked in `.github/workflows.disabled/`. Only `.github/workflows/ci.yml` is active; the factory operates via local Claude Code skills (`/ship-issue`, `/ship-batch`) until an explicit reactivation.


## Context
The day-to-day work of shipping software — triage, design decomposition, assignment, review, QA, CI monitoring — is repetitive and high-volume. We want it run by agents continuously, with humans reserved for risky or ambiguous calls.

## Decision
We run an **autonomous software factory**: role-based agents (Product Owner, Factory Architect, Project Manager, Tech Reviewer, QA Manager, Actions Monitor) defined as Markdown files with YAML frontmatter in `.github/agents/`, executed by GitHub Actions on schedules/triggers via a shared TypeScript runtime (`@github/copilot-sdk`). Each agent is bounded per run, deduplicates its work, writes a run summary, and escalates risk to humans. The single-tenant factory keeps agent definitions **in repo files** (contrast the multi-tenant Operations Factory, ADR-0020, which stores config in the DB).

## Consequences
- Continuous, scheduled operation; agent prompts are versioned and reviewed as PRs.
- Bounded runs + serialized concurrency (`cancel-in-progress: false`) avoid churn and API throttling.
- Agent work-phase timeout is per-agent configurable (PR #101).
- Health depends on a monitoring agent (ADR is partly self-referential) and `MONITORING.md`.

## Alternatives considered
- **Manual engineering workflow** — rejected: the project's premise is autonomy.
- **One monolithic agent** — rejected: role separation gives clear authority and review boundaries.

## Evidence
- `docs/specs/software-creation-factory.md`; `.github/factory.yml`; `.github/agents/*.agent.md`; `.github/tools/shared/src/run-agent.ts`
- `.github/workflows/agent-*.yml`, `monitor-actions.yml`
- PR #59 (`ee665c9`) actions-monitor investigates failures; PR #101 (`50cee60`) per-agent timeout; PR #54 (`7025dd7`) project board sync
