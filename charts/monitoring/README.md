# charts/monitoring

Helm chart that provisions Grafana datasource and dashboard ConfigMaps for
the Dealernet monitoring stack. Install alongside
[kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack)
in the `monitoring` namespace.

---

## Prerequisites

- `helm` 3.x
- `kube-prometheus-stack` installed in the target namespace with sidecar
  provisioning enabled (see [values-kube-prometheus-stack.yaml](./values-kube-prometheus-stack.yaml))

---

## Quick start

```bash
# 1. Add the Prometheus Community chart repository (once)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# 2. Create the Grafana admin credentials secret
kubectl create secret generic grafana-admin-credentials \
  --from-literal=admin-user=admin \
  --from-literal=admin-password='<strong-password>' \
  -n monitoring

# 3. Install kube-prometheus-stack with Dealernet's sidecar configuration
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f charts/monitoring/values-kube-prometheus-stack.yaml

# 4. Install the monitoring chart (provisions dashboards + datasource)
helm upgrade --install dia-monitoring charts/monitoring \
  --namespace monitoring
```

---

## Environment profiles

| Profile | File | Use |
|---------|------|-----|
| Base | `values.yaml` | Shared defaults |
| Dev | `values-dev.yaml` | `dia-dev` |
| Test | `values-test.yaml` | `dia-test` |
| Prod | `values-prod.yaml` | `dia-prod` |

Apply an environment profile:

```bash
helm upgrade --install dia-monitoring charts/monitoring \
  --namespace monitoring \
  -f charts/monitoring/values-prod.yaml
```

---

## Provisioned dashboards

| Dashboard | Folder | UID | Description |
|-----------|--------|-----|-------------|
| **Temporal Server** | Temporal | `temporal-server` | Service requests, workflow execution, persistence |
| **Temporal SDK / Worker** | Temporal | `temporal-sdk` | Poll rates, workflow/activity latency, SDK worker health |
| **Dealernet Ops** | Dealernet Ops | `dia-ops` | Workflow throughput/latency, task-queue backlog/age, activity failure rate, schedule health, ops-api latency/error rate |
| **System — Pods & Nodes** | System | `system-pods-nodes` | Pod CPU/mem, pod restarts, node pressure |

All dashboards are provisioned from ConfigMaps and are read-only in the UI.
Edits made in the Grafana UI will be lost on the next Helm upgrade — make
changes in the ConfigMap templates and redeploy.

Folder organisation is automatic: the kube-prometheus-stack dashboard sidecar
reads the `dia/dashboard-folder` annotation on each ConfigMap and groups
dashboards accordingly (configured via `grafana.sidecar.dashboards.folderAnnotation`
in `values-kube-prometheus-stack.yaml`).

---

## Datasource

A single Prometheus datasource (`uid: prometheus`) is provisioned automatically
from the `configmap-datasource.yaml` template, pointing at the
`prometheus-operated` service in the same namespace. The default URL
(`http://prometheus-operated:9090`) is set in `values.yaml` and can be
overridden per environment.

---

## Access model

Grafana is exposed as a `ClusterIP` service by default (internal-only).
External access is gated by the oauth2-proxy boundary in `charts/app`
(`adminAccess.grafana.*`) per
[ADR-0034](../../docs/adrs/0034-admin-observability-ingress-oidc-boundary.md).
Do **not** expose Grafana publicly before the Keycloak OIDC identity boundary
is healthy.

Internal (port-forward) access:

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
# then open http://localhost:3000
```

---

## Values reference

| Key | Default | Description |
|-----|---------|-------------|
| `grafana.namespace` | `monitoring` | Namespace where Grafana is running |
| `grafana.dashboardLabel` | `grafana_dashboard` | Sidecar label key for dashboard ConfigMaps |
| `grafana.dashboardLabelValue` | `"1"` | Sidecar label value |
| `grafana.datasourceLabel` | `grafana_datasource` | Sidecar label key for datasource ConfigMaps |
| `grafana.datasourceLabelValue` | `"1"` | Sidecar label value |
| `grafana.prometheusUrl` | `http://prometheus-operated:9090` | Prometheus URL visible from Grafana pod |

---

## Validation

```bash
# Lint the chart
helm lint charts/monitoring

# Render all manifests with default values
helm template dia-monitoring charts/monitoring

# Run the full CI test suite
bash charts/monitoring/ci-test.sh
```
