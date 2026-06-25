# ADR-0034: External admin observability ingress stays behind oauth2-proxy OIDC group gating

- **Status:** Accepted (Grafana boundary superseded by ADR-0036; Temporal UI boundary remains in force)
- **Date:** 2026-06-08
- **Deciders:** Repository owner, Tech Reviewer, Copilot PR implementer
- **Supersedes / Superseded by:** Grafana boundary superseded by ADR-0036

## Context
Test/prod Helm values expose external admin routes for Temporal UI and Grafana. Temporal UI
was explicitly routed through oauth2-proxy with Keycloak group checks, but Grafana ingress
could be rendered directly to the upstream service without any auth boundary encoded in this
chart. That made external auth posture depend on undocumented assumptions outside this repo.

Admin observability tooling crosses a security boundary (public ingress into internal
monitoring/runtime systems), so the boundary must be explicit and deny-by-default in rendered
resources.

## Decision
We require both external admin routes (Temporal UI and Grafana) to be gated by oauth2-proxy
OIDC with Keycloak `groups` claim enforcement (`allowed-group=admin`) in this chart.

Grafana ingress only renders when the dedicated Grafana oauth2-proxy boundary is enabled, and
the ingress backend targets that proxy rather than the Grafana upstream service directly.

## Consequences
- External Grafana access is now explicitly authenticated and group-authorized in rendered
  manifests, removing auth-bypass ambiguity from this chart.
- Operators must configure valid Grafana oauth2-proxy callback URLs and the shared oauth2-proxy
  client/cookie secrets per environment.
- If the oauth2-proxy boundary is disabled, Grafana stays internal-only by default.

## Alternatives considered
- **Direct Grafana ingress with assumed native OIDC enforcement elsewhere:** rejected — this
  leaves boundary enforcement implicit and unauditable from this repo.
- **Disable external Grafana entirely:** rejected — operators need the admin route, but it must
  be explicitly gated.

## Evidence
- `charts/app/templates/admin-grafana-route.yaml`
- `charts/app/templates/admin-grafana-oauth2-proxy-deployment.yaml`
- `charts/app/templates/admin-grafana-oauth2-proxy-service.yaml`
- `charts/app/values-test.yaml`
- `charts/app/values-prod.yaml`
