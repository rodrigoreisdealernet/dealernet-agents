# OpenBao Production Operations Runbook (ADR-0040)

Operations for the production-grade, HA, Raft-backed OpenBao that backs runtime secret
delivery (ADR-0039 established the OpenBao + ESO path; this runbook covers running it for
real). All steps are **cluster-admin / platform-bootstrap** — the namespace-scoped
`gha-deployer` cannot perform them.

> Dev tier (`deploy/k8s/dia-vault/openbao-dev.yaml`, PR #856) is `bao server -dev` and is
> NOT covered here — it has no HA/persistence/audit and must not be used for production.

## 1. Install / bootstrap

```bash
helm repo add openbao https://openbao.github.io/openbao-helm
# Prereqs: AKS OIDC/workload identity enabled; set `server.workloadIdentity.clientId` in
# deploy/openbao/values-ha.yaml to the dedicated UAMI client ID before rendering/apply;
# cert-manager installed; deploy/openbao/certificate.yaml applied (secret openbao-tls).

# Validate NetworkPolicy + snapshot DR traffic before apply:
bash deploy/openbao/validate-networkpolicy.sh

kubectl apply -f deploy/openbao/certificate.yaml          # TLS
helm upgrade --install openbao openbao/openbao -n dia-vault -f deploy/openbao/values-ha.yaml
kubectl apply -f deploy/openbao/networkpolicy.yaml
kubectl apply -f deploy/openbao/snapshot-cronjob.yaml
```

## 2. Initialize + unseal (one time)

The committed production runtime uses the scoped Azure Key Vault seal from
`deploy/openbao/values-ha.yaml`; there is no manual-unseal steady state.

```bash
kubectl -n dia-vault exec -it openbao-0 -- bao operator init \
  -recovery-shares=5 -recovery-threshold=3
```

Distribute the 5 **recovery** key shares to named custodians (offline, split custody). Nodes
auto-unseal on restart via the Key Vault key; recovery keys are only for `generate-root` /
emergency reseal.

**After init:** enable audit, configure auth, then **revoke the initial root token**:
```bash
kubectl -n dia-vault exec -it openbao-0 -- sh -c '
  bao audit enable file file_path=/openbao/audit/audit.log     # auditStorage PVC
  bao secrets enable -path=secret -version=2 kv                 # if not already present
  bao auth enable kubernetes
  bao write auth/kubernetes/config \
    kubernetes_host="https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT" \
    kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
    token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token'
# ... create per-env read-only policies + roles (see §4) ...
bao token revoke <initial-root-token>
```

## 3. Key & token custody

- **Recovery keys** (auto-unseal): 5 shares / threshold 3, held offline by distinct
  custodians; never co-located; logged in the custody register (not the values).
- **Root token:** revoked after bootstrap. Regenerate transiently with
  `bao operator generate-root` (needs recovery-key quorum) only for break-glass.
- **Per-consumer tokens:** issued via Kubernetes auth with short TTLs; no static tokens
  except the snapshot token (least-privilege, §6).

## 4. AuthZ — least privilege, per env

```bash
printf 'path "secret/data/dia/prod/*" { capabilities = ["read"] }\n' | bao policy write dia-prod-ro -
bao write auth/kubernetes/role/dia-prod \
  bound_service_account_names=eso-vault-auth \
  bound_service_account_namespaces=dia-prod \
  policies=dia-prod-ro ttl=1h
```
One role + policy per environment; paths never overlap across envs.

## 5. Backup / restore (DR)

- Snapshots run every 6h via `deploy/openbao/snapshot-cronjob.yaml` (least-priv snapshot
  token in secret `openbao-snapshot-token`). Off-cluster encrypted upload is a TODO.
- **Restore drill** (exercise on a cadence, in a scratch namespace — never blind on prod):
  ```bash
  kubectl -n dia-vault cp <snapshot>.snap openbao-0:/tmp/restore.snap
  kubectl -n dia-vault exec -it openbao-0 -- bao operator raft snapshot restore /tmp/restore.snap
  ```

## 6. Certificate rotation

cert-manager auto-rotates `openbao-tls` 15d before expiry (`renewBefore`). After rotation,
roll the StatefulSet so peers pick up the new cert:
`kubectl -n dia-vault rollout restart statefulset/openbao` (one pod at a time; quorum-safe).

## 7. Upgrades

Bump `server.image.tag` in `values-ha.yaml`; `helm upgrade`; the StatefulSet rolls one pod at
a time. Confirm `bao operator raft list-peers` shows all voters healthy and a stable leader
between each pod. Take a snapshot first.

## 8. Break-glass

If ESO cannot sync and the app needs a secret immediately, fall back to a manually-created
Kubernetes Secret (per `charts/app/README.md`), logged in the incident ticket, and revert to
ESO delivery once OpenBao is healthy. Rotate any value exposed during break-glass.

## 9. Health checks

```bash
kubectl -n dia-vault exec openbao-0 -- bao status                 # Sealed=false, HA mode
kubectl -n dia-vault exec openbao-0 -- bao operator raft list-peers
kubectl -n dia-vault get pods,pvc
kubectl get externalsecrets -A                                       # all Ready=True
```
Alerts (see ADR-0040 §observability): sealed, no-leader/quorum, peer loss, storage near-full,
cert expiry, audit-device failure, ESO sync failure. Metrics are intentionally **not**
unauthenticated on `:8200`; add a private scraper + low-privilege token before opening any
NetworkPolicy ingress for Prometheus.
