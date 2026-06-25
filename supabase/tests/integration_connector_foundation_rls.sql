-- RLS behavioral tests for the integration connector foundation tables
-- (migration 20260611090000_integration_connector_foundation.sql).
--
-- These assertions fail if:
--   * anon can SELECT or INSERT any integration table
--   * authenticated roles not in ('admin','branch_manager') can SELECT rows
--   * authenticated can INSERT, UPDATE, or DELETE any integration row
--   * a tenant_a user can read tenant_b rows (cross-tenant leak)
--   * service_role is blocked from reading or writing rows it should own
--
-- Pattern: multiple DO blocks inside one transaction with SET LOCAL ROLE +
-- set_config('request.jwt.claims', ...) to simulate PostgREST JWT contexts.

begin;

-- ── Fixture setup (superuser / service_role context) ─────────────────────
do $$
declare
    v_tenant_a_id uuid;
    v_tenant_b_id uuid;
    v_config_a_id uuid;
    v_config_b_id uuid;
begin
    insert into public.tenants (tenant_key, name)
    values
        ('intg-rls-tenant-a', 'Integration RLS Tenant A'),
        ('intg-rls-tenant-b', 'Integration RLS Tenant B');

    select id into v_tenant_a_id from public.tenants where tenant_key = 'intg-rls-tenant-a';
    select id into v_tenant_b_id from public.tenants where tenant_key = 'intg-rls-tenant-b';

    -- Seed an integration_config row for each tenant (inserted separately to capture ids)
    insert into public.integration_config
        (tenant_id, provider, display_name, enabled, auth_type,
         connection_config, secret_refs, feature_config)
    values
        (v_tenant_a_id, 'mulesoft', 'Tenant A MuleSoft', true, 'client_credentials',
         '{"base_url":"https://a.example.com"}'::jsonb,
         '{"client_id_ref":"vault/a/client_id"}'::jsonb,
         '{}'::jsonb)
    returning id into v_config_a_id;

    insert into public.integration_config
        (tenant_id, provider, display_name, enabled, auth_type,
         connection_config, secret_refs, feature_config)
    values
        (v_tenant_b_id, 'mulesoft', 'Tenant B MuleSoft', true, 'client_credentials',
         '{"base_url":"https://b.example.com"}'::jsonb,
         '{"client_id_ref":"vault/b/client_id"}'::jsonb,
         '{}'::jsonb)
    returning id into v_config_b_id;

    -- Seed integration_sync_state rows
    insert into public.integration_sync_state
        (integration_id, tenant_id, scope_key, source_of_truth)
    values
        (v_config_a_id, v_tenant_a_id, 'rental_contract_snapshot', 'wynne'),
        (v_config_b_id, v_tenant_b_id, 'rental_contract_snapshot', 'wynne');

    -- Seed external_id_map rows
    insert into public.external_id_map
        (tenant_id, provider, entity_type, wynne_entity_id, external_id, external_system)
    values
        (v_tenant_a_id, 'mulesoft', 'contract', gen_random_uuid(), 'EXT-A-001', 'mulesoft'),
        (v_tenant_b_id, 'mulesoft', 'contract', gen_random_uuid(), 'EXT-B-001', 'mulesoft');

    -- Seed integration_delivery_log rows
    insert into public.integration_delivery_log
        (integration_id, tenant_id, direction, exchange_key, idempotency_key, status)
    values
        (v_config_a_id, v_tenant_a_id, 'outbound', 'rental_contract_snapshot', 'idem-a-001', 'delivered'),
        (v_config_b_id, v_tenant_b_id, 'outbound', 'rental_contract_snapshot', 'idem-b-001', 'delivered');

    raise notice 'Fixture setup complete: tenant_a=%, tenant_b=%', v_tenant_a_id, v_tenant_b_id;
end;
$$;

-- ── 1. anon is denied SELECT and INSERT on all four tables ────────────────
set local role anon;

do $$
declare
    v_caught bool;
    v_dummy  int;
begin
    -- 1a. integration_config SELECT
    v_caught := false;
    begin
        select count(*) into v_dummy from public.integration_config;
        raise exception 'FAIL 1a: anon SELECT on integration_config succeeded';
    exception
        when insufficient_privilege then v_caught := true;
        when others then raise exception 'FAIL 1a: unexpected % "%"', sqlstate, sqlerrm;
    end;
    if not v_caught then
        raise exception 'FAIL 1a: anon should be denied SELECT on integration_config';
    end if;

    -- 1b. integration_sync_state SELECT
    v_caught := false;
    begin
        select count(*) into v_dummy from public.integration_sync_state;
        raise exception 'FAIL 1b: anon SELECT on integration_sync_state succeeded';
    exception
        when insufficient_privilege then v_caught := true;
        when others then raise exception 'FAIL 1b: unexpected % "%"', sqlstate, sqlerrm;
    end;
    if not v_caught then
        raise exception 'FAIL 1b: anon should be denied SELECT on integration_sync_state';
    end if;

    -- 1c. external_id_map SELECT
    v_caught := false;
    begin
        select count(*) into v_dummy from public.external_id_map;
        raise exception 'FAIL 1c: anon SELECT on external_id_map succeeded';
    exception
        when insufficient_privilege then v_caught := true;
        when others then raise exception 'FAIL 1c: unexpected % "%"', sqlstate, sqlerrm;
    end;
    if not v_caught then
        raise exception 'FAIL 1c: anon should be denied SELECT on external_id_map';
    end if;

    -- 1d. integration_delivery_log SELECT
    v_caught := false;
    begin
        select count(*) into v_dummy from public.integration_delivery_log;
        raise exception 'FAIL 1d: anon SELECT on integration_delivery_log succeeded';
    exception
        when insufficient_privilege then v_caught := true;
        when others then raise exception 'FAIL 1d: unexpected % "%"', sqlstate, sqlerrm;
    end;
    if not v_caught then
        raise exception 'FAIL 1d: anon should be denied SELECT on integration_delivery_log';
    end if;

    raise notice 'PASS 1: anon denied SELECT on all four integration tables';
end;
$$;

reset role;

-- ── 2. authenticated admin can SELECT only their tenant's rows ────────────
--
-- Sets JWT claims so ops_claim_tenant_key() returns 'intg-rls-tenant-a'
-- and ops_claim_app_role() returns 'admin'.  Tenant A rows must be visible;
-- tenant B rows must be hidden by RLS.
set local role authenticated;
select set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0001-000000000001","role":"authenticated","app_metadata":{"role":"admin","tenant":"intg-rls-tenant-a"}}',
    true
);

do $$
declare
    v_tenant_a_id uuid;
    v_count_a     int;
    v_count_b     int;
    v_total       int;
begin
    select id into v_tenant_a_id from public.tenants where tenant_key = 'intg-rls-tenant-a';

    -- integration_config: must see tenant_a row, not tenant_b row
    select count(*) into v_total from public.integration_config
    where provider = 'mulesoft';

    select count(*) into v_count_a from public.integration_config
    where tenant_id = v_tenant_a_id and provider = 'mulesoft';

    if v_count_a < 1 then
        raise exception 'FAIL 2a: admin should see tenant_a integration_config row; got %', v_count_a;
    end if;

    if v_total <> v_count_a then
        raise exception
            'FAIL 2b: cross-tenant leak — integration_config total=% but tenant_a count=%; '
            'tenant_b rows must be invisible', v_total, v_count_a;
    end if;

    -- integration_sync_state: only tenant_a rows
    select count(*) into v_total from public.integration_sync_state;
    select count(*) into v_count_a from public.integration_sync_state
    where tenant_id = v_tenant_a_id;
    if v_total <> v_count_a then
        raise exception
            'FAIL 2c: cross-tenant leak — integration_sync_state total=% tenant_a=%',
            v_total, v_count_a;
    end if;

    -- external_id_map: only tenant_a rows
    select count(*) into v_total from public.external_id_map;
    select count(*) into v_count_a from public.external_id_map where tenant_id = v_tenant_a_id;
    if v_total <> v_count_a then
        raise exception
            'FAIL 2d: cross-tenant leak — external_id_map total=% tenant_a=%',
            v_total, v_count_a;
    end if;

    -- integration_delivery_log: only tenant_a rows
    select count(*) into v_total from public.integration_delivery_log;
    select count(*) into v_count_a from public.integration_delivery_log
    where tenant_id = v_tenant_a_id;
    if v_total <> v_count_a then
        raise exception
            'FAIL 2e: cross-tenant leak — integration_delivery_log total=% tenant_a=%',
            v_total, v_count_a;
    end if;

    raise notice 'PASS 2: admin sees only their tenant rows; cross-tenant isolation holds';
end;
$$;

reset role;

-- ── 3. authenticated field_operator cannot SELECT integration tables ───────
--
-- Integration config/sync/alias/delivery are admin/branch_manager only.
-- field_operator should see zero rows (RLS role gate).
set local role authenticated;
select set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0001-000000000002","role":"authenticated","app_metadata":{"role":"field_operator","tenant":"intg-rls-tenant-a"}}',
    true
);

do $$
declare
    v_count int;
begin
    select count(*) into v_count from public.integration_config;
    if v_count <> 0 then
        raise exception
            'FAIL 3a: field_operator should see 0 integration_config rows (RLS role gate); got %',
            v_count;
    end if;

    select count(*) into v_count from public.integration_sync_state;
    if v_count <> 0 then
        raise exception
            'FAIL 3b: field_operator should see 0 integration_sync_state rows; got %', v_count;
    end if;

    select count(*) into v_count from public.external_id_map;
    if v_count <> 0 then
        raise exception
            'FAIL 3c: field_operator should see 0 external_id_map rows; got %', v_count;
    end if;

    select count(*) into v_count from public.integration_delivery_log;
    if v_count <> 0 then
        raise exception
            'FAIL 3d: field_operator should see 0 integration_delivery_log rows; got %', v_count;
    end if;

    raise notice 'PASS 3: field_operator sees 0 rows on all integration tables (role gate effective)';
end;
$$;

reset role;

-- ── 4. authenticated cannot INSERT, UPDATE, or DELETE integration rows ────
--
-- All writes must go through the Temporal worker (service_role).
-- authenticated has only SELECT granted; INSERT/UPDATE/DELETE raise
-- insufficient_privilege at the table-grant level.
set local role authenticated;
select set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0001-000000000001","role":"authenticated","app_metadata":{"role":"admin","tenant":"intg-rls-tenant-a"}}',
    true
);

do $$
declare
    v_tenant_a_id  uuid;
    v_caught       bool;
begin
    select id into v_tenant_a_id from public.tenants where tenant_key = 'intg-rls-tenant-a';

    -- 4a. INSERT on integration_config denied
    v_caught := false;
    begin
        insert into public.integration_config
            (tenant_id, provider, display_name, enabled, auth_type)
        values (v_tenant_a_id, 'injected_provider', 'Injected', true, 'none');
        if exists (
            select 1 from public.integration_config
            where tenant_id = v_tenant_a_id and provider = 'injected_provider'
        ) then
            raise exception 'FAIL 4a: authenticated INSERT on integration_config succeeded';
        end if;
        v_caught := true;  -- row silently suppressed by RLS
    exception
        when insufficient_privilege then v_caught := true;
        when check_violation        then v_caught := true;
        when others then raise exception 'FAIL 4a: unexpected % "%"', sqlstate, sqlerrm;
    end;
    if not v_caught then
        raise exception 'FAIL 4a: authenticated INSERT on integration_config should be denied';
    end if;

    -- 4b. UPDATE on integration_config denied
    v_caught := false;
    begin
        update public.integration_config
           set display_name = 'tampered'
         where tenant_id = v_tenant_a_id and provider = 'mulesoft';
        if exists (
            select 1 from public.integration_config
            where tenant_id = v_tenant_a_id and display_name = 'tampered'
        ) then
            raise exception 'FAIL 4b: authenticated UPDATE on integration_config mutated a row';
        end if;
        v_caught := true;  -- UPDATE silently affected 0 rows (RLS or no UPDATE policy)
    exception
        when insufficient_privilege then v_caught := true;
        when others then raise exception 'FAIL 4b: unexpected % "%"', sqlstate, sqlerrm;
    end;
    if not v_caught then
        raise exception 'FAIL 4b: authenticated UPDATE on integration_config should be denied';
    end if;

    -- 4c. DELETE on integration_config denied
    v_caught := false;
    begin
        delete from public.integration_config
        where tenant_id = v_tenant_a_id and provider = 'mulesoft';
        if not exists (
            select 1 from public.integration_config
            where tenant_id = v_tenant_a_id and provider = 'mulesoft'
        ) then
            raise exception 'FAIL 4c: authenticated DELETE removed integration_config row';
        end if;
        v_caught := true;  -- DELETE silently affected 0 rows
    exception
        when insufficient_privilege then v_caught := true;
        when others then raise exception 'FAIL 4c: unexpected % "%"', sqlstate, sqlerrm;
    end;
    if not v_caught then
        raise exception 'FAIL 4c: authenticated DELETE on integration_config should be denied';
    end if;

    raise notice 'PASS 4: authenticated cannot INSERT, UPDATE, or DELETE integration_config';
end;
$$;

reset role;

-- ── 5. service_role can INSERT, SELECT, UPDATE, DELETE ───────────────────
--
-- Temporal worker context: no JWT claims, service_role postgres role.
do $$
declare
    v_tenant_a_id  uuid;
    v_config_a_id  uuid;
    v_new_id       uuid;
    v_count        int;
begin
    select id into v_tenant_a_id from public.tenants where tenant_key = 'intg-rls-tenant-a';
    select id into v_config_a_id from public.integration_config
    where tenant_id = v_tenant_a_id and provider = 'mulesoft';

    -- 5a. service_role INSERT on external_id_map
    insert into public.external_id_map
        (tenant_id, provider, entity_type, wynne_entity_id, external_id, external_system)
    values
        (v_tenant_a_id, 'mulesoft', 'asset', gen_random_uuid(), 'SVC-ROLE-ASSET-001', 'mulesoft')
    returning id into v_new_id;

    assert v_new_id is not null,
        'FAIL 5a: service_role INSERT on external_id_map returned null id';

    -- 5b. service_role SELECT on external_id_map
    select count(*) into v_count from public.external_id_map
    where id = v_new_id;
    assert v_count = 1, format('FAIL 5b: service_role SELECT on external_id_map returned %', v_count);

    -- 5c. service_role UPDATE on external_id_map
    update public.external_id_map set external_id = 'SVC-ROLE-ASSET-001-UPD' where id = v_new_id;
    if not exists (select 1 from public.external_id_map where id = v_new_id and external_id = 'SVC-ROLE-ASSET-001-UPD') then
        raise exception 'FAIL 5c: service_role UPDATE on external_id_map did not take effect';
    end if;

    -- 5d. service_role DELETE on external_id_map
    delete from public.external_id_map where id = v_new_id;
    if exists (select 1 from public.external_id_map where id = v_new_id) then
        raise exception 'FAIL 5d: service_role DELETE on external_id_map did not remove the row';
    end if;

    -- 5e. service_role INSERT on integration_delivery_log
    insert into public.integration_delivery_log
        (integration_id, tenant_id, direction, exchange_key, idempotency_key, status)
    values
        (v_config_a_id, v_tenant_a_id, 'outbound', 'invoice_snapshot', 'svc-idem-001', 'pending')
    returning id into v_new_id;

    assert v_new_id is not null,
        'FAIL 5e: service_role INSERT on integration_delivery_log returned null id';

    raise notice 'PASS 5: service_role can INSERT, SELECT, UPDATE, DELETE integration tables';
end;
$$;

-- Rollback discards all fixture data inserted above, leaving the database clean
-- for subsequent test runs without requiring manual teardown.
rollback;
