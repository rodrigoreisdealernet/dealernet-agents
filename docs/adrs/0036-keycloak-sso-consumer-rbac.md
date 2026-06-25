# ADR-0036: Keycloak SSO consumer-side RBAC — Grafana native OIDC and Supabase-federated app sessions

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Repository owner, architecture review
- **Supersedes / Superseded by:** Supersedes ADR-0034 (Grafana boundary only; Temporal UI boundary stays behind oauth2-proxy)

## Context

The Keycloak identity epic (#680) established Keycloak as the platform IdP. Consumer-side
integrations must be wired to that IdP:

- **Grafana** needed an authenticated external route. ADR-0034 placed a generic oauth2-proxy
  in front of Grafana and allowed only the `admin` group. That approach gave Grafana only one
  effective role (admin-or-blocked) and required an additional proxy process. Grafana ships its
  own native OIDC auth, which supports per-group role mapping (Admin / Editor / Viewer) and
  removes the proxy hop — but only if the auth configuration is explicit and repo-managed, not
  assumed to be configured out-of-band.

- **App and ops-api** authenticate users via Supabase-issued JWTs. To integrate with Keycloak
  without a flag-day migration away from Supabase-backed sessions, the approved path is
  Keycloak → Supabase federation: users authenticate at Keycloak, and GoTrue issues the
  Supabase session. A database-level claim-mapping function maps Keycloak `groups` claims to
  the canonical application role (`admin`, `branch_manager`, `field_operator`, `read_only`)
  and stores the result in `raw_app_meta_data` so the Supabase JWT carries the correct role.

## Decision

### Grafana: native OIDC with repo-managed role mapping

We configure Grafana to authenticate users directly against Keycloak via
`auth.generic_oauth`. The Helm chart renders a ConfigMap with all non-secret OIDC settings
(endpoint URLs, role attribute path, sign-out URL). Secret settings (client ID and client
secret) are read from a named Kubernetes Secret. The external ingress for Grafana targets the
Grafana upstream service directly; the dedicated Grafana oauth2-proxy deployment and service
are removed.

Keycloak group → Grafana role mapping:

| Keycloak group        | Grafana role |
|-----------------------|--------------|
| `dia-admin`         | `Admin`      |
| `dia-branch-manager` | `Editor`    |
| `dia-field-operator` | `Editor`    |
| (no matching group)   | denied       |

`GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT_MODE` is set to `true` and
`GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP` is set to `false`. This means a Keycloak-authenticated
user whose groups claim does not match `dia-admin`, `dia-branch-manager`, or
`dia-field-operator` is denied sign-in by Grafana — there is no catch-all Viewer fallback.
The `dia-read-only` group does not grant Grafana access; Grafana access is limited to the
three explicitly mapped operational groups.

The Temporal UI boundary is **not changed**: it remains behind oauth2-proxy (ADR-0034 is still
in force for that path).

### App and ops-api: Keycloak → Supabase federation

Keycloak is configured as an external OIDC provider in GoTrue. A database migration adds:
- `public.keycloak_groups_to_role(groups jsonb)` — deterministic, immutable mapping of the
  Keycloak `groups` array to the canonical `public.app_role`.
- Extended `public.handle_new_user()` trigger — for Keycloak-federated users (identified by
  `raw_app_meta_data->'providers' @> '["keycloak"]'`), reads `raw_user_meta_data->'groups'`
  and backfills `raw_app_meta_data.role` and `raw_app_meta_data.tenant` so the Supabase JWT
  carries correct claims. A `pg_trigger_depth()` guard prevents recursive invocation.
- `tenant` must be present (from Keycloak claim or default); sign-in must not succeed without
  a role-bearing session.

The `ops-api` continues to accept Supabase-issued JWTs and validates them via GoTrue as
before; no raw Keycloak token path is introduced in this story.

## Consequences

- Grafana operators must provision a `grafana-oidc-secrets-<env>` Kubernetes Secret with
  `GF_AUTH_GENERIC_OAUTH_CLIENT_ID` and `GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET`. The Grafana
  deployment (kube-prometheus-stack) must be configured to reference the OIDC ConfigMap via
  `envFrom` and the above Secret.
- The `adminAccess.grafana.oauth2Proxy.*` values stanza is removed; existing `values-test.yaml`
  and `values-prod.yaml` must use `adminAccess.grafana.nativeOidc.*` instead.
- Existing GoTrue-only users (no Keycloak federation) are unaffected; the trigger is a no-op
  for non-Keycloak providers.
- Role changes require a new sign-in to take effect (session-bound claims).
- Operators must configure Keycloak with a protocol mapper that emits a `groups` array claim
  in the id_token. The tenant claim must also be mapped from Keycloak attributes when
  multi-tenant scoping is required.

## Alternatives considered

- **Keep oauth2-proxy for Grafana (one role only):** rejected — provides no role differentiation
  (all authenticated users get admin-level access in Grafana), and adds an extra process and
  callback URL per environment.
- **Raw Keycloak token validation in ops-api:** rejected by ADR-0035/design review — avoids the
  dual-issuer complexity and keeps the existing Supabase session path intact.
- **Server-side Keycloak OIDC JWT introspection in ops-api:** deferred — acceptable in a future
  story once Keycloak is the sole IdP and the Supabase session path is retired.

## Evidence

- `charts/app/templates/grafana-oidc-config.yaml`
- `charts/app/templates/admin-grafana-route.yaml` (updated)
- `charts/app/values.yaml` (`adminAccess.grafana.nativeOidc`)
- `charts/app/values-test.yaml`, `charts/app/values-prod.yaml`
- `supabase/migrations/20260609210000_keycloak_group_role_sync.sql`
- `OPERATIONS.md` (Keycloak SSO group-to-role mapping table)
