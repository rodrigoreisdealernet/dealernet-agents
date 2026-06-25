# ADR-0009: Queue/state label work-routing model

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect

## Context
If every agent independently scans the whole repo, they produce overlapping and conflicting work (duplicate reviews, competing assignments). The factory needs explicit, low-coordination routing between roles.

## Decision
Work is routed by **labels**. One `queue:*` label assigns ownership (`product`, `architecture`, `development`, `review`, `qa`, `security`, `database`, `platform`, `release`, `ops`, `docs`); one **state** label marks lifecycle (`needs-triage`, `needs-design`, `ready-for-dev`, `assigned-to-copilot`, `ready-for-review`, …); `risk:*`, `priority:*`, and specialist `needs-*-review` labels add gates. Specialists act only on their queue; only broad agents (Product Owner, Project Manager, Actions Monitor) scan widely. Epics link to stories via `Part of #N`.

## Consequences
- Predictable handoffs; no work duplication; no need for SDK personas to be real GitHub users.
- A `ready-for-dev` issue with no blocking `needs-*` label is the only thing the PM assigns to Copilot — the readiness gate.
- An unlabeled issue is invisible to specialists; the Product Owner must catch orphans.

## Alternatives considered
- **Free-form discovery** — rejected: agent spam, conflicts.
- **Central work queue/coordinator** — rejected: bottleneck.

## Evidence
- `docs/specs/software-creation-factory.md` (routing & handoff model, full label taxonomy)
- Live labels verified via `gh label list` (all queue/state/risk/priority/specialist labels exist)
- `.github/copilot-instructions.md` (ticket-readiness gate); `.github/workflows/pr-enrichment.yml` (auto risk/specialist labels)
