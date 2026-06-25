// Teste de CONTRATO SQL — Issue #31 (fix marca/empresa) contra o Postgres VIVO.
// Espelha supabase/tests/company_brand_crud.test.mjs (#5): node:test + node:assert
// nativos, psql via docker exec, cada cenario em BEGIN; ... ROLLBACK; para nao
// poluir o banco compartilhado.
//
// COMO RODAR:
//   node --test supabase/tests/issue31_company_brand_fix.test.mjs
// Pre-requisitos:
//   * container Postgres no ar: docker exec -i supabase_db_dealernet-agents psql ...
//   * migration 20260626130000_fix_brand_catalog_company_edit_brand_assoc.sql aplicada
//     (npx supabase migration up --local).
//
// Cobre os criterios de aceite da spec docs/specs/31-portal-cruds-acoes-como-botoes.md:
//   * "Marca aparece apos criacao" — apos create_brand, a marca aparece em
//     v_dia_brand_current (regressao do bug de catalogo: 'brand' faltava em
//     rental_entity_type_catalog).
//   * "Editar Empresa sem erro" — update_company sucede numa empresa legada cujo
//     data tem 'name' mas NAO 'legal_name' (backfill de legal_name).
//   * "Associar Marca em Empresa" — empresa criada/editada com brand_id; a view
//     v_dia_company_current resolve brand_name via left join a marca.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const CONTAINER = 'supabase_db_dealernet-agents'

const claims = (appRole) =>
  JSON.stringify({
    role: 'authenticated',
    sub: '00000000-0000-0000-0000-0000000000aa',
    app_metadata: { role: appRole },
  })

function psql(sql, { expectError = false } = {}) {
  const args = [
    'exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-q', '-t', '-A', '-F', '|',
  ]
  if (!expectError) args.push('-v', 'ON_ERROR_STOP=1')
  try {
    const out = execFileSync('docker', args, {
      input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
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

const parse = (out) => {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
}

// ===========================================================================
// AC "Marca aparece apos criacao" — regressao do bug de catalogo.
// 'brand' precisa estar em rental_entity_type_catalog (recriado pela migration);
// sem ele, rental_current_entity_state filtra a marca fora e v_dia_brand_current
// fica vazia mesmo apos create_brand inserir no banco.
// ===========================================================================

test("AC catalogo: 'brand' esta presente em rental_entity_type_catalog (corrige view vazia)", () => {
  const { ok, out, err } = psql(
    `select exists(select 1 from public.rental_entity_type_catalog where entity_type = 'brand');`,
  )
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', "rental_entity_type_catalog deve conter 'brand'")
})

test('AC marca/visivel: apos create_brand a marca aparece em v_dia_brand_current (1 linha)', () => {
  const sql = `${asWriter('admin')}
create temp table _b on commit drop as
  select entity_id from create_brand(
    '{"name":"Toyota","segment":"automoveis","status":"ativo"}'::jsonb);
select 'count', count(*) from v_dia_brand_current b join _b using (entity_id);
select 'view', b.name, b.segment, b.status
from v_dia_brand_current b join _b using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(
    get('count'),
    ['count', '1'],
    'marca recem-criada deve aparecer (exatamente 1 linha) em v_dia_brand_current',
  )
  assert.deepEqual(
    get('view'),
    ['view', 'Toyota', 'automoveis', 'ativo'],
    'a marca deve aparecer na view com os campos informados',
  )
})

// ===========================================================================
// AC "Editar Empresa sem erro" — empresa legada com 'name' mas SEM 'legal_name'.
// Simulamos uma entidade legada inserindo direto na tabela (sem create_company,
// que e estrito) e entao chamamos update_company: o backfill de legal_name a
// partir de name deve fazer a validacao passar (sem "legal_name is required").
// ===========================================================================

test('AC empresa/legado: update_company SUCEDE em empresa legada com name mas sem legal_name (backfill)', () => {
  const sql = `${asWriter('admin')}
-- Cria uma entidade 'company' legada: data tem 'name' (dominio rental antigo) mas
-- NAO 'legal_name' nem 'cnpj' como o create_company moderno exigiria.
create temp table _c (entity_id uuid) on commit drop;
with ins as (
  insert into public.entities (entity_type) values ('company') returning id as entity_id
)
insert into _c (entity_id) select entity_id from ins;
insert into public.entity_versions (entity_id, version_number, data)
  select entity_id, 1, '{"name":"Loja Legada","cnpj":"99.999.999/0001-99","status":"ativo"}'::jsonb
  from _c;
-- A view corrente NAO deve expor legal_name para essa empresa legada.
select 'legal_before', coalesce(c.legal_name, '<null>')
from v_dia_company_current c join _c using (entity_id);
-- Edita um campo qualquer (city); update_company deve backfillar legal_name de name
-- e SUCEDER (sem 'company.legal_name is required').
select update_company((select entity_id from _c),
  '{"city":"Joinville"}'::jsonb) is not null as updated;
select 'after', c.version_number, c.city, c.legal_name
from v_dia_company_current c join _c using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `update_company deveria suceder em empresa legada; psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(
    get('legal_before'),
    ['legal_before', '<null>'],
    'pre-condicao: empresa legada nao tem legal_name',
  )
  const after = get('after')
  assert.ok(after, 'a empresa deve continuar na view corrente apos o update')
  assert.equal(after[1], '2', 'update_company deve gerar a versao 2 (SCD2)')
  assert.equal(after[2], 'Joinville', 'o campo editado (city) deve refletir o novo valor')
  assert.equal(
    after[3],
    'Loja Legada',
    'legal_name deve ter sido backfillado a partir de name (corrige "legal_name is required")',
  )
})

// ===========================================================================
// AC "Associar Marca em Empresa" — create_company com brand_id; a view resolve
// brand_name via left join a v_dia_brand_current.
// ===========================================================================

test('AC marca-empresa: create_company com brand_id; v_dia_company_current resolve brand_name', () => {
  const sql = `${asWriter('admin')}
create temp table _b on commit drop as
  select entity_id from create_brand('{"name":"Honda","segment":"automoveis"}'::jsonb);
create temp table _c on commit drop as
  select entity_id from create_company(
    ('{"legal_name":"Concessionaria Honda LTDA","cnpj":"10.000.000/0001-00","brand_id":"'
      || (select entity_id from _b) || '"}')::jsonb);
select 'view', c.legal_name, (c.brand_id = (select entity_id from _b)) as brand_match, c.brand_name
from v_dia_company_current c join _c using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(
    get('view'),
    ['view', 'Concessionaria Honda LTDA', 't', 'Honda'],
    'empresa deve persistir brand_id e a view deve resolver brand_name = "Honda"',
  )
})

test('AC marca-empresa: update_company associa marca e brand_name passa a aparecer', () => {
  const sql = `${asWriter('admin')}
create temp table _b on commit drop as
  select entity_id from create_brand('{"name":"Fiat","segment":"automoveis"}'::jsonb);
create temp table _c on commit drop as
  select entity_id from create_company(
    '{"legal_name":"Sem Marca LTDA","cnpj":"20.000.000/0001-00"}'::jsonb);
-- Antes: sem marca associada.
select 'before', coalesce(c.brand_name, '<null>')
from v_dia_company_current c join _c using (entity_id);
-- Associa a marca via update_company.
select update_company((select entity_id from _c),
  ('{"brand_id":"' || (select entity_id from _b) || '"}')::jsonb) is not null as updated;
select 'after', c.brand_name
from v_dia_company_current c join _c using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(
    get('before'),
    ['before', '<null>'],
    'pre-condicao: empresa sem marca nao tem brand_name resolvido',
  )
  assert.deepEqual(
    get('after'),
    ['after', 'Fiat'],
    'apos update_company com brand_id, a view deve resolver brand_name = "Fiat"',
  )
})

test('AC marca-empresa: brand_id em branco DESASSOCIA a marca (brand_name volta a null)', () => {
  const sql = `${asWriter('admin')}
create temp table _b on commit drop as
  select entity_id from create_brand('{"name":"Ford","segment":"automoveis"}'::jsonb);
create temp table _c on commit drop as
  select entity_id from create_company(
    ('{"legal_name":"Com Marca LTDA","cnpj":"30.000.000/0001-00","brand_id":"'
      || (select entity_id from _b) || '"}')::jsonb);
select 'assoc', c.brand_name from v_dia_company_current c join _c using (entity_id);
-- Desassocia enviando brand_id em branco.
select update_company((select entity_id from _c),
  '{"brand_id":""}'::jsonb) is not null as updated;
select 'cleared', coalesce(c.brand_name, '<null>'), coalesce(c.brand_id::text, '<null>')
from v_dia_company_current c join _c using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(get('assoc'), ['assoc', 'Ford'], 'pre-condicao: empresa associada a Ford')
  assert.deepEqual(
    get('cleared'),
    ['cleared', '<null>', '<null>'],
    'brand_id em branco deve desassociar (brand_id e brand_name nulos)',
  )
})
