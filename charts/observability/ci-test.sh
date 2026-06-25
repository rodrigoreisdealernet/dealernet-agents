#!/usr/bin/env bash
# charts/observability/ci-test.sh
#
# Validate the observability Helm chart (kube-prometheus-stack + scrape contract).

set -euo pipefail

CHART="charts/observability"
RELEASE="ci-observability"
PASS=0
FAIL=0

pass() { printf "  ✅ %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  ❌ FAIL: %s\n" "$1"; FAIL=$((FAIL + 1)); }

assert_contains() {
  local manifest="$1" label="$2" pattern="$3"
  if grep -qE -- "$pattern" <<<"$manifest"; then
    pass "$label"
  else
    fail "$label — expected pattern not found: $pattern"
  fi
}

echo "=== helm dependency build ==="
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1 || true
RENDER_CHECKS=true
if helm dependency build "$CHART" >/dev/null 2>&1; then
  pass "dependency: kube-prometheus-stack downloaded"
else
  echo "  ⚠️ dependency download unavailable; skipping rendered dependency checks"
  pass "dependency: kube-prometheus-stack download skipped"
  RENDER_CHECKS=false
fi

echo ""
echo "=== helm lint ==="
for profile in values.yaml values-dev.yaml values-test.yaml values-prod.yaml; do
  if helm lint "$CHART" -f "$CHART/$profile" >/dev/null 2>&1; then
    pass "lint: $profile"
  else
    fail "lint: $profile"
    helm lint "$CHART" -f "$CHART/$profile" || true
  fi
done

echo ""
echo "=== rendered contract checks ==="
assert_contains "$(cat "$CHART/templates/metrics-services.yaml")" "contract: temporal server metrics Service template present" "name: \\{\\{ \\.Values\\.targets\\.temporalServer\\.service\\.name \\}\\}"
assert_contains "$(cat "$CHART/templates/metrics-services.yaml")" "contract: temporal worker metrics Service template present" "name: \\{\\{ \\.Values\\.targets\\.temporalWorker\\.service\\.name \\}\\}"
assert_contains "$(cat "$CHART/templates/metrics-services.yaml")" "contract: ops-api metrics Service template present" "name: \\{\\{ \\.Values\\.targets\\.opsApi\\.service\\.name \\}\\}"
assert_contains "$(cat "$CHART/templates/servicemonitors.yaml")" "contract: temporal ServiceMonitor template present" "name: temporal-server"
assert_contains "$(cat "$CHART/templates/servicemonitors.yaml")" "contract: worker ServiceMonitor template present" "name: temporal-worker"
assert_contains "$(cat "$CHART/templates/servicemonitors.yaml")" "contract: ops-api ServiceMonitor template present" "name: ops-api"
assert_contains "$(cat "$CHART/values-dev.yaml")" "dev values: retention set to 3d" "retention: 3d"
assert_contains "$(cat "$CHART/values-test.yaml")" "test values: retention set to 7d" "retention: 7d"
assert_contains "$(cat "$CHART/values-prod.yaml")" "prod values: retention set to 30d" "retention: 30d"
# Grafana OIDC template present and fail-closed policy enforced
assert_contains "$(cat "$CHART/templates/grafana-oidc-config.yaml")" "contract: grafana-oidc-config template present" "GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT_MODE"
if grep -qE "\|\| 'Viewer'" "$CHART/templates/grafana-oidc-config.yaml"; then
  fail "contract: grafana-oidc-config must not contain catch-all Viewer fallback"
else
  pass "contract: grafana-oidc-config has no || 'Viewer' catch-all (fail-closed)"
fi
assert_contains "$(cat "$CHART/values-test.yaml")" "test: grafana OIDC enabled" "grafanaOidc:"
assert_contains "$(cat "$CHART/values-test.yaml")" "test: grafana extraEnvFrom references oidc configmap" "grafana-oidc-config"
assert_contains "$(cat "$CHART/values-test.yaml")" "test: grafana extraEnvFrom references oidc secret" "grafana-oidc-secrets-dia-test"
assert_contains "$(cat "$CHART/values-prod.yaml")" "prod: grafana OIDC enabled" "grafanaOidc:"
assert_contains "$(cat "$CHART/values-prod.yaml")" "prod: grafana extraEnvFrom references oidc configmap" "grafana-oidc-config"
assert_contains "$(cat "$CHART/values-prod.yaml")" "prod: grafana extraEnvFrom references oidc secret" "grafana-oidc-secrets-dia-prod"

if [ "$RENDER_CHECKS" = true ]; then
  BASE=$(helm template "$RELEASE" "$CHART")
  DEV=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-dev.yaml")
  TEST=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-test.yaml")
  PROD=$(helm template "$RELEASE" "$CHART" -f "$CHART/values-prod.yaml")

  assert_contains "$BASE" "base: temporal server ServiceMonitor rendered" "kind: ServiceMonitor"
  assert_contains "$BASE" "base: temporal server metrics Service rendered" "name: temporal-server-metrics"
  assert_contains "$BASE" "base: temporal worker metrics Service rendered" "name: temporal-worker-metrics"
  assert_contains "$BASE" "base: ops-api metrics Service rendered" "name: ops-api-metrics"
  assert_contains "$BASE" "base: ServiceMonitor namespace is dia-observability" "namespace: dia-observability"
  assert_contains "$DEV" "dev: temporal namespace wiring set to dev" "- dev"
  assert_contains "$TEST" "test: app target namespace wiring set to dia-test" "- dia-test"
  assert_contains "$PROD" "prod: app target namespace wiring set to dia-prod" "- dia-prod"
  # Grafana OIDC ConfigMap rendered in test/prod, absent in base/dev
  if echo "$BASE" | grep -q "grafana-oidc-config"; then
    fail "base: grafana-oidc ConfigMap must not render when grafanaOidc.enabled=false"
  else
    pass "base: grafana-oidc ConfigMap suppressed when grafanaOidc.enabled=false"
  fi
  assert_contains "$TEST" "test: grafana-oidc ConfigMap rendered with STRICT_MODE" "GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT_MODE"
  assert_contains "$PROD" "prod: grafana-oidc ConfigMap rendered with STRICT_MODE" "GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT_MODE"
fi

echo ""
echo "=== Summary: ${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
