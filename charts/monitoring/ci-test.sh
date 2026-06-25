#!/usr/bin/env bash
# charts/monitoring/ci-test.sh
#
# Validate the monitoring Helm chart — helm lint + helm template checks for
# datasource provisioning, dashboard ConfigMaps, and label integrity.
#
# Usage (from repo root):
#   bash charts/monitoring/ci-test.sh
#
# Requirements: helm 3.x on PATH.

set -euo pipefail

CHART="charts/monitoring"
RELEASE="ci-test"
PASS=0
FAIL=0

pass() { printf "  ✅ %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  ❌ FAIL: %s\n" "$1"; FAIL=$((FAIL + 1)); }

# Write rendered manifest to a temp file to avoid bash argument-length
# limits and special-character expansion issues with large JSON payloads.
_RENDERED_TMP=""

set_rendered() {
  if [ -n "$_RENDERED_TMP" ]; then rm -f "$_RENDERED_TMP"; fi
  _RENDERED_TMP=$(mktemp)
  printf '%s' "$1" > "$_RENDERED_TMP"
}

assert_contains() {
  local label="$1" pattern="$2"
  if grep -qE "$pattern" "$_RENDERED_TMP"; then
    pass "$label"
  else
    fail "$label (pattern not found: $pattern)"
  fi
}

trap 'if [ -n "$_RENDERED_TMP" ]; then rm -f "$_RENDERED_TMP"; fi' EXIT

# ── helm lint ─────────────────────────────────────────────────────────────────
echo ""
echo "=== helm lint ==="
if helm lint "$CHART" --strict 2>&1 | grep -v "^\[INFO\]" | grep -qE "^\["; then
  fail "helm lint --strict: unexpected warnings/errors"
else
  pass "helm lint --strict: clean"
fi

# ── base chart (default values) ───────────────────────────────────────────────
echo ""
echo "=== base chart (default values) ==="
set_rendered "$(helm template "$RELEASE" "$CHART")"

assert_contains "base: datasource ConfigMap present"               "kind: ConfigMap"
assert_contains "base: datasource ConfigMap has datasource label"  'grafana_datasource: "1"'
assert_contains "base: dashboard label present"                    'grafana_dashboard: "1"'
assert_contains "base: Prometheus datasource URL configured"       "http://prometheus-operated:9090"
assert_contains "base: datasource uid=prometheus"                  "uid: prometheus"
assert_contains "base: datasource type=prometheus"                 "type: prometheus"
assert_contains "base: datasource isDefault=true"                  "isDefault: true"

# Temporal server dashboard
assert_contains "base: temporal-server dashboard ConfigMap present"   "temporal-server.json"
assert_contains "base: temporal-server dashboard title"               '"title": "Temporal Server"'
assert_contains "base: temporal-server dashboard uid"                 '"uid": "temporal-server"'
assert_contains "base: temporal-server grafana_dashboard label"       "wynne/dashboard-folder: temporal"

# Temporal SDK dashboard
assert_contains "base: temporal-sdk dashboard ConfigMap present"      "temporal-sdk.json"
assert_contains "base: temporal-sdk dashboard title"                  "Temporal SDK / Worker"
assert_contains "base: temporal-sdk dashboard uid"                    '"uid": "temporal-sdk"'
assert_contains "base: temporal-sdk grafana_dashboard label"          "wynne/dashboard-folder: temporal"

# Wynne ops dashboard
assert_contains "base: wynne-ops dashboard ConfigMap present"         "wynne-ops.json"
assert_contains "base: wynne-ops dashboard title"                     '"title": "Wynne Ops"'
assert_contains "base: wynne-ops dashboard uid"                       '"uid": "wynne-ops"'
assert_contains "base: wynne-ops grafana_dashboard label"             "wynne/dashboard-folder: ops"

# System dashboard
assert_contains "base: system dashboard ConfigMap present"            "system.json"
assert_contains "base: system dashboard title"                        "System.*Pods.*Nodes"
assert_contains "base: system dashboard uid"                          '"uid": "system-pods-nodes"'
assert_contains "base: system grafana_dashboard label"                "wynne/dashboard-folder: system"

# Dashboard content spot checks
assert_contains "base: workflow throughput panel"                  "Workflow Throughput"
assert_contains "base: task-queue backlog panel"                   "Task-Queue Backlog"
assert_contains "base: activity failure rate panel"                "Activity Failure Rate"
assert_contains "base: schedule health panel"                      "Schedule"
assert_contains "base: ops-api latency panel"                      "Ops API"
assert_contains "base: pod cpu panel"                              "Pod CPU"
assert_contains "base: pod memory panel"                           "Pod Memory"
assert_contains "base: pod restarts panel"                         "Restarts"
assert_contains "base: node pressure panel"                        "Node Pressure"

# ── values-dev.yaml ───────────────────────────────────────────────────────────
echo ""
echo "=== dev profile (values-dev.yaml) ==="
set_rendered "$(helm template "$RELEASE" "$CHART" -f "$CHART/values-dev.yaml")"

assert_contains "dev: chart renders cleanly"                       "kind: ConfigMap"
assert_contains "dev: prometheus URL unchanged"                    "http://prometheus-operated:9090"

# ── values-test.yaml ──────────────────────────────────────────────────────────
echo ""
echo "=== test profile (values-test.yaml) ==="
set_rendered "$(helm template "$RELEASE" "$CHART" -f "$CHART/values-test.yaml")"

assert_contains "test: chart renders cleanly"                      "kind: ConfigMap"
assert_contains "test: grafana_dashboard label present"            'grafana_dashboard: "1"'

# ── values-prod.yaml ──────────────────────────────────────────────────────────
echo ""
echo "=== prod profile (values-prod.yaml) ==="
set_rendered "$(helm template "$RELEASE" "$CHART" -f "$CHART/values-prod.yaml")"

assert_contains "prod: chart renders cleanly"                      "kind: ConfigMap"
assert_contains "prod: all four dashboards present"                'grafana_dashboard: "1"'

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== Summary: $PASS passed, $FAIL failed ==="
  exit 0
else
  echo "=== Summary: $PASS passed, $FAIL failed ==="
  exit 1
fi
