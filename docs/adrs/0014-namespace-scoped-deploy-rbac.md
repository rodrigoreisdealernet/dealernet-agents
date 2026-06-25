# ADR-0014: Namespace-scoped RBAC for deploy runners

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect, Platform

## Context
A CI deploy identity with cluster-admin would let a compromised runner mutate every namespace and workload. Deploys (ADR-0012) only need to manage release-owned resources in one environment's namespace.

## Decision
Each environment has a **namespace-scoped `gha-deployer` service account** bound to a `Role` (not `ClusterRole`) granting only the verbs needed to deploy (get/list/watch/create/patch/update) on namespaced resources. No cross-namespace mutation, no cluster-admin, no shared cluster-wide runner identity.

## Consequences
- Blast radius of a compromised deploy runner is limited to its namespace.
- A deploy runner cannot be reused across namespaces; each environment binds its own SA.
- Smoke/troubleshooting scripts on the runner also operate under that least-privilege Role.

## Alternatives considered
- **Generic cluster-admin runner identity** — rejected: unsafe.
- **One shared runner across environments** — rejected: breaks isolation.

## Evidence
- `deploy/k8s/rbac-nonprod.yaml` (per-ns Role/RoleBinding for `gha-deployer`) — PR #100 (`e6c2548`)
- PR #104 (`c35b87f`) deterministic coverage for nonprod RBAC scope
- `docs/specs/live-cluster-deploy-smoke-rollback.md` (RBAC design)
