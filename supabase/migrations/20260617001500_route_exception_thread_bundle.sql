-- Route exception threading and branch review bundle read model.
--
-- Extends submit_stop_exception so repeated updates for the same stop +
-- exception type collapse into a single unresolved thread, and exposes a
-- branch/dispatch review projection that packages operational context with
-- evidence in one row.

create index if not exists idx_route_stop_exceptions_open_thread
  on public.route_stop_exceptions (stop_id, exception_type)
  where resolved_at is null;

create or replace function public.submit_stop_exception(
  p_stop_id                 uuid,
  p_exception_type          text,
  p_notes                   text    default null,
  p_photo_paths             text[]  default '{}',
  p_estimated_delay_minutes int     default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app_role   text;
  v_driver_id  uuid;
  v_exc_id     uuid;
  v_delay_min  int;
  v_notes      text;
  v_photo_paths text[];
begin
  v_app_role  := public.ops_claim_app_role();
  v_driver_id := auth.uid();

  if v_app_role not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'submit_stop_exception requires field_operator or higher role';
  end if;

  if p_exception_type not in ('eta_delay', 'access_issue', 'damage', 'missing_attachment') then
    raise exception 'Invalid exception_type: %', p_exception_type;
  end if;

  if v_app_role = 'field_operator' then
    if not exists (
      select 1 from public.route_stops s
      join public.dispatch_routes r on r.id = s.route_id
      where s.id = p_stop_id
        and r.driver_id = v_driver_id
    ) then
      raise exception 'Field operators may only submit exceptions for their own stops';
    end if;
  end if;

  -- Empty notes preserve the existing thread narrative rather than clearing it.
  -- Explicit clear semantics can be introduced later with a dedicated flag.
  v_notes := nullif(trim(p_notes), '');
  v_photo_paths := coalesce(p_photo_paths, '{}');

  if p_exception_type = 'eta_delay' then
    if p_estimated_delay_minutes is not null and p_estimated_delay_minutes <= 0 then
      raise exception 'estimated_delay_minutes must be greater than zero for eta_delay exceptions';
    end if;
    v_delay_min := p_estimated_delay_minutes;
  else
    v_delay_min := null;
  end if;

  -- Serialize updates per stop/type so concurrent submissions cannot fork
  -- multiple unresolved threads for the same stop exception.
  perform pg_advisory_xact_lock(hashtext(p_stop_id::text || '|' || p_exception_type));

  -- Collapse repeated submissions into one current thread per stop/type.
  select e.id
    into v_exc_id
  from public.route_stop_exceptions e
  where e.stop_id = p_stop_id
    and e.exception_type = p_exception_type
    and e.resolved_at is null
  order by e.submitted_at desc, e.id desc
  limit 1
  for update;

  if found then
    update public.route_stop_exceptions e
    set
      notes = coalesce(v_notes, e.notes),
      photo_paths = (
        select coalesce(array_agg(m.path order by m.first_ord), '{}')
        from (
          select p as path, min(ord) as first_ord
          from unnest(coalesce(e.photo_paths, '{}') || v_photo_paths) with ordinality as u(p, ord)
          where p is not null
            and p <> ''
          group by p
        ) m
      ),
      estimated_delay_minutes = coalesce(v_delay_min, e.estimated_delay_minutes),
      requires_human_review = true
    where e.id = v_exc_id;

    return v_exc_id;
  end if;

  insert into public.route_stop_exceptions (
    stop_id,
    exception_type,
    notes,
    photo_paths,
    estimated_delay_minutes,
    requires_human_review
  ) values (
    p_stop_id,
    p_exception_type,
    v_notes,
    v_photo_paths,
    v_delay_min,
    true
  )
  returning id into v_exc_id;

  return v_exc_id;
end;
$$;

revoke all on function public.submit_stop_exception from public;
grant execute on function public.submit_stop_exception to authenticated;

create or replace view public.v_route_exception_review_bundle
with (security_invoker = true)
as
select
  e.id                                     as exception_id,
  e.stop_id,
  s.route_id,
  r.route_date,
  r.status                                 as route_status,
  s.sequence_order,
  s.stop_type,
  s.contract_line_id,
  s.asset_id,
  s.customer_name,
  s.job_site_name,
  s.address,
  e.exception_type,
  (e.exception_type in ('damage', 'missing_attachment'))::boolean
                                           as is_damage_or_missing_attachment,
  e.notes,
  e.photo_paths,
  e.estimated_delay_minutes,
  e.requires_human_review,
  e.submitted_at,
  e.resolved_at,
  jsonb_build_object(
    'exception', jsonb_build_object(
      'id', e.id,
      'type', e.exception_type,
      'notes', e.notes,
      'photo_paths', to_jsonb(coalesce(e.photo_paths, '{}')),
      'estimated_delay_minutes', e.estimated_delay_minutes,
      'submitted_at', e.submitted_at,
      'requires_human_review', e.requires_human_review,
      'resolved_at', e.resolved_at
    ),
    'stop', jsonb_build_object(
      'stop_id', s.id,
      'route_id', s.route_id,
      'sequence_order', s.sequence_order,
      'stop_type', s.stop_type,
      'contract_line_id', s.contract_line_id,
      'asset_id', s.asset_id,
      'customer_name', s.customer_name,
      'job_site_name', s.job_site_name,
      'address', s.address
    ),
    'route', jsonb_build_object(
      'route_id', r.id,
      'driver_id', r.driver_id,
      'route_date', r.route_date,
      'route_status', r.status
    )
  )                                         as evidence_bundle
from public.route_stop_exceptions e
join public.route_stops s on s.id = e.stop_id
join public.dispatch_routes r on r.id = s.route_id
where e.resolved_at is null;

grant select on public.v_route_exception_review_bundle to authenticated, service_role;
alter view public.v_route_exception_review_bundle set (security_invoker = true);
