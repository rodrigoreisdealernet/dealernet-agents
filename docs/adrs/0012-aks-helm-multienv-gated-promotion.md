# ADR-0012: AKS + Helm chart + per-env values + gated promotion

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect, Platform

## Context
Phase 2 requires running the app and Temporal worker on real infrastructure across dev/test/prod with consistent artifacts and safe promotion. AKS + Helm + Istio is the verified existing platform.

## Decision
The frontend and Temporal worker deploy to **AKS** via a single Helm chart (`charts/app`) with per-environment values profiles (`values.yaml` defaults + `values-dev/test/prod.yaml`). Environments are namespaces: `wynne-dev` (auto-deploy on `main`), `wynne-test` (manual promotion), `wynne-prod` (protected environment + reviewers). Promotion carries the immutable image digest (ADR-0010).

## Consequences
- One chart, env differences isolated to values files — but those profiles must be diff-reviewed to avoid drift; the prod profile is security-sensitive.
- Auto-dev / manual-test / protected-prod gives a safe promotion gradient.
- Kubernetes operational burden (upgrades, networking, storage) is owned by the platform; namespace isolation is soft (no NetworkPolicy yet).
- dev/test currently run on the shared `aks-selfheal-staging` cluster; prod on `aks-selfheal-prod` (see ADR-0021).

## Alternatives considered
- **Docker Compose only** — rejected: local-only, not prod-grade (still used for local dev).
- **Three separate charts** — rejected: maintenance/drift.

## Evidence
- `charts/app/` (Chart + `values-dev/test/prod.yaml`); PR #47, PR #83 (`eb84429`)
- `deploy/k8s/namespaces.yaml`; `.github/workflows/deploy-dev.yml` — PR #100 (`e6c2548`), PR #106 (dev live on `wynne-dev`)
- `docs/specs/live-cluster-deploy-smoke-rollback.md` (promotion flow, smoke, rollback)
