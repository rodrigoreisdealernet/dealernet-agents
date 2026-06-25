-- Shop morning-queue: least-privilege access for pm_work_orders
-- Created: 2026-06-14
-- Purpose: Enable RLS on pm_work_orders and wire the grant/policy chain needed
--          for v_shop_morning_queue_scope (security_invoker = true) to work.
--          Without this, authenticated callers cannot read the pm_due branch of
--          that view.
--
-- v_shop_morning_queue_scope is granted to service_role only (see
-- 20260614200000_shop_morning_queue.sql). The Temporal workflow worker accesses it
-- via service_role and applies its own tenant_id filter. The frontend reads
-- ops_findings_view; there is no authenticated direct-read path for this view.
--
-- Entity-backed branches (work_order_priority / parts_blocker / not_available_unit)
-- read public.entities, public.entity_versions, and public.relationships_v2, which
-- carry broad authenticated read policies (USING (true)) from
-- 20260606114000_enable_rls_rental_tables.sql. Those tables are not exposed to
-- authenticated users through this view (no authenticated grant on the view).
-- tenant_id is surfaced from ev.data->>'tenant_id' for application-level
-- filtering by the Temporal workflow.
--
-- Issue: #1701 (follow-up to database steward review)

-- ---------------------------------------------------------------------------
-- 1. pm_work_orders: RLS + least-privilege grants
-- ---------------------------------------------------------------------------

alter table public.pm_work_orders enable row level security;

-- authenticated: SELECT only. Writes remain a service-role (Temporal worker) path.
revoke all on table public.pm_work_orders from anon, authenticated;
grant select on table public.pm_work_orders to authenticated;
grant select, insert, update, delete on table public.pm_work_orders to service_role;

-- Tenant-scoped read: authenticated may only see work orders for their own tenant.
-- pm_work_orders.tenant_id is a text key that matches the tenant key embedded in
-- the JWT via ops_claim_tenant_key().
drop policy if exists pm_work_orders_authenticated_read on public.pm_work_orders;
create policy pm_work_orders_authenticated_read
  on public.pm_work_orders
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator', 'read_only')
    and tenant_id = public.ops_claim_tenant_key()
  );

-- service_role: unrestricted access for the Temporal workflow writer.
drop policy if exists pm_work_orders_service_role_all on public.pm_work_orders;
create policy pm_work_orders_service_role_all
  on public.pm_work_orders
  for all
  to service_role
  using (true)
  with check (true);

-- anon: no access.
drop policy if exists pm_work_orders_anon_deny on public.pm_work_orders;
create policy pm_work_orders_anon_deny
  on public.pm_work_orders
  for select
  to anon
  using (false);
