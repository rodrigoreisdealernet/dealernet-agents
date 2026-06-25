// Teste de CONTRATO SQL — Part Sale CRUD (issue #10), rodando contra o Postgres VIVO.
//
// Ambiente OFFLINE: SEM Supabase CLI e SEM runner instalavel. Usamos apenas os
// modulos nativos do Node (node:test + node:assert) e chamamos o psql do
// container Docker via child_process.execFileSync. Cada cenario roda dentro de
// uma transacao BEGIN; ... ROLLBACK; para NAO poluir o banco (idempotente) — e
// usa source_record_ids unicos de teste ('test-part-sale-...'), NUNCA toca o seed.
//
// COMO RODAR:
//   node --test supabase/tests/part_sale_crud.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Notas de implementacao (espelha part_crud.test.mjs, mesmo padrao SCD2):
//   * dia_assert_part_sale_writer() exige role de REQUISICAO 'authenticated' (ou
//     'service_role') E get_my_role() in (admin, branch_manager). get_my_role()
//     le auth.jwt() -> 'app_metadata' ->> 'role'. Por isso o JWT simulado precisa
//     de {"role":"authenticated", ..., "app_metadata":{"role":"<app_role>"}}.
//   * create_part_sale/cancel_part_sale sao funcoes data-modifying. Capturamos o
//     entity_id da peca e da venda em TEMP TABLE (statement separado) antes de
//     consultar as views no mesmo BEGIN/ROLLBACK.
//   * A venda decrementa a peca na MESMA transacao (movimento de estoque atomico):
//     se quantity > quantity_in_stock, RAISE 22023 ANTES de qualquer escrita.
//
// Cada teste traz no nome o criterio de aceite (spec da issue #10) que verifica.

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

// Troca o JWT no meio de uma mesma transacao (sem abrir/fechar).
const switchRole = (appRole) =>
  `select set_config('request.jwt.claims', '${claims(appRole)}', true) \\g /dev/null\n`

// Captura o SQLSTATE de uma chamada que DEVE falhar. RAISE NOTICE sai em stderr
// (que execFileSync nao retorna no caminho de sucesso), entao gravamos o
// resultado numa temp table e fazemos SELECT — assim a saida vem em STDOUT.
// Retorna a linha: 'SQLSTATE=<code>' ou 'NO_ERROR' (se a chamada nao falhou).
function captureSqlstate(stmt) {
  return `
do $$ begin
  ${stmt}
  insert into _r values ('NO_ERROR');
exception when others then
  insert into _r values ('SQLSTATE=' || SQLSTATE);
end $$;
`
}

// Tabela usada por captureSqlstate; criada uma vez por transacao.
const declareResult = `create temp table _r (outcome text) on commit drop;\n`

// Helper para montar um payload de peca minimo valido + overrides em JSONB.
const partData = (overrides = {}) =>
  JSON.stringify({
    part_number: 'TEST-PS-PN',
    description: 'Peca para venda',
    ...overrides,
  }).replace(/'/g, "''") // escape de aspas simples para o literal SQL

// Helper para montar payload de venda em JSONB (part_id injetado via subselect no SQL,
// entao aqui montamos apenas os campos escalares e concatenamos no proprio SQL).
const saleData = (overrides = {}) =>
  JSON.stringify({
    quantity: 1,
    unit_price: 100,
    sale_date: '2026-06-25',
    customer: 'Cliente Teste',
    salesperson: 'Vendedor Teste',
    ...overrides,
  }).replace(/'/g, "''")

// Parser comum de saida multi-linha rotulada ('label|col1|col2').
const parseLabeled = (out) => {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
}

// Monta um create_part_sale embutindo o part_id de uma temp table _p no payload.
// jsonb_build_object('part_id', (select entity_id::text from _p)) || <demais campos>.
const createSaleSql = (overrides) => `
create_part_sale(
  jsonb_build_object('part_id', (select entity_id::text from _p))
  || '${saleData(overrides)}'::jsonb
)`

// ===========================================================================
// AC #1: uma venda decrementa o estoque da peca na MESMA transacao e a venda
// aparece em v_dia_part_sale_current com total = qty*unit_price - discount.
// ===========================================================================
test('AC1 decremento: create_part_sale qty 3 baixa estoque 10->7 e total=qty*price-discount', () => {
  const sql = `${asWriter('admin')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-DEC',
    description: 'Filtro',
    unit_cost: '10',
    unit_price: '25',
    quantity_in_stock: '10',
    min_stock: '2',
    reorder_point: '4',
  })}'::jsonb);
select 'stock_before', v.quantity_in_stock from v_dia_part_current v join _p using (entity_id);
create temp table _s on commit drop as
  select entity_id from ${createSaleSql({ quantity: 3, unit_price: 25, discount: 5 })};
select 'stock_after', v.quantity_in_stock from v_dia_part_current v join _p using (entity_id);
select 'sale', s.quantity, s.unit_price, s.discount, s.total, s.status, s.channel
from v_dia_part_sale_current s join _s using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(get('stock_before'), ['stock_before', '10'], 'estoque inicial 10')
  assert.deepEqual(
    get('stock_after'),
    ['stock_after', '7'],
    'apos venda de 3, estoque deve cair para 7 na mesma transacao',
  )
  // total = 3*25 - 5 = 70. channel default 'balcao', status default 'registrada'.
  assert.deepEqual(
    get('sale'),
    ['sale', '3', '25', '5', '70.00', 'registrada', 'balcao'],
    'venda na view: qty 3, price 25, discount 5, total 70.00, registrada, balcao',
  )
})

// ===========================================================================
// AC #2: a venda dispara a transicao de stock_status (ok -> critico -> zerado),
// lida em v_dia_part_current apos o movimento.
// ===========================================================================
test('AC2 transicao status: venda empurra peca de ok para critico (estoque <= min_stock)', () => {
  // min_stock=3, reorder_point=6, qty=10 (ok). Vender 7 => 3 (== min_stock => critico).
  const sql = `${asWriter('admin')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-CRIT',
    description: 'Pastilha',
    unit_cost: '1',
    unit_price: '50',
    quantity_in_stock: '10',
    min_stock: '3',
    reorder_point: '6',
  })}'::jsonb);
select 'before', v.quantity_in_stock, v.stock_status from v_dia_part_current v join _p using (entity_id);
create temp table _s on commit drop as
  select entity_id from ${createSaleSql({ quantity: 7, unit_price: 50 })};
select 'after', v.quantity_in_stock, v.stock_status from v_dia_part_current v join _p using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(get('before'), ['before', '10', 'ok'], 'estado inicial: 10 unidades, status ok')
  assert.deepEqual(
    get('after'),
    ['after', '3', 'critico'],
    'apos vender 7, estoque 3 (== min_stock) deve virar critico',
  )
})

test('AC2 transicao status: vender ate o fim leva a peca para zerado', () => {
  // qty=4, vender 4 => 0 (zerado vence tudo).
  const sql = `${asWriter('admin')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-ZERO',
    description: 'Vela',
    unit_cost: '1',
    unit_price: '20',
    quantity_in_stock: '4',
    min_stock: '2',
    reorder_point: '3',
  })}'::jsonb);
create temp table _s on commit drop as
  select entity_id from ${createSaleSql({ quantity: 4, unit_price: 20 })};
select 'after', v.quantity_in_stock, v.stock_status from v_dia_part_current v join _p using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(
    get('after'),
    ['after', '0', 'zerado'],
    'apos vender todo o estoque, quantity_in_stock=0 e status=zerado',
  )
})

// ===========================================================================
// AC #3: venda acima do estoque e' REJEITADA (22023), estoque permanece intacto
// (nunca negativo) e NENHUMA linha de venda e' criada (atomicidade).
// ===========================================================================
test('AC3 over-stock: vender 9 de peca com 5 FALHA (22023), estoque fica 5, sem venda', () => {
  const sql = `${asWriter('admin')}
${declareResult}create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-OVER',
    description: 'Correia',
    unit_cost: '1',
    unit_price: '30',
    quantity_in_stock: '5',
    min_stock: '1',
    reorder_point: '2',
  })}'::jsonb);
${captureSqlstate(`perform * from ${createSaleSql({ quantity: 9, unit_price: 30 })};`)}
select outcome from _r;
select 'stock', v.quantity_in_stock from v_dia_part_current v join _p using (entity_id);
select 'sales', count(*)
from v_dia_part_sale_current s where s.part_id = (select entity_id from _p);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const get = parseLabeled(out)
  assert.ok(
    lines.includes('SQLSTATE=22023'),
    `esperado SQLSTATE 22023 (insufficient stock); saida: ${out}`,
  )
  // estoque inalterado — nunca negativo, nenhuma escrita parcial.
  assert.deepEqual(get('stock'), ['stock', '5'], 'estoque deve permanecer 5 (intacto, nao negativo)')
  // nenhuma venda registrada (rollback do RAISE dentro do corpo plpgsql).
  assert.deepEqual(get('sales'), ['sales', '0'], 'nenhuma linha de venda deve ter sido criada')
})

// ===========================================================================
// AC #4: cancelar uma venda devolve o estoque (restock) e a venda some da view
// corrente (status cancelada e' filtrado).
// ===========================================================================
test('AC4 cancelamento: cancel_part_sale restock 7->10 e remove venda da view corrente', () => {
  const sql = `${asWriter('admin')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-CANCEL',
    description: 'Amortecedor',
    unit_cost: '1',
    unit_price: '40',
    quantity_in_stock: '10',
    min_stock: '2',
    reorder_point: '4',
  })}'::jsonb);
create temp table _s on commit drop as
  select entity_id from ${createSaleSql({ quantity: 3, unit_price: 40 })};
select 'stock_after_sale', v.quantity_in_stock from v_dia_part_current v join _p using (entity_id);
select 'sale_visible', count(*) from v_dia_part_sale_current s join _s using (entity_id);
select cancel_part_sale((select entity_id from _s)) is not null as cancelled;
select 'stock_after_cancel', v.quantity_in_stock from v_dia_part_current v join _p using (entity_id);
select 'sale_after_cancel', count(*) from v_dia_part_sale_current s join _s using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(get('stock_after_sale'), ['stock_after_sale', '7'], 'venda de 3 baixa 10->7')
  assert.deepEqual(get('sale_visible'), ['sale_visible', '1'], 'venda registrada visivel antes do cancel')
  assert.deepEqual(
    get('stock_after_cancel'),
    ['stock_after_cancel', '10'],
    'cancelamento devolve as 3 unidades: estoque volta a 10',
  )
  assert.deepEqual(
    get('sale_after_cancel'),
    ['sale_after_cancel', '0'],
    'venda cancelada deve sumir de v_dia_part_sale_current (status filtrado)',
  )
})

// ===========================================================================
// AC #5: cancelamento e' idempotente — cancelar duas vezes NAO faz restock duplo.
// ===========================================================================
test('AC5 idempotencia: cancelar a mesma venda duas vezes nao faz restock duplo (fica 10, nao 13)', () => {
  const sql = `${asWriter('admin')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-IDEM',
    description: 'Bomba',
    unit_cost: '1',
    unit_price: '15',
    quantity_in_stock: '10',
    min_stock: '2',
    reorder_point: '4',
  })}'::jsonb);
create temp table _s on commit drop as
  select entity_id from ${createSaleSql({ quantity: 3, unit_price: 15 })};
select cancel_part_sale((select entity_id from _s)) is not null as c1;
select 'after_first_cancel', v.quantity_in_stock from v_dia_part_current v join _p using (entity_id);
select cancel_part_sale((select entity_id from _s)) is not null as c2;
select 'after_second_cancel', v.quantity_in_stock from v_dia_part_current v join _p using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(
    get('after_first_cancel'),
    ['after_first_cancel', '10'],
    'primeiro cancel restock 7->10',
  )
  assert.deepEqual(
    get('after_second_cancel'),
    ['after_second_cancel', '10'],
    'segundo cancel e no-op idempotente: estoque continua 10 (nao 13)',
  )
})

// ===========================================================================
// AC #6: validacao do payload — quantity <= 0 ou part_id ausente FALHA (22023).
// ===========================================================================
test('AC6 validacao: create_part_sale com quantity 0 FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${declareResult}create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-Q0',
    description: 'Qualquer',
    quantity_in_stock: '10',
  })}'::jsonb);
${captureSqlstate(`perform * from ${createSaleSql({ quantity: 0, unit_price: 10 })};`)}
select outcome from _r;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para quantity<=0; obtido: ${out}`)
})

test('AC6 validacao: create_part_sale sem part_id FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${declareResult}${captureSqlstate(
    `perform * from create_part_sale('{"quantity":"1","unit_price":"10"}'::jsonb);`,
  )}
select outcome from _r;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para part_id ausente; obtido: ${out}`)
})

// ===========================================================================
// AC #7: role guard — escrita exige admin/branch_manager; read_only e' negado
// (42501) tanto em create_part_sale quanto em cancel_part_sale.
// ===========================================================================
test('AC7 role-guard: create_part_sale como read_only FALHA com SQLSTATE 42501', () => {
  // Cria a peca como admin e troca para read_only antes da venda (mesma tx).
  const sql = `${asWriter('admin')}
${declareResult}create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-RO',
    description: 'Negado',
    quantity_in_stock: '10',
  })}'::jsonb);
${switchRole('read_only')}${captureSqlstate(
    `perform * from ${createSaleSql({ quantity: 1, unit_price: 10 })};`,
  )}
select outcome from _r;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado 42501 para read_only no create; obtido: ${out}`)
})

test('AC7 role-guard: cancel_part_sale como read_only FALHA com SQLSTATE 42501', () => {
  // Cria peca + venda como admin, troca para read_only e tenta cancelar (mesma tx).
  const sql = `${asWriter('admin')}
${declareResult}create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-ROCAN',
    description: 'Negado cancel',
    quantity_in_stock: '10',
  })}'::jsonb);
create temp table _s on commit drop as
  select entity_id from ${createSaleSql({ quantity: 2, unit_price: 10 })};
${switchRole('read_only')}${captureSqlstate(
    `perform cancel_part_sale((select entity_id from _s));`,
  )}
select outcome from _r;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado 42501 para read_only no cancel; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC #7 (positivo): branch_manager pode vender (escrita liberada) — complementa
// os cenarios admin de AC1-AC5 e prova que o guard nao bloqueia o role valido.
// ---------------------------------------------------------------------------
test('AC7 role-guard: create_part_sale como branch_manager SUCEDE e decrementa estoque', () => {
  const sql = `${asWriter('branch_manager')}
create temp table _p on commit drop as
  select entity_id from create_part('${partData({
    part_number: 'TEST-PS-BM',
    description: 'Permitido',
    unit_cost: '1',
    unit_price: '12',
    quantity_in_stock: '8',
    min_stock: '1',
    reorder_point: '2',
  })}'::jsonb);
create temp table _s on commit drop as
  select entity_id from ${createSaleSql({ quantity: 2, unit_price: 12 })};
select 'sale_ok', (s.entity_id is not null), s.total
from v_dia_part_sale_current s join _s using (entity_id);
select 'stock', v.quantity_in_stock from v_dia_part_current v join _p using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = parseLabeled(out)
  assert.deepEqual(
    get('sale_ok'),
    ['sale_ok', 't', '24.00'],
    'branch_manager deveria registrar a venda (total 2*12=24.00)',
  )
  assert.deepEqual(get('stock'), ['stock', '6'], 'estoque cai 8->6 apos a venda do branch_manager')
})
