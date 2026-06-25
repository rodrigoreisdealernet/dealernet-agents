-- Fleet availability calendar with conflict detection + maintenance-status integration
--
-- Provides a shared availability query usable by the calendar surface and
-- reservation/maintenance write-path validation so both surfaces always apply
-- the same overlap rules.
--
-- New objects:
--   fleet_get_availability_calendar(p_start_date, p_end_date, p_branch_id,
--                                   p_category_id, p_status)
--       Per-asset availability rows with conflict_reason values:
--       on_rent | inspection_hold | maintenance | transfer | retired | lost
--
-- Security:
--   SECURITY INVOKER — the function runs with the caller's Postgres role so
--   the caller's RLS policies gate what data is visible.  The underlying
--   views already carry security_invoker = true (migration 20260607183000).
--   Service-role callers continue to bypass RLS as expected.
--   GRANT execute is limited to authenticated and service_role so unauthenticated
--   (anon) callers receive a permission-denied error before the function body
--   is entered.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS fleet_get_availability_calendar CASCADE;

-- ---------------------------------------------------------------------------
-- fleet_get_availability_calendar
--
-- Returns one row per asset with date-window occupancy and blocking reason.
-- Used by both the /inventory/calendar frontend surface and write-path
-- reservation/maintenance validation so the same overlap algorithm governs
-- both display and enforcement.
--
-- Overlap rule (inclusive both ends — consistent with storefront RPC):
--   A contract line conflicts with [p_start_date, p_end_date] when:
--     line_start <= p_end_date
--     AND (line_end IS NULL OR line_end >= p_start_date)
--
-- Conflict priority (highest wins):
--   1. operational_status blocking states (maintenance, inspection_hold, transfer,
--      retired, lost) — these block the asset regardless of the requested window.
--      Both the canonical long forms (seed/DB: in_maintenance, on_inspection_hold,
--      on_transfer) and the field-operations short forms (maintenance,
--      inspection_hold, in_transit) are recognised so no in-flight assets are
--      silently treated as available.
--   2. Active contract-line overlap with the requested window (on_rent).
--      on_rent is intentionally excluded from the hard-blocking set so that
--      an asset with operational_status = on_rent is available for future
--      windows where no contract line overlaps.
--
-- Null-date handling:
--   When p_start_date or p_end_date is NULL the booked_lines CTE matches any
--   active (non-terminal) line, treating the current occupancy as a conflict.
--   The frontend always passes both dates; this path exists as a defence-in-
--   depth safeguard so on_rent assets are never incorrectly shown as available
--   when only one (or neither) date is supplied.
--
-- Status filter (p_status):
--   'available' / 'unavailable' — composite availability predicates.
--   Any other value — matches assets whose eff_status is in the same
--   vocabulary group as p_status (long and short forms are equivalent).
-- ---------------------------------------------------------------------------
create or replace function public.fleet_get_availability_calendar(
  p_start_date  date    default null,
  p_end_date    date    default null,
  p_branch_id   uuid    default null,
  p_category_id uuid    default null,
  p_status      text    default null
)
returns table (
  entity_id             uuid,
  name                  text,
  identifier            text,
  branch_id             uuid,
  branch_name           text,
  asset_category_id     uuid,
  asset_category_name   text,
  operational_status    text,
  maintenance_due_status text,
  is_available          boolean,
  conflict_reason       text
)
language plpgsql
-- SECURITY INVOKER ensures queries run with the caller's Postgres role so the
-- base-table RLS policies (and the security_invoker = true views) correctly
-- scope results to what the caller is permitted to see.
security invoker
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
begin
  -- Defense-in-depth: reject callers whose JWT does not carry an authenticated
  -- or service_role claim.  The GRANT already prevents anon from executing the
  -- function; this guard adds a second layer.
  if v_role not in ('authenticated', 'service_role') then
    raise exception 'fleet_get_availability_calendar: access denied'
      using errcode = '42501';
  end if;

  if p_start_date is not null and p_end_date is not null
     and p_start_date > p_end_date then
    raise exception 'p_start_date must not be after p_end_date'
      using errcode = '22023';
  end if;

  return query
  with booked_lines as (
    -- Assets that have at least one active (non-terminal) contract line
    -- that conflicts with the requested period.
    --
    -- When both dates are given: standard inclusive-end overlap check.
    -- When one or both dates are absent: any active line is treated as a
    -- conflict so on_rent assets are never incorrectly shown as available.
    select distinct
      l.asset_id::uuid as asset_id,
      l.status         as line_status
    from v_rental_contract_line_current l
    where l.status not in ('returned', 'cancelled')
      and (
        -- One or both dates absent → include all active lines (current occupancy)
        (p_start_date is null or p_end_date is null)
        or (
          -- Both dates present → standard window-overlap check
          coalesce(
            nullif(l.actual_start, '')::date,
            nullif(l.data ->> 'planned_start', '')::date
          ) <= p_end_date
          and (
            coalesce(
              nullif(l.actual_end, '')::date,
              nullif(l.data ->> 'planned_end', '')::date
            ) is null
            or coalesce(
              nullif(l.actual_end, '')::date,
              nullif(l.data ->> 'planned_end', '')::date
            ) >= p_start_date
          )
        )
      )
  ),
  -- Resolve each asset's effective operational_status once so the rest of
  -- the query references a single column rather than repeating coalesce().
  assets_with_status as (
    select
      a.*,
      coalesce(a.operational_status, 'available') as eff_status
    from rental_current_assets a
  )
  select
    a.entity_id::uuid,
    a.name,
    a.data ->> 'identifier'    as identifier,
    a.current_branch_id::uuid,
    a.current_branch_name,
    a.current_asset_category_id::uuid,
    a.current_asset_category_name,
    a.eff_status               as operational_status,
    a.maintenance_due_status,

    -- is_available:
    --   true  = hard-blocking status absent AND no overlapping contract line.
    --   on_rent is intentionally excluded from the hard-blocking list; an asset
    --   currently on_rent is available for future windows where no contract line
    --   overlaps (the booked_lines CTE provides that window check).
    (
      a.eff_status not in (
        'in_maintenance',    'maintenance',
        'on_inspection_hold','inspection_hold',
        'on_transfer',       'in_transit',
        'retired', 'lost', 'conflicting_assignment'
      )
      and bl.asset_id is null
    )                          as is_available,

    -- conflict_reason: highest-priority blocking reason, or NULL when available.
    --   Normalises both the long forms (seed/DB canonical) and the short forms
    --   (field operations app) to the same exported labels.
    case
      when a.eff_status in ('in_maintenance', 'maintenance')
        then 'maintenance'
      when a.eff_status in ('on_inspection_hold', 'inspection_hold')
        then 'inspection_hold'
      when a.eff_status in ('on_transfer', 'in_transit')
        then 'transfer'
      when a.eff_status in ('retired', 'lost', 'conflicting_assignment')
        then a.eff_status
      when bl.asset_id is not null
        then 'on_rent'
      else null
    end                        as conflict_reason

  from assets_with_status a
  left join booked_lines bl on bl.asset_id = a.entity_id::uuid
  where a.current_branch_id is not null
    and (p_branch_id   is null or a.current_branch_id::uuid           = p_branch_id)
    and (p_category_id is null or a.current_asset_category_id::uuid   = p_category_id)
    and (
      p_status is null
      or (
        p_status = 'available'
          and a.eff_status not in (
                'in_maintenance',    'maintenance',
                'on_inspection_hold','inspection_hold',
                'on_transfer',       'in_transit',
                'retired', 'lost', 'conflicting_assignment'
              )
          and bl.asset_id is null
      )
      or (
        p_status = 'unavailable'
          and (
            a.eff_status in (
              'in_maintenance',    'maintenance',
              'on_inspection_hold','inspection_hold',
              'on_transfer',       'in_transit',
              'retired', 'lost', 'conflicting_assignment'
            )
            or bl.asset_id is not null
          )
      )
      -- For specific-status filters, match both the long form and short form so
      -- that filtering by 'in_maintenance' also returns assets stored as
      -- 'maintenance' (and vice versa), and similarly for the other pairs.
      or (
        p_status not in ('available', 'unavailable')
          and case
            when p_status in ('in_maintenance', 'maintenance')
              then a.eff_status in ('in_maintenance', 'maintenance')
            when p_status in ('on_inspection_hold', 'inspection_hold')
              then a.eff_status in ('on_inspection_hold', 'inspection_hold')
            when p_status in ('on_transfer', 'in_transit')
              then a.eff_status in ('on_transfer', 'in_transit')
            else a.eff_status = p_status
          end
      )
    )
  order by
    a.current_branch_name,
    a.current_asset_category_name,
    a.name;
end;
$$;

-- SECURITY INVOKER functions do not require an explicit grant in the same way
-- as SECURITY DEFINER functions (the caller already needs to hold the function's
-- execute privilege AND have select on the underlying tables via RLS).  We keep
-- the explicit grants here so that callers can discover and call the function.
grant execute on function public.fleet_get_availability_calendar
  to authenticated, service_role;

-- fleet_get_availability_calendar is SECURITY INVOKER: it executes with the
-- caller's Postgres role, so the caller must have SELECT on every view the
-- function body reads.  The views below were introduced by earlier migrations
-- that pre-date the pattern of adding explicit grants (they relied on Supabase's
-- default-privilege mechanism which is not present in bare-Postgres test harnesses
-- or non-Supabase deployments).  Granting here ensures the function works for
-- authenticated and service_role callers in all environments.
grant select on table public.rental_entity_type_catalog       to authenticated, service_role;
grant select on table public.rental_current_entity_state      to authenticated, service_role;
grant select on table public.rental_current_branches          to authenticated, service_role;
grant select on table public.rental_current_asset_categories  to authenticated, service_role;
grant select on table public.rental_current_assets            to authenticated, service_role;
grant select on table public.v_rental_contract_line_current   to authenticated, service_role;
