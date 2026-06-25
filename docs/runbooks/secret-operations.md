# Secret Operations Runbook (Demo + Deployment Path)

## Scope and controls

This runbook covers secret operations for credentials touched by the Kubernetes
deployment path and demo environment access:

- Runtime app credentials (`VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) delivered
  via OpenBao + External Secrets Operator (ADR-0100)
- Demo Supabase/app credentials (`DEMO_ADMIN_PASS`, `DEMO_OPERATOR_PASS`, and any split manager/read-only variants)
- Supabase Studio dashboard credentials (`supabase-dashboard` in `dia-supabase`)
- Registry/deploy credentials currently used by workflows (`ACR_USERNAME`/`ACR_PASSWORD`, `KUBE_CONFIG_DEV`, `KUBE_CONFIG_DEV_DB_BOOTSTRAP`) and their OIDC/workload-identity replacement path

Rules:

1. Never print resolved values in repo files, issues, PR comments, workflow summaries, or logs.
2. Keep repo-controlled surfaces on secret **references only**.
3. Frontend/browser surfaces must never receive admin/service-role credentials.

---

## OpenBao + ESO secret delivery (ADR-0100)

Runtime app secrets (`VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and the
ACR pull `.dockerconfigjson` when not using managed identity) are stored in **OpenBao**
(KV-v2, accessed via ESO's `vault` provider) and synced into namespace-scoped Kubernetes
`Secret` objects by External Secrets Operator. Paths below are relative to the KV-v2 mount
configured on the `SecretStore` (e.g. mount `secret`).

### OpenBao path + field convention

Runtime secrets are stored as KV-v2 **grouped maps**: one path holds multiple fields
(`externalSecrets.keys.*` selects the path, `externalSecrets.properties.*` selects the field).

| Environment | OpenBao path | Field | Kubernetes secret name | Key |
|---|---|---|---|---|
| dev | `dia/dev/runtime` | `anon-key` | `frontend-secrets-dia-dev` | `VITE_SUPABASE_ANON_KEY` |
| dev | `dia/dev/runtime` | `service-role-key` | `temporal-worker-secrets-dia-dev` | `SUPABASE_SERVICE_ROLE_KEY` |
| dev | `dia/dev/acr-pull` | `dockerconfigjson` | `acr-pull` ¹ | `.dockerconfigjson` |
| test | `dia/test/runtime` | `anon-key` | `frontend-secrets-dia-test` | `VITE_SUPABASE_ANON_KEY` |
| test | `dia/test/runtime` | `service-role-key` | `temporal-worker-secrets-dia-test` | `SUPABASE_SERVICE_ROLE_KEY` |
| prod | `dia/prod/runtime` | `anon-key` | `frontend-secrets-dia-prod` | `VITE_SUPABASE_ANON_KEY` |
| prod | `dia/prod/runtime` | `service-role-key` | `temporal-worker-secrets-dia-prod` | `SUPABASE_SERVICE_ROLE_KEY` |

¹ The `acr-pull` imagePullSecret has no environment suffix because all workload components
reference it by that exact name via `imagePullSecrets`. The name is fixed by the Kubernetes
imagePullSecret contract (hardcoded in the template target). App secrets carry env suffixes
to prevent cross-namespace leakage; the pull secret is namespace-scoped regardless and
does not carry credentials used inside the app.

### ESO rotation procedure

Rotation via OpenBao does **not** require changes to this repo. The sequence is:

1. **Write a new secret version** in OpenBao (KV-v2 versions each write automatically, so
   rollback material is preserved — patch only the rotated field to keep siblings intact):
   ```bash
   bao kv patch secret/dia/dev/runtime anon-key="$NEW_ANON_KEY"
   ```
2. **Wait for ESO sync** (default: `refreshInterval: 1h`; force an immediate sync with
   `kubectl annotate externalsecret <name> -n <ns> force-sync=$(date +%s) --overwrite`).
3. **Verify** the Kubernetes Secret has updated:
   ```bash
   kubectl get secret frontend-secrets-dia-dev -n dia-dev \
     -o jsonpath='{.metadata.resourceVersion}'
   ```
4. **Restart affected pods** if the app does not watch for secret changes at runtime:
   ```bash
   kubectl rollout restart deployment/<name> -n <ns>
   ```
5. **Destroy the old KV-v2 version** (`bao kv destroy -versions=<n> secret/dia/dev/runtime`)
   after verifying the new one is serving traffic.
6. **Record** the rotation timestamp, operator, and result in the incident/change log.
   Never include secret values in the log.

### OpenBao break-glass (ESO store unavailable)

If ESO is unhealthy and secrets cannot sync, follow the manual fallback in the
[Fallback: manual secret creation](#fallback-manual-secret-creation) section of
`charts/app/README.md`. Revert to ESO-managed delivery as soon as ESO is restored.
Retain the break-glass window in the incident log; rotate any manually-created secrets
that were used outside the normal ESO path.

### SecretStore health check

```bash
# dev uses a namespaced SecretStore (openbao-dev in dia-dev)
kubectl -n dia-dev get secretstore openbao-dev \
  -o jsonpath='{.status.conditions[*].type}={.status.conditions[*].status}{"\n"}'   # want Ready=True
kubectl -n dia-vault get deploy openbao        # OpenBao up
kubectl -n external-secrets get pods             # ESO controller up
# ESO-synced secrets report sync status in ExternalSecret .status.conditions
kubectl get externalsecrets -A
```

## Initial migration + cutover (manual Secret → OpenBao/ESO)

This is the **one-time** procedure to move an environment from manually-created Kubernetes
Secrets to ESO delivery. ESO's `creationPolicy: Owner` adopts existing secrets rather than
conflicting with them, so this is zero-disruption when done in order:

1. Bootstrap OpenBao and provision secret values (see `deploy/k8s/dia-vault/openbao-dev.yaml`
   bootstrap comments and the path/field table above).
2. Apply the `SecretStore` and `eso-vault-auth` SA:
   ```bash
   kubectl apply -f deploy/k8s/dia-dev/secretstore-openbao.yaml
   ```
3. Verify the `SecretStore` reports `Ready=True`.
4. Set `externalSecrets.enabled: true` in the environment values file and deploy:
   ```bash
   helm upgrade --install app-dev charts/app -n dia-dev \
     -f charts/app/values-dev.yaml \
     --set externalSecrets.enabled=true
   ```
5. ESO syncs and takes ownership of the Kubernetes Secrets. Verify:
   ```bash
   kubectl get externalsecrets -n dia-dev
   kubectl get secret frontend-secrets-dia-dev -n dia-dev -o yaml | grep -A2 ownerReferences
   ```
6. Remove any manually-created backup copies of the secrets from operator notes/history.

---

## Credential custody and ownership

| Credential set | Primary owner | Storage location | Consumers | Rotation cadence |
|---|---|---|---|---|
| Demo app sign-in credentials (`DEMO_*_PASS`) | Maintainers + security reviewer | Approved GitHub secret store for the target environment (per #125) | `scripts/seed-demo-users.sh` seeding flow | Every 30 days and on any exposure suspicion |
| Supabase dashboard credentials (`supabase-dashboard` secret) | Platform + maintainer approver | Kubernetes secret in `dia-supabase` sourced from approved secret manager path | Break-glass Studio access only | Every 30 days and after each break-glass use |
| Registry publish credentials (`ACR_USERNAME`, `ACR_PASSWORD`) | Platform engineer | GitHub Actions secret store | `.github/workflows/build-images.yml` push gate | Every 60 days until replaced by workload identity |
| Deploy auth (`KUBE_CONFIG_DEV`) | Platform engineer | GitHub environment secret store (`dev`) | `.github/workflows/deploy-dev.yml` | Every 30 days until replaced by OIDC/workload identity |
| DB bootstrap auth (`KUBE_CONFIG_DEV_DB_BOOTSTRAP`) | Platform engineer + maintainer approver | GitHub repository secret store | `.github/workflows/deploy-dev.yml` `bootstrap-db` job only | Every 30 days until replaced by OIDC/workload identity |

The `bootstrap-db` gate also depends on two **repo variables** that are not secret but
must be updated in the same change window as the scoped kubeconfig. Both values must
stay explicit and operator-supplied for the intended least-privilege bootstrap boundary:

- `DIA_DB_BOOTSTRAP_USER = <least-privilege bootstrap role>`
- `DIA_DB_BOOTSTRAP_DB_NAME = <bootstrap target database>`

## Rotation rollout plan (required sequence)

Perform rotation in a maintainer-coordinated window.

1. **Prepare new values**
   - Generate new credentials in the approved secret manager flow.
   - Stage them in secret storage only (never in repo/workflow YAML).
2. **Update secret references**
   - Update GitHub environment/repository secret entries used by `build-images.yml` and `deploy-dev.yml`.
   - For DB bootstrap rotations, update `KUBE_CONFIG_DEV_DB_BOOTSTRAP` and confirm
     the paired `DIA_DB_BOOTSTRAP_USER` and `DIA_DB_BOOTSTRAP_DB_NAME` values
     still point at the intended explicit least-privilege bootstrap role/database.
   - Update Kubernetes-backed dashboard secret source (`supabase-dashboard`).
3. **Apply demo credential rotation**
   - Re-run `scripts/seed-demo-users.sh` using only new `DEMO_*_PASS` values from secure env injection.
   - Keep passwords out of shell history and logs.
4. **Invalidate superseded values**
   - Revoke/delete replaced credentials in source stores.
   - For dashboard and deploy creds, ensure old credentials cannot authenticate.
   - For demo users, old passwords must fail sign-in.
5. **Capture verification evidence**
   - Record timestamp, operator, and pass/fail checks in incident/change record.
   - Store only metadata/evidence outcomes; never include secret values.

## Verification checklist (manual)

After rotation:

1. **Demo app sign-in**
   - `admin@dia-rental.dev` and `operator@dia-rental.dev` succeed with newly issued credentials.
   - Previous credentials fail authentication.
2. **Dashboard access**
   - Port-forward works, login succeeds with newly issued credential.
   - Superseded dashboard credential is rejected.
3. **Deploy path**
   - `build-images.yml` can authenticate to registry and push when gates are enabled.
   - `deploy-dev.yml` can deploy with current auth material.
   - The preflight summary reports `DB bootstrap | ✅ enabled |`.
   - The `Bootstrap Supabase DB (migrations + demo seed)` job runs instead of being skipped.
   - Superseded registry/deploy credentials no longer authenticate.
4. **Least privilege check**
   - Frontend configuration references only anon/public client credentials.
   - Service-role/admin credentials are not exposed in frontend env, manifests, docs, or workflow summaries.

## Rollback procedure

Use rollback only if rotation breaks deploy/app access.

1. Confirm blast radius and affected credential set.
2. Reapply the previous known-good secret version from secure storage.
   - Retain at least the previous two credential versions for 90 days so rollback
     material is available during incident response.
3. Validate service restoration (build/deploy/login path affected).
4. Open a security follow-up for immediate re-rotation with corrected procedure.
5. Time-box rollback state; do not leave old values active beyond emergency window.

## Break-glass handling (tightly scoped)

Break-glass is only for incident response when normal credentials are unavailable.

1. Requires explicit maintainer + security approval before activation.
2. Grant minimal scope and TTL (target: <= 60 minutes).
3. Log who approved, who executed, why, and when access expires in the incident
   ticket and security audit log for the rotation event.
4. Rotate affected credentials immediately after incident stabilization and record
   the post-incident rotation completion in the same ticket/log.
5. Re-disable any temporary legacy account access (including `demo@dia-rental.dev`) after use.

## Transition note: replacing long-lived deploy credentials

Where platform prerequisites allow, replace static registry/deploy secrets with
OIDC/workload identity as described in `docs/specs/live-cluster-deploy-smoke-rollback.md`.
After cutover:

- Remove superseded static credentials from GitHub secret stores.
- Verify workflows use identity federation/references only.
- Keep this runbook as the operational sequence for future rotations and emergency access.
