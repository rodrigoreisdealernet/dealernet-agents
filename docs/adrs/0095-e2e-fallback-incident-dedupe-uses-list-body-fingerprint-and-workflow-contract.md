# ADR-0095: E2E fallback incident dedupe uses list/body fingerprint and workflow contract

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** @copilot, @ianreay
- **Supersedes / Superseded by:** none

## Context

The E2E failure sentinel has two incident-upsert paths in `.github/workflows/e2e-dev.yml`:
the shared runtime CLI path and a `gh` fallback path used when shared-tools bootstrap is unavailable.

The fallback path briefly regressed to `gh issue list --search "fingerprint:e2e-dev-failure"`.
GitHub search is eventually consistent and can normalize punctuation, which risks duplicate incident
creation when near-simultaneous failures occur before the index converges.

Because workflow files are control-plane boundaries in this repository, this behavior needs an
explicit decision record and a regression contract to prevent recurrence.

## Decision

The E2E fallback incident-upsert path must dedupe using the strongly consistent issue list API:
list open issues with bodies, inspect fingerprint comments locally (`<!-- fingerprint:... -->`),
and update the canonical oldest matching issue (`min_by(.number)`), never search index lookup.

The workflow contract test must assert this dedupe shape (no `--search`, list/body scan, oldest-match selection)
alongside existing priority/fingerprint and least-privilege token assertions.

## Consequences

- Preserves fallback dedupe guarantees during shared-tools outages.
- Avoids duplicate incident fan-out caused by search-index lag.
- Adds a durable policy/test boundary for future workflow edits in this control-plane file.

## Alternatives considered

- Use `gh issue list --search` in fallback for shorter script syntax — rejected due to eventual consistency
  and punctuation normalization behavior that weakens dedupe under concurrent failures.
- Omit workflow-level contract tests and rely only on runtime behavior — rejected because wiring regressions
  in YAML can bypass runtime tests until incidents duplicate in production.

## Evidence

- `.github/workflows/e2e-dev.yml`
- `temporal/tests/test_e2e_history_scripts.py`
