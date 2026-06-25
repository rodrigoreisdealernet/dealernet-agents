# ADR-0018: Real-environment E2E (Playwright) — gating smoke + non-gating experience tests

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** QA Manager, Factory Architect

> **Status atual (2026-06-25):** `e2e-dev.yml` is currently parked in `.github/workflows.disabled/`, so Playwright E2E does not run on a schedule or post-deploy automatically today. This ADR remains the target design for any future reactivation.


## Context
Unit/integration tests pass locally yet the deployed app can still fail — wrong Supabase URL, Kong unreachable, migrations not applied. We need tests that exercise the *deployed* environment, and a way to encode desired UX without blocking releases on taste.

## Decision
**Playwright E2E runs against the deployed dev app** (`E2E_BASE_URL`), not local Docker Compose, on a schedule and post-deploy. Two tiers:
- **Smoke (gating):** all routes render, no crash — must pass.
- **Experience (non-gating):** desired-UX expectations (e.g. dashboard shows KPIs) — allowed to fail; failures file improvement issues. The QA Manager reviews the live experience for real usefulness.

## Consequences
- Catches deployment-level regressions unit tests can't (it already caught the frontend pointing at a placeholder Supabase URL).
- E2E reliability depends on dev being healthy; if dev deploy is broken, smoke is noisy.
- Experience tests document intended UX in executable form without gating releases on it.
- Temporal tests run for real in CI (no more hidden failures) after pytest-asyncio was added.

## Alternatives considered
- **Unit/integration only** — rejected: misses deploy issues.
- **All experience tests gating** — rejected: blocks releases on UX preference.

## Evidence
- PR #139 (`c2af7e8`) real-environment E2E vs dev + experience-driven QA Manager; `383e312` exclude e2e from vitest unit run
- `frontend/e2e/smoke.spec.ts`, `frontend/e2e/experience.spec.ts`, `frontend/playwright.config.ts`; `.github/workflows/e2e-dev.yml`
- PR #63 (`fc0effa`) stop hiding temporal test failures + pytest-asyncio
- `.github/agents/qa-manager.agent.md`
