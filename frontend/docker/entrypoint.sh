#!/bin/sh
set -eu

# Base64 is used only to safely serialize arbitrary env values into JS source.
# Strip wrapped newlines for BusyBox/GNU base64 compatibility.
base64_encode() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

# Support both Vite-prefixed names and generic runtime names for compatibility.
SUPABASE_URL_VALUE="${VITE_SUPABASE_URL:-${SUPABASE_URL:-}}"
SUPABASE_ANON_KEY_VALUE="${VITE_SUPABASE_ANON_KEY:-${SUPABASE_ANON_KEY:-}}"
# Base64 here is only for safe JS-string transport in the generated file.
if [ -n "$SUPABASE_URL_VALUE" ]; then
  SUPABASE_URL_EXPR="atob(\"$(base64_encode "$SUPABASE_URL_VALUE")\")"
else
  SUPABASE_URL_EXPR="undefined"
fi

if [ -n "$SUPABASE_ANON_KEY_VALUE" ]; then
  SUPABASE_ANON_KEY_EXPR="atob(\"$(base64_encode "$SUPABASE_ANON_KEY_VALUE")\")"
else
  SUPABASE_ANON_KEY_EXPR="undefined"
fi

if [ -z "$SUPABASE_URL_VALUE" ] || [ -z "$SUPABASE_ANON_KEY_VALUE" ]; then
  MISSING_ENV_NAMES=""
  if [ -z "$SUPABASE_URL_VALUE" ]; then
    MISSING_ENV_NAMES="VITE_SUPABASE_URL"
  fi
  if [ -z "$SUPABASE_ANON_KEY_VALUE" ]; then
    if [ -n "$MISSING_ENV_NAMES" ]; then
      MISSING_ENV_NAMES="$MISSING_ENV_NAMES, "
    fi
    MISSING_ENV_NAMES="${MISSING_ENV_NAMES}VITE_SUPABASE_ANON_KEY"
  fi
  echo "WARN: missing Supabase runtime env: ${MISSING_ENV_NAMES}; browser config may fall back to build-time or local defaults." >&2
fi

cat <<EOF > /tmp/runtime-config.js
window.__DIA_RUNTIME_CONFIG__ = {
  VITE_SUPABASE_URL: $SUPABASE_URL_EXPR,
  VITE_SUPABASE_ANON_KEY: $SUPABASE_ANON_KEY_EXPR,
};
EOF

# Build the nginx config from the template, substituting only OPS_API_URL so that
# nginx's own $-variables (e.g. $host, $remote_addr) are preserved verbatim.
# NGINX_TEMPLATE / NGINX_CONF_OUT may be overridden in tests running outside Docker.
NGINX_TEMPLATE="${NGINX_TEMPLATE:-/etc/nginx/templates/default.conf.template}"
NGINX_CONF_OUT="${NGINX_CONF_OUT:-/etc/nginx/conf.d/default.conf}"
OPS_API_URL="${OPS_API_URL:-}"
if [ -z "$OPS_API_URL" ]; then
  echo "WARN: OPS_API_URL not set; /api/* proxy will return 502 (connection refused)." >&2
  # Use a local port that is guaranteed to refuse connections rather than relying on DNS.
  OPS_API_URL="http://127.0.0.1:65535"
fi
export OPS_API_URL
envsubst "\${OPS_API_URL}" < "$NGINX_TEMPLATE" > "$NGINX_CONF_OUT"

exec nginx -g 'daemon off;'
