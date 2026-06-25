// Teste de CONTRATO SQL — Company + Brand CRUD (issue #5), rodando contra o
// Postgres VIVO. Espelha supabase/tests/vehicle_crud.test.mjs (#4).
//
// Ambiente OFFLINE: SEM Supabase CLI e SEM runner instalavel. Usamos apenas os
// modulos nativos do Node (node:test + node:assert) e chamamos o psql do
// container Docker via child_process.execFileSync. Cada cenario roda dentro de
// uma transacao BEGIN; ... ROLLBACK; para NAO poluir o banco compartilhado.
//
// COMO RODAR:
//   node --test supabase/tests/company_brand_crud.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Notas de implementacao (espelham as do teste de veiculo, ver migration
// 20260625150000_dia_company_brand_entity_crud.sql):
//   * dia_assert_company_writer()/dia_assert_brand_writer() exigem role de
//     REQUISICAO 'authenticated' (ou 'service_role') E get_my_role() in
//     (admin, branch_manager). get_my_role() le auth.jwt() ->
//     'app_metadata' ->> 'role'. Por isso o JWT simulado precisa de
//     {"role":"authenticated", ..., "app_metadata":{"role":"<app_role>"}}.
//   * create_/update_/delete_ sao funcoes data-modifying. Uma CTE
//     `with c as (select ... from create_company(...))` NAO materializa as
//     escritas a tempo do JOIN no mesmo statement; capturamos o entity_id numa
//     TEMP TABLE (statement separado) antes de consultar a view/historico.
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/5-feat-empresa-e-marca-entidades.md) que verifica.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const CONTAINER = 'supabase_db_dealernet-agents'

// JWT claims canonicas usadas nos cenarios. role de requisicao = 'authenticated';
// app_metadata.role define o app_role lido por get_my_role().
const claims = (appRole) =>
  JSON.stringify({
    role: 'authenticated',
    sub: '00000000-0000-0000-0000-0000000000aa',
    app_metadata: { role: appRole },
  })

// Executa um script SQL no Postgres vivo via psql. Retorna stdout (trim).
// Usa -t -A -F'|' (tuplas-only, unaligned, separador pipe) para parse simples.
// Por padrao usa ON_ERROR_STOP=1 para que um erro inesperado quebre o teste.
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
    '-q', // quiet: suprime tags de comando (BEGIN/SET/DO/CREATE TABLE/ROLLBACK)
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
    // execFileSync lanca quando o processo sai != 0 (ex.: ON_ERROR_STOP).
    return {
      ok: false,
      out: (e.stdout || '').toString().trim(),
      err: (e.stderr || '').toString().trim(),
    }
  }
}

// Prefacio comum: abre transacao, vira authenticated e injeta o JWT do app_role.
// O resultado de set_config e' descartado (\g /dev/null) para nao poluir stdout;
// com -q so as linhas de SELECT dos cenarios sobram na saida.
const asWriter = (appRole) => `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims(appRole)}', true) \\g /dev/null
`

// Captura o SQLSTATE de uma chamada que DEVE falhar. RAISE NOTICE sai em stderr
// (que execFileSync nao retorna no caminho de sucesso), entao gravamos o
// resultado numa temp table e fazemos SELECT — assim a saida vem em STDOUT.
// Retorna a linha: 'SQLSTATE=<code>' ou 'NO_ERROR' (se a chamada nao falhou).
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

// Helper de parse: quebra stdout em linhas marcadas 'chave|...'.
const parse = (out) => {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
}

// ===========================================================================
// COMPANY
// ===========================================================================

// ---------------------------------------------------------------------------
// AC Controle de acesso / Empresa cadastravel — create_company como admin
// sucede e o registro aparece na view corrente v_dia_company_current.
// ---------------------------------------------------------------------------
test('AC empresa/access: create_company como admin SUCEDE e aparece em v_dia_company_current', () => {
  const sql = `${asWriter('admin')}
create temp table _c on commit drop as
  select entity_id from create_company(
    '{"legal_name":"Concessionaria Alfa LTDA","trade_name":"Alfa Motors","cnpj":"11.111.111/0001-11","city":"Curitiba","state":"PR","status":"ativo"}'::jsonb);
select 'view', c.legal_name, c.trade_name, c.cnpj, c.city, c.state, c.status
from v_dia_company_current c join _c using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(
    get('view'),
    ['view', 'Concessionaria Alfa LTDA', 'Alfa Motors', '11.111.111/0001-11', 'Curitiba', 'PR', 'ativo'],
    'empresa criada deveria aparecer na view corrente com os campos informados',
  )
})

test('AC empresa/access: create_company como branch_manager SUCEDE', () => {
  const sql = `${asWriter('branch_manager')}
select entity_id is not null as created
from create_company('{"legal_name":"Beta Veiculos SA","cnpj":"22.222.222/0001-22"}'::jsonb);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', `branch_manager deveria criar empresa; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC Controle de acesso — write requer admin/branch_manager; read_only e'
// negado (42501). Nao ha caminho de escrita fora da RPC.
// ---------------------------------------------------------------------------
test('AC empresa/access: create_company como read_only FALHA com SQLSTATE 42501', () => {
  const sql = `${asWriter('read_only')}
${captureSqlstate(`perform create_company('{"legal_name":"Gama LTDA","cnpj":"33.333.333/0001-33"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado SQLSTATE 42501 para read_only; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC Validacao de dados — status invalido e' rejeitado (22023).
// ---------------------------------------------------------------------------
test('AC empresa/validacao: create_company com status invalido FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_company('{"legal_name":"X LTDA","cnpj":"44.444.444/0001-44","status":"zzz"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para status invalido; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC Validacao de dados — razao social (legal_name) obrigatoria (22023).
// ---------------------------------------------------------------------------
test('AC empresa/validacao: create_company sem legal_name FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_company('{"cnpj":"55.555.555/0001-55"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para legal_name ausente; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC Validacao de dados — CNPJ obrigatorio (22023).
// ---------------------------------------------------------------------------
test('AC empresa/validacao: create_company sem cnpj FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_company('{"legal_name":"Sem CNPJ LTDA"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para cnpj ausente; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC Empresa cadastravel (soft-delete) — delete_company some da view corrente
// mas preserva o historico SCD2 (nenhum DELETE fisico).
// ---------------------------------------------------------------------------
test('AC empresa/soft-delete: delete_company sai da view mas preserva historico em entity_versions', () => {
  const sql = `${asWriter('admin')}
create temp table _c on commit drop as
  select entity_id from create_company(
    '{"legal_name":"Delta LTDA","cnpj":"66.666.666/0001-66","status":"ativo"}'::jsonb);
select 'before', count(*) from v_dia_company_current c join _c using (entity_id);
select delete_company((select entity_id from _c)) is not null as deleted;
select 'after_view', count(*) from v_dia_company_current c join _c using (entity_id);
select 'versions', count(*) from entity_versions ev join _c using (entity_id);
select 'v1', (ev.data->>'status'), (ev.data ? 'retired')
from entity_versions ev join _c using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(get('before'), ['before', '1'], 'empresa deveria estar na view antes do delete')
  assert.deepEqual(get('after_view'), ['after_view', '0'], 'empresa deveria SAIR da view apos delete')
  assert.deepEqual(
    get('versions'),
    ['versions', '2'],
    'historico SCD2 deveria ter 2 versoes (criacao + baixa), nenhuma apagada',
  )
  assert.deepEqual(
    get('v1'),
    ['v1', 'ativo', 'f'],
    'a versao anterior (v1) deve permanecer intacta no historico (ativo, sem retired)',
  )
})

// ---------------------------------------------------------------------------
// AC Empresa cadastravel (edicao SCD2) — update_company incrementa
// version_number, a view reflete o novo valor e a v1 permanece intacta.
// ---------------------------------------------------------------------------
test('AC empresa/update SCD2: update_company incrementa version_number, preserva v1 e view reflete novo valor', () => {
  const sql = `${asWriter('admin')}
create temp table _c on commit drop as
  select entity_id from create_company(
    '{"legal_name":"Epsilon LTDA","trade_name":"Epsilon","cnpj":"77.777.777/0001-77","city":"Sao Paulo","state":"SP"}'::jsonb);
select 'v_before', c.version_number, c.trade_name, c.city
from v_dia_company_current c join _c using (entity_id);
select update_company((select entity_id from _c),
  '{"trade_name":"Epsilon Premium","city":"Campinas"}'::jsonb) is not null as updated;
select 'v_after', c.version_number, c.trade_name, c.city
from v_dia_company_current c join _c using (entity_id);
select 'versions', count(*) from entity_versions ev join _c using (entity_id);
select 'v1_intact', (ev.data->>'trade_name'), (ev.data->>'city')
from entity_versions ev join _c using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(
    get('v_before'),
    ['v_before', '1', 'Epsilon', 'Sao Paulo'],
    'estado inicial: versao 1, trade_name Epsilon, city Sao Paulo',
  )
  assert.deepEqual(
    get('v_after'),
    ['v_after', '2', 'Epsilon Premium', 'Campinas'],
    'apos update: versao corrente = 2 com NOVOS valores',
  )
  assert.deepEqual(
    get('versions'),
    ['versions', '2'],
    'historico SCD2 deveria ter 2 versoes (criacao + update), nenhuma apagada',
  )
  assert.deepEqual(
    get('v1_intact'),
    ['v1_intact', 'Epsilon', 'Sao Paulo'],
    'a versao anterior (v1) deve permanecer intacta no historico (valores originais)',
  )
})

// ===========================================================================
// BRAND
// ===========================================================================

// ---------------------------------------------------------------------------
// AC Controle de acesso / Marca cadastravel — create_brand como admin sucede
// e o registro aparece na view corrente v_dia_brand_current.
// ---------------------------------------------------------------------------
test('AC marca/access: create_brand como admin SUCEDE e aparece em v_dia_brand_current', () => {
  const sql = `${asWriter('admin')}
create temp table _b on commit drop as
  select entity_id from create_brand(
    '{"name":"Volkswagen","segment":"automoveis","status":"ativo"}'::jsonb);
select 'view', b.name, b.segment, b.status
from v_dia_brand_current b join _b using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(
    get('view'),
    ['view', 'Volkswagen', 'automoveis', 'ativo'],
    'marca criada deveria aparecer na view corrente com os campos informados',
  )
})

test('AC marca/access: create_brand como branch_manager SUCEDE', () => {
  const sql = `${asWriter('branch_manager')}
select entity_id is not null as created
from create_brand('{"name":"Scania","segment":"caminhoes"}'::jsonb);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', `branch_manager deveria criar marca; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC Controle de acesso — read_only e' negado (42501).
// ---------------------------------------------------------------------------
test('AC marca/access: create_brand como read_only FALHA com SQLSTATE 42501', () => {
  const sql = `${asWriter('read_only')}
${captureSqlstate(`perform create_brand('{"name":"Honda","segment":"motos"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado SQLSTATE 42501 para read_only; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC Validacao de dados — segment fora dos valores permitidos (22023).
// ---------------------------------------------------------------------------
test('AC marca/validacao: create_brand com segment invalido FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_brand('{"name":"Foo","segment":"avioes"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para segment invalido; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC Validacao de dados — status invalido (22023).
// ---------------------------------------------------------------------------
test('AC marca/validacao: create_brand com status invalido FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_brand('{"name":"Foo","segment":"automoveis","status":"zzz"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para status invalido; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC Validacao de dados — name obrigatorio (22023).
// ---------------------------------------------------------------------------
test('AC marca/validacao: create_brand sem name FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_brand('{"segment":"automoveis"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para name ausente; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC Validacao de dados — segment obrigatorio (ausente) (22023).
// ---------------------------------------------------------------------------
test('AC marca/validacao: create_brand sem segment FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_brand('{"name":"Sem Segmento"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para segment ausente; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC Marca cadastravel (soft-delete) — delete_brand some da view mas preserva
// historico SCD2 (nenhum DELETE fisico).
// ---------------------------------------------------------------------------
test('AC marca/soft-delete: delete_brand sai da view mas preserva historico em entity_versions', () => {
  const sql = `${asWriter('admin')}
create temp table _b on commit drop as
  select entity_id from create_brand(
    '{"name":"Fiat","segment":"automoveis","status":"ativo"}'::jsonb);
select 'before', count(*) from v_dia_brand_current b join _b using (entity_id);
select delete_brand((select entity_id from _b)) is not null as deleted;
select 'after_view', count(*) from v_dia_brand_current b join _b using (entity_id);
select 'versions', count(*) from entity_versions ev join _b using (entity_id);
select 'v1', (ev.data->>'status'), (ev.data ? 'retired')
from entity_versions ev join _b using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(get('before'), ['before', '1'], 'marca deveria estar na view antes do delete')
  assert.deepEqual(get('after_view'), ['after_view', '0'], 'marca deveria SAIR da view apos delete')
  assert.deepEqual(
    get('versions'),
    ['versions', '2'],
    'historico SCD2 deveria ter 2 versoes (criacao + baixa), nenhuma apagada',
  )
  assert.deepEqual(
    get('v1'),
    ['v1', 'ativo', 'f'],
    'a versao anterior (v1) deve permanecer intacta no historico (ativo, sem retired)',
  )
})

// ---------------------------------------------------------------------------
// AC Marca cadastravel (edicao SCD2) — update_brand incrementa version_number,
// a view reflete o novo valor e a v1 permanece intacta.
// ---------------------------------------------------------------------------
test('AC marca/update SCD2: update_brand incrementa version_number, preserva v1 e view reflete novo valor', () => {
  const sql = `${asWriter('admin')}
create temp table _b on commit drop as
  select entity_id from create_brand(
    '{"name":"Chevrolet","segment":"automoveis"}'::jsonb);
select 'v_before', b.version_number, b.name, b.segment
from v_dia_brand_current b join _b using (entity_id);
select update_brand((select entity_id from _b),
  '{"name":"Chevrolet Trucks","segment":"caminhoes"}'::jsonb) is not null as updated;
select 'v_after', b.version_number, b.name, b.segment
from v_dia_brand_current b join _b using (entity_id);
select 'versions', count(*) from entity_versions ev join _b using (entity_id);
select 'v1_intact', (ev.data->>'name'), (ev.data->>'segment')
from entity_versions ev join _b using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parse(out)
  assert.deepEqual(
    get('v_before'),
    ['v_before', '1', 'Chevrolet', 'automoveis'],
    'estado inicial: versao 1, name Chevrolet, segment automoveis',
  )
  assert.deepEqual(
    get('v_after'),
    ['v_after', '2', 'Chevrolet Trucks', 'caminhoes'],
    'apos update: versao corrente = 2 com NOVOS valores',
  )
  assert.deepEqual(
    get('versions'),
    ['versions', '2'],
    'historico SCD2 deveria ter 2 versoes (criacao + update), nenhuma apagada',
  )
  assert.deepEqual(
    get('v1_intact'),
    ['v1_intact', 'Chevrolet', 'automoveis'],
    'a versao anterior (v1) deve permanecer intacta no historico (valores originais)',
  )
})
