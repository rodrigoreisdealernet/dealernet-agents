-- Reset-path regression checks for procurement vendor master and purchasing
-- authorization controls
-- (migration 20260612194000_procurement_vendor_master_controls.sql).
set search_path = public, extensions;

begin;

do $$
declare
  v_fn_upsert_vendor_exists boolean;
  v_fn_upsert_contact_exists boolean;
  v_fn_evaluate_auth_exists boolean;
  v_view_vendor_master_exists boolean;
  v_view_contacts_exists boolean;
  v_table_policies_exists boolean;
  v_vendor_id uuid;
  v_contact_id uuid;
  v_version int;
  v_vendor_versions int;
  v_closed_versions int;
  v_name text;
  v_active boolean;
  v_auth_status text;
  v_policy_role text;
  v_dual_approval boolean;
  v_auto_approve boolean;
  v_contact_approved boolean;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', 'reset-path-user', true);

  -- 1. Core objects must exist after a fresh schema reset.
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'procurement_upsert_vendor_master'
      and p.prosecdef = true
      and pg_catalog.pg_get_function_identity_arguments(p.oid)
          = 'p_vendor_id uuid, p_name text, p_vendor_code text, p_is_active boolean, p_payment_terms text, p_currency_code text, p_tax_identifier text, p_commercial_details jsonb'
  ) into v_fn_upsert_vendor_exists;

  if not v_fn_upsert_vendor_exists then
    raise exception 'FAIL 1a: procurement_upsert_vendor_master(...) missing or not SECURITY DEFINER after reset';
  end if;

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'procurement_upsert_vendor_contact'
      and p.prosecdef = true
      and pg_catalog.pg_get_function_identity_arguments(p.oid)
          = 'p_vendor_id uuid, p_contact_id uuid, p_full_name text, p_email text, p_phone text, p_title text, p_is_active boolean, p_is_approved_purchasing_contact boolean, p_notes text'
  ) into v_fn_upsert_contact_exists;

  if not v_fn_upsert_contact_exists then
    raise exception 'FAIL 1b: procurement_upsert_vendor_contact(...) missing or not SECURITY DEFINER after reset';
  end if;

  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'procurement_evaluate_vendor_authorization'
      and p.prosecdef = false
      and pg_catalog.pg_get_function_identity_arguments(p.oid)
          = 'p_vendor_id uuid, p_purchase_amount numeric, p_evaluated_at timestamp with time zone'
  ) into v_fn_evaluate_auth_exists;

  if not v_fn_evaluate_auth_exists then
    raise exception 'FAIL 1c: procurement_evaluate_vendor_authorization(...) missing or not SECURITY INVOKER after reset';
  end if;

  select exists (
    select 1 from pg_views
    where schemaname = 'public'
      and viewname = 'procurement_vendor_master_current'
  ) into v_view_vendor_master_exists;

  if not v_view_vendor_master_exists then
    raise exception 'FAIL 1d: procurement_vendor_master_current view missing after reset';
  end if;

  select exists (
    select 1 from pg_views
    where schemaname = 'public'
      and viewname = 'procurement_vendor_purchasing_contacts_current'
  ) into v_view_contacts_exists;

  if not v_view_contacts_exists then
    raise exception 'FAIL 1e: procurement_vendor_purchasing_contacts_current view missing after reset';
  end if;

  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'procurement_authorization_policies'
      and c.relkind = 'r'
  ) into v_table_policies_exists;

  if not v_table_policies_exists then
    raise exception 'FAIL 1f: procurement_authorization_policies table missing after reset';
  end if;

  raise notice 'PASS 1: all vendor master objects exist after fresh reset';

  -- 2. Vendor create and master-view projection.
  select vendor_id, version_number
    into v_vendor_id, v_version
  from public.procurement_upsert_vendor_master(
    p_name => 'Acme Supplies Reset',
    p_vendor_code => 'RESET-ACME-001',
    p_is_active => true,
    p_payment_terms => 'net_30',
    p_currency_code => 'usd',
    p_tax_identifier => 'TAX-RESET-001',
    p_commercial_details => jsonb_build_object('incoterms', 'FOB')
  );

  if v_vendor_id is null or v_version <> 1 then
    raise exception 'FAIL 2a: vendor create should return id and version 1 (got vendor_id=%, version=%)', v_vendor_id, v_version;
  end if;

  select vendor_name, is_active
    into v_name, v_active
  from public.procurement_vendor_master_current
  where vendor_id = v_vendor_id;

  if v_name <> 'Acme Supplies Reset' or v_active is distinct from true then
    raise exception 'FAIL 2b: vendor master view should show name and active=true (got %, %)', v_name, v_active;
  end if;

  raise notice 'PASS 2: vendor create and master view projection work after reset';

  -- 3. SCD2 history closure on update.
  select version_number
    into v_version
  from public.procurement_upsert_vendor_master(
    p_vendor_id => v_vendor_id,
    p_name => 'Acme Supplies Reset',
    p_vendor_code => 'RESET-ACME-001',
    p_is_active => false,
    p_payment_terms => 'net_45',
    p_currency_code => 'USD',
    p_tax_identifier => 'TAX-RESET-001',
    p_commercial_details => jsonb_build_object('incoterms', 'CIF')
  );

  if v_version <> 2 then
    raise exception 'FAIL 3a: vendor update should create version 2 (got %)', v_version;
  end if;

  select count(*), count(*) filter (where is_current = false)
    into v_vendor_versions, v_closed_versions
  from public.entity_versions
  where entity_id = v_vendor_id;

  if v_vendor_versions <> 2 or v_closed_versions <> 1 then
    raise exception 'FAIL 3b: expected 2 total versions and 1 closed version (got %, %)', v_vendor_versions, v_closed_versions;
  end if;

  raise notice 'PASS 3: SCD2 history closure works correctly after reset';

  -- 4. Authorization evaluation on inactive vendor.
  select authorization_status
    into v_auth_status
  from public.procurement_evaluate_vendor_authorization(v_vendor_id, 100::numeric, now());

  if v_auth_status <> 'vendor_inactive' then
    raise exception 'FAIL 4: expected vendor_inactive for deactivated vendor (got %)', v_auth_status;
  end if;

  raise notice 'PASS 4: vendor_inactive authorization status returned correctly after reset';

  -- 5. Purchasing contact upsert and contacts view.
  perform public.procurement_upsert_vendor_master(
    p_vendor_id => v_vendor_id,
    p_name => 'Acme Supplies Reset',
    p_vendor_code => 'RESET-ACME-001',
    p_is_active => true,
    p_payment_terms => 'net_30',
    p_currency_code => 'USD',
    p_tax_identifier => 'TAX-RESET-001',
    p_commercial_details => jsonb_build_object('incoterms', 'FOB')
  );

  select contact_id
    into v_contact_id
  from public.procurement_upsert_vendor_contact(
    p_vendor_id => v_vendor_id,
    p_full_name => 'Pat Buyer',
    p_email => 'pat.buyer@example.com',
    p_phone => '+1-555-0199',
    p_title => 'Purchasing Lead',
    p_is_active => true,
    p_is_approved_purchasing_contact => true,
    p_notes => 'Reset path approval contact'
  );

  if v_contact_id is null then
    raise exception 'FAIL 5a: vendor contact create should return a contact id';
  end if;

  select is_approved_purchasing_contact
    into v_contact_approved
  from public.procurement_vendor_purchasing_contacts_current
  where vendor_id = v_vendor_id
    and contact_id = v_contact_id;

  if v_contact_approved is distinct from true then
    raise exception 'FAIL 5b: purchasing contacts view should reflect approved contact';
  end if;

  raise notice 'PASS 5: vendor contact create and purchasing contacts view work after reset';

  -- 6. Policy-based authorization evaluation.
  insert into public.procurement_authorization_policies (
    vendor_id, policy_code, minimum_amount, maximum_amount,
    required_approval_role, require_dual_approval, auto_approve, is_active, metadata
  )
  values
    (v_vendor_id, 'RESET_AUTO_UNDER_500', 0, 499.99,
     'branch_manager', false, true, true,
     jsonb_build_object('workflow', 'procurement_standard')),
    (v_vendor_id, 'RESET_APPROVAL_500_PLUS', 500, null,
     'admin', true, false, true,
     jsonb_build_object('workflow', 'procurement_escalation'));

  select authorization_status, required_approval_role, auto_approve
    into v_auth_status, v_policy_role, v_auto_approve
  from public.procurement_evaluate_vendor_authorization(v_vendor_id, 250::numeric, now());

  if v_auth_status <> 'auto_approved' or v_policy_role <> 'branch_manager' or v_auto_approve is distinct from true then
    raise exception 'FAIL 6a: expected auto_approved/branch_manager (got %, %, %)', v_auth_status, v_policy_role, v_auto_approve;
  end if;

  select authorization_status, required_approval_role, require_dual_approval
    into v_auth_status, v_policy_role, v_dual_approval
  from public.procurement_evaluate_vendor_authorization(v_vendor_id, 1500::numeric, now());

  if v_auth_status <> 'approval_required' or v_policy_role <> 'admin' or v_dual_approval is distinct from true then
    raise exception 'FAIL 6b: expected approval_required/admin/dual (got %, %, %)', v_auth_status, v_policy_role, v_dual_approval;
  end if;

  raise notice 'PASS 6: policy-based authorization evaluation works correctly after reset';
end;
$$;

-- 7. RLS: read_only cannot write directly to procurement_authorization_policies.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_vendor_id uuid;
begin
  select vendor_id
    into v_vendor_id
  from public.procurement_upsert_vendor_master(
    p_name => 'RLS Fixture Vendor Reset',
    p_vendor_code => 'RESET-RLS-FIXTURE-001',
    p_is_active => true,
    p_payment_terms => 'net_30',
    p_currency_code => 'USD',
    p_tax_identifier => 'TAX-RLS-RESET-001',
    p_commercial_details => jsonb_build_object('fixture', true)
  );
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000201","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_vendor_id uuid;
  v_caught boolean := false;
begin
  select id
    into v_vendor_id
  from public.entities
  where entity_type = 'vendor'
    and source_record_id = 'RESET-RLS-FIXTURE-001';

  if v_vendor_id is null then
    raise exception 'FAIL 7a: RLS fixture vendor not found after reset';
  end if;

  begin
    insert into public.procurement_authorization_policies (
      vendor_id, policy_code, minimum_amount, maximum_amount,
      required_approval_role, require_dual_approval, auto_approve, is_active
    )
    values (
      v_vendor_id, 'RESET_READ_ONLY_DENIED', 0, 100,
      'admin', false, false, true
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 7a: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 7a: read_only must be denied direct policy INSERT (42501)';
  end if;

  raise notice 'PASS 7a: read_only denied direct policy INSERT (42501) after reset';
end;
$$;

-- 8. RLS: branch_manager can write directly to procurement_authorization_policies.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000202","app_metadata":{"role":"branch_manager"}}',
  true
);

do $$
declare
  v_vendor_id uuid;
  v_policy_id uuid;
begin
  select id
    into v_vendor_id
  from public.entities
  where entity_type = 'vendor'
    and source_record_id = 'RESET-RLS-FIXTURE-001';

  if v_vendor_id is null then
    raise exception 'FAIL 8: RLS fixture vendor not found after reset';
  end if;

  insert into public.procurement_authorization_policies (
    vendor_id, policy_code, minimum_amount, maximum_amount,
    required_approval_role, require_dual_approval, auto_approve, is_active
  )
  values (
    v_vendor_id, 'RESET_BRANCH_MANAGER_WRITE_OK', 101, 999,
    'admin', false, false, true
  )
  returning id into v_policy_id;

  if v_policy_id is null then
    raise exception 'FAIL 8: branch_manager direct policy INSERT should succeed after reset';
  end if;

  raise notice 'PASS 8: branch_manager direct policy INSERT succeeded after reset';
end;
$$;

-- 9. RPC: read_only denied vendor/contact upserts.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000203","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_vendor_id uuid;
  v_caught boolean := false;
begin
  select id
    into v_vendor_id
  from public.entities
  where entity_type = 'vendor'
    and source_record_id = 'RESET-RLS-FIXTURE-001';

  if v_vendor_id is null then
    raise exception 'FAIL 9a: RLS fixture vendor not found';
  end if;

  begin
    perform public.procurement_upsert_vendor_master(
      p_name => 'Unauthorized Vendor Reset',
      p_vendor_code => 'RESET-RLS-FIXTURE-001',
      p_is_active => true
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 9a: unexpected vendor RPC error % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 9a: read_only must be denied procurement_upsert_vendor_master (42501)';
  end if;

  v_caught := false;
  begin
    perform public.procurement_upsert_vendor_contact(
      p_vendor_id => v_vendor_id,
      p_full_name => 'Unauthorized Contact Reset',
      p_email => 'unauthorized.reset@example.com',
      p_is_active => true,
      p_is_approved_purchasing_contact => false
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 9b: unexpected contact RPC error % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 9b: read_only must be denied procurement_upsert_vendor_contact (42501)';
  end if;

  raise notice 'PASS 9: read_only denied vendor/contact upsert RPCs after reset (42501)';
end;
$$;

-- 10. RPC: branch_manager can upsert vendor and contact.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000204","app_metadata":{"role":"branch_manager"}}',
  true
);

do $$
declare
  v_vendor_id uuid;
  v_contact_id uuid;
begin
  select vendor_id
    into v_vendor_id
  from public.procurement_upsert_vendor_master(
    p_name => 'Manager Authorized Vendor Reset',
    p_vendor_code => 'RESET-MGR-VENDOR-001',
    p_is_active => true,
    p_payment_terms => 'net_30',
    p_currency_code => 'USD',
    p_tax_identifier => 'TAX-MGR-RESET-001',
    p_commercial_details => jsonb_build_object('authorized_path', true)
  );

  if v_vendor_id is null then
    raise exception 'FAIL 10a: branch_manager vendor upsert should succeed after reset';
  end if;

  select contact_id
    into v_contact_id
  from public.procurement_upsert_vendor_contact(
    p_vendor_id => v_vendor_id,
    p_full_name => 'Manager Reset Contact',
    p_email => 'manager.reset@example.com',
    p_phone => '+1-555-0300',
    p_title => 'Procurement Lead',
    p_is_active => true,
    p_is_approved_purchasing_contact => true,
    p_notes => 'Reset path manager contact'
  );

  if v_contact_id is null then
    raise exception 'FAIL 10b: branch_manager contact upsert should succeed after reset';
  end if;

  raise notice 'PASS 10: branch_manager vendor/contact upsert RPCs succeeded after reset';
end;
$$;

reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '', true);

rollback;
