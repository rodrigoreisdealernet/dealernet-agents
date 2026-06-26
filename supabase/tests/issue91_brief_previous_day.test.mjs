// Teste de CONTRATO SQL — issue #91 (Morning Brief do Dono VOLTA a janela de
// MÊS CORRENTE (MTD) para o DIA ANTERIOR — now()::date - 1), rodando contra o
// Postgres VIVO do Supabase.
//
// O QUE A MUDANÇA DA #91 FAZ (migration 20260627140000_..._previous_day.sql):
//   create or replace de v_dia_owner_brief_by_brand / _by_store IDÊNTICAS à versão
//   MTD (20260627120000_..._month_to_date.sql) EXCETO pela janela temporal: o CTE
//   `month_window` ([1º dia do mês, 1º dia do próximo mês)) vira `day_window` com
//   um único `prev_day = now()::date - 1`, e cada setor de período compara sua data
//   por IGUALDADE a prev_day:
//     * Novos/Usados: coalesce(sold_at, updated_at, valid_from)::date = prev_day
//     * Peças: part_sale com sale_date::date = prev_day; valor =
//       quantity*unit_price - coalesce(discount,0); exclui 'cancelada'
//     * AT: service_order com opened_at::date = prev_day; soma revenue; exclui 'cancelada'
//     * FP (Floor Plan): INALTERADO — "as of now" (estoque atual, SEM filtro de data)
//   As correções de Peças/AT introduzidas no MTD permanecem; só a janela reverte.
//
// PADRÃO: idêntico a issue43_owner_brief.test.mjs / issue85_brief_yesterday.test.mjs.
//   * Ambiente OFFLINE: só node:test + node:assert; psql do container Docker via
//     execFileSync. Cada cenário roda em BEGIN; ... ROLLBACK; — NUNCA reseta nem
//     polui o banco compartilhado e NÃO depende do seed global já ter rodado:
//     o teste INSERE as próprias linhas (create_vehicle/create_part/create_part_sale/
//     create_service_order — o mesmo caminho da UI e do seed), com JWT de admin.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/issue91_brief_previous_day.test.mjs
// Pré-requisito: container Postgres do Supabase no ar E migrations aplicadas:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//   migrations: 20260626140000_dia_owner_brief_by_brand.sql
//               20260627120000_dia_owner_brief_month_to_date.sql
//               20260627140000_dia_owner_brief_previous_day.sql  (DEFINIÇÃO VIVA)
//
// CADA ASSERT FALHA SE A JANELA FOR REVERTIDA AO MTD (ou se uma correção regredir):
//   provamos a janela com pares de datas que só coincidem em "dia anterior" e DIVERGEM
//   em MTD — uma venda de ANTEONTEM (now()::date - 2) e uma do INÍCIO DO MÊS
//   (date_trunc('month', now())) que NÃO é ontem entrariam sob MTD mas NÃO devem
//   entrar sob dia-anterior.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const CONTAINER = 'supabase_db_dealernet-agents'

// JWT canônico: role de requisição 'authenticated'; app_metadata.role = admin
// (habilita o writer guard das RPCs), igual a issue43/issue85_owner_brief.
const ADMIN_CLAIMS = JSON.stringify({
  role: 'authenticated',
  sub: '00000000-0000-0000-0000-0000000000aa',
  app_metadata: { role: 'admin' },
})

// Executa SQL no Postgres vivo via psql. -t -A -F'|' (tuplas-only, unaligned,
// separador pipe); ON_ERROR_STOP=1 quebra em erro inesperado.
function psql(sql, { expectError = false } = {}) {
  const args = [
    'exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-q', '-t', '-A', '-F', '|',
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

// Roda uma consulta escalar dentro de begin;...rollback; e retorna o valor.
function scalar(query) {
  const { ok, out, err } = psql(`begin;\n${query}\nrollback;`)
  assert.ok(ok, `psql falhou: ${err}`)
  return out
}

// Lista ordenada (CSV) das colunas de uma view, via information_schema.
function columnsCsv(viewName) {
  return scalar(
    `select string_agg(column_name, ',' order by column_name)
       from information_schema.columns
      where table_schema = 'public' and table_name = '${viewName}';`,
  )
}

// Prefácio: abre txn, vira authenticated e injeta o JWT de admin (writer).
const AS_ADMIN = `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${ADMIN_CLAIMS}', true) \\g /dev/null
`

// Parser de saída multi-linha (key|... por linha): get('key') -> array de campos.
function rows(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
}

// Datas-âncora RELATIVAS (robustas a qualquer dia):
//   yesterday   = now()::date - 1  — a NOVA janela (dia anterior).
//   twoDaysAgo  = now()::date - 2  — SEMPRE fora da janela dia-anterior; sob MTD
//                 (exceto dia 1/2 do mês) AINDA contaria → prova o revert.
//   monthStart  = date_trunc('month', now())::date — o 1º dia do mês. Está SEMPRE
//                 dentro do MTD mas (na grande maioria dos dias) NÃO é ontem; se
//                 calhar de ser ontem (rodando no dia 2), caímos para now()::date-3.
const yesterday = `(now()::date - 1)::text`
const twoDaysAgo = `(now()::date - 2)::text`
// "início do mês, mas não ontem" — se monthStart == ontem (dia 2 do mês), usa now()-3.
const monthNotYesterday = `(case when date_trunc('month', now())::date = now()::date - 1
                                 then now()::date - 3
                                 else date_trunc('month', now())::date end)::text`

// ---------------------------------------------------------------------------
// AC1 — Inclusão do dia anterior: um NOVO e um USADO vendidos ONTEM
// (now()::date - 1) para uma marca conhecida aparecem com novos_units>=1,
// usados_units>=1 e resultado>0. (resultado por marca = Novos+Usados.)
// ---------------------------------------------------------------------------
test('AC1: vendas NOVO+USADO de ONTEM populam novos_units/usados_units e resultado>0', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ91_INCL","model":"N1","store":"Loja A","cost":"100000","sale_price":"150000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ91_INCL","model":"U1","store":"Loja A","cost":"80000","sale_price":"100000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'r', novos_units, usados_units, (resultado > 0)
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ91_INCL';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    rows(out)('r'),
    ['r', '1', '1', 't'],
    'a marca deveria ter novos_units=1, usados_units=1 e resultado>0 com vendas de ONTEM',
  )
})

// ---------------------------------------------------------------------------
// AC2 — EXCLUSÃO da janela (a prova-chave do revert): para a MESMA marca,
// inserimos (a) uma venda de ANTEONTEM (now()::date - 2) e (b) uma venda do
// INÍCIO DO MÊS que NÃO é ontem (date_trunc('month', now()), ou now()-3 se calhar
// de ser ontem) — AMBAS contariam sob MTD, NENHUMA pode contar sob dia-anterior.
// Junto com uma venda de ONTEM, asseguramos que SÓ a de ontem entra.
// ---------------------------------------------------------------------------
test('AC2: vendas de ANTEONTEM e do início do mês NÃO contam; só a de ONTEM entra', () => {
  const sql = `${AS_ADMIN}
-- (a) ONTEM: deve contar (1 unidade nova).
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ91_WIN","model":"Ontem","store":"L1","cost":"60000","sale_price":"90000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
-- (b) ANTEONTEM: NÃO deve contar (entraria sob MTD).
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ91_WIN","model":"Anteontem","store":"L1","cost":"60000","sale_price":"90000","status":"vendido","sold_at":"' || ${twoDaysAgo} || '"}')::jsonb) \\g /dev/null
-- (c) INÍCIO DO MÊS (não-ontem): NÃO deve contar (entraria sob MTD).
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ91_WIN","model":"InicioMes","store":"L1","cost":"50000","sale_price":"70000","status":"vendido","sold_at":"' || ${monthNotYesterday} || '"}')::jsonb) \\g /dev/null
select 'w', novos_units, usados_units, novos_value, usados_value
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ91_WIN';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  // SÓ a venda de ONTEM (1 nova, R$90000) conta. usados_units=0 (a usado é do início
  // do mês), e novos_units=1 (a de anteontem não entra). Sob MTD seriam 2 novos + 1 usado.
  assert.deepEqual(
    rows(out)('w'),
    ['w', '1', '0', '90000.00', ''],
    'só a venda de ONTEM deveria contar: novos_units=1/90000, usados_units=0 (anteontem e início-do-mês fora da janela)',
  )
})

// ---------------------------------------------------------------------------
// AC3 — Peças preservadas + dia anterior: uma venda de peça (part_sale,
// sale_date = ONTEM, referenciando uma peça em estoque) faz pecas_value sair
// NON-NULL e > 0; uma venda de peça datada de ANTEONTEM NÃO soma a pecas_value.
// Prova a correção (part_sale/sale_date/valor=quantity*unit_price-discount) E a
// nova janela. Comparamos o pecas_value group-wide nos dois cenários (rollback
// isola cada um, então cada cenário só vê suas próprias linhas + o seed).
// ---------------------------------------------------------------------------
test('AC3: peça de ONTEM popula pecas_value (>0); peça de ANTEONTEM NÃO soma', () => {
  // Cenário 1: peça vendida ONTEM (deve contar).
  const sqlYesterday = `${AS_ADMIN}
select create_part(
  '{"part_number":"ZZ91-P1","description":"Peca 91","quantity_in_stock":"100","unit_cost":"10","unit_price":"100","status":"ativo","source_record_id":"zz91-part-ontem"}'::jsonb) \\g /dev/null
select create_part_sale(jsonb_build_object(
  'part_id', (select id from entities where entity_type = 'part' and source_record_id = 'zz91-part-ontem')::text,
  'quantity', 5, 'unit_price', 100, 'discount', 0, 'sale_date', ${yesterday})) \\g /dev/null
select 'pec', (pecas_value is not null), (pecas_value >= 500)
  from v_dia_owner_brief_by_brand limit 1;
rollback;
`
  const r1 = psql(sqlYesterday)
  assert.ok(r1.ok, `psql falhou: ${r1.err}`)
  assert.deepEqual(
    rows(r1.out)('pec'),
    ['pec', 't', 't'],
    'pecas_value deveria ser NON-NULL e >= 500 (5*100) com venda de peça de ONTEM',
  )

  // Cenário 2: peça vendida ANTEONTEM — NÃO deve somar a pecas_value. Capturamos
  // pecas_value ANTES e DEPOIS da inserção na mesma txn: deve ficar IGUAL (ou NULL).
  const sqlTwoDaysAgo = `${AS_ADMIN}
select 'before', coalesce(pecas_value, 0) from v_dia_owner_brief_by_brand limit 1;
select create_part(
  '{"part_number":"ZZ91-P2","description":"Peca 91b","quantity_in_stock":"100","unit_cost":"10","unit_price":"100","status":"ativo","source_record_id":"zz91-part-anteontem"}'::jsonb) \\g /dev/null
select create_part_sale(jsonb_build_object(
  'part_id', (select id from entities where entity_type = 'part' and source_record_id = 'zz91-part-anteontem')::text,
  'quantity', 9, 'unit_price', 100, 'discount', 0, 'sale_date', ${twoDaysAgo})) \\g /dev/null
select 'after', coalesce(pecas_value, 0) from v_dia_owner_brief_by_brand limit 1;
rollback;
`
  const r2 = psql(sqlTwoDaysAgo)
  assert.ok(r2.ok, `psql falhou: ${r2.err}`)
  const before = rows(r2.out)('before')?.[1]
  const after = rows(r2.out)('after')?.[1]
  assert.equal(
    after,
    before,
    `peça de ANTEONTEM NÃO deveria somar a pecas_value (before=${before}, after=${after}); entraria sob MTD`,
  )
})

// ---------------------------------------------------------------------------
// AC4 — AT/Oficina preservada + dia anterior: uma OS 'concluida' aberta ONTEM
// com revenue faz at_value sair NON-NULL e > 0; uma OS aberta ANTEONTEM NÃO soma;
// e uma OS 'cancelada' aberta ONTEM é EXCLUÍDA (fix preservado). Comparamos
// at_value antes/depois para os casos de exclusão.
// ---------------------------------------------------------------------------
test('AC4: OS de ONTEM popula at_value (>0); ANTEONTEM e CANCELADA de ontem são excluídas', () => {
  // Cenário 1: OS concluída aberta ONTEM com revenue (deve contar).
  const sqlYesterday = `${AS_ADMIN}
select create_service_order(
  ('{"customer":"Cliente ZZ91","description":"OS 91","status":"concluida","revenue":"1340","opened_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'at', (at_value is not null), (at_value >= 1340)
  from v_dia_owner_brief_by_brand limit 1;
rollback;
`
  const r1 = psql(sqlYesterday)
  assert.ok(r1.ok, `psql falhou: ${r1.err}`)
  assert.deepEqual(
    rows(r1.out)('at'),
    ['at', 't', 't'],
    'at_value deveria ser NON-NULL e >= 1340 com OS aberta ONTEM e revenue',
  )

  // Cenário 2: OS aberta ANTEONTEM — NÃO deve somar a at_value (entraria sob MTD).
  const sqlTwoDaysAgo = `${AS_ADMIN}
select 'before', coalesce(at_value, 0) from v_dia_owner_brief_by_brand limit 1;
select create_service_order(
  ('{"customer":"Cliente ZZ91b","description":"OS 91 anteontem","status":"concluida","revenue":"7777","opened_at":"' || ${twoDaysAgo} || '"}')::jsonb) \\g /dev/null
select 'after', coalesce(at_value, 0) from v_dia_owner_brief_by_brand limit 1;
rollback;
`
  const r2 = psql(sqlTwoDaysAgo)
  assert.ok(r2.ok, `psql falhou: ${r2.err}`)
  assert.equal(
    rows(r2.out)('after')?.[1],
    rows(r2.out)('before')?.[1],
    'OS de ANTEONTEM NÃO deveria somar a at_value; entraria sob MTD',
  )

  // Cenário 3: OS 'cancelada' aberta ONTEM — EXCLUÍDA (fix preservado).
  const sqlCancelled = `${AS_ADMIN}
select 'before', coalesce(at_value, 0) from v_dia_owner_brief_by_brand limit 1;
select create_service_order(
  ('{"customer":"Cliente ZZ91c","description":"OS 91 cancelada","status":"cancelada","revenue":"9999","opened_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'after', coalesce(at_value, 0) from v_dia_owner_brief_by_brand limit 1;
rollback;
`
  const r3 = psql(sqlCancelled)
  assert.ok(r3.ok, `psql falhou: ${r3.err}`)
  assert.equal(
    rows(r3.out)('after')?.[1],
    rows(r3.out)('before')?.[1],
    "OS 'cancelada' de ONTEM deveria ser excluída de at_value (fix preservado)",
  )
})

// ---------------------------------------------------------------------------
// AC5 — Floor Plan INALTERADO ("as of now"): um veículo EM ESTOQUE aging
// (days_in_stock >= 83; purchase_date = now()-90) ainda conta em fp_units e
// fp_units_at_risk, INDEPENDENTE de qualquer janela de data. Uma venda de ONTEM
// (status='vendido') NÃO entra no FP. Prova que FP não foi tocado pelo revert.
// ---------------------------------------------------------------------------
test('AC5: FP continua "as of now" — estoque aging conta; venda de ontem não entra no FP', () => {
  const sql = `${AS_ADMIN}
-- Venda de ONTEM (não entra no FP, que é status='em_estoque').
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ91_FP","model":"Vendido","store":"L1","cost":"50000","sale_price":"80000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
-- Estoque aging at-risk (days_in_stock=90 >= 83), comprado há 90 dias — fora de
-- qualquer janela de "dia anterior", mas DEVE contar pois FP é "as of now".
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ91_FP","model":"Velho","store":"L1","cost":"40000","status":"em_estoque","purchase_date":"' || (now()::date - 90)::text || '"}')::jsonb) \\g /dev/null
select 'fp', fp_units, fp_units_at_risk, (fp_value > 0), (fp_value_at_risk > 0)
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ91_FP';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    rows(out)('fp'),
    ['fp', '1', '1', 't', 't'],
    'FP deveria contar SÓ o estoque aging (fp_units=1, at-risk=1), independente da janela; venda de ontem não entra',
  )
})

// ---------------------------------------------------------------------------
// AC6 — Shape de colunas inalterado + security_invoker + helper. As duas views
// expõem EXATAMENTE o mesmo conjunto de colunas do estado MTD; ambas são
// security_invoker=true; o helper dia_owner_brief_at_risk_days() = 83.
// ---------------------------------------------------------------------------
test('AC6: shape de colunas idêntico ao MTD, security_invoker=true, helper=83', () => {
  // by_brand: conjunto EXATO de colunas (igual ao contrato do estado MTD #43).
  const expectedBrand = [
    'at_margin',
    'at_value',
    'brand_id',
    'brand_name',
    'fp_units',
    'fp_units_at_risk',
    'fp_value',
    'fp_value_at_risk',
    'novos_margin',
    'novos_units',
    'novos_value',
    'pecas_margin',
    'pecas_value',
    'resultado',
    'store_count',
    'usados_margin',
    'usados_units',
    'usados_value',
  ].join(',')
  assert.equal(
    columnsCsv('v_dia_owner_brief_by_brand'),
    expectedBrand,
    'contrato de colunas de by_brand divergiu do estado MTD',
  )

  // by_store: mesmo shape, trocando store_count por store_name.
  const expectedStore = [
    'at_margin',
    'at_value',
    'brand_id',
    'brand_name',
    'fp_units',
    'fp_units_at_risk',
    'fp_value',
    'fp_value_at_risk',
    'novos_margin',
    'novos_units',
    'novos_value',
    'pecas_margin',
    'pecas_value',
    'resultado',
    'store_name',
    'usados_margin',
    'usados_units',
    'usados_value',
  ].join(',')
  assert.equal(
    columnsCsv('v_dia_owner_brief_by_store'),
    expectedStore,
    'contrato de colunas de by_store divergiu do estado MTD',
  )

  // Ambas security_invoker=true.
  const si = scalar(
    `select bool_and((c.reloptions)::text[] @> array['security_invoker=true'])
       from pg_class c
      where c.relname in ('v_dia_owner_brief_by_brand','v_dia_owner_brief_by_store');`,
  )
  assert.equal(si, 't', `ambas as views deveriam ser security_invoker=true; obtido=${si}`)

  // Helper inalterado.
  const days = scalar('select public.dia_owner_brief_at_risk_days();')
  assert.equal(days, '83', `dia_owner_brief_at_risk_days() deveria retornar 83; obtido=${days}`)
})

// ---------------------------------------------------------------------------
// AC7 — Consistência by_store x by_brand para o dia anterior: para uma marca com
// vendas de ONTEM em DUAS lojas, SUM(by_store novos/usados/resultado) = by_brand.
// ---------------------------------------------------------------------------
test('AC7: by_store soma a by_brand para vendas de ONTEM (novos/usados/resultado)', () => {
  const sql = `${AS_ADMIN}
-- Loja A: 1 novo (80000) + 1 usado (60000) vendidos ONTEM.
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ91_CONS","model":"NA","store":"Loja A","cost":"50000","sale_price":"80000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ91_CONS","model":"UA","store":"Loja A","cost":"40000","sale_price":"60000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
-- Loja B: 1 novo (70000) vendido ONTEM.
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ91_CONS","model":"NB","store":"Loja B","cost":"50000","sale_price":"70000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'brand', novos_units, usados_units, resultado
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ91_CONS';
select 'stores', count(*), sum(novos_units), sum(usados_units), sum(resultado)
  from v_dia_owner_brief_by_store where brand_name = 'ZZ91_CONS';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = rows(out)
  const brand = get('brand')
  const stores = get('stores')
  assert.ok(brand, `linha de by_brand ausente; saida=${out}`)
  assert.ok(stores, `agregacao de by_store ausente; saida=${out}`)

  // by_brand: 2 novos, 1 usado, resultado = 80000+60000+70000 = 210000.
  assert.deepEqual(
    brand,
    ['brand', '2', '1', '210000.00'],
    'by_brand: novos_units=2, usados_units=1, resultado=210000 (vendas de ontem)',
  )
  // by_store: 2 lojas; somas batem com o total por marca.
  assert.equal(stores[1], '2', `by_store deveria ter 2 linhas (uma por loja); obtido=${stores[1]}`)
  assert.equal(stores[2], brand[1], `SUM(by_store.novos_units) deveria igualar by_brand; stores=${stores[2]} brand=${brand[1]}`)
  assert.equal(stores[3], brand[2], `SUM(by_store.usados_units) deveria igualar by_brand; stores=${stores[3]} brand=${brand[2]}`)
  assert.equal(stores[4], brand[3], `SUM(by_store.resultado) deveria igualar by_brand; stores=${stores[4]} brand=${brand[3]}`)
})
