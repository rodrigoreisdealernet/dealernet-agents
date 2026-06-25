# ADR-0072: Project compliance readiness reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** Copilot (issue #1551, PR #1529)
- **Supersedes / Superseded by:** none

## Context

PR #1529 merged `supabase/migrations/20260613212000_project_compliance_readiness_tracking.sql`,
which adds:

- `project_assignment_readiness_audit` — append-only audit trail table with RLS
  enabled, used by the assignment gate to record blocked and committed events.
- `v_project_equipment_readiness_current` — `security_invoker = true` view that
  projects current assignment readiness state per project.
- `project_get_required_readiness(...)` — RPC that resolves certification
  requirements through the `inherited_project` relationship chain.
- `project_evaluate_assignment_readiness(...)` — RPC that evaluates whether a
  specific asset satisfies all active certification requirements for a project,
  returning explicit blocker codes (`missing_equipment_certification`,
  `expired_equipment_certification`) for any gap.
- `project_assign_asset_with_readiness_check(...)` — blocking assignment gate
  RPC that either commits a `project_has_asset` relationship and an
  `assignment_committed` audit row, or writes an `assignment_blocked` audit row
  and returns the failure reason.

The PR shipped behavioral SQL coverage but without a `supabase db reset`
guardrail.  Issue #1551 identified the gap: no automated proof existed that the
migration chain, requirement-inheritance resolver, certification RLS, and audit
table survive a fresh `supabase db reset --config supabase/config.toml` (full
migrations + seed rebuild).  A regression in an earlier migration — or a change
to the `rental_entity_type_catalog` view, the relationship contract tables, or
the certification seed data — could silently break the compliance gate on a
fresh rebuild while leaving already-evolved development databases unaffected.

## Decision

We add a `supabase-project-compliance-readiness-reset` job to
`pr-validation.yml` that runs
`bash supabase/tests/run_project_compliance_readiness_tracking_reset.sh` on
every PR, and wire the result into the `validation-summary` required gate.

The SQL harness (`supabase/tests/project_compliance_readiness_tracking_reset.sql`)
confirms after a clean reset that:

1. `project_assignment_readiness_audit` table exists with RLS enabled.
2. `v_project_equipment_readiness_current` view exists and is queryable.
3. Both RPCs (`project_evaluate_assignment_readiness`,
   `project_assign_asset_with_readiness_check`) are present and callable.
4. Requirement inheritance resolves to `inherited_project` source via the
   rebuilt schema.
5. Missing-cert and expired-cert assignments are blocked with the correct
   blocker codes and write `assignment_blocked` audit rows.
6. A compliant assignment commits a `project_has_asset` relationship and an
   `assignment_committed` audit row.
7. The readiness projection view returns a `ready` row for the committed
   assignment; blocked audit row count is coherent.

The CI job installs the Supabase CLI via `supabase/setup-cli@v1` with
`github-token: ${{ secrets.GITHUB_TOKEN }}` to authenticate the "resolve
latest release" API call.  Without a token, the unauthenticated GitHub API
rate limit (60 requests/hour/IP) is exhausted under high PR volume on shared
runners, causing the CLI install to fail with "Failed to resolve latest
Supabase CLI release: rate limit exceeded" and reddening main.  The
`GITHUB_TOKEN` is a short-lived, repository-scoped installation token
generated automatically by GitHub Actions; it carries only the minimum
permissions granted to the workflow job (`contents: read` by default) and is
never exposed to the test harness or the Supabase process.

## Consequences

- **Easier:** reset-path regressions in the project compliance and readiness
  gate are caught before merge, giving reviewers automated evidence that the
  full migration chain + seed still produces a functional compliance gate on a
  fresh schema rebuild.
- **Trade-off:** one additional Supabase CLI job (≈ 3–5 min including Docker
  pull and `supabase db reset`) per PR run.  This is consistent with the
  pattern established by ADR-0042 and all subsequent `*-reset` jobs.
- **`GITHUB_TOKEN` scope:** the token is consumed only by `supabase/setup-cli`
  to look up the latest CLI release version via the GitHub Releases API.  It is
  not forwarded to the Supabase CLI, the database, or any test script, and
  expires when the workflow job ends.
- **Obligation:** future migrations that alter `project_assignment_readiness_audit`,
  its RLS policy, either compliance RPC, `v_project_equipment_readiness_current`,
  or the certification/requirement seed data must keep the reset assertions
  passing or update them to match the new landscape.

## Alternatives considered

- **Skip CI, rely on manual reset check** — rejected; no automatic regression
  signal means reset-path drift is undetected until a developer rebuilds from
  scratch.
- **Fold into the existing behavioral SQL harness** — rejected; that harness
  runs against a bare Postgres container that applies migrations but does not
  execute `seed.sql`, so requirement/certification seed data is absent and the
  readiness projection view cannot be exercised end-to-end.
- **Unauthenticated Supabase CLI install** — rejected; the shared-runner IP
  pool exhausts the GitHub API anonymous rate limit at moderate PR volume,
  which would make the gate non-deterministically red and is the same failure
  mode that motivated the token parameter in every other reset-path job
  (ADR-0046 onwards).

## Evidence

- Migration: `supabase/migrations/20260613212000_project_compliance_readiness_tracking.sql`
- Reset SQL: `supabase/tests/project_compliance_readiness_tracking_reset.sql`
- Runner: `supabase/tests/run_project_compliance_readiness_tracking_reset.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-project-compliance-readiness-reset`
- Issue: #1551
- PR: #1529 (migration), PR #1698 (this gate)
