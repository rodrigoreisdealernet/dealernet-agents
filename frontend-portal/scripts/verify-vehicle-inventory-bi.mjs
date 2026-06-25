// Verificacao dependency-free do dashboard "Estoque de Veículos" (Fast BI) — Issue #19.
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest, sem node_modules
// no worktree): usamos apenas os modulos nativos do Node (node:test, node:assert,
// node:fs) para assertar — lendo os arquivos-fonte como texto — que a tela
// VehicleInventoryBI.tsx e sua fiacao satisfazem os criterios de aceite da spec
// docs/specs/19-feat-frontend-dashboard-estoque-de.md.
//
// Roda com: node --test scripts/verify-vehicle-inventory-bi.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const VEHICLE_BI_PATH = 'src/portal/renderers/screens/VehicleInventoryBI.tsx'
const REGISTRY_PATH = 'src/portal/renderers/registry.ts'
const PORTAL_API_PATH = 'src/portal/lib/portalApi.ts'
const AGENTS_API_PATH = 'src/portal/lib/agentsApi.ts'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// AC screen+registry: a tela existe e exporta o componente default.
test('AC screen+registry: VehicleInventoryBI.tsx existe e exporta VehicleInventoryBI', () => {
  assert.ok(
    existsSync(resolve(ROOT, VEHICLE_BI_PATH)),
    `${VEHICLE_BI_PATH} deve existir`,
  )
  const src = read(VEHICLE_BI_PATH)
  assert.match(
    src,
    /export\s+default\s+function\s+VehicleInventoryBI\s*\(/,
    'VehicleInventoryBI.tsx deve ter "export default function VehicleInventoryBI(...)"',
  )
})

// AC screen+registry: registry.ts mapeia 'dia-vehicle-inventory' via lazy import.
test("AC screen+registry: registry.ts registra 'dia-vehicle-inventory' com lazy import", () => {
  const src = read(REGISTRY_PATH)
  assert.match(
    src,
    /['"]dia-vehicle-inventory['"]\s*:\s*lazy\(\s*\(\)\s*=>\s*import\([^)]*VehicleInventoryBI[^)]*\)\s*\)/,
    "registry.ts deve mapear 'dia-vehicle-inventory' -> lazy(() => import('.../VehicleInventoryBI'))",
  )
})

// AC menu: o item "Estoque de Veículos" aparece sob a secao Fast BI correta.
test("AC menu: portalApi.ts tem 'Estoque de Veículos' -> dia-vehicle-inventory dentro de Fast BI", () => {
  const src = read(PORTAL_API_PATH)
  assert.match(
    src,
    /id:\s*['"]fast-bi['"][\s\S]*?text:\s*['"]Fast BI['"]/,
    "a secao 'fast-bi' do MOCK_MENU deve ter text 'Fast BI'",
  )
  assert.match(
    src,
    /text:\s*['"]Estoque de Veículos['"]/,
    "MOCK_MENU deve conter item com text 'Estoque de Veículos'",
  )
  assert.match(
    src,
    /text:\s*['"]Estoque de Veículos['"][\s\S]{0,400}?componentKey:\s*['"]dia-vehicle-inventory['"]/,
    "o item 'Estoque de Veículos' deve referenciar componentKey 'dia-vehicle-inventory'",
  )
  assert.match(
    src,
    /text:\s*['"]Estoque de Veículos['"][\s\S]{0,400}?kind:\s*['"]component['"]/,
    "o item 'Estoque de Veículos' deve ter kind 'component'",
  )
  const fastBiStart = src.indexOf("id: 'fast-bi'")
  const dealershipStart = src.indexOf("id: 'dealership'")
  assert.ok(
    fastBiStart !== -1 && dealershipStart !== -1 && fastBiStart < dealershipStart,
    'as secoes fast-bi e dealership devem existir nessa ordem',
  )
  const fastBiBlock = src.slice(fastBiStart, dealershipStart)
  assert.match(
    fastBiBlock,
    /text:\s*['"]Estoque de Veículos['"][\s\S]*?componentKey:\s*['"]dia-vehicle-inventory['"]/,
    "o item 'dia-vehicle-inventory' deve estar dentro da secao Fast BI",
  )
})

// AC KPIs (4): a tela renderiza quatro KpiCard com os campos reais e fallback.
test('AC KPIs: renderiza quatro KpiCard com campos reais, fallbacks e +90 dias derivado', () => {
  const src = read(VEHICLE_BI_PATH)
  const kpiCount = (src.match(/<KpiCard\b/g) ?? []).length
  assert.ok(kpiCount >= 4, `deve renderizar ao menos 4 KpiCard; encontrados ${kpiCount}`)
  assert.ok(src.includes('KpiCard'), 'VehicleInventoryBI deve usar o componente KpiCard')
  assert.match(
    src,
    /formatBRL\(\s*kpis\?\.inventory_vehicle_value\s*\?\?\s*0\s*\)/,
    'KPI valor do estoque deve usar kpis?.inventory_vehicle_value ?? 0 via formatBRL',
  )
  assert.match(
    src,
    /formatBRL\(\s*kpis\?\.floor_plan_total\s*\?\?\s*0\s*\)/,
    'KPI floor plan total deve usar kpis?.floor_plan_total ?? 0 via formatBRL',
  )
  assert.match(
    src,
    /Math\.round\(\s*kpis\?\.avg_days_in_stock\s*\?\?\s*0\s*\)/,
    'KPI dias medios deve usar Math.round(kpis?.avg_days_in_stock ?? 0)',
  )
  assert.match(
    src,
    /\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.age_band\s*===\s*['"]90\+['"]\s*\)/,
    "KPI +90 dias deve filtrar summary por age_band === '90+'",
  )
  assert.match(
    src,
    /\.reduce\(\s*\([^)]*total[^)]*,[^)]*\w+[^)]*\)\s*=>\s*total\s*\+\s*\(\s*\w+\.vehicles_count\s*\?\?\s*0\s*\)/,
    'KPI +90 dias deve somar vehicles_count com fallback ?? 0',
  )
})

// AC age-band chart: grafico por faixa com ordem fixa e series de custo/valor.
test('AC age-band chart: ChartCard bar xKey age_band, ordem fixa e series floor_plan/inventory', () => {
  const src = read(VEHICLE_BI_PATH)
  assert.match(
    src,
    /const\s+AGE_BANDS\s*=\s*\[\s*['"]0-30['"]\s*,\s*['"]31-60['"]\s*,\s*['"]61-90['"]\s*,\s*['"]90\+['"]\s*\]/,
    "deve declarar AGE_BANDS na ordem ['0-30', '31-60', '61-90', '90+']",
  )
  const ageChartRe = /<ChartCard[\s\S]*?type=["']bar["'][\s\S]*?xKey=["']age_band["']/
  const ageChartReAlt = /<ChartCard[\s\S]*?xKey=["']age_band["'][\s\S]*?type=["']bar["']/
  assert.ok(
    ageChartRe.test(src) || ageChartReAlt.test(src),
    "deve haver ChartCard type='bar' com xKey='age_band'",
  )
  const ageChartBlock =
    src.match(/<ChartCard[\s\S]*?xKey=["']age_band["'][\s\S]*?\/>/)?.[0] ??
    src.match(/<ChartCard[\s\S]*?type=["']bar["'][\s\S]*?xKey=["']age_band["'][\s\S]*?\/>/)?.[0] ??
    ''
  assert.ok(ageChartBlock, 'nao foi possivel localizar o ChartCard de age_band')
  assert.match(ageChartBlock, /key:\s*['"]floor_plan_cost['"]/, 'grafico de idade deve incluir floor_plan_cost')
  assert.match(ageChartBlock, /key:\s*['"]inventory_value['"]/, 'grafico de idade deve incluir inventory_value')
})

// AC brand/store chart: segundo grafico por marca/loja ordenado por maior floor_plan_cost.
test('AC brand/store chart: ChartCard bar xKey brand_store ordena floor_plan_cost desc', () => {
  const src = read(VEHICLE_BI_PATH)
  const chartRe = /<ChartCard[\s\S]*?type=["']bar["'][\s\S]*?xKey=["']brand_store["']/
  const chartReAlt = /<ChartCard[\s\S]*?xKey=["']brand_store["'][\s\S]*?type=["']bar["']/
  assert.ok(
    chartRe.test(src) || chartReAlt.test(src),
    "deve haver segundo ChartCard type='bar' com xKey='brand_store'",
  )
  assert.match(
    src,
    /\.sort\(\s*\(?\s*\w+\s*,\s*\w+\s*\)?\s*=>\s*\w+\.floor_plan_cost\s*-\s*\w+\.floor_plan_cost\s*,?\s*\)/,
    'linhas por marca/loja devem ser ordenadas DESC por floor_plan_cost',
  )
})

// AC oldest-vehicles list: chama getVehicles, filtra em estoque, ordena por floor_plan_cost e renderiza campos.
test('AC oldest-vehicles list: filtra em_estoque, ordena por floor_plan_cost desc e renderiza campos', () => {
  const src = read(VEHICLE_BI_PATH)
  assert.match(
    src,
    /import\s*\{[\s\S]*\bgetVehicles\b/,
    'VehicleInventoryBI deve importar getVehicles de agentsApi',
  )
  assert.match(src, /getVehicles\s*\(/, 'VehicleInventoryBI deve invocar getVehicles()')
  assert.match(
    src,
    /\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.status\s*===\s*['"]em_estoque['"]\s*\)/,
    "lista deve filtrar apenas veiculos com status === 'em_estoque'",
  )
  assert.match(
    src,
    /\.sort\(\s*\(?\s*\w+\s*,\s*\w+\s*\)?\s*=>\s*\(\s*\w+\.floor_plan_cost\s*\?\?\s*0\s*\)\s*-\s*\(\s*\w+\.floor_plan_cost\s*\?\?\s*0\s*\)\s*,?\s*\)/,
    'lista deve ordenar por floor_plan_cost DESC com fallback ?? 0',
  )
  assert.match(src, /vehicle\.days_in_stock/, 'linhas devem renderizar days_in_stock')
  assert.match(
    src,
    /formatBRL\(\s*vehicle\.floor_plan_cost\s*\?\?\s*0\s*\)/,
    'linhas devem renderizar floor_plan_cost via formatBRL',
  )
  assert.match(src, /vehicle\.store/, 'linhas devem renderizar store')
  for (const field of ['brand', 'model', 'model_year']) {
    assert.match(src, new RegExp(`vehicle\\.${field}`), `linhas devem renderizar vehicle.${field}`)
  }
})

// AC graceful states: loading, emptyMessage em cada ChartCard e fallback da tabela.
test('AC graceful states: loading, emptyMessage por ChartCard e fallback de tabela vazia', () => {
  const src = read(VEHICLE_BI_PATH)
  assert.match(src, /loading\s*&&[\s\S]{0,120}?Carregando/, 'deve renderizar estado de loading')
  const emptyMatches = src.match(/emptyMessage=/g) ?? []
  const chartCount = (src.match(/<ChartCard\b/g) ?? []).length
  assert.ok(chartCount >= 2, `esperado >= 2 ChartCard; encontrados ${chartCount}`)
  assert.ok(
    emptyMatches.length >= chartCount,
    `cada ChartCard (${chartCount}) deve ter emptyMessage; encontrados ${emptyMatches.length}`,
  )
  assert.ok(
    src.includes('Nenhum veículo em estoque.'),
    'deve haver fallback vazio da tabela: "Nenhum veículo em estoque."',
  )
})

// AC data layer: agentsApi expoe leituras das views reais e o shape consumido pela tela.
test('AC data layer: agentsApi exporta inventory summary, owner kpis e vehicles das views reais', () => {
  const src = read(AGENTS_API_PATH)
  assert.match(
    src,
    /export\s+async\s+function\s+getInventorySummary\s*\(/,
    'agentsApi deve exportar getInventorySummary',
  )
  assert.match(
    src,
    /getInventorySummary[\s\S]*?\.from\(\s*['"]v_dia_inventory_summary['"]\s*\)/,
    "getInventorySummary deve ler a view 'v_dia_inventory_summary'",
  )
  assert.match(
    src,
    /export\s+async\s+function\s+getOwnerKpis\s*\(/,
    'agentsApi deve exportar getOwnerKpis',
  )
  assert.match(
    src,
    /getOwnerKpis[\s\S]*?\.from\(\s*['"]v_dia_owner_kpis['"]\s*\)/,
    "getOwnerKpis deve ler a view 'v_dia_owner_kpis'",
  )
  assert.match(
    src,
    /export\s+async\s+function\s+getVehicles\s*\(/,
    'agentsApi deve exportar getVehicles',
  )
  assert.match(
    src,
    /getVehicles[\s\S]*?\.from\(\s*['"]v_dia_vehicle_current['"]\s*\)/,
    "getVehicles deve ler a view 'v_dia_vehicle_current'",
  )
  const inventoryBlock =
    src.match(/export\s+interface\s+InventorySummaryRow\s*\{[\s\S]*?\}/)?.[0] ?? ''
  assert.ok(inventoryBlock, 'nao foi possivel localizar InventorySummaryRow')
  for (const field of ['age_band', 'vehicles_count', 'inventory_value', 'floor_plan_cost']) {
    assert.match(
      inventoryBlock,
      new RegExp(`\\b${field}\\b`),
      `InventorySummaryRow deve declarar '${field}'`,
    )
  }
})
