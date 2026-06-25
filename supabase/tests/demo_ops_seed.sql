begin;

do $$
declare
  v_contract_count int;
  v_rate_card_count int;
  v_finding_count int;
  v_pending_count int;
  v_approved_count int;
  v_rejected_count int;
  v_recoverable numeric;
  v_clean_flagged int;
  v_workflow_runs int;
  v_cfg_count int;
  v_fleet_cfg_count int;
  v_tenant_b_threshold numeric;
  v_tenant_a_threshold numeric;
  v_tenant_scoped_contracts int;
  v_tenant_b_contracts int;
  v_fleet_findings int;
  v_fleet_demand_links int;
  v_fleet_demand_points int;
  v_approved_finding_id uuid;
  v_approved_contract_id uuid;
  v_draft_count int;
  v_audit_points int;
  v_credit_cfg_count int;
  v_credit_run_count int;
  v_credit_finding_count int;
  v_credit_pending_count int;
  v_credit_approved_count int;
  v_credit_rejected_count int;
  v_credit_proposal_count int;
  v_agent_status_identified_delta numeric;
  v_agent_status_pending_count int;
  v_agent_status_has_pending_badge boolean;
  v_tenant_b_identified_delta numeric;
  v_pending_placeholder_count constant int := 500;
  v_planted_finding_count constant int := 5;
  v_seeded_pending_count constant int := 3;
begin
  select count(*) into v_contract_count
  from entities
  where entity_type = 'rental_contract'
    and source_record_id like 'demo-ops-rental-contract-%';

  if v_contract_count <> 8 then
    raise exception 'Expected 8 demo ops contracts, found %', v_contract_count;
  end if;

  select count(*) into v_rate_card_count
  from entities
  where entity_type = 'rate_card'
    and source_record_id like 'demo-ops-rate-card-%';

  if v_rate_card_count <> 8 then
    raise exception 'Expected 8 demo ops rate cards, found %', v_rate_card_count;
  end if;

  select
    count(*),
    count(*) filter (where status = 'pending_approval'),
    count(*) filter (where status = 'approved'),
    count(*) filter (where status = 'rejected'),
    coalesce(sum(delta), 0)
  into
    v_finding_count,
    v_pending_count,
    v_approved_count,
    v_rejected_count,
    v_recoverable
  from finding
  where fingerprint like 'demo-ops-%'
    and agent_key = 'revrec-analyst';

  if v_finding_count < (v_planted_finding_count + v_pending_placeholder_count) then
    raise exception
      'Expected seeded demo ops findings (including pending placeholders) >= %, found %',
      (v_planted_finding_count + v_pending_placeholder_count),
      v_finding_count;
  end if;

  if v_pending_count < (v_seeded_pending_count + v_pending_placeholder_count) or v_approved_count <> 1 or v_rejected_count <> 1 then
    raise exception
      'Expected mixed states with stable pending queue (pending>=% approved=1 rejected=1), got pending=% approved=% rejected=%',
      (v_seeded_pending_count + v_pending_placeholder_count),
      v_pending_count, v_approved_count, v_rejected_count;
  end if;

  if v_recoverable <> 4420 then
    raise exception 'Expected recoverable delta of 4420, got %', v_recoverable;
  end if;

  select
    s.identified_delta,
    s.pending_findings,
    s.has_pending_badge
  into
    v_agent_status_identified_delta,
    v_agent_status_pending_count,
    v_agent_status_has_pending_badge
  from ops_agent_status_view s
  join tenants t on t.id = s.tenant_id
  where t.tenant_key = 'demo-ops-a'
    and s.agent_key = 'revrec-analyst';

  if v_agent_status_identified_delta <> 4420 then
    raise exception
      'Expected ops_agent_status_view identified_delta=4420 for demo-ops-a/revrec-analyst, got %',
      v_agent_status_identified_delta;
  end if;

  if v_agent_status_pending_count < (v_seeded_pending_count + v_pending_placeholder_count)
     or v_agent_status_has_pending_badge is not true then
    raise exception
      'Expected ops_agent_status_view pending queue depth >= % with pending badge true, got pending=% badge=%',
      (v_seeded_pending_count + v_pending_placeholder_count),
      v_agent_status_pending_count,
      v_agent_status_has_pending_badge;
  end if;

  select s.identified_delta
    into v_tenant_b_identified_delta
  from ops_agent_status_view s
  join tenants t on t.id = s.tenant_id
  where t.tenant_key = 'demo-ops-b'
    and s.agent_key = 'revrec-analyst';

  if v_tenant_b_identified_delta <> 0 then
    raise exception
      'Expected tenant-isolated identified_delta=0 for demo-ops-b/revrec-analyst, got %',
      v_tenant_b_identified_delta;
  end if;

  if exists (
    select 1
    from finding f
    where f.fingerprint like 'demo-ops-%'
      and f.agent_key = 'revrec-analyst'
      and (
        (f.finding_type = 'unbilled_on_rent' and f.delta <> 1200) or
        (f.finding_type = 'billing_past_return' and f.delta <> 1200) or
        (f.finding_type = 'rate_tier_mismatch' and f.delta <> 480) or
        (f.finding_type = 'missed_escalation' and f.delta <> 640) or
        (f.finding_type = 'over_billed' and f.delta <> 900)
      )
  ) then
    raise exception 'One or more seeded findings do not match the required planted deltas';
  end if;

  if exists (
    select 1
    from (
      select finding_type, count(*) as c
      from finding
      where fingerprint like 'demo-ops-%'
        and agent_key = 'revrec-analyst'
        and finding_type in ('unbilled_on_rent', 'billing_past_return', 'rate_tier_mismatch', 'missed_escalation', 'over_billed')
      group by finding_type
    ) planted
    where planted.c <> 1
  )
  or (
    select count(distinct finding_type)
    from finding
    where fingerprint like 'demo-ops-%'
      and agent_key = 'revrec-analyst'
      and finding_type in ('unbilled_on_rent', 'billing_past_return', 'rate_tier_mismatch', 'missed_escalation', 'over_billed')
  ) <> 5 then
    raise exception 'Expected each of the 5 planted finding types to be present exactly once';
  end if;

  select count(*) into v_clean_flagged
  from finding f
  join entities c
    on c.id = f.contract_id
  join entity_versions ev
    on ev.entity_id = c.id
   and ev.is_current
  where f.fingerprint like 'demo-ops-%'
    and f.agent_key = 'revrec-analyst'
    and ev.data ->> 'contract_number' in ('C-DEMO-106', 'C-DEMO-107', 'C-DEMO-108');

  if v_clean_flagged <> 0 then
    raise exception 'Expected clean contracts C-DEMO-106/107/108 to have zero findings, found %', v_clean_flagged;
  end if;

  select count(*) into v_workflow_runs
  from ops_workflow_run
  where run_id like 'demo-ops-%';

  if v_workflow_runs <> 4 then
    raise exception 'Expected 4 seeded ops workflow runs (2 revrec + 2 fleet, one of each per tenant), found %', v_workflow_runs;
  end if;

  select count(*) into v_cfg_count
  from ops_agent_config_current cfg
  join tenants t on t.id = cfg.tenant_id
  where cfg.agent_key = 'revrec-analyst'
    and t.tenant_key in ('demo-ops-a', 'demo-ops-b');

  if v_cfg_count <> 2 then
    raise exception 'Expected revrec-analyst config for both demo tenants, found %', v_cfg_count;
  end if;

  select count(*) into v_fleet_cfg_count
  from ops_agent_config cfg
  join tenants t on t.id = cfg.tenant_id
  where cfg.agent_key = 'fleet-auditor'
    and t.tenant_key in ('demo-ops-a', 'demo-ops-b');

  if v_fleet_cfg_count <> 2 then
    raise exception 'Expected fleet-auditor config for both demo tenants, found %', v_fleet_cfg_count;
  end if;

  select (cfg.thresholds ->> 'rate_mismatch_min_delta')::numeric
    into v_tenant_a_threshold
  from ops_agent_config_current cfg
  join tenants t on t.id = cfg.tenant_id
  where cfg.agent_key = 'revrec-analyst'
    and t.tenant_key = 'demo-ops-a';

  select (cfg.thresholds ->> 'rate_mismatch_min_delta')::numeric
    into v_tenant_b_threshold
  from ops_agent_config_current cfg
  join tenants t on t.id = cfg.tenant_id
  where cfg.agent_key = 'revrec-analyst'
    and t.tenant_key = 'demo-ops-b';

  if not exists (
    select 1
    from ops_output_schema_registry
    where schema_key = 'revrec_finding_v1'
  ) then
    raise exception 'Expected output schema key revrec_finding_v1 to be registered';
  end if;

  if not exists (
    select 1
    from ops_output_schema_registry
    where schema_key = 'credit_proposal_v1'
  ) then
    raise exception 'Expected output schema key credit_proposal_v1 to be registered';
  end if;

  if v_tenant_b_threshold >= v_tenant_a_threshold then
    raise exception
      'Expected tenant B mismatch threshold < tenant A threshold, got B=% A=%',
      v_tenant_b_threshold, v_tenant_a_threshold;
  end if;

  select count(*) into v_tenant_scoped_contracts
  from entities c
  join entity_versions ev
    on ev.entity_id = c.id
   and ev.is_current
  where c.entity_type = 'rental_contract'
    and c.source_record_id like 'demo-ops-rental-contract-%'
    and ev.data ? 'tenant_key';

  if v_tenant_scoped_contracts <> 8 then
    raise exception 'Expected all 8 demo ops contracts to include tenant_key, found %', v_tenant_scoped_contracts;
  end if;

  select count(*) into v_tenant_b_contracts
  from entities c
  join entity_versions ev
    on ev.entity_id = c.id
   and ev.is_current
  where c.entity_type = 'rental_contract'
    and c.source_record_id like 'demo-ops-rental-contract-%'
    and ev.data ->> 'tenant_key' = 'demo-ops-b';

  if v_tenant_b_contracts <> 3 then
    raise exception 'Expected 3 clean demo ops contracts scoped to tenant B, found %', v_tenant_b_contracts;
  end if;

  select count(*) into v_fleet_findings
  from finding f
  where f.agent_key = 'fleet-auditor'
    and f.fingerprint = 'demo-ops-fleet-idle-transfer-001'
    and f.finding_type = 'idle_under_utilized'
    and f.status = 'pending_approval';

  if v_fleet_findings <> 1 then
    raise exception 'Expected one seeded fleet idle transfer finding, found %', v_fleet_findings;
  end if;

  select count(*) into v_fleet_demand_links
  from entities demand_order
  join entities demand_line
    on demand_line.entity_type = 'rental_order_line'
   and demand_line.source_record_id = 'demo-ops-rental-order-line-demand-001'
  join entity_versions demand_line_ev
    on demand_line_ev.entity_id = demand_line.id
   and demand_line_ev.is_current
  join entity_versions demand_order_ev
    on demand_order_ev.entity_id = demand_order.id
   and demand_order_ev.is_current
  where demand_order.entity_type = 'rental_order'
    and demand_order.source_record_id = 'demo-ops-rental-order-demand-001'
    and demand_line_ev.data ->> 'order_id' = demand_order.id::text
    and demand_line_ev.data ->> 'tenant_key' = 'demo-ops-a'
    and demand_order_ev.data ->> 'branch_id' = (
      select f.expected ->> 'target_branch_id'
      from finding f
      where f.fingerprint = 'demo-ops-fleet-idle-transfer-001'
      limit 1
    )
    and demand_order_ev.data ->> 'branch_id' <> (
      select f.expected ->> 'home_branch_id'
      from finding f
      where f.fingerprint = 'demo-ops-fleet-idle-transfer-001'
      limit 1
    )
    and coalesce(demand_line_ev.data ->> 'category_id', '') <> ''
    and coalesce((demand_line_ev.data ->> 'requested_quantity')::int, 0) = 3;

  if v_fleet_demand_links <> 1 then
    raise exception 'Expected tenant-scoped fleet demand line linked to demand order, found %', v_fleet_demand_links;
  end if;

  select count(*) into v_fleet_demand_points
  from time_series_points tsp
  where tsp.source_id in ('demo-ops-fleet-idle-001', 'demo-ops-fleet-demand-001');

  if v_fleet_demand_points <> 2 then
    raise exception 'Expected two fleet scenario time-series points (idle + demand), found %', v_fleet_demand_points;
  end if;

  select f.id, f.contract_id
    into v_approved_finding_id, v_approved_contract_id
  from finding f
  where f.fingerprint = 'demo-ops-missed-escalation';

  if v_approved_finding_id is null then
    raise exception 'Expected approved missed_escalation finding to be seeded';
  end if;

  select count(*) into v_draft_count
  from invoice_adjustment_draft d
  where d.finding_id = v_approved_finding_id
    and d.amount = 640;

  if v_draft_count <> 1 then
    raise exception 'Expected one drafted adjustment for approved finding, found %', v_draft_count;
  end if;

  select count(*) into v_audit_points
  from time_series_points tsp
  where tsp.entity_id = v_approved_contract_id
    and tsp.source_id like 'demo-ops-audit-%';

  if v_audit_points < 3 then
    raise exception 'Expected >= 3 audit trail points for approved finding contract, found %', v_audit_points;
  end if;

  select count(*) into v_credit_cfg_count
  from ops_agent_config cfg
  join tenants t on t.id = cfg.tenant_id
  where cfg.agent_key = 'credit-analyst'
    and t.tenant_key in ('demo-ops-a', 'demo-ops-b');

  if v_credit_cfg_count <> 2 then
    raise exception 'Expected credit-analyst config for both demo tenants, found %', v_credit_cfg_count;
  end if;

  select count(*) into v_credit_run_count
  from ops_workflow_run
  where run_id like 'demo-credit-%';

  if v_credit_run_count <> 2 then
    raise exception 'Expected 2 seeded credit workflow runs, found %', v_credit_run_count;
  end if;

  select
    count(*),
    count(*) filter (where status = 'pending_approval'),
    count(*) filter (where status = 'approved'),
    count(*) filter (where status = 'rejected')
  into
    v_credit_finding_count,
    v_credit_pending_count,
    v_credit_approved_count,
    v_credit_rejected_count
  from finding
  where run_id like 'demo-credit-%'
    and agent_key = 'credit-analyst'
    and finding_type = 'collections_priority';

  if v_credit_finding_count <> 3
     or v_credit_pending_count <> 1
     or v_credit_approved_count <> 1
     or v_credit_rejected_count <> 1 then
    raise exception
      'Expected seeded collections-priority findings pending=1 approved=1 rejected=1 (total=3), got pending=% approved=% rejected=% total=%',
      v_credit_pending_count, v_credit_approved_count, v_credit_rejected_count, v_credit_finding_count;
  end if;

  select count(*) into v_credit_proposal_count
  from credit_change_proposal
  where payload ->> 'seed_namespace' = 'demo-credit';

  if v_credit_proposal_count <> 1 then
    raise exception 'Expected 1 seeded credit_change_proposal row for demo-credit namespace, found %', v_credit_proposal_count;
  end if;
end
$$;

rollback;
