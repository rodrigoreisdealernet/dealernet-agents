# ADR-0076: Narrow Temporal reset-suite path scope to DB-surface changes only

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** copilot (PR #1886) / development lane
- **Supersedes / Superseded by:** Supersedes the `temporal/` half of ADR-0066 (the
  `supabase/` and `.github/workflows/pr-validation.yml` entries are unchanged)

## Context

ADR-0066 introduced path-scoping for the `Temporal worker tests` required check:
the heavy Supabase reset/smoke validations (~25 tests × ~2 min each ≈ 45+ min) are
skipped for PRs that touch neither `supabase/`, `temporal/`, nor
`.github/workflows/pr-validation.yml`.  The `temporal/` entry was added to catch PRs
that change the reset-test files themselves.

However, `temporal/` is a broad prefix.  It matches not only `temporal/tests/` (where
the reset/smoke validation tests live) but also `temporal/src/` (Python workflows,
activities, and tools) and `temporal/pyproject.toml`.  A PR that adds a new Temporal
workflow in `temporal/src/` has nothing to do with the Supabase migration stack, yet it
triggers the full ~45+ min reset suite — a disproportionate cost.

Incident evidence (issue #1883): PR runs 27591470076 and 27591305734 each spent ~52 min
in `Temporal worker tests` on step "Test Temporal suite".  Both PRs touched
`temporal/src/` paths.  Because `temporal/` matched the broad filter, `skip_reset=0`
was set and the full suite ran, delaying every subsequent PR in the queue.

## Decision

We narrow the path-scope filter from `temporal/` to `temporal/tests/`, while explicitly
preserving `temporal/pyproject.toml` as a trigger because it controls the Python
environment installed for this job.

Updated grep pattern in the `Scope reset/smoke validations to DB-surface changes` step:

```
grep -qE '^(supabase/|temporal/tests/|temporal/pyproject\.toml|\.github/workflows/pr-validation\.yml)'
```

This means:
- **`supabase/`** — all migration, seed, and schema-test changes trigger the full suite.
- **`temporal/tests/`** — changes to the reset/smoke validation test files themselves
  trigger the full suite.  This preserves the original intent of the `temporal/` entry.
- **`temporal/pyproject.toml`** — defines the Python environment installed via
  `pip install -e ".[dev]"` for this job.  A change there can alter how the reset/smoke
  suite runs (e.g. upgrading pytest or changing test dependencies), so it must be
  validated on-PR rather than being given the fast path.
- **`.github/workflows/pr-validation.yml`** — the control-plane file governing this
  check always triggers the full suite.
- **`temporal/src/`** and all other paths — the heavy reset suite is skipped.  Fast
  unit tests still run and gate the required check.

## Consequences

- **Easier:** PRs that only change `temporal/src/` (the common case for feature and
  fix work) now clear `Temporal worker tests` in minutes instead of ~50 min.
- **Unchanged coverage:** Any PR that touches `supabase/`, `temporal/tests/`, or
  `temporal/pyproject.toml` still runs the full reset/smoke validation suite.  Every
  push to `main` runs the full suite (path scoping is PR-only).  Migration stack
  coverage is intact.
- **Obligation:** If new directories are added that host DB-surface logic outside of
  `supabase/` and `temporal/tests/`, the path filter must be updated.  If heavy
  reset/smoke tests are added to new files outside `temporal/tests/`, those paths must
  also be included.  If new temporal root-level config files that govern the test
  environment are added, they should be included too.
- **Trade-off accepted:** A PR that modifies other `temporal/` root files (e.g. the
  `Dockerfile` or `build/` scripts) will skip the reset suite.  These files do not
  affect Supabase migrations.  `temporal/pyproject.toml` is explicitly included because
  it directly controls the Python install used by this job.

## Alternatives considered

- **Split the `temporal` job into fast and reset sub-jobs** — more structurally
  correct but requires updating the `validation-summary` needs list, branch-protection
  required-check names, and multiple contract tests.  The path-filter narrowing achieves
  the same practical outcome (fast path for source-only PRs) with a minimal diff.
- **Keep the broad `temporal/` filter** — rejected because it forced ~50 min runs on
  every PR touching application code, which created the incident pattern documented
  in #1883.
- **Remove `temporal/` from the filter entirely** — rejected because changes to the
  reset-test files (`temporal/tests/`) must still trigger the suite they exercise.

## Evidence

- Workflow: `.github/workflows/pr-validation.yml` — `temporal` job, `Scope reset/smoke
  validations to DB-surface changes` step
- Contract tests: `temporal/tests/test_pr_validation_workflow_contract.py`
- Incident: issue #1883 — runs 27591470076 (~52 min) and 27591305734 (~55 min)
- Prior art: ADR-0066 (original path-scoping), ADR-0071 (fail-fast timeout), ADR-0073
  (timeout bound)
- PR: #1886
