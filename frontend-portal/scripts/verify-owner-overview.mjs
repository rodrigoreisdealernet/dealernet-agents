// Verificacao dependency-free da tela "Visão do Dono" (Fast BI, Issue #15).
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest, sem node_modules
// no worktree): usamos apenas os modulos nativos do Node (node:test, node:assert,
// node:fs) para assertar — lendo os arquivos-fonte como texto — que o dashboard
// DiaOverview satisfaz os criterios de aceite da spec
// docs/specs/15-feat-frontend-dashboard-visao-do.md.
//
// Roda com: node --test scripts/verify-owner-overview.mjs
//
// Este e o padrao estabelecido do repo (ver verify-chartcard.mjs e
// verify-vehicle-wiring.mjs): testes estruturais sobre o texto-fonte, sem
// introduzir um framework de testes novo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SCREEN_PATH = 'src/portal/renderers/screens/DiaOverview.tsx'
const REGISTRY_PATH = 'src/portal/renderers/registry.ts'
const PORTAL_API_PATH = 'src/portal/lib/portalApi.ts'
const AGENTS_API_PATH = 'src/portal/lib/agentsApi.ts'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// AC: Existe uma nova tela "Visão do Dono" — DiaOverview.tsx com default export.
test('AC: DiaOverview.tsx existe e tem default export da funcao DiaOverview', () => {
  assert.ok(
    existsSync(resolve(ROOT, SCREEN_PATH)),
    `${SCREEN_PATH} deve existir`,
  )
  const src = read(SCREEN_PATH)
  assert.match(
    src,
    /export\s+default\s+function\s+DiaOverview\s*\(/,
    'DiaOverview.tsx deve fazer "export default function DiaOverview(" ',
  )
})

// AC: Registrada com componentKey 'dia-overview' em registry.ts (import lazy).
test("AC: registry.ts mapeia 'dia-overview' -> import lazy de DiaOverview", () => {
  const registry = read(REGISTRY_PATH)
  assert.match(
    registry,
    /['"]dia-overview['"]\s*:\s*lazy\(\s*\(\)\s*=>\s*import\([^)]*DiaOverview[^)]*\)\s*\)/,
    "registry.ts deve ter 'dia-overview': lazy(() => import(.../DiaOverview))",
  )
})

// AC: Item de menu "Visão do Dono" sob secao "Fast BI" em MOCK_MENU -> dia-overview.
test("AC: MOCK_MENU tem secao 'Fast BI' com item 'Visão do Dono' -> componentKey 'dia-overview'", () => {
  const portalApi = read(PORTAL_API_PATH)
  assert.match(
    portalApi,
    /text:\s*['"]Fast BI['"]/,
    "portalApi.ts deve ter uma secao com text: 'Fast BI'",
  )
  assert.match(
    portalApi,
    /text:\s*['"]Visão do Dono['"]/,
    "portalApi.ts deve ter um item de menu com text: 'Visão do Dono'",
  )
  assert.match(
    portalApi,
    /componentKey:\s*['"]dia-overview['"]/,
    "o item de menu deve apontar componentKey: 'dia-overview' (liga menu -> registry -> tela)",
  )
})

// AC: Helpers de dados existem e leem as 3 views com as colunas exatas.
test('AC: agentsApi.ts exporta getOwnerKpis/getSalesTrend/getInventorySummary lendo as 3 views', () => {
  const api = read(AGENTS_API_PATH)
  for (const fn of ['getOwnerKpis', 'getSalesTrend', 'getInventorySummary']) {
    assert.match(
      api,
      new RegExp(`export\\s+async\\s+function\\s+${fn}\\s*\\(`),
      `agentsApi.ts deve exportar a funcao async ${fn}`,
    )
  }
  for (const view of ['v_dia_owner_kpis', 'v_dia_sales_trend', 'v_dia_inventory_summary']) {
    assert.match(
      api,
      new RegExp(`\\.from\\(\\s*['"]${view}['"]\\s*\\)`),
      `agentsApi.ts deve ler de supabase.from('${view}')`,
    )
  }
  // A string de colunas dos KPIs deve incluir as colunas-chave da view (pega
  // regressao no .select — nao basta apontar para a view certa).
  for (const col of ['sales_units_month', 'floor_plan_total', 'parts_critical_count']) {
    assert.ok(
      api.includes(col),
      `o .select de KPIs deve incluir a coluna '${col}'`,
    )
  }
  // As views de tendencia/estoque tambem precisam das colunas consumidas pelos
  // graficos (pega regressao que remova units_sold/vehicles_count do .select).
  for (const col of ['sale_date', 'units_sold', 'revenue', 'age_band', 'vehicles_count', 'inventory_value']) {
    assert.ok(
      api.includes(col),
      `o .select das views de tendencia/estoque deve incluir a coluna '${col}'`,
    )
  }
})

// AC: Banda de KpiCards cobre as metricas obrigatorias, ligadas a kpis?.<campo>.
test('AC: DiaOverview liga a banda de KpiCards aos campos obrigatorios de v_dia_owner_kpis', () => {
  const src = read(SCREEN_PATH)
  const fields = [
    'sales_units_month',
    'sales_revenue_month',
    'margin_month',
    'service_orders_open',
    'service_revenue_month',
    'inventory_vehicle_value',
    'floor_plan_total',
    'parts_inventory_value',
    'parts_critical_count',
  ]
  for (const field of fields) {
    assert.match(
      src,
      new RegExp(`kpis\\?\\.${field}\\b`),
      `a banda de KpiCards deve referenciar kpis?.${field}`,
    )
  }
})

// AC: Ao menos 2 ChartCards — linha (xKey sale_date) e barra (xKey age_band).
test('AC: DiaOverview usa >=2 ChartCards: line/sale_date e bar/age_band', () => {
  const src = read(SCREEN_PATH)
  const usages = src.match(/<ChartCard\b/g) ?? []
  assert.ok(
    usages.length >= 2,
    `DiaOverview deve renderizar pelo menos 2 <ChartCard>, encontrou ${usages.length}`,
  )
  // ChartCard de linha: type="line" + xKey="sale_date" (tendencia de vendas).
  assert.match(
    src,
    /<ChartCard\b[\s\S]*?type="line"[\s\S]*?xKey="sale_date"|<ChartCard\b[\s\S]*?xKey="sale_date"[\s\S]*?type="line"/,
    'deve haver um ChartCard type="line" com xKey="sale_date" (tendencia de vendas)',
  )
  // ChartCard de barra: type="bar" + xKey="age_band" (estoque por faixa de idade).
  assert.match(
    src,
    /<ChartCard\b[\s\S]*?type="bar"[\s\S]*?xKey="age_band"|<ChartCard\b[\s\S]*?xKey="age_band"[\s\S]*?type="bar"/,
    'deve haver um ChartCard type="bar" com xKey="age_band" (estoque por faixa de idade)',
  )
  // As `series` devem apontar para campos REAIS das views (pega renome de key para
  // coluna inexistente): tendencia usa revenue/units_sold; estoque usa
  // vehicles_count/inventory_value.
  for (const key of ['revenue', 'units_sold', 'vehicles_count', 'inventory_value']) {
    assert.match(
      src,
      new RegExp(`key:\\s*['"]${key}['"]`),
      `as series dos ChartCards devem incluir key: '${key}' (campo real das views)`,
    )
  }
})

// AC: Reaproveita widgets/formatters e os helpers de dados (sem reimplementar).
test('AC: DiaOverview importa ChartCard/KpiCard/ScreenShell/formatBRL e os 3 helpers', () => {
  const src = read(SCREEN_PATH)
  assert.match(
    src,
    /import\s*\{\s*ChartCard\s*\}\s*from\s*['"]\.\/ChartCard['"]/,
    "deve importar { ChartCard } de './ChartCard'",
  )
  assert.match(
    src,
    /import\s*\{[^}]*\bKpiCard\b[^}]*\bScreenShell\b[^}]*\}\s*from\s*['"]\.\/ui['"]|import\s*\{[^}]*\bScreenShell\b[^}]*\bKpiCard\b[^}]*\}\s*from\s*['"]\.\/ui['"]/,
    "deve importar KpiCard e ScreenShell de './ui'",
  )
  // Issue #54: os KPI cards passaram a usar formatBRLKpi (sem R$/decimais).
  assert.match(
    src,
    /import\s*\{[^}]*\bformatBRLKpi\b[^}]*\}\s*from\s*['"]\.\/format['"]/,
    "deve importar formatBRLKpi de './format' (KPI cards, issue #54)",
  )
  for (const fn of ['getOwnerKpis', 'getSalesTrend', 'getInventorySummary']) {
    assert.ok(
      src.includes(fn),
      `DiaOverview deve consumir ${fn} de @/portal/lib/agentsApi`,
    )
  }
  assert.match(
    src,
    /from\s*['"]@\/portal\/lib\/agentsApi['"]/,
    'deve importar os helpers de @/portal/lib/agentsApi',
  )
})

// AC: Trata estados de erro e vazio (em vez de quebrar).
test('AC: DiaOverview trata estado de erro (text-destructive) e estado vazio (emptyMessage)', () => {
  const src = read(SCREEN_PATH)
  // Ramo de erro visivel ao usuario.
  assert.match(
    src,
    /error\s*&&[\s\S]*?text-destructive/,
    'DiaOverview deve renderizar um ramo de erro em text-destructive',
  )
  // Estado vazio delegado ao ChartCard via emptyMessage (placeholder, nao quebra).
  assert.match(
    src,
    /emptyMessage=/,
    'DiaOverview deve passar emptyMessage aos ChartCards (estado vazio tratado)',
  )
})
