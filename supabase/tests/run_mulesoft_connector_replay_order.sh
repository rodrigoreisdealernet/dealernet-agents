#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-wynne_lvl3_mulesoft_replay_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
target_migration="20260611160000_mulesoft_connector_tables.sql"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

docker run -d \
  --name "$container_name" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  "$postgres_image" >/dev/null

container_ready=false
for _ in $(seq 1 30); do
  if docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    container_ready=true
    break
  fi
  sleep 1
done

if [ "${container_ready:-false}" != "true" ]; then
  echo "Postgres test container did not become ready" >&2
  exit 1
fi

docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$repo_root"/supabase/tests/auth_stub.sql >/dev/null

for migration in "$repo_root"/supabase/migrations/*.sql; do
  base="$(basename "$migration")"

  if [[ "$base" == "$target_migration" ]]; then
    echo "Seeding legacy shared-connector rows before $base"
    docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
insert into public.tenants (id, tenant_key, name)
values ('a1111111-1111-1111-1111-111111111111'::uuid, 'mulesoft-test-a', 'MuleSoft Test A');

insert into public.integration_config (
  id,
  tenant_id,
  provider,
  display_name,
  enabled,
  auth_type,
  connection_config,
  secret_refs,
  feature_config,
  sync_schedule
) values (
  '10000000-0000-0000-0000-000000000001'::uuid,
  'a1111111-1111-1111-1111-111111111111'::uuid,
  'mulesoft',
  'Legacy MuleSoft',
  true,
  'none',
  '{"base_url":"https://legacy.example.test"}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  null
);

insert into public.integration_sync_state (
  integration_id,
  tenant_id,
  scope_key,
  cursor_value,
  source_of_truth,
  metadata
) values
  (
    '10000000-0000-0000-0000-000000000001'::uuid,
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'legacy-outbound',
    'cursor-out',
    'wynne',
    '{"legacy":"outbound"}'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000001'::uuid,
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'legacy-inbound',
    'cursor-in',
    'provider',
    '{"legacy":"inbound"}'::jsonb
  );
SQL
  fi

  echo "Applying $base"
  if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration" >/dev/null; then
    echo "Failed applying migration: $base" >&2
    exit 1
  fi
done

echo "Running MuleSoft replay-order compatibility checks"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$repo_root"/supabase/tests/mulesoft_connector_replay_order.sql >/dev/null; then
  echo "MuleSoft replay-order SQL checks failed" >&2
  exit 1
fi

echo "MuleSoft connector replay-order checks passed"
