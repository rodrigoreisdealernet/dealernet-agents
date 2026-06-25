-- CRM demo customer baseline reset assertions
-- Verifies the CRM demo-customer migration materializes list/detail-readable
-- customer profiles in a migration-only rebuild path and remains idempotent.

begin;

-- Simulate a migration-only rebuild target with no pre-existing customers.
delete from public.entities where entity_type = 'customer';

-- Guard-path check: when a customer already exists, migration should no-op.
insert into public.entities (entity_type, source_record_id)
values ('customer', 'crm-reset-existing-customer');

\ir ../migrations/20260613220000_crm_demo_customer_baseline.sql

do $$
declare
  v_guarded_demo_count bigint;
begin
  select count(*) into v_guarded_demo_count
  from public.entities
  where entity_type = 'customer'
    and source_record_id like 'crm-demo-%';

  if v_guarded_demo_count <> 0 then
    raise exception
      'CRM demo baseline reset check failed: migration inserted demo customers despite pre-existing customer entities (count=%)',
      v_guarded_demo_count;
  end if;
end;
$$;

-- Seed-path check: with no customers, migration should create demo baseline rows.
delete from public.entities where entity_type = 'customer';

\ir ../migrations/20260613220000_crm_demo_customer_baseline.sql

do $$
declare
  v_expected_demo_count constant bigint := 3;
  v_demo_customer_count bigint;
  v_readable_name_count bigint;
  v_commercial_context_count bigint;
begin
  -- service_role is required so the reset assertion can query the protected
  -- CRM profile read model regardless of local auth/session defaults.
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select count(*) into v_demo_customer_count
  from public.crm_customer_profile_current
  where source_record_id like 'crm-demo-%';

  if v_demo_customer_count <> v_expected_demo_count then
    raise exception
      'CRM demo baseline reset check failed: expected exactly 3 migration-seeded demo customers, got %',
      v_demo_customer_count;
  end if;

  select count(*) into v_readable_name_count
  from public.crm_customer_profile_current
  where source_record_id like 'crm-demo-%'
    and coalesce(name, '') <> ''
    and name not like 'crm-demo-%'
    -- Exclude full UUID placeholders, which indicate unresolved/raw identifiers
    -- in list-rendered names.
    and name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  if v_readable_name_count <> v_expected_demo_count then
    raise exception
      'CRM demo baseline reset check failed: expected 3 readable customer names, got %',
      v_readable_name_count;
  end if;

  select count(*) into v_commercial_context_count
  from public.crm_customer_profile_current
  where source_record_id like 'crm-demo-%'
    and coalesce(industry, '') <> ''
    and coalesce(tier, '') <> ''
    and coalesce(customer_type, '') <> ''
    and coalesce(preferred_payment_method, '') <> ''
    and balance is not null
    and avg_days_to_pay is not null;

  if v_commercial_context_count <> v_expected_demo_count then
    raise exception
      'CRM demo baseline reset check failed: expected 3 demo customers with full commercial context, got %',
      v_commercial_context_count;
  end if;
end;
$$;

-- Second apply should no-op because customer entities now exist (idempotency).
\ir ../migrations/20260613220000_crm_demo_customer_baseline.sql

do $$
declare
  v_expected_demo_count constant bigint := 3;
  v_demo_customer_count bigint;
  v_distinct_demo_sources bigint;
begin
  select count(*) into v_demo_customer_count
  from public.entities
  where entity_type = 'customer'
    and source_record_id like 'crm-demo-%';

  select count(distinct source_record_id) into v_distinct_demo_sources
  from public.entities
  where entity_type = 'customer'
    and source_record_id like 'crm-demo-%';

  if v_demo_customer_count <> v_expected_demo_count
     or v_distinct_demo_sources <> v_expected_demo_count then
    raise exception
      'CRM demo baseline reset check failed: migration idempotency broken (rows=%, distinct_sources=%)',
      v_demo_customer_count, v_distinct_demo_sources;
  end if;

  raise notice 'CRM demo customer baseline reset checks passed';
end;
$$;

rollback;
