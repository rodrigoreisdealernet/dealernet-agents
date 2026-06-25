-- ---------------------------------------------------------------------------
-- portal_get_demo_intake_url
--
-- Returns the portal intake URL for the seeded demo token so the e2e-dev
-- workflow can exercise the portal intake E2E journey without hard-coding
-- a database row ID. Follows the same pattern as portal_get_demo_portal_url.
--
-- The demo token 'dia-demo-intake-token-001' is a non-secret value used
-- only in dev/CI. It is seeded by seed.sql.
-- ---------------------------------------------------------------------------

create or replace function public.portal_get_demo_intake_url()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token_id        uuid;
  v_demo_token      constant text := 'dia-demo-intake-token-001';
  v_demo_token_hash constant text := '5467ab75215992bc249e670aa6827ed439067156ec4d6647f5f21fb37bf29c26';
begin
  select id
    into v_token_id
  from public.portal_intake_scope_tokens
  where token_hash = v_demo_token_hash;

  if v_token_id is null then
    return null;
  end if;

  -- URL format: /portal/intake/:tokenId#token=<rawToken>
  -- The raw token is delivered in the hash fragment so it is never sent to
  -- the server (same security contract as the issued production tokens).
  return format('/portal/intake/%s#token=%s', v_token_id::text, v_demo_token);
end;
$$;

revoke all on function public.portal_get_demo_intake_url() from public;
grant execute on function public.portal_get_demo_intake_url() to service_role;
