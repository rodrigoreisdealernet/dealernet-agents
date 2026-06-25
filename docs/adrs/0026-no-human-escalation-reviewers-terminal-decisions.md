# ADR-0026: Factory reviewers reach terminal decisions in-lane — no human escalation, even for control-plane PRs

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Repository owner (ianreay); applies to tech-reviewer, security-reviewer, project-manager agents
- **Supersedes / Superseded by:** Complements the 2026-06-07 removal of the `requires-maintainer-review` human merge gate.

## Context
The human merge gate (`requires-maintainer-review`) was removed on 2026-06-07 so the factory merges autonomously. But a **residual human gate survived for the factory's own control-plane PRs** (changes to `.github/**`, `CODEOWNERS`, reviewer-agent policy), which are exactly the PRs that trip the "needs an Accepted ADR" rule:

- The **Tech Reviewer** would only flip an **existing `Proposed`** ADR to `Accepted`; it had no instruction to author a **missing** one — so it blocked.
- The **Factory Architect** (the agent that writes ADRs) only processes **issues, never PRs**, by design.
- The **Project Manager** codified this as "the deadlock case → escalate to the **human owner** and stop."

Result: control-plane / self-improvement PRs (e.g. #281) sat open indefinitely, security-reviewed and CI-green, waiting on a human who, by the owner's direction, is not part of the loop. The factory structurally could not evolve its own control plane.

## Decision
There is **no human escalation in the merge path**. Every review lane reaches a **terminal decision in-lane** on every run:

1. **Reviewers author the ADR when one is required and missing.** For a control-plane/architecture PR that needs an ADR and has none, the owning reviewer — **Tech Reviewer** for engineering/architecture boundaries, **Security Reviewer** for security boundaries — authors a minimal ADR from `docs/adrs/TEMPLATE.md`, marks it `Status: Accepted` with a one-line decision note, references it, removes `needs-adr`, and approves. Existing `Proposed` ADRs are accepted in-lane as before. Reviewers never route PR design to the Factory Architect and never escalate to a human.
2. **A missing linked issue is not a merge blocker.** Create and link a tracking issue if useful, but never wedge an otherwise-sound PR on the absence of `closingIssuesReferences`.
3. **Security boundary stays gated on an agent, not a human.** The Security Reviewer owns it via `security-reviewed`. A committed real **secret value** is a code-fix request (remove it / move to a secret store), which Copilot can action — not a human gate.

## Consequences
- The factory can evolve its **own** control plane (workflows, CODEOWNERS, reviewer contracts) autonomously — no PR waits on a human.
- The "Escalations / human must act" concept is removed from the Project Manager; deadlocks are instead routed to the owning reviewer, who must resolve them.
- **Trade-off / risk:** an agent could, in principle, weaken a guardrail and self-accept it. Mitigations: the Security Reviewer independently owns the security boundary (`security-reviewed` is still required before a security-sensitive PR merges), and the whole-repo architecture audit (#281) runs report-only as a standing detector.

## Alternatives considered
- *Let the Factory Architect service PRs* — rejected: it would blur its issue-decomposition role and the contracts already warn it "will never service a PR."
- *Keep escalating to a human* — rejected: this is the exact gate the owner directed be removed; it wedged the factory's self-improvement PRs for hours.

## Evidence
- Agent contracts: `.github/agents/tech-reviewer.agent.md`, `.github/agents/security-reviewer.agent.md`, `.github/agents/project-manager.agent.md`.
- Deadlocked PR that motivated this: #281 (control-plane change, security-reviewed + platform-reviewed + CI-green, blocked solely on a missing ADR + linked issue).
