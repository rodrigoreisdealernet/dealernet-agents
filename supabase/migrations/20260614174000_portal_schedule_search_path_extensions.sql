-- Keep shipped migration immutable: patch portal_get_contract_schedule via additive migration.
-- Ensures digest() resolves on reset-path runs where pgcrypto functions live in extensions schema.
alter function public.portal_get_contract_schedule(uuid, text)
  set search_path to public, extensions, pg_temp;
