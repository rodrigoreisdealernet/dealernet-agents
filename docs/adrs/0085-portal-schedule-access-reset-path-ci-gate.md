# ADR-0085: Portal schedule public-read + forged-token-denial reset-path validation is a required PR gate (DB-surface scoped)

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Copilot (issue #1931 re-kick)
- **Supersedes / Superseded by:** none

## Context

Migrations `20260613222000_portal_schedule_public_read.sql` and
`20260615234500_portal_customer_service_request_workflow.sql` together implement:

- **Public schedule read** — `portal_get_contract_schedule(uuid, text)` allows
  `anon` to read the schedule when `p_scope_token` is `null` (the contract UUID
  itself is the share secret; no explicit token is required for read-only access).
- **Forged-token denial** — `anon` passing a token that does not match a seeded
  `portal_contract_scope_tokens` row receives `42501` (insufficient_privilege)
  from `portal_get_contract_schedule` and from the write-path RPCs
  (`portal_submit_customer_service_request`,
  `portal_list_customer_service_requests`).
- **Demo portal URL guard** — `portal_get_demo_portal_url()` is a
  `SECURITY DEFINER` function accessible only to `service_role`; `anon`
  attempting to call it receives `42501`.
- **Customer service request workflow** — `portal_submit_customer_service_request`
  replaces the narrower `portal_submit_off_rent_request` RPC, supporting
  multiple request types (`off_rent_pickup`, `contract_extension`,
  `field_service`) with scope-token enforcement and update-in-place
  deduplication per `(contract, line, request_type)`.

These migrations shipped without a `supabase db reset` guardrail.  A regression
in an earlier migration — or a change to the `portal_contract_scope_tokens` table,
the `digest()` search-path resolution, or the tenant seed data — could silently
break the public-read grant or the forged-token denial on a fresh rebuild while
leaving already-evolved development databases unaffected.

The reset-path SQL harness
(`supabase/tests/portal_schedule_access.sql`) exercises all four
acceptance criteria after a clean reset:

1. Schema shape — table, function signatures, and `SECURITY DEFINER` marker.
2. Seed data — demo scope token row and `portal_get_demo_portal_url()` URL.
3. Scope-token auth — service_role bypass, anon + valid token, anon + null
   token (public read), anon + forged token (42501), anon calling
   `portal_get_demo_portal_url` (42501).
4. Customer-request persistence — null token denied, forged token denied,
   valid token accepted, submitted request visible in
   `portal_list_customer_service_requests`, duplicate collapses.

### Control-plane boundary

`pr-validation.yml` is a hot shared file; every addition to
`validation-summary.needs` serialises that job and extends the wall-clock
required-check time for every subsequent PR.  The decision to add directly to
`pr-validation.yml` rather than a separate workflow file is deliberate:

1. **Visibility and required-check enforcement** — GitHub branch protection
   can only gate on named jobs within a workflow that runs on `pull_request`.
   A separate workflow file produces a separate check run that requires an
   additional branch-protection entry; adding to the existing required workflow
   is operationally simpler and consistent with all previous reset-path gates
   (ADR-0042 through ADR-0084).
2. **DB-surface path scoping** — The job introduces a `scope` step that
   computes a `git diff` between the PR base and head SHA.  The heavy
   `supabase db reset` is skipped when the PR touches neither `supabase/` nor
   `.github/workflows/pr-validation.yml`.  On `push` to `main` (post-merge
   trunk validation) the full suite always runs.
3. **Fail-closed on indeterminate diff** — If the git diff returns an empty
   file list (e.g. shallow clone or SHA resolution failure), the scope step
   defaults to `skip_reset=0` (run the suite) so coverage is never silently
   dropped.
4. **Drift mitigation** — The repo instructions require an ADR for every
   control-plane change (this document) and recommend keeping the PR small.
   This PR adds exactly one job block and one `needs` / summary-table entry.

### Permissions

The new job inherits the workflow-level read-only permissions (`contents: read`,
`pull-requests: read`) declared at the top of `pr-validation.yml`.  No
job-level `permissions:` override is added.  The `GITHUB_TOKEN` passed to
`supabase/setup-cli@v2` is used only to authenticate the GitHub Releases API
call that resolves the latest CLI version.

## Decision

We add a `supabase-portal-schedule-access-reset` job to `pr-validation.yml`
that:

1. Runs a `scope` step to compute whether the PR touches `supabase/` or
   `.github/workflows/pr-validation.yml`.
2. Skips the Supabase CLI install and the reset harness on PRs that touch
   neither path (emitting a SKIPPED summary line).
3. Runs `bash supabase/tests/run_portal_schedule_access_reset.sh` on
   DB-surface PRs and unconditionally on `push` to `main`.
4. Wires the job result into the `validation-summary` required gate.

## Consequences

- **Easier:** reset-path regressions in the portal schedule public-read grant,
  the forged-token denial, and the customer service request workflow are caught
  before merge.
- **Cost control:** frontend-only, Temporal-only, and docs-only PRs skip the
  ≈ 3–5 min reset penalty.  DB-surface PRs pay the cost as expected.
- **`pr-validation.yml` drift (issue #58):** every PR that modifies this file
  carries merge-conflict risk with concurrent PRs.  Keeping the change minimal
  (one job block + one `needs` entry + one summary-table `echo`) reduces the
  conflict surface.
- **Rollback:** if the reset harness proves consistently flaky, the job can be
  temporarily removed from `validation-summary.needs` to make it non-blocking
  while the flakiness is investigated.
- **Obligation:** future migrations that alter `portal_get_contract_schedule`,
  `portal_submit_customer_service_request`,
  `portal_list_customer_service_requests`, `portal_contract_scope_tokens`, or
  the demo scope token seed must keep the reset assertions passing or update
  them to match the new landscape.

## Alternatives considered

- **Always-on (no path scoping)** — rejected; adds ≈ 3–5 min to every PR
  regardless of whether DB-surface files changed.
- **Skip CI, rely on manual reset check** — rejected; no automatic regression
  signal means reset-path drift is undetected until a developer rebuilds from
  scratch.
- **Separate workflow file** — rejected; requires a separate branch-protection
  entry, increases workflow file sprawl, and is inconsistent with all previous
  reset-path CI gates (ADR-0042 through ADR-0084).
- **Unauthenticated Supabase CLI install** — rejected; the shared-runner IP
  pool exhausts the GitHub API anonymous rate limit at moderate PR volume,
  causing non-deterministic red gates.

## Evidence

- Migrations:
  - `supabase/migrations/20260613222000_portal_schedule_public_read.sql`
  - `supabase/migrations/20260615234500_portal_customer_service_request_workflow.sql`
- Reset SQL: `supabase/tests/portal_schedule_access.sql`
- Runner: `supabase/tests/run_portal_schedule_access_reset.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-portal-schedule-access-reset`
- Re-kick issue: #1931
- Related ADR (temporal scoping pattern): ADR-0066
- Related issue (drift guard): #58
