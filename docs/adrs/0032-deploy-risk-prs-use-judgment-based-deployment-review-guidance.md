# ADR-0032: Deploy-risk PRs use judgment-based deployment-review guidance in the existing reviewer handoff

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Repository owner, PR Handler, Tech Reviewer
- **Supersedes / Superseded by:** —

## Context
Deploy regressions were still reaching merge despite the existing escalated reviewer flow,
because the reviewer prompts did not explicitly tell that reviewer to read deploy-risk
changes through a "will this actually deploy and run?" lens.

The affected contract is control-plane behavior in the existing reviewer personas under
`.github/agents/`. The requested scope is deliberately narrow: preserve the current
handoff, keep review judgment-based, and avoid adding a new reviewer lane, merge gate, or
runtime-heavy static-check harness.

## Decision
Deploy-risk pull requests keep the existing reviewer handoff. When a PR touches
`temporal/src/**`, `charts/**/values*.yaml`, `deploy/k8s/**`, or `supabase/seed.sql`, the
escalated reviewer applies concise, judgment-based deployment-review guidance in
`pr-handler.agent.md`, mirrored in `tech-reviewer.agent.md`.

That guidance is advisory rather than a new lane or gate: reviewers watch for likely
runtime/deploy failures (for example worker boot risks, unresolved env/service/secret
wiring, missing RBAC verbs/resources, digest-promotion drift, or broken seed invariants)
and raise normal review feedback when they see a concrete concern.

## Consequences
- Deploy-risk review gets a clearer runtime lens without changing routing, personas, or
  approval flow.
- The factory keeps relying on reviewer judgment instead of a prescribed battery of static
  checks.
- The prompt contract and its ADR/index entry must stay in sync so control-plane behavior
  changes remain reviewable.

## Alternatives considered
- **Add a new deployment-review lane or merge gate:** rejected — the goal is to improve the
  existing reviewer behavior, not expand the factory workflow.
- **Mandate static worker/chart/RBAC checks:** rejected — that over-prescribes the review
  and exceeds the intentionally de-scoped, guidance-first requirement.

## Evidence
- `.github/agents/pr-handler.agent.md`
- `.github/agents/tech-reviewer.agent.md`
- `temporal/tests/test_deployment_review_guidance.py`
