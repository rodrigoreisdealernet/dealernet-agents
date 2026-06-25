-- Quote Fee Engine + Tax Presets
--
-- Implements configurable default-fee and tax-preset tables that drive the
-- staff-facing quote-builder pricing preview.
--
-- Precedence for preset resolution (explicit, not implicit fallback):
--   category_branch (scope_rank 4) — most specific: matches exact branch + category
--   category        (scope_rank 3) — any branch, specific category
--   branch          (scope_rank 2) — any category, specific branch
--   global          (scope_rank 1) — least specific, no branch/category filter
-- For each unique fee/tax name only the highest-priority matching preset applies.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.staff_quote_save_draft CASCADE;
--   DROP FUNCTION IF EXISTS public.staff_quote_pricing_preview CASCADE;
--   DROP TABLE IF EXISTS public.staff_quote_drafts CASCADE;
--   DROP TABLE IF EXISTS public.quote_tax_presets CASCADE;
--   DROP TABLE IF EXISTS public.quote_fee_presets CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. quote_fee_presets
--    Admin-maintained default fee rules applied automatically when building a
--    staff quote.  fee_type='percent' → amount is a decimal rate (0.05 = 5 %);
--    fee_type='flat' → amount is a fixed USD value.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.quote_fee_presets (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,
  fee_type     text        not null,
  amount       numeric     not null,
  scope        text        not null default 'global',
  branch_id    uuid,
  category_id  uuid,
  is_active    boolean     not null default true,
  sort_order   int         not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint quote_fee_presets_fee_type_chk
    check (fee_type in ('percent', 'flat')),
  constraint quote_fee_presets_scope_chk
    check (scope in ('global', 'branch', 'category', 'category_branch')),
  constraint quote_fee_presets_amount_nn
    check (amount >= 0)
);

create index if not exists idx_quote_fee_presets_lookup
  on public.quote_fee_presets (is_active, branch_id, category_id);

create trigger trg_quote_fee_presets_updated_at
  before update on public.quote_fee_presets
  for each row execute function update_updated_at();

alter table public.quote_fee_presets enable row level security;

create policy quote_fee_presets_staff_select
  on public.quote_fee_presets for select
  to authenticated
  using (public.ops_claim_app_role() in ('admin', 'branch_manager'));

create policy quote_fee_presets_admin_insert
  on public.quote_fee_presets for insert
  to authenticated
  with check (public.ops_claim_app_role() = 'admin');

create policy quote_fee_presets_admin_update
  on public.quote_fee_presets for update
  to authenticated
  using (public.ops_claim_app_role() = 'admin');

grant select, insert, update on public.quote_fee_presets to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. quote_tax_presets
--    Configuration-based tax rates by branch/location and/or category.
--    rate is stored as a decimal (0.085 = 8.5 %).  Full third-party tax engine
--    integration is out of scope; this table is the authoritative config source.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.quote_tax_presets (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,
  rate         numeric     not null,
  scope        text        not null default 'global',
  branch_id    uuid,
  category_id  uuid,
  is_active    boolean     not null default true,
  sort_order   int         not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint quote_tax_presets_scope_chk
    check (scope in ('global', 'branch', 'category', 'category_branch')),
  constraint quote_tax_presets_rate_range
    check (rate >= 0 and rate < 1)
);

create index if not exists idx_quote_tax_presets_lookup
  on public.quote_tax_presets (is_active, branch_id, category_id);

create trigger trg_quote_tax_presets_updated_at
  before update on public.quote_tax_presets
  for each row execute function update_updated_at();

alter table public.quote_tax_presets enable row level security;

create policy quote_tax_presets_staff_select
  on public.quote_tax_presets for select
  to authenticated
  using (public.ops_claim_app_role() in ('admin', 'branch_manager'));

create policy quote_tax_presets_admin_insert
  on public.quote_tax_presets for insert
  to authenticated
  with check (public.ops_claim_app_role() = 'admin');

create policy quote_tax_presets_admin_update
  on public.quote_tax_presets for update
  to authenticated
  using (public.ops_claim_app_role() = 'admin');

grant select, insert, update on public.quote_tax_presets to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. staff_quote_drafts
--    Persists a pricing snapshot at the moment a staff quote is saved so that
--    later conversion to a rental order does not silently recalculate against
--    different rules.  The pricing_snapshot column stores the full breakdown
--    (base, fee lines, tax lines, totals, preset IDs used).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.staff_quote_drafts (
  id                 uuid        primary key default gen_random_uuid(),
  asset_id           uuid,
  asset_category_id  uuid,
  branch_id          uuid,
  start_date         date,
  end_date           date,
  quantity           int         not null default 1
                     constraint staff_quote_drafts_quantity_pos check (quantity >= 1),
  base_amount        numeric,
  pricing_snapshot   jsonb,
  status             text        not null default 'draft',
  created_by         uuid        references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint staff_quote_drafts_status_chk
    check (status in ('draft', 'sent', 'accepted', 'declined', 'expired'))
);

create index if not exists idx_staff_quote_drafts_created_by
  on public.staff_quote_drafts (created_by, created_at desc);

create index if not exists idx_staff_quote_drafts_branch
  on public.staff_quote_drafts (branch_id, status);

create trigger trg_staff_quote_drafts_updated_at
  before update on public.staff_quote_drafts
  for each row execute function update_updated_at();

alter table public.staff_quote_drafts enable row level security;

create policy staff_quote_drafts_staff_all
  on public.staff_quote_drafts for all
  to authenticated
  using (public.ops_claim_app_role() in ('admin', 'branch_manager'))
  with check (public.ops_claim_app_role() in ('admin', 'branch_manager'));

grant select, insert, update on public.staff_quote_drafts to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RPC: staff_quote_pricing_preview
--    Resolves applicable fee + tax presets for a given context and returns a
--    full, auditable pricing breakdown.
--
--    Inputs:
--      p_base_amount  — rental base amount already computed from rate × days
--      p_category_id  — asset category (may be null for category-agnostic queries)
--      p_branch_id    — branch/location (may be null for branch-agnostic queries)
--
--    Outputs (single row):
--      base_amount, fee_lines[], fees_total, subtotal,
--      tax_lines[], tax_total, grand_total, preset_snapshot
--
--    Security: staff only (admin / branch_manager JWT claim required).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.staff_quote_pricing_preview(
  p_base_amount  numeric,
  p_category_id  uuid    default null,
  p_branch_id    uuid    default null
)
returns table (
  base_amount      numeric,
  fee_lines        jsonb,
  fees_total       numeric,
  subtotal         numeric,
  tax_lines        jsonb,
  tax_total        numeric,
  grand_total      numeric,
  preset_snapshot  jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role    text;
  v_fee_lines   jsonb    := '[]'::jsonb;
  v_tax_lines   jsonb    := '[]'::jsonb;
  v_fees_total  numeric  := 0;
  v_subtotal    numeric;
  v_tax_total   numeric  := 0;
  v_grand_total numeric;
  v_preset_ids  jsonb    := '[]'::jsonb;

  r_fee         record;
  r_tax         record;
  v_fee_amount  numeric;
  v_tax_amount  numeric;
begin
  v_app_role := public.ops_claim_app_role();
  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'staff_quote_pricing_preview: access denied'
      using errcode = '42501';
  end if;

  if p_base_amount is null or p_base_amount < 0 then
    raise exception 'p_base_amount must be a non-negative numeric value'
      using errcode = '22023';
  end if;

  -- ── Fee preset resolution ────────────────────────────────────────────────
  -- For each distinct fee name, DISTINCT ON picks the highest scope_rank row
  -- (category_branch > category > branch > global).  sort_order breaks ties.
  for r_fee in
    select distinct on (fp.name)
      fp.id,
      fp.name,
      fp.fee_type,
      fp.amount,
      fp.scope,
      case fp.scope
        when 'category_branch' then 4
        when 'category'        then 3
        when 'branch'          then 2
        else                        1
      end as scope_rank
    from public.quote_fee_presets fp
    where fp.is_active
      and (
           (fp.scope = 'global')
        or (fp.scope = 'branch'
            and fp.branch_id   = p_branch_id
            and p_branch_id is not null)
        or (fp.scope = 'category'
            and fp.category_id = p_category_id
            and p_category_id is not null)
        or (fp.scope = 'category_branch'
            and fp.branch_id   = p_branch_id
            and fp.category_id = p_category_id
            and p_branch_id is not null
            and p_category_id is not null)
      )
    order by fp.name,
             case fp.scope
               when 'category_branch' then 4
               when 'category'        then 3
               when 'branch'          then 2
               else                        1
             end desc,
             fp.sort_order
  loop
    if r_fee.fee_type = 'percent' then
      v_fee_amount := round(p_base_amount * r_fee.amount, 2);
    else
      v_fee_amount := round(r_fee.amount, 2);
    end if;

    v_fees_total := v_fees_total + v_fee_amount;

    v_fee_lines := v_fee_lines || jsonb_build_array(jsonb_build_object(
      'preset_id', r_fee.id,
      'name',      r_fee.name,
      'fee_type',  r_fee.fee_type,
      'rate',      r_fee.amount,
      'amount',    v_fee_amount,
      'scope',     r_fee.scope
    ));

    v_preset_ids := v_preset_ids || jsonb_build_array(
      jsonb_build_object('type', 'fee', 'id', r_fee.id)
    );
  end loop;

  v_subtotal := round(p_base_amount + v_fees_total, 2);

  -- ── Tax preset resolution ────────────────────────────────────────────────
  -- Taxes are computed on (base + fees), i.e. the subtotal.
  for r_tax in
    select distinct on (tp.name)
      tp.id,
      tp.name,
      tp.rate,
      tp.scope,
      case tp.scope
        when 'category_branch' then 4
        when 'category'        then 3
        when 'branch'          then 2
        else                        1
      end as scope_rank
    from public.quote_tax_presets tp
    where tp.is_active
      and (
           (tp.scope = 'global')
        or (tp.scope = 'branch'
            and tp.branch_id   = p_branch_id
            and p_branch_id is not null)
        or (tp.scope = 'category'
            and tp.category_id = p_category_id
            and p_category_id is not null)
        or (tp.scope = 'category_branch'
            and tp.branch_id   = p_branch_id
            and tp.category_id = p_category_id
            and p_branch_id is not null
            and p_category_id is not null)
      )
    order by tp.name,
             case tp.scope
               when 'category_branch' then 4
               when 'category'        then 3
               when 'branch'          then 2
               else                        1
             end desc,
             tp.sort_order
  loop
    v_tax_amount := round(v_subtotal * r_tax.rate, 2);
    v_tax_total  := v_tax_total + v_tax_amount;

    v_tax_lines := v_tax_lines || jsonb_build_array(jsonb_build_object(
      'preset_id', r_tax.id,
      'name',      r_tax.name,
      'rate',      r_tax.rate,
      'amount',    v_tax_amount,
      'scope',     r_tax.scope
    ));

    v_preset_ids := v_preset_ids || jsonb_build_array(
      jsonb_build_object('type', 'tax', 'id', r_tax.id)
    );
  end loop;

  v_grand_total := round(v_subtotal + v_tax_total, 2);

  base_amount    := round(p_base_amount, 2);
  fee_lines      := v_fee_lines;
  fees_total     := round(v_fees_total, 2);
  subtotal       := v_subtotal;
  tax_lines      := v_tax_lines;
  tax_total      := round(v_tax_total, 2);
  grand_total    := v_grand_total;
  preset_snapshot := jsonb_build_object(
    'base_amount',  base_amount,
    'fee_lines',    fee_lines,
    'fees_total',   fees_total,
    'subtotal',     subtotal,
    'tax_lines',    tax_lines,
    'tax_total',    tax_total,
    'grand_total',  grand_total,
    'presets_used', v_preset_ids,
    'context', jsonb_build_object(
      'category_id', p_category_id,
      'branch_id',   p_branch_id
    )
  );

  return next;
end;
$$;

grant execute on function public.staff_quote_pricing_preview to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RPC: staff_quote_save_draft
--    Computes a fresh pricing preview and persists it as a quote draft so the
--    snapshot is immutable at the point of saving.  Later edits call this again
--    to produce a new snapshot; the saved_snapshot / current_recalculation
--    distinction is maintained by checking draft.updated_at vs. now().
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.staff_quote_save_draft(
  p_base_amount      numeric,
  p_category_id      uuid      default null,
  p_branch_id        uuid      default null,
  p_asset_id         uuid      default null,
  p_start_date       date      default null,
  p_end_date         date      default null,
  p_quantity         int       default 1
)
returns table (
  draft_id   uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role   text;
  v_user_id    uuid;
  v_pricing    record;
  v_id         uuid;
  v_ts         timestamptz := timezone('utc'::text, now());
begin
  v_app_role := public.ops_claim_app_role();
  if v_app_role not in ('admin', 'branch_manager') then
    raise exception 'staff_quote_save_draft: access denied'
      using errcode = '42501';
  end if;

  v_user_id := (
    coalesce(
      nullif(current_setting('request.jwt.claims', true), ''),
      '{}'
    )::jsonb ->> 'sub'
  )::uuid;

  select * into v_pricing
  from public.staff_quote_pricing_preview(p_base_amount, p_category_id, p_branch_id);

  insert into public.staff_quote_drafts (
    asset_id, asset_category_id, branch_id,
    start_date, end_date, quantity,
    base_amount, pricing_snapshot,
    status, created_by, created_at, updated_at
  ) values (
    p_asset_id, p_category_id, p_branch_id,
    p_start_date, p_end_date,
    coalesce(p_quantity, 1),
    round(p_base_amount, 2),
    v_pricing.preset_snapshot,
    'draft', v_user_id, v_ts, v_ts
  )
  returning id into v_id;

  draft_id   := v_id;
  created_at := v_ts;
  return next;
end;
$$;

grant execute on function public.staff_quote_save_draft to authenticated;
