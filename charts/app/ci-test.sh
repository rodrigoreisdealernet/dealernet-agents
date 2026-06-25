#!/usr/bin/env bash
# charts/app/ci-test.sh
#
# Validate the app Helm chart and its environment-specific values profiles.
# Runs helm lint + helm template checks for base, dev, test, and prod profiles.
# Includes ESO (External Secrets Operator) integration assertions that verify:
#   - ExternalSecret resources are NOT rendered when externalSecrets.enabled=false
#   - Correct kind/name/secretStoreRef/remoteRef/refreshInterval/policies when enabled
#   - remoteRef.property (OpenBao KV-v2 grouped maps) renders only when set, omitted when ""
#   - ACR pull secret renders with kubernetes.io/dockerconfigjson type
#   - Dev profile secret paths/properties align with Deployment secretKeyRef targets
#   - Partial oauth2-proxy config (only clientId set) produces no ExternalSecret
#
# Usage (from repo root):
#   bash charts/app/ci-test.sh
#
# Requirements: helm 3.x on PATH.

set -euo pipefail

CHART="charts/app"
RELEASE="ci-test"
PASS=0
FAIL=0

pass() { printf "  ✅ %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  ❌ FAIL: %s\n" "$1"; FAIL=$((FAIL + 1)); }

# assert_contains <rendered_manifest> <label> <extended_regexp>
assert_contains() {
  local manifest="$1" label="$2" pattern="$3"
  if grep -qE "$pattern" <<<"$manifest"; then
    pass "$label"
  else
    fail "$label — expected pattern not found: $pattern"
  fi
}

# assert_not_contains <rendered_manifest> <label> <extended_regexp>
assert_not_contains() {
  local manifest="$1" label="$2" pattern="$3"
  if grep -qE "$pattern" <<<"$manifest"; then
    fail "$label — unexpected pattern found: $pattern"
  else
    pass "$label"
  fi
}

# ── helm lint ─────────────────────────────────────────────────────────────────
echo "=== helm lint ==="

lint_check() {
  local label="$1"; shift
  if helm lint "$@" >/dev/null 2>&1; then
    pass "lint: $label"
  else
    fail "lint: $label"
    helm lint "$@" || true
  fi
}

lint_check "base chart"                  "$CHART"
lint_check "values-dev.yaml"  "$CHART" -f "$CHART/values-dev.yaml"
lint_check "values-test.yaml" "$CHART" -f "$CHART/values-test.yaml"
lint_check "values-prod.yaml" "$CHART" -f "$CHART/values-prod.yaml"

# ── base chart (default values) ───────────────────────────────────────────────
echo ""
echo "=== base chart (default values) ==="
BASE=$(helm template "$RELEASE" "$CHART")

assert_contains     "$BASE" "base: frontend Deployment present"         "kind: Deployment"
assert_contains     "$BASE" "base: Service present"                     "kind: Service"
assert_contains     "$BASE" "base: ops-api Deployment present"          "name: ${RELEASE}-app-ops-api"
assert_contains     "$BASE" "base: ops-api Service present"             "name: ${RELEASE}-app-ops-api"
assert_not_contains "$BASE" "base: oauth2-proxy disabled by default"   "component: oauth2-proxy"
assert_not_contains "$BASE" "base: admin temporal ingress disabled"     "temporal-ui-admin"
assert_not_contains "$BASE" "base: admin grafana ingress disabled"      "grafana-admin"
assert_not_contains "$BASE" "base: temporal-ui disabled by default"     "component: temporal-ui"
assert_not_contains "$BASE" "base: ServiceMonitor disabled by default"  "kind: ServiceMonitor"
assert_not_contains "$BASE" "base: PrometheusRule disabled by default"  "kind: PrometheusRule"
assert_contains     "$BASE" "base: secretKeyRef used for frontend key"  "secretKeyRef"
# No Ingress by default
assert_not_contains "$BASE" "base: no Ingress rendered by default"      "kind: Ingress"
# Sensitive env vars must not appear as plain value: fields
assert_not_contains "$BASE" "base: VITE_SUPABASE_ANON_KEY not literal"      "value:.*VITE_SUPABASE_ANON_KEY"
assert_not_contains "$BASE" "base: SUPABASE_SERVICE_ROLE_KEY not literal"    "value:.*SUPABASE_SERVICE_ROLE_KEY"
# Default tag is "latest" (mutable) → pullPolicy must NOT be IfNotPresent (ADR-0010)
assert_not_contains "$BASE" "base: pullPolicy not IfNotPresent with mutable tag" "imagePullPolicy: IfNotPresent"
assert_contains     "$BASE" "base: pod runAsNonRoot enabled"             "runAsNonRoot: true"
assert_contains     "$BASE" "base: frontend runAsUser non-root"          "runAsUser: 101"
assert_contains     "$BASE" "base: worker runAsUser non-root"            "runAsUser: 10001"
assert_contains     "$BASE" "base: seccomp runtime default"              "type: RuntimeDefault"
assert_contains     "$BASE" "base: priv-esc disabled"                    "allowPrivilegeEscalation: false"
assert_contains     "$BASE" "base: root fs readonly"                     "readOnlyRootFilesystem: true"
assert_contains     "$BASE" "base: all capabilities dropped"             "drop:"
assert_contains     "$BASE" "base: frontend nginx cache writable mount"  "mountPath: /var/cache/nginx"
assert_contains     "$BASE" "base: frontend run dir writable mount"      "mountPath: /var/run"
assert_contains     "$BASE" "base: worker tmp writable mount"            "name: temporal-worker-tmp"
assert_contains     "$BASE" "base: ops-api tmp writable mount"           "name: ops-api-tmp"
assert_not_contains "$BASE" "base: ops-api SUPABASE_SERVICE_ROLE_KEY not literal" "value:.*SUPABASE_SERVICE_ROLE_KEY"

# ops-api-scoped hardening assertions — these fail if ops-api loses its security contexts
OPS_API_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: ops-api/' <<<"$BASE")
assert_contains "$OPS_API_DEPLOY" "base: ops-api podSecurityContext runAsNonRoot"    "runAsNonRoot: true"
assert_contains "$OPS_API_DEPLOY" "base: ops-api podSecurityContext runAsUser=10001" "runAsUser: 10001"
assert_contains "$OPS_API_DEPLOY" "base: ops-api seccomp RuntimeDefault"             "type: RuntimeDefault"
assert_contains "$OPS_API_DEPLOY" "base: ops-api allowPrivilegeEscalation=false"     "allowPrivilegeEscalation: false"
assert_contains "$OPS_API_DEPLOY" "base: ops-api readOnlyRootFilesystem"             "readOnlyRootFilesystem: true"
assert_contains "$OPS_API_DEPLOY" "base: ops-api capabilities.drop ALL"              "drop:"

# frontend-scoped hardening assertions — guardrail: fail if frontend loses its security contexts
FRONTEND_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: frontend/' <<<"$BASE")
assert_contains "$FRONTEND_DEPLOY" "base: frontend podSecurityContext runAsNonRoot"    "runAsNonRoot: true"
assert_contains "$FRONTEND_DEPLOY" "base: frontend podSecurityContext runAsUser=101"   "runAsUser: 101"
assert_contains "$FRONTEND_DEPLOY" "base: frontend podSecurityContext runAsGroup=101"  "runAsGroup: 101"
assert_contains "$FRONTEND_DEPLOY" "base: frontend seccomp RuntimeDefault"             "type: RuntimeDefault"
assert_contains "$FRONTEND_DEPLOY" "base: frontend allowPrivilegeEscalation=false"     "allowPrivilegeEscalation: false"
assert_contains "$FRONTEND_DEPLOY" "base: frontend readOnlyRootFilesystem"             "readOnlyRootFilesystem: true"
assert_contains "$FRONTEND_DEPLOY" "base: frontend capabilities.drop ALL"              "drop:"
# frontend writable-path mounts — entrypoint writes to /tmp; nginx needs /var/cache/nginx and /var/run
assert_contains "$FRONTEND_DEPLOY" "base: frontend /tmp writable emptyDir mount"       "mountPath: /tmp"
assert_contains "$FRONTEND_DEPLOY" "base: frontend /var/cache/nginx writable mount"    "mountPath: /var/cache/nginx"
assert_contains "$FRONTEND_DEPLOY" "base: frontend /var/run writable mount"            "mountPath: /var/run"

# temporal-worker-scoped hardening assertions — guardrail: fail if worker loses its security contexts
WORKER_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: temporal-worker/' <<<"$BASE")
assert_contains "$WORKER_DEPLOY" "base: temporal-worker podSecurityContext runAsNonRoot"     "runAsNonRoot: true"
assert_contains "$WORKER_DEPLOY" "base: temporal-worker podSecurityContext runAsUser=10001"  "runAsUser: 10001"
assert_contains "$WORKER_DEPLOY" "base: temporal-worker podSecurityContext runAsGroup=10001" "runAsGroup: 10001"
assert_contains "$WORKER_DEPLOY" "base: temporal-worker seccomp RuntimeDefault"              "type: RuntimeDefault"
assert_contains "$WORKER_DEPLOY" "base: temporal-worker allowPrivilegeEscalation=false"      "allowPrivilegeEscalation: false"
assert_contains "$WORKER_DEPLOY" "base: temporal-worker readOnlyRootFilesystem"              "readOnlyRootFilesystem: true"
assert_contains "$WORKER_DEPLOY" "base: temporal-worker capabilities.drop ALL"               "drop:"
# temporal-worker writable-path mount — worker needs /tmp for transient files
assert_contains "$WORKER_DEPLOY" "base: temporal-worker /tmp writable emptyDir mount"        "mountPath: /tmp"

# ── digest rendering (inline render with --set) ────────────────────────────────
echo ""
echo "=== digest rendering ==="
DIGEST_SHA="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
DIGEST_RENDER=$(helm template "$RELEASE" "$CHART" \
  --set "imageRegistry=example.azurecr.io" \
  --set "frontend.image.repository=frontend" \
  --set "frontend.image.digest=${DIGEST_SHA}" \
  --set "temporalWorker.image.repository=temporal-worker" \
  --set "temporalWorker.image.digest=${DIGEST_SHA}" \
  --set "opsApi.image.repository=temporal-worker" \
  --set "opsApi.image.digest=${DIGEST_SHA}")

assert_contains     "$DIGEST_RENDER" "digest: frontend image uses @sha256: form"         "image: example.azurecr.io/frontend@sha256:"
assert_contains     "$DIGEST_RENDER" "digest: worker image uses @sha256: form"           "image: example.azurecr.io/temporal-worker@sha256:"
assert_contains     "$DIGEST_RENDER" "digest: ops-api image uses @sha256: form"          "image: example.azurecr.io/temporal-worker@sha256:"
assert_not_contains "$DIGEST_RENDER" "digest: no :tag suffix when digest is set"         "image: example.azurecr.io/frontend:latest"

# ── dev profile ───────────────────────────────────────────────────────────────
echo ""
echo "=== values-dev.yaml ==="
DEV=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-dev.yaml")
DEV_VALUES=$(cat "$CHART/values-dev.yaml")
DEV_TEMPORAL_TARGET="temporal-frontend.dev.svc.cluster.local:7233"
DEV_TEMPORAL_TARGET_REGEX="${DEV_TEMPORAL_TARGET//./\\.}"
DEV_VALUES_TEMPORAL_TARGET_COUNT=$(grep -cF "address: \"$DEV_TEMPORAL_TARGET\"" <<<"$DEV_VALUES")

assert_contains     "$DEV" "dev: frontend Deployment renders"           "kind: Deployment"
assert_contains     "$DEV" "dev: frontend replicas=1"                   "replicas: 1"
assert_not_contains "$DEV" "dev: no Ingress (ingress.enabled=false)"    "kind: Ingress"
assert_not_contains "$DEV" "dev: oauth2-proxy disabled"                  "component: oauth2-proxy"
# Scope to the frontend Service document in the multi-doc helm template output.
DEV_FRONTEND_SERVICE=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /app.kubernetes.io\/component: frontend/' <<<"$DEV")
if [ -z "$DEV_FRONTEND_SERVICE" ]; then
  fail "dev: frontend Service manifest extracted"
else
  pass "dev: frontend Service manifest extracted"
fi
assert_contains     "$DEV_FRONTEND_SERVICE" "dev: frontend service type=LoadBalancer" "type: LoadBalancer"
assert_contains     "$DEV" "dev: frontend image tag=dev-latest"         "image: (.*/)?frontend:dev-latest"
assert_contains     "$DEV" "dev: worker image tag=dev-latest"           "image: (.*/)?temporal-worker:dev-latest"
assert_contains     "$DEV" "dev: ops-api image tag=dev-latest"          "image: (.*/)?temporal-worker:dev-latest"
assert_contains     "$DEV" "dev: temporal namespace=wynne-dev"          "wynne-dev"
assert_contains     "$DEV" "dev: temporal taskQueue=wynne-dev-main"     "wynne-dev-main"
assert_contains     "$DEV" "dev: secretKeyRef present"                  "secretKeyRef"
assert_contains     "$DEV" "dev: frontend secret=frontend-secrets-wynne-dev"       "frontend-secrets-wynne-dev"
assert_contains     "$DEV" "dev: worker secret=temporal-worker-secrets-wynne-dev"  "temporal-worker-secrets-wynne-dev"
assert_contains     "$DEV" "dev: ops-api health endpoint configured"    "/api/ops/health"
assert_contains     "$DEV_VALUES" "dev values: frontend Supabase URL uses HTTPS"    "supabaseUrl: \"https://"
assert_contains     "$DEV_VALUES" "dev values: frontend API URL uses HTTPS"         "apiUrl: \"https://"
if [[ "$DEV_VALUES_TEMPORAL_TARGET_COUNT" -eq 2 ]]; then
  pass "dev values: temporal addresses stay on dev namespace service"
else
  fail "dev values: temporal addresses stay on dev namespace service (expected 2 matches for $DEV_TEMPORAL_TARGET, found $DEV_VALUES_TEMPORAL_TARGET_COUNT)"
fi
assert_not_contains "$DEV" "dev: VITE_SUPABASE_ANON_KEY not literal"   "value:.*VITE_SUPABASE_ANON_KEY"
assert_not_contains "$DEV" "dev: SUPABASE_SERVICE_ROLE_KEY not literal" "value:.*SUPABASE_SERVICE_ROLE_KEY"

# dev profile: scoped hardening guardrails for frontend and temporal-worker
DEV_OPS_API_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: ops-api/' <<<"$DEV")
assert_contains "$DEV_OPS_API_DEPLOY" "dev: ops-api Temporal endpoint uses dev namespace service" "$DEV_TEMPORAL_TARGET_REGEX"
assert_not_contains "$DEV_OPS_API_DEPLOY" "dev: ops-api no nonexistent temporal namespace hostname" "temporal-frontend.temporal.svc.cluster.local:7233"
DEV_FRONTEND_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: frontend/' <<<"$DEV")
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend runAsNonRoot"              "runAsNonRoot: true"
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend runAsUser=101"             "runAsUser: 101"
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend seccomp RuntimeDefault"    "type: RuntimeDefault"
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend allowPrivilegeEscalation"  "allowPrivilegeEscalation: false"
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend readOnlyRootFilesystem"    "readOnlyRootFilesystem: true"
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend /tmp writable mount"       "mountPath: /tmp"
DEV_WORKER_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: temporal-worker/' <<<"$DEV")
assert_contains "$DEV_WORKER_DEPLOY" "dev: temporal-worker endpoint uses dev namespace service" "$DEV_TEMPORAL_TARGET_REGEX"
assert_not_contains "$DEV_WORKER_DEPLOY" "dev: temporal-worker no nonexistent temporal namespace hostname" "temporal-frontend.temporal.svc.cluster.local:7233"
assert_contains "$DEV_WORKER_DEPLOY" "dev: temporal-worker runAsNonRoot"             "runAsNonRoot: true"
assert_contains "$DEV_WORKER_DEPLOY" "dev: temporal-worker runAsUser=10001"          "runAsUser: 10001"
assert_contains "$DEV_WORKER_DEPLOY" "dev: temporal-worker seccomp RuntimeDefault"   "type: RuntimeDefault"
assert_contains "$DEV_WORKER_DEPLOY" "dev: temporal-worker allowPrivilegeEscalation" "allowPrivilegeEscalation: false"
assert_contains "$DEV_WORKER_DEPLOY" "dev: temporal-worker readOnlyRootFilesystem"   "readOnlyRootFilesystem: true"
assert_contains "$DEV_WORKER_DEPLOY" "dev: temporal-worker /tmp writable mount"      "mountPath: /tmp"

# dev profile: live-env deploy wiring — acr-pull imagePullSecret, in-cluster Temporal, resource sizing
# These assertions guard the settings that keep the live dev environment working after PR #106/#407.
DEV_OPS_API_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: ops-api/' <<<"$DEV")
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend imagePullSecrets=acr-pull"    "name: acr-pull"
assert_contains "$DEV_WORKER_DEPLOY"   "dev: temporal-worker imagePullSecrets=acr-pull" "name: acr-pull"
assert_contains "$DEV_OPS_API_DEPLOY"  "dev: ops-api imagePullSecrets=acr-pull"     "name: acr-pull"
assert_contains "$DEV_WORKER_DEPLOY" "dev: temporal-worker temporal address=in-cluster svc" \
  "$DEV_TEMPORAL_TARGET_REGEX"
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend memory request=512Mi"         "memory: 512Mi"
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend memory limit=1Gi"             "memory: 1Gi"
assert_contains "$DEV_FRONTEND_DEPLOY" "dev: frontend cpu request=100m"             "cpu: 100m"

# dev profile: observability — Temporal UI rendered with a writable config mount
# so the upstream entrypoint can write ./config/docker.yaml while staying non-root.
DEV_TEMPORAL_UI_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: temporal-ui/' <<<"$DEV")
DEV_TEMPORAL_UI_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /component: temporal-ui/' <<<"$DEV")
DEV_WORKER_METRICS_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /component: temporal-worker-metrics/' <<<"$DEV")
if [ -z "$DEV_TEMPORAL_UI_DEPLOY" ]; then
  fail "dev observability: Temporal UI Deployment missing"
else
  pass "dev observability: Temporal UI Deployment rendered"
fi
if [ -z "$DEV_TEMPORAL_UI_SVC" ]; then
  fail "dev observability: Temporal UI Service missing"
else
  pass "dev observability: Temporal UI Service rendered"
fi
assert_contains "$DEV_TEMPORAL_UI_SVC"    "dev observability: Temporal UI Service port=8080"      "port: 8080"
assert_contains "$DEV_TEMPORAL_UI_DEPLOY" "dev observability: Temporal UI runAsNonRoot"            "runAsNonRoot: true"
assert_contains "$DEV_TEMPORAL_UI_DEPLOY" "dev observability: Temporal UI runAsUser=1000"         "runAsUser: 1000"
assert_contains "$DEV_TEMPORAL_UI_DEPLOY" "dev observability: Temporal UI config mount path"      "mountPath: /home/ui-server/config"
assert_contains "$DEV_TEMPORAL_UI_DEPLOY" "dev observability: Temporal UI config emptyDir volume" "emptyDir:"
assert_contains "$DEV_WORKER_METRICS_SVC" "dev observability: worker-metrics Service rendered"     "kind: Service"
assert_contains "$DEV_WORKER_METRICS_SVC" "dev observability: worker-metrics Service port=9000"    "port: 9000"
assert_not_contains "$DEV" "dev observability: ServiceMonitor disabled by default in dev" "kind: ServiceMonitor"
assert_not_contains "$DEV" "dev observability: PrometheusRule disabled by default in dev" "kind: PrometheusRule"
assert_not_contains "$DEV" "dev observability: Grafana dashboards disabled by default in dev" "grafana-ops-api-dashboard"

DEV_DIGEST_RENDER=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-dev.yaml" \
  --set "frontend.image.digest=${DIGEST_SHA}" \
  --set "frontend.image.tag=digest-dev-audit" \
  --set "temporalWorker.image.digest=${DIGEST_SHA}" \
  --set "temporalWorker.image.tag=digest-dev-audit")
assert_contains     "$DEV_DIGEST_RENDER" "dev digest: frontend render pins digest ref"      "image: .*frontend@sha256:"
assert_contains     "$DEV_DIGEST_RENDER" "dev digest: worker render pins digest ref"        "image: .*temporal-worker@sha256:"
assert_not_contains "$DEV_DIGEST_RENDER" "dev digest: frontend render does not fall back to tag" \
  "image: .*frontend:digest-dev-audit"
assert_not_contains "$DEV_DIGEST_RENDER" "dev digest: worker render does not fall back to tag" \
  "image: .*temporal-worker:digest-dev-audit"

# ── test profile ──────────────────────────────────────────────────────────────
echo ""
echo "=== values-test.yaml ==="
TEST=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-test.yaml")
TEST_ADMIN=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-test.yaml" \
  --set "adminAccess.enabled=true")

assert_contains     "$TEST" "test: frontend Deployment renders"          "kind: Deployment"
assert_contains     "$TEST" "test: frontend replicas=2"                  "replicas: 2"
assert_not_contains "$TEST" "test: Ingress disabled for UAT profile"     "kind: Ingress"
assert_contains     "$TEST" "test: frontend Service type=LoadBalancer"   "type: LoadBalancer"
assert_not_contains "$TEST" "test: oauth2-proxy deployment disabled"     "component: oauth2-proxy"
assert_not_contains "$TEST" "test: grafana oauth2-proxy removed"          "component: oauth2-proxy-grafana"
assert_not_contains "$TEST" "test: temporal admin ingress disabled"      "temporal\\.wynne-test\\.example\\.com"
assert_not_contains "$TEST" "test: grafana admin ingress disabled"       "grafana\\.wynne-test\\.example\\.com"
assert_not_contains "$TEST" "test: oauth2-proxy admin group absent"      "\\-\\-allowed-group=admin"
assert_not_contains "$TEST" "test: grafana ingress not via oauth2-proxy" "grafana-oauth2-proxy"
assert_contains     "$TEST" "test: frontend image tag prefix=test-"      "image: frontend:test-"
assert_contains     "$TEST" "test: worker image tag prefix=test-"        "image: temporal-worker:test-"
assert_contains     "$TEST" "test: ops-api image tag prefix=test- (shared temporal-worker image)" "image: temporal-worker:test-"
assert_contains     "$TEST" "test: temporal namespace=wynne-test"        "wynne-test"
assert_contains     "$TEST" "test: temporal taskQueue=wynne-test-main"   "wynne-test-main"
assert_contains     "$TEST" "test: secretKeyRef present"                 "secretKeyRef"
assert_contains     "$TEST" "test: frontend secret=frontend-secrets-wynne-test"       "frontend-secrets-wynne-test"
assert_contains     "$TEST" "test: worker secret=temporal-worker-secrets-wynne-test"  "temporal-worker-secrets-wynne-test"
assert_not_contains "$TEST" "test: VITE_SUPABASE_ANON_KEY not literal"   "value:.*VITE_SUPABASE_ANON_KEY"
assert_not_contains "$TEST" "test: SUPABASE_SERVICE_ROLE_KEY not literal" "value:.*SUPABASE_SERVICE_ROLE_KEY"

# test profile: scoped hardening guardrails for frontend and temporal-worker
TEST_FRONTEND_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: frontend/' <<<"$TEST")
assert_contains "$TEST_FRONTEND_DEPLOY" "test: frontend runAsNonRoot"              "runAsNonRoot: true"
assert_contains "$TEST_FRONTEND_DEPLOY" "test: frontend runAsUser=101"             "runAsUser: 101"
assert_contains "$TEST_FRONTEND_DEPLOY" "test: frontend seccomp RuntimeDefault"    "type: RuntimeDefault"
assert_contains "$TEST_FRONTEND_DEPLOY" "test: frontend allowPrivilegeEscalation"  "allowPrivilegeEscalation: false"
assert_contains "$TEST_FRONTEND_DEPLOY" "test: frontend readOnlyRootFilesystem"    "readOnlyRootFilesystem: true"
assert_contains "$TEST_FRONTEND_DEPLOY" "test: frontend /tmp writable mount"       "mountPath: /tmp"
TEST_WORKER_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: temporal-worker/' <<<"$TEST")
assert_contains "$TEST_WORKER_DEPLOY" "test: temporal-worker runAsNonRoot"             "runAsNonRoot: true"
assert_contains "$TEST_WORKER_DEPLOY" "test: temporal-worker runAsUser=10001"          "runAsUser: 10001"
assert_contains "$TEST_WORKER_DEPLOY" "test: temporal-worker seccomp RuntimeDefault"   "type: RuntimeDefault"
assert_contains "$TEST_WORKER_DEPLOY" "test: temporal-worker allowPrivilegeEscalation" "allowPrivilegeEscalation: false"
assert_contains "$TEST_WORKER_DEPLOY" "test: temporal-worker readOnlyRootFilesystem"   "readOnlyRootFilesystem: true"
assert_contains "$TEST_WORKER_DEPLOY" "test: temporal-worker /tmp writable mount"      "mountPath: /tmp"

# test profile: observability/admin disabled in UAT
TEST_WORKER_METRICS_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /component: temporal-worker-metrics/' <<<"$TEST")
assert_not_contains "$TEST"                "test observability: Temporal UI Service disabled"        "component: temporal-ui"
assert_contains "$TEST_WORKER_METRICS_SVC" "test observability: worker-metrics Service rendered"    "kind: Service"
assert_not_contains "$TEST"                "test observability: ServiceMonitor disabled"             "kind: ServiceMonitor"
assert_not_contains "$TEST"                "test observability: PrometheusRule disabled"             "kind: PrometheusRule"
assert_not_contains "$TEST"                "test observability: Grafana dashboard ConfigMaps disabled" "grafana_dashboard"
assert_not_contains "$TEST"                "test observability: TemporalWorkerDown alert disabled"   "TemporalWorkerDown"
assert_not_contains "$TEST"                "test observability: OpsApiDown alert disabled"           "OpsApiDown"
assert_not_contains "$TEST"                "test observability: TemporalWorkflowFailureSpike alert disabled" "TemporalWorkflowFailureSpike"
assert_not_contains "$TEST"                "test observability: kube-prometheus-stack label absent"  "release: observability"
# Grafana upstream DNS contract — must point at the observability Helm release in wynne-observability (PR #789)
TEST_GRAFANA_ROUTE=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /component: grafana-admin-upstream/' <<<"$TEST")
assert_not_contains "$TEST_GRAFANA_ROUTE" "test observability: Grafana upstream route not rendered with adminAccess=false" \
  "observability-grafana\\.wynne-observability\\.svc\\.cluster\\.local"
# test profile: deeper observability guardrails — Temporal UI Deployment, scrape config alignment, full alert set
TEST_TEMPORAL_UI_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: temporal-ui/' <<<"$TEST")
if [ -z "$TEST_TEMPORAL_UI_DEPLOY" ]; then
  pass "test observability: Temporal UI Deployment disabled"
else
  fail "test observability: Temporal UI Deployment unexpectedly rendered"
fi
assert_contains "$TEST_WORKER_METRICS_SVC" "test observability: worker-metrics Service port=9000"          "port: 9000"
assert_not_contains "$TEST"                "test observability: ServiceMonitor scrape path disabled"        "path: /metrics"
assert_not_contains "$TEST"                "test observability: ServiceMonitor ops-api port name disabled"  "port: http"
assert_not_contains "$TEST"                "test observability: ServiceMonitor worker port name disabled"   "port: metrics"
assert_not_contains "$TEST"                "test observability: TemporalTaskQueueBacklog alert disabled"    "TemporalTaskQueueBacklog"
assert_not_contains "$TEST"                "test observability: OpsRevRecScheduleMiss alert disabled"       "OpsRevRecScheduleMiss"
assert_not_contains "$TEST"                "test observability: ops-api Grafana dashboard ConfigMap disabled" "grafana-ops-api-dashboard"
assert_not_contains "$TEST"                "test observability: temporal-worker Grafana dashboard ConfigMap disabled" "grafana-temporal-dashboard"

TEST_DIGEST_RENDER=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-test.yaml" \
  --set "frontend.image.digest=${DIGEST_SHA}" \
  --set "frontend.image.tag=digest-test-audit" \
  --set "temporalWorker.image.digest=${DIGEST_SHA}" \
  --set "temporalWorker.image.tag=digest-test-audit")
assert_contains     "$TEST_DIGEST_RENDER" "test digest: frontend render pins digest ref"      "image: .*frontend@sha256:"
assert_contains     "$TEST_DIGEST_RENDER" "test digest: worker render pins digest ref"        "image: .*temporal-worker@sha256:"
assert_not_contains "$TEST_DIGEST_RENDER" "test digest: frontend render does not fall back to tag" \
  "image: .*frontend:digest-test-audit"
assert_not_contains "$TEST_DIGEST_RENDER" "test digest: worker render does not fall back to tag" \
  "image: .*temporal-worker:digest-test-audit"

# ── prod profile ──────────────────────────────────────────────────────────────
echo ""
echo "=== values-prod.yaml ==="
PROD=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-prod.yaml")

assert_contains     "$PROD" "prod: frontend Deployment renders"          "kind: Deployment"
assert_contains     "$PROD" "prod: frontend replicas=3"                  "replicas: 3"
assert_contains     "$PROD" "prod: worker replicas=2"                    "replicas: 2"
assert_contains     "$PROD" "prod: Ingress enabled"                      "kind: Ingress"
assert_contains     "$PROD" "prod: ingress host=frontend.wynne.example.com"  "frontend\\.wynne\\.example\\.com"
assert_contains     "$PROD" "prod: ingress className=nginx"              "ingressClassName: nginx"
assert_contains     "$PROD" "prod: oauth2-proxy deployment enabled"      "component: oauth2-proxy"
assert_not_contains "$PROD" "prod: grafana oauth2-proxy removed"          "component: oauth2-proxy-grafana"
assert_contains     "$PROD" "prod: temporal admin ingress host"          "temporal\\.wynne\\.example\\.com"
assert_contains     "$PROD" "prod: grafana admin ingress host"           "grafana\\.wynne\\.example\\.com"
assert_contains     "$PROD" "prod: oauth2-proxy admin group enforced"    "\\-\\-allowed-group=admin"
assert_not_contains "$PROD" "prod: grafana ingress not via oauth2-proxy" "grafana-oauth2-proxy"
assert_contains     "$PROD" "prod: frontend image tag prefix=prod-"      "/frontend:prod-"
assert_contains     "$PROD" "prod: worker image tag prefix=prod-"        "/temporal-worker:prod-"
assert_contains     "$PROD" "prod: ops-api image tag prefix=prod-"       "/temporal-worker:prod-"
assert_contains     "$PROD" "prod: temporal namespace=wynne-prod"        "wynne-prod"
assert_contains     "$PROD" "prod: temporal taskQueue=wynne-prod-main"   "wynne-prod-main"
assert_contains     "$PROD" "prod: secretKeyRef present"                 "secretKeyRef"
assert_contains     "$PROD" "prod: frontend secret=frontend-secrets-wynne-prod"       "frontend-secrets-wynne-prod"
assert_contains     "$PROD" "prod: worker secret=temporal-worker-secrets-wynne-prod"  "temporal-worker-secrets-wynne-prod"
assert_not_contains "$PROD" "prod: VITE_SUPABASE_ANON_KEY not literal"   "value:.*VITE_SUPABASE_ANON_KEY"
assert_not_contains "$PROD" "prod: SUPABASE_SERVICE_ROLE_KEY not literal" "value:.*SUPABASE_SERVICE_ROLE_KEY"

# prod profile: scoped hardening guardrails for frontend and temporal-worker
PROD_FRONTEND_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: frontend/' <<<"$PROD")
assert_contains "$PROD_FRONTEND_DEPLOY" "prod: frontend runAsNonRoot"              "runAsNonRoot: true"
assert_contains "$PROD_FRONTEND_DEPLOY" "prod: frontend runAsUser=101"             "runAsUser: 101"
assert_contains "$PROD_FRONTEND_DEPLOY" "prod: frontend seccomp RuntimeDefault"    "type: RuntimeDefault"
assert_contains "$PROD_FRONTEND_DEPLOY" "prod: frontend allowPrivilegeEscalation"  "allowPrivilegeEscalation: false"
assert_contains "$PROD_FRONTEND_DEPLOY" "prod: frontend readOnlyRootFilesystem"    "readOnlyRootFilesystem: true"
assert_contains "$PROD_FRONTEND_DEPLOY" "prod: frontend /tmp writable mount"       "mountPath: /tmp"
PROD_WORKER_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: temporal-worker/' <<<"$PROD")
assert_contains "$PROD_WORKER_DEPLOY" "prod: temporal-worker runAsNonRoot"             "runAsNonRoot: true"
assert_contains "$PROD_WORKER_DEPLOY" "prod: temporal-worker runAsUser=10001"          "runAsUser: 10001"
assert_contains "$PROD_WORKER_DEPLOY" "prod: temporal-worker seccomp RuntimeDefault"   "type: RuntimeDefault"
assert_contains "$PROD_WORKER_DEPLOY" "prod: temporal-worker allowPrivilegeEscalation" "allowPrivilegeEscalation: false"
assert_contains "$PROD_WORKER_DEPLOY" "prod: temporal-worker readOnlyRootFilesystem"   "readOnlyRootFilesystem: true"
assert_contains "$PROD_WORKER_DEPLOY" "prod: temporal-worker /tmp writable mount"      "mountPath: /tmp"

# prod profile: observability — Temporal UI, ServiceMonitor, PrometheusRule, dashboards
PROD_TEMPORAL_UI_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /component: temporal-ui/' <<<"$PROD")
assert_contains "$PROD_TEMPORAL_UI_SVC" "prod observability: Temporal UI Service rendered"    "kind: Service"
assert_contains "$PROD"                 "prod observability: ServiceMonitor rendered"          "kind: ServiceMonitor"
assert_contains "$PROD"                 "prod observability: PrometheusRule rendered"          "kind: PrometheusRule"
assert_contains "$PROD"                 "prod observability: Grafana dashboard ConfigMaps"     "grafana_dashboard"
assert_contains "$PROD"                 "prod observability: kube-prometheus-stack label"      "release: observability"
# Grafana upstream DNS contract — must point at the observability Helm release in wynne-observability (PR #789)
PROD_GRAFANA_ROUTE=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /component: grafana-admin-upstream/' <<<"$PROD")
assert_contains "$PROD_GRAFANA_ROUTE" "prod observability: Grafana upstream targets observability-grafana service" \
  "observability-grafana\\.wynne-observability\\.svc\\.cluster\\.local"
assert_not_contains "$PROD_GRAFANA_ROUTE" "prod observability: Grafana upstream not stale monitoring namespace" \
  "grafana\\.monitoring\\.svc\\.cluster\\.local"
# prod profile: deeper observability guardrails — Temporal UI Deployment, worker-metrics Service, scrape config, full alert set
PROD_TEMPORAL_UI_DEPLOY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: temporal-ui/' <<<"$PROD")
if [ -z "$PROD_TEMPORAL_UI_DEPLOY" ]; then
  fail "prod observability: Temporal UI Deployment rendered"
else
  pass "prod observability: Temporal UI Deployment rendered"
fi
assert_contains "$PROD_TEMPORAL_UI_DEPLOY" "prod observability: Temporal UI runAsNonRoot"            "runAsNonRoot: true"
assert_contains "$PROD_TEMPORAL_UI_DEPLOY" "prod observability: Temporal UI runAsUser=1000"         "runAsUser: 1000"
assert_contains "$PROD_TEMPORAL_UI_DEPLOY" "prod observability: Temporal UI config mount path"      "mountPath: /home/ui-server/config"
assert_contains "$PROD_TEMPORAL_UI_DEPLOY" "prod observability: Temporal UI config emptyDir volume" "emptyDir:"
PROD_WORKER_METRICS_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /component: temporal-worker-metrics/' <<<"$PROD")
assert_contains "$PROD_WORKER_METRICS_SVC" "prod observability: worker-metrics Service rendered"          "kind: Service"
assert_contains "$PROD_WORKER_METRICS_SVC" "prod observability: worker-metrics Service port=9000"         "port: 9000"
assert_contains "$PROD"                    "prod observability: ServiceMonitor scrape path /metrics"       "path: /metrics"
assert_contains "$PROD"                    "prod observability: ServiceMonitor ops-api port name=http"     "port: http"
assert_contains "$PROD"                    "prod observability: ServiceMonitor worker port name=metrics"   "port: metrics"
assert_contains "$PROD"                    "prod observability: TemporalTaskQueueBacklog alert present"    "TemporalTaskQueueBacklog"
assert_contains "$PROD"                    "prod observability: OpsRevRecScheduleMiss alert present"       "OpsRevRecScheduleMiss"

PROD_DIGEST_RENDER=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-prod.yaml" \
  --set "frontend.image.digest=${DIGEST_SHA}" \
  --set "frontend.image.tag=digest-prod-audit" \
  --set "temporalWorker.image.digest=${DIGEST_SHA}" \
  --set "temporalWorker.image.tag=digest-prod-audit")
assert_contains     "$PROD_DIGEST_RENDER" "prod digest: frontend render pins digest ref"      "image: .*frontend@sha256:"
assert_contains     "$PROD_DIGEST_RENDER" "prod digest: worker render pins digest ref"        "image: .*temporal-worker@sha256:"
assert_not_contains "$PROD_DIGEST_RENDER" "prod digest: frontend render does not fall back to tag" \
  "image: .*frontend:digest-prod-audit"
assert_not_contains "$PROD_DIGEST_RENDER" "prod digest: worker render does not fall back to tag" \
  "image: .*temporal-worker:digest-prod-audit"

# ── admin access gate — oauth2-proxy OIDC wiring ─────────────────────────────
# Deterministic coverage for oauth2-proxy deployments, services, routes,
# and helpers for admin boundaries.
echo ""
echo "=== admin access gate — oauth2-proxy OIDC wiring ==="

# Gate: adminAccess.enabled=false suppresses ALL admin objects
GATE_ALL_OFF=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-test.yaml" \
  --set "adminAccess.enabled=false")
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses temporal oauth2-proxy deployment"   "component: oauth2-proxy"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses grafana oauth2-proxy deployment"    "component: oauth2-proxy-grafana"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses studio oauth2-proxy deployment"     "component: oauth2-proxy-studio"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses prometheus oauth2-proxy deployment" "component: oauth2-proxy-prometheus"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses alertmanager oauth2-proxy deployment" "component: oauth2-proxy-alertmanager"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses temporal-ui-admin ingress"         "temporal-ui-admin-ingress"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses grafana-admin ingress"             "grafana-admin-ingress"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses studio-admin ingress"              "studio-admin-ingress"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses prometheus-admin ingress"          "prometheus-admin-ingress"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses alertmanager-admin ingress"        "alertmanager-admin-ingress"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses temporal-ui-upstream service"      "temporal-ui-admin-upstream"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses grafana-upstream service"          "grafana-admin-upstream"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses studio-upstream service"           "studio-admin-upstream"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses prometheus-upstream service"       "prometheus-admin-upstream"
assert_not_contains "$GATE_ALL_OFF" "gate: adminAccess.enabled=false suppresses alertmanager-upstream service"     "alertmanager-admin-upstream"

# Gate: grafana.nativeOidc.enabled=false suppresses grafana OIDC ConfigMap + ingress, not temporal
GRAFANA_NATIVEOIDC_OFF=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-test.yaml" \
  --set "adminAccess.enabled=true" \
  --set "adminAccess.grafana.nativeOidc.enabled=false")
assert_not_contains "$GRAFANA_NATIVEOIDC_OFF" "gate: grafana.nativeOidc.enabled=false suppresses grafana admin ingress"    "grafana-admin-ingress"
assert_contains     "$GRAFANA_NATIVEOIDC_OFF" "gate: grafana.nativeOidc.enabled=false keeps temporal proxy deployment"     "component: oauth2-proxy"
assert_contains     "$GRAFANA_NATIVEOIDC_OFF" "gate: grafana.nativeOidc.enabled=false keeps temporal admin ingress"        "temporal-ui-admin-ingress"

# Gate: temporalUi.enabled=false suppresses temporal proxy + ingress + upstream, not grafana
TEMPORAL_UI_OFF=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-test.yaml" \
  --set "adminAccess.enabled=true" \
  --set "adminAccess.temporalUi.enabled=false")
assert_not_contains "$TEMPORAL_UI_OFF" "gate: temporalUi.enabled=false suppresses temporal proxy deployment"     "component: oauth2-proxy$"
assert_not_contains "$TEMPORAL_UI_OFF" "gate: temporalUi.enabled=false suppresses temporal-ui-upstream service" "temporal-ui-admin-upstream"
assert_not_contains "$TEMPORAL_UI_OFF" "gate: temporalUi.enabled=false suppresses temporal-ui-admin ingress"    "temporal-ui-admin-ingress"
assert_contains     "$TEMPORAL_UI_OFF" "gate: temporalUi.enabled=false keeps grafana admin ingress"             "grafana-admin-ingress"

# Scoped: temporal UI oauth2-proxy deployment — upstream target and OIDC wiring
TEST_TEMPORAL_PROXY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: oauth2-proxy/ && !/component: oauth2-proxy-grafana/' <<<"$TEST_ADMIN")
assert_contains "$TEST_TEMPORAL_PROXY" "test: temporal oauth2-proxy upstream targets temporal-ui-upstream service" \
  "upstream=http://.*-temporal-ui-upstream:"
assert_contains "$TEST_TEMPORAL_PROXY" "test: temporal oauth2-proxy upstream port=8080" \
  "upstream=http://.*-temporal-ui-upstream:8080"
assert_contains "$TEST_TEMPORAL_PROXY" "test: temporal oauth2-proxy allowed-group=admin enforced" \
  "\\-\\-allowed-group=admin"
assert_contains "$TEST_TEMPORAL_PROXY" "test: temporal oauth2-proxy CLIENT_ID uses secretKeyRef" \
  "OAUTH2_PROXY_CLIENT_ID"
assert_contains "$TEST_TEMPORAL_PROXY" "test: temporal oauth2-proxy CLIENT_SECRET uses secretKeyRef" \
  "OAUTH2_PROXY_CLIENT_SECRET"
assert_contains "$TEST_TEMPORAL_PROXY" "test: temporal oauth2-proxy COOKIE_SECRET uses secretKeyRef" \
  "OAUTH2_PROXY_COOKIE_SECRET"
assert_contains "$TEST_TEMPORAL_PROXY" "test: temporal oauth2-proxy sets x-auth-request headers" \
  "\\-\\-set-xauthrequest=true"
assert_contains "$TEST_TEMPORAL_PROXY" "test: temporal oauth2-proxy OIDC credentials not plain env values" \
  "secretKeyRef"
assert_not_contains "$TEST_TEMPORAL_PROXY" "test: temporal oauth2-proxy CLIENT_ID not a plain env value" \
  "value: .*OAUTH2_PROXY_CLIENT_ID"

# Scoped: studio oauth2-proxy deployment — upstream target and OIDC wiring
TEST_STUDIO_PROXY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: oauth2-proxy-studio/' <<<"$TEST_ADMIN")
assert_contains "$TEST_STUDIO_PROXY" "test: studio oauth2-proxy upstream targets studio-upstream service" \
  "upstream=http://.*-studio-upstream:"
assert_contains "$TEST_STUDIO_PROXY" "test: studio oauth2-proxy upstream port=3000" \
  "upstream=http://.*-studio-upstream:3000"
assert_contains "$TEST_STUDIO_PROXY" "test: studio oauth2-proxy allowed-group=admin enforced" \
  "\\-\\-allowed-group=admin"
assert_contains "$TEST_STUDIO_PROXY" "test: studio oauth2-proxy sets x-auth-request headers" \
  "\\-\\-set-xauthrequest=true"
assert_contains "$TEST_STUDIO_PROXY" "test: studio oauth2-proxy OIDC credentials not plain env values" \
  "secretKeyRef"

# Scoped: prometheus oauth2-proxy deployment — upstream target and OIDC wiring
TEST_PROMETHEUS_PROXY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: oauth2-proxy-prometheus/' <<<"$TEST_ADMIN")
assert_contains "$TEST_PROMETHEUS_PROXY" "test: prometheus oauth2-proxy upstream targets prometheus-upstream service" \
  "upstream=http://.*-prometheus-upstream:"
assert_contains "$TEST_PROMETHEUS_PROXY" "test: prometheus oauth2-proxy upstream port=9090" \
  "upstream=http://.*-prometheus-upstream:9090"
assert_contains "$TEST_PROMETHEUS_PROXY" "test: prometheus oauth2-proxy allowed-group=admin enforced" \
  "\\-\\-allowed-group=admin"
assert_contains "$TEST_PROMETHEUS_PROXY" "test: prometheus oauth2-proxy sets x-auth-request headers" \
  "\\-\\-set-xauthrequest=true"
assert_contains "$TEST_PROMETHEUS_PROXY" "test: prometheus oauth2-proxy OIDC credentials not plain env values" \
  "secretKeyRef"

# Scoped: alertmanager oauth2-proxy deployment — upstream target and OIDC wiring
TEST_ALERTMANAGER_PROXY=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Deployment/ && /component: oauth2-proxy-alertmanager/' <<<"$TEST_ADMIN")
assert_contains "$TEST_ALERTMANAGER_PROXY" "test: alertmanager oauth2-proxy upstream targets alertmanager-upstream service" \
  "upstream=http://.*-alertmanager-upstream:"
assert_contains "$TEST_ALERTMANAGER_PROXY" "test: alertmanager oauth2-proxy upstream port=9093" \
  "upstream=http://.*-alertmanager-upstream:9093"
assert_contains "$TEST_ALERTMANAGER_PROXY" "test: alertmanager oauth2-proxy allowed-group=admin enforced" \
  "\\-\\-allowed-group=admin"
assert_contains "$TEST_ALERTMANAGER_PROXY" "test: alertmanager oauth2-proxy sets x-auth-request headers" \
  "\\-\\-set-xauthrequest=true"
assert_contains "$TEST_ALERTMANAGER_PROXY" "test: alertmanager oauth2-proxy OIDC credentials not plain env values" \
  "secretKeyRef"


# Scoped: temporal-ui-upstream ExternalName service
TEST_TEMPORAL_UPSTREAM_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /temporal-ui-admin-upstream/' <<<"$TEST_ADMIN")
assert_contains "$TEST_TEMPORAL_UPSTREAM_SVC" "test: temporal-ui-upstream service type=ExternalName" \
  "type: ExternalName"
assert_contains "$TEST_TEMPORAL_UPSTREAM_SVC" "test: temporal-ui-upstream externalName=rental-app-temporal-ui.wynne-test.svc.cluster.local" \
  "externalName: .*rental-app-temporal-ui\.wynne-test\.svc\.cluster\.local"
assert_contains "$TEST_TEMPORAL_UPSTREAM_SVC" "test: temporal-ui-upstream service port=8080" \
  "port: 8080"

# Scoped: grafana-upstream ExternalName service
TEST_GRAFANA_UPSTREAM_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /grafana-admin-upstream/' <<<"$TEST_ADMIN")
assert_contains "$TEST_GRAFANA_UPSTREAM_SVC" "test: grafana-upstream service type=ExternalName" \
  "type: ExternalName"
assert_contains "$TEST_GRAFANA_UPSTREAM_SVC" "test: grafana-upstream externalName=observability-grafana.wynne-observability.svc.cluster.local" \
  "externalName: .*observability-grafana\.wynne-observability\.svc\.cluster\.local"
assert_contains "$TEST_GRAFANA_UPSTREAM_SVC" "test: grafana-upstream service port=80" \
  "port: 80"

# Scoped: studio-upstream ExternalName service
TEST_STUDIO_UPSTREAM_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /studio-admin-upstream/' <<<"$TEST_ADMIN")
assert_contains "$TEST_STUDIO_UPSTREAM_SVC" "test: studio-upstream service type=ExternalName" \
  "type: ExternalName"
assert_contains "$TEST_STUDIO_UPSTREAM_SVC" "test: studio-upstream externalName=supabase-supabase-studio.wynne-supabase.svc.cluster.local" \
  "externalName: .*supabase-supabase-studio\.wynne-supabase\.svc\.cluster\.local"
assert_contains "$TEST_STUDIO_UPSTREAM_SVC" "test: studio-upstream service port=3000" \
  "port: 3000"

# Scoped: prometheus-upstream ExternalName service
TEST_PROMETHEUS_UPSTREAM_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /prometheus-admin-upstream/' <<<"$TEST_ADMIN")
assert_contains "$TEST_PROMETHEUS_UPSTREAM_SVC" "test: prometheus-upstream service type=ExternalName" \
  "type: ExternalName"
assert_contains "$TEST_PROMETHEUS_UPSTREAM_SVC" "test: prometheus-upstream externalName=observability-kube-prometheus-stack-prometheus.wynne-observability.svc.cluster.local" \
  "externalName: .*observability-kube-prometheus-stack-prometheus\.wynne-observability\.svc\.cluster\.local"
assert_contains "$TEST_PROMETHEUS_UPSTREAM_SVC" "test: prometheus-upstream service port=9090" \
  "port: 9090"

# Scoped: alertmanager-upstream ExternalName service
TEST_ALERTMANAGER_UPSTREAM_SVC=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Service/ && /alertmanager-admin-upstream/' <<<"$TEST_ADMIN")
assert_contains "$TEST_ALERTMANAGER_UPSTREAM_SVC" "test: alertmanager-upstream service type=ExternalName" \
  "type: ExternalName"
assert_contains "$TEST_ALERTMANAGER_UPSTREAM_SVC" "test: alertmanager-upstream externalName=observability-kube-prometheus-stack-alertmanager.wynne-observability.svc.cluster.local" \
  "externalName: .*observability-kube-prometheus-stack-alertmanager\.wynne-observability\.svc\.cluster\.local"
assert_contains "$TEST_ALERTMANAGER_UPSTREAM_SVC" "test: alertmanager-upstream service port=9093" \
  "port: 9093"

# Scoped: temporal UI admin ingress — backend targets oauth2-proxy, not upstream
TEST_TEMPORAL_INGRESS=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Ingress/ && /temporal-ui-admin-ingress/' <<<"$TEST_ADMIN")
assert_contains     "$TEST_TEMPORAL_INGRESS" "test: temporal admin ingress backend targets oauth2-proxy service" \
  "name: .*-oauth2-proxy"
assert_not_contains "$TEST_TEMPORAL_INGRESS" "test: temporal admin ingress backend does not target upstream directly" \
  "name: .*-temporal-ui-upstream"

# Scoped: grafana admin ingress — backend targets grafana-upstream directly (native OIDC; no proxy)
TEST_GRAFANA_INGRESS=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Ingress/ && /grafana-admin-ingress/' <<<"$TEST_ADMIN")
assert_contains     "$TEST_GRAFANA_INGRESS" "test: grafana admin ingress backend targets grafana upstream service" \
  "name: .*-grafana-upstream"
assert_not_contains "$TEST_GRAFANA_INGRESS" "test: grafana admin ingress backend does not use oauth2-proxy" \
  "name: .*-grafana-oauth2-proxy"

# Scoped: studio admin ingress — backend targets studio-oauth2-proxy, not upstream
TEST_STUDIO_INGRESS=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Ingress/ && /studio-admin-ingress/' <<<"$TEST_ADMIN")
assert_contains     "$TEST_STUDIO_INGRESS" "test: studio admin ingress backend targets studio-oauth2-proxy service" \
  "name: .*-studio-oauth2-proxy"
assert_not_contains "$TEST_STUDIO_INGRESS" "test: studio admin ingress backend does not target upstream directly" \
  "name: .*-studio-upstream"

# Scoped: prometheus admin ingress — backend targets prometheus-oauth2-proxy, not upstream
TEST_PROMETHEUS_INGRESS=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Ingress/ && /prometheus-admin-ingress/' <<<"$TEST_ADMIN")
assert_contains     "$TEST_PROMETHEUS_INGRESS" "test: prometheus admin ingress backend targets prometheus-oauth2-proxy service" \
  "name: .*-prometheus-oauth2-proxy"
assert_not_contains "$TEST_PROMETHEUS_INGRESS" "test: prometheus admin ingress backend does not target upstream directly" \
  "name: .*-prometheus-upstream"

# Scoped: alertmanager admin ingress — backend targets alertmanager-oauth2-proxy, not upstream
TEST_ALERTMANAGER_INGRESS=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Ingress/ && /alertmanager-admin-ingress/' <<<"$TEST_ADMIN")
assert_contains     "$TEST_ALERTMANAGER_INGRESS" "test: alertmanager admin ingress backend targets alertmanager-oauth2-proxy service" \
  "name: .*-alertmanager-oauth2-proxy"
assert_not_contains "$TEST_ALERTMANAGER_INGRESS" "test: alertmanager admin ingress backend does not target upstream directly" \
  "name: .*-alertmanager-upstream"

# Helpers: verify scoped name helper output for this release
assert_contains "$TEST_ADMIN" "test: oauth2-proxy service name matches helper"               "name: ${RELEASE}-app-oauth2-proxy"
assert_contains "$TEST_ADMIN" "test: temporal-ui-upstream service name matches helper"       "name: ${RELEASE}-app-temporal-ui-upstream"
assert_contains "$TEST_ADMIN" "test: grafana-upstream service name matches helper"           "name: ${RELEASE}-app-grafana-upstream"
assert_contains "$TEST_ADMIN" "test: studio-upstream service name matches helper"            "name: ${RELEASE}-app-studio-upstream"
assert_contains "$TEST_ADMIN" "test: studio-oauth2-proxy service name matches helper"        "name: ${RELEASE}-app-studio-oauth2-proxy"
assert_contains "$TEST_ADMIN" "test: prometheus-upstream service name matches helper"        "name: ${RELEASE}-app-prometheus-upstream"
assert_contains "$TEST_ADMIN" "test: prometheus-oauth2-proxy service name matches helper"    "name: ${RELEASE}-app-prometheus-oauth2-proxy"
assert_contains "$TEST_ADMIN" "test: alertmanager-upstream service name matches helper"      "name: ${RELEASE}-app-alertmanager-upstream"
assert_contains "$TEST_ADMIN" "test: alertmanager-oauth2-proxy service name matches helper"  "name: ${RELEASE}-app-alertmanager-oauth2-proxy"


# ── workflow contract assertions (ADR-0010 digest promotion) ──────────────────
# Deterministic CI-local checks for the digest handoff contract:
# build-images captures/publishes digests, and deploy-dev/test/prod consume those
# same promoted digests (no tag-only fallback).
echo ""
echo "=== workflow digest-promotion assertions ==="
BUILD_WORKFLOW=".github/workflows/build-images.yml"
if [ ! -f "$BUILD_WORKFLOW" ]; then
  fail "workflow: build-images.yml exists at .github/workflows/build-images.yml"
else
  pass "workflow: build-images.yml exists"

  BUILD_DIGEST_STEP=$(awk '
    /^      - name: Write and upload image digest/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$BUILD_WORKFLOW")
  BUILD_ARTIFACT_STEP=$(awk '
    /^      - name: Upload image digest artifact/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$BUILD_WORKFLOW")

  if [ -z "$BUILD_DIGEST_STEP" ]; then
    fail "workflow: build-images digest-write step extracted"
  else
    pass "workflow: build-images digest-write step extracted"
    assert_contains "$BUILD_DIGEST_STEP" "workflow: build-images writes build output digest to digest.txt" \
      'steps\.build\.outputs\.digest'
    assert_contains "$BUILD_DIGEST_STEP" "workflow: build-images digest write is gated on push-enabled" \
      "if: steps\\.push-gate\\.outputs\\.enabled == 'true'"
  fi
  if [ -z "$BUILD_ARTIFACT_STEP" ]; then
    fail "workflow: build-images digest-artifact step extracted"
  else
    pass "workflow: build-images digest-artifact step extracted"
    assert_contains "$BUILD_ARTIFACT_STEP" "workflow: build-images uploads image-digest-* artifacts" \
      'name: image-digest-\$\{\{ matrix\.image_name \}\}'
    assert_contains "$BUILD_ARTIFACT_STEP" "workflow: build-images uploads digest.txt artifact payload" \
      'path: /tmp/digest\.txt'
  fi
fi

# Assertions are scoped to specific named step blocks — not whole-file grep — so
# mentions in comments or unrelated steps cannot satisfy them.
for ENV_NAME in dev test prod; do
  WORKFLOW_FILE=".github/workflows/deploy-${ENV_NAME}.yml"
  if [ ! -f "$WORKFLOW_FILE" ]; then
    fail "workflow: deploy-${ENV_NAME}.yml exists at .github/workflows/deploy-${ENV_NAME}.yml"
    continue
  fi
  pass "workflow: deploy-${ENV_NAME}.yml exists"
  WORKFLOW_TEXT=$(cat "$WORKFLOW_FILE")
  assert_contains "$WORKFLOW_TEXT" "workflow: deploy-${ENV_NAME} has actions:read permission for cross-run artifact download" \
    "actions: read"

  DOWNLOAD_STEP=$(awk '
    /^      - name: Download image digests from Build Images run/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")
  # dev keeps a single "Resolve and validate image digests" step; test/prod split
  # that into "Resolve digests from artifacts (legacy path)" + "Select digests + audit tag".
  if [ "$ENV_NAME" = "dev" ]; then
    DIGESTS_STEP=$(awk '
      /^      - name: Resolve and validate image digests/{capturing=1; print; next}
      capturing && /^      - name: /{capturing=0}
      capturing{print}
    ' "$WORKFLOW_FILE")
    SELECT_STEP=""
  else
    DIGESTS_STEP=$(awk '
      /^      - name: Resolve digests from artifacts \(legacy path\)/{capturing=1; print; next}
      capturing && /^      - name: /{capturing=0}
      capturing{print}
    ' "$WORKFLOW_FILE")
    SELECT_STEP=$(awk '
      /^      - name: Select digests \+ audit tag/{capturing=1; print; next}
      capturing && /^      - name: /{capturing=0}
      capturing{print}
    ' "$WORKFLOW_FILE")
  fi
  HELM_UPGRADE_STEP=$(awk '
    /^      - name: Helm upgrade \(wynne-'$ENV_NAME'\)/{capturing=1; print; next}
    capturing && (/^  [a-z]/ || /^      - name: /){capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")
  DIAGNOSTICS_STEP=$(awk '
    /^      - name: Diagnose rollout failure \(pods, events, logs\)/{capturing=1; print; next}
    capturing && (/^  [a-z]/ || /^      - name: /){capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")

  if [ -z "$DOWNLOAD_STEP" ]; then
    fail "workflow: deploy-${ENV_NAME} digest-download step extracted"
  else
    pass "workflow: deploy-${ENV_NAME} digest-download step extracted"
    assert_contains "$DOWNLOAD_STEP" "workflow: deploy-${ENV_NAME} download step uses artifact pattern image-digest-*" \
      "pattern: image-digest-\\*"
    assert_contains "$DOWNLOAD_STEP" "workflow: deploy-${ENV_NAME} download step merges digest artifacts by folder" \
      "merge-multiple: false"
    assert_contains "$DOWNLOAD_STEP" "workflow: deploy-${ENV_NAME} download step uses actions/download-artifact@v4" \
      "uses: actions/download-artifact@v4"
    if [ "$ENV_NAME" = "dev" ]; then
      assert_contains "$DOWNLOAD_STEP" "workflow: deploy-dev downloads digests from resolved build_run_id output" \
        'run-id: \$\{\{ steps\.run_ref\.outputs\.build_run_id \}\}'
    else
      assert_contains "$DOWNLOAD_STEP" "workflow: deploy-${ENV_NAME} downloads digests from required build_run_id input" \
        'run-id: \$\{\{ inputs\.build_run_id \}\}'
    fi
  fi

  if [ -z "$DIGESTS_STEP" ]; then
    fail "workflow: deploy-${ENV_NAME} digest-resolve step extracted"
  else
    pass "workflow: deploy-${ENV_NAME} digest-resolve step extracted"
    assert_contains "$DIGESTS_STEP" "workflow: deploy-${ENV_NAME} reads frontend digest artifact file" \
      "image-digest-frontend/digest\\.txt"
    assert_contains "$DIGESTS_STEP" "workflow: deploy-${ENV_NAME} reads temporal-worker digest artifact file" \
      "image-digest-temporal-worker/digest\\.txt"
    if [ "$ENV_NAME" = "dev" ]; then
      assert_contains "$DIGESTS_STEP" "workflow: deploy-dev hard-fails when frontend digest missing" \
        '::error::frontend image digest missing'
      assert_contains "$DIGESTS_STEP" "workflow: deploy-dev hard-fails when worker digest missing" \
        '::error::temporal-worker image digest missing'
    else
      assert_contains "$DIGESTS_STEP" "workflow: deploy-${ENV_NAME} hard-fails when digest artifacts missing" \
        '::error::digest artifacts missing'
    fi
    # shellcheck disable=SC2016
    assert_contains "$DIGESTS_STEP" "workflow: deploy-${ENV_NAME} publishes resolved frontend digest output" \
      'echo "frontend=\$\{FRONTEND_DIGEST\}" >> "\$GITHUB_OUTPUT"'
    # shellcheck disable=SC2016
    assert_contains "$DIGESTS_STEP" "workflow: deploy-${ENV_NAME} publishes resolved worker digest output" \
      'echo "worker=\$\{WORKER_DIGEST\}" >> "\$GITHUB_OUTPUT"'
  fi

  if [ "$ENV_NAME" != "dev" ]; then
    if [ -z "$SELECT_STEP" ]; then
      fail "workflow: deploy-${ENV_NAME} digest-select step extracted"
    else
      pass "workflow: deploy-${ENV_NAME} digest-select step extracted"
      assert_contains "$SELECT_STEP" "workflow: deploy-${ENV_NAME} select step hard-fails when digests cannot be resolved" \
        '::error::failed to resolve both image digests'
      # shellcheck disable=SC2016
      assert_contains "$SELECT_STEP" "workflow: deploy-${ENV_NAME} select step publishes final frontend digest output" \
        'echo "frontend=\$FE"'
      # shellcheck disable=SC2016
      assert_contains "$SELECT_STEP" "workflow: deploy-${ENV_NAME} select step publishes final worker digest output" \
        'echo "worker=\$WK"'
    fi
  fi

  if [ -z "$HELM_UPGRADE_STEP" ]; then
    fail "workflow: deploy-${ENV_NAME} helm-upgrade step extracted"
  else
    pass "workflow: deploy-${ENV_NAME} helm-upgrade step extracted"
    assert_contains "$HELM_UPGRADE_STEP" "workflow: deploy-${ENV_NAME} helm upgrade uses values-${ENV_NAME}.yaml" \
      "charts/app/values-${ENV_NAME}\\.yaml"
    assert_contains "$HELM_UPGRADE_STEP" "workflow: deploy-${ENV_NAME} helm upgrade consumes frontend digest output" \
      'frontend\.image\.digest=\$\{\{ steps\.digests\.outputs\.frontend \}\}'
    assert_contains "$HELM_UPGRADE_STEP" "workflow: deploy-${ENV_NAME} helm upgrade consumes worker digest output" \
      'temporalWorker\.image\.digest=\$\{\{ steps\.digests\.outputs\.worker \}\}'
    assert_contains "$HELM_UPGRADE_STEP" "workflow: deploy-${ENV_NAME} helm upgrade pins ops-api to worker digest output" \
      'opsApi\.image\.digest=\$\{\{ steps\.digests\.outputs\.worker \}\}'
    assert_contains "$HELM_UPGRADE_STEP" "workflow: deploy-${ENV_NAME} helm upgrade still sets audit tag values" \
      "frontend\\.image\\.tag"
  fi

  if [ "$ENV_NAME" = "dev" ]; then
    if [ -z "$DIAGNOSTICS_STEP" ]; then
      fail "workflow: deploy-dev diagnostics step extracted"
    else
      pass "workflow: deploy-dev diagnostics step extracted"
      # shellcheck disable=SC2016
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics checks pods/log auth before log collection" \
        'kubectl auth can-i get pods/log -n "\$ns"'
      # shellcheck disable=SC2016
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics checks events auth before event collection" \
        'kubectl auth can-i list events -n "\$ns"'
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics warns to apply RBAC when events access is missing" \
        "Cannot list events in namespace '\\\$ns'"
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics events warning references RBAC manifest guidance" \
        'Apply or re-apply \$\{rbac_manifest\}'
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics warns to apply RBAC when pod logs access is missing" \
        "Cannot read pod logs in namespace '\\\$ns'"
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics pod logs warning references RBAC manifest guidance" \
        'Apply or re-apply \$\{rbac_manifest\}'
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics captures temporal-worker rollout context group" \
        '::group::temporal-worker rollout context'
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics captures temporal-worker image via named container jsonpath" \
        'containers\[\?\(@\.name=="temporal-worker"\)\]\.image'
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics captures temporal-worker secret wiring" \
        'SUPABASE_SERVICE_ROLE_KEY secret:'
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics compares newest temporal-worker pod describe output" \
        '::group::describe newest temporal-worker pod'
      assert_contains "$DIAGNOSTICS_STEP" "workflow: deploy-dev diagnostics compares previous temporal-worker pod describe output" \
        '::group::describe previous temporal-worker pod'
    fi
  fi
done

# ── nonprod deploy RBAC ───────────────────────────────────────────────────────
echo ""
echo "=== deploy/k8s/rbac-nonprod.yaml ==="
RBAC_NONPROD="deploy/k8s/rbac-nonprod.yaml"
DEV_DEPLOYER_ROLE=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Role/ && /namespace: wynne-dev/ && /name: gha-deployer/' "$RBAC_NONPROD")
TEST_DEPLOYER_ROLE=$(awk 'BEGIN{RS="---\n"; ORS=""} /kind: Role/ && /namespace: wynne-test/ && /name: gha-deployer/' "$RBAC_NONPROD")
assert_contains "$DEV_DEPLOYER_ROLE" "rbac: wynne-dev gha-deployer can read pod logs and events" 'resources: \["pods/log", "events"\]'
assert_contains "$DEV_DEPLOYER_ROLE" "rbac: wynne-dev gha-deployer diagnostics are read-only" 'verbs: \["get", "list", "watch"\]'
assert_contains "$TEST_DEPLOYER_ROLE" "rbac: wynne-test gha-deployer can read pod logs and events" 'resources: \["pods/log", "events"\]'
assert_contains "$TEST_DEPLOYER_ROLE" "rbac: wynne-test gha-deployer diagnostics are read-only" 'verbs: \["get", "list", "watch"\]'
assert_contains "$DEV_DEPLOYER_ROLE"  "rbac: wynne-dev gha-deployer can manage ExternalSecrets (ADR-0100)"  'externalsecrets'
assert_contains "$TEST_DEPLOYER_ROLE" "rbac: wynne-test gha-deployer can manage ExternalSecrets (ADR-0100)" 'externalsecrets'

# ── External Secrets Operator (ESO) template assertions ──────────────────────
# Guard: externalSecrets.enabled=false (default) must not render any ExternalSecret.
# Guard: externalSecrets.enabled=true must render correctly wired ExternalSecret objects.
echo ""
echo "=== external-secrets template ==="

# Default (disabled) — no ExternalSecret resources in any profile.
for PROFILE_LABEL in "base" "dev" "test" "prod"; do
  case "$PROFILE_LABEL" in
    base) ESO_OFF=$(helm template "$RELEASE" "$CHART") ;;
    dev)  ESO_OFF=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-dev.yaml") ;;
    test) ESO_OFF=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-test.yaml") ;;
    prod) ESO_OFF=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-prod.yaml") ;;
  esac
  assert_not_contains "$ESO_OFF" "eso ${PROFILE_LABEL}: no ExternalSecret when disabled (default)" \
    "kind: ExternalSecret"
done

# Enabled — frontend + worker ExternalSecrets rendered with correct secret targets.
ESO_ON=$(helm template "$RELEASE" "$CHART" \
  --set "externalSecrets.enabled=true" \
  --set "externalSecrets.secretStore.name=test-store" \
  --set "externalSecrets.secretStore.kind=ClusterSecretStore" \
  --set "externalSecrets.keys.supabaseAnonKey=my-anon-key" \
  --set "externalSecrets.keys.supabaseServiceRoleKey=my-service-role-key")

assert_contains "$ESO_ON" "eso enabled: ExternalSecret kind present"                "kind: ExternalSecret"
# API must be external-secrets.io/v1 — ESO v2.x no longer serves v1beta1 (ADR-0100).
assert_contains     "$ESO_ON" "eso enabled: ExternalSecret apiVersion=external-secrets.io/v1" "apiVersion: external-secrets.io/v1"
assert_not_contains "$ESO_ON" "eso enabled: no deprecated v1beta1 apiVersion"                 "external-secrets.io/v1beta1"
assert_contains "$ESO_ON" "eso enabled: frontend ExternalSecret present"            "name: ${RELEASE}-app-frontend-eso"
assert_contains "$ESO_ON" "eso enabled: worker ExternalSecret present"              "name: ${RELEASE}-app-temporal-worker-eso"
assert_contains "$ESO_ON" "eso enabled: secretStoreRef name=test-store"             "name: \"test-store\""
assert_contains "$ESO_ON" "eso enabled: secretStoreRef kind=ClusterSecretStore"     "kind: \"ClusterSecretStore\""
assert_contains "$ESO_ON" "eso enabled: frontend target=frontend-secrets"           "name: \"frontend-secrets\""
assert_contains "$ESO_ON" "eso enabled: worker target=temporal-worker-secrets"      "name: \"temporal-worker-secrets\""
assert_contains "$ESO_ON" "eso enabled: frontend maps VITE_SUPABASE_ANON_KEY"       "VITE_SUPABASE_ANON_KEY"
assert_contains "$ESO_ON" "eso enabled: worker maps SUPABASE_SERVICE_ROLE_KEY"      "SUPABASE_SERVICE_ROLE_KEY"
assert_contains "$ESO_ON" "eso enabled: frontend remoteRef=my-anon-key"             "key: \"my-anon-key\""
assert_contains "$ESO_ON" "eso enabled: worker remoteRef=my-service-role-key"       "key: \"my-service-role-key\""
assert_contains "$ESO_ON" "eso enabled: refreshInterval present"                    "refreshInterval:"
assert_contains "$ESO_ON" "eso enabled: creationPolicy=Owner"                       "creationPolicy: Owner"
assert_contains "$ESO_ON" "eso enabled: deletionPolicy=Retain"                      "deletionPolicy: Retain"
# ACR pull ExternalSecret should NOT render when acrPullDockerConfig is empty (default).
assert_not_contains "$ESO_ON" "eso enabled: no acr-pull ESO when key is empty"      "acr-pull-eso"
# Deployments still render secretKeyRef (unchanged contract).
assert_contains "$ESO_ON" "eso enabled: secretKeyRef contract preserved"            "secretKeyRef"
# remoteRef.property is omitted when externalSecrets.properties.* is unset (flat-store layout).
assert_not_contains "$ESO_ON" "eso enabled: no property line when properties unset" "property:"

# remoteRef.property: rendered when externalSecrets.properties.* is set (OpenBao KV-v2 grouped map).
ESO_PROP=$(helm template "$RELEASE" "$CHART" \
  --set "externalSecrets.enabled=true" \
  --set "externalSecrets.secretStore.name=openbao-test" \
  --set "externalSecrets.keys.supabaseAnonKey=wynne/x/runtime" \
  --set "externalSecrets.keys.supabaseServiceRoleKey=wynne/x/runtime" \
  --set "externalSecrets.properties.supabaseAnonKey=anon-key" \
  --set "externalSecrets.properties.supabaseServiceRoleKey=service-role-key")
assert_contains "$ESO_PROP" "eso property: shared path key=wynne/x/runtime"          "key: \"wynne/x/runtime\""
assert_contains "$ESO_PROP" "eso property: frontend field=anon-key"                  "property: \"anon-key\""
assert_contains "$ESO_PROP" "eso property: worker field=service-role-key"            "property: \"service-role-key\""

# ACR pull ESO: rendered when acrPullDockerConfig is set.
ESO_ACR=$(helm template "$RELEASE" "$CHART" \
  --set "externalSecrets.enabled=true" \
  --set "externalSecrets.secretStore.name=test-store" \
  --set "externalSecrets.keys.supabaseAnonKey=my-anon-key" \
  --set "externalSecrets.keys.supabaseServiceRoleKey=my-service-role-key" \
  --set "externalSecrets.keys.acrPullDockerConfig=my-acr-pull-json")
assert_contains "$ESO_ACR" "eso acr: acr-pull-eso ExternalSecret rendered"          "acr-pull-eso"
assert_contains "$ESO_ACR" "eso acr: acr-pull target secret name=acr-pull"          "name: \"acr-pull\""
assert_contains "$ESO_ACR" "eso acr: acr-pull type=dockerconfigjson"                "kubernetes.io/dockerconfigjson"
assert_contains "$ESO_ACR" "eso acr: acr-pull remoteRef=my-acr-pull-json"           "key: \"my-acr-pull-json\""

# ESO with dev values: secret names match secretKeyRef names in dev deployments.
ESO_DEV=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-dev.yaml" \
  --set "externalSecrets.enabled=true" \
  --set "externalSecrets.secretStore.name=test-store")
assert_contains "$ESO_DEV" "eso dev: frontend target=frontend-secrets-wynne-dev"    "frontend-secrets-wynne-dev"
assert_contains "$ESO_DEV" "eso dev: worker target=temporal-worker-secrets-wynne-dev" "temporal-worker-secrets-wynne-dev"
assert_contains "$ESO_DEV" "eso dev: runtime secrets share OpenBao path wynne/dev/runtime" "key: \"wynne/dev/runtime\""
assert_contains "$ESO_DEV" "eso dev: frontend field property=anon-key"              "property: \"anon-key\""
assert_contains "$ESO_DEV" "eso dev: worker field property=service-role-key"        "property: \"service-role-key\""
# dev provisions a scoped ACR pull token at wynne/dev/acr-pull (field: dockerconfigjson).
assert_contains "$ESO_DEV" "eso dev: acr-pull ExternalSecret rendered"              "acr-pull-eso"
assert_contains "$ESO_DEV" "eso dev: acr-pull path=wynne/dev/acr-pull"              "key: \"wynne/dev/acr-pull\""
assert_contains "$ESO_DEV" "eso dev: acr-pull field property=dockerconfigjson"      "property: \"dockerconfigjson\""

# Partial oauth2-proxy keys: only clientId set — must NOT render oauth2-proxy ExternalSecret.
ESO_PARTIAL_OAUTH=$(helm template "$RELEASE" "$CHART" \
  --set "adminAccess.enabled=true" \
  --set "adminAccess.oauth2Proxy.enabled=true" \
  --set "externalSecrets.enabled=true" \
  --set "externalSecrets.secretStore.name=test-store" \
  --set "externalSecrets.keys.supabaseAnonKey=my-anon-key" \
  --set "externalSecrets.keys.supabaseServiceRoleKey=my-service-role-key" \
  --set "externalSecrets.keys.oauth2ProxyClientId=my-client-id")
# clientSecret and cookieSecret left empty (default) — no ExternalSecret must be emitted.
assert_not_contains "$ESO_PARTIAL_OAUTH" \
  "eso oauth2 partial keys: no ExternalSecret rendered when clientSecret/cookieSecret empty" \
  "${RELEASE}-app-oauth2-proxy-eso"

# ── Prometheus alerting rules ─────────────────────────────────────────────────
echo ""
echo "=== alerting: PrometheusRule (alerting.enabled=true) ==="
ALERTING=$(helm template "$RELEASE" "$CHART" --set alerting.enabled=true)

assert_contains "$ALERTING" "alerting: PrometheusRule resource created"       "kind: PrometheusRule"
assert_contains "$ALERTING" "alerting: component label = alerting"            "app.kubernetes.io/component: alerting"
assert_contains "$ALERTING" "alerting: temporal-worker alert group present"   "name: temporal-worker"
assert_contains "$ALERTING" "alerting: ops-api alert group present"           "name: ops-api"
assert_contains "$ALERTING" "alerting: TemporalWorkerDown rule present"       "alert: TemporalWorkerDown"
assert_contains "$ALERTING" "alerting: TemporalTaskQueueBacklogHigh present"  "alert: TemporalTaskQueueBacklogHigh"
assert_contains "$ALERTING" "alerting: TemporalWorkflowFailureRateHigh present" "alert: TemporalWorkflowFailureRateHigh"
assert_contains "$ALERTING" "alerting: TemporalScheduleMissed present"        "alert: TemporalScheduleMissed"
assert_contains "$ALERTING" "alerting: OpsApiErrorRateHigh present"           "alert: OpsApiErrorRateHigh"
assert_contains "$ALERTING" "alerting: OpsApiLatencyHigh present"             "alert: OpsApiLatencyHigh"
assert_contains "$ALERTING" "alerting: all rules have for: window"            "for:"
assert_contains "$ALERTING" "alerting: all rules reference OPERATIONS.md"     "OPERATIONS\\.md"
# AlertmanagerConfig must NOT render when webhookUrl is empty
assert_not_contains "$ALERTING" "alerting: no AlertmanagerConfig when webhookUrl unset" "kind: AlertmanagerConfig"

echo ""
echo "=== alerting: AlertmanagerConfig (with webhookUrl) ==="
ALERTING_WITH_BRIDGE=$(helm template "$RELEASE" "$CHART" \
  --set alerting.enabled=true \
  --set "alerting.alertmanagerConfig.incidentBridge.webhookUrl=https://bridge.example.com/alert")

assert_contains "$ALERTING_WITH_BRIDGE" "alerting: AlertmanagerConfig created when webhookUrl set" "kind: AlertmanagerConfig"
assert_contains "$ALERTING_WITH_BRIDGE" "alerting: receiver name = incident-bridge"               "receiver: incident-bridge"
assert_contains "$ALERTING_WITH_BRIDGE" "alerting: webhook url rendered in config"                "https://bridge\\.example\\.com/alert"
assert_contains "$ALERTING_WITH_BRIDGE" "alerting: sendResolved enabled"                          "sendResolved: true"
assert_contains "$ALERTING_WITH_BRIDGE" "alerting: groupWait configured"                          "groupWait:"
assert_contains "$ALERTING_WITH_BRIDGE" "alerting: repeatInterval configured"                     "repeatInterval:"

echo ""
echo "=== alerting: disabled by default (base profile) ==="
assert_not_contains "$BASE" "alerting: PrometheusRule absent by default"    "kind: PrometheusRule"
assert_not_contains "$BASE" "alerting: AlertmanagerConfig absent by default" "kind: AlertmanagerConfig"

echo ""
echo "=== alerting: test profile has alerting.enabled=false ==="
assert_not_contains "$TEST" "alerting: PrometheusRule absent in test profile"  "kind: PrometheusRule"

echo ""
echo "=== alerting: prod profile has alerting.enabled=true ==="
assert_contains "$PROD" "alerting: PrometheusRule in prod profile"  "kind: PrometheusRule"

echo ""
echo "=== alerting: bridge workflow exists ==="
BRIDGE_WORKFLOW=".github/workflows/alert-incident-bridge.yml"
if [ ! -f "$BRIDGE_WORKFLOW" ]; then
  fail "alerting: alert-incident-bridge.yml exists at .github/workflows/"
else
  pass "alerting: alert-incident-bridge.yml exists"
  BRIDGE_TEXT=$(cat "$BRIDGE_WORKFLOW")
  assert_contains "$BRIDGE_TEXT" "alerting: bridge triggers on repository_dispatch"  "repository_dispatch"
  assert_contains "$BRIDGE_TEXT" "alerting: bridge triggers on workflow_dispatch"     "workflow_dispatch"
  assert_contains "$BRIDGE_TEXT" "alerting: bridge has issues:write permission"       "issues: write"
  assert_contains "$BRIDGE_TEXT" "alerting: bridge runs alert-incident-bridge.ts"     "alert-incident-bridge\\.ts"
fi

# ── promotion preflight gate-confirmed guard (ADR-0062) ───────────────────────
# Both deploy-test and deploy-prod must hard-fail when K8S is enabled but the
# corresponding WYNNE_{ENV}_GATE_CONFIRMED variable is not set to 'true', so
# promotion cannot proceed on an unprotected GitHub Environment by accident.
echo ""
echo "=== promotion preflight gate-confirmed guard ==="
for ENV_NAME in test prod; do
  WORKFLOW_FILE=".github/workflows/deploy-${ENV_NAME}.yml"
  if [ ! -f "$WORKFLOW_FILE" ]; then
    fail "gate-guard: deploy-${ENV_NAME}.yml exists"
    continue
  fi
  pass "gate-guard: deploy-${ENV_NAME}.yml exists"

  # Explicit mapping — avoids fragile runtime string transforms.
  case "$ENV_NAME" in
    test) GATE_VAR="WYNNE_TEST_GATE_CONFIRMED" ;;
    prod) GATE_VAR="WYNNE_PROD_GATE_CONFIRMED" ;;
  esac

  # Extracts the '- id: gate' step block (6-space YAML indent matching the rest of
  # this file's workflow assertions). Stops at the next sibling step attribute.
  PREFLIGHT_STEP=$(awk '
    /^      - id: gate/{capturing=1; print; next}
    capturing && /^      - (id|name|uses|if):[[:space:]]/{capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")

  if [ -z "$PREFLIGHT_STEP" ]; then
    fail "gate-guard: deploy-${ENV_NAME} preflight gate step extracted"
  else
    pass "gate-guard: deploy-${ENV_NAME} preflight gate step extracted"
    # Expected: GATE_CONFIRMED: ${{ vars.WYNNE_TEST_GATE_CONFIRMED }}
    assert_contains "$PREFLIGHT_STEP" "gate-guard: deploy-${ENV_NAME} reads GATE_CONFIRMED from vars.${GATE_VAR}" \
      "GATE_CONFIRMED: \\\${{ vars\\.${GATE_VAR} }}"
    # Expected: ::error::WYNNE_TEST_GATE_CONFIRMED is not set to 'true'. ...
    assert_contains "$PREFLIGHT_STEP" "gate-guard: deploy-${ENV_NAME} hard-fails when gate not confirmed" \
      "::error::${GATE_VAR}"
    # Expected: if [[ "$GATE_CONFIRMED" != "true" ]]; then
    assert_contains "$PREFLIGHT_STEP" "gate-guard: deploy-${ENV_NAME} hard-fail is gated on GATE_CONFIRMED != true" \
      'GATE_CONFIRMED.*!=.*true'
    assert_contains "$PREFLIGHT_STEP" "gate-guard: deploy-${ENV_NAME} hard-fail references the promotion runbook" \
      'docs/runbooks/promotion\.md'
    assert_contains "$PREFLIGHT_STEP" "gate-guard: deploy-${ENV_NAME} hard-fail exits 1" \
      'exit 1'
  fi
done

# ── known-good release ledger (e2e-dev: Stamp known-good release step) ────────
echo ""
echo "=== release ledger: e2e-dev stamp step ==="
E2E_WORKFLOW=".github/workflows/e2e-dev.yml"
if [ ! -f "$E2E_WORKFLOW" ]; then
  fail "ledger: e2e-dev.yml exists"
else
  pass "ledger: e2e-dev.yml exists"
  STAMP_STEP=$(awk '
    /^      - name: Stamp known-good release/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$E2E_WORKFLOW")

  if [ -z "$STAMP_STEP" ]; then
    fail "ledger: Stamp known-good release step extracted"
  else
    pass "ledger: Stamp known-good release step extracted"
    assert_contains "$STAMP_STEP" "ledger: stamp step gated on workflow_run event" \
      "github\.event_name == 'workflow_run'"
    assert_contains "$STAMP_STEP" "ledger: stamp step gated on deploy conclusion=success" \
      "github\.event\.workflow_run\.conclusion == 'success'"
    assert_contains "$STAMP_STEP" "ledger: stamp step gated on e2e job success" \
      "needs\.e2e\.result == 'success'"
    assert_contains "$STAMP_STEP" "ledger: stamp step uses deployed SHA from workflow_run" \
      'DEPLOYED_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}'
    assert_contains "$STAMP_STEP" "ledger: stamp step records deploy run id (not build run id)" \
      'DEPLOY_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}'
    assert_contains "$STAMP_STEP" "ledger: stamp step invokes release-ledger-record.mjs" \
      "release-ledger-record\.mjs"
    assert_contains "$STAMP_STEP" "ledger: stamp step passes --deploy-run-id flag" \
      '\-\-deploy-run-id'
    assert_contains "$STAMP_STEP" "ledger: stamp step appends to known-good.jsonl" \
      "known-good\.jsonl"
    assert_contains "$STAMP_STEP" "ledger: stamp step updates latest-known-good.txt" \
      "latest-known-good\.txt"
    assert_contains "$STAMP_STEP" "ledger: stamp step pushes to releases-ledger branch" \
      'BRANCH=releases-ledger'
    assert_contains "$STAMP_STEP" "ledger: stamp step uses fetch/rebase retry loop" \
      'for attempt in 1 2 3 4 5'
    assert_contains "$STAMP_STEP" "ledger: stamp step exits 0 on successful push" \
      'exit 0'
    assert_contains "$STAMP_STEP" "ledger: stamp step exits 1 after exhausting retries" \
      'exit 1'

    # ── e2e job must grant contents: write so the push to releases-ledger succeeds ─
    E2E_JOB_PERMS=$(awk '
      /^  e2e:/{capturing=1; next}
      capturing && /^    permissions:/{perms=1; next}
      perms && /^    [a-z]/{perms=0; capturing=0}
      perms{print}
    ' "$E2E_WORKFLOW")
    assert_contains "$E2E_JOB_PERMS" "ledger: e2e job grants contents: write (required for releases-ledger push)" \
      'contents: write'
  fi
fi

# ── sha-preferred promotion path wiring (ADR-0062) ────────────────────────────
# Behavioral coverage for the new promote-by-SHA path added to deploy-test and
# deploy-prod. Asserts:
#   • sha workflow_dispatch input is declared (known-good/releases-ledger ref)
#   • ACR login + resolve steps only run when sha != '' (sha path)
#   • Download + artifact-resolve steps only run when sha == '' (legacy path)
#   • Select-digests step reads ACR outputs (preferred) and artifact outputs
#     (fallback) and wires FE/WK correctly via the ${ACR_FE:-$ART_FE} pattern
#   • environment: test/prod is present for the human gate
echo ""
echo "=== sha-preferred promotion path wiring ==="
for ENV_NAME in test prod; do
  WORKFLOW_FILE=".github/workflows/deploy-${ENV_NAME}.yml"
  if [ ! -f "$WORKFLOW_FILE" ]; then
    fail "sha-path: deploy-${ENV_NAME}.yml exists"
    continue
  fi
  pass "sha-path: deploy-${ENV_NAME}.yml exists"
  WORKFLOW_TEXT=$(cat "$WORKFLOW_FILE")

  # ── sha workflow_dispatch input ──────────────────────────────────────────────
  SHA_INPUT=$(awk '
    /^      sha:/{capturing=1; print; next}
    capturing && /^      [a-z_]+:/{capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")
  if [ -z "$SHA_INPUT" ]; then
    fail "sha-path: deploy-${ENV_NAME} sha input block extracted"
  else
    pass "sha-path: deploy-${ENV_NAME} sha input block extracted"
    assert_contains "$SHA_INPUT" "sha-path: deploy-${ENV_NAME} sha input description references known-good" \
      'KNOWN-GOOD|known-good'
    assert_contains "$SHA_INPUT" "sha-path: deploy-${ENV_NAME} sha input description references releases-ledger" \
      'releases-ledger'
  fi

  # ── Validate promotion inputs: hard-fail when neither sha nor build_run_id ──
  VALIDATE_STEP=$(awk '
    /^      - name: Validate promotion inputs/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")
  if [ -z "$VALIDATE_STEP" ]; then
    fail "sha-path: deploy-${ENV_NAME} validate-inputs step extracted"
  else
    pass "sha-path: deploy-${ENV_NAME} validate-inputs step extracted"
    assert_contains "$VALIDATE_STEP" "sha-path: deploy-${ENV_NAME} validate-inputs reads SHA from inputs.sha" \
      'SHA: \$\{\{ inputs\.sha \}\}'
    assert_contains "$VALIDATE_STEP" "sha-path: deploy-${ENV_NAME} validate-inputs reads BUILD_RUN_ID from inputs.build_run_id" \
      'BUILD_RUN_ID: \$\{\{ inputs\.build_run_id \}\}'
    assert_contains "$VALIDATE_STEP" "sha-path: deploy-${ENV_NAME} validate-inputs hard-fails when both inputs are empty" \
      '::error::provide either'
    assert_contains "$VALIDATE_STEP" "sha-path: deploy-${ENV_NAME} validate-inputs prefers sha over build_run_id when both given" \
      "using 'sha'"
  fi

  # ── Log in to ACR: only on sha path (if: inputs.sha != '') ─────────────────
  ACR_LOGIN_STEP=$(awk '
    /^      - name: Log in to ACR \(promote-by-SHA path\)/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")
  if [ -z "$ACR_LOGIN_STEP" ]; then
    fail "sha-path: deploy-${ENV_NAME} ACR login step extracted"
  else
    pass "sha-path: deploy-${ENV_NAME} ACR login step extracted"
    assert_contains "$ACR_LOGIN_STEP" "sha-path: deploy-${ENV_NAME} ACR login step only runs on sha path" \
      "if:.*inputs\.sha != ''"
    assert_contains "$ACR_LOGIN_STEP" "sha-path: deploy-${ENV_NAME} ACR login step uses ACR_LOGIN_SERVER registry" \
      'registry: \$\{\{ vars\.ACR_LOGIN_SERVER \}\}'
  fi

  # ── Resolve digests from ACR by SHA: only on sha path ──────────────────────
  ACR_RESOLVE_STEP=$(awk '
    /^      - name: Resolve digests from ACR by SHA/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")
  if [ -z "$ACR_RESOLVE_STEP" ]; then
    fail "sha-path: deploy-${ENV_NAME} ACR digest-resolve step extracted"
  else
    pass "sha-path: deploy-${ENV_NAME} ACR digest-resolve step extracted"
    assert_contains "$ACR_RESOLVE_STEP" "sha-path: deploy-${ENV_NAME} ACR resolve step only runs on sha path" \
      "if:.*inputs\.sha != ''"
    assert_contains "$ACR_RESOLVE_STEP" "sha-path: deploy-${ENV_NAME} ACR resolve step passes SHA from inputs.sha" \
      'SHA: \$\{\{ inputs\.sha \}\}'
    # shellcheck disable=SC2016
    assert_contains "$ACR_RESOLVE_STEP" "sha-path: deploy-${ENV_NAME} ACR resolve step calls resolve-image-digest.sh for frontend" \
      'resolve-image-digest\.sh frontend "\$SHA"'
    # shellcheck disable=SC2016
    assert_contains "$ACR_RESOLVE_STEP" "sha-path: deploy-${ENV_NAME} ACR resolve step calls resolve-image-digest.sh for worker" \
      'resolve-image-digest\.sh temporal-worker "\$SHA"'
    assert_contains "$ACR_RESOLVE_STEP" "sha-path: deploy-${ENV_NAME} ACR resolve step publishes frontend GITHUB_OUTPUT" \
      'frontend=.*GITHUB_OUTPUT'
    assert_contains "$ACR_RESOLVE_STEP" "sha-path: deploy-${ENV_NAME} ACR resolve step publishes worker GITHUB_OUTPUT" \
      'worker=.*GITHUB_OUTPUT'
  fi

  # ── Legacy download: only when sha == '' ───────────────────────────────────
  LEGACY_DOWNLOAD_STEP=$(awk '
    /^      - name: Download image digests from Build Images run \(legacy path\)/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")
  if [ -z "$LEGACY_DOWNLOAD_STEP" ]; then
    fail "sha-path: deploy-${ENV_NAME} legacy download step extracted"
  else
    pass "sha-path: deploy-${ENV_NAME} legacy download step extracted"
    assert_contains "$LEGACY_DOWNLOAD_STEP" "sha-path: deploy-${ENV_NAME} legacy download only runs when sha is empty" \
      "if:.*inputs\.sha == ''"
  fi

  # ── Legacy artifact-resolve: only when sha == '' ───────────────────────────
  LEGACY_ARTIFACT_STEP=$(awk '
    /^      - name: Resolve digests from artifacts \(legacy path\)/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")
  if [ -z "$LEGACY_ARTIFACT_STEP" ]; then
    fail "sha-path: deploy-${ENV_NAME} legacy artifact-resolve step extracted"
  else
    pass "sha-path: deploy-${ENV_NAME} legacy artifact-resolve step extracted"
    assert_contains "$LEGACY_ARTIFACT_STEP" "sha-path: deploy-${ENV_NAME} legacy artifact-resolve only runs when sha is empty" \
      "if:.*inputs\.sha == ''"
  fi

  # ── Select digests: ACR (sha path) preferred over artifacts (legacy path) ──
  SHA_SELECT_STEP=$(awk '
    /^      - name: Select digests \+ audit tag/{capturing=1; print; next}
    capturing && /^      - name: /{capturing=0}
    capturing{print}
  ' "$WORKFLOW_FILE")
  if [ -z "$SHA_SELECT_STEP" ]; then
    fail "sha-path: deploy-${ENV_NAME} select-digests step extracted"
  else
    pass "sha-path: deploy-${ENV_NAME} select-digests step extracted"
    assert_contains "$SHA_SELECT_STEP" "sha-path: deploy-${ENV_NAME} select step reads ACR frontend output (sha path)" \
      'ACR_FE: \$\{\{ steps\.acr\.outputs\.frontend \}\}'
    assert_contains "$SHA_SELECT_STEP" "sha-path: deploy-${ENV_NAME} select step reads ACR worker output (sha path)" \
      'ACR_WK: \$\{\{ steps\.acr\.outputs\.worker \}\}'
    assert_contains "$SHA_SELECT_STEP" "sha-path: deploy-${ENV_NAME} select step reads artifact frontend output (legacy path)" \
      'ART_FE: \$\{\{ steps\.artifact\.outputs\.frontend \}\}'
    assert_contains "$SHA_SELECT_STEP" "sha-path: deploy-${ENV_NAME} select step reads artifact worker output (legacy path)" \
      'ART_WK: \$\{\{ steps\.artifact\.outputs\.worker \}\}'
    # shellcheck disable=SC2016
    assert_contains "$SHA_SELECT_STEP" "sha-path: deploy-${ENV_NAME} select step prefers ACR digest over artifact digest" \
      'FE="\$\{ACR_FE:-\$ART_FE\}"'
    assert_contains "$SHA_SELECT_STEP" "sha-path: deploy-${ENV_NAME} select step builds audit tag with sha then build_run_id fallback" \
      'SHA_TAG:-.*SHA:-build-.*BUILD_RUN_ID'
  fi

  # ── environment declaration for human gate ──────────────────────────────────
  assert_contains "$WORKFLOW_TEXT" "sha-path: deploy-${ENV_NAME} declares github environment for human gate" \
    "environment: ${ENV_NAME}"
done

# ── release-ledger-record.mjs behavioral tests ────────────────────────────────
# Run the script directly to guard its record schema and invalid-input rejection.
# Catching regressions early: if the schema fields are renamed/removed, or the
# SHA validation regex changes, these tests fail in CI before any deployment path
# relies on the ledger.
echo ""
echo "=== release-ledger-record.mjs behavioral tests ==="
LEDGER_SCRIPT=".github/scripts/release-ledger-record.mjs"
if [ ! -f "$LEDGER_SCRIPT" ]; then
  fail "ledger-record: $LEDGER_SCRIPT exists"
else
  pass "ledger-record: $LEDGER_SCRIPT exists"

  if ! command -v node >/dev/null 2>&1; then
    fail "ledger-record: node is available (required to execute script)"
  else
    pass "ledger-record: node is available"

    # ── valid short SHA (7 hex chars) exits 0 and emits JSON ──────────────────
    # Use || to prevent set -e aborting on expected non-zero exits below.
    _rc=0; _out=$(node "$LEDGER_SCRIPT" --sha "abc1234" 2>&1) || _rc=$?
    if [ "$_rc" -eq 0 ]; then
      pass "ledger-record: valid 7-char hex SHA exits 0"
      assert_contains "$_out" "ledger-record: output includes ts field" \
        '"ts":'
      assert_contains "$_out" "ledger-record: output includes sha field" \
        '"sha":"abc1234"'
      assert_contains "$_out" "ledger-record: output includes sha_short field" \
        '"sha_short":"abc1234"'
      assert_contains "$_out" "ledger-record: output includes smoke field (defaults to passed)" \
        '"smoke":"passed"'
      assert_contains "$_out" "ledger-record: output includes e2e_run_id field" \
        '"e2e_run_id":'
      assert_contains "$_out" "ledger-record: output includes e2e_run_url field" \
        '"e2e_run_url":'
      assert_contains "$_out" "ledger-record: output includes deploy_run_id field" \
        '"deploy_run_id":'
      assert_contains "$_out" "ledger-record: output includes trigger field" \
        '"trigger":'
    else
      fail "ledger-record: valid 7-char hex SHA exits 0 (got exit $_rc; output: $_out)"
    fi

    # ── sha_short is first 12 chars of a longer SHA ───────────────────────────
    _full_sha="aabbccdd11223344aabbccdd11223344aabbccdd"
    _rc=0; _out=$(node "$LEDGER_SCRIPT" --sha "$_full_sha" 2>&1) || _rc=$?
    if [ "$_rc" -eq 0 ]; then
      pass "ledger-record: valid 40-char hex SHA exits 0"
      assert_contains "$_out" "ledger-record: sha_short is first 12 chars of full SHA" \
        '"sha_short":"aabbccdd1122"'
    else
      fail "ledger-record: valid 40-char hex SHA exits 0 (got exit $_rc)"
    fi

    # ── --deploy-run-id is stored in deploy_run_id field ─────────────────────
    _rc=0; _out=$(node "$LEDGER_SCRIPT" --sha "abc1234" --deploy-run-id "9876543" 2>&1) || _rc=$?
    if [ "$_rc" -eq 0 ]; then
      pass "ledger-record: --deploy-run-id arg exits 0"
      assert_contains "$_out" "ledger-record: --deploy-run-id value stored in deploy_run_id field" \
        '"deploy_run_id":"9876543"'
    else
      fail "ledger-record: --deploy-run-id arg exits 0 (got exit $_rc)"
    fi

    # ── invalid SHA (non-hex chars) exits non-zero ────────────────────────────
    _rc=0; _out=$(node "$LEDGER_SCRIPT" --sha "not-a-sha!" 2>&1) || _rc=$?
    if [ "$_rc" -ne 0 ]; then
      pass "ledger-record: non-hex SHA exits non-zero"
      assert_contains "$_out" "ledger-record: non-hex SHA prints descriptive error" \
        'must be a commit SHA'
    else
      fail "ledger-record: non-hex SHA should exit non-zero (got 0)"
    fi

    # ── SHA too long (> 40 chars) exits non-zero ──────────────────────────────
    _rc=0; _out=$(node "$LEDGER_SCRIPT" --sha "aabbccdd112233aabbccdd112233aabbccdd11223344" 2>&1) || _rc=$?
    if [ "$_rc" -ne 0 ]; then
      pass "ledger-record: SHA longer than 40 chars exits non-zero"
    else
      fail "ledger-record: SHA longer than 40 chars should exit non-zero (got 0)"
    fi

    # ── missing --sha arg (with GITHUB_SHA cleared) exits non-zero ───────────
    _rc=0; _out=$(GITHUB_SHA="" node "$LEDGER_SCRIPT" 2>&1) || _rc=$?
    if [ "$_rc" -ne 0 ]; then
      pass "ledger-record: missing --sha arg exits non-zero"
      assert_contains "$_out" "ledger-record: missing --sha prints descriptive error" \
        'must be a commit SHA'
    else
      fail "ledger-record: missing --sha arg should exit non-zero (got 0)"
    fi
  fi
fi

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary: ${PASS} passed, ${FAIL} failed ==="

# Optional machine-readable summary for the CI test-trend history (ci-history branch).
# Written only when CI_HISTORY_JSON points somewhere; default behavior is unchanged.
if [ -n "${CI_HISTORY_JSON:-}" ]; then
  outcome=passed
  [ "$FAIL" -ne 0 ] && outcome=failed
  printf '{"outcome":"%s","expected":%d,"unexpected":%d}\n' "$outcome" "$PASS" "$FAIL" > "$CI_HISTORY_JSON"
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
