create or replace function rental_build_alternative_suggestions(
  p_branch_id uuid,
  p_asset_category_id uuid,
  p_quantity int,
  p_start_date date,
  p_end_date date,
  p_limit int default 5
)
returns jsonb
language sql
stable
as $$
with requested as (
  select
    a.branch_id,
    a.branch_name,
    a.asset_category_id,
    a.asset_category_name,
    rb.data ->> 'region_id' as branch_region_id,
    rb.data ->> 'state' as branch_state,
    rb.data ->> 'city' as branch_city,
    (
      select assets.ownership_type
      from rental_current_assets assets
      where assets.current_branch_id = a.branch_id
        and assets.current_asset_category_id = a.asset_category_id
        and coalesce(assets.operational_status, '') = 'available'
      group by assets.ownership_type
      order by count(*) desc, assets.ownership_type asc
      limit 1
    ) as preferred_ownership_type
  from rental_asset_availability_current a
  left join rental_current_branches rb
    on rb.entity_id = a.branch_id
  where a.branch_id = p_branch_id
    and a.asset_category_id = p_asset_category_id
),
candidates as (
  select
    a.branch_id,
    a.branch_name,
    a.asset_category_id,
    a.asset_category_name,
    scoped.available_assets,
    scoped.shortage_reason,
    case
      when a.asset_category_id = p_asset_category_id and a.branch_id <> p_branch_id then 1
      when a.branch_id = p_branch_id and a.asset_category_id <> p_asset_category_id then 2
      else 9
    end as suggestion_priority,
    case
      when a.branch_id = p_branch_id then 0
      when coalesce(candidate_branch.data ->> 'city', '') <> ''
           and candidate_branch.data ->> 'city' = req.branch_city then 1
      when coalesce(candidate_branch.data ->> 'region_id', '') <> ''
           and candidate_branch.data ->> 'region_id' = req.branch_region_id then 2
      when coalesce(candidate_branch.data ->> 'state', '') <> ''
           and candidate_branch.data ->> 'state' = req.branch_state then 3
      else 4
    end as transfer_cost_rank,
    case
      when a.branch_id = p_branch_id then 'none'
      when coalesce(candidate_branch.data ->> 'city', '') <> ''
           and candidate_branch.data ->> 'city' = req.branch_city then 'intra_city'
      when coalesce(candidate_branch.data ->> 'region_id', '') <> ''
           and candidate_branch.data ->> 'region_id' = req.branch_region_id then 'intra_region'
      when coalesce(candidate_branch.data ->> 'state', '') <> ''
           and candidate_branch.data ->> 'state' = req.branch_state then 'intra_state'
      else 'inter_state'
    end as transfer_cost_band,
    case
      when a.asset_category_id = p_asset_category_id and a.branch_id <> p_branch_id
        then 'cross_branch_same_category'
      when a.branch_id = p_branch_id and a.asset_category_id <> p_asset_category_id
        then 'same_branch_substitute_category'
      else 'ranked_other_eligible_inventory'
    end as recommendation_reason_code,
    coalesce((
      select count(*)::bigint
      from rental_current_assets assets
      where assets.current_branch_id = a.branch_id
        and assets.current_asset_category_id = a.asset_category_id
        and coalesce(assets.operational_status, '') = 'available'
        and req.preferred_ownership_type is not null
        and assets.ownership_type = req.preferred_ownership_type
    ), 0) as ownership_match_count
  from rental_asset_availability_current a
  left join requested req
    on true
  left join rental_current_branches candidate_branch
    on candidate_branch.entity_id = a.branch_id
  cross join lateral rental_category_window_availability(
    a.branch_id,
    a.asset_category_id,
    p_start_date,
    p_end_date
  ) as scoped
  where scoped.available_assets > 0
    and (
      (a.asset_category_id = p_asset_category_id and a.branch_id <> p_branch_id)
      or (a.branch_id = p_branch_id and a.asset_category_id <> p_asset_category_id)
    )
),
ranked as (
  select
    candidates.*,
    row_number() over (
      order by
        candidates.suggestion_priority asc,
        candidates.transfer_cost_rank asc,
        candidates.ownership_match_count desc,
        candidates.available_assets desc,
        candidates.branch_name asc,
        candidates.asset_category_name asc
    )::int as recommendation_rank
  from candidates
  order by
    candidates.suggestion_priority asc,
    candidates.transfer_cost_rank asc,
    candidates.ownership_match_count desc,
    candidates.available_assets desc,
    candidates.branch_name asc,
    candidates.asset_category_name asc
  limit greatest(coalesce(p_limit, 5), 0)
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'recommendation_rank', ranked.recommendation_rank,
      'branch_id', ranked.branch_id,
      'branch_name', ranked.branch_name,
      'asset_category_id', ranked.asset_category_id,
      'asset_category_name', ranked.asset_category_name,
      'available_quantity', ranked.available_assets,
      'requested_quantity', greatest(coalesce(p_quantity, 1), 1),
      'fit_type', case
        when ranked.suggestion_priority = 1 then 'same_category_other_location'
        else 'same_location_substitute_category'
      end,
      'shortage_reason', ranked.shortage_reason,
      'recommendation_reason_code', ranked.recommendation_reason_code,
      'transfer_cost_band', ranked.transfer_cost_band,
      'transfer_cost_rank', ranked.transfer_cost_rank,
      'availability_model', 'rental_asset_availability_current',
      'explanation', case
        when ranked.suggestion_priority = 1 then
          'Same category at another branch ranked by transfer-cost context, ownership fit, and available quantity'
        else
          'Substitute category at requested branch ranked by ownership fit and available quantity'
      end
    )
    order by ranked.recommendation_rank
  ),
  '[]'::jsonb
)
from ranked;
$$;
