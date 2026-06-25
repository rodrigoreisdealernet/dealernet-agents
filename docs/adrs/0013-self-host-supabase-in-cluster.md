# ADR-0013: Self-host open-source Supabase in-cluster (overrides managed)

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Maintainer, Factory Architect

## Context
The app uses the Supabase stack (Postgres + PostgREST + GoTrue + Kong + Realtime + Storage + Meta + Studio). Managed Supabase is convenient but adds a third-party dependency, cost, and data-residency questions, and sits outside the cluster-native deployment model (ADR-0012). This decision **explicitly overrides** an earlier general preference for managed services.

## Decision
We **self-host the open-source Supabase stack inside the Kubernetes cluster**, on the same AKS infrastructure as the app and worker. The platform team owns its lifecycle.

## Consequences
- All infrastructure under one operational model; no external data dependency; data stays in our subscription.
- We own Supabase HA, backups, security patching, and upgrades; the community Helm chart is not officially supported and is adapted/owned by us.
- DB credentials must be externalized (Kubernetes secrets / external-secrets), never defaulted in values.
- The API is fronted by Front Door for external access (ADR-0015).

## Alternatives considered
- **Managed Supabase** — rejected: third-party SLA/cost/lock-in, data residency.
- **Self-host outside the cluster** — rejected: separate ops burden, added latency.

## Evidence
- Commit `f8988cd` "docs(spec): self-host open-source Supabase in-cluster (decision overrides managed preference)"
- `docs/specs/software-creation-factory.md` (Kubernetes deployment reality; self-hosted Supabase constraints)
