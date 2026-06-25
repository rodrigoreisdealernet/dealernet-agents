#!/usr/bin/env bash
# frontend/docker/test-entrypoint.sh
#
# Unit tests for frontend/docker/entrypoint.sh.
#
# Covers:
#  - Runtime-config generation: both VITE_-prefixed and generic env var names,
#    missing-var warnings, VITE_ priority, and base64/atob encoding.
#  - Writable-path contract: the script writes exclusively to /tmp
#    (read-only-root-filesystem safe), as mounted by the Helm chart's emptyDir.
#  - Determinism: identical inputs produce identical output.
#
# No container, cluster, or nginx installation required — runs in plain bash.
# Usage (from repo root):
#   bash frontend/docker/test-entrypoint.sh

set -euo pipefail

ENTRYPOINT="$(cd "$(dirname "$0")" && pwd)/entrypoint.sh"
PASS=0
FAIL=0

pass() { printf "  ✅ %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  ❌ FAIL: %s\n" "$1"; FAIL=$((FAIL + 1)); }

assert_contains() {
  local content="$1" label="$2" pattern="$3"
  if grep -qE "$pattern" <<<"$content"; then
    pass "$label"
  else
    fail "$label — expected pattern not found: $pattern"
  fi
}

assert_not_contains() {
  local content="$1" label="$2" pattern="$3"
  if grep -qE "$pattern" <<<"$content"; then
    fail "$label — unexpected pattern found: $pattern"
  else
    pass "$label"
  fi
}

# The real entrypoint ends with `exec nginx -g 'daemon off;'`.
# A stub that exits 0 allows the full script to run in CI without nginx.
STUB_BIN=$(mktemp -d)
cat > "$STUB_BIN/nginx" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$STUB_BIN/nginx"

# Create a temporary nginx directory structure so the entrypoint's envsubst step
# can run outside Docker (no /etc/nginx/templates/ or /etc/nginx/conf.d/ on the host).
# NGINX_TEMPLATE / NGINX_CONF_OUT override the production defaults in entrypoint.sh.
NGINX_TEST_DIR=$(mktemp -d)
mkdir -p "$NGINX_TEST_DIR/conf.d"
cat > "$NGINX_TEST_DIR/default.conf.template" <<'TMPL'
server {
  listen 3000;
  location /api/ { proxy_pass ${OPS_API_URL}; }
  location / { try_files $uri $uri/ /index.html; }
}
TMPL
export NGINX_TEMPLATE="$NGINX_TEST_DIR/default.conf.template"
export NGINX_CONF_OUT="$NGINX_TEST_DIR/conf.d/default.conf"
trap 'rm -rf "$STUB_BIN" "$NGINX_TEST_DIR"' EXIT

run_entrypoint() {
  env "$@" PATH="$STUB_BIN:$PATH" bash "$ENTRYPOINT"
}

# ── test: both VITE_-prefixed vars set ───────────────────────────────────────
echo "=== both VITE_ vars set ==="
run_entrypoint \
  VITE_SUPABASE_URL="https://example.supabase.co" \
  VITE_SUPABASE_ANON_KEY="my-anon-key" \
  2>/dev/null
CONFIG=$(cat /tmp/runtime-config.js)
assert_contains     "$CONFIG" "config: global runtime-config object present"  "window\.__WYNNE_RUNTIME_CONFIG__"
assert_contains     "$CONFIG" "config: VITE_SUPABASE_URL key present"         "VITE_SUPABASE_URL:"
assert_contains     "$CONFIG" "config: URL encoded with atob()"               'atob\('
assert_contains     "$CONFIG" "config: VITE_SUPABASE_ANON_KEY key present"    "VITE_SUPABASE_ANON_KEY:"
assert_contains     "$CONFIG" "config: anon key encoded with atob()"          'atob\('
assert_not_contains "$CONFIG" "config: raw URL not embedded in output"        "https://example\.supabase\.co"
assert_not_contains "$CONFIG" "config: raw anon key not embedded in output"   "my-anon-key"

# ── test: writable-path contract (writes to /tmp, not root fs) ───────────────
echo ""
echo "=== writable-path contract ==="
run_entrypoint \
  VITE_SUPABASE_URL="https://wp-test.supabase.co" \
  VITE_SUPABASE_ANON_KEY="wp-key" \
  2>/dev/null
if [ -f /tmp/runtime-config.js ]; then
  pass "entrypoint: config written to /tmp/runtime-config.js (read-only-fs safe)"
else
  fail "entrypoint: /tmp/runtime-config.js not created"
fi
assert_contains "$(cat /tmp/runtime-config.js)" \
  "entrypoint: /tmp file contains runtime config object" \
  "window\.__WYNNE_RUNTIME_CONFIG__"

# ── test: generic non-VITE_ var names (SUPABASE_URL / SUPABASE_ANON_KEY) ─────
echo ""
echo "=== generic var names (no VITE_ prefix) ==="
run_entrypoint \
  -u VITE_SUPABASE_URL \
  -u VITE_SUPABASE_ANON_KEY \
  SUPABASE_URL="https://generic.supabase.co" \
  SUPABASE_ANON_KEY="generic-anon-key" \
  2>/dev/null
CONFIG=$(cat /tmp/runtime-config.js)
assert_contains "$CONFIG" "config: generic SUPABASE_URL mapped to VITE_SUPABASE_URL"          "VITE_SUPABASE_URL:"
assert_contains "$CONFIG" "config: generic URL value encoded with atob()"                      'atob\('
assert_contains "$CONFIG" "config: generic SUPABASE_ANON_KEY mapped to VITE_SUPABASE_ANON_KEY" "VITE_SUPABASE_ANON_KEY:"

# ── test: VITE_ prefix takes priority over generic names ─────────────────────
echo ""
echo "=== VITE_ prefix wins over generic names ==="
run_entrypoint \
  VITE_SUPABASE_URL="https://vite-url.supabase.co" \
  SUPABASE_URL="https://generic-url.supabase.co" \
  VITE_SUPABASE_ANON_KEY="vite-key" \
  SUPABASE_ANON_KEY="generic-key" \
  2>/dev/null
CONFIG=$(cat /tmp/runtime-config.js)
EXPECTED_URL_B64=$(printf '%s' "https://vite-url.supabase.co" | base64 | tr -d '\n')
EXPECTED_KEY_B64=$(printf '%s' "vite-key" | base64 | tr -d '\n')
assert_contains "$CONFIG" "config: VITE_SUPABASE_URL wins over SUPABASE_URL"          "$EXPECTED_URL_B64"
assert_contains "$CONFIG" "config: VITE_SUPABASE_ANON_KEY wins over SUPABASE_ANON_KEY" "$EXPECTED_KEY_B64"

# ── test: missing vars emit warning and write undefined placeholders ──────────
echo ""
echo "=== missing vars produce warning and undefined values ==="
WARN_OUTPUT_FILE=$(mktemp)
if ! run_entrypoint \
  -u VITE_SUPABASE_URL \
  -u VITE_SUPABASE_ANON_KEY \
  -u SUPABASE_URL \
  -u SUPABASE_ANON_KEY \
  > /dev/null 2>"$WARN_OUTPUT_FILE"; then
  true
fi
WARN_OUTPUT=$(cat "$WARN_OUTPUT_FILE")
rm -f "$WARN_OUTPUT_FILE"
CONFIG=$(cat /tmp/runtime-config.js)
assert_contains "$WARN_OUTPUT" "warn: warning emitted to stderr when vars missing"            "WARN:"
assert_contains "$CONFIG"      "config: VITE_SUPABASE_URL is undefined when var missing"      "VITE_SUPABASE_URL: undefined"
assert_contains "$CONFIG"      "config: VITE_SUPABASE_ANON_KEY is undefined when var missing" "VITE_SUPABASE_ANON_KEY: undefined"

# ── test: output is deterministic (same inputs → identical file) ──────────────
echo ""
echo "=== output is deterministic ==="
run_entrypoint \
  VITE_SUPABASE_URL="https://stable.supabase.co" \
  VITE_SUPABASE_ANON_KEY="stable-key" \
  2>/dev/null
FIRST=$(cat /tmp/runtime-config.js)
run_entrypoint \
  VITE_SUPABASE_URL="https://stable.supabase.co" \
  VITE_SUPABASE_ANON_KEY="stable-key" \
  2>/dev/null
SECOND=$(cat /tmp/runtime-config.js)
if [ "$FIRST" = "$SECOND" ]; then
  pass "entrypoint: output is deterministic for identical inputs"
else
  fail "entrypoint: output differs between identical runs"
fi

# ── test: nginx conf generated with OPS_API_URL substituted ──────────────────
echo ""
echo "=== nginx conf generation: OPS_API_URL substituted ==="
run_entrypoint \
  VITE_SUPABASE_URL="https://example.supabase.co" \
  VITE_SUPABASE_ANON_KEY="my-anon-key" \
  OPS_API_URL="http://rental-app-ops-api:8000" \
  2>/dev/null
NGINX_CONF=$(cat "$NGINX_CONF_OUT")
assert_contains     "$NGINX_CONF" "nginx: conf file created"                          "proxy_pass"
assert_contains     "$NGINX_CONF" "nginx: OPS_API_URL substituted in proxy_pass"     "http://rental-app-ops-api:8000"
assert_not_contains "$NGINX_CONF" "nginx: no literal \${OPS_API_URL} in output"      '\$\{OPS_API_URL\}'

# ── test: nginx conf fallback when OPS_API_URL unset ─────────────────────────
echo ""
echo "=== nginx conf generation: fallback when OPS_API_URL unset ==="
run_entrypoint \
  -u OPS_API_URL \
  VITE_SUPABASE_URL="https://example.supabase.co" \
  VITE_SUPABASE_ANON_KEY="my-anon-key" \
  2>/dev/null
NGINX_CONF=$(cat "$NGINX_CONF_OUT")
assert_contains     "$NGINX_CONF" "nginx: fallback proxy_pass uses 127.0.0.1:65535"  "127\.0\.0\.1:65535"
assert_not_contains "$NGINX_CONF" "nginx: no literal \${OPS_API_URL} with fallback"  '\$\{OPS_API_URL\}'

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary: ${PASS} passed, ${FAIL} failed ==="
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
