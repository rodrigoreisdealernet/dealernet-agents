# ADR-0027: Standing whole-repo architecture audits + behavior-over-existence review

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Tech Reviewer (engineering/architecture boundary), per ADR-0026; security aspects cleared by Security Reviewer (`security-reviewed`)
- **Supersedes / Superseded by:** —

## Context
A 2026-06-07 architecture review found a class of defects the factory's review agents systematically miss, rooted in *how* they review:
1. **Diff-scoped + `gh`-only** — reviewers see one PR's diff, never the whole repo, and run nothing; cross-file wiring is invisible.
2. **Existence over behavior** — checks assert a policy/test *exists*, not that it *works*; inert policies and assertion-free tests pass CI.
3. **No standing audits** — everything is per-PR/additive; nothing reconciles code against ADRs or checks holistic posture.

This let real defects ship green: the inert role matrix (#234), four unrunnable Temporal workflows (#269), 21 RLS-bypassing views (#272), and `pull_request_target`+secrets in a workflow (#274).

## Decision
Add **executable, stdlib-only whole-repo audits** (`scripts/audit/`) for the three biggest blind spots — Temporal registration (#269), workflow security (#274), and view `security_invoker`/RLS-bypass (#272) — run by a **report-only** CI job (`architecture-audit.yml`, mirroring the non-gating experience-suite precedent; promote individual checks to `--strict` as their tracking issues close). Sharpen the **Security Reviewer** (standing posture sweep consulting the audit), **Database Steward** (verify the full `GRANT→RLS→policy→claim` chain with a *behavioral* RLS test), and **Tech Reviewer** (Temporal + frontend-engine rubrics; judge tests by behavior). Add a **`.github/CODEOWNERS`** control-plane gate so the factory can't silently rewrite its own governing workflows/agents (#277).

## Consequences
- The factory gains a standing detector for whole-repo/behavioral defects; running against `main` it surfaces the 40 known findings rather than missing them.
- Audits are **report-only**, so they don't block while the underlying defects (#234/#269/#272/#274) are still open — they produce a worklist. Each check flips to gating (`--strict`) once its issue closes.
- New obligation: the "Require review from Code Owners" branch-protection setting must be enabled on `main` to make CODEOWNERS enforcing (manual repo setting).
- Trade-off: report-only means a green CI can still carry known-but-tracked findings; accepted because gating them now would block all unrelated work.

## Alternatives considered
- *Gate immediately (`--strict`)* — rejected: would red-wall `main` on pre-existing, separately-tracked defects.
- *Give review agents repo-checkout + shell to run the audits directly* — deferred to a follow-up; this PR has them consult the CI audit summary.

## Evidence
- `scripts/audit/{run_audits,check_temporal_registration,check_workflow_security,check_view_security_invoker}.py`, `.github/workflows/architecture-audit.yml`, `temporal/tests/test_architecture_audit.py` (7 tests), `.github/CODEOWNERS`, and the sharpened `.github/agents/{security-reviewer,database-steward,tech-reviewer}.agent.md`. Introduced in PR #281.
