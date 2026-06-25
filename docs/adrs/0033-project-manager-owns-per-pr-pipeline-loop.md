# ADR-0033: Project Manager owns the bounded per-PR pipeline loop; Tech Reviewer is the escalation reviewer

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Repository owner, Project Manager, Tech Reviewer
- **Supersedes / Superseded by:** Clarifies the PR-pipeline topology described in [ADR-0025](./0025-agent-cadence-pipelines.md); complements [ADR-0026](./0026-no-human-escalation-reviewers-terminal-decisions.md)

## Context

The old PR topology split ownership awkwardly:

- `run-pr-pipeline.ts` kept the correct **bounded fresh-session, oldest-first per-PR loop**, but
  the persona inside the loop was `pr-handler`.
- `project-manager.agent.md` still carried an older whole-queue PR sweep section, even though the
  runtime had to suppress it with a custom "PR queue already handled" prompt to avoid double work.
- `tech-reviewer.agent.md` existed, but no live workflow invoked it, so substantive engineering
  review was effectively folded into `pr-handler`.

That left the contracts confusing, kept review ownership blurry, and preserved a latent regression
where the Project Manager could drift back toward the monolithic whole-queue session that had
already ballooned to ~100k tokens and been killed mid-sweep before merging.

## Decision

We keep the **bounded per-PR fresh-session loop** from ADR-0025, but swap the active persona in
that loop from `pr-handler` to **Project Manager**. Project Manager now owns PR mechanics and merge
execution; **Tech Reviewer** is the active terminal reviewer for substantive `queue:review` work.

The merge carve-out stays intentionally narrow:
- Project Manager may merge directly only for trivially-safe PRs (docs-only, `.github`-only, or
  additive migration-only with green CI and an existing approval).
- All other substantive PRs are escalated to `queue:review`, where Tech Reviewer must return a
  terminal `APPROVED` / `CHANGES_REQUESTED` decision that Project Manager then consumes.

`pr-handler` is retired rather than kept as a parallel/live persona.

## Consequences

- The factory preserves the **fresh-session, oldest-first** safety property that fixed the original
  token blow-up failure mode.
- PR ownership becomes explicit: Project Manager handles mechanics, assignment, and merge; Tech
  Reviewer handles substantive engineering/code-scope review.
- Prompt/runtime/docs/test drift is reduced because the runtime no longer depends on a retired
  persona and the Tech Reviewer is once again a live lane.
- The Project Manager assignment guard remains mandatory: Copilot is never assigned to issues that
  still carry `needs-design` or `design-in-progress`.

## Alternatives considered

- **Keep `pr-handler` as the active per-PR persona:** rejected — it duplicates Project Manager
  mechanics and leaves Tech Reviewer dormant.
- **Move back to a monolithic Project Manager queue sweep:** rejected — this reintroduces the
  previously observed large-context timeout failure mode.
- **Let Project Manager do all substantive review inline:** rejected — it collapses review
  independence and widens the direct-merge carve-out beyond the explicitly safe cases.

## Evidence

- `.github/tools/shared/src/run-pr-pipeline.ts`
- `.github/agents/project-manager.agent.md`
- `.github/agents/tech-reviewer.agent.md`
- `.github/workflows/pipeline-fast.yml`
- `docs/architecture/ci-cd-pipelines.md`
- `docs/architecture/software-factory.md`
- `temporal/tests/test_pipeline_fast_workflow_contract.py`
- `temporal/tests/test_pr_enrichment_workflow_logic.py`
