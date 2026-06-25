# ADR-0110: Experience-suite runtime prerequisite provisioning

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Copilot (issue #2295 implementation)
- **Supersedes / Superseded by:** none

## Context

The non-gating experience suite in `.github/workflows/e2e-dev.yml` was still skipping prerequisite-driven journeys even after manager/read-only auth and the portal schedule/intake demo URLs were wired in. The latest run evidence for issue #2295 still showed skips concentrated in:

1. field-operator journeys that rely on `E2E_OPERATOR_*` credentials but the experience job did not export them;
2. portal catalog and billing-update journeys that need a seeded scope URL but had no runtime resolver; and
3. authenticated portal-request journeys that need `portal_customer` auth users plus `portal_customer_access_grant` rows, but the workflow had no provisioning path for them.

These are harness-level gaps, not product assertions. Leaving them as silent `test.skip()` results keeps the suite green while reducing coverage trust.

## Decision

We provision the remaining experience-suite prerequisites at workflow runtime using the existing Supabase service-role secret:

1. Export `E2E_OPERATOR_EMAIL` and `E2E_OPERATOR_PASSWORD` into the experience job so field-operator journeys can authenticate against deployed dev.
2. Keep resolving the seeded portal schedule and intake URLs in workflow, and add a runtime provisioning script that:
   - derives the portal catalog URL from the seeded demo schedule contract,
   - issues a fresh billing-update scope token via `portal_issue_billing_update_token`, and
   - creates or updates two deterministic `portal_customer` auth users plus matching `portal_customer_access_grant` rows for the eligible and non-eligible portal-request cases.

The suite remains non-gating, but the workflow now treats missing service-role provisioning inputs as an explicit harness failure instead of silently dropping those journeys from coverage.

## Consequences

- Portal catalog, billing-update, portal-request, and field-operator experience checks can run on deployed dev without requiring extra long-lived portal-customer secrets.
- The workflow now depends on the service-role key for both scope-token resolution and portal-customer admin provisioning, so regressions in Supabase admin access surface immediately in the experience lane.
- The provisioning logic is tied to the seeded demo contract fixtures: the eligible path resolves `demo-baseline-rental-contract-002` through `portal_get_demo_portal_url()`, and the non-eligible path looks up `demo-baseline-rental-contract-001` directly. If those canonical demo records change, the workflow helper must be updated.

## Alternatives considered

- **Add more repository secrets for portal customers and static billing-update URLs:** Rejected — it would duplicate data already derivable from the demo seed and create more long-lived credential/config drift.
- **Hard-code portal catalog or billing-update URLs in the workflow:** Rejected — the URLs depend on database row IDs and raw tokens that can change across resets or re-issuance.
- **Modify the tests to stop skipping when prerequisites are absent:** Rejected — the tests should continue to advertise missing harness prerequisites explicitly rather than produce false positives.

## Evidence

- `.github/workflows/e2e-dev.yml`: experience job env now includes operator auth and calls the runtime provisioning step before `experience.spec.ts`.
- `scripts/provision-experience-prereqs.mjs`: service-role provisioning for portal catalog URL, billing-update token, and portal-customer auth/grant fixtures.
- `frontend/e2e/experience.spec.ts`: prerequisite-gated journeys consume `E2E_OPERATOR_*`, `E2E_PORTAL_CATALOG_SCOPED_URL`, `E2E_PORTAL_BILLING_UPDATE_SCOPED_URL`, and portal-customer auth env vars.
- Issue: Volaris-AI/wynne-lvl-3#2295.
