-- Behavioral checks for 20260619224000_compliance_subject_monitor_inputs.sql
--
-- Covers:
--  1) One scoped record per asset/operator/checkout subject with due date/state/branch/evidence
--  2) Tenant-config rule-input assembly using jurisdiction/equipment/category filters
--  3) Explicit blocked/unknown evidence gaps when prerequisites are missing or stale/unknown

begin;

do $$
declare
  v_tenant_a uuid;
  v_tenant_b uuid;
  v_count int;
  v_state text;
  v_gap_state text;
  v_rule_count int;
  v_has_missing bool;
  v_has_stale bool;
  v_has_unknown bool;
  v_due_date date;
  v_branch_name text;
  v_evidence_count int;
  v_count_before int;
  v_count_after int;
  v_text_before text;
  v_text_after text;
  v_write_blocked bool;
begin
  if not has_table_privilege('authenticated', 'public.v_compliance_subject_monitor', 'SELECT') then
    raise exception 'Expected authenticated SELECT on public.v_compliance_subject_monitor';
  end if;

  if has_table_privilege('anon', 'public.v_compliance_subject_monitor', 'SELECT') then
    raise exception 'Did not expect anon SELECT on public.v_compliance_subject_monitor';
  end if;

  insert into public.tenants (tenant_key, name)
  values
    ('compliance-monitor-a', 'Compliance Monitor Tenant A'),
    ('compliance-monitor-b', 'Compliance Monitor Tenant B')
  on conflict (tenant_key) do nothing;

  select id into v_tenant_a from public.tenants where tenant_key = 'compliance-monitor-a';
  select id into v_tenant_b from public.tenants where tenant_key = 'compliance-monitor-b';

  set local role service_role;

  insert into public.compliance_rule_inputs (
    tenant_id,
    subject_type,
    rule_key,
    rule_reference,
    jurisdiction_code,
    equipment_category,
    regulated_category,
    trigger_condition,
    required_inputs,
    stale_after_hours,
    due_window_days,
    enabled
  ) values
    (
      v_tenant_a,
      'asset',
      'asset-inspection-forklift-tx',
      'OSHA PIT inspections + branch inspection policy',
      'US-TX',
      'forklift',
      null,
      'inspection_due_within_window',
      '["inspection_certificate","asset_certification"]'::jsonb,
      48,
      30,
      true
    ),
    (
      v_tenant_a,
      'asset',
      'asset-inspection-california-only',
      'California-only inspection addendum',
      'US-CA',
      'forklift',
      null,
      'inspection_due_within_window',
      '["ca_specific_record"]'::jsonb,
      24,
      14,
      true
    ),
    (
      v_tenant_a,
      'operator',
      'operator-qualification-forklift',
      'OSHA operator qualification',
      null,
      'forklift',
      null,
      'operator_assignment_check',
      '["operator_license"]'::jsonb,
      24,
      14,
      true
    ),
    (
      v_tenant_a,
      'checkout_decision',
      'regulated-checkout-hazmat-us-tx',
      'HazMat checkout preconditions',
      'US-TX',
      null,
      'hazmat',
      'checkout_preflight',
      '["customer_qualification","operator_clearance"]'::jsonb,
      12,
      7,
      true
    ),
    (
      v_tenant_b,
      'asset',
      'asset-inspection-tenant-b',
      'Tenant B asset inspection rule',
      'US-TX',
      'forklift',
      null,
      'inspection_due_within_window',
      '["inspection_certificate"]'::jsonb,
      48,
      30,
      true
    );

  insert into public.compliance_subject_records (
    tenant_id,
    subject_type,
    subject_ref,
    subject_label,
    owning_branch_id,
    owning_branch_name,
    equipment_category,
    jurisdiction_code,
    regulated_category,
    due_date,
    current_state,
    evidence_refs,
    prerequisite_status,
    source_ref,
    source_synced_at
  ) values
    (
      v_tenant_a,
      'asset',
      'asset-a-1',
      'Branch A Forklift 101',
      gen_random_uuid(),
      'Branch A',
      'forklift',
      'US-TX',
      null,
      current_date + 5,
      'compliant',
      '["inspection:insp-101","certification:osha-101"]'::jsonb,
      '[
        {"key":"inspection_certificate","status":"ready","evidence_ref":"inspection:insp-101"},
        {"key":"asset_certification","status":"ready","evidence_ref":"certification:osha-101"}
      ]'::jsonb,
      'inspection-feed',
      now()
    ),
    (
      v_tenant_a,
      'operator',
      'operator-a-1',
      'Operator A',
      gen_random_uuid(),
      'Branch A',
      'forklift',
      'US-TX',
      null,
      current_date + 2,
      'compliant',
      '["operator:operator-a-1"]'::jsonb,
      '[]'::jsonb,
      'operator-credential-feed',
      now()
    ),
    (
      v_tenant_a,
      'checkout_decision',
      'checkout-a-1',
      'HazMat checkout case A',
      gen_random_uuid(),
      'Branch B',
      'forklift',
      'US-TX',
      'hazmat',
      current_date,
      'compliant',
      '["checkout:case-a-1"]'::jsonb,
      '[
        {"key":"customer_qualification","status":"stale","evidence_ref":"customer:qual-9"},
        {"key":"operator_clearance","status":"unknown"}
      ]'::jsonb,
      'checkout-preflight-feed',
      now() - interval '13 hours'
    ),
    (
      v_tenant_b,
      'asset',
      'asset-b-1',
      'Tenant B Forklift',
      gen_random_uuid(),
      'Branch B-1',
      'forklift',
      'US-TX',
      null,
      current_date + 3,
      'compliant',
      '["inspection:tenant-b"]'::jsonb,
      '[{"key":"inspection_certificate","status":"ready","evidence_ref":"inspection:tenant-b"}]'::jsonb,
      'inspection-feed',
      now()
    );

  reset role;

  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"app_metadata":{"role":"admin","tenant":"compliance-monitor-a"}}',
    true
  );

  -- Authenticated writes must be denied or blocked on new base tables.
  select count(*) into v_count_before
  from public.compliance_subject_records
  where tenant_id = v_tenant_a;

  v_write_blocked := false;
  begin
    insert into public.compliance_subject_records (
      tenant_id,
      subject_type,
      subject_ref,
      current_state
    ) values (
      v_tenant_a,
      'asset',
      'asset-auth-write-attempt',
      'compliant'
    );
  exception
    when insufficient_privilege then
      v_write_blocked := true;
  end;

  select count(*) into v_count_after
  from public.compliance_subject_records
  where tenant_id = v_tenant_a;
  if not v_write_blocked and v_count_after <> v_count_before then
    raise exception 'Authenticated INSERT unexpectedly succeeded on compliance_subject_records';
  end if;

  select owning_branch_name into v_text_before
  from public.compliance_subject_records
  where tenant_id = v_tenant_a
    and subject_type = 'asset'
    and subject_ref = 'asset-a-1';

  v_write_blocked := false;
  begin
    update public.compliance_subject_records
    set owning_branch_name = 'Unauthorized update attempt'
    where tenant_id = v_tenant_a
      and subject_type = 'asset'
      and subject_ref = 'asset-a-1';
  exception
    when insufficient_privilege then
      v_write_blocked := true;
  end;

  select owning_branch_name into v_text_after
  from public.compliance_subject_records
  where tenant_id = v_tenant_a
    and subject_type = 'asset'
    and subject_ref = 'asset-a-1';
  if not v_write_blocked and v_text_after is distinct from v_text_before then
    raise exception 'Authenticated UPDATE unexpectedly mutated compliance_subject_records';
  end if;

  select count(*) into v_count_before
  from public.compliance_subject_records
  where tenant_id = v_tenant_a;

  v_write_blocked := false;
  begin
    delete from public.compliance_subject_records
    where tenant_id = v_tenant_a
      and subject_type = 'asset'
      and subject_ref = 'asset-a-1';
  exception
    when insufficient_privilege then
      v_write_blocked := true;
  end;

  select count(*) into v_count_after
  from public.compliance_subject_records
  where tenant_id = v_tenant_a;
  if not v_write_blocked and v_count_after <> v_count_before then
    raise exception 'Authenticated DELETE unexpectedly removed compliance_subject_records rows';
  end if;

  select count(*) into v_count_before
  from public.compliance_rule_inputs
  where tenant_id = v_tenant_a;

  v_write_blocked := false;
  begin
    insert into public.compliance_rule_inputs (
      tenant_id,
      subject_type,
      rule_key,
      trigger_condition,
      required_inputs
    ) values (
      v_tenant_a,
      'asset',
      'asset-auth-rule-write-attempt',
      'inspection_due_within_window',
      '["inspection_certificate"]'::jsonb
    );
  exception
    when insufficient_privilege then
      v_write_blocked := true;
  end;

  select count(*) into v_count_after
  from public.compliance_rule_inputs
  where tenant_id = v_tenant_a;
  if not v_write_blocked and v_count_after <> v_count_before then
    raise exception 'Authenticated INSERT unexpectedly succeeded on compliance_rule_inputs';
  end if;

  select rule_reference into v_text_before
  from public.compliance_rule_inputs
  where tenant_id = v_tenant_a
    and subject_type = 'asset'
    and rule_key = 'asset-inspection-forklift-tx';

  v_write_blocked := false;
  begin
    update public.compliance_rule_inputs
    set rule_reference = 'Unauthorized update attempt'
    where tenant_id = v_tenant_a
      and subject_type = 'asset'
      and rule_key = 'asset-inspection-forklift-tx';
  exception
    when insufficient_privilege then
      v_write_blocked := true;
  end;

  select rule_reference into v_text_after
  from public.compliance_rule_inputs
  where tenant_id = v_tenant_a
    and subject_type = 'asset'
    and rule_key = 'asset-inspection-forklift-tx';
  if not v_write_blocked and v_text_after is distinct from v_text_before then
    raise exception 'Authenticated UPDATE unexpectedly mutated compliance_rule_inputs';
  end if;

  select count(*) into v_count_before
  from public.compliance_rule_inputs
  where tenant_id = v_tenant_a;

  v_write_blocked := false;
  begin
    delete from public.compliance_rule_inputs
    where tenant_id = v_tenant_a
      and subject_type = 'asset'
      and rule_key = 'asset-inspection-forklift-tx';
  exception
    when insufficient_privilege then
      v_write_blocked := true;
  end;

  select count(*) into v_count_after
  from public.compliance_rule_inputs
  where tenant_id = v_tenant_a;
  if not v_write_blocked and v_count_after <> v_count_before then
    raise exception 'Authenticated DELETE unexpectedly removed compliance_rule_inputs rows';
  end if;

  -- Exactly one scoped record per tenant-a subject (asset/operator/checkout_decision).
  select count(*) into v_count
  from public.v_compliance_subject_monitor;
  if v_count <> 3 then
    raise exception 'Expected 3 tenant-a scoped compliance subject rows, found %', v_count;
  end if;

  select count(*) into v_count
  from (
    select subject_type, subject_ref, count(*)
    from public.v_compliance_subject_monitor
    group by 1, 2
    having count(*) > 1
  ) duplicates;
  if v_count <> 0 then
    raise exception 'Expected one row per scoped subject; found duplicates';
  end if;

  -- Asset row: due date/current state/branch/evidence + TX forklift rule match only.
  select
    due_date,
    current_state,
    compliance_state,
    owning_branch_name,
    jsonb_array_length(evidence_refs),
    jsonb_array_length(rule_inputs)
  into v_due_date, v_state, v_gap_state, v_branch_name, v_evidence_count, v_rule_count
  from public.v_compliance_subject_monitor
  where subject_type = 'asset' and subject_ref = 'asset-a-1';

  if v_due_date is null then
    raise exception 'Expected due_date on asset scoped compliance row';
  end if;
  if v_state <> 'compliant' then
    raise exception 'Expected asset current_state=compliant, got %', coalesce(v_state, '<null>');
  end if;
  if v_gap_state <> 'compliant' then
    raise exception 'Expected asset compliance_state=compliant, got %', coalesce(v_gap_state, '<null>');
  end if;
  if v_branch_name <> 'Branch A' then
    raise exception 'Expected owning branch Branch A, got %', coalesce(v_branch_name, '<null>');
  end if;
  if v_evidence_count < 1 then
    raise exception 'Expected evidence references on asset scoped row';
  end if;
  if v_rule_count <> 1 then
    raise exception 'Expected exactly one matched rule for TX forklift asset, found %', v_rule_count;
  end if;

  if exists (
    select 1
    from public.v_compliance_subject_monitor v,
    jsonb_array_elements(v.rule_inputs) rule_item
    where v.subject_type = 'asset'
      and v.subject_ref = 'asset-a-1'
      and rule_item ->> 'rule_key' = 'asset-inspection-california-only'
  ) then
    raise exception 'Unexpected California-only rule matched for TX forklift asset';
  end if;

  -- Missing prerequisites are explicit blockers, never clean passes.
  select
    compliance_state,
    evidence_gap_state,
    exists (
      select 1
      from jsonb_array_elements(evidence_gaps) gap
      where gap ->> 'gap_state' = 'missing'
        and gap ->> 'required_input' = 'operator_license'
    )
  into v_state, v_gap_state, v_has_missing
  from public.v_compliance_subject_monitor
  where subject_type = 'operator' and subject_ref = 'operator-a-1';

  if v_state <> 'blocked' then
    raise exception 'Expected operator compliance_state=blocked when required input missing, got %', coalesce(v_state, '<null>');
  end if;
  if v_gap_state not in ('blocked_missing', 'blocked_missing_and_stale_or_unknown') then
    raise exception 'Expected blocked_missing evidence gap state for operator, got %', coalesce(v_gap_state, '<null>');
  end if;
  if not v_has_missing then
    raise exception 'Expected explicit missing operator_license evidence gap';
  end if;

  -- Stale/unknown prerequisites are explicit unknown blockers.
  select
    compliance_state,
    evidence_gap_state,
    exists (
      select 1
      from jsonb_array_elements(evidence_gaps) gap
      where gap ->> 'gap_state' = 'stale'
        and gap ->> 'required_input' = 'customer_qualification'
    ),
    exists (
      select 1
      from jsonb_array_elements(evidence_gaps) gap
      where gap ->> 'gap_state' = 'unknown'
        and gap ->> 'required_input' = 'operator_clearance'
    )
  into v_state, v_gap_state, v_has_stale, v_has_unknown
  from public.v_compliance_subject_monitor
  where subject_type = 'checkout_decision' and subject_ref = 'checkout-a-1';

  if v_state <> 'unknown' then
    raise exception 'Expected checkout compliance_state=unknown when stale/unknown prerequisites exist, got %', coalesce(v_state, '<null>');
  end if;
  if v_gap_state <> 'blocked_stale_or_unknown' then
    raise exception 'Expected blocked_stale_or_unknown evidence gap state for checkout, got %', coalesce(v_gap_state, '<null>');
  end if;
  if not v_has_stale or not v_has_unknown then
    raise exception 'Expected explicit stale and unknown evidence gaps on checkout row';
  end if;

  -- Cross-tenant scoping.
  perform set_config(
    'request.jwt.claims',
    '{"app_metadata":{"role":"admin","tenant":"compliance-monitor-b"}}',
    true
  );

  select count(*) into v_count from public.v_compliance_subject_monitor;
  if v_count <> 1 then
    raise exception 'Expected tenant-b to see only 1 scoped row, found %', v_count;
  end if;

  if not exists (
    select 1
    from public.v_compliance_subject_monitor
    where subject_type = 'asset'
      and subject_ref = 'asset-b-1'
  ) then
    raise exception 'Expected tenant-b scoped asset row not found';
  end if;

  raise notice 'PASS compliance subject monitor scoping + rule-input assembly + missing-data behavior';
end;
$$;

rollback;
