# ADR-0097: Portal intake demo URL resolution in e2e workflow

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Copilot (issue #2020 implementation)
- **Supersedes / Superseded by:** none

## Context

The portal intake e2e tests in `frontend/e2e/experience.spec.ts` are gated behind the `E2E_PORTAL_INTAKE_SCOPED_URL` environment variable. When that variable is not set the three tests are skipped via `test.skip()`, which the QA Manager counts as "red" (unexercised) expectations.

The root cause is that no mechanism existed to resolve a valid portal intake URL for use in the e2e workflow:

1. No demo intake token was seeded in `supabase/seed.sql`.
2. No Supabase RPC function (`portal_get_demo_intake_url`) existed to look up and return the URL for that token.
3. The `e2e-dev.yml` workflow had no step to call that function and export the result as `E2E_PORTAL_INTAKE_SCOPED_URL`.

The portal schedule journey already uses the identical pattern (`portal_get_demo_portal_url` RPC + "Resolve portal schedule demo URL" workflow step + `E2E_PORTAL_SCHEDULE_SCOPED_URL`).

## Decision

We extend the e2e pipeline to resolve a portal intake URL at workflow runtime using the same pattern already established for the schedule portal:

1. Seed one demo intake token (`wynne-demo-intake-token-001`) in `supabase/seed.sql`, idempotent via `ON CONFLICT (token_hash) DO UPDATE`.
2. Add a migration (`20260618120000_portal_demo_intake_url.sql`) that creates the `portal_get_demo_intake_url()` function, granted to `service_role` only.
3. Add a "Resolve portal intake demo URL" step in `.github/workflows/e2e-dev.yml` that calls the RPC and writes the result to `GITHUB_ENV` as `E2E_PORTAL_INTAKE_SCOPED_URL`.

The e2e workflow test run remains non-blocking (`|| true`); this change does not gate CI.

## Consequences

- The three portal intake e2e tests will run (rather than skip) in the e2e-dev workflow when `E2E_SUPABASE_SERVICE_KEY` is configured.
- The demo token is long-lived (`expires 9999-12-31`) and non-revocable in the seed, so the e2e URL will resolve consistently across resets.
- The `portal_get_demo_intake_url` function is only callable by `service_role`, limiting exposure.
- Any future rename of the demo token or the intake token table requires updating the seed, the migration function, and the workflow step.

## Alternatives considered

- **Hard-code the intake URL in the workflow:** Rejected — the URL embeds the token row's UUID primary key which changes on each `db reset`. A runtime RPC call is the only stable approach.
- **Generate the intake URL directly in the workflow using SQL:** Rejected — the schedule portal uses an RPC function; consistency with that pattern is preferable and keeps business logic server-side.
- **Modify the e2e tests to not require the env var:** Rejected — the tests intentionally skip when no scoped URL is available (protecting CI from false positives against a missing backend).

## Evidence

- `supabase/seed.sql`: demo intake token insert after portal contract scope token block.
- `supabase/migrations/20260618120000_portal_demo_intake_url.sql`: `portal_get_demo_intake_url()` function.
- `.github/workflows/e2e-dev.yml`: "Resolve portal intake demo URL" step mirroring lines ~260–283 (schedule step).
- Reference pattern: `supabase/migrations/20260610010100_crm_portal_contract_scope_tokens.sql` and the existing "Resolve portal schedule demo URL" step.
- Issue: Volaris-AI/wynne-lvl-3#2020.
