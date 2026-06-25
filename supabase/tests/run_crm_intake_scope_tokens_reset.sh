#!/usr/bin/env bash
# Validates the 20260610010200_crm_intake_scope_tokens.sql migration via a full
# supabase db reset, then verifies the portal_intake_scope_tokens table and
# associated RPC functions were created cleanly.
#
# Usage (from repo root):
#   bash supabase/tests/run_crm_intake_scope_tokens_reset.sh
#
# Requirements:
#   - Supabase CLI installed (https://supabase.com/docs/guides/cli)
#   - Docker running (Supabase local stack uses Docker)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/supabase/tests/reset_validation_lib.sh"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required for reset validation" >&2
  exit 127
fi

setup_supabase_reset_validation "$repo_root"

cleanup() {
  cleanup_supabase_reset_validation
}

trap cleanup EXIT

run_supabase_start_with_transient_retry 6
run_supabase_reset_with_transient_retry 6

echo "Verifying CRM intake scope token schema after reset"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  <<'SQL'
do $$
begin
  -- Table must exist
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name   = 'portal_intake_scope_tokens'
  ) then
    raise exception 'portal_intake_scope_tokens table is missing after reset';
  end if;

  -- portal_issue_intake_token function must be present
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'portal_issue_intake_token'
  ) then
    raise exception 'portal_issue_intake_token function is missing after reset';
  end if;

  -- portal_submit_intake function must be present
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'portal_submit_intake'
  ) then
    raise exception 'portal_submit_intake function is missing after reset';
  end if;

  -- customer_intake_submitted fact type must be seeded
  if not exists (
    select 1 from public.fact_types
    where key = 'customer_intake_submitted'
  ) then
    raise exception 'customer_intake_submitted fact type is missing after reset';
  end if;

  raise notice 'CRM intake scope token schema verified OK';
end;
$$;
SQL

echo "CRM intake scope token reset checks passed"
