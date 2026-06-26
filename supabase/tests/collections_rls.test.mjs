// SQL contract tests — Collections finance mirror (issue #82).
//
// Runs against the live Supabase Postgres container using only node:test and psql.
// Each scenario is wrapped in BEGIN/ROLLBACK and uses TEST-* source_record_id
// values so the suite never touches seed/demo rows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const CONTAINER = 'supabase_db_dealernet-agents'

const claims = (appRole) =>
  JSON.stringify({
    role: 'authenticated',
    sub: '00000000-0000-0000-0000-000000000082',
    app_metadata: { role: appRole },
  })

function psql(sql, { expectError = false } = {}) {
  const args = [
    'exec',
    '-i',
    CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-q',
    '-t',
    '-A',
    '-F',
    '|',
  ]
  if (!expectError) args.push('-v', 'ON_ERROR_STOP=1')
  try {
    const out = execFileSync('docker', args, {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { ok: true, out: out.trim(), err: '' }
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || '').toString().trim(),
      err: (e.stderr || '').toString().trim(),
    }
  }
}

const asWriter = (appRole) => `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims(appRole)}', true) \\g /dev/null
`

function captureSqlstate(stmt) {
  return `
create temp table _r (outcome text) on commit drop;
do $$ begin
  ${stmt}
  insert into _r values ('NO_ERROR');
exception when others then
  insert into _r values ('SQLSTATE=' || SQLSTATE);
end $$;
select outcome from _r;
`
}

const escapeJson = (value) => JSON.stringify(value).replace(/'/g, "''")

const receivableData = (overrides = {}) =>
  escapeJson({
    customer_id: 'TEST-CUSTOMER-82',
    customer_name: 'Cliente Teste 82',
    document_number: 'TEST-DOC-82',
    receivable_type: 'a_receber',
    due_date: '2026-01-01',
    balance: '1500.00',
    source_record_id: 'TEST-receivable-82',
    ...overrides,
  })

const contactData = (overrides = {}) =>
  escapeJson({
    customer_id: 'TEST-CUSTOMER-82',
    action: 'call',
    note: 'Contato de teste',
    contact_date: '2026-01-01',
    source_record_id: 'TEST-collection-contact-82',
    ...overrides,
  })

const parseLabeled = (out) => {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
}

test('AC-1 catalog keeps existing types and adds receivable + collection_contact', () => {
  const sql = `${asWriter('admin')}
select 'types', string_agg(entity_type, ',' order by entity_type)
from rental_entity_type_catalog
where entity_type in ('vehicle','brand','service_order','part','part_sale','receivable','collection_contact');
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql failed: ${err}`)
  const get = parseLabeled(out)
  const types = new Set(get('types')[1].split(','))
  for (const required of ['vehicle', 'brand', 'service_order', 'part', 'part_sale', 'receivable', 'collection_contact']) {
    assert.ok(types.has(required), `${required} should remain in rental_entity_type_catalog`)
  }
})

test('AC-2 create_receivable as admin appears in current view with version 1 and default status', () => {
  const sql = `${asWriter('admin')}
create temp table _r on commit drop as
  select entity_id from create_receivable('${receivableData({
    customer_id: 'TEST-CUSTOMER-CREATE',
    document_number: 'TEST-DOC-CREATE',
    source_record_id: 'TEST-receivable-create',
  })}'::jsonb);
select 'row', v.version_number, v.customer_id, v.document_number, v.balance, v.status
from v_dia_receivable_current v join _r using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql failed: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(
    get('row'),
    ['row', '1', 'TEST-CUSTOMER-CREATE', 'TEST-DOC-CREATE', '1500.00', 'aberto'],
  )
})

test('AC-3 create_receivable without due_date fails with SQLSTATE 22023', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_receivable('${receivableData({ due_date: undefined })}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql failed: ${err}`)
  assert.equal(out, 'SQLSTATE=22023')
})

test('AC-3 create_collection_contact without action fails with SQLSTATE 22023', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_collection_contact('${contactData({ action: undefined })}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql failed: ${err}`)
  assert.equal(out, 'SQLSTATE=22023')
})

test('AC-4 read_only cannot create receivables or collection contacts', () => {
  const sql = `${asWriter('read_only')}
${captureSqlstate(`perform create_receivable('${receivableData({ source_record_id: 'TEST-ro-rec' })}'::jsonb);`)}
rollback;
`
  const receivable = psql(sql)
  assert.ok(receivable.ok, `psql failed: ${receivable.err}`)
  assert.equal(receivable.out, 'SQLSTATE=42501')

  const contactSql = `${asWriter('read_only')}
${captureSqlstate(`perform create_collection_contact('${contactData({ source_record_id: 'TEST-ro-contact' })}'::jsonb);`)}
rollback;
`
  const contact = psql(contactSql)
  assert.ok(contact.ok, `psql failed: ${contact.err}`)
  assert.equal(contact.out, 'SQLSTATE=42501')
})

test('AC-4 branch_manager can create receivables and collection contacts', () => {
  const sql = `${asWriter('branch_manager')}
select 'receivable', entity_id is not null from create_receivable('${receivableData({
    customer_id: 'TEST-CUSTOMER-BM',
    source_record_id: 'TEST-bm-rec',
  })}'::jsonb);
select 'contact', entity_id is not null from create_collection_contact('${contactData({
    customer_id: 'TEST-CUSTOMER-BM',
    source_record_id: 'TEST-bm-contact',
  })}'::jsonb);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql failed: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(get('receivable'), ['receivable', 't'])
  assert.deepEqual(get('contact'), ['contact', 't'])
})

test('AC-5 update_receivable increments SCD2 version and delete soft-retires from current view', () => {
  const sql = `${asWriter('admin')}
create temp table _r on commit drop as
  select entity_id from create_receivable('${receivableData({
    customer_id: 'TEST-CUSTOMER-SCD2',
    balance: '1000.00',
    document_number: 'TEST-DOC-SCD2',
    source_record_id: 'TEST-receivable-scd2',
  })}'::jsonb);
select 'before', v.version_number, v.balance, v.status
from v_dia_receivable_current v join _r using (entity_id);
select update_receivable((select entity_id from _r), '{"balance":"1250.50"}'::jsonb) is not null as updated;
select 'after_update', v.version_number, v.balance, v.status
from v_dia_receivable_current v join _r using (entity_id);
select delete_receivable((select entity_id from _r)) is not null as deleted;
select 'after_delete_view', count(*) from v_dia_receivable_current v join _r using (entity_id);
select 'versions', count(*) from entity_versions ev join _r using (entity_id);
select 'current', ev.version_number, ev.data->>'status', ev.data->>'retired'
from entity_versions ev join _r using (entity_id) where ev.is_current;
select 'v1_intact', ev.version_number, ev.data->>'balance', coalesce(ev.data->>'retired', '<null>')
from entity_versions ev join _r using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql failed: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(get('before'), ['before', '1', '1000.00', 'aberto'])
  assert.deepEqual(get('after_update'), ['after_update', '2', '1250.50', 'aberto'])
  assert.deepEqual(get('after_delete_view'), ['after_delete_view', '0'])
  assert.deepEqual(get('versions'), ['versions', '3'])
  assert.deepEqual(get('current'), ['current', '3', 'inativo', 'true'])
  assert.deepEqual(get('v1_intact'), ['v1_intact', '1', '1000.00', '<null>'])
})

test('AC-6 v_dia_receivable_current derives days_overdue for past and future due dates', () => {
  const sql = `${asWriter('admin')}
create temp table _ids (label text, entity_id uuid) on commit drop;
insert into _ids
select 'past', entity_id
from create_receivable(jsonb_build_object(
  'customer_id', 'TEST-CUSTOMER-PAST',
  'customer_name', 'Cliente Past',
  'document_number', 'TEST-DOC-PAST',
  'due_date', (current_date - 100)::text,
  'balance', '100.00',
  'source_record_id', 'TEST-receivable-past'
));
insert into _ids
select 'future', entity_id
from create_receivable(jsonb_build_object(
  'customer_id', 'TEST-CUSTOMER-FUTURE',
  'customer_name', 'Cliente Future',
  'document_number', 'TEST-DOC-FUTURE',
  'due_date', (current_date + 10)::text,
  'balance', '100.00',
  'source_record_id', 'TEST-receivable-future'
));
select i.label, v.days_overdue
from _ids i join v_dia_receivable_current v using (entity_id)
order by i.label;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql failed: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(get('future'), ['future', '0'])
  assert.deepEqual(get('past'), ['past', '100'])
})
