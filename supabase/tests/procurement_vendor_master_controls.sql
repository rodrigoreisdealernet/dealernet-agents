begin;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_vendor_id uuid;
  v_contact_id uuid;
  v_version int;
  v_vendor_versions int;
  v_closed_versions int;
  v_active bool;
  v_auth_status text;
  v_policy_role text;
  v_dual_approval bool;
  v_auto_approve bool;
  v_name text;
  v_contact_approved bool;
begin
  -- 1) Create a vendor master record.
  select vendor_id, version_number
    into v_vendor_id, v_version
  from public.procurement_upsert_vendor_master(
    p_name => 'Acme Parts Supply',
    p_vendor_code => 'ACME-001',
    p_is_active => true,
    p_payment_terms => 'net_30',
    p_currency_code => 'usd',
    p_tax_identifier => 'TAX-ACME-123',
    p_commercial_details => jsonb_build_object('incoterms', 'FOB', 'preferred_payment_method', 'ach')
  );

  if v_vendor_id is null or v_version <> 1 then
    raise exception 'FAIL 1: vendor create should return id + version 1';
  end if;

  select vendor_name
    into v_name
  from public.procurement_vendor_master_current
  where vendor_id = v_vendor_id;

  if v_name <> 'Acme Parts Supply' then
    raise exception 'FAIL 1: expected vendor_name Acme Parts Supply, got %', v_name;
  end if;

  -- 2) Update vendor state to inactive and confirm SCD2 history closure.
  select version_number
    into v_version
  from public.procurement_upsert_vendor_master(
    p_vendor_id => v_vendor_id,
    p_name => 'Acme Parts Supply',
    p_vendor_code => 'ACME-001',
    p_is_active => false,
    p_payment_terms => 'net_45',
    p_currency_code => 'USD',
    p_tax_identifier => 'TAX-ACME-123',
    p_commercial_details => jsonb_build_object('incoterms', 'CIF', 'preferred_payment_method', 'wire')
  );

  if v_version <> 2 then
    raise exception 'FAIL 2: vendor update should create version 2, got %', v_version;
  end if;

  select count(*), count(*) filter (where is_current = false)
    into v_vendor_versions, v_closed_versions
  from public.entity_versions
  where entity_id = v_vendor_id;

  if v_vendor_versions <> 2 or v_closed_versions <> 1 then
    raise exception 'FAIL 2: expected 2 total vendor versions and 1 closed version (got %, %)', v_vendor_versions, v_closed_versions;
  end if;

  select authorization_status
    into v_auth_status
  from public.procurement_evaluate_vendor_authorization(v_vendor_id, 100::numeric, now());

  if v_auth_status <> 'vendor_inactive' then
    raise exception 'FAIL 2: expected vendor_inactive for inactive vendor, got %', v_auth_status;
  end if;

  -- 3) Reactivate vendor, maintain approved purchasing contact.
  perform public.procurement_upsert_vendor_master(
    p_vendor_id => v_vendor_id,
    p_name => 'Acme Parts Supply',
    p_vendor_code => 'ACME-001',
    p_is_active => true,
    p_payment_terms => 'net_30',
    p_currency_code => 'USD',
    p_tax_identifier => 'TAX-ACME-123',
    p_commercial_details => jsonb_build_object('incoterms', 'FOB')
  );

  select contact_id
    into v_contact_id
  from public.procurement_upsert_vendor_contact(
    p_vendor_id => v_vendor_id,
    p_full_name => 'Dana Buyer',
    p_email => 'dana.buyer@example.com',
    p_phone => '+1-555-0100',
    p_title => 'Purchasing Manager',
    p_is_active => true,
    p_is_approved_purchasing_contact => true,
    p_notes => 'Primary procurement approver'
  );

  if v_contact_id is null then
    raise exception 'FAIL 3: expected created vendor contact id';
  end if;

  select is_active
    into v_active
  from public.procurement_vendor_master_current
  where vendor_id = v_vendor_id;

  if v_active is distinct from true then
    raise exception 'FAIL 3: expected vendor to be active after reactivation';
  end if;

  select is_approved_purchasing_contact
    into v_contact_approved
  from public.procurement_vendor_purchasing_contacts_current
  where vendor_id = v_vendor_id
    and contact_id = v_contact_id;

  if v_contact_approved is distinct from true then
    raise exception 'FAIL 3: expected approved purchasing contact=true';
  end if;

  -- 4) Explicit purchasing-limit/authorization-policy evaluation.
  insert into public.procurement_authorization_policies (
    vendor_id,
    policy_code,
    minimum_amount,
    maximum_amount,
    required_approval_role,
    require_dual_approval,
    auto_approve,
    is_active,
    metadata
  )
  values
    (
      v_vendor_id,
      'AUTO_UNDER_500',
      0,
      499.99,
      'branch_manager',
      false,
      true,
      true,
      jsonb_build_object('workflow', 'procurement_standard')
    ),
    (
      v_vendor_id,
      'APPROVAL_500_PLUS',
      500,
      null,
      'admin',
      true,
      false,
      true,
      jsonb_build_object('workflow', 'procurement_escalation')
    );

  select authorization_status, required_approval_role, require_dual_approval, auto_approve
    into v_auth_status, v_policy_role, v_dual_approval, v_auto_approve
  from public.procurement_evaluate_vendor_authorization(v_vendor_id, 250::numeric, now());

  if v_auth_status <> 'auto_approved' or v_policy_role <> 'branch_manager' or v_auto_approve is distinct from true then
    raise exception 'FAIL 4a: expected auto-approved branch_manager policy (got %, %, %)', v_auth_status, v_policy_role, v_auto_approve;
  end if;

  select authorization_status, required_approval_role, require_dual_approval, auto_approve
    into v_auth_status, v_policy_role, v_dual_approval, v_auto_approve
  from public.procurement_evaluate_vendor_authorization(v_vendor_id, 2400::numeric, now());

  if v_auth_status <> 'approval_required' or v_policy_role <> 'admin' or v_dual_approval is distinct from true then
    raise exception 'FAIL 4b: expected admin dual-approval policy (got %, %, %)', v_auth_status, v_policy_role, v_dual_approval;
  end if;

  raise notice 'PASS: procurement vendor master and purchasing controls checks passed';
end;
$$;

-- 5) Authenticated JWT/RLS behavior on direct policy writes.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
begin
  perform public.procurement_upsert_vendor_master(
    p_name => 'Authz Fixture Vendor',
    p_vendor_code => 'PROC-AUTHZ-FIXTURE-001',
    p_is_active => true,
    p_payment_terms => 'net_30',
    p_currency_code => 'USD',
    p_tax_identifier => 'TAX-AUTHZ-001',
    p_commercial_details => jsonb_build_object('fixture', true)
  );
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000111","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_vendor_id uuid;
  v_caught bool := false;
begin
  select id
    into v_vendor_id
  from public.entities
  where entity_type = 'vendor'
    and source_record_id = 'PROC-AUTHZ-FIXTURE-001';

  if v_vendor_id is null then
    raise exception 'FAIL 5a: fixture vendor not found';
  end if;

  begin
    insert into public.procurement_authorization_policies (
      vendor_id,
      policy_code,
      minimum_amount,
      maximum_amount,
      required_approval_role,
      require_dual_approval,
      auto_approve,
      is_active
    )
    values (
      v_vendor_id,
      'READ_ONLY_DENIED_DIRECT_WRITE',
      0,
      100,
      'admin',
      false,
      false,
      true
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 5a: unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 5a: read_only should be denied direct policy INSERT with 42501';
  end if;

  raise notice 'PASS 5a: read_only denied direct policy INSERT (42501)';
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000112","app_metadata":{"role":"branch_manager"}}',
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
    and source_record_id = 'PROC-AUTHZ-FIXTURE-001';

  if v_vendor_id is null then
    raise exception 'FAIL 5b: fixture vendor not found';
  end if;

  insert into public.procurement_authorization_policies (
    vendor_id,
    policy_code,
    minimum_amount,
    maximum_amount,
    required_approval_role,
    require_dual_approval,
    auto_approve,
    is_active
  )
  values (
    v_vendor_id,
    'BRANCH_MANAGER_DIRECT_WRITE_OK',
    101,
    999,
    'admin',
    false,
    false,
    true
  )
  returning id into v_policy_id;

  if v_policy_id is null then
    raise exception 'FAIL 5b: branch_manager direct policy INSERT should succeed';
  end if;

  raise notice 'PASS 5b: branch_manager direct policy INSERT succeeded';
end;
$$;

-- 6) Authenticated JWT/RPC behavior on vendor/contact upserts.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000113","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_vendor_id uuid;
  v_caught bool := false;
begin
  select id
    into v_vendor_id
  from public.entities
  where entity_type = 'vendor'
    and source_record_id = 'PROC-AUTHZ-FIXTURE-001';

  if v_vendor_id is null then
    raise exception 'FAIL 6a: fixture vendor not found';
  end if;

  begin
    perform public.procurement_upsert_vendor_master(
      p_name => 'Unauthorized Vendor Update',
      p_vendor_code => 'PROC-AUTHZ-FIXTURE-001',
      p_is_active => true
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 6a: unexpected vendor RPC error % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 6a: read_only should be denied procurement_upsert_vendor_master with 42501';
  end if;

  v_caught := false;
  begin
    perform public.procurement_upsert_vendor_contact(
      p_vendor_id => v_vendor_id,
      p_full_name => 'Unauthorized Contact',
      p_email => 'unauthorized.contact@example.com',
      p_is_active => true,
      p_is_approved_purchasing_contact => false
    );
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501' then v_caught := true;
    when others then
      raise exception 'FAIL 6a: unexpected contact RPC error % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'FAIL 6a: read_only should be denied procurement_upsert_vendor_contact with 42501';
  end if;

  raise notice 'PASS 6a: read_only denied vendor/contact upsert RPCs (42501)';
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000114","app_metadata":{"role":"branch_manager"}}',
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
    p_name => 'Manager Authorized Vendor',
    p_vendor_code => 'PROC-AUTHZ-MANAGER-001',
    p_is_active => true,
    p_payment_terms => 'net_30',
    p_currency_code => 'USD',
    p_tax_identifier => 'TAX-AUTHZ-MGR-001',
    p_commercial_details => jsonb_build_object('authorized_path', true)
  );

  if v_vendor_id is null then
    raise exception 'FAIL 6b: branch_manager vendor upsert should succeed';
  end if;

  select contact_id
    into v_contact_id
  from public.procurement_upsert_vendor_contact(
    p_vendor_id => v_vendor_id,
    p_full_name => 'Manager Authorized Contact',
    p_email => 'manager.contact@example.com',
    p_phone => '+1-555-0200',
    p_title => 'Procurement Lead',
    p_is_active => true,
    p_is_approved_purchasing_contact => true,
    p_notes => 'Authorized manager path'
  );

  if v_contact_id is null then
    raise exception 'FAIL 6b: branch_manager contact upsert should succeed';
  end if;

  raise notice 'PASS 6b: branch_manager vendor/contact upsert RPCs succeeded';
end;
$$;

reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '', true);

rollback;
