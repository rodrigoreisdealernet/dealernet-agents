# ADR-0036: Keycloak is the platform IdP while Supabase brokers app sessions

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** Supersedes ADR-0034

## Context
The repo currently has two identity planes:

- the browser app and `ops-api` rely on Supabase GoTrue sessions plus `app_metadata.role`;
- operator/admin tooling needs standards-based OIDC for SSO and group-based access control.

Supabase GoTrue is the current application session broker, but it is not the platform OIDC issuer
we need for off-the-shelf admin tooling. Grafana supports native OIDC. Temporal UI, Supabase
Studio, Prometheus, and Alertmanager need a reverse-proxy OIDC boundary. At the same time, the app
and existing RLS/role flows still depend on Supabase-issued sessions, so a flag-day migration would
break the current auth contract.

ADR-0034 solved the narrower observability-ingress problem by putting Grafana behind
`oauth2-proxy`. The broader platform identity decision now needs to cover the whole human-access
surface and allow Grafana to use its native OIDC support while keeping the boundary explicit in repo
managed config.

## Decision
We use Keycloak as the canonical self-hosted OIDC/SAML identity provider for workforce and admin
access across the platform.

Supabase GoTrue remains the browser-app session broker during the coexistence period. Users
authenticate through Keycloak federation where needed, but the frontend/PostgREST/`ops-api` path
continues to depend on Supabase-issued sessions until a later ADR explicitly migrates that contract.

Per protected surface:

- Grafana uses native Keycloak OIDC with explicit group-to-role mapping.
- Temporal UI, Supabase Studio, Prometheus, and Alertmanager stay behind Keycloak-backed
  `oauth2-proxy` boundaries.
- Each protected surface gets its own Keycloak client; we do not share one client across Grafana and
  multiple proxy-backed tools.
- Keycloak `groups` are the RBAC source of truth for workforce/admin access and must map into the
  existing application roles (`admin`, `branch_manager`, `field_operator`, `read_only`).
- `tenant` is a required mapped claim for any federated app sign-in flow; if role/tenant mapping
  fails, login fails rather than silently downgrading access.

## Consequences
- We get one standards-based SSO boundary for human platform access without breaking the current
  app-session contract.
- Grafana can use its native OIDC support, which supersedes ADR-0034's narrower
  Grafana-behind-`oauth2-proxy` decision.
- We accept temporary dual-identity complexity: Keycloak is the canonical workforce/admin IdP while
  Supabase remains the application-session issuer.
- Keycloak becomes another stateful platform service with its own Postgres backing, client/realm
  configuration, secret rotation, and per-environment isolation requirements.
- Follow-on work must not assume raw Keycloak JWTs are accepted by the current frontend/PostgREST/
  `ops-api` path until a later ADR changes that boundary.

## Alternatives considered
- **Supabase-only identity:** rejected because it does not provide the standards-based OIDC issuer
  shape required by the off-the-shelf admin tooling surface.
- **Immediate full migration of app sessions to Keycloak:** rejected because it would break the
  current Supabase-session/RLS contract before the app path is ready.
- **Keep Grafana behind `oauth2-proxy`:** rejected because Grafana already supports native OIDC and
  the broader identity decision should use the native path when it can still be rendered explicitly
  from repo-managed config.
- **Dex or Entra ID as the platform IdP:** rejected for this decision because the approved direction
  is a self-hosted, vendor-neutral IdP with full control over federation and client layout.

## Evidence
- Issue #688 and epic #680
- `docs/adrs/0034-admin-observability-ingress-oidc-boundary.md`
- `OPERATIONS.md`
