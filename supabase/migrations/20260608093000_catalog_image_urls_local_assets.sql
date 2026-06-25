-- Backfill local catalog images for rental assets by category.
-- This avoids runtime dependency on externally hosted image providers.
with mapped(category_name, image_url) as (
  values
    ('Earthmoving Excavators', '/equipment-images/earthmoving.svg'),
    ('Boom and Scissor Lifts', '/equipment-images/boom-scissor-lifts.svg'),
    ('Power & Climate Control', '/equipment-images/power-climate.svg'),
    ('Compaction Rollers', '/equipment-images/compaction-rollers.svg'),
    ('Worksite Attachments', '/equipment-images/worksite-attachments.svg')
),
target as (
  select
    ev.entity_id,
    ev.data as current_data,
    mapped.image_url
  from entity_versions ev
  join entities e
    on e.id = ev.entity_id
   and e.entity_type = 'asset'
  join relationships_v2 rel
    on rel.child_id = e.id
   and rel.relationship_type = 'asset_category_has_asset'
   and rel.is_current = true
  join entity_versions cat_ev
    on cat_ev.entity_id = rel.parent_id
   and cat_ev.is_current = true
  join mapped
    on mapped.category_name = cat_ev.data ->> 'name'
  where ev.is_current = true
    and (
      coalesce(ev.data ->> 'image_url', '') = ''
      or ev.data ->> 'image_url' like 'http://%'
      or ev.data ->> 'image_url' like 'https://%'
    )
)
insert into entity_versions (entity_id, version_number, data)
select
  target.entity_id,
  coalesce(max(ev_all.version_number), 0) + 1 as version_number,
  jsonb_set(target.current_data, '{image_url}', to_jsonb(target.image_url), true) as data
from target
join entity_versions ev_all
  on ev_all.entity_id = target.entity_id
group by target.entity_id, target.current_data, target.image_url;
