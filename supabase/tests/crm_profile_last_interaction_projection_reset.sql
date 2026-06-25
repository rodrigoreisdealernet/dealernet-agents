begin;

-- Validate that the CRM profile last-interaction projection migration
-- (20260615122000_crm_profile_last_interaction_projection.sql) applies cleanly
-- on a full supabase db reset and that the new columns are both present and
-- populated correctly after calling crm_upsert_customer_profile with
-- p_enrich_only => true.
--
-- Runs after: supabase db reset (which applies migrations + seed.sql)

do $$
declare
  v_customer_id        uuid;
  v_source_record_id   text;
  v_interaction_type   text;
  v_interaction_summary text;
  v_col_exists_type    boolean;
  v_col_exists_summary boolean;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- ------------------------------------------------------------------
  -- 1. last_interaction_type and last_interaction_summary columns must
  --    exist on crm_customer_profile_current after the migration is applied.
  -- ------------------------------------------------------------------
  select
    count(*) filter (where column_name = 'last_interaction_type') > 0,
    count(*) filter (where column_name = 'last_interaction_summary') > 0
    into v_col_exists_type, v_col_exists_summary
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'crm_customer_profile_current';

  if not v_col_exists_type then
    raise exception
      'CRM projection migration check failed: column last_interaction_type is missing from crm_customer_profile_current';
  end if;

  if not v_col_exists_summary then
    raise exception
      'CRM projection migration check failed: column last_interaction_summary is missing from crm_customer_profile_current';
  end if;

  -- ------------------------------------------------------------------
  -- 2. Resolve the first seeded customer so we can round-trip the data.
  -- ------------------------------------------------------------------
  select e.id, e.source_record_id
    into v_customer_id, v_source_record_id
  from public.entities e
  where e.entity_type = 'customer'
  order by e.created_at, e.id
  limit 1;

  if v_customer_id is null then
    raise exception
      'CRM projection migration check failed: no seeded customer found after reset';
  end if;

  -- ------------------------------------------------------------------
  -- 3. Write last_interaction_type + last_interaction_summary via the
  --    enrichment path (p_enrich_only => true) and confirm the view
  --    projects the values correctly — this is the exact path the
  --    Log Interaction action uses from /crm/customers/:id.
  -- ------------------------------------------------------------------
  perform public.crm_upsert_customer_profile(
    p_source_record_id => v_source_record_id,
    p_data             => jsonb_build_object(
                            'last_interaction_type',    'call',
                            'last_interaction_summary', 'Reset-path projection validation call'
                          ),
    p_enrich_only      => true
  );

  select
    last_interaction_type,
    last_interaction_summary
    into v_interaction_type, v_interaction_summary
  from public.crm_customer_profile_current
  where entity_id = v_customer_id;

  if v_interaction_type is distinct from 'call' then
    raise exception
      'CRM projection migration check failed: expected last_interaction_type = ''call'', got %',
      coalesce(v_interaction_type, 'NULL');
  end if;

  if v_interaction_summary is distinct from 'Reset-path projection validation call' then
    raise exception
      'CRM projection migration check failed: expected last_interaction_summary = ''Reset-path projection validation call'', got %',
      coalesce(v_interaction_summary, 'NULL');
  end if;

  -- ------------------------------------------------------------------
  -- 4. A second read of the view must return the same values — simulating
  --    the browser reload that reads from crm_customer_profile_current.
  -- ------------------------------------------------------------------
  select
    last_interaction_type,
    last_interaction_summary
    into v_interaction_type, v_interaction_summary
  from public.crm_customer_profile_current
  where entity_id = v_customer_id;

  if v_interaction_type is distinct from 'call' then
    raise exception
      'CRM projection migration check failed: last_interaction_type changed on second read, expected ''call'', got %',
      coalesce(v_interaction_type, 'NULL');
  end if;

  if v_interaction_summary is distinct from 'Reset-path projection validation call' then
    raise exception
      'CRM projection migration check failed: last_interaction_summary changed on second read, expected ''Reset-path projection validation call'', got %',
      coalesce(v_interaction_summary, 'NULL');
  end if;

  raise notice 'CRM profile last-interaction projection reset assertions passed';
end;
$$;

rollback;
