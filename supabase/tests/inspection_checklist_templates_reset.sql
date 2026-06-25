begin;

do $$
declare
  v_table_exists boolean := to_regclass('public.inspection_checklist_templates') is not null;
  v_view_exists boolean := to_regclass('public.v_checklist_template_items') is not null;
  v_security_invoker boolean := false;
  v_id uuid;
  v_visible_count integer;
begin
  if not v_table_exists then
    raise exception 'inspection_checklist_templates table missing after reset';
  end if;

  if not v_view_exists then
    raise exception 'v_checklist_template_items view missing after reset';
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_security_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'v_checklist_template_items';

  if not v_security_invoker then
    raise exception 'v_checklist_template_items must declare security_invoker=true after reset';
  end if;

  insert into public.inspection_checklist_templates (
    tenant_id,
    equipment_category,
    inspection_intent,
    item_key,
    label,
    section,
    is_required,
    sort_order
  ) values (
    null,
    'Reset Validation Category',
    'return',
    'reset_validation_item',
    'Reset validation checklist item',
    'Validation',
    true,
    10
  )
  returning id into v_id;

  select count(*)
    into v_visible_count
    from public.v_checklist_template_items
   where id = v_id
     and equipment_category = 'Reset Validation Category'
     and inspection_intent = 'return'
     and item_key = 'reset_validation_item';

  if v_visible_count <> 1 then
    raise exception 'reset validation checklist item was not visible via v_checklist_template_items';
  end if;
end
$$;

rollback;
