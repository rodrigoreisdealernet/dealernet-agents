# ADR-0066: Path-scope Temporal reset/smoke validations to DB-surface PRs

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** copilot / platform review (PR #1615)
- **Supersedes / Superseded by:** none

## Context

The `Temporal worker tests` required check in `pr-validation.yml` runs ~25 Supabase
reset/smoke validations as part of a single serialized `pytest` run. Each validation
performs a full `supabase db reset` (~2 minutes). The suite therefore serializes to
~45+ minutes end-to-end.

Under current PR volume on shared GitHub-hosted runners, the job **never reaches a
terminal conclusion**: across the last 40 PR-validation runs it completed 0 times —
18 runs were simultaneously `in_progress`, queuing for hours and being superseded by
re-triggers before finishing. Because `Temporal worker tests` is a required check, this
wedged **every** open PR regardless of what the PR touched.

Concrete fallout: frontend-only PRs #1554, #1555, and #1557 sat 8+ hours blocked on
DB validations that had nothing to do with their single-file frontend changes. They were
admin-merged manually to unblock; this ADR records the policy change that fixes the root
cause.

The key observation is that every one of these heavy validations exercises the
**database surface** exclusively — they test that migrations apply cleanly, that
schema-level contracts are preserved, and that reset-path semantics are correct. A PR
that touches neither `supabase/` nor `temporal/` cannot affect any of those properties,
so running the validations provides zero coverage value while consuming significant
shared-runner capacity.

## Decision

We gate the heavy Supabase reset/smoke validations on the files a PR actually changes:

1. **`.github/workflows/pr-validation.yml`** — the `temporal` job diffs the PR head
   against its base SHA and sets `SKIP_SUPABASE_RESET_VALIDATION=1` when none of
   `supabase/`, `temporal/`, or `.github/workflows/pr-validation.yml` is touched.
   This last entry ensures that a PR editing the control-plane file that governs
   this check always runs the full suite. **Merge-base diff:** the diff uses
   three-dot syntax (`git diff --name-only "$base...$head"`) so only commits
   introduced by the PR branch itself are evaluated — not unrelated commits already
   on `main` that happen to touch `supabase/` or `temporal/`. Two-tree diff syntax
   (`"$base" "$head"`) would include those unrelated commits and incorrectly force
   `skip_reset=0` on frontend-only PRs whenever `main` contains recent DB changes.
   **Fail-closed policy:** the `git diff` command runs without error suppression
   (`|| true` is absent); if the diff fails the step hard-fails rather than silently
   defaulting to skip. If the diff succeeds but returns an empty file list
   (indeterminate changeset), `skip_reset=0` is written so the full suite runs.
   Pushes to `main` (post-merge trunk runs) always set `skip_reset=0`, keeping full
   trunk coverage intact.

2. **Stale-run cancellation** — the workflow's `concurrency` block now uses
   `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. This
   conditional expression evaluates to `true` for PR events (stale runs are
   automatically retired when a new commit is pushed, so the required check always
   advances to the current head SHA) and to `false` for push-to-main events
   (trunk runs are never cancelled, preserving full post-merge coverage). Under
   the previous hard-coded `cancel-in-progress: false` a wedged `Temporal worker
   tests` run for an older commit could continue to block the required check for
   the entire PR, even after a newer commit had already been pushed.

3. **`temporal/tests/conftest.py`** — a `pytest_collection_modifyitems` hook checks
   `SKIP_SUPABASE_RESET_VALIDATION`. When set to `1`, it deselects every test whose
   name ends with `_reset_validation` or `_smoke_validation` via suffix matching. The
   two cheap pure-Python library unit tests
   (`test_reset_validation_detects_duplicate_migrations` and
   `test_reset_validation_lib_preserves_unique_migration_versions`) end with
   `_migrations` and `_versions` respectively, so they are intentionally excluded from
   the skip set and always run.

## Why no branch-protection topology change is needed

The required-check name (`Temporal worker tests`) and the job that produces it are
unchanged. The job still runs on every PR; it still reports a pass/fail result to
GitHub's required-check gate. What changes is the *composition* of that result: on
non-DB PRs the heavy validations are skipped (reported as `skipped`, not `failed`),
and the remaining tests (including the cheap library unit tests) still gate the job.
Branch protection evaluates the job conclusion, not the individual test list, so no
topology change is required.

## Consequences

- **Easier:** frontend, docs, and test-only PRs clear the `Temporal worker tests`
  required check in minutes instead of timing out. PR queue pressure on shared runners
  is substantially reduced.
- **Faster PR advancement:** stale PR runs are cancelled when a new commit is pushed,
  so the required check always reflects the current head SHA and cannot be indefinitely
  blocked by an older run that will never complete.
- **Unchanged:** any PR that touches `supabase/`, `temporal/`, or
  `.github/workflows/pr-validation.yml` runs the full suite.
  Every push to `main` runs the full suite and is never cancelled. Trunk
  migration-reset coverage is intact.
- **Obligation:** the path-scoping rule must be updated if new directories are added
  that host DB-surface logic, or if the control-plane file is renamed. The two cheap
  library unit tests must continue to end with suffixes other than `_reset_validation` /
  `_smoke_validation` or they will be incorrectly skipped.
- **Trade-off accepted:** a PR that refactors shared utility code used by migrations
  but lives outside `supabase/` or `temporal/` could theoretically skip the reset
  validations. The risk is low given the current repository layout; if utility code
  paths expand the rule can be updated.

## Alternatives considered

- **Remove the heavy validations from the required check** — rejected; migration reset
  coverage is a hard requirement for safe DB-touching PRs. The validations must remain
  blocking for DB-surface changes.
- **Extract into a separate optional workflow** — rejected; making the check optional
  removes the safety net for DB PRs and requires a branch-protection topology change
  with all its coordination overhead.
- **Increase runner concurrency / use larger runners** — viable long-term but does not
  change the fundamental serialization problem (each reset is ~2 min and cannot be
  easily parallelised within a single pytest run). Path scoping is the correct
  first-order fix.
- **Parallelise reset tests across matrix jobs** — viable and complementary but would
  require significant restructuring. Left as follow-up work.

## Evidence

- CI job change: `.github/workflows/pr-validation.yml` — `temporal` job, `Scope
  reset/smoke validations to DB-surface changes` step
- Test hook: `temporal/tests/conftest.py` — `pytest_collection_modifyitems`
- PR: #1615
- Blocked frontend PRs (motivation): #1554, #1555, #1557
