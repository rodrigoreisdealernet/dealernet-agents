# ADR-0040: E2E portal schedule URL resolution is optional without service key

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Tech Reviewer
- **Supersedes / Superseded by:** -

## Context

The `experience` job in `.github/workflows/e2e-dev.yml` includes a control-plane step that resolves a demo portal schedule URL through the Supabase RPC `portal_get_demo_portal_url`. That lookup requires `E2E_SUPABASE_SERVICE_KEY`.

In some repository or fork contexts, that secret is intentionally absent. Making the URL-resolution step hard-required would fail the entire workflow before non-gating good-UX expectations run, even though the schedule-scoped URL is enrichment data rather than a prerequisite for the baseline experience suite.

## Decision

We treat portal schedule URL resolution as optional when `E2E_SUPABASE_SERVICE_KEY` is not configured.

The workflow step exits successfully after logging that resolution is skipped, and only sets `E2E_PORTAL_SCHEDULE_SCOPED_URL` when the service key is present and a non-null URL is returned.

## Consequences

- The non-gating `experience` job continues to execute in environments that do not provision `E2E_SUPABASE_SERVICE_KEY`.
- Portal schedule-specific checks remain enabled automatically in environments that do provide the service key.
- The workflow preserves least-surprise behavior: optional enrichment does not become an implicit hard dependency.

## Alternatives considered

- **Fail when `E2E_SUPABASE_SERVICE_KEY` is missing:** rejected because it blocks the entire experience run for an optional data-enrichment path.
- **Remove portal URL resolution entirely:** rejected because environments with the secret should still validate schedule-scoped UX behavior.

## Evidence

- `.github/workflows/e2e-dev.yml`
