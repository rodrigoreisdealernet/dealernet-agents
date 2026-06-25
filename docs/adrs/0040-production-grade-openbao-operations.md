# ADR-0040: Production-grade OpenBao operations (HA, auto-unseal, DR)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Repository owner, Platform engineer, Security reviewer
- **Supersedes / Superseded by:** Extends ADR-0039 (OpenBao + ESO runtime secret delivery)
- **Decision note:** Accepted by security review on 2026-06-10 after the committed runtime pinned the scoped Azure Key Vault workload-identity seal path, authenticated-only telemetry, and explicit snapshot NetworkPolicy allowance.

## Context

ADR-0039 established OpenBao + External Secrets Operator (ESO) as the runtime secret-delivery
path and was proven end-to-end in `dia-dev` against a **dev-grade** OpenBao: `bao server -dev`
(in-memory, single replica, auto-unsealed, HTTP). That tier is explicitly not production secret
custody — a pod restart wipes all data, there is no HA, no TLS, no audit trail, and no backup.

Making secret delivery production-quality requires hardening OpenBao itself into a highly
available, durable, observable, recoverable service. Two environment constraints (confirmed
on `aks-selfheal-staging`, which currently hosts the Dealernet namespaces) shape the decision:

1. **No scoped auto-unseal identity exists yet.** The standard AKS Key Vault seal path needs
   a dedicated workload identity plus one narrow Key Vault key grant before bootstrap can use
   it.
2. **Single availability zone.** All current nodes are in one zone, so the present cluster
   can provide node-level HA only, not zone-fault tolerance. There is no `dia-prod`
   namespace yet; prod placement is an open question.

Additionally, the CI deploy identity (`gha-deployer`) is namespace-scoped and cannot create
cluster-scoped resources, so production OpenBao must be installed and operated through a
separate, elevated platform-bootstrap path — not the app deploy pipeline.

## Decision

We operate production OpenBao as a **highly available, Raft-backed StatefulSet** deployed via
the official OpenBao Helm chart, with the following production requirements:

- **HA + storage:** 3-node (min) Raft integrated storage; per-replica PVC on Azure Premium
  SSD (`managed-csi-premium`); pod anti-affinity; PodDisruptionBudget; Raft autopilot;
  pinned image version; topology spread across zones once a multi-zone pool exists.
- **Auto-unseal:** automated, no human-in-the-loop on restart/scale, using **one narrowly
  scoped Azure Key Vault key** (`seal "azurekeyvault"`) and **Azure Workload Identity
  Federation**. The committed runtime in `deploy/openbao/values-ha.yaml` uses:
  - `vault_name = "dia-openbao-prod"`
  - `key_name = "openbao-prod-unseal"`
  - `use_workload_identity = "true"` with the projected token file
    `/var/run/secrets/azure/tokens/azure-identity-token`
  - server pod label `azure.workload.identity/use: "true"`
  - server service-account annotation rendered from `server.workloadIdentity.clientId`
    to `azure.workload.identity/client-id: <OpenBao UAMI client id>`
  The Key Vault grant is limited to **`wrapKey`, `unwrapKey`, `get`** on that single key.
  No static Azure credentials are committed to the repo. AWS KMS and Transit remain fallback
  designs if Azure cannot provide the scoped grant, but they are not the committed production
  runtime for this ADR. Shamir manual unseal of the main cluster is **rejected**: it requires
  N operators on every restart and is incompatible with autonomous/factory operations and
  autoscaling.
- **Key custody:** recovery keys (auto-unseal) Shamir-split among named custodians and stored
  offline; OpenBao initialized once; the initial **root token is revoked** after bootstrap.
  Steady-state access is via auth methods and least-privilege tokens only.
- **TLS everywhere:** cert-manager-issued server certificates and Raft peer TLS; ESO connects
  over `https` with a `caProvider`/`caBundle`. Certificates rotate automatically.
- **AuthN/Z least privilege:** Kubernetes auth; one role per consumer; read-only policies
  scoped to exact paths (`secret/data/dia/<env>/*`); short token TTLs; no wildcard or root
  access in steady state.
- **Audit:** an audit device enabled and shipped to the log pipeline; verified to contain no
  secret values; retained per policy.
- **Backup / DR:** scheduled Raft snapshots to encrypted, off-cluster storage (Azure Blob),
  with retention and a **tested restore runbook** exercised on a cadence.
- **Observability:** OpenBao telemetry is enabled, but metrics stay on the authenticated
  management path — **not** an unauthenticated shared listener. A future Prometheus scrape
  must use a dedicated low-privilege metrics token and an explicit private NetworkPolicy
  allow-list once the monitoring stack exists. Alerts still cover sealed state, loss of
  leader/quorum, peer loss, storage near-full, certificate expiry, audit-device failure, and
  ESO sync failures.
- **Networking:** default-deny NetworkPolicy; only ESO, Raft peers, and the snapshot CronJob
  reach `:8200`; named operators require explicit allow-list. OpenBao stays out of the service
  mesh (no sidecar injection), as today.
- **Environment isolation:** **production is a separate OpenBao trust domain** (its own
  unseal key, audit, and policies), ideally on the production cluster; dev/test may share one
  instance with strict path/policy separation.
- **Bootstrap pipeline:** a distinct, cluster-admin GitOps path (Argo/Flux or a gated admin
  workflow) installs and upgrades cert-manager, ESO, OpenBao, SecretStores, and NetworkPolicies.
  Everything except secret values and unseal/recovery keys is committed to the repo.

Status is **Accepted**. Production cluster placement / zone topology still requires an owner
decision, and bootstrap still depends on the narrow Azure grant plus the bootstrap owner being
assigned, but those are rollout prerequisites rather than reasons to leave the decision itself
unaccepted.

### The scoped-AKV-key ask (to unblock auto-unseal option 1)

Request from whoever owns Azure — note this grants *no* access to read or store application
secrets, only the ability to wrap/unwrap OpenBao's seal key:

- One Key Vault (existing or new) and **one key** (`openbao-prod-unseal`, RSA-2048+ or AES,
  soft-delete + purge-protection enabled) in vault `dia-openbao-prod`.
- A dedicated user-assigned managed identity for the OpenBao server pods, federated via Azure
  Workload Identity, with an access policy limited to **`wrapKey`, `unwrapKey`, `get`** on
  that single key — nothing else.
- AKS OIDC issuer / workload identity enabled on the target cluster so the OpenBao server
  service account annotation can project the federated token file consumed by the seal stanza.

## Consequences

### Positive
- Secret delivery survives pod/node failure, restarts, and upgrades without manual unsealing.
- Durable storage + tested snapshots give a real recovery path; audit + telemetry make the
  store observable and compliant.
- Least-privilege auth and per-env trust domains bound the blast radius of any compromise.
- The scoped-key ask keeps the "no AKV for secrets" constraint intact while still using Azure
  for the one thing it is best at (key wrapping).
- The bootstrap path now explicitly depends on AKS workload identity being enabled and the
  dedicated UAMI client ID being wired into the server service account annotation.

### Negative / constraints
- OpenBao becomes standing stateful infrastructure the platform team must run, upgrade, back
  up, and monitor — operational burden a managed Key Vault would have absorbed.
- True zone-level HA requires a multi-zone node pool (or dedicated prod cluster) that does not
  exist today; until then prod HA is node-level only.
- Auto-unseal depends on a (small) Azure grant plus AKS workload identity enablement; AWS KMS
  and Transit remain fallback designs if that bootstrap cannot be delivered.
- A separate cluster-admin bootstrap path must be established and secured, distinct from the
  namespace-scoped app deployer.

## Alternatives considered

- **Stay on the dev-grade `-dev` server.** Rejected: no HA, no persistence, no audit/backup —
  unacceptable for production credential custody.
- **Shamir manual unseal of the HA cluster.** Rejected: incompatible with autonomous ops and
  autoscaling (humans required on every restart).
- **Managed Vault (HCP Vault).** External dependency, licensing, and cost; does not fit the
  self-hosted, in-cluster posture and the BSL-avoidance rationale of ADR-0039.
- **Key Vault CSI driver instead of ESO.** Already rejected in ADR-0039 (breaks the
  `secretKeyRef` contract; not backend-agnostic).

## Interfaces changed (when implemented)

- `deploy/openbao/values-ha.yaml` — OpenBao Helm chart production values (Raft HA, TLS, audit,
  authenticated-only telemetry, Azure Key Vault workload-identity seal stanza).
- `deploy/openbao/networkpolicy.yaml`, `deploy/openbao/snapshot-cronjob.yaml`,
  `deploy/openbao/certificate.yaml` — supporting production manifests.
- `deploy/k8s/<ns>/secretstore-openbao.yaml` — per-env SecretStore (https + caProvider).
- `docs/runbooks/openbao-operations.md` — unseal, snapshot/restore, cert rotation, break-glass.

## Evidence

- ADR-0039 and PR #856 (dev tier, verified live in `dia-dev`).
- Platform epic: secrets-management prod-hardening (links #125, #196).
- Cluster facts gathered 2026-06-10 on `aks-selfheal-staging`: no AKV, single-zone nodes,
  no cert-manager, no Prometheus operator, `managed-csi-premium` available, ESO v2.6.0
  (serves `external-secrets.io/v1` only).
