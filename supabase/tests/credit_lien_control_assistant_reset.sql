-- Reset-path assertions for 20260617230000_credit_lien_control_assistant.sql
--
-- Verifies that the migration applied cleanly after a full supabase db reset:
--   1. ops_output_schema_registry contains all three new schema entries
--      (credit_application_proposal_v1, lien_deadline_proposal_v1,
--       lien_waiver_proposal_v1) with the correct required-field sets.
--   2. The three domain tables exist with the expected columns and RLS enabled.
--   3. ops_agent_config for credit-lien-control carries the correct system
--      prompt and the required thresholds.

begin;

do $$
declare
  v_count  int;
  v_prompt text;
  v_thresh jsonb;
begin

  -- ── ops_output_schema_registry: credit_application_proposal_v1 ───────────

  select count(*)
    into v_count
  from public.ops_output_schema_registry
  where schema_key = 'credit_application_proposal_v1';

  if v_count <> 1 then
    raise exception
      'Expected 1 ops_output_schema_registry row for credit_application_proposal_v1, found %',
      v_count;
  end if;

  select count(*)
    into v_count
  from public.ops_output_schema_registry,
       jsonb_array_elements_text(schema_json -> 'required') as req
  where schema_key = 'credit_application_proposal_v1'
    and req in ('application_id', 'risk_level', 'recommended_action', 'rationale');

  if v_count <> 4 then
    raise exception
      'credit_application_proposal_v1 must list application_id, risk_level, recommended_action, rationale as required; found %',
      v_count;
  end if;

  raise notice 'credit_application_proposal_v1 schema checks passed';

  -- ── ops_output_schema_registry: lien_deadline_proposal_v1 ────────────────

  select count(*)
    into v_count
  from public.ops_output_schema_registry
  where schema_key = 'lien_deadline_proposal_v1';

  if v_count <> 1 then
    raise exception
      'Expected 1 ops_output_schema_registry row for lien_deadline_proposal_v1, found %',
      v_count;
  end if;

  select count(*)
    into v_count
  from public.ops_output_schema_registry,
       jsonb_array_elements_text(schema_json -> 'required') as req
  where schema_key = 'lien_deadline_proposal_v1'
    and req in ('obligation_id', 'urgency', 'recommended_action', 'rationale');

  if v_count <> 4 then
    raise exception
      'lien_deadline_proposal_v1 must list obligation_id, urgency, recommended_action, rationale as required; found %',
      v_count;
  end if;

  raise notice 'lien_deadline_proposal_v1 schema checks passed';

  -- ── ops_output_schema_registry: lien_waiver_proposal_v1 ──────────────────

  select count(*)
    into v_count
  from public.ops_output_schema_registry
  where schema_key = 'lien_waiver_proposal_v1';

  if v_count <> 1 then
    raise exception
      'Expected 1 ops_output_schema_registry row for lien_waiver_proposal_v1, found %',
      v_count;
  end if;

  select count(*)
    into v_count
  from public.ops_output_schema_registry,
       jsonb_array_elements_text(schema_json -> 'required') as req
  where schema_key = 'lien_waiver_proposal_v1'
    and req in ('obligation_id', 'waiver_type', 'waiver_status', 'recommended_action', 'rationale');

  if v_count <> 5 then
    raise exception
      'lien_waiver_proposal_v1 must list obligation_id, waiver_type, waiver_status, recommended_action, rationale as required; found %',
      v_count;
  end if;

  raise notice 'lien_waiver_proposal_v1 schema checks passed';

  -- ── credit_application table ──────────────────────────────────────────────

  select count(*)
    into v_count
  from information_schema.tables
  where table_schema = 'public'
    and table_name   = 'credit_application';

  if v_count <> 1 then
    raise exception 'Table public.credit_application must exist after migration, found %', v_count;
  end if;

  -- Required columns: id, tenant_id, customer_name, status, requested_credit_limit
  select count(*)
    into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'credit_application'
    and column_name  in ('id', 'tenant_id', 'customer_name', 'status',
                         'requested_credit_limit', 'current_credit_limit',
                         'requested_terms', 'submitted_at');

  if v_count <> 8 then
    raise exception
      'credit_application must have columns id, tenant_id, customer_name, status, requested_credit_limit, current_credit_limit, requested_terms, submitted_at; found %',
      v_count;
  end if;

  -- RLS must be enabled.
  select count(*)
    into v_count
  from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname     = 'credit_application'
    and pg_class.relrowsecurity;

  if v_count <> 1 then
    raise exception 'Row-level security must be enabled on public.credit_application';
  end if;

  raise notice 'credit_application table checks passed';

  -- ── lien_deadline_obligation table ───────────────────────────────────────

  select count(*)
    into v_count
  from information_schema.tables
  where table_schema = 'public'
    and table_name   = 'lien_deadline_obligation';

  if v_count <> 1 then
    raise exception 'Table public.lien_deadline_obligation must exist after migration, found %', v_count;
  end if;

  select count(*)
    into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'lien_deadline_obligation'
    and column_name  in ('id', 'tenant_id', 'state', 'first_furnishing_date',
                         'notice_sent', 'notice_sent_at');

  if v_count <> 6 then
    raise exception
      'lien_deadline_obligation must have columns id, tenant_id, state, first_furnishing_date, notice_sent, notice_sent_at; found %',
      v_count;
  end if;

  select count(*)
    into v_count
  from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname     = 'lien_deadline_obligation'
    and pg_class.relrowsecurity;

  if v_count <> 1 then
    raise exception 'Row-level security must be enabled on public.lien_deadline_obligation';
  end if;

  raise notice 'lien_deadline_obligation table checks passed';

  -- ── lien_waiver_obligation table ──────────────────────────────────────────

  select count(*)
    into v_count
  from information_schema.tables
  where table_schema = 'public'
    and table_name   = 'lien_waiver_obligation';

  if v_count <> 1 then
    raise exception 'Table public.lien_waiver_obligation must exist after migration, found %', v_count;
  end if;

  select count(*)
    into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'lien_waiver_obligation'
    and column_name  in ('id', 'tenant_id', 'waiver_type', 'waiver_status',
                         'payment_amount', 'payment_date');

  if v_count <> 6 then
    raise exception
      'lien_waiver_obligation must have columns id, tenant_id, waiver_type, waiver_status, payment_amount, payment_date; found %',
      v_count;
  end if;

  select count(*)
    into v_count
  from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname     = 'lien_waiver_obligation'
    and pg_class.relrowsecurity;

  if v_count <> 1 then
    raise exception 'Row-level security must be enabled on public.lien_waiver_obligation';
  end if;

  raise notice 'lien_waiver_obligation table checks passed';

  -- ── ops_agent_config: credit-lien-control ────────────────────────────────
  -- The per-tenant loop is a no-op on a fresh install (no tenants), so the
  -- schema and tables checks above are sufficient to prove the migration
  -- replayed cleanly.  If the demo seed was applied and tenants exist, we
  -- additionally verify the agent config row.

  select count(*)
    into v_count
  from public.ops_agent_config
  where agent_key = 'credit-lien-control';

  if v_count > 0 then
    -- System prompt must reference credit/lien roles.
    select system_prompt
      into v_prompt
    from public.ops_agent_config
    where agent_key = 'credit-lien-control'
    limit 1;

    if v_prompt not ilike '%credit%' or v_prompt not ilike '%lien%' then
      raise exception
        'ops_agent_config system_prompt for credit-lien-control must reference both credit and lien roles; got: %',
        left(v_prompt, 120);
    end if;

    -- Required thresholds must be present.
    select thresholds
      into v_thresh
    from public.ops_agent_config
    where agent_key = 'credit-lien-control'
    limit 1;

    if (v_thresh ->> 'min_confidence_to_surface') is null then
      raise exception
        'ops_agent_config thresholds for credit-lien-control must include min_confidence_to_surface';
    end if;

    if (v_thresh ->> 'max_applications') is null then
      raise exception
        'ops_agent_config thresholds for credit-lien-control must include max_applications';
    end if;

    if (v_thresh ->> 'max_obligations') is null then
      raise exception
        'ops_agent_config thresholds for credit-lien-control must include max_obligations';
    end if;

    raise notice 'ops_agent_config credit-lien-control checks passed';
  else
    raise notice 'No tenants present — ops_agent_config per-tenant loop was a no-op (expected on fresh install)';
  end if;

end;
$$;

rollback;
