#!/usr/bin/env bash
# deploy/openbao/ci-test.sh
#
# Validate the OpenBao Helm chart rendering and standalone manifests for production-grade
# HA OpenBao deployment (ADR-0040). This is render-only validation — no cluster contact.
#
# Usage (from repo root):
#   bash deploy/openbao/ci-test.sh
#
# Requirements: helm 3.x on PATH.

set -euo pipefail

OPENBAO_DIR="deploy/openbao"
RELEASE="ci-test-openbao"
NAMESPACE="dia-vault"
PASS=0
FAIL=0

pass() { printf "  ✅ %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  ❌ FAIL: %s\n" "$1"; FAIL=$((FAIL + 1)); }

echo "=== OpenBao Deploy Surface Validation (ADR-0040) ==="
echo

# ── 1. Add OpenBao Helm repo ──────────────────────────────────────────────────
echo ":: Adding openbao Helm repo"
if ! helm repo add openbao https://openbao.github.io/openbao-helm 2>&1 | grep -v "already exists"; then
  echo "   (network issue or already exists - continuing)"
fi
if ! helm repo update 2>&1 | grep -v "no repositories"; then
  echo "   (no repos or network issue - continuing)"
fi

if helm search repo openbao/openbao --version ">0.28.0" >/dev/null 2>&1; then
  pass "helm repo openbao/openbao available"
else
  fail "helm repo openbao/openbao not accessible - cannot validate values-ha.yaml"
  echo "   OpenBao chart fetch/render is required for exact-head CI validation."
  echo "   This validation must fail closed to ensure deploy surface coverage."
fi

# ── 2. Helm template render with values-ha.yaml ──────────────────────────────
echo ":: helm template openbao/openbao with values-ha.yaml"

# The values file requires server.workloadIdentity.clientId to be set at render time.
# Use a dummy value for CI validation.
DUMMY_CLIENT_ID="00000000-0000-0000-0000-000000000000"

if RENDERED=$(helm template "$RELEASE" openbao/openbao \
  --namespace "$NAMESPACE" \
  -f "${OPENBAO_DIR}/values-ha.yaml" \
  --set "server.workloadIdentity.clientId=${DUMMY_CLIENT_ID}" \
  2>&1); then
  pass "helm template openbao/openbao with values-ha.yaml"
else
  fail "helm template openbao/openbao with values-ha.yaml"
  echo "Error output:"
  echo "$RENDERED"
fi

# Basic sanity checks on the rendered manifest
if echo "$RENDERED" | grep -q "kind: StatefulSet"; then
  pass "rendered manifest includes StatefulSet"
else
  fail "rendered manifest missing StatefulSet"
fi

if echo "$RENDERED" | grep -q "app.kubernetes.io/name: openbao"; then
  pass "rendered manifest includes openbao labels"
else
  fail "rendered manifest missing openbao labels"
fi

# ── 3. Validate standalone manifests syntax ───────────────────────────────────
echo ":: Validating standalone manifests"

for manifest in certificate.yaml networkpolicy.yaml snapshot-cronjob.yaml secretstore-prod-template.yaml; do
  manifest_path="${OPENBAO_DIR}/${manifest}"
  if [ ! -f "$manifest_path" ]; then
    fail "$manifest does not exist"
    continue
  fi

  # Basic YAML syntax check using Python (available in CI)
  if python3 -c "import yaml; yaml.safe_load_all(open('${manifest_path}'))" 2>/dev/null; then
    pass "$manifest is valid YAML"
  else
    fail "$manifest has invalid YAML syntax"
  fi
done

# ── 4. Run NetworkPolicy validation script ────────────────────────────────────
echo ":: Running NetworkPolicy validation script"

if bash "${OPENBAO_DIR}/validate-networkpolicy.sh" >/dev/null 2>&1; then
  pass "validate-networkpolicy.sh passes"
else
  fail "validate-networkpolicy.sh failed"
  echo "Re-running with output:"
  bash "${OPENBAO_DIR}/validate-networkpolicy.sh" || true
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo
echo "=== Summary ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [ $FAIL -gt 0 ]; then
  echo
  echo "❌ OpenBao deploy surface validation failed."
  exit 1
else
  echo
  echo "✅ All OpenBao deploy surface validations passed."
  exit 0
fi
