-- Project proposal and rate-approval workbench
-- Closes #1812
--
-- Provides the data surfaces for the outside-sales-representative project
-- proposal workbench (operating-model tags: outside-sales-representative:t3,
-- outside-sales-representative:t5).
--
-- Adds:
--   1. v_project_proposal_account_context  — customer profile + rental-history
--      summary for the account context section of the workbench.
--   2. v_project_proposal_pricing_history  — historical daily/weekly/monthly
--      rates per asset category derived from closed rental order lines.
--   3. staff_submit_project_proposal_for_approval — RPC that packages the
--      assembled proposal context into a finding row so the internal rate or
--      exception approval can be routed, reviewed, and decided before anything
--      customer-facing is produced.
--
-- Design constraints:
--   * Assist-only: no customer-facing quote or price commitment is generated
--     by these objects.  The finding row created by the RPC requires a human
--     approver to change its status before any downstream action is taken.
--   * Stale-input surface: both views expose a data_freshness_at timestamp
--     so the UI can warn the rep when account enrichment or pricing evidence
--     has not been refreshed recently.
--   * Tenant isolation: both views use security_invoker = true and filter
--     entity rows through org_scope_closure (same pattern as
--     crm_customer_profile_current).  Entities with org_scope_id set are
--     visible only when the caller's org_scope_closure includes that scope;
--     entities with org_scope_id IS NULL remain universally visible to all
--     authenticated users.  The RPC enforces write-path tenant isolation via
--     ops_claim_tenant_key() and ops_tenant_match().

-- -------------------------------------------------------------------------
-- 1. v_project_proposal_account_context
--    Customer profiles with rental-order history count and freshness.
-- -------------------------------------------------------------------------
create or replace view public.v_project_proposal_account_context
with (security_invoker = true) as
with customer_orders as (
  select
    public.parse_uuid_or_null(ov.data ->> 'customer_id') as customer_id,
    count(*)                                              as order_count,
    max(e.created_at)                                     as last_order_at
  from public.entities e
  join public.entity_versions ov
    on ov.entity_id = e.id
   and ov.is_current
  where e.entity_type = 'rental_order'
    and public.parse_uuid_or_null(ov.data ->> 'customer_id') is not null
    and (
      e.org_scope_id is null
      or exists (
        select 1 from public.org_scope_closure osc
        where osc.descendant_id = e.org_scope_id
      )
    )
  group by public.parse_uuid_or_null(ov.data ->> 'customer_id')
)
select
  c.entity_id,
  c.source_record_id,
  c.name,
  c.customer_type,
  c.tier,
  c.industry,
  c.balance,
  c.credit_limit,
  c.avg_days_to_pay,
  c.payment_issue_flag,
  c.primary_contact_name,
  c.primary_contact_email,
  c.preferences,
  coalesce(co.order_count, 0)   as rental_order_count,
  co.last_order_at,
  -- Data freshness: use the later of the entity-version timestamp (valid_from
  -- is a real timestamptz column, no string parsing needed) and the last order
  -- date so the UI can surface staleness for inactive accounts.
  greatest(c.valid_from, co.last_order_at) as data_freshness_at
from public.crm_customer_profile_current c
left join customer_orders co on co.customer_id = c.entity_id;

grant select on public.v_project_proposal_account_context to authenticated;

-- -------------------------------------------------------------------------
-- 2. v_project_proposal_pricing_history
--    Historical rates per asset category from closed/active rental lines.
-- -------------------------------------------------------------------------
create or replace view public.v_project_proposal_pricing_history
with (security_invoker = true) as
with line_rates as (
  select
    public.parse_uuid_or_null(l.data ->> 'category_id')    as category_id,
    lower(coalesce(nullif(l.data ->> 'rate_type', ''), 'daily')) as rate_type,
    public.parse_numeric_or_null(l.data ->> 'daily_rate')   as rate_amount,
    l.data ->> 'status'                                     as line_status,
    e.created_at                                            as line_created_at
  from public.entities e
  join public.entity_versions l
    on l.entity_id = e.id
   and l.is_current
  where e.entity_type = 'rental_order_line'
    and public.parse_numeric_or_null(l.data ->> 'daily_rate') > 0
    and (
      e.org_scope_id is null
      or exists (
        select 1 from public.org_scope_closure osc
        where osc.descendant_id = e.org_scope_id
      )
    )
),
category_names as (
  select
    e.id           as category_id,
    coalesce(ev.data ->> 'name', e.source_record_id) as category_name
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current
  where e.entity_type = 'asset_category'
)
select
  lr.category_id,
  cn.category_name,
  lr.rate_type,
  round(min(lr.rate_amount), 2)  as min_rate,
  round(max(lr.rate_amount), 2)  as max_rate,
  round(avg(lr.rate_amount), 2)  as avg_rate,
  count(*)                       as sample_count,
  max(lr.line_created_at)        as last_seen_at,
  -- Flag as stale when no rate evidence exists within 90 days
  case when max(lr.line_created_at) < now() - interval '90 days'
         or max(lr.line_created_at) is null
       then true else false end  as is_stale
from line_rates lr
left join category_names cn on cn.category_id = lr.category_id
where lr.category_id is not null
group by lr.category_id, cn.category_name, lr.rate_type;

grant select on public.v_project_proposal_pricing_history to authenticated;

-- -------------------------------------------------------------------------
-- 3. staff_submit_project_proposal_for_approval
--    Creates a finding row representing the rate/exception approval case.
--    The rep calls this from the workbench UI after reviewing assembled
--    context.  The resulting finding is reviewed at /ops/findings/{id}.
--    Nothing customer-facing is created or sent by this function.
-- -------------------------------------------------------------------------
create or replace function public.staff_submit_project_proposal_for_approval(
  p_customer_id     text    default null,
  p_customer_name   text    default null,
  p_branch_id       text    default null,
  p_branch_name     text    default null,
  p_term_days       int     default 30,
  p_categories      jsonb   default '[]'::jsonb,
  p_proposed_rates  jsonb   default '{}'::jsonb,
  p_notes           text    default null
)
returns table (
  finding_id   uuid,
  fingerprint  text,
  status       text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_app_role    text;
  v_tenant_id   uuid;
  v_finding_id  uuid;
  v_fingerprint text;
  v_evidence    jsonb;
begin
  -- ── Role guard ─────────────────────────────────────────────────────────────
  -- Note: 'outside-sales-representative' is an operating-model tag (t3, t5),
  -- not an app role.  App roles are admin, branch_manager, field_operator, and
  -- read_only (ADR-0023).  Write RPCs follow the same pattern as
  -- staff_save_quote_order and gate on admin / branch_manager.
  v_app_role := public.ops_claim_app_role();
  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'staff_submit_project_proposal_for_approval: access denied'
      using errcode = '42501';
  end if;

  -- ── Tenant ──────────────────────────────────────────────────────────────────
  -- Resolve the caller's tenant UUID from the tenant-key claim.  get_my_tenant()
  -- returns a TEXT key (e.g. 'acme'), not a UUID, so we do a direct lookup.
  select id into v_tenant_id
  from public.tenants
  where tenant_key = public.ops_claim_tenant_key();

  if v_tenant_id is null then
    raise exception 'staff_submit_project_proposal_for_approval: tenant not resolved'
      using errcode = '22023';
  end if;

  -- ── Fingerprint ─────────────────────────────────────────────────────────────
  -- Deduplicate same-customer same-day submissions.
  v_fingerprint := 'project-proposal:'
    || coalesce(p_customer_id, 'no-customer')
    || ':'
    || coalesce(p_branch_id, 'no-branch')
    || ':'
    || to_char(current_date, 'YYYY-MM-DD');

  -- ── Evidence payload ────────────────────────────────────────────────────────
  v_evidence := jsonb_build_object(
    'customer_id',   p_customer_id,
    'customer_name', p_customer_name,
    'branch_id',     p_branch_id,
    'branch_name',   p_branch_name,
    'term_days',     p_term_days,
    'categories',    p_categories,
    'proposed_rates', p_proposed_rates,
    'notes',         p_notes,
    'submitted_at',  now(),
    'operating_model_tags', jsonb_build_array(
      'outside-sales-representative:t3',
      'outside-sales-representative:t5'
    )
  );

  -- ── Upsert finding (on fingerprint conflict update evidence + timestamp) ────
  insert into public.finding (
    tenant_id,
    agent_key,
    finding_type,
    severity,
    status,
    evidence,
    proposed_action,
    rationale,
    fingerprint
  ) values (
    v_tenant_id,
    'project-proposal-workbench',
    'project_rate_approval',
    'medium',
    'pending_approval',
    v_evidence,
    'Review proposed project rental rates and approve or adjust before preparing customer-facing materials.',
    coalesce(p_notes, 'Project proposal submitted for internal rate review by outside sales representative.'),
    v_fingerprint
  )
  on conflict (tenant_id, fingerprint) do update
    set evidence      = excluded.evidence,
        rationale     = excluded.rationale,
        status        = 'pending_approval',
        decided_at    = null,
        approver      = null
  returning id into v_finding_id;

  return query select v_finding_id, v_fingerprint, 'pending_approval'::text;
end;
$$;

revoke all on function public.staff_submit_project_proposal_for_approval from public, anon;
grant execute on function public.staff_submit_project_proposal_for_approval to authenticated;

-- -------------------------------------------------------------------------
-- 4. Register output schema so the findings view renders proposal context
-- -------------------------------------------------------------------------
insert into public.ops_output_schema_registry (schema_key, schema_json, description)
values (
  'project_proposal_v1',
  '{
    "type": "object",
    "required": ["customer_id", "term_days", "categories"],
    "properties": {
      "customer_id":    { "type": "string" },
      "customer_name":  { "type": "string" },
      "branch_id":      { "type": "string" },
      "branch_name":    { "type": "string" },
      "term_days":      { "type": "integer" },
      "categories":     { "type": "array" },
      "proposed_rates": { "type": "object" },
      "notes":          { "type": "string" },
      "operating_model_tags": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  }'::jsonb,
  'Project proposal and rate-approval workbench output schema v1 (outside-sales-representative:t3, outside-sales-representative:t5)'
)
on conflict (schema_key) do update
  set schema_json = excluded.schema_json,
      description = excluded.description,
      updated_at  = now();