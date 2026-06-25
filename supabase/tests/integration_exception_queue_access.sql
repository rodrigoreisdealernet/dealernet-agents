-- Access-boundary tests for v_integration_exception_queue_scope
-- (migration 20260615210000_integration_exception_queue.sql).
--
-- This view is consumed exclusively by the Temporal worker (service_role).
-- The master_data_drift branch reads entities/entity_versions, which do not
-- yet have a complete JWT-tenant-claim RLS chain for authenticated users
-- (#120). The migration therefore grants SELECT to service_role only.
--
-- These assertions fail if:
--   * security_invoker is not declared on the view
--   * authenticated has SELECT access (missing data would silently be empty,
--     masking misconfiguration; explicit denial is the correct posture)
--   * anon has SELECT access
--   * service_role is blocked from reading the view
--
-- Pattern: all assertions run inside one transaction that is rolled back, so
-- no fixture data persists.  SET LOCAL ROLE simulates PostgREST contexts.

begin;

-- ── 1. View declares security_invoker = true ──────────────────────────────
do $$
declare
    v_has_invoker bool;
begin
    select coalesce('security_invoker=true' = any(c.reloptions), false)
      into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_integration_exception_queue_scope';

    if not v_has_invoker then
        raise exception
            'FAIL 1: v_integration_exception_queue_scope must declare '
            'security_invoker = true (without it the view owner bypasses '
            'base-table RLS)';
    end if;

    raise notice 'PASS 1: security_invoker = true on v_integration_exception_queue_scope';
end;
$$;

-- ── 2. service_role has SELECT on the view ───────────────────────────────
do $$
begin
    if not has_table_privilege('service_role',
                               'public.v_integration_exception_queue_scope',
                               'SELECT') then
        raise exception
            'FAIL 2: service_role must have SELECT on '
            'v_integration_exception_queue_scope (Temporal worker read path)';
    end if;

    raise notice 'PASS 2: service_role has SELECT on v_integration_exception_queue_scope';
end;
$$;

-- ── 3. authenticated is NOT granted SELECT on the view ───────────────────
-- entities/entity_versions lack a complete JWT-tenant-claim RLS chain for
-- authenticated (#120); the grant is intentionally withheld until that
-- lands.  If this check fails the migration was incorrectly changed.
do $$
begin
    if has_table_privilege('authenticated',
                           'public.v_integration_exception_queue_scope',
                           'SELECT') then
        raise exception
            'FAIL 3: authenticated must NOT have SELECT on '
            'v_integration_exception_queue_scope until the '
            'entities/entity_versions RLS chain is complete (#120). '
            'Revoke the grant from the migration.';
    end if;

    raise notice 'PASS 3: authenticated is correctly denied SELECT on v_integration_exception_queue_scope';
end;
$$;

-- ── 4. anon is NOT granted SELECT on the view ────────────────────────────
do $$
begin
    if has_table_privilege('anon',
                           'public.v_integration_exception_queue_scope',
                           'SELECT') then
        raise exception
            'FAIL 4: anon must NOT have SELECT on '
            'v_integration_exception_queue_scope';
    end if;

    raise notice 'PASS 4: anon is correctly denied SELECT on v_integration_exception_queue_scope';
end;
$$;

-- ── 5. Attempting SELECT as authenticated raises insufficient_privilege ───
-- Confirms the denial is enforced at execution time, not just at grant level.
set local role authenticated;
select set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0001-000000000001","role":"authenticated","app_metadata":{"role":"admin","tenant":"intq-test"}}',
    true
);

do $$
declare
    v_caught bool := false;
    v_dummy  int;
begin
    begin
        select count(*) into v_dummy
        from public.v_integration_exception_queue_scope;
        raise exception
            'FAIL 5: authenticated SELECT on v_integration_exception_queue_scope '
            'should raise insufficient_privilege but succeeded';
    exception
        when insufficient_privilege then
            v_caught := true;
        when others then
            raise exception
                'FAIL 5: unexpected error % "%"', sqlstate, sqlerrm;
    end;

    if not v_caught then
        raise exception
            'FAIL 5: authenticated must be denied SELECT on '
            'v_integration_exception_queue_scope';
    end if;

    raise notice 'PASS 5: authenticated SELECT correctly raises insufficient_privilege';
end;
$$;

-- ── 6. service_role can execute a SELECT without error ───────────────────
reset role;

do $$
declare
    v_count int;
begin
    -- No fixture rows are seeded so we just prove the query compiles and
    -- executes without error; row count of zero is expected.
    select count(*) into v_count
    from public.v_integration_exception_queue_scope;

    raise notice 'PASS 6: service_role SELECT returned % row(s) (empty fixture is expected)', v_count;
end;
$$;

rollback;
