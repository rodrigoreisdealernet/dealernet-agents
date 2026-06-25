-- Add resulting_asset_status as an explicit extracted column to
-- v_rental_contract_line_current so that PostgREST filters on this field
-- use a first-class column name instead of the JSONB arrow operator syntax
-- (which is percent-encoded in URLs and may not decode reliably on all
-- PostgREST/proxy configurations).
--
-- security_invoker = true ensures the caller's RLS policies apply when the
-- view is queried inside SECURITY INVOKER functions (e.g. fleet-availability
-- calendar helper), preserving the RLS enforcement chain.
--
-- All other columns are unchanged from 20251210000000_rental_order_contract.sql.
-- The new column (ev.data->>'resulting_asset_status' as resulting_asset_status) is appended
-- last so CREATE OR REPLACE VIEW preserves the existing column order (required by Postgres).

create or replace view v_rental_contract_line_current with (security_invoker = true) as
select
    e.id                                                  as entity_id,
    ev.id                                                 as version_id,
    ev.version_number,
    ev.data->>'status'                                    as status,
    ev.data->>'contract_id'                               as contract_id,
    ev.data->>'asset_id'                                  as asset_id,
    ev.data->>'category_id'                               as category_id,
    ev.data->>'rental_type'                               as rental_type,
    ev.data->>'rate_type'                                 as rate_type,
    (ev.data->>'rate_amount')::numeric                    as rate_amount,
    ev.data->>'actual_start'                              as actual_start,
    ev.data->>'actual_end'                                as actual_end,
    ev.valid_from,
    ev.valid_to,
    ev.data                                               as data,
    ev.data->>'resulting_asset_status'                    as resulting_asset_status
from entities e
join entity_versions ev on ev.entity_id = e.id and ev.is_current
where e.entity_type = 'rental_contract_line';

grant select on v_rental_contract_line_current to anon, authenticated;
