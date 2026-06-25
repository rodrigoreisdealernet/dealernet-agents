# ADR-0023: Dev DB bootstrap via in-cluster Job boundary

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Platform, Security, Factory Architect

## Context
Issue #222 requires dev deploy automation to apply Supabase migrations and the demo baseline seed against the deployed database. A direct GitHub Actions `kubectl exec` path into the Supabase DB pod expands trusted compute outside the cluster boundary and weakens least-privilege separation from app deploy.

## Decision
We run dev DB bootstrap as an **in-cluster Kubernetes Job** in `dia-supabase`, created by a dedicated DB-bootstrap kubeconfig. GitHub Actions no longer executes SQL directly into the DB pod; it only creates/watches/deletes scoped bootstrap resources. The workflow requires explicit bootstrap role/database settings (`DIA_DB_BOOTSTRAP_USER`, `DIA_DB_BOOTSTRAP_DB_NAME`) with no `postgres` defaults.

## Consequences
- Privileged migration/seed execution happens inside cluster trust boundaries.
- Least-privilege RBAC is split by identity in `dia-supabase`: GitHub bootstrap credential (`gha-db-bootstrap`) can only manage bootstrap Job/ConfigMap lifecycle + job pod logs; in-cluster bootstrap service account (`dia-db-bootstrap`) can only resolve DB pod + use `pods/exec`.
- Deploy preflight is stricter: bootstrap variables + scoped bootstrap kubeconfig must be configured before enabling dev deploy.
- Deploy validation now proves demo-baseline seed idempotency by reapplying `seed.sql` and rerunning assertions.

## Alternatives considered
- **Direct GitHub runner `kubectl exec` to DB pod** — rejected: broadens trust boundary and violates least-privilege intent.
- **Manual post-deploy SQL runbooks** — rejected: does not satisfy automated acceptance criteria for #222.

## Evidence
- `.github/workflows/deploy-dev.yml` (separate app deploy and in-cluster bootstrap job path)
- `deploy/k8s/rbac-dev-db-bootstrap.yaml` (concrete bootstrap identities + namespace-scoped RBAC)
- `PHASE2-DEPLOYMENT.md` (required bootstrap settings and scoped credential contract)
- `.github/tools/shared/src/__tests__/phase2-k8s-deploy-foundation.test.ts` (preflight contract coverage)
