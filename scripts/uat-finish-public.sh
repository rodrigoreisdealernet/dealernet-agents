#!/usr/bin/env bash
# uat-finish-public.sh — finish making UAT (wynne-test) publicly reachable via Front Door.
#
# Run this AFTER the Azure public-IP quota has been raised (the only blocker; needs an
# MFA-authenticated session — see docs/runbooks/promotion.md / memory uat-environment-bringup).
#   az quota update --resource-name IPv4StandardSkuPublicIpAddresses \
#     --scope /subscriptions/44542832-156a-4b4e-a4fd-5a182428ca1e/providers/Microsoft.Network/locations/eastus2 \
#     --limit-object value=20 --resource-type PublicIpAddresses
#
# Everything else is already in place (2026-06-14):
#  - app running in wynne-test (frontend+ops-api); isolated Supabase in wynne-supabase-test
#  - Front Door endpoints + origin-groups pre-created on wynne-afd (rg-wynne-dev)
#  - frontend already configured with supabaseUrl=https://<wynne-api-test host>
# This script: flips frontend to LoadBalancer, flips Supabase/Kong to LoadBalancer with
# Azure Front Door backend source-range allowlisting, waits for public IPs, attaches them as
# Front Door origins, creates the routes, and verifies direct-origin bypass is blocked.
# Idempotent.
set -euo pipefail

RG=rg-wynne-dev; PROF=wynne-afd
APP_EP=wynne-app-test; API_EP=wynne-api-test
AFD_SERVICE_TAG_LOCATION=eastus2
API_HEALTH_CHECK_TIMEOUT_SECONDS=20
DIRECT_ORIGIN_BLOCK_TIMEOUT_SECONDS=8 # blocked path should fail quickly if source-range allowlist is active.
CURL_EXIT_COULDNT_CONNECT=7
CURL_EXIT_OPERATION_TIMEDOUT=28

echo "1/6 flip frontend to LoadBalancer"
kubectl -n wynne-test patch svc rental-app-frontend -p '{"spec":{"type":"LoadBalancer"}}'

echo "2/6 set Kong to LoadBalancer with Azure Front Door backend allowlist"
# Keep IPv4 CIDRs only; this cluster's LB allowlist is IPv4-only. IPv6 entries are
# intentionally excluded and logged when present.
if ! AFD_PREFIXES_TSV="$(
  az network list-service-tags --location "$AFD_SERVICE_TAG_LOCATION" \
    --query "values[?name=='AzureFrontDoor.Backend'].properties.addressPrefixes[]" -o tsv 2>&1
)"; then
  echo "ERROR: failed to fetch AzureFrontDoor.Backend service-tag prefixes: $AFD_PREFIXES_TSV" >&2
  exit 1
fi

AFD_RANGES_JSON="$(
  AFD_PREFIXES_TSV="$AFD_PREFIXES_TSV" python - <<'PY'
import ipaddress
import json
import os
import sys

valid = []
invalid = []
ipv6_filtered = 0
for raw in os.environ.get("AFD_PREFIXES_TSV", "").splitlines():
    prefix = raw.strip()
    if not prefix:
        continue
    try:
        network = ipaddress.ip_network(prefix, strict=False)
    except ValueError:
        invalid.append(prefix)
        continue
    if network.version == 4:
        valid.append(prefix)
    else:
        ipv6_filtered += 1

if invalid:
    print(f"ERROR: invalid AzureFrontDoor.Backend CIDRs: {', '.join(invalid)}", file=sys.stderr)
    sys.exit(1)
if ipv6_filtered:
    print(f"INFO: filtered {ipv6_filtered} IPv6 AzureFrontDoor.Backend CIDRs (IPv4-only allowlist)", file=sys.stderr)

print(json.dumps(valid))
PY
)"

if [ "$AFD_RANGES_JSON" = "[]" ]; then
  echo "ERROR: no IPv4 prefixes found for AzureFrontDoor.Backend service tag" >&2
  exit 1
fi

kubectl -n wynne-supabase-test patch svc supabase-supabase-kong --type merge -p \
  "{\"spec\":{\"type\":\"LoadBalancer\",\"loadBalancerSourceRanges\":$AFD_RANGES_JSON}}"

echo "3/6 wait for public IPs (fails if quota still capped: PublicIPCountLimitReached)"
wait_ip() { # ns svc
  for _ in $(seq 1 60); do
    ip=$(kubectl -n "$1" get svc "$2" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    [ -n "$ip" ] && { echo "$ip"; return 0; }
    sleep 5
  done
  echo "ERROR: $1/$2 never got an external IP — is the public-IP quota raised?" >&2; return 1
}
FE_IP=$(wait_ip wynne-test rental-app-frontend)
KONG_IP=$(wait_ip wynne-supabase-test supabase-supabase-kong)
python - "$KONG_IP" <<'PY' || {
import ipaddress
import sys
try:
    ipaddress.ip_address(sys.argv[1])
except ValueError as exc:
    print(exc, file=sys.stderr)
    sys.exit(1)
PY
  echo "ERROR: Kong load balancer IP validation failed (invalid format): $KONG_IP" >&2
  exit 1
}
echo "   frontend=$FE_IP  kong=$KONG_IP"

echo "4/6 attach Front Door origins (HTTP origin; AFD terminates TLS — mirrors dev)"
upsert_origin() { # origin_group origin_name host_ip
  if az afd origin show --profile-name "$PROF" -g "$RG" --origin-group-name "$1" --origin-name "$2" >/dev/null 2>&1; then
    az afd origin update --profile-name "$PROF" -g "$RG" --origin-group-name "$1" --origin-name "$2" \
      --host-name "$3" --origin-host-header "$3" --http-port 80 --https-port 443 \
      --priority 1 --weight 1000 --enabled-state Enabled --enforce-certificate-name-check false >/dev/null
  else
    az afd origin create --profile-name "$PROF" -g "$RG" --origin-group-name "$1" --origin-name "$2" \
      --host-name "$3" --origin-host-header "$3" --http-port 80 --https-port 443 \
      --priority 1 --weight 1000 --enabled-state Enabled --enforce-certificate-name-check false >/dev/null
  fi
}
upsert_origin app-test-og app-lb "$FE_IP"
upsert_origin api-test-og api-lb "$KONG_IP"

echo "5/6 create routes (/* , forward HttpOnly, https-redirect)"
az afd route create --profile-name $PROF -g $RG --endpoint-name $APP_EP --route-name app-route \
  --origin-group app-test-og --supported-protocols Http Https --patterns-to-match "/*" \
  --forwarding-protocol HttpOnly --https-redirect Enabled --link-to-default-domain Enabled >/dev/null 2>&1 || \
  echo "   (app-route may already exist — ok)"
az afd route create --profile-name $PROF -g $RG --endpoint-name $API_EP --route-name api-route \
  --origin-group api-test-og --supported-protocols Http Https --patterns-to-match "/*" \
  --forwarding-protocol HttpOnly --https-redirect Enabled --link-to-default-domain Enabled >/dev/null 2>&1 || \
  echo "   (api-route may already exist — ok)"

APP_HOST=$(az afd endpoint show --profile-name $PROF -g $RG --endpoint-name $APP_EP --query hostName -o tsv)
API_HOST=$(az afd endpoint show --profile-name $PROF -g $RG --endpoint-name $API_EP --query hostName -o tsv)

echo "6/6 verify (Front Door propagation can take a few minutes)"
echo "   app:  https://$APP_HOST"
echo "   api:  https://$API_HOST"
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$APP_HOST/" || true)
  echo "   GET app -> HTTP $code"; [ "$code" = "200" ] && break; sleep 15
done
api_code=$(curl -sS --max-time "$API_HEALTH_CHECK_TIMEOUT_SECONDS" -o /dev/null -w '%{http_code}' "https://$API_HOST/auth/v1/health" || true)
echo "   GET api (Front Door) -> HTTP $api_code"
[ "$api_code" = "200" ] || { echo "ERROR: Front Door API health check failed"; exit 1; }

set +e
# Intentional HTTP check against the origin LB IP (origin traffic is HTTP; TLS terminates at AFD).
direct_code=$(curl -sS --max-time "$DIRECT_ORIGIN_BLOCK_TIMEOUT_SECONDS" -o /dev/null -w '%{http_code}' "http://$KONG_IP/auth/v1/health")
direct_rc=$?
set -e
if [ "$direct_rc" -eq 0 ]; then
  echo "ERROR: SECURITY BLOCKER: direct-origin bypass is still reachable (HTTP $direct_code)." >&2
  echo "Verify loadBalancerSourceRanges on supabase-supabase-kong and AzureFrontDoor.Backend coverage immediately." >&2
  exit 1
fi
case "$direct_rc" in
  "$CURL_EXIT_COULDNT_CONNECT"|"$CURL_EXIT_OPERATION_TIMEDOUT") ;;
  # expected: connection refused/unreachable (7) or timeout (28) when allowlist blocks direct-origin traffic
  *)
    echo "ERROR: direct-origin verification failed with unexpected curl exit: $direct_rc"
    exit 1
    ;;
esac
echo "   GET api (direct origin) -> blocked as expected (curl exit $direct_rc)"

echo "DONE. UAT app: https://$APP_HOST   (supabase via https://$API_HOST; direct-origin blocked)"
