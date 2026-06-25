-- Enable row-level security and least-privilege access for rental domain tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

DO $$
DECLARE
  v_table text;
  v_tables constant text[] := ARRAY[
    'entities',
    'entity_versions',
    'relationships_v2',
    'fact_types',
    'entity_facts',
    'time_series_points',
    'dim_rental_order_status',
    'dim_rental_contract_status',
    'dim_rental_line_status',
    'dim_asset_availability_status',
    'dim_rental_rate_type',
    'dim_rental_type'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);

    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM anon', v_table);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO anon', v_table);

    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM authenticated', v_table);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', v_table);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', v_table);

    EXECUTE format('DROP POLICY IF EXISTS anon_read ON public.%I', v_table);
    EXECUTE format('DROP POLICY IF EXISTS service_role_write ON public.%I', v_table);

    EXECUTE format(
      'CREATE POLICY anon_read ON public.%I FOR SELECT TO anon USING (true)',
      v_table
    );

    EXECUTE format(
      'CREATE POLICY service_role_write ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      v_table
    );
  END LOOP;
END;
$$;
