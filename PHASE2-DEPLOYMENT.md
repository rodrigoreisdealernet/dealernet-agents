# Phase 2 — Kubernetes Nonprod Deployment (Go-Live Checklist)

This repo's Phase 2 deployment **scaffolding is in place and validated**, but live
deployment is **intentionally gated** until the infrastructure prerequisites below
are provided. Nothing here touches the existing `level-3-v2` `dev`/`test`/`prod`
namespaces. Design of record: `docs/specs/live-cluster-deploy-smoke-rollback.md`.

## What's already built (render-only, no cluster contact)

| Artifact | Purpose |
|----------|---------|
| `charts/app/` + `values-{dev,test,prod}.yaml` | Helm chart for frontend + temporal-worker |
| `charts/observability/` + `values-{dev,test,prod}.yaml` | Helm chart for `kube-prometheus-stack` + ServiceMonitor scrape contracts |
| `.github/workflows/build-images.yml` | Builds both images (push gated on registry creds) |
| `.github/workflows/k8s-render-validate.yml` | CI: helm lint/template + kubeconform for every profile + bootstrap manifests |
| `deploy/k8s/namespaces.yaml` | `wynne-dev`, `wynne-test` namespaces |
| `deploy/k8s/rbac-nonprod.yaml` | Per-namespace `gha-deployer` SA + namespace-scoped Role/RoleBinding |
| `deploy/k8s/rbac-dev-db-bootstrap.yaml` | `wynne-supabase` bootstrap SAs + least-privilege Roles/RoleBindings for GitHub bootstrap and in-cluster DB exec |
| `.github/workflows/deploy-dev.yml` | Gated deploy to `wynne-dev`; runs Supabase migrations + demo-baseline seed/assertions via in-cluster bootstrap Job |

## Go-live checklist (your infra/admin steps)

Live `wynne-dev` deployment turns on when **all** of these are done:

1. **Image registry** — provide push creds so `build-images.yml` publishes:
   - repo **variable** `ACR_LOGIN_SERVER` (e.g. `acrselfhealstg.azurecr.io`) — also used as `IMAGE_REGISTRY`
   - repo **secrets** `ACR_USERNAME`, `ACR_PASSWORD`
   - (GHCR is a fine alternative — adjust the registry var/secret names accordingly.)
2. **Cluster namespaces + RBAC** — against a cluster that is **not** level-3-v2's:
   ```bash
   kubectl apply -f deploy/k8s/namespaces.yaml
   kubectl apply -f deploy/k8s/rbac-nonprod.yaml
   kubectl apply -f deploy/k8s/rbac-dev-db-bootstrap.yaml
   ```
3. **Self-hosted deploy runner** — register a runner with labels
   `self-hosted, linux, x64, factory-deploy-nonprod`, reachable to `wynne-dev`/`wynne-test`
   **only**, authenticated as the `gha-deployer` SA (kubeconfig/token or OIDC/workload identity).
4. **GitHub Environment** — create environment `dev` (test/prod added with their workflows).
5. **Enable the gate** — set repo **variables**:
   - `K8S_DEPLOY_ENABLED = true`
   - `WYNNE_DEV_NAMESPACE = wynne-dev`
   - `WYNNE_DB_BOOTSTRAP_USER = <operator-supplied least-privilege bootstrap role>`
   - `WYNNE_DB_BOOTSTRAP_DB_NAME = <operator-supplied bootstrap target database>`
   - Choose a bootstrap role scoped only to the migration/seed work this workflow runs
     against that target database.
6. **Dev app deploy secret** — add repo **secret** `KUBE_CONFIG_DEV` containing the
   namespace-scoped `gha-deployer` kubeconfig for `wynne-dev` (Helm app deploy only).
7. **Dev DB bootstrap secret** — add repo **secret** `KUBE_CONFIG_DEV_DB_BOOTSTRAP`
   containing a kubeconfig for service account `gha-db-bootstrap`, scoped only to
   bootstrap Job/ConfigMap lifecycle + bootstrap job pod log reads in `wynne-supabase`
   (it no longer executes directly in the DB pod from GitHub Actions).

   Example (AKS/admin context):
   ```bash
   kubectl -n wynne-supabase create token gha-db-bootstrap > /tmp/gha-db-bootstrap.token
   kubectl config set-cluster wynne \
     --server="<cluster-api-server>" \
     --certificate-authority="<cluster-ca.crt>" \
     --embed-certs=true --kubeconfig /tmp/kubeconfig-db-bootstrap
   kubectl config set-credentials gha-db-bootstrap \
     --token="$(cat /tmp/gha-db-bootstrap.token)" \
     --kubeconfig /tmp/kubeconfig-db-bootstrap
   kubectl config set-context gha-db-bootstrap@wynne-supabase \
     --cluster=wynne --user=gha-db-bootstrap --namespace=wynne-supabase \
     --kubeconfig /tmp/kubeconfig-db-bootstrap
   kubectl config use-context gha-db-bootstrap@wynne-supabase --kubeconfig /tmp/kubeconfig-db-bootstrap
   ```

   Then store the scoped kubeconfig as GitHub secret `KUBE_CONFIG_DEV_DB_BOOTSTRAP`
   and set the matching repo vars to the explicit least-privilege bootstrap role and
   database for your environment (this repo does not prescribe privileged defaults):
   ```bash
   gh secret set KUBE_CONFIG_DEV_DB_BOOTSTRAP < /tmp/kubeconfig-db-bootstrap
   gh variable set WYNNE_DB_BOOTSTRAP_USER --body '<least-privilege-bootstrap-role>'
   gh variable set WYNNE_DB_BOOTSTRAP_DB_NAME --body '<bootstrap-target-database>'
   ```

`deploy-dev.yml` now uses in-cluster service account `wynne-db-bootstrap` (from
`deploy/k8s/rbac-dev-db-bootstrap.yaml`) for DB-pod `exec` inside `wynne-supabase`;
that account is limited to `pods` get/list + `pods/exec` create.

Until all required deploy variables and secrets are configured, `deploy-dev.yml` runs its preflight on `ubuntu-latest` and **skips cleanly**
with a summary — it never hangs waiting on the missing self-hosted runner.
Once the secret + explicit bootstrap vars above are set, preflight reports `DB bootstrap | ✅ enabled |` and the `bootstrap-db` job is eligible to run instead of being skipped.

DB bootstrap validation now mirrors the demo reset-path idempotency expectation by:
1) applying `supabase/seed.sql`, 2) running `supabase/tests/demo_baseline_seed.sql`,
3) re-applying `supabase/seed.sql`, and 4) re-running `demo_baseline_seed.sql`.

## Cluster auth & secrets (decide before go-live)

- Choose credential injection vs. OIDC/workload identity (current clusters report OIDC issuer disabled — enable deliberately if used).
- Application secrets stay **externalized** (External Secrets / CSI). Helm values carry only references — never literal credentials.
- Rotate registry/deploy/demo/dashboard credentials and capture invalidation evidence using [`docs/runbooks/secret-operations.md`](./docs/runbooks/secret-operations.md) before enabling live deploy gates.
- Resolve the `aks-selfheal-prod nodepool1` provisioning failure before any prod use.

## Remaining Phase 2 follow-ups (after dev is live)

Tracked under epic **#41**, sliced per the design:
1. ✅ Nonprod deploy + namespace/RBAC artifacts (this change) — `deploy-test.yml` mirrors `deploy-dev.yml`.
2. `smoke-dev-test-prod.yml` — frontend reachability, worker/Temporal connectivity, task-queue registration, migration state.
3. `deploy-prod.yml` — protected `prod` environment + required reviewers (promotes validated digests only).
4. `rollback.yml` — protected, Helm-revision/digest rollback.

## Human approvals required before prod (per design)

Platform review (runner/RBAC), maintainer review (prod guardrails), release-owner promotion
policy, and security sign-off on secret handling + runner isolation.
