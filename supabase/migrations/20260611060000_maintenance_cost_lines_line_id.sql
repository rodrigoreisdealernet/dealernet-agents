-- Add a caller-supplied idempotency key column (line_id) to maintenance_cost_lines.
--
-- The original design derived the row `id` from business-data fields, which
-- caused two identical line items on the same work order to collapse into a
-- single row.  This migration introduces a stable per-line key so that retries
-- are idempotent on (maintenance_record_id, line_id) while allowing two
-- legitimately duplicate charges to coexist as separate rows.
--
-- The column is nullable and defaults to the row id so that any rows inserted
-- before this migration are not broken.

alter table public.maintenance_cost_lines
  add column if not exists line_id text;

-- Back-fill existing rows so the unique constraint can be applied.
update public.maintenance_cost_lines
  set line_id = id::text
  where line_id is null;

alter table public.maintenance_cost_lines
  alter column line_id set not null;

alter table public.maintenance_cost_lines
  add constraint uq_maintenance_cost_lines_record_line unique (maintenance_record_id, line_id);
