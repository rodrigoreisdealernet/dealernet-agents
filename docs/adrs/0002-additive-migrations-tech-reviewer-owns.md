# ADR-0002: Additive-only migrations; Tech Reviewer owns migration review

- **Status:** Superseded by ADR-0031
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect, Tech Reviewer
- **Supersedes / Superseded by:** Superseded by [ADR-0031](./0031-pr-routing-db-signoff-and-needs-design-assignment-guard.md)

## Context
Schema changes ship continuously through the autonomous factory (ADR-0006), often authored by Copilot without a human in the loop. Destructive DDL (DROP, type-changing ALTER, truncation) risks irreversible data loss and breaks the application-first rollback model (ADR-0012). The factory has no dedicated Database Steward agent.

## Decision
Migrations must be **purely additive** (CREATE TABLE/INDEX/VIEW/FUNCTION, ALTER TABLE ADD COLUMN). The **Tech Reviewer owns migration review**: additive migrations are safe to approve; anything destructive is blocked, and migrations touching auth/RLS or payment data require a human (`requires-maintainer-review`).

## Consequences
- Rollbacks stay safe because old code keeps working against the new schema; deploys can roll back without a DB rollback.
- Columns/tables accumulate and need periodic, deliberate cleanup (a destructive op, gated on a human).
- No separate DB-reviewer role to maintain; one clear owner.
- Backward compatibility must be preserved across multi-stage rollouts (schema first, then code).

## Alternatives considered
- **Dedicated Database Steward agent** — proposed in the factory spec but not implemented; folded into Tech Reviewer.
- **Allow destructive migrations with automated recovery** — rejected: too risky for revenue data.

## Evidence
- `.github/agents/tech-reviewer.agent.md` §5 (migration review rules; removes `needs-database-review`)
- All files under `supabase/migrations/` are additive (verified — no DROP/destructive ALTER)
- `docs/specs/live-cluster-deploy-smoke-rollback.md` (rollback requires backward-compatible schema)
