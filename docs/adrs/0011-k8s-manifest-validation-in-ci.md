# ADR-0011: Kubernetes manifest validation in CI (helm lint + kubeconform)

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect, Platform

## Context
Helm/manifest errors are cheap to catch before a deploy and expensive to catch during one. We also want this validation to run on GitHub-hosted runners (ADR-0008) with no cluster access.

## Decision
Every PR touching `charts/**` or `deploy/k8s/**` runs **`helm lint` + `helm template`** for all environment profiles (dev/test/prod) and validates the rendered manifests against the Kubernetes OpenAPI schema with **kubeconform** — entirely render-only, no live-cluster contact.

## Consequences
- Syntax/schema errors and profile-specific breakage surface at PR time.
- Runtime problems (image pull, RBAC, reachability) are not caught here — that is the smoke-test layer's job.
- The kubeconform schema version must track the target cluster's Kubernetes version (currently 1.33).

## Alternatives considered
- **Validate only at deploy** — rejected: late, wastes deploy cycles.
- **No validation** — rejected: obvious errors reach the cluster.

## Evidence
- `.github/workflows/k8s-render-validate.yml` — PR #100 (`e6c2548`)
- PR #97 (`adbdb3f`) helm lint + template validation across dev/test/prod profiles
- `charts/app/` profiles; AKS target version 1.33 (see ADR-0021)
