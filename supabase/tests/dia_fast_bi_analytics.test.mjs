// Teste de CONTRATO SQL — Fast BI analytic layer (issue #14), rodando contra o
// Postgres VIVO do Supabase.
//
// Ambiente OFFLINE: SEM Supabase CLI e SEM runner instalavel. Usamos apenas os
// modulos nativos do Node (node:test + node:assert) e chamamos o psql do
// container Docker via child_process.execFileSync. As consultas sao read-only,
// mas cada cenario roda dentro de uma transacao BEGIN; ... ROLLBACK; para manter
// o mesmo padrao do harness de vehicle_crud (idempotente, nunca polui o banco).
//
// COMO RODAR:
//   node --test supabase/tests/dia_fast_bi_analytics.test.mjs
// Pre-requisito: container Postgres do Supabase no ar E a migration aplicada:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//   migration: supabase/migrations/20260625150000_dia_fast_bi_analytics.sql
//
// ESTRATEGIA DE ASSERCAO:
//   As views foram escritas contra dados de seed REAIS de veiculos (12 veiculos,
//   condition novo/usado, alguns vendidos, alguns em_estoque). Estes contratos
//   afirmam ESTRUTURA e INVARIANTES (colunas, dominios, nao-negatividade,
//   security_invoker) que se mantem independentemente das contagens exatas do
//   seed — assim os testes seguem verdes a medida que os seeds evoluem.
//
//   As views de service/oficina (#7) e parts (#8/#10) leem entity_types que
//   AINDA NAO existem no catalogo/seed deste branch. Por isso v_dia_service_summary
//   e v_dia_parts_summary retornam ZERO linhas hoje (sem erro) — os contratos
//   abaixo verificam que a consulta executa sem erro e usam coalesce(...,true)
//   sobre bool_and para tolerar conjuntos de 0 linhas. Eles passam a popular
//   automaticamente quando #7/#8/#10 semearem esses tipos.
//
// Cada teste traz no nome o criterio de aceite (camada analitica do Fast BI)
// que verifica.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const CONTAINER = 'supabase_db_dealernet-agents'

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
    '-q', // quiet: suprime tags de comando (BEGIN/SET/ROLLBACK)
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

// Roda uma unica consulta escalar dentro de begin;...rollback; e retorna o
// valor (string trim). Mantem o envelope transacional consistente com o harness.
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

// ---------------------------------------------------------------------------
// AC1: v_dia_owner_kpis e' um snapshot de EXATAMENTE UMA linha, sem nenhuma
// coluna nula (todas as KPIs coalesced; as_of = now()).
// ---------------------------------------------------------------------------
test('AC1 owner_kpis: exatamente 1 linha e nenhuma coluna nula', () => {
  const count = scalar('select count(*) from v_dia_owner_kpis;')
  assert.equal(count, '1', `v_dia_owner_kpis deveria ter exatamente 1 linha; obtido=${count}`)

  // bool_and sobre TODAS as colunas (incluindo as_of) via jsonb_each: 't' se
  // nenhum valor for nulo. Cobre as 12 colunas sem precisar lista-las aqui.
  const noNulls = scalar(
    `select bool_and(value is not null)
       from v_dia_owner_kpis k, lateral jsonb_each(to_jsonb(k)) as e(key, value);`,
  )
  assert.equal(noNulls, 't', `nenhuma coluna de v_dia_owner_kpis deveria ser nula; obtido=${noNulls}`)
})

// ---------------------------------------------------------------------------
// AC2: KPIs numericas de contagem/valor sao nao-negativas (margin pode ser
// negativa em teoria, entao e' deliberadamente excluida).
// ---------------------------------------------------------------------------
test('AC2 owner_kpis: KPIs numericas (exceto margin) sao >= 0', () => {
  const out = scalar(
    `select
        sales_units_month >= 0
        and sales_revenue_month >= 0
        and inventory_vehicle_value >= 0
        and floor_plan_total >= 0
        and avg_days_in_stock >= 0
        and service_orders_open >= 0
        and parts_inventory_value >= 0
        and parts_critical_count >= 0
      from v_dia_owner_kpis;`,
  )
  assert.equal(out, 't', `todas as KPIs nao-margin de v_dia_owner_kpis deveriam ser >= 0; obtido=${out}`)
})

// ---------------------------------------------------------------------------
// AC3: contrato de colunas de v_dia_owner_kpis — conjunto exato (e estavel) de
// nomes que os dashboards (#15-#18) vinculam.
// ---------------------------------------------------------------------------
test('AC3 owner_kpis: contrato de colunas e exatamente o esperado', () => {
  const expected = [
    'as_of',
    'avg_days_in_stock',
    'floor_plan_total',
    'inventory_vehicle_value',
    'margin_month',
    'parts_critical_count',
    'parts_inventory_value',
    'sales_revenue_month',
    'sales_units_month',
    'service_avg_turnaround',
    'service_orders_open',
    'service_revenue_month',
  ].join(',')
  assert.equal(columnsCsv('v_dia_owner_kpis'), expected, 'contrato de colunas de v_dia_owner_kpis divergiu')
})

// ---------------------------------------------------------------------------
// AC4: v_dia_sales_summary — contrato de colunas + invariante "somente veiculos
// vendidos": cada linha tem units_sold >= 1 e condition em (novo, usado).
// ---------------------------------------------------------------------------
test('AC4 sales_summary: contrato de colunas + apenas veiculos vendidos (units>=1, condition valido)', () => {
  const expected = [
    'avg_days_to_sell',
    'brand',
    'condition',
    'margin',
    'period_month',
    'revenue',
    'store',
    'units_sold',
  ].join(',')
  assert.equal(columnsCsv('v_dia_sales_summary'), expected, 'contrato de colunas de v_dia_sales_summary divergiu')

  // coalesce(...,true): bool_and sobre 0 linhas retorna null; sem vendas o
  // invariante e' vacuamente verdadeiro.
  const inv = scalar(
    `select coalesce(bool_and(units_sold >= 1 and condition in ('novo','usado')), true)
       from v_dia_sales_summary;`,
  )
  assert.equal(inv, 't', `toda linha de v_dia_sales_summary deveria ter units_sold>=1 e condition valido; obtido=${inv}`)
})

// ---------------------------------------------------------------------------
// AC5: v_dia_sales_trend — contrato de colunas + janela movel de 90 dias
// (sale_date dentro de [hoje-90, hoje], units_sold >= 1).
// ---------------------------------------------------------------------------
test('AC5 sales_trend: contrato de colunas + janela de 90 dias e units>=1', () => {
  const expected = ['revenue', 'sale_date', 'units_sold'].join(',')
  assert.equal(columnsCsv('v_dia_sales_trend'), expected, 'contrato de colunas de v_dia_sales_trend divergiu')

  const inv = scalar(
    `select coalesce(bool_and(
              sale_date >= (now()::date - 90)
              and sale_date <= now()::date
              and units_sold >= 1), true)
       from v_dia_sales_trend;`,
  )
  assert.equal(inv, 't', `v_dia_sales_trend deveria respeitar a janela de 90 dias e units_sold>=1; obtido=${inv}`)
})

// ---------------------------------------------------------------------------
// AC6: v_dia_inventory_summary — contrato de colunas + dominio de age_band
// (0-30, 31-60, 61-90, 90+) e vehicles_count >= 1.
// ---------------------------------------------------------------------------
test('AC6 inventory_summary: contrato de colunas + dominio de age_band e count>=1', () => {
  const expected = [
    'age_band',
    'brand',
    'floor_plan_cost',
    'inventory_value',
    'store',
    'vehicles_count',
  ].join(',')
  assert.equal(columnsCsv('v_dia_inventory_summary'), expected, 'contrato de colunas de v_dia_inventory_summary divergiu')

  const inv = scalar(
    `select coalesce(bool_and(
              age_band in ('0-30','31-60','61-90','90+')
              and vehicles_count >= 1), true)
       from v_dia_inventory_summary;`,
  )
  assert.equal(inv, 't', `v_dia_inventory_summary deveria ter age_band no dominio e vehicles_count>=1; obtido=${inv}`)
})

// ---------------------------------------------------------------------------
// AC7: v_dia_service_summary — contrato de colunas + degrada graciosamente
// (0 linhas hoje, entity_type 'service_order' ainda nao semeado em #7). A
// consulta deve EXECUTAR SEM ERRO.
// ---------------------------------------------------------------------------
test('AC7 service_summary: contrato de colunas + select executa sem erro (0 linhas hoje)', () => {
  const expected = ['avg_turnaround', 'orders_count', 'period_month', 'revenue', 'status'].join(',')
  assert.equal(columnsCsv('v_dia_service_summary'), expected, 'contrato de colunas de v_dia_service_summary divergiu')

  // O select tem que rodar limpo mesmo sem o entity_type 'service_order'.
  const { ok, out, err } = psql(`begin;\nselect count(*) from v_dia_service_summary;\nrollback;`)
  assert.ok(ok, `select em v_dia_service_summary falhou: ${err}`)
  assert.ok(Number(out) >= 0, `count(*) de v_dia_service_summary deveria ser >= 0; obtido=${out}`)
})

// ---------------------------------------------------------------------------
// AC8: v_dia_parts_summary — contrato de colunas + degrada graciosamente
// (0 linhas hoje, entity_types 'part'/'parts_sale' ainda nao semeados em #8/#10).
// A consulta (UNION ALL inventory+sales) deve EXECUTAR SEM ERRO.
// ---------------------------------------------------------------------------
test('AC8 parts_summary: contrato de colunas + select executa sem erro (0 linhas hoje)', () => {
  const expected = ['inventory_value', 'period_month', 'revenue', 'stock_status', 'units_sold'].join(',')
  assert.equal(columnsCsv('v_dia_parts_summary'), expected, 'contrato de colunas de v_dia_parts_summary divergiu')

  const { ok, out, err } = psql(`begin;\nselect count(*) from v_dia_parts_summary;\nrollback;`)
  assert.ok(ok, `select em v_dia_parts_summary falhou: ${err}`)
  assert.ok(Number(out) >= 0, `count(*) de v_dia_parts_summary deveria ser >= 0; obtido=${out}`)
})

// ---------------------------------------------------------------------------
// AC9: as 6 fact_types da camada analitica foram inseridas idempotentemente.
// ---------------------------------------------------------------------------
test('AC9 fact_types: as 6 chaves do Fast BI estao presentes', () => {
  const count = scalar(
    `select count(*) from fact_types
      where key in (
        'vn_units_sold','vn_revenue','vu_units_sold','vu_revenue',
        'service_revenue','parts_sales_revenue');`,
  )
  assert.equal(count, '6', `deveriam existir 6 fact_types do Fast BI; obtido=${count}`)
})

// ---------------------------------------------------------------------------
// AC10: TODAS as 6 views da camada sao security_invoker = true (a RLS do
// chamador se aplica). reloptions e' text[]; checamos via @> array[...].
// ---------------------------------------------------------------------------
test('AC10 security_invoker: todas as 6 views sao security_invoker=true', () => {
  const out = scalar(
    `select bool_and((c.reloptions)::text[] @> array['security_invoker=true'])
       from pg_class c
      where c.relname in (
        'v_dia_owner_kpis','v_dia_sales_summary','v_dia_sales_trend',
        'v_dia_service_summary','v_dia_inventory_summary','v_dia_parts_summary');`,
  )
  assert.equal(out, 't', `todas as 6 views deveriam ser security_invoker=true; obtido=${out}`)
})
