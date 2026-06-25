begin;

do $$
declare
  v_http_versions int;
  v_blank_versions int;
  v_local_versions int;
  v_http_current_image text;
  v_blank_current_image text;
  v_local_current_image text;
  v_http_historical_legacy int;
  v_blank_historical_blank int;
begin
  select count(*) into v_http_versions
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id = 'catalog-migration-asset-http';

  if v_http_versions <> 2 then
    raise exception 'Expected HTTP legacy asset to have 2 versions after SCD2 backfill, found %', v_http_versions;
  end if;

  select ev.data->>'image_url' into v_http_current_image
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id = 'catalog-migration-asset-http'
    and ev.is_current;

  if v_http_current_image <> '/equipment-images/earthmoving.svg' then
    raise exception 'Expected HTTP legacy asset current image_url to be /equipment-images/earthmoving.svg, got %', v_http_current_image;
  end if;

  select count(*) into v_http_historical_legacy
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id = 'catalog-migration-asset-http'
    and not ev.is_current
    and ev.data->>'image_url' = 'https://legacy.example.com/excavator.png';

  if v_http_historical_legacy <> 1 then
    raise exception 'Expected HTTP legacy asset historical version to preserve original external image_url';
  end if;

  select count(*) into v_blank_versions
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id = 'catalog-migration-asset-blank';

  if v_blank_versions <> 2 then
    raise exception 'Expected blank-image asset to have 2 versions after SCD2 backfill, found %', v_blank_versions;
  end if;

  select ev.data->>'image_url' into v_blank_current_image
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id = 'catalog-migration-asset-blank'
    and ev.is_current;

  if v_blank_current_image <> '/equipment-images/earthmoving.svg' then
    raise exception 'Expected blank-image asset current image_url to be /equipment-images/earthmoving.svg, got %', v_blank_current_image;
  end if;

  select count(*) into v_blank_historical_blank
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id = 'catalog-migration-asset-blank'
    and not ev.is_current
    and coalesce(ev.data->>'image_url', '') = '';

  if v_blank_historical_blank <> 1 then
    raise exception 'Expected blank-image asset historical version to preserve blank image_url';
  end if;

  select count(*) into v_local_versions
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id = 'catalog-migration-asset-local';

  if v_local_versions <> 1 then
    raise exception 'Expected already-local asset to remain single-version, found % versions', v_local_versions;
  end if;

  select ev.data->>'image_url' into v_local_current_image
  from entity_versions ev
  join entities e on e.id = ev.entity_id
  where e.source_record_id = 'catalog-migration-asset-local'
    and ev.is_current;

  if v_local_current_image <> '/equipment-images/earthmoving.svg' then
    raise exception 'Expected already-local asset image_url to remain /equipment-images/earthmoving.svg, got %', v_local_current_image;
  end if;
end
$$;

rollback;
