# ADR-0021: Azure environment topology (reference)

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Platform
- **Note:** Reference record capturing the live Azure footprint so other ADRs (0010–0015) have a single source of truth. Snapshot as of 2026-06-06; update when the footprint changes.

## Context
The deployment, registry, edge, and RBAC ADRs all reference Azure resources that were never written down in one place. Reviews need to know what actually exists and where.

## Decision
We record the current Azure topology as the reference for all infrastructure ADRs.

**Subscription:** `Volaris Alexandria - Subscription 1` (`44542832-156a-4b4e-a4fd-5a182428ca1e`), tenant `Volaris Group` (`ourvolaris.onmicrosoft.com`), primary region **East US 2**.

**Clusters (AKS, k8s 1.33, eastus2):**
- `aks-selfheal-staging` (`rg-selfheal-staging`) — hosts the dia **dev/test** workloads (namespaces `dia-dev`, `dia-test`). Node RG `MC_rg-selfheal-staging_aks-selfheal-staging_eastus2` holds the app/api LoadBalancer public IPs.
- `aks-selfheal-prod` (`rg-selfheal-prod`) — intended **prod** cluster (`dia-prod`).

**Registry (ACR):** `acrselfhealstg.azurecr.io` (Basic, `rg-selfheal-staging`). *(Other registries in the subscription — `samproacr`, `sspaiacrvolaris` — belong to unrelated projects.)*

**Edge (Front Door / ADR-0015):** `dia-afd` (`rg-dia-dev`); siblings `selfheal-afd`, `selfheal-prod-afd`, `equip-afd`.

**Runners:** `github-runners-rg` (self-hosted runner infra, ADR-0008).

## Consequences
- Naming is cross-cutting: "dia" lives across `rg-dia-dev` (Front Door), `rg-selfheal-staging` (cluster/ACR), and the `dia-*` namespaces — reviewers must not assume one resource group holds everything.
- dev/test share one staging cluster; isolation between them is namespace-level only (ADR-0012).
- A dedicated prod ACR and confirmed prod edge/runner placement are gaps to close before prod go-live.

## Alternatives considered
- N/A (descriptive reference).

## Evidence
- `az account show`; `az group list`; `az aks list`; `az acr list`; `az afd profile list`; `az network public-ip list` (2026-06-06)
- Related ADRs: 0008, 0010, 0012, 0013, 0014, 0015
