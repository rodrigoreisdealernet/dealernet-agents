-- Procurement receiving, PO matching, and warranty capture
--
-- Implements child story #1234.
--
-- Changes:
--   0. Restore requisition, supplier, and purchase_order in
--      rental_entity_type_catalog (stomped by 20260613002000).
--   1. procurement_receipts        – individual goods-receipt records against a PO
--                                    (supports multiple partial receipts)
--   2. procurement_supplier_invoices – supplier invoices for three-way matching
--   3. procurement_po_match_outcomes – two-way and three-way match results with
--                                    explicit discrepancy details and a hold flag
--                                    that blocks downstream completion until reviewed
--   4. procurement_warranty_records  – warranty metadata attached to purchased
--                                    assets or parts, queryable from the
--                                    operational record
--   5. Fact-type seeds for receipt, match, and warranty audit events
--   6. Views: v_procurement_receipts, v_procurement_po_match_outcomes,
--             v_procurement_warranty_records
--   7. RPCs:  procurement_record_receipt, procurement_record_supplier_invoice,
--             procurement_run_po_match, procurement_resolve_match_discrepancy,
--             procurement_attach_warranty

-- ---------------------------------------------------------------------------
-- 0. Restore procurement entity types in rental_entity_type_catalog
--    (20260613002000_inventory_kits_bundles.sql redefined the catalog view
--    without carrying forward requisition, supplier, and purchase_order added
--    by 20260612195000_procurement_purchase_order_lifecycle.sql)
-- ---------------------------------------------------------------------------

create or replace view public.rental_entity_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('company'),
    ('region'),
    ('branch'),
    ('customer'),
    ('billing_account'),
    ('contact'),
    ('job_site'),
    ('asset_category'),
    ('asset'),
    ('stock_item'),
    ('inventory_kit'),
    ('maintenance_record'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line'),
    ('invoice'),
    ('invoice_line'),
    ('transfer'),
    ('rate_card'),
    ('document'),
    ('note'),
    ('agent_config'),
    ('customer_issue'),
    ('requisition'),
    ('supplier'),
    ('purchase_order')
) as rental_entity_types(entity_type);

-- ---------------------------------------------------------------------------
-- 1. procurement_receipts
-- ---------------------------------------------------------------------------

create table if not exists public.procurement_receipts (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references public.entities(id) on delete restrict,
  receipt_number      text not null,
  received_quantity   numeric(14,4) not null check (received_quantity > 0),
  delivery_note_number text,
  received_at         timestamptz not null default now(),
  condition_notes     text,
  status              text not null default 'pending_match'
                        check (status in ('pending_match', 'matched', 'discrepancy_held', 'discrepancy_resolved')),
  metadata            jsonb not null default '{}'::jsonb,
  recorded_by         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists procurement_receipts_number_uq
  on public.procurement_receipts (receipt_number);

create index if not exists procurement_receipts_po_idx
  on public.procurement_receipts (purchase_order_id, received_at desc);

create trigger trg_procurement_receipts_updated_at
  before update on public.procurement_receipts
  for each row execute function public.update_updated_at();

alter table public.procurement_receipts enable row level security;

drop policy if exists procurement_receipts_read on public.procurement_receipts;
create policy procurement_receipts_read
  on public.procurement_receipts
  for select
  to authenticated
  using (public.get_my_role() in ('admin', 'branch_manager', 'field_operator', 'read_only'));

drop policy if exists procurement_receipts_write on public.procurement_receipts;
create policy procurement_receipts_write
  on public.procurement_receipts
  for all
  to authenticated
  using  (public.get_my_role() in ('admin', 'branch_manager'))
  with check (public.get_my_role() in ('admin', 'branch_manager'));

drop policy if exists procurement_receipts_service_role on public.procurement_receipts;
create policy procurement_receipts_service_role
  on public.procurement_receipts
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update on public.procurement_receipts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. procurement_supplier_invoices
-- ---------------------------------------------------------------------------

create table if not exists public.procurement_supplier_invoices (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references public.entities(id) on delete restrict,
  invoice_number      text not null,
  invoice_date        date not null,
  invoiced_quantity   numeric(14,4) not null check (invoiced_quantity > 0),
  invoiced_unit_price numeric(14,4),
  invoiced_total      numeric(14,2) not null check (invoiced_total > 0),
  currency_code       text not null default 'USD',
  status              text not null default 'pending_match'
                        check (status in ('pending_match', 'matched', 'discrepancy_held', 'discrepancy_resolved')),
  metadata            jsonb not null default '{}'::jsonb,
  recorded_by         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists procurement_supplier_invoices_po_number_uq
  on public.procurement_supplier_invoices (purchase_order_id, invoice_number);

create index if not exists procurement_supplier_invoices_po_idx
  on public.procurement_supplier_invoices (purchase_order_id, invoice_date desc);

create trigger trg_procurement_supplier_invoices_updated_at
  before update on public.procurement_supplier_invoices
  for each row execute function public.update_updated_at();

alter table public.procurement_supplier_invoices enable row level security;

drop policy if exists procurement_supplier_invoices_read on public.procurement_supplier_invoices;
create policy procurement_supplier_invoices_read
  on public.procurement_supplier_invoices
  for select
  to authenticated
  using (public.get_my_role() in ('admin', 'branch_manager', 'field_operator', 'read_only'));

drop policy if exists procurement_supplier_invoices_write on public.procurement_supplier_invoices;
create policy procurement_supplier_invoices_write
  on public.procurement_supplier_invoices
  for all
  to authenticated
  using  (public.get_my_role() in ('admin', 'branch_manager'))
  with check (public.get_my_role() in ('admin', 'branch_manager'));

drop policy if exists procurement_supplier_invoices_service_role on public.procurement_supplier_invoices;
create policy procurement_supplier_invoices_service_role
  on public.procurement_supplier_invoices
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update on public.procurement_supplier_invoices to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. procurement_po_match_outcomes
-- ---------------------------------------------------------------------------

create table if not exists public.procurement_po_match_outcomes (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references public.entities(id) on delete restrict,
  receipt_id          uuid references public.procurement_receipts(id) on delete set null,
  invoice_id          uuid references public.procurement_supplier_invoices(id) on delete set null,
  match_type          text not null check (match_type in ('two_way', 'three_way')),
  outcome             text not null check (outcome in ('matched', 'discrepancy', 'pending_review')),
  quantity_variance   numeric(14,4),
  price_variance      numeric(14,4),
  total_variance      numeric(14,2),
  discrepancy_details jsonb not null default '[]'::jsonb,
  hold_downstream     boolean not null default false,
  reviewed_by         text,
  reviewed_at         timestamptz,
  review_resolution   text check (review_resolution in ('accepted', 'rejected', 'escalated')),
  review_notes        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists procurement_po_match_outcomes_po_idx
  on public.procurement_po_match_outcomes (purchase_order_id, created_at desc);

create index if not exists procurement_po_match_outcomes_hold_idx
  on public.procurement_po_match_outcomes (hold_downstream, outcome)
  where hold_downstream = true;

create trigger trg_procurement_po_match_outcomes_updated_at
  before update on public.procurement_po_match_outcomes
  for each row execute function public.update_updated_at();

alter table public.procurement_po_match_outcomes enable row level security;

drop policy if exists procurement_po_match_outcomes_read on public.procurement_po_match_outcomes;
create policy procurement_po_match_outcomes_read
  on public.procurement_po_match_outcomes
  for select
  to authenticated
  using (public.get_my_role() in ('admin', 'branch_manager', 'field_operator', 'read_only'));

drop policy if exists procurement_po_match_outcomes_write on public.procurement_po_match_outcomes;
create policy procurement_po_match_outcomes_write
  on public.procurement_po_match_outcomes
  for all
  to authenticated
  using  (public.get_my_role() in ('admin', 'branch_manager'))
  with check (public.get_my_role() in ('admin', 'branch_manager'));

drop policy if exists procurement_po_match_outcomes_service_role on public.procurement_po_match_outcomes;
create policy procurement_po_match_outcomes_service_role
  on public.procurement_po_match_outcomes
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update on public.procurement_po_match_outcomes to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. procurement_warranty_records
-- ---------------------------------------------------------------------------

create table if not exists public.procurement_warranty_records (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null references public.entities(id) on delete restrict,
  purchase_order_id     uuid references public.entities(id) on delete set null,
  receipt_id            uuid references public.procurement_receipts(id) on delete set null,
  warranty_provider     text not null,
  serial_number         text,
  warranty_start_date   date not null,
  warranty_end_date     date not null,
  warranty_type         text not null default 'full'
                          check (warranty_type in ('parts', 'labor', 'full', 'extended', 'other')),
  warranty_terms        text,
  warranty_document_ref text,
  is_active             boolean not null default true,
  metadata              jsonb not null default '{}'::jsonb,
  recorded_by           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (warranty_end_date >= warranty_start_date)
);

create index if not exists procurement_warranty_records_entity_idx
  on public.procurement_warranty_records (entity_id, warranty_end_date desc);

create index if not exists procurement_warranty_records_po_idx
  on public.procurement_warranty_records (purchase_order_id)
  where purchase_order_id is not null;

create index if not exists procurement_warranty_records_active_idx
  on public.procurement_warranty_records (entity_id, is_active)
  where is_active = true;

create trigger trg_procurement_warranty_records_updated_at
  before update on public.procurement_warranty_records
  for each row execute function public.update_updated_at();

alter table public.procurement_warranty_records enable row level security;

drop policy if exists procurement_warranty_records_read on public.procurement_warranty_records;
create policy procurement_warranty_records_read
  on public.procurement_warranty_records
  for select
  to authenticated
  using (public.get_my_role() in ('admin', 'branch_manager', 'field_operator', 'read_only'));

drop policy if exists procurement_warranty_records_write on public.procurement_warranty_records;
create policy procurement_warranty_records_write
  on public.procurement_warranty_records
  for all
  to authenticated
  using  (public.get_my_role() in ('admin', 'branch_manager'))
  with check (public.get_my_role() in ('admin', 'branch_manager'));

drop policy if exists procurement_warranty_records_service_role on public.procurement_warranty_records;
create policy procurement_warranty_records_service_role
  on public.procurement_warranty_records
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update on public.procurement_warranty_records to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Fact-type seeds
-- ---------------------------------------------------------------------------

insert into public.fact_types (key, label, description, unit)
values
  ('po_receipt_event',  'PO Receipt Event',  'Goods-receipt events recorded against a purchase order', 'event'),
  ('po_match_event',    'PO Match Event',    'Two-way and three-way PO match outcome events',           'event'),
  ('warranty_event',    'Warranty Event',    'Warranty attachment and update events on purchased items', 'event')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Views
-- ---------------------------------------------------------------------------

create or replace view public.v_procurement_receipts
with (security_invoker = true) as
select
  r.id                                                         as receipt_id,
  r.purchase_order_id,
  ev.data ->> 'purchase_order_number'                          as purchase_order_number,
  supplier_ev.data ->> 'name'                                  as supplier_name,
  branch_ev.data ->> 'name'                                    as branch_name,
  r.receipt_number,
  r.received_quantity,
  (ev.data ->> 'ordered_quantity')::numeric                    as ordered_quantity,
  r.delivery_note_number,
  r.received_at,
  r.condition_notes,
  r.status,
  r.recorded_by,
  r.metadata,
  r.created_at,
  r.updated_at
from public.procurement_receipts r
join public.entities e
  on e.id = r.purchase_order_id
join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current = true
left join public.entities supplier_e
  on supplier_e.id = nullif(ev.data ->> 'supplier_id', '')::uuid
left join public.entity_versions supplier_ev
  on supplier_ev.entity_id = supplier_e.id
 and supplier_ev.is_current = true
left join public.entities branch_e
  on branch_e.id = nullif(ev.data ->> 'branch_id', '')::uuid
left join public.entity_versions branch_ev
  on branch_ev.entity_id = branch_e.id
 and branch_ev.is_current = true;

create or replace view public.v_procurement_po_match_outcomes
with (security_invoker = true) as
select
  m.id                                                         as match_outcome_id,
  m.purchase_order_id,
  ev.data ->> 'purchase_order_number'                          as purchase_order_number,
  supplier_ev.data ->> 'name'                                  as supplier_name,
  m.receipt_id,
  r.receipt_number,
  m.invoice_id,
  si.invoice_number,
  m.match_type,
  m.outcome,
  m.quantity_variance,
  m.price_variance,
  m.total_variance,
  m.discrepancy_details,
  m.hold_downstream,
  m.reviewed_by,
  m.reviewed_at,
  m.review_resolution,
  m.review_notes,
  m.created_at,
  m.updated_at
from public.procurement_po_match_outcomes m
join public.entities e
  on e.id = m.purchase_order_id
join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current = true
left join public.entities supplier_e
  on supplier_e.id = nullif(ev.data ->> 'supplier_id', '')::uuid
left join public.entity_versions supplier_ev
  on supplier_ev.entity_id = supplier_e.id
 and supplier_ev.is_current = true
left join public.procurement_receipts r
  on r.id = m.receipt_id
left join public.procurement_supplier_invoices si
  on si.id = m.invoice_id;

create or replace view public.v_procurement_warranty_records
with (security_invoker = true) as
select
  w.id                                                          as warranty_record_id,
  w.entity_id,
  e.entity_type                                                 as entity_type,
  ev.data ->> 'name'                                            as entity_name,
  w.purchase_order_id,
  po_ev.data ->> 'purchase_order_number'                        as purchase_order_number,
  w.receipt_id,
  r.receipt_number,
  w.warranty_provider,
  w.serial_number,
  w.warranty_start_date,
  w.warranty_end_date,
  w.warranty_type,
  w.warranty_terms,
  w.warranty_document_ref,
  w.is_active,
  (w.warranty_end_date >= current_date)                         as is_in_warranty,
  (w.warranty_end_date - current_date)                          as days_remaining,
  w.metadata,
  w.recorded_by,
  w.created_at,
  w.updated_at
from public.procurement_warranty_records w
join public.entities e
  on e.id = w.entity_id
join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current = true
left join public.entities po_e
  on po_e.id = w.purchase_order_id
left join public.entity_versions po_ev
  on po_ev.entity_id = po_e.id
 and po_ev.is_current = true
left join public.procurement_receipts r
  on r.id = w.receipt_id;

-- ---------------------------------------------------------------------------
-- 7a. RPC: procurement_record_receipt
--
-- Records a goods-receipt line against an open purchase order.  Updates the
-- PO's cumulative received_quantity via procurement_transition_purchase_order
-- so receipt tracking, partial/full status projection, and audit events remain
-- consistent with the existing PO lifecycle.
-- ---------------------------------------------------------------------------

create or replace function public.procurement_record_receipt(
  p_purchase_order_id   uuid,
  p_received_quantity   numeric,
  p_delivery_note_number text  default null,
  p_condition_notes     text  default null,
  p_reason              text  default null
)
returns table (
  receipt_id            uuid,
  receipt_number        text,
  purchase_order_id     uuid,
  purchase_order_number text,
  received_quantity     numeric,
  cumulative_received   numeric,
  po_status             text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_app_role      text := coalesce(public.ops_claim_app_role(), '');
  v_claims        jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  v_actor_id      text := coalesce(v_claims ->> 'sub', '');
  v_po_data       jsonb;
  v_po_status     text;
  v_po_number     text;
  v_cumulative    numeric;
  v_receipt_id    uuid;
  v_receipt_number text;
  v_fact_type_id  uuid;
  v_attempt       int;
  v_new_po_status text;
begin
  if not (
    v_request_role = 'service_role'
    or (v_request_role = 'authenticated' and v_app_role in ('admin', 'branch_manager'))
  ) then
    raise exception 'procurement_record_receipt: access denied'
      using errcode = '42501';
  end if;

  if p_purchase_order_id is null then
    raise exception 'procurement_record_receipt: purchase_order_id is required'
      using errcode = '22023';
  end if;

  if coalesce(p_received_quantity, 0) <= 0 then
    raise exception 'procurement_record_receipt: received_quantity must be positive'
      using errcode = '22023';
  end if;

  select ev.data
    into v_po_data
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.id = p_purchase_order_id
    and e.entity_type = 'purchase_order';

  if not found then
    raise exception 'procurement_record_receipt: purchase_order % not found', p_purchase_order_id
      using errcode = '22023';
  end if;

  v_po_status := coalesce(v_po_data ->> 'status', 'draft');
  v_po_number := coalesce(v_po_data ->> 'purchase_order_number', '');

  if v_po_status = 'draft' then
    raise exception 'procurement_record_receipt: purchase order must be issued before recording receipts'
      using errcode = '22023';
  end if;
  if v_po_status = 'closed' then
    raise exception 'procurement_record_receipt: closed purchase orders cannot receive additional quantity'
      using errcode = '22023';
  end if;
  if v_po_status = 'cancelled' then
    raise exception 'procurement_record_receipt: cannot record receipt against a cancelled purchase order'
      using errcode = '22023';
  end if;

  -- Allocate a unique receipt number.
  v_receipt_number := null;
  for v_attempt in 1..10 loop
    v_receipt_number := 'GRN-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(floor(random() * 100000)::text, 5, '0');
    exit when not exists (
      select 1 from public.procurement_receipts r where r.receipt_number = v_receipt_number
    );
    v_receipt_number := null;
  end loop;

  if v_receipt_number is null then
    raise exception 'procurement_record_receipt: unable to allocate unique receipt_number'
      using errcode = '23505';
  end if;

  insert into public.procurement_receipts (
    purchase_order_id,
    receipt_number,
    received_quantity,
    delivery_note_number,
    condition_notes,
    recorded_by
  ) values (
    p_purchase_order_id,
    v_receipt_number,
    p_received_quantity,
    nullif(btrim(coalesce(p_delivery_note_number, '')), ''),
    nullif(btrim(coalesce(p_condition_notes, '')), ''),
    nullif(v_actor_id, '')
  )
  returning id into v_receipt_id;

  -- Compute new cumulative total and update the PO lifecycle.
  select coalesce(sum(r.received_quantity), 0)
    into v_cumulative
  from public.procurement_receipts r
  where r.purchase_order_id = p_purchase_order_id;

  select r.status
    into v_new_po_status
  from public.procurement_transition_purchase_order(
    p_purchase_order_id => p_purchase_order_id,
    p_action            => 'receive',
    p_reason            => nullif(btrim(coalesce(p_reason, '')), ''),
    p_received_quantity => v_cumulative
  ) as r;

  -- Write receipt audit event to time_series_points.
  select id into v_fact_type_id from public.fact_types where key = 'po_receipt_event';

  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id
  ) values (
    p_purchase_order_id,
    v_fact_type_id,
    now(),
    jsonb_strip_nulls(jsonb_build_object(
      'event_type',            'receipt_recorded',
      'receipt_id',            v_receipt_id,
      'receipt_number',        v_receipt_number,
      'received_quantity',     p_received_quantity,
      'cumulative_received',   v_cumulative,
      'delivery_note_number',  p_delivery_note_number,
      'reason',                p_reason,
      'po_status',             v_new_po_status
    )),
    v_receipt_number
  );

  receipt_id            := v_receipt_id;
  receipt_number        := v_receipt_number;
  purchase_order_id     := p_purchase_order_id;
  purchase_order_number := v_po_number;
  received_quantity     := p_received_quantity;
  cumulative_received   := v_cumulative;
  po_status             := v_new_po_status;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7b. RPC: procurement_record_supplier_invoice
--
-- Records a supplier invoice against a purchase order for use in three-way
-- matching.
-- ---------------------------------------------------------------------------

create or replace function public.procurement_record_supplier_invoice(
  p_purchase_order_id   uuid,
  p_invoice_number      text,
  p_invoice_date        date,
  p_invoiced_quantity   numeric,
  p_invoiced_total      numeric,
  p_invoiced_unit_price numeric  default null,
  p_currency_code       text     default 'USD',
  p_reason              text     default null
)
returns table (
  invoice_id            uuid,
  invoice_number        text,
  purchase_order_id     uuid,
  purchase_order_number text,
  invoiced_quantity     numeric,
  invoiced_total        numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_app_role      text := coalesce(public.ops_claim_app_role(), '');
  v_claims        jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  v_actor_id      text := coalesce(v_claims ->> 'sub', '');
  v_po_data       jsonb;
  v_po_status     text;
  v_po_number     text;
  v_invoice_id    uuid;
  v_fact_type_id  uuid;
begin
  if not (
    v_request_role = 'service_role'
    or (v_request_role = 'authenticated' and v_app_role in ('admin', 'branch_manager'))
  ) then
    raise exception 'procurement_record_supplier_invoice: access denied'
      using errcode = '42501';
  end if;

  if p_purchase_order_id is null then
    raise exception 'procurement_record_supplier_invoice: purchase_order_id is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_invoice_number, '')), '') is null then
    raise exception 'procurement_record_supplier_invoice: invoice_number is required'
      using errcode = '22023';
  end if;

  if p_invoice_date is null then
    raise exception 'procurement_record_supplier_invoice: invoice_date is required'
      using errcode = '22023';
  end if;

  if coalesce(p_invoiced_quantity, 0) <= 0 then
    raise exception 'procurement_record_supplier_invoice: invoiced_quantity must be positive'
      using errcode = '22023';
  end if;

  if coalesce(p_invoiced_total, 0) <= 0 then
    raise exception 'procurement_record_supplier_invoice: invoiced_total must be positive'
      using errcode = '22023';
  end if;

  select ev.data
    into v_po_data
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.id = p_purchase_order_id
    and e.entity_type = 'purchase_order';

  if not found then
    raise exception 'procurement_record_supplier_invoice: purchase_order % not found', p_purchase_order_id
      using errcode = '22023';
  end if;

  v_po_status := coalesce(v_po_data ->> 'status', 'draft');
  v_po_number := coalesce(v_po_data ->> 'purchase_order_number', '');

  if v_po_status = 'draft' then
    raise exception 'procurement_record_supplier_invoice: purchase order must be issued before recording invoices'
      using errcode = '22023';
  end if;
  if v_po_status = 'cancelled' then
    raise exception 'procurement_record_supplier_invoice: cannot record invoice against a cancelled purchase order'
      using errcode = '22023';
  end if;

  insert into public.procurement_supplier_invoices (
    purchase_order_id,
    invoice_number,
    invoice_date,
    invoiced_quantity,
    invoiced_unit_price,
    invoiced_total,
    currency_code,
    recorded_by
  ) values (
    p_purchase_order_id,
    btrim(p_invoice_number),
    p_invoice_date,
    p_invoiced_quantity,
    p_invoiced_unit_price,
    p_invoiced_total,
    coalesce(nullif(btrim(coalesce(p_currency_code, '')), ''), 'USD'),
    nullif(v_actor_id, '')
  )
  returning id into v_invoice_id;

  select id into v_fact_type_id from public.fact_types where key = 'po_match_event';

  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id
  ) values (
    p_purchase_order_id,
    v_fact_type_id,
    now(),
    jsonb_strip_nulls(jsonb_build_object(
      'event_type',        'invoice_recorded',
      'invoice_id',        v_invoice_id,
      'invoice_number',    p_invoice_number,
      'invoiced_quantity', p_invoiced_quantity,
      'invoiced_total',    p_invoiced_total,
      'reason',            p_reason
    )),
    p_invoice_number
  );

  invoice_id            := v_invoice_id;
  invoice_number        := p_invoice_number;
  purchase_order_id     := p_purchase_order_id;
  purchase_order_number := v_po_number;
  invoiced_quantity     := p_invoiced_quantity;
  invoiced_total        := p_invoiced_total;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7c. RPC: procurement_run_po_match
--
-- Executes a two-way or three-way PO match and creates a match outcome record.
--
-- Two-way: compares PO ordered_quantity vs the most recent receipt's
-- cumulative received_quantity.  Discrepancy when received != ordered
-- (over-delivery or under-delivery).
--
-- Three-way: performs two-way checks plus compares the most recent supplier
-- invoice's invoiced_quantity vs received_quantity, and (if both the invoice
-- and PO carry unit-price / total data) compares invoiced_total vs the PO's
-- ordered_total.
--
-- A match outcome with outcome='discrepancy' sets hold_downstream=true,
-- blocking downstream completion until resolved via
-- procurement_resolve_match_discrepancy.
-- ---------------------------------------------------------------------------

create or replace function public.procurement_run_po_match(
  p_purchase_order_id uuid,
  p_match_type        text    default 'two_way',
  p_receipt_id        uuid    default null,
  p_invoice_id        uuid    default null,
  p_reason            text    default null
)
returns table (
  match_outcome_id    uuid,
  purchase_order_id   uuid,
  match_type          text,
  outcome             text,
  hold_downstream     boolean,
  discrepancy_details jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role    text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_app_role        text := coalesce(public.ops_claim_app_role(), '');
  v_po_data         jsonb;
  v_po_number       text;
  v_ordered_qty     numeric;
  v_ordered_total   numeric;
  v_ordered_unit_price numeric;
  v_receipt_row     record;
  v_invoice_row     record;
  v_total_received  numeric;
  v_qty_variance    numeric;
  v_price_variance  numeric;
  v_total_variance  numeric;
  v_outcome         text;
  v_hold            boolean;
  v_discrepancies   jsonb;
  v_match_type      text;
  v_outcome_id      uuid;
  v_fact_type_id    uuid;
  v_resolved_invoice_id uuid;
begin
  if not (
    v_request_role = 'service_role'
    or (v_request_role = 'authenticated' and v_app_role in ('admin', 'branch_manager'))
  ) then
    raise exception 'procurement_run_po_match: access denied'
      using errcode = '42501';
  end if;

  if p_purchase_order_id is null then
    raise exception 'procurement_run_po_match: purchase_order_id is required'
      using errcode = '22023';
  end if;

  v_match_type := lower(btrim(coalesce(p_match_type, 'two_way')));
  if v_match_type not in ('two_way', 'three_way') then
    raise exception 'procurement_run_po_match: match_type must be two_way or three_way'
      using errcode = '22023';
  end if;

  select ev.data
    into v_po_data
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
  where e.id = p_purchase_order_id
    and e.entity_type = 'purchase_order';

  if not found then
    raise exception 'procurement_run_po_match: purchase_order % not found', p_purchase_order_id
      using errcode = '22023';
  end if;

  v_po_number          := coalesce(v_po_data ->> 'purchase_order_number', '');
  v_ordered_qty        := coalesce((v_po_data ->> 'ordered_quantity')::numeric, 0);
  v_ordered_total      := (v_po_data ->> 'ordered_total')::numeric;
  v_ordered_unit_price := (v_po_data ->> 'ordered_unit_price')::numeric;

  -- Resolve the receipt to match against.
  if p_receipt_id is not null then
    select r.id, r.received_quantity, r.receipt_number
      into v_receipt_row
    from public.procurement_receipts r
    where r.id = p_receipt_id
      and r.purchase_order_id = p_purchase_order_id;
    if not found then
      raise exception 'procurement_run_po_match: receipt % not found for purchase_order %',
        p_receipt_id, p_purchase_order_id
        using errcode = '22023';
    end if;
  end if;

  -- Use cumulative received from all receipts for the quantity comparison.
  select coalesce(sum(r.received_quantity), 0)
    into v_total_received
  from public.procurement_receipts r
  where r.purchase_order_id = p_purchase_order_id;

  -- Resolve the invoice for three-way match.
  if v_match_type = 'three_way' then
    if p_invoice_id is not null then
      select si.id, si.invoiced_quantity, si.invoiced_unit_price, si.invoiced_total, si.invoice_number
        into v_invoice_row
      from public.procurement_supplier_invoices si
      where si.id = p_invoice_id
        and si.purchase_order_id = p_purchase_order_id;
      if not found then
        raise exception 'procurement_run_po_match: invoice % not found for purchase_order %',
          p_invoice_id, p_purchase_order_id
          using errcode = '22023';
      end if;
    else
      -- Use the most recent invoice for this PO.
      select si.id, si.invoiced_quantity, si.invoiced_unit_price, si.invoiced_total, si.invoice_number
        into v_invoice_row
      from public.procurement_supplier_invoices si
      where si.purchase_order_id = p_purchase_order_id
      order by si.created_at desc
      limit 1;
      if not found then
        raise exception 'procurement_run_po_match: no supplier invoice found for purchase_order % (required for three_way match)', p_purchase_order_id
          using errcode = '22023';
      end if;
    end if;
    v_resolved_invoice_id := coalesce(p_invoice_id, v_invoice_row.id);
  end if;

  -- Build discrepancy list and compute variances.
  v_discrepancies := '[]'::jsonb;

  -- Quantity variance: ordered vs received.
  v_qty_variance := v_ordered_qty - v_total_received;
  if v_qty_variance <> 0 then
    v_discrepancies := v_discrepancies || jsonb_build_object(
      'type',            'quantity',
      'dimension',       'ordered_vs_received',
      'ordered_quantity', v_ordered_qty,
      'received_quantity', v_total_received,
      'variance',        v_qty_variance
    );
  end if;

  -- Three-way additional checks.
  if v_match_type = 'three_way' then
    -- Invoice qty vs received qty.
    if v_invoice_row.invoiced_quantity <> v_total_received then
      v_discrepancies := v_discrepancies || jsonb_build_object(
        'type',              'quantity',
        'dimension',         'invoiced_vs_received',
        'invoiced_quantity', v_invoice_row.invoiced_quantity,
        'received_quantity', v_total_received,
        'variance',          v_invoice_row.invoiced_quantity - v_total_received
      );
    end if;

    -- Unit price variance (only if PO carries ordered_unit_price).
    if v_ordered_unit_price is not null and v_invoice_row.invoiced_unit_price is not null then
      v_price_variance := v_ordered_unit_price - v_invoice_row.invoiced_unit_price;
      if v_price_variance <> 0 then
        v_discrepancies := v_discrepancies || jsonb_build_object(
          'type',                'price',
          'dimension',           'ordered_unit_price_vs_invoiced',
          'ordered_unit_price',  v_ordered_unit_price,
          'invoiced_unit_price', v_invoice_row.invoiced_unit_price,
          'variance',            v_price_variance
        );
      end if;
    end if;

    -- Total variance (only if PO carries ordered_total).
    if v_ordered_total is not null then
      v_total_variance := v_ordered_total - v_invoice_row.invoiced_total;
      if v_total_variance <> 0 then
        v_discrepancies := v_discrepancies || jsonb_build_object(
          'type',           'total',
          'dimension',      'ordered_total_vs_invoiced',
          'ordered_total',  v_ordered_total,
          'invoiced_total', v_invoice_row.invoiced_total,
          'variance',       v_total_variance
        );
      end if;
    end if;
  end if;

  -- Determine outcome.
  if jsonb_array_length(v_discrepancies) = 0 then
    v_outcome := 'matched';
    v_hold    := false;
  else
    v_outcome := 'discrepancy';
    v_hold    := true;
  end if;

  insert into public.procurement_po_match_outcomes (
    purchase_order_id,
    receipt_id,
    invoice_id,
    match_type,
    outcome,
    quantity_variance,
    price_variance,
    total_variance,
    discrepancy_details,
    hold_downstream
  ) values (
    p_purchase_order_id,
    p_receipt_id,
    case when v_match_type = 'three_way' then v_resolved_invoice_id else null end,
    v_match_type,
    v_outcome,
    nullif(v_qty_variance, 0),
    nullif(v_price_variance, 0),
    nullif(v_total_variance, 0),
    v_discrepancies,
    v_hold
  )
  returning id into v_outcome_id;

  -- Update receipt and invoice status to reflect match result.
  update public.procurement_receipts pr
  set status = case
    when v_outcome = 'matched' then 'matched'
    else 'discrepancy_held'
  end
  where pr.purchase_order_id = p_purchase_order_id
    and pr.status = 'pending_match';

  if v_match_type = 'three_way' then
    update public.procurement_supplier_invoices
    set status = case
      when v_outcome = 'matched' then 'matched'
      else 'discrepancy_held'
    end
    where id = v_resolved_invoice_id
      and status = 'pending_match';
  end if;

  select id into v_fact_type_id from public.fact_types where key = 'po_match_event';

  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id
  ) values (
    p_purchase_order_id,
    v_fact_type_id,
    now(),
    jsonb_strip_nulls(jsonb_build_object(
      'event_type',          'match_run',
      'match_outcome_id',    v_outcome_id,
      'match_type',          v_match_type,
      'outcome',             v_outcome,
      'hold_downstream',     v_hold,
      'discrepancy_count',   jsonb_array_length(v_discrepancies),
      'reason',              p_reason
    )),
    v_po_number
  );

  match_outcome_id    := v_outcome_id;
  purchase_order_id   := p_purchase_order_id;
  match_type          := v_match_type;
  outcome             := v_outcome;
  hold_downstream     := v_hold;
  discrepancy_details := v_discrepancies;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7d. RPC: procurement_resolve_match_discrepancy
--
-- Records a reviewer's decision on a discrepancy outcome, clearing the
-- hold_downstream flag so downstream processing can continue.
-- ---------------------------------------------------------------------------

create or replace function public.procurement_resolve_match_discrepancy(
  p_match_outcome_id  uuid,
  p_resolution        text,
  p_review_notes      text  default null
)
returns table (
  match_outcome_id    uuid,
  purchase_order_id   uuid,
  outcome             text,
  hold_downstream     boolean,
  review_resolution   text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_app_role     text := coalesce(public.ops_claim_app_role(), '');
  v_claims       jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  v_actor_id     text := coalesce(v_claims ->> 'sub', '');
  v_outcome_row  record;
  v_resolution   text;
  v_fact_type_id uuid;
begin
  if not (
    v_request_role = 'service_role'
    or (v_request_role = 'authenticated' and v_app_role in ('admin', 'branch_manager'))
  ) then
    raise exception 'procurement_resolve_match_discrepancy: access denied'
      using errcode = '42501';
  end if;

  if p_match_outcome_id is null then
    raise exception 'procurement_resolve_match_discrepancy: match_outcome_id is required'
      using errcode = '22023';
  end if;

  v_resolution := lower(btrim(coalesce(p_resolution, '')));
  if v_resolution not in ('accepted', 'rejected', 'escalated') then
    raise exception 'procurement_resolve_match_discrepancy: resolution must be accepted, rejected, or escalated'
      using errcode = '22023';
  end if;

  select mo.id, mo.purchase_order_id, mo.outcome, mo.hold_downstream, mo.invoice_id
    into v_outcome_row
  from public.procurement_po_match_outcomes mo
  where mo.id = p_match_outcome_id;

  if not found then
    raise exception 'procurement_resolve_match_discrepancy: match_outcome % not found', p_match_outcome_id
      using errcode = '22023';
  end if;

  if v_outcome_row.outcome = 'matched' then
    raise exception 'procurement_resolve_match_discrepancy: outcome % has no discrepancy to resolve', p_match_outcome_id
      using errcode = '22023';
  end if;

  update public.procurement_po_match_outcomes
  set
    outcome           = 'pending_review',
    hold_downstream   = (v_resolution = 'escalated'),
    reviewed_by       = nullif(v_actor_id, ''),
    reviewed_at       = now(),
    review_resolution = v_resolution,
    review_notes      = nullif(btrim(coalesce(p_review_notes, '')), '')
  where id = p_match_outcome_id;

  -- If accepted or rejected (not escalated) clear the hold on associated records,
  -- scoped to the rows tied to this specific outcome so that other open discrepancy
  -- outcomes on the same PO are not prematurely cleared.
  if v_resolution in ('accepted', 'rejected') then
    -- Receipts: clear receipts on this PO not still specifically held by another
    -- active outcome (outcomes that name a receipt_id = pr.id).  Outcomes without
    -- a specific receipt_id (aggregate two-way matches) do not block clearance.
    update public.procurement_receipts pr
    set status = 'discrepancy_resolved'
    where pr.purchase_order_id = v_outcome_row.purchase_order_id
      and pr.status = 'discrepancy_held'
      and not exists (
        select 1
          from public.procurement_po_match_outcomes mo2
         where mo2.purchase_order_id = v_outcome_row.purchase_order_id
           and mo2.id <> p_match_outcome_id
           and mo2.hold_downstream = true
           and mo2.receipt_id = pr.id
      );

    -- Invoices: only clear the invoice explicitly tied to this outcome (if any).
    -- A two-way outcome has invoice_id = NULL and must not touch unrelated invoice holds.
    if v_outcome_row.invoice_id is not null then
      update public.procurement_supplier_invoices si
      set status = 'discrepancy_resolved'
      where si.id = v_outcome_row.invoice_id
        and si.status = 'discrepancy_held'
        and not exists (
          select 1
            from public.procurement_po_match_outcomes mo2
           where mo2.invoice_id = v_outcome_row.invoice_id
             and mo2.id <> p_match_outcome_id
             and mo2.hold_downstream = true
        );
    end if;
  end if;

  select id into v_fact_type_id from public.fact_types where key = 'po_match_event';

  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id
  ) values (
    v_outcome_row.purchase_order_id,
    v_fact_type_id,
    now(),
    jsonb_strip_nulls(jsonb_build_object(
      'event_type',        'discrepancy_resolved',
      'match_outcome_id',  p_match_outcome_id,
      'resolution',        v_resolution,
      'review_notes',      p_review_notes,
      'hold_downstream',   (v_resolution = 'escalated'),
      'reviewed_by',       nullif(v_actor_id, '')
    )),
    p_match_outcome_id::text
  );

  match_outcome_id  := p_match_outcome_id;
  purchase_order_id := v_outcome_row.purchase_order_id;
  outcome           := 'pending_review';
  hold_downstream   := (v_resolution = 'escalated');
  review_resolution := v_resolution;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7e. RPC: procurement_attach_warranty
--
-- Attaches warranty metadata to a purchased asset or part entity.  The record
-- is queryable from the operational view v_procurement_warranty_records.
-- ---------------------------------------------------------------------------

create or replace function public.procurement_attach_warranty(
  p_entity_id             uuid,
  p_purchase_order_id     uuid    default null,
  p_receipt_id            uuid    default null,
  p_warranty_provider     text    default null,
  p_serial_number         text    default null,
  p_warranty_start_date   date    default null,
  p_warranty_end_date     date    default null,
  p_warranty_type         text    default 'full',
  p_warranty_terms        text    default null,
  p_warranty_document_ref text    default null,
  p_metadata              jsonb   default '{}'::jsonb
)
returns table (
  warranty_record_id    uuid,
  entity_id             uuid,
  purchase_order_id     uuid,
  warranty_provider     text,
  warranty_start_date   date,
  warranty_end_date     date,
  warranty_type         text,
  is_in_warranty        boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'role',
    ''
  );
  v_app_role     text := coalesce(public.ops_claim_app_role(), '');
  v_claims       jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  v_actor_id     text := coalesce(v_claims ->> 'sub', '');
  v_warranty_id  uuid;
  v_w_type       text;
  v_fact_type_id uuid;
begin
  if not (
    v_request_role = 'service_role'
    or (v_request_role = 'authenticated' and v_app_role in ('admin', 'branch_manager'))
  ) then
    raise exception 'procurement_attach_warranty: access denied'
      using errcode = '42501';
  end if;

  if p_entity_id is null then
    raise exception 'procurement_attach_warranty: entity_id is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_warranty_provider, '')), '') is null then
    raise exception 'procurement_attach_warranty: warranty_provider is required'
      using errcode = '22023';
  end if;

  if p_warranty_start_date is null then
    raise exception 'procurement_attach_warranty: warranty_start_date is required'
      using errcode = '22023';
  end if;

  if p_warranty_end_date is null then
    raise exception 'procurement_attach_warranty: warranty_end_date is required'
      using errcode = '22023';
  end if;

  if p_warranty_end_date < p_warranty_start_date then
    raise exception 'procurement_attach_warranty: warranty_end_date must be on or after warranty_start_date'
      using errcode = '22023';
  end if;

  v_w_type := lower(btrim(coalesce(p_warranty_type, 'full')));
  if v_w_type not in ('parts', 'labor', 'full', 'extended', 'other') then
    raise exception 'procurement_attach_warranty: warranty_type must be parts, labor, full, extended, or other'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.entities where id = p_entity_id
  ) then
    raise exception 'procurement_attach_warranty: entity % not found', p_entity_id
      using errcode = '22023';
  end if;

  if p_purchase_order_id is not null and not exists (
    select 1 from public.entities
    where id = p_purchase_order_id and entity_type = 'purchase_order'
  ) then
    raise exception 'procurement_attach_warranty: purchase_order % not found', p_purchase_order_id
      using errcode = '22023';
  end if;

  if p_receipt_id is not null and not exists (
    select 1 from public.procurement_receipts where id = p_receipt_id
  ) then
    raise exception 'procurement_attach_warranty: receipt % not found', p_receipt_id
      using errcode = '22023';
  end if;

  insert into public.procurement_warranty_records (
    entity_id,
    purchase_order_id,
    receipt_id,
    warranty_provider,
    serial_number,
    warranty_start_date,
    warranty_end_date,
    warranty_type,
    warranty_terms,
    warranty_document_ref,
    metadata,
    recorded_by
  ) values (
    p_entity_id,
    p_purchase_order_id,
    p_receipt_id,
    btrim(p_warranty_provider),
    nullif(btrim(coalesce(p_serial_number, '')), ''),
    p_warranty_start_date,
    p_warranty_end_date,
    v_w_type,
    nullif(btrim(coalesce(p_warranty_terms, '')), ''),
    nullif(btrim(coalesce(p_warranty_document_ref, '')), ''),
    coalesce(p_metadata, '{}'::jsonb),
    nullif(v_actor_id, '')
  )
  returning id into v_warranty_id;

  select id into v_fact_type_id from public.fact_types where key = 'warranty_event';

  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id
  ) values (
    p_entity_id,
    v_fact_type_id,
    now(),
    jsonb_strip_nulls(jsonb_build_object(
      'event_type',           'warranty_attached',
      'warranty_record_id',   v_warranty_id,
      'purchase_order_id',    p_purchase_order_id,
      'warranty_provider',    p_warranty_provider,
      'warranty_type',        v_w_type,
      'warranty_start_date',  p_warranty_start_date,
      'warranty_end_date',    p_warranty_end_date
    )),
    v_warranty_id::text
  );

  warranty_record_id  := v_warranty_id;
  entity_id           := p_entity_id;
  purchase_order_id   := p_purchase_order_id;
  warranty_provider   := p_warranty_provider;
  warranty_start_date := p_warranty_start_date;
  warranty_end_date   := p_warranty_end_date;
  warranty_type       := v_w_type;
  is_in_warranty      := (p_warranty_end_date >= current_date);
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.procurement_record_receipt(uuid, numeric, text, text, text) from public, anon;
grant execute on function public.procurement_record_receipt(uuid, numeric, text, text, text) to authenticated, service_role;

revoke all on function public.procurement_record_supplier_invoice(uuid, text, date, numeric, numeric, numeric, text, text) from public, anon;
grant execute on function public.procurement_record_supplier_invoice(uuid, text, date, numeric, numeric, numeric, text, text) to authenticated, service_role;

revoke all on function public.procurement_run_po_match(uuid, text, uuid, uuid, text) from public, anon;
grant execute on function public.procurement_run_po_match(uuid, text, uuid, uuid, text) to authenticated, service_role;

revoke all on function public.procurement_resolve_match_discrepancy(uuid, text, text) from public, anon;
grant execute on function public.procurement_resolve_match_discrepancy(uuid, text, text) to authenticated, service_role;

revoke all on function public.procurement_attach_warranty(uuid, uuid, uuid, text, text, date, date, text, text, text, jsonb) from public, anon;
grant execute on function public.procurement_attach_warranty(uuid, uuid, uuid, text, text, date, date, text, text, text, jsonb) to authenticated, service_role;

grant select on public.v_procurement_receipts          to authenticated, service_role;
grant select on public.v_procurement_po_match_outcomes to authenticated, service_role;
grant select on public.v_procurement_warranty_records  to authenticated, service_role;
