# ADR-0008: GitHub-hosted runners default; self-hosted for cluster/private ops

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect, Platform

## Context
Self-hosted runners carry real operational cost (VM lifecycle, patching, credential custody) and a larger attack surface. Most CI work (lint, test, build, manifest validation, agent runs) needs none of that. Only cluster deploys and private-network smoke checks need privileged, in-network runners.

## Decision
**GitHub-hosted `ubuntu-latest` is the default.** Self-hosted runner pools are used only where a job needs private cluster access or preinstalled cloud tooling, identified by labels: `factory-build`, `factory-deploy-nonprod`, `factory-prod-ops`. Workflows that require a not-yet-provisioned self-hosted runner **skip cleanly** rather than hang.

## Consequences
- Lower cost and smaller attack surface for the common case; cluster credentials live only on isolated self-hosted runners.
- GitHub-hosted jobs cannot reach private cluster IPs or run `kubectl`; deploys are orchestrated separately on self-hosted runners.
- Gated workflows degrade gracefully when a runner pool is absent (verified by tests, PR #104).

## Alternatives considered
- **All self-hosted** — rejected: cost and provisioning burden.
- **All GitHub-hosted** — rejected: no private cluster access for deploy/smoke.

## Evidence
- `.github/factory.yml` (`runners` block: default `ubuntu-latest`; self-hosted `build`/`deploy_nonprod`/`prod_ops` labels)
- `docs/specs/software-creation-factory.md` (runner placement policy)
- `.github/workflows/deploy-dev.yml` (preflight gate; skips without runner) — PR #100 (`e6c2548`), PR #106; PR #104 (`c35b87f`) deploy-gate coverage
