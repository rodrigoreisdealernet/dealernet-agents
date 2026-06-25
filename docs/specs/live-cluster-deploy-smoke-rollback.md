# Live-Cluster Deploy, Smoke, and Rollback Design (Phase 2, Gated)

**Status:** Draft for platform and maintainer review  
**Owner:** Factory Architect  
**Related epic:** #41  
**Related issue:** #44  
**Published:** 2026-06-06

## Overview

This document defines the Phase 2 design for live-cluster deployment automation in `Volaris-AI/dia`.

It covers:
- `deploy-dev.yml`
- `deploy-test.yml`
- `deploy-prod.yml`
- `smoke-dev-test-prod.yml`
- `rollback.yml`

This is a design artifact only. It does **not** authorize implementation of live-cluster automation until the required human approvals and infrastructure prerequisites are completed.

## Goals

- Promote the same immutable frontend and worker images across dev, test, and prod.
- Keep release coordination on GitHub-hosted runners and environment mutation on tightly scoped self-hosted runners.
- Restrict deployment permissions to namespace-scoped identities.
- Validate each environment with concrete smoke checks before promotion.
- Make rollback an explicit, auditable, protected workflow.

## Non-Goals

- No Kubernetes workflow implementation in this design issue.
- No generic cluster-wide runner identity.
- No secret literals in repo, workflow YAML, Helm values, or issue comments.
- No production auto-promotion from `main`.

## Runner Topology

| Job type | Runner | Reason |
|---|---|---|
| Release coordination, metadata, release notes, GitHub Environment orchestration | `ubuntu-latest` | Does not need private cluster access |
| `deploy-dev.yml`, `deploy-test.yml`, nonprod smoke needing private reachability | `factory-deploy-nonprod` | Nonprod cluster mutation and environment-local checks |
| `deploy-prod.yml`, prod smoke, `rollback.yml` | `factory-prod-ops` | Production-only access with stronger isolation and approvals |

### Runner rules

- `factory-deploy-nonprod` must only reach `dia-dev` and `dia-test`.
- `factory-prod-ops` must only reach `dia-prod`.
- Privileged workflows must target explicit labels or runner groups, never plain `self-hosted`.
- Production runner access must be isolated from general CI and Copilot execution.
- Release coordination may run on GitHub-hosted runners, but any `kubectl` or `helm upgrade` step must run on the environment-specific deploy runner.

## Promotion Flow

1. Merge to `main` triggers `build-images.yml`.
2. `build-images.yml` publishes immutable frontend and worker images tagged with:
   - commit SHA
   - optional release tag/metadata
   - image digest recorded in workflow output
3. `deploy-dev.yml` automatically deploys the exact built digests to `dia-dev`.
4. `smoke-dev-test-prod.yml` runs dev smoke checks and records pass/fail evidence.
5. Promotion to test uses the **same previously validated digests**, not a rebuild.
6. `deploy-test.yml` is gated by successful dev smoke plus release-manager intent.
7. `smoke-dev-test-prod.yml` runs test smoke checks and confirms promotion evidence.
8. `deploy-prod.yml` promotes the same validated digests to `dia-prod` through a protected GitHub Environment with required reviewers.
9. Post-deploy prod smoke must succeed before the release is considered complete.

### Immutable artifact contract

- Promotion moves image **digests**, not mutable tags.
- Helm values may reference a human-readable tag for display, but the deploy step must pin the resolved digest.
- Frontend and worker digests for a release must be recorded together as one release unit.

## Environment Model

| Environment | Namespace | Trigger | Approval model |
|---|---|---|---|
| Dev | `dia-dev` | Automatic on `main` after build success | No manual approval required |
| Test | `dia-test` | Promotion of validated dev release | Manual or release-manager-controlled |
| Prod | `dia-prod` | Promotion of validated test release only | Protected environment + required reviewers |

### GitHub Environment policy

- Create GitHub Environments: `dev`, `test`, `prod`.
- `prod` must require human reviewers before any deploy or rollback job starts.
- `deploy-prod.yml` and `rollback.yml` must target the `prod` environment.
- Environment secrets must contain references or auth material only; application secrets remain externalized.
- Use concurrency groups per environment so only one mutation workflow runs at a time.

## RBAC Design

Each environment gets its own namespace-scoped deployment identity.

| Namespace | Service account | Used by |
|---|---|---|
| `dia-dev` | `gha-deployer` | `deploy-dev.yml`, nonprod smoke helpers |
| `dia-test` | `gha-deployer` | `deploy-test.yml`, nonprod smoke helpers |
| `dia-prod` | `gha-deployer` | `deploy-prod.yml`, prod smoke, `rollback.yml` |

### RBAC requirements

- Bind each service account to a namespace-scoped `Role` and `RoleBinding`, not `ClusterRoleBinding`.
- Allow only the verbs needed for the release path: `get`, `list`, `watch`, `create`, `patch`, `update` on namespaced deployment resources.
- Limit secret mutation to the release-owned secret references required by the application.
- Deny cross-namespace mutation.
- Do not let a general runner identity mutate all namespaces.
- If smoke checks need Kubernetes API access, prefer a separate read-only role over reusing the mutating role.

## Secret Management

- Store real secret values in an external secret manager or equivalent cloud secret store.
- Kubernetes receives secrets through secret synchronization, such as `ExternalSecret` or CSI/secret-provider integration.
- GitHub Actions stores only:
  - environment selection metadata
  - cloud auth material or federation config
  - secret identifiers or references
- Helm values files must contain only secret references, never literal credentials.
- Issue bodies, PRs, comments, and workflow summaries must never print resolved secret values.

## Smoke Check Design

`smoke-dev-test-prod.yml` should run environment-specific checks after each deploy and before higher-environment promotion.

### Required checks

1. **Frontend reachability**
   - Expected ingress/front-door URL responds successfully.
   - Health or landing route returns expected status.
2. **Worker connectivity**
   - Worker deployment is available.
   - Worker can reach Temporal and starts without queue-registration errors.
3. **Temporal task-queue registration**
   - The configured task queue for the environment is discoverable through the approved runtime check.
   - Failed worker registration blocks promotion.
4. **Database and migration state**
   - The release references the expected migration version or migration job completion evidence.
   - The app is not running against a partially applied schema.

### Evidence model

- Each smoke run should publish a compact pass/fail summary to the workflow summary.
- Promotion to test or prod must require a successful smoke result from the previous environment.
- Smoke failures create a release-blocking signal; they do not auto-promote.

## Rollback Design

`rollback.yml` is a manual workflow for reverting an environment to the last known good release.

### Allowed rollback inputs

- target environment
- Helm release name
- Helm revision or previously approved image digest set
- incident or release reference

### Rollback behavior

- Prefer Helm release history rollback for application changes.
- If the deployment model later moves to GitOps, the equivalent action is a Git revert/promotion revert that restores the prior release declaration.
- Rollback must reuse the same environment protection as deployment.
- Prod rollback requires protected-environment approval.
- Rollback must record who approved it, what target revision was restored, and which release/incident triggered it.

### Database caveat

- Rollback is application-first. Schema changes must remain additive/backward-compatible for the release window.
- If a release includes a destructive or non-reversible database change, automatic rollback is blocked and requires a human runbook.

## Human Approvals Required Before Phase 2 Implementation

The following approvals are required before implementation issues can be unblocked:

1. **Platform review** of runner topology, namespace/RBAC boundaries, and cluster-access model.
2. **Maintainer review** of protected-environment and production-mutation guardrails.
3. **Release-owner agreement** on dev/test/prod promotion policy and rollback trigger model.
4. **Security confirmation** that secret handling and runner isolation are acceptable for live-cluster use.

## Infrastructure Prerequisites

Phase 2 implementation stays blocked until these are resolved or explicitly accepted:

1. Resolve the `aks-selfheal-prod` `nodepool1` provisioning failure and confirm the intended production node state.
2. Create dedicated namespaces: `dia-dev`, `dia-test`, `dia-prod`.
3. Create environment-specific service accounts and namespace-scoped RBAC bindings.
4. Stand up the required runner placement:
   - `factory-deploy-nonprod`
   - `factory-prod-ops`
5. Decide and document the cluster authentication model:
   - current credential injection, or
   - deliberately enabled OIDC/workload identity
6. Address the current lack of network policy if production workloads will rely on these clusters.
7. Confirm where secret synchronization will be sourced from and how rotation is handled.
8. Confirm ingress/front-door endpoints and health-check contracts for each environment.

## Implementation Boundaries For Later Child Issues

When implementation is eventually unblocked, split the work so that:

- release coordination and deploy execution remain separate concerns
- nonprod automation can ship before prod automation
- prod deploy and rollback stay gated behind maintainer/platform approval
- smoke checks are implemented before prod promotion is allowed

Suggested future story slices:

1. Build nonprod deploy workflows and namespace bootstrap artifacts.
2. Add smoke validation for dev and test.
3. Add protected prod promotion workflow.
4. Add protected rollback workflow.

## Decision Summary

- Use GitHub-hosted runners for coordination; use environment-specific self-hosted runners for mutation.
- Promote immutable image digests across environments.
- Scope access by namespace-specific service account and RBAC.
- Externalize secret values; store references only in GitHub/workflow config.
- Require smoke evidence before promotion.
- Keep prod deployment and rollback human-gated until prerequisites are complete.
