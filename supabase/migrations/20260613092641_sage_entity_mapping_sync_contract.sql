-- Sage entity mapping and synchronization contract.
-- Defines supported Sage accounting entity directions, conflict handling,
-- reconciliation expectations, and replay-safe external identifier guards.

create or replace function public.sage_supported_entity_contract()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'entities',
    jsonb_build_array(
      jsonb_build_object(
        'entity_type', 'general_ledger',
        'direction', 'outbound',
        'conflict_rule', 'wynne_wins_with_stable_external_id',
        'reconciliation_behavior', 'line_totals_must_balance_before_post'
      ),
      jsonb_build_object(
        'entity_type', 'accounts_payable',
        'direction', 'inbound',
        'conflict_rule', 'provider_wins_by_cursor_then_external_id',
        'reconciliation_behavior', 'replay_updates_existing_scope_state_only'
      ),
      jsonb_build_object(
        'entity_type', 'accounts_receivable',
        'direction', 'inbound',
        'conflict_rule', 'provider_wins_by_cursor_then_external_id',
        'reconciliation_behavior', 'replay_updates_existing_scope_state_only'
      ),
      jsonb_build_object(
        'entity_type', 'invoice',
        'direction', 'outbound',
        'conflict_rule', 'wynne_wins_with_stable_external_id',
        'reconciliation_behavior', 'posting_state_must_not_regress_on_replay'
      )
    ),
    'required_external_identifier_fields',
    jsonb_build_array('idempotency_key', 'external_id', 'entity_type', 'entity_id', 'posting_state')
  );
$$;

create or replace view public.v_sage_entity_mapping_contract
with (security_invoker = true)
as
select
  c.id as integration_id,
  c.tenant_id,
  c.display_name,
  c.enabled,
  public.sage_supported_entity_contract() -> 'entities' as supported_entities,
  coalesce(c.mappings, '{}'::jsonb) as configured_field_mappings,
  public.sage_supported_entity_contract() -> 'required_external_identifier_fields'
    as required_external_identifier_fields
from public.integration_config c
where c.connector_key = 'sage';

revoke all on public.v_sage_entity_mapping_contract from anon, authenticated;
grant select on public.v_sage_entity_mapping_contract to authenticated;
grant select on public.v_sage_entity_mapping_contract to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'integration_delivery_log_sage_external_identifier_chk'
      and conrelid = 'public.integration_delivery_log'::regclass
  ) then
    alter table public.integration_delivery_log
      add constraint integration_delivery_log_sage_external_identifier_chk
      check (
        connector_key <> 'sage'
        or (
          nullif(btrim(coalesce(idempotency_key, '')), '') is not null
          and nullif(btrim(coalesce(request_payload ->> 'external_id', '')), '') is not null
          and nullif(btrim(coalesce(request_payload ->> 'entity_type', '')), '') is not null
          and nullif(btrim(coalesce(request_payload ->> 'entity_id', '')), '') is not null
          and nullif(btrim(coalesce(request_payload ->> 'posting_state', '')), '') is not null
        )
      )
      not valid;
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from public.integration_delivery_log l
    where l.connector_key = 'sage'
      and (
        nullif(btrim(coalesce(l.idempotency_key, '')), '') is null
        or nullif(btrim(coalesce(l.request_payload ->> 'external_id', '')), '') is null
        or nullif(btrim(coalesce(l.request_payload ->> 'entity_type', '')), '') is null
        or nullif(btrim(coalesce(l.request_payload ->> 'entity_id', '')), '') is null
        or nullif(btrim(coalesce(l.request_payload ->> 'posting_state', '')), '') is null
      )
  ) then
    raise notice 'integration_delivery_log_sage_external_identifier_chk left NOT VALID: backfill invalid sage delivery rows, then run ALTER TABLE public.integration_delivery_log VALIDATE CONSTRAINT integration_delivery_log_sage_external_identifier_chk;';
  else
    alter table public.integration_delivery_log
      validate constraint integration_delivery_log_sage_external_identifier_chk;
  end if;
end;
$$;

create or replace function public.external_id_map_sage_external_id_guard()
returns trigger
language plpgsql
as $$
begin
  if coalesce(new.connector_key, '') = 'sage' then
    if nullif(btrim(coalesce(new.external_id, '')), '') is null then
      raise exception 'sage external_id must be present';
    end if;

    if tg_op = 'UPDATE'
       and coalesce(old.connector_key, '') = 'sage'
       and new.external_id is distinct from old.external_id then
      raise exception 'sage external_id is immutable once mapped';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_external_id_map_sage_external_id_guard on public.external_id_map;

create trigger trg_external_id_map_sage_external_id_guard
  before insert or update on public.external_id_map
  for each row
  execute function public.external_id_map_sage_external_id_guard();
