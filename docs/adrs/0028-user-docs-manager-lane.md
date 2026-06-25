# ADR-0028: User Docs Manager lane for proactive end-user coverage

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Tech Reviewer + maintainers (factory control-plane boundary)
- **Supersedes / Superseded by:** —

> **Status atual (2026-06-25):** this ADR records the accepted design, but its GitHub Actions implementation is currently parked in `.github/workflows.disabled/`. Only `.github/workflows/ci.yml` is active; the factory operates via local Claude Code skills (`/ship-issue`, `/ship-batch`) until an explicit reactivation.


## Context
PR #416 adds a new autonomous docs lane in the factory control plane under
`.github/**`: a new `user-docs-manager` agent, a prompt-boundary split from
`docs-improver`, and a new stage in `pipeline-daily`. This is a durable
ownership and scheduling boundary, so it must be recorded as an accepted ADR.

## Decision
We split documentation ownership into two explicit lanes:
1. **User Docs Manager** owns proactive end-user documentation coverage under
   `docs/user-guide/**` and creates/updates user-doc issues (not direct doc PRs).
2. **Docs Improver** remains limited to developer/factory docs drift and must
   ignore the `user-docs` lane.
3. **`pipeline-daily` runs both stages in order**: `docs-improver` first, then
   `user-docs-manager`.

## Consequences
- End-user guide coverage has a dedicated proactive owner instead of relying on
  repeated-review-feedback thresholds.
- Developer/factory docs drift remains in a separate lane, reducing overlap and
  duplicate issue creation.
- Daily pipeline behavior now has an explicit stage-order contract that should
  be preserved by tests/reviews when control-plane files change.

## Alternatives considered
- Fold end-user guide coverage into Docs Improver — rejected because Docs
  Improver is intentionally limited to repeated, evidence-backed dev/factory
  docs drift and
  would not reliably produce proactive user-guide coverage.

## Evidence
- PR #416.
- `.github/agents/user-docs-manager.agent.md`
- `.github/agents/docs-improver.agent.md`
- `.github/workflows/pipeline-daily.yml`
- `docs/architecture/software-factory.md`
