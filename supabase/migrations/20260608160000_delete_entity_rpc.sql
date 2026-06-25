-- Introduce a security-definer delete_entity RPC so the UI can delete
-- entities via a guarded RPC call instead of a direct authenticated DELETE
-- (the authenticated role only has SELECT/INSERT/UPDATE on entities).

create or replace function delete_entity(
  p_entity_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
begin
  v_request_role := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role', '');

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'delete_entity requires authenticated admin or branch_manager access'
      using errcode = '42501';
  end if;

  delete from entities where id = p_entity_id;

  if not found then
    raise exception 'Entity % not found', p_entity_id
      using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.delete_entity(uuid) from public, anon;
grant execute on function public.delete_entity(uuid) to authenticated, service_role;
