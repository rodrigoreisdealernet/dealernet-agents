do $$
declare
  v_count int;
  v_provider_connector text;
  v_provider_audit_connector text;
begin
  select count(*) into v_count
    from public.integration_config
   where connector_key is null;

  if v_count <> 0 then
    raise exception 'FAIL replay: integration_config.connector_key still null for % rows', v_count;
  end if;

  select connector_key into v_provider_connector
    from public.integration_config
   where provider = 'Descartes Provider';

  if v_provider_connector is distinct from 'descartes_provider' then
    raise exception 'FAIL replay: provider fallback expected connector_key=descartes_provider, got %', v_provider_connector;
  end if;

  select count(*) into v_count
    from public.integration_config
   where provider_key = 'descartes_pk'
     and connector_key = 'descartes_pk';

  if v_count <> 1 then
    raise exception 'FAIL replay: provider_key fallback did not preserve descartes_pk connector_key';
  end if;

  select count(*) into v_count
    from public.integration_config_audit
   where connector_key is null;

  if v_count <> 0 then
    raise exception 'FAIL replay: integration_config_audit.connector_key still null for % rows', v_count;
  end if;

  select connector_key into v_provider_audit_connector
    from public.integration_config_audit
   where provider = 'Descartes Provider';

  if v_provider_audit_connector is distinct from 'descartes_provider' then
    raise exception 'FAIL replay: audit provider fallback expected connector_key=descartes_provider, got %', v_provider_audit_connector;
  end if;

  raise notice 'PASS: replay-order provider/provider_key compatibility backfill verified';
end;
$$;
