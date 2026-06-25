begin;
set local request.jwt.claim.role = 'service_role';

do $$
declare
  v_category uuid;
  v_asset_http uuid;
  v_asset_blank uuid;
  v_asset_local uuid;
begin
  select entity_id into v_category
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_source_record_id => 'catalog-migration-category-earthmoving',
    p_data => jsonb_build_object('name', 'Earthmoving Excavators')
  );

  select entity_id into v_asset_http
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'catalog-migration-asset-http',
    p_data => jsonb_build_object(
      'name', 'Legacy HTTP image asset',
      'image_url', 'https://legacy.example.com/excavator.png'
    )
  );

  perform rental_upsert_relationship('asset_category_has_asset', v_category, v_asset_http);

  select entity_id into v_asset_blank
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'catalog-migration-asset-blank',
    p_data => jsonb_build_object(
      'name', 'Legacy blank image asset',
      'image_url', ''
    )
  );

  perform rental_upsert_relationship('asset_category_has_asset', v_category, v_asset_blank);

  select entity_id into v_asset_local
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset',
    p_source_record_id => 'catalog-migration-asset-local',
    p_data => jsonb_build_object(
      'name', 'Already local image asset',
      'image_url', '/equipment-images/earthmoving.svg'
    )
  );

  perform rental_upsert_relationship('asset_category_has_asset', v_category, v_asset_local);
end
$$;

commit;
