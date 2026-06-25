-- Remove blanket anon read access from rental business data.
-- Authenticated role remains read-capable via existing grants + RLS.
-- Rollback plan (if auth-gated rollout must be backed out):
--   1) Re-grant anon SELECT on each table/view listed below.
--   2) Re-create anon_read SELECT policies on the gated base tables listed below.
--      Example per table:
--        GRANT SELECT ON TABLE public.<table_name> TO anon;
--        CREATE POLICY anon_read ON public.<table_name> FOR SELECT TO anon USING (true);
--      Example per view:
--        GRANT SELECT ON TABLE public.<view_name> TO anon;

DO $$
DECLARE
  v_table text;
  v_view text;
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
  v_views constant text[] := ARRAY[
    'rental_entity_type_catalog',
    'rental_relationship_type_catalog',
    'rental_current_entity_state',
    'rental_current_branches',
    'rental_current_customers',
    'rental_current_billing_accounts',
    'rental_current_contacts',
    'rental_current_job_sites',
    'rental_current_asset_categories',
    'rental_current_relationships',
    'rental_current_assets',
    'rental_asset_availability_current',
    'v_rental_order_current',
    'v_rental_contract_current',
    'v_rental_contract_line_current',
    'v_home_dashboard_kpis'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I FROM anon', v_table);
    EXECUTE format('DROP POLICY IF EXISTS anon_read ON public.%I', v_table);
  END LOOP;

  FOREACH v_view IN ARRAY v_views LOOP
    EXECUTE format('REVOKE SELECT ON TABLE public.%I FROM anon', v_view);
  END LOOP;
END;
$$;
