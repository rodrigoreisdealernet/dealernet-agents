# ADR-0046: Fleet availability calendar reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-12
- **Deciders:** Tech Review, Platform, Copilot
- **Supersedes / Superseded by:** N/A

## Context
PR #1271 adds a dedicated `supabase-fleet-availability-calendar-reset` job to `.github/workflows/pr-validation.yml`. That changes PR control-plane behavior by making clean-reset validation for `fleet_get_availability_calendar` a required CI gate instead of an ad hoc local check.

The underlying risk is reset-path drift: the fleet availability calendar migration had behavior that was only validated against an evolved development database, leaving fresh-schema rebuild regressions undiscovered until after merge.

## Decision
We keep fleet availability calendar reset-path validation as a named, required PR validation job wired into the `validation-summary` gate.

## Consequences
- Fresh-schema regressions in the fleet availability calendar path fail PR validation before merge.
- The PR workflow gains one more required Supabase validation job, increasing CI runtime slightly.
- Future changes to this area must preserve both the dedicated job and the reset-path assertions unless a superseding ADR replaces this gate.

## Alternatives considered
- Rely on manual `supabase db reset` checks only — rejected because it is easy to skip and does not protect main.
- Fold the assertions into an existing generic Supabase job — rejected because a dedicated gate makes failures explicit and keeps this reset-path contract visible in the summary table.

## Evidence
- `.github/workflows/pr-validation.yml`
- `supabase/tests/fleet_availability_calendar_reset.sql`
- `supabase/tests/run_fleet_availability_calendar_reset.sh`
- PR #1271 (`Add fleet availability calendar reset-path validation`)
