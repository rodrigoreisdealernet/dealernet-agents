// Teste de CONTRATO SQL — Part CRUD (issue #8), rodando contra o Postgres VIVO.
//
// Ambiente OFFLINE: SEM Supabase CLI e SEM runner instalavel. Usamos apenas os
// modulos nativos do Node (node:test + node:assert) e chamamos o psql do
// container Docker via child_process.execFileSync. Cada cenario roda dentro de
// uma transacao BEGIN; ... ROLLBACK; para NAO poluir o banco (idempotente) — e
// usa source_record_ids unicos de teste ('test-part-...'), NUNCA toca o seed demo.
//
// COMO RODAR:
//   node --test supabase/tests/part_crud.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Notas de implementacao (espelha vehicle_crud.test.mjs, mesmo padrao SCD2):
//   * dia_assert_part_writer() exige role de REQUISICAO 'authenticated' (ou
//     'service_role') E get_my_role() in (admin, branch_manager). get_my_role()
//     le auth.jwt() -> 'app_metadata' ->> 'role'. Por isso o JWT simulado precisa
//     de {"role":"authenticated", ..., "app_metadata":{"role":"<app_role>"}}.
//   * create_part/update_part/delete_part sao funcoes data-modifying. Capturamos
//     o entity_id numa TEMP TABLE (statement separado) antes de consultar a
//     view/historico no mesmo BEGIN/ROLLBACK.
//
// Cada teste traz no nome o criterio de aceite (spec docs/specs/8-feat-pecas-entidade-crud.md)
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

// Helper para montar um payload de peca minimo valido + overrides em JSONB.
// part_number/description sao obrigatorios; demais campos opcionais.
const partData = (overrides = {}) =>
  JSON.stringify({
    part_number: 'TEST-PN-001',
    description: 'Peca de teste',
    ...overrides,
  }).replace(/'/g, "''") // escape de aspas simples para o literal SQL

// Parser comum de saida multi-linha rotulada ('label|col1|col2').
const parseLabeled = (out) => {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
}

// ===========================================================================
// AC: create_part — happy path cria entidade + primeira versao corrente.
// ===========================================================================
test('AC create: create_part (admin) cria peca na view corrente com version 1 e status ativo', () => {
  const sql = `${asWriter('admin')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PN-CREATE',
    description: 'Filtro de oleo',
    unit_cost: '10',
    unit_price: '25',
    quantity_in_stock: '50',
    min_stock: '5',
    reorder_point: '10',
  })}'::jsonb);
select 'row', v.version_number, v.part_number, v.description, v.status
from v_dia_part_current v join _p using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(
    get('row'),
    ['row', '1', 'TEST-PN-CREATE', 'Filtro de oleo', 'ativo'],
    'peca criada deveria aparecer na view: versao 1, campos corretos, status default ativo',
  )
})

// ---------------------------------------------------------------------------
// AC: campos obrigatorios — part_number ausente e' rejeitado (22023).
// ---------------------------------------------------------------------------
test('AC validacao: create_part sem part_number FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_part('{"description":"sem numero"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para part_number ausente; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC: campos obrigatorios — description ausente e' rejeitado (22023).
// ---------------------------------------------------------------------------
test('AC validacao: create_part sem description FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_part('{"part_number":"PN-X"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para description ausente; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC: validacao de status — status fora do enum (ativo|inativo) e' rejeitado.
// ---------------------------------------------------------------------------
test('AC validacao: create_part com status invalido FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_part('{"part_number":"PN-X","description":"d","status":"zzz"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para status invalido; obtido: ${out}`)
})

// ===========================================================================
// AC: update_part faz merge SCD2 — incrementa version_number, preserva a versao
// anterior intacta e a view corrente reflete o novo valor.
// ===========================================================================
test('AC update SCD2: update_part incrementa version, preserva historico e view reflete novo valor', () => {
  const sql = `${asWriter('admin')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PN-UPD',
    description: 'Pastilha de freio',
    unit_cost: '40',
    unit_price: '90',
    quantity_in_stock: '12',
    min_stock: '4',
    reorder_point: '8',
  })}'::jsonb);
select 'v_before', v.version_number, v.unit_price, v.quantity_in_stock, v.description
from v_dia_part_current v join _p using (entity_id);
select update_part((select entity_id from _p),
  '{"unit_price":"110","quantity_in_stock":"20"}'::jsonb) is not null as updated;
select 'v_after', v.version_number, v.unit_price, v.quantity_in_stock, v.description
from v_dia_part_current v join _p using (entity_id);
select 'versions', count(*) from entity_versions ev join _p using (entity_id);
select 'v1_intact', (ev.data->>'unit_price'), (ev.data->>'quantity_in_stock')
from entity_versions ev join _p using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)

  // version 1 com valores originais
  assert.deepEqual(
    get('v_before'),
    ['v_before', '1', '90', '12', 'Pastilha de freio'],
    'estado inicial: versao 1, unit_price 90, qty 12',
  )
  // version 2 corrente com novos valores; campos nao alterados sao preservados (merge).
  assert.deepEqual(
    get('v_after'),
    ['v_after', '2', '110', '20', 'Pastilha de freio'],
    'apos update: versao corrente = 2 com unit_price 110 e qty 20, description preservada (merge)',
  )
  // historico SCD2 com 2 versoes, nenhuma apagada.
  assert.deepEqual(
    get('versions'),
    ['versions', '2'],
    'historico SCD2 deveria ter 2 versoes (criacao + update)',
  )
  // a versao 1 permanece intacta com os valores originais.
  assert.deepEqual(
    get('v1_intact'),
    ['v1_intact', '90', '12'],
    'a versao anterior (v1) deve permanecer intacta no historico',
  )
})

// ===========================================================================
// AC: delete_part = soft-delete — seta status inativo + retired e a peca SAI
// da v_dia_part_current; nenhum DELETE fisico (historico preservado).
// ===========================================================================
test('AC soft-delete: delete_part inativa e retira da view, preservando historico', () => {
  const sql = `${asWriter('admin')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PN-DEL',
    description: 'Correia dentada',
    quantity_in_stock: '7',
  })}'::jsonb);
select 'before', count(*) from v_dia_part_current v join _p using (entity_id);
select delete_part((select entity_id from _p)) is not null as deleted;
select 'after_view', count(*) from v_dia_part_current v join _p using (entity_id);
select 'versions', count(*) from entity_versions ev join _p using (entity_id);
select 'current', (ev.data->>'status'), coalesce((ev.data->>'retired'),'<null>')
from entity_versions ev join _p using (entity_id) where ev.is_current;
select 'v1_intact', (ev.data->>'status'), (ev.data ? 'retired')
from entity_versions ev join _p using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)

  assert.deepEqual(get('before'), ['before', '1'], 'peca deveria estar na view antes do delete')
  assert.deepEqual(get('after_view'), ['after_view', '0'], 'peca deveria SAIR da view apos soft-delete')
  assert.deepEqual(
    get('versions'),
    ['versions', '2'],
    'historico SCD2 deveria ter 2 versoes (criacao + baixa), nenhuma apagada',
  )
  // versao corrente: status inativo + retired true.
  assert.deepEqual(
    get('current'),
    ['current', 'inativo', 'true'],
    'a versao corrente apos delete deve ter status inativo e retired=true',
  )
  // versao 1 permanece intacta: status ativo, sem flag retired.
  assert.deepEqual(
    get('v1_intact'),
    ['v1_intact', 'ativo', 'f'],
    'a versao anterior (v1) deve permanecer intacta (ativo, sem retired)',
  )
})

// ===========================================================================
// AC: v_dia_part_current — stock_value = quantity_in_stock * unit_cost.
// ===========================================================================
test('AC view: stock_value = quantity_in_stock * unit_cost (round 2)', () => {
  const qty = 15
  const unitCost = 12.5
  const sql = `${asWriter('admin')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PN-VAL',
    description: 'Vela de ignicao',
    unit_cost: String(unitCost),
    quantity_in_stock: String(qty),
    min_stock: '1',
    reorder_point: '2',
  })}'::jsonb);
select 'val', v.stock_value
from v_dia_part_current v join _p using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  const expected = Math.round(qty * unitCost * 100) / 100
  assert.equal(
    Number(get('val')[1]),
    expected,
    `stock_value esperado=${expected} (=${qty}*${unitCost})`,
  )
})

// ===========================================================================
// AC: v_dia_part_current — precedencia do stock_status com casos de fronteira.
//   zerado  (qty=0) vence sobre tudo
//   critico (qty<=min_stock, >0); fronteira qty == min_stock => critico
//   baixo   (qty<=reorder_point, >min_stock)
//   ok      (qty>reorder_point); fronteira reorder_point+1 => ok
// ===========================================================================
test('AC stock_status: precedencia e fronteiras (zerado/critico/baixo/ok)', () => {
  // min_stock=5, reorder_point=10 em todos os casos.
  const cases = [
    // [label, qty, expectedStatus]
    ['zerado', 0, 'zerado'], // qty=0 vence mesmo com min/reorder definidos
    ['critico_below', 3, 'critico'], // qty < min_stock
    ['critico_eq_min', 5, 'critico'], // FRONTEIRA: qty == min_stock => critico
    ['baixo_below', 8, 'baixo'], // min_stock < qty <= reorder_point
    ['baixo_eq_reorder', 10, 'baixo'], // FRONTEIRA: qty == reorder_point => baixo
    ['ok_above', 11, 'ok'], // FRONTEIRA: qty == reorder_point+1 => ok
  ]
  const selects = cases
    .map(
      ([label, qty]) => `
create temp table _${label} on commit drop as
  select entity_id from create_part('${partData({
        part_number: `TEST-PN-${label}`,
        description: `caso ${label}`,
        unit_cost: '1',
        quantity_in_stock: String(qty),
        min_stock: '5',
        reorder_point: '10',
      })}'::jsonb);
select '${label}', v.stock_status from v_dia_part_current v join _${label} using (entity_id);`,
    )
    .join('\n')

  const sql = `${asWriter('admin')}
${selects}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  for (const [label, , expected] of cases) {
    assert.deepEqual(
      get(label),
      [label, expected],
      `caso ${label}: stock_status esperado=${expected}`,
    )
  }
})

// ---------------------------------------------------------------------------
// AC: stock_status — qty=0 vence mesmo quando min_stock=0 (zerado tem prioridade
// maxima; nao deve cair em 'critico' por qty<=min_stock).
// ---------------------------------------------------------------------------
test('AC stock_status: qty=0 com min_stock=0 ainda e zerado (nao critico)', () => {
  const sql = `${asWriter('admin')}
create temp table _z on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PN-ZERO0',
    description: 'sem estoque',
    unit_cost: '1',
    quantity_in_stock: '0',
    min_stock: '0',
    reorder_point: '0',
  })}'::jsonb);
select 'z', v.stock_status from v_dia_part_current v join _z using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(get('z'), ['z', 'zerado'], 'qty=0 deve ser zerado independentemente de min_stock')
})

// ===========================================================================
// AC: v_dia_parts_critical — retorna apenas baixo/critico/zerado, ordenado por
// criticidade (zerado -> critico -> baixo) e depois por part_number. Uma peca
// 'ok' NAO deve aparecer.
// ===========================================================================
test('AC view critical: filtra baixo/critico/zerado e ordena por criticidade', () => {
  // Cria 4 pecas (zerado, critico, baixo, ok), com part_numbers que provam o
  // tie-break secundario, e checa a ordem/filtro restritos as nossas pecas de teste.
  const sql = `${asWriter('admin')}
create temp table _ids (label text, entity_id uuid) on commit drop;
insert into _ids select 'zerado',  entity_id from create_part('${partData({
    part_number: 'TEST-CRIT-Z',
    description: 'z',
    unit_cost: '1',
    quantity_in_stock: '0',
    min_stock: '5',
    reorder_point: '10',
  })}'::jsonb);
insert into _ids select 'critico', entity_id from create_part('${partData({
    part_number: 'TEST-CRIT-C',
    description: 'c',
    unit_cost: '1',
    quantity_in_stock: '3',
    min_stock: '5',
    reorder_point: '10',
  })}'::jsonb);
insert into _ids select 'baixo',   entity_id from create_part('${partData({
    part_number: 'TEST-CRIT-B',
    description: 'b',
    unit_cost: '1',
    quantity_in_stock: '8',
    min_stock: '5',
    reorder_point: '10',
  })}'::jsonb);
insert into _ids select 'ok',      entity_id from create_part('${partData({
    part_number: 'TEST-CRIT-OK',
    description: 'o',
    unit_cost: '1',
    quantity_in_stock: '50',
    min_stock: '5',
    reorder_point: '10',
  })}'::jsonb);
-- Lista, em ordem da view, apenas as pecas de teste deste cenario.
select c.stock_status
from v_dia_parts_critical c
join _ids i on i.entity_id = c.entity_id
order by c.criticality_rank, c.part_number;
-- Conta se a peca 'ok' vazou para a view critica (deveria ser 0).
select 'ok_leak', count(*)
from v_dia_parts_critical c
join _ids i on i.entity_id = c.entity_id
where i.label = 'ok';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const statuses = lines.filter((l) => !l.startsWith('ok_leak|'))
  const okLeak = lines.find((l) => l.startsWith('ok_leak|'))?.split('|')

  // Ordem por criticidade: zerado, critico, baixo. 'ok' nao aparece.
  assert.deepEqual(
    statuses,
    ['zerado', 'critico', 'baixo'],
    'v_dia_parts_critical deve listar zerado -> critico -> baixo e excluir ok',
  )
  assert.deepEqual(okLeak, ['ok_leak', '0'], 'peca ok NAO deve aparecer na view critica')
})

// ===========================================================================
// AC: role guard — escrita requer admin/branch_manager; read_only e' negado (42501).
// ===========================================================================
test('AC role-guard: create_part como read_only FALHA com SQLSTATE 42501', () => {
  const sql = `${asWriter('read_only')}
${captureSqlstate(`perform create_part('{"part_number":"PN-RO","description":"d"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado SQLSTATE 42501 para read_only; obtido: ${out}`)
})

test('AC role-guard: update_part como read_only FALHA com SQLSTATE 42501', () => {
  // Cria como admin numa tx separada (capturado em temp) — mas como a tx faz
  // rollback, criamos e atualizamos no MESMO BEGIN, trocando o JWT no meio.
  const sql = `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims('admin')}', true) \\g /dev/null
create temp table _p on commit drop as
  select entity_id from create_part('{"part_number":"PN-UPDRO","description":"d"}'::jsonb);
select set_config('request.jwt.claims', '${claims('read_only')}', true) \\g /dev/null
${captureSqlstate(`perform update_part((select entity_id from _p), '{"unit_price":"5"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  // saida contem apenas a linha do captureSqlstate (set_config foi para /dev/null).
  assert.equal(out, 'SQLSTATE=42501', `esperado 42501 para read_only no update; obtido: ${out}`)
})

test('AC role-guard: delete_part como read_only FALHA com SQLSTATE 42501', () => {
  const sql = `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims('admin')}', true) \\g /dev/null
create temp table _p on commit drop as
  select entity_id from create_part('{"part_number":"PN-DELRO","description":"d"}'::jsonb);
select set_config('request.jwt.claims', '${claims('read_only')}', true) \\g /dev/null
${captureSqlstate(`perform delete_part((select entity_id from _p));`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado 42501 para read_only no delete; obtido: ${out}`)
})

test('AC role-guard: create_part como branch_manager SUCEDE (retorna entity_id)', () => {
  const sql = `${asWriter('branch_manager')}
select entity_id is not null as created
from create_part('${partData({ part_number: 'TEST-PN-BM', description: 'manager' })}'::jsonb);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', `branch_manager deveria criar peca; saida=${out}`)
})

test('AC role-guard: create_part como admin SUCEDE (retorna entity_id)', () => {
  const sql = `${asWriter('admin')}
select entity_id is not null as created
from create_part('${partData({ part_number: 'TEST-PN-ADM', description: 'admin' })}'::jsonb);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', `admin deveria criar peca; saida=${out}`)
})
