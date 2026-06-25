# charts/app

Helm chart that deploys the two stateless application components to Kubernetes:

| Component | Description |
|-----------|-------------|
| **frontend** | Vite/React dev server (`frontend/Dockerfile`) — exposed via `Service` and optionally an `Ingress` |
| **temporal-worker** | Python Temporal worker (`temporal/Dockerfile`) — headless; no `Service` or `Ingress` |

---

## Prerequisites

- Helm 3.x
- Kubernetes 1.24+
- Runtime secrets in the target namespace (see [Required Secrets](#required-secrets))

---

## Required Secrets

Runtime secrets are delivered via **External Secrets Operator (ESO)** pulling values from
**OpenBao** (the MPL-2.0, Linux Foundation fork of HashiCorp Vault — OpenBao is API-compatible
with Vault, so ESO's `vault` provider talks to it unchanged). This is the approved delivery
path (ADR-0100). A manual fallback is available for local development where ESO is not installed.

### Approved path: ESO + OpenBao

1. **Install External Secrets Operator** in the cluster (once per cluster):

   ```bash
   helm repo add external-secrets https://charts.external-secrets.io
   helm install external-secrets external-secrets/external-secrets \
     -n external-secrets --create-namespace
   ```

2. **Create a `SecretStore`** (or `ClusterSecretStore`) that authenticates ESO against your
   OpenBao instance. Use ESO's `vault` provider (OpenBao speaks the Vault API). A namespaced
   `SecretStore` fits the namespace-scoped `gha-deployer` used in nonprod; use a
   `ClusterSecretStore` only when a cluster admin provisions it out-of-band. See the
   [ESO HashiCorp Vault provider docs](https://external-secrets.io/latest/provider/hashicorp-vault/)
   and `docs/runbooks/secret-operations.md` for rotation and break-glass handling.

   The store name/kind must match `externalSecrets.secretStore.{name,kind}` in your values
   file (dev uses `openbao-dev` / `SecretStore`). The committed bootstrap manifest is
   `deploy/k8s/dia-dev/secretstore-openbao.yaml`; the dev shape (proven against ESO v2.6.0,
   API `external-secrets.io/v1`) is:

   ```yaml
   apiVersion: external-secrets.io/v1
   kind: SecretStore
   metadata:
     name: openbao-dev
     namespace: dia-dev
   spec:
     provider:
       vault:                                       # OpenBao is Vault-API compatible
         server: "http://openbao.dia-vault.svc:8200"  # dev-grade OpenBao (HTTP, no TLS)
         path: "secret"                             # KV-v2 mount; remoteRef.key is relative to this
         version: "v2"
         auth:
           kubernetes:
             mountPath: "kubernetes"
             role: "dia-eso"                      # OpenBao role bound to the eso-vault-auth SA
             serviceAccountRef:
               name: "eso-vault-auth"               # SA in dia-dev ESO authenticates as
   ```

3. **Provision OpenBao secrets** at the paths declared in `externalSecrets.keys.*` (and, for
   KV-v2 grouped maps, the fields in `externalSecrets.properties.*`) in the environment values
   file. With the dev profile, for example:

   ```bash
   # Values come from secure input only — never literals in shell history or repo files.
   # Use `bao kv put` for initial provisioning of a new path.
   # For subsequent rotations use `bao kv patch` to update only the changed field
   # without overwriting sibling fields at the same path.
   bao kv put secret/dia/dev/runtime \
     anon-key="$SUPABASE_ANON_KEY" service-role-key="$SUPABASE_SERVICE_ROLE_KEY"
   bao kv put secret/dia/dev/acr-pull dockerconfigjson="$ACR_DOCKERCONFIGJSON"
   ```

   No literal values should appear in repo files, workflow env, or operator shell history.
   See `docs/runbooks/secret-operations.md` for the rotation procedure (`bao kv patch`).

4. **Enable ESO in the values file**:

   ```yaml
   externalSecrets:
     enabled: true
     secretStore:
       name: openbao-dev   # must match your SecretStore
       kind: SecretStore
   ```

   The chart then renders `ExternalSecret` resources that ESO syncs from OpenBao into
   namespace-scoped Kubernetes `Secret` objects. Deployment `secretKeyRef` references
   are unchanged.

### ACR image pull auth

**Intermediate state** (`externalSecrets.keys.acrPullDockerConfig` set): ESO delivers
the `acr-pull` imagePullSecret from an OpenBao secret containing the scoped-token
`.dockerconfigjson`. This replaces the previous admin-credential pull secret.

**Target state** (per ADR-0100): grant AKS kubelet managed identity the `AcrPull` role
on the registry, then remove `imagePullSecrets` from all component values and remove
`externalSecrets.keys.acrPullDockerConfig`. No pull secret is needed with managed identity.

### Fallback: manual secret creation (local / no-ESO environments)

When ESO is not available (`externalSecrets.enabled: false`, the default), create the
secrets manually. Retrieve values from the approved secret manager; **do not embed
literals in shell history or docs**.

```bash
# Read values from secure storage first, then inject via env vars.
# Never write literal credential values in commands, files, or notes.

kubectl create secret generic frontend-secrets \
  --from-literal=VITE_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY"

kubectl create secret generic temporal-worker-secrets \
  --from-literal=SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY"
```

The secret names and keys are configurable via `values.yaml`
(`frontend.secrets.*` and `temporalWorker.secrets.*`).

---

## Installing the Chart

```bash
# Render manifests to stdout (dry-run)
helm template my-release charts/app

# Render using environment profiles
helm template my-release charts/app -f charts/app/values-dev.yaml
helm template my-release charts/app -f charts/app/values-test.yaml
helm template my-release charts/app -f charts/app/values-prod.yaml

# Install into the current namespace
helm install my-release charts/app

# Install with custom image tags
helm install my-release charts/app \
  --set frontend.image.repository=ghcr.io/your-org/frontend \
  --set frontend.image.tag=1.2.3 \
  --set temporalWorker.image.repository=ghcr.io/your-org/temporal-worker \
  --set temporalWorker.image.tag=1.2.3

# Install with image digests (ADR-0010 digest-pinning — preferred for test/prod)
# When image.digest is set, the image is referenced as repo@sha256:… and the tag
# is used for audit/display only. Use pullPolicy: IfNotPresent with digests.
helm install my-release charts/app \
  --set frontend.image.repository=ghcr.io/your-org/frontend \
  --set frontend.image.digest=sha256:abc123... \
  --set frontend.image.pullPolicy=IfNotPresent \
  --set temporalWorker.image.repository=ghcr.io/your-org/temporal-worker \
  --set temporalWorker.image.digest=sha256:def456... \
  --set temporalWorker.image.pullPolicy=IfNotPresent

# Enable the frontend Ingress
helm install my-release charts/app \
  --set frontend.ingress.enabled=true \
  --set frontend.ingress.className=nginx \
  --set frontend.ingress.hosts[0].host=app.example.com \
  --set frontend.ingress.hosts[0].paths[0].path=/ \
  --set frontend.ingress.hosts[0].paths[0].pathType=Prefix
```

---

## Environment Profiles

The chart includes static values profiles for the proposed namespaces:

- `charts/app/values-dev.yaml` (`dia-dev`)
- `charts/app/values-test.yaml` (`dia-test`)
- `charts/app/values-prod.yaml` (`dia-prod`)

Use them with explicit namespace selection:

```bash
helm upgrade --install app-dev charts/app -n dia-dev -f charts/app/values-dev.yaml
helm upgrade --install app-test charts/app -n dia-test -f charts/app/values-test.yaml
helm upgrade --install app-prod charts/app -n dia-prod -f charts/app/values-prod.yaml
```

---

## Admin-only external access (oauth2-proxy boundaries)

`values-test.yaml` and `values-prod.yaml` include `adminAccess.*` defaults for:

- `oauth2-proxy` in front of Temporal UI (`--allowed-group=admin`)
- External Ingress for Temporal UI through oauth2-proxy
- External Ingress for Grafana via **Grafana native OIDC** (direct ingress; Grafana authenticates against Keycloak with group→role mapping)
- Dedicated `oauth2-proxy` boundaries for Supabase Studio, Prometheus, and Alertmanager (`--allowed-group=admin`)
- External Ingress routes for each protected surface through its corresponding proxy service

The chart keeps all admin routes disabled by default. Enable in custom values with:

```bash
# Temporal UI (still via oauth2-proxy)
helm template my-release charts/app \
  --set adminAccess.enabled=true \
  --set adminAccess.oauth2Proxy.enabled=true \
  --set adminAccess.temporalUi.enabled=true \
  --set adminAccess.temporalUi.ingress.enabled=true \
  --set adminAccess.studio.enabled=true \
  --set adminAccess.studio.oauth2Proxy.enabled=true \
  --set adminAccess.studio.ingress.enabled=true \
  --set adminAccess.prometheus.enabled=true \
  --set adminAccess.prometheus.oauth2Proxy.enabled=true \
  --set adminAccess.prometheus.ingress.enabled=true \
  --set adminAccess.alertmanager.enabled=true \
  --set adminAccess.alertmanager.oauth2Proxy.enabled=true \
  --set adminAccess.alertmanager.ingress.enabled=true

# Grafana (native OIDC — no oauth2-proxy hop)
helm template my-release charts/app \
  --set adminAccess.grafana.enabled=true \
  --set adminAccess.grafana.nativeOidc.enabled=true \
  --set adminAccess.grafana.nativeOidc.issuerUrl=https://keycloak.example.com/realms/dia \
  --set adminAccess.grafana.nativeOidc.redirectUrl=https://grafana.example.com/login/generic_oauth \
  --set adminAccess.grafana.ingress.enabled=true
```

Required secret keys for **Temporal UI oauth2-proxy** (in `oauth2-proxy-secrets-<env>`):

- `OAUTH2_PROXY_CLIENT_ID`
- `OAUTH2_PROXY_CLIENT_SECRET`
- `OAUTH2_PROXY_COOKIE_SECRET`

Required secret keys for **Grafana native OIDC** (in `grafana-oidc-secrets-<env>`):

- `GF_AUTH_GENERIC_OAUTH_CLIENT_ID`
- `GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET`

When `adminAccess.grafana.nativeOidc.enabled=true`, the app chart renders the Grafana ingress
routing directly to the upstream. The `GF_AUTH_GENERIC_OAUTH_*` ConfigMap that Grafana consumes
at runtime is rendered by the **observability chart** (`charts/observability`) in the
`dia-observability` namespace where Grafana runs. Configure the kube-prometheus-stack Grafana
deployment to consume that ConfigMap via `extraEnvFrom` and mount the above Secret directly.

**Keycloak group → Grafana role mapping** (rendered in the ConfigMap):

| Keycloak group | Grafana role |
|---|---|
| `dia-admin` | `Admin` |
| `dia-branch-manager` | `Editor` |
| `dia-field-operator` | `Editor` |
| `dia-read-only` | denied |
| (no matching group) | denied |

See [ADR-0036](../../docs/adrs/0036-keycloak-sso-consumer-rbac.md) and `OPERATIONS.md` for full context.

Each protected surface should use its own Keycloak client + callback URL + cookie secret,
and downstream services should only trust identity headers (`X-Auth-Request-User`,
`X-Auth-Request-Email`) from the oauth2-proxy boundary.

---

## Values Reference

### Global

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `nameOverride` | string | `""` | Override chart name |
| `fullnameOverride` | string | `""` | Override full release name |
| `imageRegistry` | string | `""` | Global image registry prefix (e.g. `ghcr.io`) |

### Frontend

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `frontend.replicaCount` | int | `1` | Number of pod replicas |
| `frontend.image.registry` | string | `""` | Registry (overrides `imageRegistry`) |
| `frontend.image.repository` | string | `"your-org/frontend"` | Image repository |
| `frontend.image.tag` | string | `"latest"` | Image tag |
| `frontend.image.pullPolicy` | string | `"IfNotPresent"` | Image pull policy |
| `frontend.imagePullSecrets` | list | `[]` | Pull-secret names |
| `frontend.podSecurityContext` | object | `runAsNonRoot`, uid/gid `101`, `seccompProfile: RuntimeDefault` | Pod security context |
| `frontend.securityContext` | object | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]` | Container security context |
| `frontend.service.type` | string | `"ClusterIP"` | Service type |
| `frontend.service.port` | int | `3000` | Service port |
| `frontend.ingress.enabled` | bool | `false` | Enable Ingress |
| `frontend.ingress.className` | string | `""` | Ingress class |
| `frontend.ingress.annotations` | object | `{}` | Ingress annotations |
| `frontend.ingress.hosts` | list | see values.yaml | Ingress host rules |
| `frontend.ingress.tls` | list | `[]` | Ingress TLS config |
| `frontend.resources` | object | 100m/128Mi req, 500m/512Mi lim | Pod resource requests/limits |
| `frontend.livenessProbe` | object | HTTP GET `/` :3000 | Liveness probe config |
| `frontend.readinessProbe` | object | HTTP GET `/` :3000 | Readiness probe config |
| `frontend.env.supabaseUrl` | string | `"http://supabase:8000"` | `VITE_SUPABASE_URL` value |
| `frontend.env.apiUrl` | string | `"http://supabase:8000/functions/v1"` | `VITE_API_URL` value |
| `frontend.secrets.supabaseAnonKey.secretName` | string | `"frontend-secrets"` | Secret containing anon key |
| `frontend.secrets.supabaseAnonKey.key` | string | `"VITE_SUPABASE_ANON_KEY"` | Key within the Secret |

### Temporal Worker

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `temporalWorker.replicaCount` | int | `1` | Number of pod replicas |
| `temporalWorker.image.registry` | string | `""` | Registry (overrides `imageRegistry`) |
| `temporalWorker.image.repository` | string | `"your-org/temporal-worker"` | Image repository |
| `temporalWorker.image.tag` | string | `"latest"` | Image tag |
| `temporalWorker.image.pullPolicy` | string | `"IfNotPresent"` | Image pull policy |
| `temporalWorker.imagePullSecrets` | list | `[]` | Pull-secret names |
| `temporalWorker.podSecurityContext` | object | `runAsNonRoot`, uid/gid `10001`, `seccompProfile: RuntimeDefault` | Pod security context |
| `temporalWorker.securityContext` | object | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]` | Container security context |
| `temporalWorker.resources` | object | 100m/128Mi req, 500m/512Mi lim | Pod resource requests/limits |
| `temporalWorker.livenessProbe` | object | exec `python -c "import os; os.kill(1, 0)"` | Liveness probe config |
| `temporalWorker.readinessProbe` | object | exec `python -c "import os; os.kill(1, 0)"` | Readiness probe config |
| `temporalWorker.temporal.address` | string | `"temporal:7233"` | Temporal server address |
| `temporalWorker.temporal.namespace` | string | `"default"` | Temporal namespace |
| `temporalWorker.temporal.taskQueue` | string | `"main"` | Temporal task queue |
| `temporalWorker.supabase.url` | string | `"http://supabase:8000"` | `SUPABASE_URL` value |
| `temporalWorker.secrets.supabaseServiceRoleKey.secretName` | string | `"temporal-worker-secrets"` | Secret containing service-role key |
| `temporalWorker.secrets.supabaseServiceRoleKey.key` | string | `"SUPABASE_SERVICE_ROLE_KEY"` | Key within the Secret |

### Operations API

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `opsApi.replicaCount` | int | `1` | Number of pod replicas |
| `opsApi.image.registry` | string | `""` | Registry (overrides `imageRegistry`) |
| `opsApi.image.repository` | string | `"your-org/temporal-worker"` | Image repository (same image as worker) |
| `opsApi.image.tag` | string | `"latest"` | Image tag |
| `opsApi.image.pullPolicy` | string | `"Always"` | Image pull policy |
| `opsApi.imagePullSecrets` | list | `[]` | Pull-secret names |
| `opsApi.podSecurityContext` | object | `runAsNonRoot`, uid/gid `10001`, `seccompProfile: RuntimeDefault` | Pod security context |
| `opsApi.securityContext` | object | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]` | Container security context |
| `opsApi.service.type` | string | `"ClusterIP"` | Service type |
| `opsApi.service.port` | int | `8000` | Service port |
| `opsApi.resources` | object | 100m/128Mi req, 500m/512Mi lim | Pod resource requests/limits |
| `opsApi.livenessProbe` | object | HTTP GET `/api/ops/health` :8000 | Liveness probe config |
| `opsApi.readinessProbe` | object | HTTP GET `/api/ops/health` :8000 | Readiness probe config |
| `opsApi.temporal.address` | string | `"temporal:7233"` | Temporal server address |
| `opsApi.temporal.namespace` | string | `"default"` | Temporal namespace |
| `opsApi.supabase.url` | string | `"http://supabase:8000"` | `SUPABASE_URL` value |
| `opsApi.secrets.supabaseServiceRoleKey.secretName` | string | `"temporal-worker-secrets"` | Secret containing service-role key |
| `opsApi.secrets.supabaseServiceRoleKey.key` | string | `"SUPABASE_SERVICE_ROLE_KEY"` | Key within the Secret |

### Temporal UI

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `temporalUi.enabled` | bool | `false` | Deploy the in-cluster Temporal UI |
| `temporalUi.image.repository` | string | `"temporalio/ui"` | Temporal UI image repository |
| `temporalUi.image.tag` | string | `"2.31.2"` | Temporal UI image tag |
| `temporalUi.service.port` | int | `8080` | Temporal UI service port |
| `temporalUi.temporalGrpcAddress` | string | `"temporal:7233"` | Temporal server address |
| `temporalUi.temporalDefaultNamespace` | string | `"default"` | Default namespace shown by the UI |

### External Secrets (ESO)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `externalSecrets.enabled` | bool | `false` | Enable ESO ExternalSecret rendering |
| `externalSecrets.refreshInterval` | string | `"1h"` | ESO sync interval (Go duration) |
| `externalSecrets.secretStore.name` | string | `"openbao"` | Name of the ClusterSecretStore or SecretStore |
| `externalSecrets.secretStore.kind` | string | `"ClusterSecretStore"` | Kind of the store |
| `externalSecrets.keys.supabaseAnonKey` | string | `"supabase-anon-key"` | OpenBao path for the Supabase anon key |
| `externalSecrets.keys.supabaseServiceRoleKey` | string | `"supabase-service-role-key"` | OpenBao path for the service-role key |
| `externalSecrets.keys.acrPullDockerConfig` | string | `""` | OpenBao path for `.dockerconfigjson`; empty = skip ACR pull ESO |
| `externalSecrets.keys.oauth2ProxyClientId` | string | `""` | OpenBao path for oauth2-proxy client ID |
| `externalSecrets.keys.oauth2ProxyClientSecret` | string | `""` | OpenBao path for oauth2-proxy client secret |
| `externalSecrets.keys.oauth2ProxyCookieSecret` | string | `""` | OpenBao path for oauth2-proxy cookie secret |
| `externalSecrets.properties.supabaseAnonKey` | string | `""` | KV-v2 field for anon key (empty = flat layout) |
| `externalSecrets.properties.supabaseServiceRoleKey` | string | `""` | KV-v2 field for service-role key |
| `externalSecrets.properties.acrPullDockerConfig` | string | `""` | KV-v2 field for dockerconfigjson |
| `externalSecrets.properties.oauth2ProxyClientId` | string | `""` | KV-v2 field for oauth2-proxy client ID |
| `externalSecrets.properties.oauth2ProxyClientSecret` | string | `""` | KV-v2 field for oauth2-proxy client secret |
| `externalSecrets.properties.oauth2ProxyCookieSecret` | string | `""` | KV-v2 field for oauth2-proxy cookie secret |

---

## Validation

```bash
# Lint the chart
helm lint charts/app

# Render all manifests with default values
helm template my-release charts/app

# Render with ingress enabled
helm template my-release charts/app --set frontend.ingress.enabled=true
```

`PR Validation` also checks that the current `temporalUi.image.tag` is already
mirrored into `${ACR_LOGIN_SERVER}/temporalio/ui:*`, and the
`Mirror Temporal UI image` workflow keeps that ACR copy refreshed on `main`.
