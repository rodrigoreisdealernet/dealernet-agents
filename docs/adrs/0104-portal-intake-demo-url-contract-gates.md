# ADR-0104: Portal intake demo URL contract gates

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Tech Reviewer
- **Supersedes / Superseded by:** none

## Context

PR #2243 changes two control-plane paths for the portal intake demo URL flow:

1. `.github/workflows/e2e-dev.yml` resolves `E2E_PORTAL_INTAKE_SCOPED_URL` through `portal_get_demo_intake_url()`.
2. `.github/workflows/pr-validation.yml` adds a reset-path validation job for the same RPC/seed contract.

ADR-0097 established the runtime resolution pattern, but it did not record how the workflow should react when the RPC returns an empty or malformed value, nor how that contract is kept green on pull requests. Without an explicit decision here, regressions in the seeded token, RPC grant, or workflow export shape can silently turn the portal-intake expectations back into skipped coverage.

## Decision

We fail closed when the configured portal-intake demo URL contract is broken, and we keep that contract under PR validation.

When `E2E_SUPABASE_SERVICE_KEY` is present, the `Resolve portal intake demo URL` step must require a non-empty `/portal/intake/<uuid>#token=<raw>` value before exporting `E2E_PORTAL_INTAKE_SCOPED_URL`. Pull requests also run a dedicated reset-path validation that proves the seed, RPC, and URL shape survive `supabase db reset`.

## Consequences

- The non-gating e2e workflow still skips resolution cleanly when the service key is absent, preserving ADR-0040's optional-secret behavior.
- When the service key is configured, broken demo-token seeding, broken `service_role` access, or malformed `GITHUB_ENV` exports fail loudly instead of silently degrading portal-intake coverage.
- The repository now has an explicit PR-time CI lane for this contract, which adds runtime but prevents the workflow-only regression gap that issue #2215 identified.

## Alternatives considered

- **Keep the workflow step best-effort:** Rejected because an empty or malformed intake URL would quietly re-skip the targeted experience coverage.
- **Rely only on the e2e-dev workflow runtime check:** Rejected because PRs need a deterministic validation lane before merge, not only a later environment run.
- **Add a text-only workflow fixture test instead of reset-path validation:** Rejected because the risk includes seeded data and RPC grants, not just YAML structure.

## Evidence

- `.github/workflows/e2e-dev.yml`
- `.github/workflows/pr-validation.yml`
- `supabase/tests/portal_demo_intake_url_reset.sql`
- `supabase/tests/run_portal_demo_intake_url_reset.sh`
- `supabase/tests/demo_baseline_seed.sql`
- PR: Volaris-AI/wynne-lvl-3#2243
- Issue: Volaris-AI/wynne-lvl-3#2215
