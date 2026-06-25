# ADR-0100: OpenBao + External Secrets Operator as runtime secret-delivery path

- **Status:** Accepted
- **Date:** 2026-06-18
- **Reviewed:** 2026-06-18
- **Deciders:** Repository owner, Security reviewer, Platform engineer
- **Supersedes / Superseded by:** —

## Context

Runtime credentials (Supabase anon key, Supabase service-role key, ACR pull credentials,
oauth2-proxy OIDC secrets) were delivered as plain Kubernetes `Secret` objects created
manually with `kubectl create secret generic`. The chart README instructed operators to
embed literal credential values in shell commands, which created credential-sprawl risk:
secrets could leak through shell history, operator notes, or repo drift, and there was no
systematic rotation or audit trail.

A repo-wide static search found no `ExternalSecret`, `SecretProviderClass`, or external
secret-manager integration in the chart or workflow surfaces prior to this ADR.

Additionally, image pull auth used an ACR **admin** credential stored in the `acr-pull`
Kubernetes Secret. Admin credentials carry registry-wide write scope and do not expire
without manual rotation; they expand blast radius from container-image operations into
full registry compromise.

Two constraints shaped the choice of secret-manager backend:

- **No Azure Key Vault access.** The team cannot provision or administer an AKV instance,
  so a cloud-managed Key Vault is not an available source of truth.
- **Licensing.** HashiCorp Vault was re-licensed under the Business Source License (BSL)
  in August 2023, which is not an OSI-approved open-source license and carries
  use-restriction terms the team will not accept for core infrastructure.

## Decision

We adopt **OpenBao as the runtime secret source of truth** and **External Secrets Operator
(ESO)** as the delivery path that syncs OpenBao secrets into namespace-scoped Kubernetes
`Secret` objects.

OpenBao is the MPL-2.0, Linux Foundation–governed fork of the last open-source Vault
release. It is API-compatible with Vault, so ESO's existing **`vault` provider** connects
to OpenBao with no provider-side changes. We use a KV-v2 secrets engine; secrets are stored
as **grouped maps** (one path holds multiple fields).

The Helm chart gains a conditional `ExternalSecret` template (disabled by default for
backward compatibility). When `externalSecrets.enabled: true`, the chart renders
`ExternalSecret` resources instead of requiring operators to manually create secrets. The
`secretKeyRef` references in Deployment manifests remain unchanged — ESO-delivered secrets
are identical in name and key structure to manually created ones.

Because OpenBao KV-v2 returns a map per path, each `ExternalSecret` `remoteRef` carries two
pieces of addressing: `key` (the secret **path**, from `externalSecrets.keys.*`) and an
optional `property` (the **field** within the map at that path, from
`externalSecrets.properties.*`). When `properties.*` is empty the `property` is omitted, so
the same template also supports a flat one-value-per-path layout without modification.

ACR pull auth is migrated in two steps:
1. **Intermediate**: The `acr-pull` Kubernetes Secret is ESO-delivered from OpenBao (an
   OpenBao secret stores the scoped token's `.dockerconfigjson`, replacing the admin
   credential).
2. **Target**: AKS kubelet-managed identity (or workload identity with ACR pull role
   assignment) eliminates the need for any explicit image-pull secret. `imagePullSecrets`
   will then be set to `[]` in all profiles. (This step is independent of the secret
   backend — it removes the pull secret entirely rather than re-sourcing it.)

## Consequences

### Positive
- No dependency on Azure Key Vault, which the team cannot provision; the secret backend is
  self-hostable in-cluster.
- The backend is genuinely open source (MPL-2.0), avoiding the Vault BSL use restrictions.
- Secret values never appear in repo files, operator shell history, or workflow logs.
- KV-v2 provides versioned writes (rollback material) and an audit log; ESO syncs on a
  configurable interval, so rotation in OpenBao propagates to pods without manual `kubectl`.
- Grouped-map storage keeps related credentials on a single path, so a rotation can patch
  one field without disturbing siblings.
- The chart stays backward compatible: operators who cannot install ESO can still provide
  secrets manually (`externalSecrets.enabled: false`, the default).
- ACR admin credentials are replaced by a scoped token (intermediate) and eventually by
  managed identity (no pull secret needed).

### Negative / constraints
- OpenBao is now an operational service the team must run, seal/unseal, back up, and patch —
  responsibility a cloud-managed Key Vault would have absorbed.
- ESO is an operator-level dependency. It must be installed in the cluster before
  `externalSecrets.enabled: true` is used (see runbook).
- A `ClusterSecretStore` or per-namespace `SecretStore` using the `vault` provider must be
  configured by platform engineering, including OpenBao Kubernetes-auth role binding.
- Operators must provision OpenBao secrets at the exact paths/fields declared in values
  files before deploying with ESO enabled.

## Alternatives considered

**Azure Key Vault (AKV) + ESO**: The cloud-managed Key Vault offloads operation, HA, and
patching. Rejected because the team has no AKV access to provision or administer, making it
unavailable as the source of truth regardless of its merits.

**HashiCorp Vault (OSS) + ESO**: Functionally the same integration as OpenBao (OpenBao is
its fork). Rejected on licensing: Vault's post-2023 BSL is not OSI-approved and imposes
use restrictions the team will not accept for core infrastructure. OpenBao preserves the
Vault API and tooling under MPL-2.0.

**Key Vault CSI driver (`SecretProviderClass`)**: Mounts secrets as files/env vars directly
via CSI. Does not create standard Kubernetes `Secret` objects and requires pod-level volume
mounts. ESO was preferred because it preserves the existing `secretKeyRef` contract with
zero changes to Deployment manifests, and is backend-agnostic.

**Sealed Secrets / SOPS**: Encrypt secrets at rest in the repository. Does not remove
secret literals from the operator provisioning workflow and adds key-management complexity
without OpenBao's audit trail and dynamic rotation.

## Interfaces changed

- `charts/app/values.yaml` — `externalSecrets` section: store defaults to `openbao`; `keys.*`
  now denote OpenBao paths; new `properties.*` map for KV-v2 fields.
- `charts/app/templates/external-secrets.yaml` — conditional template; each `remoteRef`
  emits `property` when `externalSecrets.properties.*` is set.
- `charts/app/values-dev.yaml`, `values-test.yaml`, `values-prod.yaml` — `externalSecrets`
  blocks: `openbao-<env>` store names, grouped-map paths (`dia/<env>/runtime`,
  `dia/<env>/acr-pull`, `dia/<env>/oauth2-proxy`) and per-field `properties`.
- `charts/app/README.md` — ESO + OpenBao setup, sample `vault`-provider `SecretStore`,
  KV-v2 path/field provisioning, values table including `properties.*`.
- `docs/runbooks/secret-operations.md` — OpenBao path/field convention table, KV-v2 rotation
  (`bao kv patch` / `bao kv destroy`), break-glass, and store health checks.
- `deploy/k8s/dia-dev/secretstore-openbao.yaml` — namespaced `SecretStore` for dev.
- `deploy/k8s/dia-vault/openbao-dev.yaml` — dev-grade OpenBao (in-memory, bootstrap docs).
- `deploy/k8s/rbac-nonprod.yaml` — `externalsecrets` RBAC for the `gha-deployer` role.

## Test strategy

- `charts/app/ci-test.sh` — assertions:
  - `externalSecrets.enabled=false` (default) renders no `ExternalSecret` resources in any
    profile.
  - `externalSecrets.enabled=true` renders correctly named `ExternalSecret` resources with
    the right `secretStoreRef`, `remoteRef.key`, target secret names, and policies.
  - `remoteRef.property` is **omitted** when `properties.*` is unset (flat layout) and
    **rendered** when set (KV-v2 grouped map), including the dev profile's shared
    `dia/dev/runtime` path with distinct `anon-key` / `service-role-key` fields and the
    `dia/dev/acr-pull` `dockerconfigjson` field.
  - ACR pull `ExternalSecret` renders `kubernetes.io/dockerconfigjson` type only when
    `acrPullDockerConfig` is set.
  - Partial oauth2-proxy key config renders no `ExternalSecret`.
- Static validation: `helm lint` passes for all profiles with ESO enabled and disabled.

## Evidence

- `charts/app/templates/external-secrets.yaml`, `charts/app/values{,-dev,-test,-prod}.yaml`.
- `deploy/k8s/dia-dev/secretstore-openbao.yaml`, `deploy/k8s/dia-vault/openbao-dev.yaml`.
- `charts/app/ci-test.sh` — assertions cover ESO enabled/disabled, property rendering,
  ACR pull, dev profile path alignment, and partial oauth2-proxy safety gate.
