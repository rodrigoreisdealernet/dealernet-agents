#!/usr/bin/env bash
# Validation script for OpenBao NetworkPolicy + snapshot DR traffic path (ADR-0040).
# Verifies that:
#   1. NetworkPolicy YAML is valid Kubernetes syntax
#   2. Snapshot CronJob pod has required labels
#   3. NetworkPolicy explicitly allows snapshot pod -> OpenBao:8200 traffic
#
# Usage: bash deploy/openbao/validate-networkpolicy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXIT_CODE=0

echo "=== OpenBao NetworkPolicy + Snapshot DR Validation ==="
echo

# 1. Validate NetworkPolicy YAML syntax with kubeval or kubectl (skip if no cluster available)
echo "[1/3] Validating NetworkPolicy YAML syntax..."
if command -v kubeval &> /dev/null; then
    if kubeval --strict "${SCRIPT_DIR}/networkpolicy.yaml" &> /dev/null; then
        echo "✅ PASS: networkpolicy.yaml is valid (kubeval)"
    else
        echo "❌ FAIL: networkpolicy.yaml is not valid Kubernetes YAML"
        EXIT_CODE=1
    fi
elif kubectl --dry-run=client --validate=false -f "${SCRIPT_DIR}/networkpolicy.yaml" apply &> /dev/null; then
    echo "✅ PASS: networkpolicy.yaml is valid (kubectl --validate=false)"
else
    # Basic YAML syntax check if neither tool is available
    if python3 -c "import yaml; yaml.safe_load_all(open('${SCRIPT_DIR}/networkpolicy.yaml'))" 2> /dev/null; then
        echo "✅ PASS: networkpolicy.yaml is valid YAML syntax"
    else
        echo "❌ FAIL: networkpolicy.yaml has invalid YAML syntax"
        EXIT_CODE=1
    fi
fi
echo

# 2. Verify snapshot CronJob has required labels
echo "[2/3] Verifying snapshot CronJob pod template has required labels..."
REQUIRED_LABELS=("app.kubernetes.io/name: openbao-snapshot" "app.kubernetes.io/component: backup")
MISSING_LABELS=()

for label in "${REQUIRED_LABELS[@]}"; do
    if ! grep -q "${label}" "${SCRIPT_DIR}/snapshot-cronjob.yaml"; then
        MISSING_LABELS+=("${label}")
    fi
done

if [[ ${#MISSING_LABELS[@]} -gt 0 ]]; then
    echo "❌ FAIL: snapshot-cronjob.yaml pod template missing required labels:"
    printf '  - %s\n' "${MISSING_LABELS[@]}"
    EXIT_CODE=1
else
    echo "✅ PASS: snapshot-cronjob.yaml has required labels"
fi
echo

# 3. Verify NetworkPolicy allows snapshot pod traffic
echo "[3/3] Verifying NetworkPolicy allows snapshot pod -> OpenBao:8200 traffic..."
if ! grep -A 10 "app.kubernetes.io/name: openbao-snapshot" "${SCRIPT_DIR}/networkpolicy.yaml" | grep -q "port: 8200"; then
    echo "❌ FAIL: networkpolicy.yaml does not allow traffic from openbao-snapshot pods to port 8200"
    EXIT_CODE=1
else
    echo "✅ PASS: NetworkPolicy explicitly allows snapshot pod traffic to port 8200"
fi
echo

# Summary
if [[ ${EXIT_CODE} -eq 0 ]]; then
    echo "=== ✅ All validations passed ==="
    echo "NetworkPolicy allows the snapshot DR traffic path."
else
    echo "=== ❌ Validation failed ==="
    echo "Fix the issues above before applying these manifests."
fi

exit ${EXIT_CODE}
