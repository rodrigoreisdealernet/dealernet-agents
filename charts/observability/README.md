# charts/observability

Helm chart for in-cluster monitoring with `kube-prometheus-stack` in the dedicated
`wynne-observability` namespace.

It also renders the Wynne scrape contract resources required for issue #679:

- `Service` + `ServiceMonitor` for Temporal server metrics
- `Service` + `ServiceMonitor` for temporal-worker SDK metrics
- `Service` + `ServiceMonitor` for ops-api `/metrics`

## Environment profiles

- `charts/observability/values-dev.yaml` — dev (3d retention, lightweight collectors)
- `charts/observability/values-test.yaml` — test (7d retention)
- `charts/observability/values-prod.yaml` — prod (30d retention)

## Validate

```bash
# Build chart dependency (kube-prometheus-stack)
helm dependency build charts/observability

# Lint and render profiles
helm lint charts/observability
helm template observability charts/observability -f charts/observability/values-dev.yaml
helm template observability charts/observability -f charts/observability/values-test.yaml
helm template observability charts/observability -f charts/observability/values-prod.yaml
```
