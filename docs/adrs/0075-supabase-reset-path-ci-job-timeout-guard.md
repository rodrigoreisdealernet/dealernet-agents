# ADR-0075: Supabase reset-path CI job-level timeout guard

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** Copilot (issue #1802)
- **Supersedes / Superseded by:** none

## Context

Issue #1802 reported that the `Supabase CRM intake scope tokens reset-path validation`
job (job 81380158811 in run 27534439879) hung indefinitely in the `Install Supabase CLI`
step on PR #1768. The job produced no error output and remained in-progress for hours,
blocking the `validation-summary` required check and preventing the PR from merging.

The `Install Supabase CLI` step uses `supabase/setup-cli@v2`, which resolves the latest
CLI release via the GitHub API. Under high runner concurrency, this API call can stall
without surfacing a timeout error (e.g., network issues, ephemeral platform wedges). All
18 Supabase reset-path validation jobs shared this exposure: none had a `timeout-minutes`
guard, so a hung install defaulted to GitHub Actions' 6-hour maximum.

This was not a shared outage: the same job completed successfully on other open PRs in
the same time window, confirming the hang was transient and runner-specific rather than
a systemic platform failure.

## Decision

We add `timeout-minutes: 20` to every Supabase reset-path validation job in
`pr-validation.yml` that uses `supabase/setup-cli@v2`, and to `supabase-ops-audit-trail-view-rls`
which follows the same structural pattern. This caps any CLI-install or migration-reset
hang at 20 minutes and causes GitHub Actions to fail and surface the stuck job promptly
rather than silently consuming runner capacity for up to 6 hours.

## Consequences

- A hung `Install Supabase CLI` or `supabase db reset` step will fail the job within
  20 minutes instead of after 6 hours, freeing the runner and surfacing the incident
  earlier.
- Legitimate slow runs are unaffected: the install step normally completes in under
  2 minutes and the full reset + validation in under 10 minutes, well within the 20-minute
  window.
- If a transient platform issue causes a timeout, the team can retrigger the run without
  needing factory-stuck escalation.
- 18 jobs are affected, all following the same pattern; the change is mechanical and
  carries no logic risk.

## Alternatives considered

- **Step-level timeout on `Install Supabase CLI` only** — rejected; GitHub Actions does
  not support step-level timeouts natively. A job-level timeout is the correct boundary.
- **Pin CLI version to avoid resolution API calls** — considered as a complementary
  improvement; rejected for this change to keep scope minimal. The existing `github-token`
  parameter already mitigates rate-limit failures; pinning is a separate follow-up.
- **Rely only on cancelling stuck runs manually** — rejected; this is the factory-stuck
  escalation path that triggered this issue. Automated timeouts are more reliable.

## Evidence

- Workflow: `.github/workflows/pr-validation.yml` (all `supabase-*-reset` jobs)
- Incident: issue #1802, factory-stuck run 27534439879 job 81380158811
- Related: ADR-0071 (Temporal lane fail-fast timeout, same pattern applied to Supabase lane)
