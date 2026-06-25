-- Ensure demo portal URL helper remains deterministic across environments where
-- pgcrypto helpers may be installed in different schemas.
-- Use the known SHA-256 hash for the fixed demo scope token to avoid runtime
-- dependency on digest() resolution.

create or replace function public.portal_get_demo_portal_url()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract_id uuid;
  v_token_hash  text;
  v_demo_token  constant text := 'wynne-demo-portal-scope-001';
  v_demo_token_hash constant text := '20aac617825fe59b100a0a010687e89b728732c716a9676a3bc1a21b16e0c63d';
begin
  select e.id
    into v_contract_id
  from public.entities e
  where e.entity_type = 'rental_contract'
    and e.source_record_id = 'demo-baseline-rental-contract-002'
  limit 1;

  if v_contract_id is null then
    return null;
  end if;

  select s.token_hash
    into v_token_hash
  from public.portal_contract_scope_tokens s
  where s.contract_id = v_contract_id
    and s.token_hash = v_demo_token_hash;

  if not found then
    return null;
  end if;

  return format('/portal/schedule/%s?scope=%s', v_contract_id::text, v_demo_token);
end;
$$;

revoke all on function public.portal_get_demo_portal_url() from public;
grant execute on function public.portal_get_demo_portal_url() to service_role;
