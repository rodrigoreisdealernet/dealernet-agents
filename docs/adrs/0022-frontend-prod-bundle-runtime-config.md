# ADR-0022: Frontend production bundle serving with runtime browser config

- **Status:** Proposed
- **Date:** 2026-06-06
- **Deciders:** Platform, Frontend

## Context
The deployed frontend was being run via the Vite development server in Kubernetes, which kept `import.meta.env.DEV` true in the browser and exposed development-only behavior in a deployed environment. At the same time, browser Supabase configuration needed to be injected at runtime so the same image can be promoted across environments without rebuilding.

This change crosses a deploy/runtime boundary and also establishes a concrete browser-facing Supabase API endpoint convention (`https://...azurefd.net`) for frontend runtime configuration.

## Decision
We serve the frontend as a built static bundle (`vite build`) from `nginx`, and generate `runtime-config.js` at container startup to inject browser-safe runtime values (currently Supabase URL and anon key).

For browser traffic in deployed environments, frontend runtime config uses public HTTPS Supabase/API endpoints.

## Consequences
- Production-like deployments no longer run a dev server and no longer expose dev-server-only behavior.
- Runtime config decouples environment-specific browser values from build-time bundling, enabling image reuse across environments.
- `runtime-config.js` must be generated at startup and served with no-cache headers so browser config changes are picked up.
- Platform/maintainer review is required before accepting this ADR and approving PRs that depend on it.

## Alternatives considered
- Keep running `vite dev` in deployed environments — rejected because it is not a production serving model and leaks dev behavior.
- Keep build-time-only Vite env configuration — rejected because it tightly couples environment values to the built artifact and complicates promotion.

## Evidence
- Frontend image switched to multi-stage build + nginx static serving: `frontend/Dockerfile`
- Runtime config generation at container startup: `frontend/docker/entrypoint.sh`
- SPA/nginx runtime-config no-cache behavior: `frontend/nginx/default.conf`
- Runtime config precedence in app code: `frontend/src/data/supabase.ts`
- Browser-facing HTTPS Supabase endpoint in dev Helm values: `charts/app/values-dev.yaml`
