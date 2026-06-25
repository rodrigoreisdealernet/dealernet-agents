# ADR-0031: PR routing must stay in PR lanes; Database Steward owns DB sign-off; PM skips `needs-design` assignment

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Repository owner, Tech Reviewer, Project Manager
- **Supersedes / Superseded by:** Supersedes [ADR-0002](./0002-additive-migrations-tech-reviewer-owns.md) for migration sign-off ownership

## Context
PR enrichment and reviewer routing allowed a dead-letter path where PRs could be labeled
`needs-design` / `queue:architecture`, but architecture is an issue lane and does not service PRs.
That caused avoidable PR deadlocks. At the same time, contract language still reflected the older
ownership model from ADR-0002 where Tech Reviewer owned migration review. The active factory lane
model now includes Database Steward as the dedicated DB reviewer, and assignment rules also need to
prevent Copilot from being assigned to `needs-design` issues.

## Decision
We enforce three coupled control-plane rules:
1. **PRs must never be routed to `needs-design` or `queue:architecture`**; PR reviewers/handlers
   must produce terminal in-lane outcomes (`APPROVE` or `CHANGES_REQUESTED`).
2. **Database migration sign-off is owned by Database Steward** (`needs-database-review` lane), not
   Tech Reviewer.
3. **Project Manager must hard-skip Copilot assignment for any issue labeled `needs-design`.**

## Consequences
- PRs cannot dead-letter into architecture-only issue labels and must complete in review lanes.
- DB-review ownership is unambiguous and aligned with the Database Steward specialist lane.
- Copilot assignment avoids unresolved design-lane work, reducing churn and mis-assignment loops.
- Agent prompts and tests must keep these rules explicit to prevent regression.

## Alternatives considered
- **Allow PRs to defer to architecture labels:** rejected — architecture lane does not service PRs,
  so this is a dead-letter route.
- **Keep Tech Reviewer as DB sign-off owner:** rejected — conflicts with the dedicated
  Database Steward lane and creates split authority.
- **Allow PM assignment on `needs-design` issues with exceptions:** rejected — weakens the guard and
  reintroduces avoidable handoff churn.

## Evidence
- Agent prompt contracts:
  - `.github/agents/database-steward.agent.md`
  - `.github/agents/platform-engineer.agent.md`
  - `.github/agents/pr-handler.agent.md`
  - `.github/agents/tech-reviewer.agent.md`
  - `.github/agents/project-manager.agent.md`
- Prompt-contract regression tests:
  - `temporal/tests/test_pr_enrichment_workflow_logic.py` (dead-letter guard, DB owner, PM assignment guard assertions)
