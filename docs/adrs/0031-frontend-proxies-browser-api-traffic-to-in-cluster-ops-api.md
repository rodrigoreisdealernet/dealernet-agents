# ADR-0031: Frontend proxies browser /api traffic to the in-cluster ops API

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** PR Handler
- **Supersedes / Superseded by:** —

## Context
The dev deployment serves the frontend over HTTPS through Azure Front Door, while the
FastAPI ops API is only reachable inside the Kubernetes cluster as a ClusterIP service.
Browser POSTs to `/api/...` therefore hit the frontend nginx container first. Without an
explicit nginx proxy route, those requests do not reach the ops API and smoke coverage
fails on the approval flow.

This change also crosses the deploy/runtime boundary: the same frontend image must stay
portable across environments, and the container already runs with a read-only root
filesystem, so any nginx config generation must happen at startup using writable mounts.

## Decision
We proxy frontend browser requests for `/api/*` through nginx to an environment-provided
ops API base URL (`OPS_API_URL`), rendered from an nginx template at container startup.

Helm values provide the in-cluster service URL per environment, and the frontend
deployment mounts a writable nginx config directory so the container can render the final
config before starting nginx.

## Consequences
- Browser approval traffic reaches the in-cluster ops API without exposing that service
  directly at the public edge.
- The frontend image remains reusable across environments because the proxy target is
  supplied at runtime rather than baked into the image.
- Environments that omit `OPS_API_URL` fail closed with 502 responses for `/api/*`
  instead of silently routing to the wrong backend.
- The chart and container startup path must continue to provide a writable nginx config
  mount and runtime `OPS_API_URL`.

## Alternatives considered
- Expose the ops API directly as a separate public endpoint — rejected because it expands
  the external surface area and complicates browser configuration.
- Hard-code the ops API service DNS name in the image — rejected because it couples one
  image to one environment and breaks promotion.
- Route approval actions through a different browser-facing service — rejected because the
  existing `/api/*` path already matches the deployed app contract.

## Evidence
- PR [#700](https://github.com/Volaris-AI/dia/pull/700)
- `frontend/nginx/default.conf`
- `frontend/docker/entrypoint.sh`
- `frontend/Dockerfile`
- `charts/app/templates/frontend-deployment.yaml`
- `charts/app/values.yaml`
- `charts/app/values-dev.yaml`
