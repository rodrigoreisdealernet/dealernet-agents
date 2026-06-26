// Teste de CONTRATO SQL — issue #85 (seed semeia transações DATADAS DE ONTEM
// para o Morning Brief do Dono), rodando contra o Postgres VIVO do Supabase.
//
// O QUE A MUDANÇA DA #85 FAZ (DATA-ONLY em supabase/seed.sql):
//   * Bloco curado 'demo-dia-sold-yesterday-%': 10 veículos status='vendido' com
//     sold_at = now()::date - 1 (NOVO e USADO em 4 marcas / várias lojas).
//   * 3 OS 'concluida' abertas ontem (demo-dia-service-019/020/021) com revenue.
//   * 2 vendas de peça com sale_date = now()::date - 1 (demo-dia-part-sale-021/022).
//   Todas as datas RELATIVAS (now()::date - 1). O objetivo é fazer Novos/Usados/
//   Peças/AT do Morning Brief popularem (antes vinham R$ 0 / "—").
//
// PADRÃO: idêntico a issue43_owner_brief.test.mjs / issue53_owner_brief_store_cols.
//   * Ambiente OFFLINE: só node:test + node:assert; psql do container Docker via
//     execFileSync. Cada cenário roda em BEGIN; ... ROLLBACK; — NUNCA reseta nem
//     polui o banco compartilhado e NÃO depende do seed global já ter rodado:
//     o teste INSERE as próprias linhas (create_vehicle/create_part_sale/
//     create_service_order — o mesmo caminho da UI e do seed), com JWT de admin.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/issue85_brief_yesterday.test.mjs
// Pré-requisito: container Postgres do Supabase no ar E migrations aplicadas:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//   migrations: 20260626140000_dia_owner_brief_by_brand.sql
//               20260627120000_dia_owner_brief_month_to_date.sql  (DEFINIÇÃO VIVA)
//
// NOTA IMPORTANTE SOBRE A JANELA DA VIEW (mismatch spec vs. implementação):
//   A spec #85 foi escrita assumindo a view DIA-ANTERIOR (now()::date - 1). Mas a
//   migration mais recente (20260627120000_dia_owner_brief_month_to_date.sql) trocou
//   o conceito para MÊS ATUAL (month-to-date) — esta é a definição VIVA da view. Sob
//   MÊS ATUAL, "ontem" cai SEMPRE dentro da janela (exceto no 1º dia do mês), então a
//   mudança de seed atinge o objetivo da spec (brief populado). Por isso a fronteira
//   é provada com uma venda no MÊS ANTERIOR (sempre fora da janela), e não com
//   "now()::date - 5" (que, sob MÊS ATUAL, AINDA contaria). Ver relatório do tester.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const CONTAINER = 'supabase_db_dealernet-agents'

const __dirname = dirname(fileURLToPath(import.meta.url))
// supabase/tests/ -> supabase/ -> raiz do repo -> supabase/seed.sql
const SEED_PATH = resolve(__dirname, '../seed.sql')

// JWT canônico: role de requisição 'authenticated'; app_metadata.role = admin
// (habilita o writer guard das RPCs), igual a issue43_owner_brief.test.mjs.
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

// Prefácio: abre txn, vira authenticated e injeta o JWT de admin (writer).
const AS_ADMIN = `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${ADMIN_CLAIMS}', true) \\g /dev/null
`

// Datas-âncora RELATIVAS (robustas a qualquer dia):
//   yesterday = now()::date - 1 — o que o seed da #85 grava (sempre na janela
//               do mês, exceto no dia 1; ver nota no topo).
//   prevMonthLastDay = último dia do mês anterior — SEMPRE fora da janela
//               (prova a fronteira do período independentemente de prev-day vs MTD).
const yesterday = `(now()::date - 1)::text`
const prevMonthLastDay = `((date_trunc('month', now()) - interval '1 day')::date)::text`

// Parser de saída multi-linha (key|... por linha): get('key') -> array de campos.
function rows(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
}

// ---------------------------------------------------------------------------
// AC1 — Novos e Usados de ONTEM com resultado > 0 (o coração da #85).
// Um NOVO e um USADO vendidos ONTEM para uma marca conhecida aparecem na brief
// com novos_units>=1, usados_units>=1 e resultado>0. Falha se o seed/voltar a
// não datar as vendas (sold_at ausente → fallback p/ hoje → fora da janela).
// ---------------------------------------------------------------------------
test('AC1: vendas NOVO+USADO de ONTEM populam novos_units/usados_units e resultado>0', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ85_BRIEF","model":"N1","store":"Loja A","cost":"100000","sale_price":"150000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ85_BRIEF","model":"U1","store":"Loja A","cost":"80000","sale_price":"100000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'r', novos_units, usados_units, (resultado > 0)
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ85_BRIEF';
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
// AC1 (valores) — novos_value e usados_value refletem os preços de venda
// (prova que os números somam, não só a contagem). resultado >= soma das vendas.
// ---------------------------------------------------------------------------
test('AC1: novos_value/usados_value somam os preços de venda de ontem; resultado >= a soma', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ85_VAL","model":"N1","store":"L1","cost":"100000","sale_price":"150000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ85_VAL","model":"U1","store":"L1","cost":"80000","sale_price":"100000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'v', novos_value, usados_value, (resultado >= 250000)
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ85_VAL';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    rows(out)('v')?.slice(0, 3),
    ['v', '150000.00', '100000.00'],
    'novos_value=150000 e usados_value=100000 (soma exata dos preços de venda de ontem)',
  )
  assert.equal(rows(out)('v')?.[3], 't', 'resultado deveria ser >= 250000 (Novos+Usados de ontem)')
})

// ---------------------------------------------------------------------------
// FRONTEIRA do período — uma venda no MÊS ANTERIOR (último dia) NÃO contribui.
// Prova que a janela é estrita: dados antigos não vazam para a brief. (Substitui
// o "now()::date - 5" da spec, que sob a view VIVA month-to-date AINDA contaria —
// ver nota no topo / relatório.)
// ---------------------------------------------------------------------------
test('fronteira: venda no mês ANTERIOR (último dia) NÃO conta na brief', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ85_OLD","model":"N1","store":"L1","cost":"100000","sale_price":"150000","status":"vendido","sold_at":"' || ${prevMonthLastDay} || '"}')::jsonb) \\g /dev/null
select 'c', count(*) from v_dia_owner_brief_by_brand where brand_name = 'ZZ85_OLD';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    rows(out)('c'),
    ['c', '0'],
    'uma venda no mês anterior NÃO deveria gerar linha de marca na brief (fronteira do período)',
  )
})

// ---------------------------------------------------------------------------
// AC2 — Drill por loja consistente: vendas de ontem em DUAS lojas da mesma marca
// aparecem em v_dia_owner_brief_by_store (uma linha por loja) e suas somas
// (novos_units/novos_value) batem com o total por marca em by_brand.
// ---------------------------------------------------------------------------
test('AC2: drill por loja — SUM(by_store) bate com by_brand para as vendas de ontem', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ85_DRILL","model":"A","store":"Loja A","cost":"50000","sale_price":"80000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ85_DRILL","model":"B","store":"Loja B","cost":"50000","sale_price":"70000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'brand', store_count, novos_units, novos_value
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ85_DRILL';
select 'stores', count(*), sum(novos_units), sum(novos_value)
  from v_dia_owner_brief_by_store where brand_name = 'ZZ85_DRILL';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = rows(out)
  assert.deepEqual(
    get('brand'),
    ['brand', '2', '2', '150000.00'],
    'by_brand: store_count=2, novos_units=2, novos_value=150000 (duas lojas, vendas de ontem)',
  )
  assert.deepEqual(
    get('stores'),
    ['stores', '2', '2', '150000.00'],
    'by_store: 2 linhas (uma por loja) cujas somas de novos batem com o total por marca',
  )
})

// ---------------------------------------------------------------------------
// AC3 — Peças populam: uma venda de peça com sale_date = ONTEM faz pecas_value
// sair NON-NULL e > 0 em by_brand. Espelha o que o seed faz (flag 'yesterday'
// em demo-dia-part-sale-021/022 ancora sale_date em now()::date - 1).
// ---------------------------------------------------------------------------
test('AC3: peça vendida ONTEM popula pecas_value (NON-NULL, > 0) em by_brand', () => {
  const sql = `${AS_ADMIN}
select create_part(
  '{"part_number":"ZZ85-P1","description":"Peca 85","quantity_in_stock":"100","unit_cost":"10","unit_price":"100","status":"ativo","source_record_id":"zz85-brief-part-1"}'::jsonb) \\g /dev/null
select create_part_sale(jsonb_build_object(
  'part_id', (select id from entities where entity_type = 'part' and source_record_id = 'zz85-brief-part-1')::text,
  'quantity', 3, 'unit_price', 100, 'discount', 0, 'sale_date', ${yesterday})) \\g /dev/null
select 'p', (pecas_value is not null), (pecas_value > 0)
  from v_dia_owner_brief_by_brand limit 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    rows(out)('p'),
    ['p', 't', 't'],
    'pecas_value deveria ser NON-NULL e > 0 com venda de peça datada de ONTEM',
  )
})

// ---------------------------------------------------------------------------
// AC3 — AT/Oficina popula: uma OS 'concluida' aberta ONTEM com revenue faz
// at_value sair NON-NULL e > 0 em by_brand. Espelha demo-dia-service-019/020/021
// (concluida, open_days=1 → opened_at = now()::date - 1, revenue presente).
// ---------------------------------------------------------------------------
test('AC3: OS concluída aberta ONTEM com revenue popula at_value (NON-NULL, > 0) em by_brand', () => {
  const sql = `${AS_ADMIN}
select create_service_order(
  ('{"customer":"Cliente ZZ85","description":"OS 85","status":"concluida","revenue":"1340","opened_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'a', (at_value is not null), (at_value > 0)
  from v_dia_owner_brief_by_brand limit 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    rows(out)('a'),
    ['a', 't', 't'],
    'at_value deveria ser NON-NULL e > 0 com OS aberta ONTEM e revenue',
  )
})

// ---------------------------------------------------------------------------
// AC4 — Floor Plan não regride: as inserções de vendas (status='vendido') da #85
// NÃO entram no Floor Plan; um veículo EM ESTOQUE aging (days_in_stock>=83) ainda
// popula fp_units/fp_value e conta como at-risk. Prova que o seed de vendas de
// ontem não rouba unidades do estoque nem quebra as colunas FP.
// ---------------------------------------------------------------------------
test('AC4: Floor Plan continua populando — venda de ontem não entra no FP; estoque aging conta', () => {
  const sql = `${AS_ADMIN}
-- Venda de ontem (NÃO deve entrar no FP, que é status='em_estoque').
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ85_FP","model":"Vendido","store":"L1","cost":"50000","sale_price":"80000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
-- Estoque aging at-risk (days_in_stock=90 >= 83).
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ85_FP","model":"Velho","store":"L1","cost":"40000","status":"em_estoque","purchase_date":"' || (now()::date - 90)::text || '"}')::jsonb) \\g /dev/null
select 'fp', fp_units, fp_units_at_risk, (fp_value > 0), (fp_value_at_risk > 0)
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ85_FP';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    rows(out)('fp'),
    ['fp', '1', '1', 't', 't'],
    'FP deveria contar SÓ o veículo em estoque (fp_units=1, at-risk=1), não a venda de ontem',
  )
})

// ---------------------------------------------------------------------------
// SEED GUARD (hermético, dependency-free) — lê supabase/seed.sql e garante que a
// datação RELATIVA de ONTEM da #85 não regrediu. Cada assert FALHA se a mudança
// for revertida (sem sold_at; sem o namespace; ou data hard-coded). Estilo de
// verify-issue43-wiring.mjs (assertiva sobre o CONTEÚDO da fonte).
// ---------------------------------------------------------------------------
const SEED = readFileSync(SEED_PATH, 'utf8')

test('seed guard: namespace "demo-dia-sold-yesterday" existe (bloco de vendas de ontem)', () => {
  assert.match(
    SEED,
    /demo-dia-sold-yesterday-001/,
    'seed.sql deveria conter o bloco curado demo-dia-sold-yesterday-* (vendas de ontem)',
  )
})

test('seed guard: veículos vendidos recebem sold_at relativo a now()::date - 1', () => {
  // sold_at deve ser populado e derivar de now()::date - 1 (não hard-coded).
  assert.match(
    SEED,
    /now\(\)::date\s*-\s*1/,
    'seed.sql deveria datar as vendas com now()::date - 1 (relativo)',
  )
  // E o campo sold_at precisa estar de fato gravado no jsonb do veículo (a causa
  // raiz da #85 era a AUSÊNCIA de sold_at → fallback p/ hoje → brief vazia).
  assert.match(
    SEED,
    /'sold_at',\s*v_yesterday/,
    "seed.sql deveria gravar 'sold_at' = v_yesterday no jsonb do veículo vendido",
  )
  // v_yesterday é derivado de now()::date - 1 (relativo, sem manutenção manual).
  assert.match(
    SEED,
    /v_yesterday\s+text\s*:=\s*to_char\(\s*now\(\)::date\s*-\s*1/,
    'v_yesterday deveria ser to_char(now()::date - 1, ...) — data RELATIVA',
  )
})

test('seed guard: peças e OS de ontem usam datas RELATIVAS (sale_date / opened_at via now()::date - 1)', () => {
  // Vendas de peça de ontem: a flag 'yesterday' ancora sale_date em now()::date - 1.
  assert.match(SEED, /demo-dia-part-sale-021/, 'seed deveria ter a venda de peça de ontem demo-dia-part-sale-021')
  assert.match(
    SEED,
    /v_sale_date\s*:=\s*to_char\(\s*now\(\)::date\s*-\s*1/,
    'a venda de peça de ontem deveria ancorar v_sale_date em now()::date - 1 (relativo)',
  )
  // OS concluídas de ontem (abertas há 1 dia → opened_at = ontem).
  assert.match(SEED, /demo-dia-service-019/, 'seed deveria ter a OS concluída de ontem demo-dia-service-019')
})

test('seed guard: as linhas de ONTEM da #85 NÃO usam data ISO hard-coded (sem literal 2026-)', () => {
  // Isola o bloco de veículos vendidos de ontem e garante que não há literal de
  // DATA ISO '2026-..' embutido (datas têm de ser relativas). order_number como
  // 'OS-2026-019' não é data e vive em outro bloco — por isso o recorte.
  const start = SEED.indexOf("demo-dia-sold-yesterday-001")
  assert.ok(start !== -1, 'bloco de vendas de ontem não encontrado')
  const end = SEED.indexOf('$$;', start)
  const block = SEED.slice(start, end === -1 ? undefined : end)
  assert.doesNotMatch(
    block,
    /['"]2026-\d{2}-\d{2}/,
    'o bloco de vendas de ONTEM não deveria conter datas ISO hard-coded (use now()::date - 1)',
  )
})
