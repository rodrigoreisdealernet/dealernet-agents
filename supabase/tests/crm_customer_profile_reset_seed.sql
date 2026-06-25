-- CRM customer profile reset seed assertions
-- Verifies that supabase db reset + seed.sql produces a populated
-- crm_customer_profile_current view and that the seeded contacts are
-- operator-readable via the relationship graph.
--
-- Runs after: supabase db reset (which applies migrations + seed.sql)

begin;

do $$
declare
  v_customer_count     bigint;
  v_first_name         text;
  v_contact_count      bigint;
  v_gold_count         bigint;
  v_national_count     bigint;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- ------------------------------------------------------------------
  -- 1. crm_customer_profile_current must surface the 4 seeded customers
  -- ------------------------------------------------------------------
  select count(*) into v_customer_count
  from crm_customer_profile_current;

  if v_customer_count < 4 then
    raise exception
      'CRM reset seed check failed: expected >=4 customer profiles, got %',
      v_customer_count;
  end if;

  -- ------------------------------------------------------------------
  -- 2. At least one seeded customer name must be non-null and non-empty
  -- ------------------------------------------------------------------
  select name into v_first_name
  from crm_customer_profile_current
  where name is not null
  order by name
  limit 1;

  if v_first_name is null or v_first_name = '' then
    raise exception
      'CRM reset seed check failed: no customer with a non-empty name found in crm_customer_profile_current';
  end if;

  -- ------------------------------------------------------------------
  -- 3. Tier and customer_type columns are populated by seed data
  -- ------------------------------------------------------------------
  select count(*) into v_gold_count
  from crm_customer_profile_current
  where tier = 'gold';

  if v_gold_count < 1 then
    raise exception
      'CRM reset seed check failed: expected >=1 gold-tier customer from seed data, got %',
      v_gold_count;
  end if;

  select count(*) into v_national_count
  from crm_customer_profile_current
  where customer_type = 'national';

  if v_national_count < 1 then
    raise exception
      'CRM reset seed check failed: expected >=1 national-type customer from seed data, got %',
      v_national_count;
  end if;

  -- ------------------------------------------------------------------
  -- 4. Seeded contacts are reachable via the relationship graph
  -- ------------------------------------------------------------------
  select count(*) into v_contact_count
  from relationships_v2
  where relationship_type = 'customer_has_contact'
    and is_current;

  if v_contact_count < 1 then
    raise exception
      'CRM reset seed check failed: no customer_has_contact relationships found after reset';
  end if;

  raise notice 'CRM customer profile reset seed checks passed';
end;
$$;

rollback;
