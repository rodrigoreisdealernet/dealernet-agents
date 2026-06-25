-- Ensure the per-asset analytics dependency chain keeps caller-RLS semantics.
--
-- Context:
--   v_asset_analytics_current reads from rental_current_assets; this migration
--   reapplies security_invoker on that path so callers can only see rows
--   authorized by base-table RLS policies.

alter view if exists public.rental_current_entity_state set (security_invoker = true);
alter view if exists public.rental_current_branches set (security_invoker = true);
alter view if exists public.rental_current_asset_categories set (security_invoker = true);
alter view if exists public.rental_current_assets set (security_invoker = true);
alter view if exists public.v_asset_analytics_current set (security_invoker = true);
