-- RLS / security-invoker and grant behavioral tests for ops_audit_trail_view
-- and ops_findings_view (migrations 20260614000000_ops_audit_trail_view_row_id.sql
-- and 20260617010000_ops_audit_trail_view_grants.sql).
--
-- These assertions would fail if:
--   * security_invoker is not set on the view (owner would bypass base-table RLS)
--   * row_id column is missing from ops_audit_trail_view
--   * the view returns more rows than time_series_points allows for the caller role
--   * row_id is null for any row returned through the view
--   * the SELECT grants from 20260617010000 are not applied to authenticated
--   * ops_findings_view exposes a tenant's findings to a different tenant's caller
--
-- Pattern: all assertions run inside one transaction that is rolled back, so no
-- fixture data persists.  SET LOCAL ROLE + set_config('request.jwt.claims', ...)
-- simulate the PostgREST JWT contexts used in production.

begin;

-- ── Fixture setup (superuser context) ─────────────────────────────────────
do $$
declare
  v_entity_id  uuid := '00000000-0000-0000-0001-000000000001';
  v_ft_id      uuid;
begin
  insert into public.entities (id, entity_type, source_record_id)
  values (v_entity_id, 'finding', 'audit-rls-test-finding')
  on conflict (entity_type, source_record_id) do nothing;

  -- Reuse an existing fact type if present; otherwise create one.
  select id into v_ft_id
  from public.fact_types
  where key = 'audit_event'
  limit 1;

  if v_ft_id is null then
    insert into public.fact_types (key, label)
    values ('audit_event', 'Audit Event')
    returning id into v_ft_id;
  end if;

  insert into public.time_series_points
    (entity_id, fact_type_id, observed_at, data_payload)
  values (
    v_entity_id,
    v_ft_id,
    now(),
    '{"rationale":"RLS test entry"}'::jsonb
  )
  on conflict do nothing;
end;
$$;

-- ── 1. View declares security_invoker = true ───────────────────────────────
do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'ops_audit_trail_view';

  if not v_has_invoker then
    raise exception
      'FAIL 1: ops_audit_trail_view must declare security_invoker = true '
      '(without it the view owner bypasses base-table RLS)';
  end if;

  raise notice 'PASS 1: security_invoker = true on ops_audit_trail_view';
end;
$$;

-- ── 2. row_id column is exposed by the view ────────────────────────────────
do $$
declare
  v_col_count int;
begin
  select count(*)
    into v_col_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'ops_audit_trail_view'
    and column_name  = 'row_id';

  if v_col_count <> 1 then
    raise exception
      'FAIL 2: ops_audit_trail_view must expose a row_id column (found %)', v_col_count;
  end if;

  raise notice 'PASS 2: row_id column present in ops_audit_trail_view';
end;
$$;

-- ── 3. Superuser sees the inserted row and row_id is non-null ─────────────
do $$
declare
  v_row_count int;
  v_null_ids  int;
begin
  select count(*)
    into v_row_count
  from public.ops_audit_trail_view
  where data_payload ->> 'rationale' = 'RLS test entry';

  if v_row_count = 0 then
    raise exception 'FAIL 3: superuser should see the test row through ops_audit_trail_view';
  end if;

  select count(*)
    into v_null_ids
  from public.ops_audit_trail_view
  where row_id is null;

  if v_null_ids > 0 then
    raise exception 'FAIL 3: row_id must be non-null for every row in ops_audit_trail_view';
  end if;

  raise notice 'PASS 3: superuser sees % row(s) with non-null row_id', v_row_count;
end;
$$;

-- ── 4. Verify grants from migration 20260617010000 are already in place ────
-- The grants are applied by the migration; they must not require an in-transaction
-- GRANT to exist.  If either check fails the migration has not been applied.
do $$
begin
  if not has_table_privilege('authenticated', 'public.ops_audit_trail_view', 'SELECT') then
    raise exception
      'FAIL 4: authenticated lacks SELECT on ops_audit_trail_view; '
      'check migration 20260617010000_ops_audit_trail_view_grants.sql';
  end if;

  if not has_table_privilege('authenticated', 'public.ops_findings_view', 'SELECT') then
    raise exception
      'FAIL 4: authenticated lacks SELECT on ops_findings_view; '
      'check migration 20260617010000_ops_audit_trail_view_grants.sql';
  end if;

  raise notice 'PASS 4: authenticated has SELECT on ops_audit_trail_view and ops_findings_view';
end;
$$;

-- ── 5. authenticated role sees rows consistent with the underlying policy ──
-- time_series_points has an authenticated_read policy (FOR SELECT TO authenticated
-- USING (true)), so authenticated can see all rows directly.  With
-- security_invoker = true the view executes in the caller's context, so the
-- same policy is applied and the view must not return MORE rows than the table
-- allows.  row_id must be non-null for every returned row.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"ops-rls-test"}}',
  true
);

do $$
declare
  v_tsp_count  int;
  v_view_count int;
  v_null_ids   int;
begin
  select count(*) into v_tsp_count  from public.time_series_points;
  select count(*) into v_view_count from public.ops_audit_trail_view;

  -- The view joins time_series_points → entities → fact_types; only rows with
  -- matching entity and fact_type records appear, so view_count ≤ tsp_count.
  if v_view_count > v_tsp_count then
    raise exception
      'FAIL 5: ops_audit_trail_view returned more rows (%) than the underlying '
      'time_series_points table (%); security_invoker may be broken',
      v_view_count, v_tsp_count;
  end if;

  -- The fixture row inserted above must be visible to authenticated because the
  -- authenticated_read policy on time_series_points uses USING (true).
  if not exists (
    select 1 from public.ops_audit_trail_view
    where data_payload ->> 'rationale' = 'RLS test entry'
  ) then
    raise exception
      'FAIL 5: authenticated should see the test row through ops_audit_trail_view '
      '(authenticated_read policy on time_series_points allows it)';
  end if;

  -- Every row the view exposes to authenticated must carry a non-null row_id.
  select count(*)
    into v_null_ids
  from public.ops_audit_trail_view
  where row_id is null;

  if v_null_ids > 0 then
    raise exception
      'FAIL 5: % row(s) have a null row_id through ops_audit_trail_view; '
      'row_id must be non-null for every accessible row', v_null_ids;
  end if;

  raise notice 'PASS 5: authenticated sees % row(s) through ops_audit_trail_view with non-null row_id (consistent with authenticated_read policy)', v_view_count;
end;
$$;

-- ── Reset role before ops_findings_view tenant tests ──────────────────────
reset role;

-- ── ops_findings_view tenant-isolation behavioral tests ───────────────────
-- Fixture: two tenants, each with one finding.
-- Tenant-alpha findings must be invisible to tenant-beta callers and vice versa.
do $$
declare
  v_tenant_alpha uuid;
  v_tenant_beta  uuid;
begin
  insert into public.tenants (tenant_key, name)
  values ('audit-test-alpha', 'Audit Test Alpha')
  on conflict (tenant_key) do update set name = excluded.name
  returning id into v_tenant_alpha;

  insert into public.tenants (tenant_key, name)
  values ('audit-test-beta', 'Audit Test Beta')
  on conflict (tenant_key) do update set name = excluded.name
  returning id into v_tenant_beta;

  insert into public.finding (
    tenant_id, agent_key, finding_type, severity, fingerprint, rationale
  ) values (
    v_tenant_alpha,
    'audit-rls-agent',
    'billing_mismatch',
    'high',
    'audit-view-rls-alpha',
    'Tenant-alpha RLS test finding'
  )
  on conflict (tenant_id, fingerprint) do update
    set rationale = excluded.rationale;

  insert into public.finding (
    tenant_id, agent_key, finding_type, severity, fingerprint, rationale
  ) values (
    v_tenant_beta,
    'audit-rls-agent',
    'billing_mismatch',
    'high',
    'audit-view-rls-beta',
    'Tenant-beta RLS test finding'
  )
  on conflict (tenant_id, fingerprint) do update
    set rationale = excluded.rationale;

  raise notice 'SETUP ops_findings_view: inserted findings for tenants alpha and beta';
end;
$$;

-- ── 6. Tenant-alpha authenticated sees only its own finding ───────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"audit-test-alpha"}}',
  true
);

do $$
declare
  v_tenant_alpha  uuid;
  v_alpha_count   int;
  v_cross_tenant  int;
begin
  select id into v_tenant_alpha from public.tenants where tenant_key = 'audit-test-alpha';

  select count(*)
    into v_alpha_count
  from public.ops_findings_view
  where rationale = 'Tenant-alpha RLS test finding';

  if v_alpha_count = 0 then
    raise exception
      'FAIL 6: tenant-alpha authenticated should see its own finding through ops_findings_view';
  end if;

  select count(*)
    into v_cross_tenant
  from public.ops_findings_view
  where tenant_id <> v_tenant_alpha;

  if v_cross_tenant > 0 then
    raise exception
      'FAIL 6: tenant-alpha authenticated sees % cross-tenant row(s) through ops_findings_view; '
      'RLS or security_invoker may be broken', v_cross_tenant;
  end if;

  raise notice 'PASS 6: tenant-alpha sees 1 own finding and 0 cross-tenant rows through ops_findings_view';
end;
$$;

-- ── 7. Tenant-beta authenticated cannot see tenant-alpha findings ─────────
select set_config(
  'request.jwt.claims',
  '{"app_metadata":{"role":"admin","tenant":"audit-test-beta"}}',
  true
);

do $$
declare
  v_alpha_visible int;
begin
  select count(*)
    into v_alpha_visible
  from public.ops_findings_view
  where rationale = 'Tenant-alpha RLS test finding';

  if v_alpha_visible > 0 then
    raise exception
      'FAIL 7: tenant-beta authenticated sees % tenant-alpha row(s) through ops_findings_view; '
      'tenant isolation is broken', v_alpha_visible;
  end if;

  raise notice 'PASS 7: tenant-beta sees 0 tenant-alpha findings through ops_findings_view';
end;
$$;

-- ── Reset and final integrity check ───────────────────────────────────────
reset role;

do $$
declare
  v_row_count int;
begin
  select count(*)
    into v_row_count
  from public.ops_audit_trail_view
  where data_payload ->> 'rationale' = 'RLS test entry';

  if v_row_count = 0 then
    raise exception 'FAIL post-reset: superuser should still see the test row after role reset';
  end if;

  raise notice 'PASS post-reset: superuser sees % row(s) after role reset', v_row_count;
end;
$$;

rollback;

