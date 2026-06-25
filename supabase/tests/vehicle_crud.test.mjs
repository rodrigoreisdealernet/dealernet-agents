// Teste de CONTRATO SQL — Vehicle CRUD (issue #4), rodando contra o Postgres VIVO.
//
// Ambiente OFFLINE: SEM Supabase CLI e SEM runner instalavel. Usamos apenas os
// modulos nativos do Node (node:test + node:assert) e chamamos o psql do
// container Docker via child_process.execFileSync. Cada cenario roda dentro de
// uma transacao BEGIN; ... ROLLBACK; para NAO poluir o banco (idempotente).
//
// COMO RODAR:
//   node --test supabase/tests/vehicle_crud.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Notas de implementacao descobertas contra o schema vivo:
//   * dia_assert_vehicle_writer() exige role de REQUISICAO 'authenticated' (ou
//     'service_role') E get_my_role() in (admin, branch_manager). get_my_role()
//     le auth.jwt() -> 'app_metadata' ->> 'role'. Por isso o JWT simulado precisa
//     de {"role":"authenticated", ..., "app_metadata":{"role":"<app_role>"}}.
//   * create_vehicle/update_vehicle/delete_vehicle sao funcoes data-modifying.
//     Uma CTE `with c as (select ... from create_vehicle(...))` NAO materializa as
//     escritas a tempo do JOIN no mesmo statement; capturamos o entity_id numa
//     TEMP TABLE (statement separado) antes de consultar a view/historico.
//
// Cada teste traz no nome o criterio de aceite (spec docs/specs/4-vehicle-crud.md)
// que verifica.

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

// ---------------------------------------------------------------------------
// AC: floor_plan_cost e days_in_stock derivados na view v_dia_vehicle_current.
// floor_plan_cost = round(cost * 0.13/365 * days_in_stock, 2).
// ---------------------------------------------------------------------------
test('AC floor-plan: days_in_stock e floor_plan_cost derivam de cost+purchase_date', () => {
  const cost = 80000
  const purchaseDate = '2026-03-26'
  const sql = `${asWriter('admin')}
create temp table _v on commit drop as
  select entity_id from create_vehicle(
    '{"condition":"novo","brand":"VW","model":"Polo","cost":"${cost}","purchase_date":"${purchaseDate}"}'::jsonb);
select v.days_in_stock, v.floor_plan_cost
from v_dia_vehicle_current v join _v using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const [daysStr, floorStr] = out.split('|')
  const daysInStock = Number(daysStr)
  const floorPlan = Number(floorStr)

  // Esperado de days_in_stock = (hoje - purchase_date) em dias, clamp >= 0.
  // Calculado em JS contra a data de hoje do container (UTC date diff).
  const todayUtc = psql(`select (now()::date)::text;`).out
  const expectedDays = Math.max(
    Math.round((Date.parse(todayUtc) - Date.parse(purchaseDate)) / 86400000),
    0,
  )
  assert.equal(daysInStock, expectedDays, `days_in_stock esperado=${expectedDays}, obtido=${daysInStock}`)

  // floor_plan_cost = round(cost * 0.13/365 * days, 2), calculado em JS.
  const expectedFloor = Math.round(cost * (0.13 / 365) * daysInStock * 100) / 100
  assert.equal(
    floorPlan,
    expectedFloor,
    `floor_plan_cost esperado=${expectedFloor}, obtido=${floorPlan}`,
  )
})

// ---------------------------------------------------------------------------
// AC: role guard — write requer admin/branch_manager; read_only e' negado (42501).
// ---------------------------------------------------------------------------
test('AC role-guard: create_vehicle como read_only FALHA com SQLSTATE 42501', () => {
  const sql = `${asWriter('read_only')}
${captureSqlstate(`perform create_vehicle('{"condition":"novo","brand":"Fiat","model":"Mobi"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado SQLSTATE 42501 para read_only; obtido: ${out}`)
})

test('AC role-guard: create_vehicle como admin SUCEDE (retorna entity_id)', () => {
  const sql = `${asWriter('admin')}
select entity_id is not null as created
from create_vehicle('{"condition":"novo","brand":"Fiat","model":"Mobi"}'::jsonb);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', `admin deveria criar veiculo; saida=${out}`)
})

test('AC role-guard: create_vehicle como branch_manager SUCEDE', () => {
  const sql = `${asWriter('branch_manager')}
select entity_id is not null as created
from create_vehicle('{"condition":"usado","brand":"GM","model":"Onix"}'::jsonb);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', `branch_manager deveria criar veiculo; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC: soft-delete preserva historico — some da view corrente mas a versao
// anterior continua em entity_versions (SCD2; nenhum DELETE fisico).
// ---------------------------------------------------------------------------
test('AC soft-delete: delete_vehicle remove da view mas preserva historico em entity_versions', () => {
  const sql = `${asWriter('admin')}
create temp table _v on commit drop as
  select entity_id from create_vehicle(
    '{"condition":"usado","brand":"GM","model":"Onix","cost":"60000","purchase_date":"2026-04-01"}'::jsonb);
select 'before', count(*) from v_dia_vehicle_current v join _v using (entity_id);
select delete_vehicle((select entity_id from _v)) is not null as deleted;
select 'after_view', count(*) from v_dia_vehicle_current v join _v using (entity_id);
select 'versions', count(*) from entity_versions ev join _v using (entity_id);
select 'v1_status', (ev.data->>'status'), (ev.data ? 'retired')
from entity_versions ev join _v using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const get = (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')

  assert.deepEqual(get('before'), ['before', '1'], 'veiculo deveria estar na view antes do delete')
  assert.deepEqual(get('after_view'), ['after_view', '0'], 'veiculo deveria SAIR da view apos delete')
  assert.deepEqual(
    get('versions'),
    ['versions', '2'],
    'historico SCD2 deveria ter 2 versoes (criacao + baixa), nenhuma apagada',
  )
  // A versao 1 (anterior) deve permanecer INTACTA: ainda em_estoque, sem retired.
  assert.deepEqual(
    get('v1_status'),
    ['v1_status', 'em_estoque', 'f'],
    'a versao anterior (v1) deve permanecer intacta no historico (em_estoque, sem retired)',
  )
})

// ---------------------------------------------------------------------------
// AC: validacao de dados — condition/status invalidos sao rejeitados (22023).
// ---------------------------------------------------------------------------
test('AC validacao: create_vehicle com condition invalido FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_vehicle('{"condition":"xpto","brand":"X","model":"Y"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para condition invalido; obtido: ${out}`)
})

test('AC validacao: create_vehicle com status invalido FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_vehicle('{"condition":"novo","status":"zzz","brand":"X","model":"Y"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para status invalido; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC: update_vehicle cria nova versao SCD2 — version_number incrementa, a versao
// anterior permanece intacta em entity_versions e a view corrente reflete o novo
// valor. update_vehicle faz merge sobre a versao corrente e anexa nova versao.
// ---------------------------------------------------------------------------
test('AC update SCD2: update_vehicle incrementa version_number, preserva historico e view reflete novo valor', () => {
  const sql = `${asWriter('admin')}
create temp table _v on commit drop as
  select entity_id from create_vehicle(
    '{"condition":"usado","brand":"GM","model":"Onix","cost":"60000","sale_price":"50000","purchase_date":"2026-04-01"}'::jsonb);
select 'v_before', v.version_number, v.status, v.sale_price
from v_dia_vehicle_current v join _v using (entity_id);
select update_vehicle((select entity_id from _v),
  '{"status":"vendido","sale_price":"72000"}'::jsonb) is not null as updated;
select 'v_after', v.version_number, v.status, v.sale_price
from v_dia_vehicle_current v join _v using (entity_id);
select 'versions', count(*) from entity_versions ev join _v using (entity_id);
select 'v1_intact', (ev.data->>'status'), (ev.data->>'sale_price')
from entity_versions ev join _v using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const get = (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')

  // (a) version_number da versao corrente incrementou (1 -> 2).
  assert.deepEqual(
    get('v_before'),
    ['v_before', '1', 'em_estoque', '50000'],
    'estado inicial: versao 1, em_estoque, sale_price 50000',
  )
  assert.deepEqual(
    get('v_after'),
    ['v_after', '2', 'vendido', '72000'],
    'apos update: versao corrente = 2 com NOVOS valores (vendido, sale_price 72000)',
  )
  // (b) a versao anterior continua em entity_versions (historico preservado).
  assert.deepEqual(
    get('versions'),
    ['versions', '2'],
    'historico SCD2 deveria ter 2 versoes (criacao + update), nenhuma apagada',
  )
  assert.deepEqual(
    get('v1_intact'),
    ['v1_intact', 'em_estoque', '50000'],
    'a versao anterior (v1) deve permanecer intacta no historico (valores originais)',
  )
})

// ---------------------------------------------------------------------------
// AC: brand obrigatorio — create_vehicle sem brand (null/ausente) e' rejeitado
// (22023). A migration exige brand nao-vazio.
// ---------------------------------------------------------------------------
test('AC validacao: create_vehicle sem brand FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_vehicle('{"condition":"novo","model":"Y"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para brand ausente; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC: model obrigatorio — create_vehicle sem model (null/ausente) e' rejeitado
// (22023). A migration exige model nao-vazio.
// ---------------------------------------------------------------------------
test('AC validacao: create_vehicle sem model FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_vehicle('{"condition":"novo","brand":"X"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para model ausente; obtido: ${out}`)
})
