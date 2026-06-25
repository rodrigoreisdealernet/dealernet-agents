# ADR-0015: Azure Front Door as external edge + TLS termination; AKS LoadBalancer `:80` origins

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Maintainer, Platform
- **Note:** This decision was **executed before it was recorded** — Azure Front Door was activated in front of the app with no ADR. This record exists to close that gap, and is the motivating example for keeping ADRs (see `docs/adrs/README.md`).

## Context
The app and Supabase API run in AKS and were exposed via Kubernetes `LoadBalancer` services on raw public IPs over port 80 (ADR-0012). That gave no HTTPS, no stable hostname, no global edge/WAF, and corporate networks block non-standard ports. The earlier "frontend dev on `:80`" change (PR #107/`721d273`) was a partial, undocumented response to the same problem.

## Decision
We front the AKS workloads with **Azure Front Door (Standard/Premium)**. The `wynne-afd` profile (`rg-wynne-dev`) terminates TLS at the edge and forwards to AKS LoadBalancer origins. Two endpoints:
- `wynne-app` → origin group `app-og` → `20.161.209.34` (frontend LB)
- `wynne-api` → origin group `api-og` → `20.36.251.229` (Supabase/Kong LB)

Both routes match `/*`, **HTTPS-redirect enabled**, **forwarding protocol `HttpOnly`** — i.e. AFD serves HTTPS to clients and forwards to the origin on HTTP `:80`. This is *why* the LoadBalancer/`:80` decision is acceptable: TLS lives at the edge, not the origin.

## Consequences
- Public clients get HTTPS + a stable `*.azurefd.net` hostname + global edge (and a place to add WAF/caching later).
- Edge→origin traffic is **HTTP over the public IP** today — it should be hardened (origin TLS, or restrict origin ingress to AFD via service tags / `X-Azure-FDID`), tracked as follow-up.
- `allowedHosts=true` in Vite dev is required so the AFD/LB hostname is accepted.
- Origin IPs are AKS-managed LB IPs in `MC_rg-selfheal-staging_...`; if the cluster/LB is recreated, AFD origins must be updated.

## Alternatives considered
- **Istio Ingress gateway + cert-manager** — viable; not chosen for the initial external edge (AFD gives global edge/WAF with less in-cluster cert plumbing).
- **Raw LoadBalancer IP, no edge** — rejected: no HTTPS, no stable hostname, port-blocking issues.

## Evidence
- Live: `az afd profile/endpoint/origin/route list` — profile `wynne-afd` (`rg-wynne-dev`, FrontDoorId `e9bd4dea-…`); endpoints `wynne-app` (`wynne-app-a4bde4gwecdnfpfb.a02.azurefd.net`), `wynne-api` (`wynne-api-fvd0fcfubfb2drcy.a02.azurefd.net`); origins `20.161.209.34`/`20.36.251.229` (`http=80 https=443`); routes `/*`, https-redirect Enabled, forwarding `HttpOnly`
- Origin IPs resolve to `kubernetes-*` public IPs in `MC_rg-selfheal-staging_aks-selfheal-staging_eastus2`
- Related: PR #107 (`f25cbdb`) Vite allowedHosts + LoadBalancer; `721d273` dev LB on `:80`
- Sibling profiles exist: `selfheal-afd`, `selfheal-prod-afd`, `equip-afd`
