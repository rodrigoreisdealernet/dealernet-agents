-- Ensure portal off-rent scope-token functions can resolve pgcrypto digest()
-- in Supabase reset-path environments where pgcrypto lives in extensions schema.

alter function public.portal_submit_off_rent_request(uuid, uuid, text, text)
  set search_path = public, extensions, pg_temp;

alter function public.portal_list_off_rent_requests(uuid, text)
  set search_path = public, extensions, pg_temp;
