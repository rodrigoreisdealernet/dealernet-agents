begin;

do $$
declare
  v_assets int;
  v_demo_entities int;
  v_current_versions int;
  v_total_versions int;
  v_assets_on_rent int;
  v_overdue_returns int;
  v_open_maintenance int;
  v_total_assets int;
  v_available_assets int;
  v_unavailable_assets int;
  v_period_revenue numeric;
  v_prior_period_revenue numeric;
  v_branch_utilization_rows int;
  v_availability_rows int;
  v_downtime_rows int;
  v_service_history_rows int;
  v_category_downtime_rows int;
  v_asset_downtime_rollup_rows int;
  v_category_downtime_minutes numeric;
  v_asset_downtime_minutes numeric;
  v_invoice_rows int;
  v_order_rows int;
  v_contract_rows int;
  v_transfer_rows int;
  v_unsafe_contact_emails int;
  v_unsafe_billing_emails int;
  v_unsafe_requester_emails int;
  v_unsafe_customer_addresses int;
  v_unsafe_job_site_addresses int;
  v_raw_id_customer_names int;
  v_raw_id_branch_names int;
  v_orders_missing_customer int;
  v_contracts_missing_order int;
  v_invoices_missing_contract int;
  v_ops_orders_with_seeded_lines int;
  v_ops_pending_findings int;
  v_assets_with_local_catalog_images int;
  v_assets_with_external_or_blank_images int;
  v_assets_with_unmapped_catalog_images int;
  v_seeded_pending_count constant int := 3;
  v_pending_placeholder_count constant int := 24;
begin
  select count(*) into v_demo_entities
  from entities
  where source_record_id like 'demo-baseline-%';

  if v_demo_entities <> 169 then
    raise exception 'Expected 169 demo baseline entities, found %', v_demo_entities;
  end if;

  select count(*) into v_current_versions
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id like 'demo-baseline-%'
    and ev.is_current;

  if v_current_versions <> 169 then
    raise exception 'Expected 169 current versions for demo entities, found %', v_current_versions;
  end if;

  select count(*) into v_total_versions
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id like 'demo-baseline-%';

  if v_total_versions <> 169 then
    raise exception 'Expected 169 total versions after reseed (one per demo entity), found %', v_total_versions;
  end if;

  select count(*) into v_assets
  from entities
  where entity_type = 'asset'
    and source_record_id like 'demo-baseline-%';

  if v_assets < 30 or v_assets > 50 then
    raise exception 'Expected 30-50 demo assets, found %', v_assets;
  end if;

  select assets_on_rent, overdue_returns_count, open_maintenance_count, period_revenue, prior_period_revenue, total_assets, available_assets, unavailable_assets
  into v_assets_on_rent, v_overdue_returns, v_open_maintenance, v_period_revenue, v_prior_period_revenue, v_total_assets, v_available_assets, v_unavailable_assets
  from v_home_dashboard_kpis;

  if v_assets_on_rent <= 0 then
    raise exception 'Expected non-zero assets_on_rent KPI, got %', v_assets_on_rent;
  end if;

  if v_overdue_returns <= 0 then
    raise exception 'Expected non-zero overdue_returns_count KPI, got %', v_overdue_returns;
  end if;

  if v_open_maintenance <= 0 then
    raise exception 'Expected non-zero open_maintenance_count KPI, got %', v_open_maintenance;
  end if;

  if v_period_revenue <= 0 or v_prior_period_revenue <= 0 then
    raise exception 'Expected non-zero period revenue KPIs, got period=% prior=%', v_period_revenue, v_prior_period_revenue;
  end if;

  if v_total_assets <= 0 or v_available_assets <= 0 or v_unavailable_assets <= 0 then
    raise exception 'Expected non-zero fleet availability breakdown, got total=% available=% unavailable=%', v_total_assets, v_available_assets, v_unavailable_assets;
  end if;

  select count(*) into v_branch_utilization_rows from v_branch_utilization;
  if v_branch_utilization_rows < 2 then
    raise exception 'Expected at least 2 branch utilization rows, found %', v_branch_utilization_rows;
  end if;

  select count(*) into v_availability_rows from rental_asset_availability_current;
  if v_availability_rows < 6 then
    raise exception 'Expected multiple branch/category availability rows, found %', v_availability_rows;
  end if;

  select count(*) into v_downtime_rows from v_asset_downtime_history;
  if v_downtime_rows <= 0 then
    raise exception 'Expected downtime rows for fleet reporting, found %', v_downtime_rows;
  end if;

  select count(*) into v_service_history_rows from v_asset_service_history;
  if v_service_history_rows <= 0 then
    raise exception 'Expected service-history rows for asset detail, found %', v_service_history_rows;
  end if;

  select count(*), coalesce(sum(total_downtime_minutes), 0)
    into v_category_downtime_rows, v_category_downtime_minutes
  from v_asset_category_downtime_summary;
  if v_category_downtime_rows <= 0 or v_category_downtime_minutes <= 0 then
    raise exception 'Expected non-zero category downtime rollups, found rows=% total_minutes=%',
      v_category_downtime_rows, v_category_downtime_minutes;
  end if;

  select count(*), coalesce(sum(total_downtime_minutes), 0)
    into v_asset_downtime_rollup_rows, v_asset_downtime_minutes
  from v_asset_downtime_analytics;
  if v_asset_downtime_rollup_rows <= 0 or v_asset_downtime_minutes <= 0 then
    raise exception 'Expected non-zero asset downtime analytics, found rows=% total_minutes=%',
      v_asset_downtime_rollup_rows, v_asset_downtime_minutes;
  end if;

  select count(*) into v_invoice_rows from entities where entity_type = 'invoice' and source_record_id like 'demo-baseline-%';
  select count(*) into v_order_rows from entities where entity_type = 'rental_order' and source_record_id like 'demo-baseline-%';
  select count(*) into v_contract_rows from entities where entity_type = 'rental_contract' and source_record_id like 'demo-baseline-%';
  select count(*) into v_transfer_rows from entities where entity_type = 'transfer' and source_record_id like 'demo-baseline-%';

  if v_invoice_rows < 5 or v_order_rows < 8 or v_contract_rows < 4 or v_transfer_rows < 4 then
    raise exception 'Expected populated operational entity sets; got invoices=% orders=% contracts=% transfers=%',
      v_invoice_rows, v_order_rows, v_contract_rows, v_transfer_rows;
  end if;

  select count(distinct o.id) into v_ops_orders_with_seeded_lines
  from entities o
  join entity_versions ov
    on ov.entity_id = o.id
   and ov.is_current
  join entities l
    on l.entity_type = 'rental_order_line'
   and l.source_record_id like 'demo-ops-rental-order-line-%'
  join entity_versions lv
    on lv.entity_id = l.id
   and lv.is_current
  where o.entity_type = 'rental_order'
    and o.source_record_id like 'demo-ops-rental-order-%'
    and coalesce(lv.data->>'order_id', '') = o.id::text
    and coalesce(lv.data->>'category_id', '') <> ''
    and coalesce(lv.data->>'job_site_id', '') <> '';

  if v_ops_orders_with_seeded_lines < 8 then
    raise exception 'Expected seeded demo-ops rental orders to carry category_id + job_site_id lines, found %', v_ops_orders_with_seeded_lines;
  end if;

  select count(*) into v_ops_pending_findings
  from finding f
  join tenants t on t.id = f.tenant_id
  where t.tenant_key = 'demo-ops-a'
    and f.status = 'pending_approval';

  if v_ops_pending_findings < (v_seeded_pending_count + v_pending_placeholder_count) then
    raise exception
      'Expected a stable pending demo-ops finding queue (>=%), found %',
      (v_seeded_pending_count + v_pending_placeholder_count),
      v_ops_pending_findings;
  end if;

  -- ---------------------------------------------------------------------------
  -- Catalog image URL checks
  -- Seeded demo assets must resolve to bundled repo-served catalog images.
  -- ---------------------------------------------------------------------------

  select count(*)
    into v_assets_with_local_catalog_images
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'asset'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and ev.data->>'image_url' like '/equipment-images/%';

  if v_assets_with_local_catalog_images <> v_assets then
    raise exception 'Expected all % demo assets to have local /equipment-images/* URLs, found %', v_assets, v_assets_with_local_catalog_images;
  end if;

  select count(*)
    into v_assets_with_external_or_blank_images
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'asset'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and (
      coalesce(ev.data->>'image_url', '') = ''
      or ev.data->>'image_url' like 'http://%'
      or ev.data->>'image_url' like 'https://%'
    );

  if v_assets_with_external_or_blank_images > 0 then
    raise exception 'Found % demo assets with external or blank image_url values; expected bundled local catalog image paths', v_assets_with_external_or_blank_images;
  end if;

  select count(*)
    into v_assets_with_unmapped_catalog_images
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'asset'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and ev.data->>'image_url' not in (
      '/equipment-images/earthmoving.svg',
      '/equipment-images/boom-scissor-lifts.svg',
      '/equipment-images/power-climate.svg',
      '/equipment-images/compaction-rollers.svg',
      '/equipment-images/worksite-attachments.svg'
    );

  if v_assets_with_unmapped_catalog_images > 0 then
    raise exception 'Found % demo assets with unmapped catalog image paths; expected category-mapped bundled SVG paths', v_assets_with_unmapped_catalog_images;
  end if;

  -- ---------------------------------------------------------------------------
  -- Demo-safe email domain checks
  -- All seeded emails must use @example.com to remain demo-safe and non-sensitive.
  -- ---------------------------------------------------------------------------

  select count(*) into v_unsafe_contact_emails
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'contact'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and ev.data ? 'email'
    and not (ev.data->>'email' like '%@example.com');

  if v_unsafe_contact_emails > 0 then
    raise exception 'Found % demo contact(s) with email not ending in @example.com — reseed must use reserved/example domains', v_unsafe_contact_emails;
  end if;

  select count(*) into v_unsafe_billing_emails
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'billing_account'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and ev.data ? 'billing_email'
    and not (ev.data->>'billing_email' like '%@example.com');

  if v_unsafe_billing_emails > 0 then
    raise exception 'Found % demo billing account(s) with billing_email not ending in @example.com', v_unsafe_billing_emails;
  end if;

  select count(*) into v_unsafe_requester_emails
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'rental_order'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and ev.data ? 'requester_id'
    and not (ev.data->>'requester_id' like '%@example.com');

  if v_unsafe_requester_emails > 0 then
    raise exception 'Found % demo rental order(s) with requester_id not ending in @example.com', v_unsafe_requester_emails;
  end if;

  -- ---------------------------------------------------------------------------
  -- Synthetic address pattern checks
  -- Seeded addresses must use clearly synthetic TX ZIP codes in the reserved
  -- 75000–75099 block so they cannot be mistaken for real private data.
  -- ---------------------------------------------------------------------------

  select count(*) into v_unsafe_customer_addresses
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'customer'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and ev.data ? 'hq_address'
    and not (ev.data->>'hq_address' ~ 'TX 750[0-9][0-9]');

  if v_unsafe_customer_addresses > 0 then
    raise exception 'Found % demo customer(s) with hq_address not matching synthetic TX ZIP pattern (TX 75000-75099)', v_unsafe_customer_addresses;
  end if;

  select count(*) into v_unsafe_job_site_addresses
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'job_site'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and ev.data ? 'address'
    and not (ev.data->>'address' ~ 'TX 750[0-9][0-9]');

  if v_unsafe_job_site_addresses > 0 then
    raise exception 'Found % demo job_site(s) with address not matching synthetic TX ZIP pattern (TX 75000-75099)', v_unsafe_job_site_addresses;
  end if;

  -- ---------------------------------------------------------------------------
  -- Human-readable name checks
  -- Entity names must not be raw source_record_id values or UUIDs — list screens
  -- must render real names, not placeholder/ID-heavy content.
  -- ---------------------------------------------------------------------------

  select count(*) into v_raw_id_customer_names
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'customer'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and (
      ev.data->>'name' like 'demo-baseline-%'
      or ev.data->>'name' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-'
      or ev.data->>'name' is null
    );

  if v_raw_id_customer_names > 0 then
    raise exception 'Found % demo customer(s) with raw-ID or null name — names must be human-readable', v_raw_id_customer_names;
  end if;

  select count(*) into v_raw_id_branch_names
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'branch'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and (
      ev.data->>'name' like 'demo-baseline-%'
      or ev.data->>'name' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-'
      or ev.data->>'name' is null
    );

  if v_raw_id_branch_names > 0 then
    raise exception 'Found % demo branch(es) with raw-ID or null name — names must be human-readable', v_raw_id_branch_names;
  end if;

  -- ---------------------------------------------------------------------------
  -- Relationship/reference consistency checks
  -- Rental orders, contracts, and invoices must reference real entities rather
  -- than holding null foreign keys, so the demo UX renders coherent linked data.
  -- ---------------------------------------------------------------------------

  select count(*) into v_orders_missing_customer
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'rental_order'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and (ev.data->>'customer_id' is null or ev.data->>'customer_id' = '');

  if v_orders_missing_customer > 0 then
    raise exception 'Found % demo rental order(s) with null/empty customer_id — orders must reference a customer', v_orders_missing_customer;
  end if;

  select count(*) into v_contracts_missing_order
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'rental_contract'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and (ev.data->>'order_id' is null or ev.data->>'order_id' = '');

  if v_contracts_missing_order > 0 then
    raise exception 'Found % demo contract(s) with null/empty order_id — contracts must reference an order', v_contracts_missing_order;
  end if;

  select count(*) into v_invoices_missing_contract
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.entity_type = 'invoice'
    and e.source_record_id like 'demo-baseline-%'
    and ev.is_current
    and (ev.data->>'contract_id' is null or ev.data->>'contract_id' = '');

  if v_invoices_missing_contract > 0 then
    raise exception 'Found % demo invoice(s) with null/empty contract_id — invoices must reference a contract', v_invoices_missing_contract;
  end if;

  -- Portal scope token seeded for demo contract 002
  declare
    v_portal_url text;
  begin
    select portal_get_demo_portal_url() into v_portal_url;
    if v_portal_url is null then
      raise exception 'portal_get_demo_portal_url() returned null — demo portal scope token must be seeded for demo-baseline-rental-contract-002';
    end if;
    if v_portal_url not like '/portal/schedule/%?scope=wynne-demo-portal-scope-001' then
      raise exception 'portal_get_demo_portal_url() returned unexpected URL: %', v_portal_url;
    end if;
  end;

  -- Portal intake demo token seeded (enables E2E_PORTAL_INTAKE_SCOPED_URL)
  declare
    v_intake_url text;
  begin
    perform set_config('request.jwt.claim.role', 'service_role', true);
    select portal_get_demo_intake_url() into v_intake_url;
    if v_intake_url is null then
      raise exception 'portal_get_demo_intake_url() returned null — demo intake token must be seeded (wynne-demo-intake-token-001)';
    end if;
    if v_intake_url not like '/portal/intake/%#token=wynne-demo-intake-token-001' then
      raise exception 'portal_get_demo_intake_url() returned unexpected URL: % (expected /portal/intake/<uuid>#token=wynne-demo-intake-token-001)', v_intake_url;
    end if;
  end;

end
$$;

rollback;
