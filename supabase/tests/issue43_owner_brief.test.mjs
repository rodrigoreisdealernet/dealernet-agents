// Teste de CONTRATO SQL — Morning Brief do Dono (issue #43), rodando contra o
// Postgres VIVO do Supabase.
//
// Ambiente OFFLINE: SEM Supabase CLI e SEM runner instalavel. Usamos apenas os
// modulos nativos do Node (node:test + node:assert) e chamamos o psql do
// container Docker via child_process.execFileSync. Cada cenario roda dentro de
// uma transacao BEGIN; ... ROLLBACK; para NAO poluir o banco compartilhado
// (idempotente, nunca reseta o DB) — mesmo padrao de vehicle_crud.test.mjs /
// dia_fast_bi_analytics.test.mjs.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/issue43_owner_brief.test.mjs
// Pre-requisito: container Postgres do Supabase no ar E a migration aplicada:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//   migration: supabase/migrations/20260626140000_dia_owner_brief_by_brand.sql
//
// O QUE ESTES CONTRATOS PROVAM (cada teste mapeia a um criterio de aceite da spec
// docs/specs/43-portal-morning-brief-do-dono.md):
//   * As views existem/sao selecionaveis e o helper at_risk_days() = 83.
//   * Agregacao do DIA ANTERIOR ("ontem" on-the-fly): venda em now()-1 entra,
//     venda em outro dia NAO entra.
//   * Agrupamento por marca + bucket "Sem marca" (brand em branco/ausente).
//   * Proxy FP em risco <7d: days_in_stock >= 83 conta como at-risk; < 83 conta
//     so no total fp_units/fp_value, nao no at-risk (boundary do proxy).
//   * Setores sem dado (Pecas/AT) -> NULL (UI renderiza "—").
//   * v_dia_owner_brief_by_store: linhas por (marca, loja) consistentes com os
//     totais por marca.
//
// SEED: usamos create_vehicle (RPC endurecida, mesmo caminho da UI) com JWT de
// admin para os cenarios com marca; para o bucket "Sem marca" (create_vehicle
// rejeita brand em branco com 22023) descemos para create_entity_with_version,
// a primitiva SCD2 que o create_vehicle envelopa. A data de venda "ontem" e'
// injetada via campo data->>'sold_at' (derivacao identica a v_dia_sales_summary).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const CONTAINER = 'supabase_db_dealernet-agents'

// JWT canonico: role de requisicao 'authenticated'; app_metadata.role = app_role
// lido por get_my_role() (admin habilita o writer guard do create_vehicle).
const ADMIN_CLAIMS = JSON.stringify({
  role: 'authenticated',
  sub: '00000000-0000-0000-0000-0000000000aa',
  app_metadata: { role: 'admin' },
})

// Executa SQL no Postgres vivo via psql. -t -A -F'|' (tuplas-only, unaligned,
// separador pipe) para parse simples; ON_ERROR_STOP=1 quebra em erro inesperado.
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

// Roda uma consulta escalar dentro de begin;...rollback; e retorna o valor.
function scalar(query) {
  const { ok, out, err } = psql(`begin;\n${query}\nrollback;`)
  assert.ok(ok, `psql falhou: ${err}`)
  return out
}

// Prefacio: abre txn, vira authenticated e injeta o JWT de admin (writer).
const AS_ADMIN = `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${ADMIN_CLAIMS}', true) \\g /dev/null
`

// Lista ordenada (CSV) das colunas de uma view, via information_schema.
function columnsCsv(viewName) {
  return scalar(
    `select string_agg(column_name, ',' order by column_name)
       from information_schema.columns
      where table_schema = 'public' and table_name = '${viewName}';`,
  )
}

// Parser de saida multi-linha (key|... por linha): get('key') -> array de campos.
function rows(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
}

// SQL para semear um veiculo via create_vehicle (com marca) dentro da txn corrente.
const yesterday = `(now()::date - 1)::text`

// ---------------------------------------------------------------------------
// AC backend: as views existem, sao selecionaveis, e o helper expoe o knob 83.
// ---------------------------------------------------------------------------
test('AC views: v_dia_owner_brief_by_brand e _by_store sao selecionaveis; helper at_risk_days()=83', () => {
  // Selecionavel sem erro (count >= 0).
  const brandCount = scalar('select count(*) >= 0 from v_dia_owner_brief_by_brand;')
  assert.equal(brandCount, 't', 'v_dia_owner_brief_by_brand deveria ser selecionavel')
  const storeCount = scalar('select count(*) >= 0 from v_dia_owner_brief_by_store;')
  assert.equal(storeCount, 't', 'v_dia_owner_brief_by_store deveria ser selecionavel')

  // O knob documentado do proxy <7d (90 - 7 = 83).
  const days = scalar('select public.dia_owner_brief_at_risk_days();')
  assert.equal(days, '83', `dia_owner_brief_at_risk_days() deveria retornar 83; obtido=${days}`)
})

// ---------------------------------------------------------------------------
// AC backend (contrato de colunas): as views expoem o shape exato que a tela
// (agentsApi OwnerBriefBrandRow/StoreRow) vincula. Falharia se uma coluna fosse
// removida/renomeada na migration.
// ---------------------------------------------------------------------------
test('AC contrato: v_dia_owner_brief_by_brand expoe as colunas dos 5 setores + FP + resultado', () => {
  const expected = [
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
  assert.equal(columnsCsv('v_dia_owner_brief_by_brand'), expected, 'contrato de colunas de by_brand divergiu')
})

test('AC contrato: v_dia_owner_brief_by_store adiciona store_name ao shape por marca', () => {
  const cols = columnsCsv('v_dia_owner_brief_by_store')
  for (const c of ['brand_name', 'store_name', 'novos_units', 'novos_value', 'fp_units_at_risk', 'resultado']) {
    assert.ok(cols.split(',').includes(c), `by_store deveria ter a coluna ${c}; colunas=${cols}`)
  }
})

// ---------------------------------------------------------------------------
// AC "dados do dia anterior" (ontem on-the-fly): um veiculo NOVO vendido em
// now()-1 para uma marca conhecida aparece com novos_units=1 e resultado
// refletindo a venda. Prova a logica "ontem".
// ---------------------------------------------------------------------------
test('AC ontem: venda NOVA de ontem reflete novos_units e resultado na marca', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ_BRIEF_ONTEM","model":"M1","store":"Loja A","cost":"100000","sale_price":"150000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'r', novos_units, novos_value, resultado
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ_BRIEF_ONTEM';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = rows(out)
  assert.deepEqual(
    get('r'),
    ['r', '1', '150000.00', '150000.00'],
    'a marca deveria ter novos_units=1, novos_value=150000 e resultado=150000 (venda de ontem)',
  )
})

// ---------------------------------------------------------------------------
// AC ontem (exclusao): uma venda em OUTRO dia (now()-5) NAO conta para a brief —
// a marca nao aparece. Prova que o filtro de "ontem" e estrito.
// ---------------------------------------------------------------------------
test('AC ontem: venda em outro dia (now()-5) NAO conta na brief', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ_BRIEF_OUTRODIA","model":"M1","store":"Loja A","cost":"100000","sale_price":"150000","status":"vendido","sold_at":"' || (now()::date - 5)::text || '"}')::jsonb) \\g /dev/null
select 'c', count(*) from v_dia_owner_brief_by_brand where brand_name = 'ZZ_BRIEF_OUTRODIA';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = rows(out)
  assert.deepEqual(
    get('c'),
    ['c', '0'],
    'uma venda em dia diferente de ontem NAO deveria gerar linha de marca na brief',
  )
})

// ---------------------------------------------------------------------------
// AC "Sem marca": um veiculo sem brand (branco/ausente) cai no bucket
// "Sem marca" — e nenhuma linha tem brand_name NULL. create_vehicle rejeita
// brand em branco (22023), entao descemos para create_entity_with_version.
// ---------------------------------------------------------------------------
test('AC sem-marca: veiculo sem brand cai no bucket "Sem marca" (nunca brand_name NULL)', () => {
  const sql = `${AS_ADMIN}
select create_entity_with_version(
  'vehicle'::text,
  ('{"condition":"novo","model":"SemMarca","status":"vendido","sale_price":"99000","cost":"50000","sold_at":"' || ${yesterday} || '"}')::jsonb,
  null::text) \\g /dev/null
select 'sm', novos_units from v_dia_owner_brief_by_brand where brand_name = 'Sem marca';
select 'nulls', count(*) from v_dia_owner_brief_by_brand where brand_name is null;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = rows(out)
  // O bucket "Sem marca" existe e contabiliza a venda sem marca de ontem.
  const sm = get('sm')
  assert.ok(sm && Number(sm[1]) >= 1, `bucket "Sem marca" deveria contar a venda sem marca; obtido=${sm}`)
  // E nenhuma linha vaza brand_name NULL (a UI sempre tem um rotulo de marca).
  assert.deepEqual(get('nulls'), ['nulls', '0'], 'nenhuma linha de by_brand deveria ter brand_name NULL')
})

// ---------------------------------------------------------------------------
// AC FP em risco <7d (proxy): um veiculo em estoque com days_in_stock >= 83
// (purchase_date = now()-90) conta como at-risk (fp_units_at_risk>=1,
// fp_value_at_risk>0); um com days_in_stock < 83 (now()-10) conta apenas no
// total (fp_units/fp_value) mas NAO no at-risk. Prova o boundary do proxy.
// ---------------------------------------------------------------------------
test('AC fp-risco: days_in_stock>=83 conta como at-risk; <83 conta so no total', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ_BRIEF_FP","model":"Velho","store":"L1","cost":"80000","status":"em_estoque","purchase_date":"' || (now()::date - 90)::text || '"}')::jsonb) \\g /dev/null
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ_BRIEF_FP","model":"Novo","store":"L1","cost":"80000","status":"em_estoque","purchase_date":"' || (now()::date - 10)::text || '"}')::jsonb) \\g /dev/null
select 'fp', fp_units, fp_units_at_risk, (fp_value_at_risk > 0), (fp_value > 0)
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ_BRIEF_FP';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = rows(out)
  assert.deepEqual(
    get('fp'),
    ['fp', '2', '1', 't', 't'],
    'dois em estoque -> fp_units=2; so o de 90d e at-risk -> fp_units_at_risk=1, fp_value_at_risk>0, fp_value>0',
  )
})

// ---------------------------------------------------------------------------
// AC fp-risco (boundary exato): days_in_stock == 83 (purchase_date = now()-83)
// JA e' at-risk (>= 83), e days_in_stock == 82 (now()-82) ainda NAO e'. Fixa o
// limite inclusivo do proxy exatamente em 83.
// ---------------------------------------------------------------------------
test('AC fp-risco (boundary): days_in_stock=83 e at-risk; =82 nao e', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ_BRIEF_B83","model":"X","store":"L1","cost":"80000","status":"em_estoque","purchase_date":"' || (now()::date - 83)::text || '"}')::jsonb) \\g /dev/null
select 'at83', fp_units, fp_units_at_risk from v_dia_owner_brief_by_brand where brand_name = 'ZZ_BRIEF_B83';
rollback;
`
  const r83 = psql(sql)
  assert.ok(r83.ok, `psql falhou: ${r83.err}`)
  assert.deepEqual(rows(r83.out)('at83'), ['at83', '1', '1'], 'days_in_stock=83 deveria ser at-risk (>=83)')

  const sql82 = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"usado","brand":"ZZ_BRIEF_B82","model":"X","store":"L1","cost":"80000","status":"em_estoque","purchase_date":"' || (now()::date - 82)::text || '"}')::jsonb) \\g /dev/null
select 'at82', fp_units, fp_units_at_risk from v_dia_owner_brief_by_brand where brand_name = 'ZZ_BRIEF_B82';
rollback;
`
  const r82 = psql(sql82)
  assert.ok(r82.ok, `psql falhou: ${r82.err}`)
  assert.deepEqual(rows(r82.out)('at82'), ['at82', '1', '0'], 'days_in_stock=82 NAO deveria ser at-risk (<83)')
})

// ---------------------------------------------------------------------------
// AC "setores sem dado -> NULL" (UI renderiza "—"): com o seed atual nao ha
// 'parts_sale'/'service_order' do dia anterior, entao pecas_value/pecas_margin e
// at_value/at_margin saem NULL em toda linha de by_brand. Tambem em by_store
// (sem atribuicao por loja).
// ---------------------------------------------------------------------------
test('AC setores vazios: pecas/at sao NULL em by_brand (renderizam "—")', () => {
  // by_brand: garantimos ao menos uma linha (seed de uma venda de ontem) e
  // asseguramos que os setores sem seed continuam NULL nessa linha.
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ_BRIEF_NULLSEC","model":"M","store":"L1","cost":"10000","sale_price":"20000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'sec', (pecas_value is null), (pecas_margin is null), (at_value is null), (at_margin is null)
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ_BRIEF_NULLSEC';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    rows(out)('sec'),
    ['sec', 't', 't', 't', 't'],
    'pecas_value/pecas_margin/at_value/at_margin deveriam ser NULL sem seed de pecas/oficina',
  )
})

test('AC setores vazios: pecas/at sao NULL em by_store (sem atribuicao por loja)', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ_BRIEF_STORENULL","model":"M","store":"L1","cost":"10000","sale_price":"20000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'sec', (pecas_value is null), (pecas_margin is null), (at_value is null), (at_margin is null)
  from v_dia_owner_brief_by_store where brand_name = 'ZZ_BRIEF_STORENULL';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    rows(out)('sec'),
    ['sec', 't', 't', 't', 't'],
    'pecas/at deveriam ser NULL em by_store (sem atribuicao por loja)',
  )
})

// ---------------------------------------------------------------------------
// AC drill por loja: v_dia_owner_brief_by_store retorna uma linha por (marca,
// loja) e os totais por loja somam ao total por marca (store_count, novos_units,
// novos_value). Prova a consistencia do drill marca -> lojas.
// ---------------------------------------------------------------------------
test('AC drill: by_store (uma linha por loja) soma aos totais de by_brand', () => {
  const sql = `${AS_ADMIN}
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ_BRIEF_DRILL","model":"A","store":"L1","cost":"50000","sale_price":"80000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select create_vehicle(
  ('{"condition":"novo","brand":"ZZ_BRIEF_DRILL","model":"B","store":"L2","cost":"50000","sale_price":"70000","status":"vendido","sold_at":"' || ${yesterday} || '"}')::jsonb) \\g /dev/null
select 'brand', store_count, novos_units, novos_value
  from v_dia_owner_brief_by_brand where brand_name = 'ZZ_BRIEF_DRILL';
select 'stores', count(*), sum(novos_units), sum(novos_value)
  from v_dia_owner_brief_by_store where brand_name = 'ZZ_BRIEF_DRILL';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const get = rows(out)
  // 2 lojas: store_count=2 no by_brand; 2 linhas no by_store; somas batem.
  assert.deepEqual(
    get('brand'),
    ['brand', '2', '2', '150000.00'],
    'by_brand: store_count=2, novos_units=2, novos_value=150000',
  )
  assert.deepEqual(
    get('stores'),
    ['stores', '2', '2', '150000.00'],
    'by_store: 2 linhas (uma por loja) cujas somas batem com o total por marca',
  )
})

// ---------------------------------------------------------------------------
// AC security_invoker: ambas as views sao security_invoker=true (a RLS do
// chamador se aplica), mesmo padrao das demais v_dia_*.
// ---------------------------------------------------------------------------
test('AC rls: as duas views da brief sao security_invoker=true', () => {
  const out = scalar(
    `select bool_and((c.reloptions)::text[] @> array['security_invoker=true'])
       from pg_class c
      where c.relname in ('v_dia_owner_brief_by_brand','v_dia_owner_brief_by_store');`,
  )
  assert.equal(out, 't', `ambas as views da brief deveriam ser security_invoker=true; obtido=${out}`)
})
