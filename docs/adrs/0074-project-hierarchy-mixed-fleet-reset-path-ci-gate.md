# ADR-0074: Project hierarchy + mixed-fleet allocation reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** Copilot (PR #1772)
- **Supersedes / Superseded by:** none

## Context

PR #1650 merged `supabase/migrations/20260614180000_project_hierarchy_mixed_fleet_allocation.sql`,
which adds:

- `project_upsert_hierarchy_node(...)` — RPC that creates a child project node
  with `branch_has_project` and `project_inherits_requirements_from_project`
  relationships in one atomic call.
- `project_allocate_equipment(...)` — RPC that produces a
  `project_equipment_assignment` entity and derives `allocation_source`
  (`owned` / `external_rental`) from the asset's `ownership_type`.
- `v_project_equipment_allocations_current` — `security_invoker = true` view
  surfacing project, branch, yard context, status, and planned dates for all
  current allocations, with RLS enforced through the invoking role.

The migration shipped without a `supabase db reset` guardrail.  Issue #1772
identified the gap: no automated proof existed that the full migration chain,
hierarchy upsert contract, allocation-source derivation, and tenant-scoped view
survive a fresh `supabase db reset --config supabase/config.toml`.  A
regression in an earlier migration — or a change to the entity/relationship
core tables, the `rental_current_entity_state` materialisation, or the tenant
seed data — could silently break the hierarchy and allocation surfaces on a
fresh rebuild while leaving already-evolved development databases unaffected.

### Control-plane boundary and issue #58

`pr-validation.yml` is a hot shared file: concurrent Copilot PRs frequently
touch it (see #58 — concurrent-PR drift on shared files).  Every addition to
`validation-summary.needs` serialises that job and extends the wall-clock
required-check time for every subsequent PR.

The decision to add directly to `pr-validation.yml` rather than a separate
workflow file is deliberate:

1. **Visibility and required-check enforcement** — GitHub branch protection
   can only gate on named jobs within a workflow that runs on `pull_request`.
   A separate workflow file produces a separate check run that would need an
   additional branch-protection entry; adding to the existing required workflow
   is operationally simpler and consistent with all previous reset-path gates
   (ADR-0042 through ADR-0072).
2. **Path-scoped skip** — ADR-0066 added a `SKIP_SUPABASE_RESET_VALIDATION`
   guard to the `temporal` job so that frontend-only PRs skip the heavy
   Supabase reset suite.  The new job is a standalone parallel job, not part
   of that temporal job, so it always runs on every PR that touches
   `supabase/`, `.github/workflows/pr-validation.yml`, or the test harness
   files.  This is consistent with all other individual reset-path jobs in the
   file.  Future optimisation (adding a path filter to individual reset jobs)
   is tracked under #58 but is out of scope here.
3. **Drift mitigation** — The repo instructions require an ADR for every
   control-plane change (this document) and recommend keeping the PR small.
   This PR adds exactly one job block and one `needs` / summary-table entry.
   Concurrent PRs that also add a job should rebase onto the merged result
   before merge (consistent with the branch-protection policy under #58).

### Permissions

The new job inherits the workflow-level read-only permissions (`contents: read`,
`pull-requests: read`) declared at the top of `pr-validation.yml`.  No
job-level `permissions:` override is added.  The `GITHUB_TOKEN` passed to
`supabase/setup-cli@v2` is used only to authenticate the GitHub Releases API
call that resolves the latest CLI version; it is not forwarded to the Supabase
process or the test harness.

## Decision

We add a `supabase-project-hierarchy-mixed-fleet-reset` job to
`pr-validation.yml` that runs
`bash supabase/tests/run_project_hierarchy_mixed_fleet_allocation_reset.sh` on
every PR, and wire the result into the `validation-summary` required gate.

The SQL harness
(`supabase/tests/project_hierarchy_mixed_fleet_allocation_reset.sql`) confirms
after a clean reset that:

1. `project_upsert_hierarchy_node` and `project_allocate_equipment` exist with
   correct `EXECUTE` grants for `authenticated` after reset.
2. `v_project_equipment_allocations_current` exists and is inaccessible to
   `anon` after reset.
3. `project_upsert_hierarchy_node` creates both `branch_has_project` and
   `project_inherits_requirements_from_project` relationships coherently.
4. `project_allocate_equipment` produces `project_equipment_assignment`
   entities; `allocation_source` derives correctly (`owned` /
   `external_rental`) from asset `ownership_type`.
5. The view surfaces project, branch, yard context, status, and planned dates
   coherently for both allocation types.
6. Cross-tenant RLS — a tenant-b claim returns 0 rows for tenant-a allocations.
7. Anon access raises `insufficient_privilege`.

The CI job uses `actions/checkout@v6` and `supabase/setup-cli@v2` — the
current trusted baseline — with `github-token: ${{ secrets.GITHUB_TOKEN }}` to
avoid the 60-req/hr anonymous GitHub API rate limit on shared runners.

## Consequences

- **Easier:** reset-path regressions in the project hierarchy and mixed-fleet
  allocation surface are caught before merge, giving reviewers automated
  evidence that the full migration chain + seed still produce functional RPCs
  and a correct view on a fresh rebuild.
- **Trade-off:** one additional parallel Supabase CLI job (≈ 3–5 min including
  Docker pull and `supabase db reset`) per PR run.  This is consistent with the
  pattern established by ADR-0042 and all subsequent `*-reset` jobs.
- **`pr-validation.yml` drift (issue #58):** every PR that modifies this file
  carries merge-conflict risk with concurrent PRs.  Keeping the change minimal
  (one job block + one `needs` entry + one summary-table `echo`) reduces the
  conflict surface.  The ADR requirement for control-plane changes (this
  document) is the primary audit trail for why the file changed.
- **Rollback:** if the reset harness proves consistently flaky, the job can be
  temporarily removed from `validation-summary.needs` to make it non-blocking
  while the flakiness is investigated.  Full removal requires a follow-up PR and
  a superseding ADR update to this record.
- **Obligation:** future migrations that alter `project_upsert_hierarchy_node`,
  `project_allocate_equipment`, `v_project_equipment_allocations_current`,
  or the relationship/entity-core tables must keep the reset assertions passing
  or update them to match the new landscape.

## Alternatives considered

- **Skip CI, rely on manual reset check** — rejected; no automatic regression
  signal means reset-path drift is undetected until a developer rebuilds from
  scratch.
- **Separate workflow file** — rejected; requires a separate branch-protection
  entry, increases workflow file sprawl, and is inconsistent with all previous
  reset-path CI gates (ADR-0042 through ADR-0072).
- **Fold into the existing focused-fixture harness** — rejected; the
  Docker-based fixture harness runs against a bare Postgres container that
  applies migrations but does not execute `seed.sql`, so tenant seed data and
  the entity/relationship core materialisation cannot be exercised end-to-end.
- **Unauthenticated Supabase CLI install** — rejected; the shared-runner IP
  pool exhausts the GitHub API anonymous rate limit at moderate PR volume,
  causing non-deterministic red gates (same failure mode that motivated the
  token parameter in ADR-0046 and every subsequent reset-path job).

## Evidence

- Migration: `supabase/migrations/20260614180000_project_hierarchy_mixed_fleet_allocation.sql`
- Reset SQL: `supabase/tests/project_hierarchy_mixed_fleet_allocation_reset.sql`
- Runner: `supabase/tests/run_project_hierarchy_mixed_fleet_allocation_reset.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-project-hierarchy-mixed-fleet-reset`
- Related issue (drift guard): #58
- PR: #1772 (this gate)
