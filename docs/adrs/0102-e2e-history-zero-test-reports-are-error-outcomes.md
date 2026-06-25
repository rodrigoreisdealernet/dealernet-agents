# ADR-0102: E2E history zero-test and errors-array reports are error outcomes

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Factory (Copilot), @ianreay
- **Supersedes / Superseded by:** none

## Context

The `e2e-history` branch records append-only JSON lines written by
`.github/scripts/e2e-history-record.mjs` after every Playwright suite run.
A false-green `outcome: "passed"` record is written when the Playwright
collection phase fails silently: the runner exits without test results yet the
script saw a parseable JSON report with `stats.total == 0` and no
`unexpected` count, which previously mapped to `"passed"`.

Two concrete failure shapes produce false-greens:

1. **Top-level `errors[]` present** — Playwright populates `report.errors[]`
   when it cannot load or compile one or more spec files (e.g. a missing
   import, a TypeScript compilation error, or a duplicate test title that
   breaks the collector). The run records zero tests but `errors` is
   non-empty.

2. **Zero-test report with empty `errors[]`** — Playwright sometimes emits a
   structurally valid JSON report with all stat counters at zero and an empty
   `errors` array when the suite is inadvertently filtered to nothing. Either
   way, zero collected tests is never a legitimate "passed" outcome.

The root cause that triggered this issue was a duplicate Playwright test title
in `frontend/e2e/experience.spec.ts` — two tests named
`"RapidCount variance review: submitted decision persists through reload and audit history"`
— which caused Playwright to abort collection for that suite, producing a
zero-test report that was silently recorded as `passed`.

## Decision

`.github/scripts/e2e-history-record.mjs` treats both failure shapes as
`outcome: "error"`:

- If `report.errors[]` is a non-empty array the outcome is `"error"` and the
  first error message is surfaced in `record.error`.
- If the parsed report has `stats.total == 0` (computed as
  `expected + unexpected + flaky + skipped`) the outcome is `"error"`,
  regardless of whether `errors[]` is present.

Existing `"passed"` / `"failed"` behaviour for normal non-zero reports is
unchanged.

## Consequences

- Collection-time Playwright failures now produce auditable `"error"` records
  instead of misleading `"passed"` records, maintaining the integrity of the
  history signal used by agents and trend dashboards.
- Any legitimate all-skipped run with `skipped > 0` has `total > 0` and
  continues to be recorded as `"passed"`.
- Purely empty suites (zero tests, no errors) are now visibly surfaced as
  problems rather than silent no-ops.
- The duplicate test title in `frontend/e2e/experience.spec.ts` that caused
  the immediate wedge is removed as part of this change.

## Alternatives considered

- **Treat zero-test reports as `"skipped"` rather than `"error"`** — rejected
  because a skipped outcome implies an intentional no-op; zero collected tests
  almost always indicates an infra or spec-file problem that needs attention.
- **Only act on `errors[]`; leave zero-test as `"passed"`** — rejected because
  Playwright does not always populate `errors[]` on a failed collection;
  checking `total == 0` provides a broader safety net.

## Evidence

- `.github/scripts/e2e-history-record.mjs` — outcome logic (lines 63-78)
- `temporal/tests/test_e2e_history_scripts.py` — `test_record_script_marks_report_with_errors_array_as_error` and `test_record_script_marks_zero_test_report_as_error`
- `frontend/e2e/experience.spec.ts` — duplicate title removed (was at lines 8242-8335)
- Issue: Volaris-AI/wynne-lvl-3#2263
