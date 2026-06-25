# ADR-0010: Immutable image builds, push gating, digest promotion

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect, Platform

## Context
Rebuilding container images per environment risks drift (different build time, base layers, env). Builds also run on PRs from forks/branches where pushing to the registry is neither possible nor desirable.

## Decision
Frontend and Temporal-worker images are built once with an immutable, commit-SHA-derived tag. **Push is gated**: images push to ACR only on `main` and only when registry credentials are present; otherwise the build runs but skips push, cleanly. Promotion across environments moves the **same image (by digest)**, never a rebuild.

## Consequences
- The exact artifact validated in dev is what runs in test/prod; no rebuild drift.
- PR builds validate the Dockerfile without needing registry secrets.
- Environment differences must be expressed in Helm values (ADR-0012), not at build time.
- Digest must be tracked through promotion (workflow outputs / Helm values).

## Alternatives considered
- **Mutable tags (`latest`/`dev`) + per-env rebuild** — rejected: drift, slower, unauditable.

## Evidence
- `.github/workflows/build-images.yml`; `.github/scripts/build-images-metadata.sh`
- PR #95 (`0be616e`) deterministic coverage for push gating + immutable tag generation
- `docs/specs/live-cluster-deploy-smoke-rollback.md` (immutable-artifact promotion contract)
- ACR: `acrselfhealstg.azurecr.io` (Basic, `rg-selfheal-staging`)
