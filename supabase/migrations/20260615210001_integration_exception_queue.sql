-- Integration and master-data exception queue scope view
-- Created: 2026-06-15
-- Purpose: Unified view that surfaces portal-integration failures, logistics/mobile
--          integration failures, and stale master-data records so the integration
--          exception queue workflow can scope candidates in a single PostgREST query.
-- Issue: #1741

-- ---------------------------------------------------------------------------
-- View: v_integration_exception_queue_scope
-- ---------------------------------------------------------------------------
-- Unions three candidate sets:
--   1. portal_exception      — integration delivery failures for connectors
--                              identified as customer-portal integrations (t5)
--   2. logistics_exception   — delivery failures for logistics/mobile connectors
--                              and Descartes sync failures (t6)
--   3. master_data_drift     — entities in master-data types (asset, customer,
--                              billing_account, branch, category) with no
--                              recent update (t7)
--
-- The 'context' column carries exception-specific JSON so callers can pass it
-- directly to the AI assessment step without additional round-trips.
-- Duplicate signals (same connector_key + scope) are pre-collapsed by the
-- view; only the most-recent representative row is retained.
-- ---------------------------------------------------------------------------

create or replace view public.v_integration_exception_queue_scope
with (security_invoker = true)
as
-- 1. Customer-portal integration delivery failures (t5)
select
    'portal_exception'::text                   as exception_type,
    dl.id                                      as exception_source_id,
    dl.tenant_id::text                         as tenant_id,
    dl.connector_key                           as source_connector,
    dl.scope_key                               as scope_key,
    dl.updated_at                              as last_updated_at,
    jsonb_build_object(
        'delivery_id',      dl.id,
        'connector_key',    dl.connector_key,
        'exchange_key',     dl.exchange_key,
        'direction',        dl.direction,
        'scope_key',        dl.scope_key,
        'entity_type',      dl.entity_type,
        'entity_id',        dl.entity_id,
        'workflow_id',      dl.workflow_id,
        'status',           dl.status,
        'attempt_count',    dl.attempt_count,
        'http_status',      dl.http_status,
        'error_message',    dl.error_message,
        'last_error',       dl.last_error,
        'received_at',      dl.received_at
    )                                          as context
from public.integration_delivery_log dl
where dl.status in ('retryable_failure', 'non_retryable_failure', 'failed', 'error', 'quarantined', 'replay_queued')
  and (
    dl.connector_key ilike '%portal%'
    or dl.connector_key ilike '%customer_portal%'
    or dl.connector_key ilike '%selfservice%'
    or dl.connector_key ilike '%self_service%'
  )

union all

-- 2a. Logistics / mobile integration delivery failures (t6)
select
    'logistics_exception'::text                as exception_type,
    dl.id                                      as exception_source_id,
    dl.tenant_id::text                         as tenant_id,
    dl.connector_key                           as source_connector,
    dl.scope_key                               as scope_key,
    dl.updated_at                              as last_updated_at,
    jsonb_build_object(
        'delivery_id',      dl.id,
        'connector_key',    dl.connector_key,
        'exchange_key',     dl.exchange_key,
        'direction',        dl.direction,
        'scope_key',        dl.scope_key,
        'entity_type',      dl.entity_type,
        'entity_id',        dl.entity_id,
        'workflow_id',      dl.workflow_id,
        'status',           dl.status,
        'attempt_count',    dl.attempt_count,
        'http_status',      dl.http_status,
        'error_message',    dl.error_message,
        'last_error',       dl.last_error,
        'received_at',      dl.received_at
    )                                          as context
from public.integration_delivery_log dl
where dl.status in ('retryable_failure', 'non_retryable_failure', 'failed', 'error', 'quarantined', 'replay_queued')
  and (
    dl.connector_key ilike '%descartes%'
    or dl.connector_key ilike '%logistics%'
    or dl.connector_key ilike '%mobile%'
    or dl.connector_key ilike '%dispatch%'
    or dl.connector_key ilike '%samsara%'
    or dl.connector_key ilike '%telematics%'
    or dl.connector_key ilike '%transport%'
    or dl.connector_key ilike '%field%'
  )

union all

-- 2b. Descartes sync delivery failures (t6)
select
    'logistics_exception'::text                as exception_type,
    dsd.id                                     as exception_source_id,
    dsd.tenant_id::text                        as tenant_id,
    dsd.provider_key                           as source_connector,
    dsd.scope                                  as scope_key,
    dsd.updated_at                             as last_updated_at,
    jsonb_build_object(
        'descartes_delivery_id', dsd.id,
        'provider_key',          dsd.provider_key,
        'scope',                 dsd.scope,
        'contract_line_id',      dsd.contract_line_id,
        'route_id',              dsd.route_id,
        'source_event_id',       dsd.source_event_id,
        'sync_status',           dsd.sync_status,
        'retry_count',           dsd.retry_count,
        'is_retryable',          dsd.is_retryable,
        'error_code',            dsd.error_code,
        'error_message',         dsd.error_message,
        'quarantine_reason',     dsd.quarantine_reason,
        'occurred_at',           dsd.occurred_at
    )                                          as context
from public.descartes_sync_delivery dsd
where dsd.sync_status in ('retryable_failure', 'non_retryable_failure', 'quarantined', 'replay_queued')

union all

-- 3. Stale master-data drift: entities not updated in 30 days (t7)
select
    'master_data_drift'::text                  as exception_type,
    e.id                                       as exception_source_id,
    (ev.data ->> 'tenant_id')::text            as tenant_id,
    'master_data'::text                        as source_connector,
    e.entity_type                              as scope_key,
    e.updated_at                               as last_updated_at,
    jsonb_build_object(
        'entity_id',      e.id,
        'entity_type',    e.entity_type,
        'name',           ev.data ->> 'name',
        'updated_at',     e.updated_at,
        'days_stale',     extract(day from (now() - e.updated_at))::int,
        'tenant_id',      ev.data ->> 'tenant_id'
    )                                          as context
from public.entities e
join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
where e.entity_type in ('asset', 'customer', 'billing_account', 'branch', 'category')
  -- NOTE: this 30-day threshold mirrors _MASTER_DATA_STALE_DAYS in
  -- temporal/src/activities/ops_integration_exception.py.
  -- If the threshold is changed in the Python constant, update it here too.
  and e.updated_at < now() - interval '30 days';

-- This view is consumed exclusively by the Temporal worker (service_role).
-- The master_data_drift branch reads entities/entity_versions; those tables
-- do not yet have a complete JWT-tenant-claim RLS chain for authenticated
-- users (#120).  Grant is restricted to service_role until #120 lands.
grant select on public.v_integration_exception_queue_scope to service_role;
