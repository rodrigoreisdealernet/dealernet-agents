// Verificacao dependency-free do dashboard "Pecas" (Fast BI) — Issue #18.
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest, sem node_modules
// no worktree): usamos apenas os modulos nativos do Node (node:test, node:assert,
// node:fs) para assertar — lendo os arquivos-fonte como texto — que a tela
// PartsBI.tsx e sua fiacao satisfazem os criterios de aceite da spec
// docs/specs/18-feat-frontend-dashboard-estoque-pecas.md.
//
// Roda com: node --test scripts/verify-parts-bi.mjs
//
// Este e o padrao estabelecido do repo (ver verify-chartcard.mjs): testes
// estruturais sobre o texto-fonte, sem introduzir um framework de testes novo
// (Non-Goal explicito da spec).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const PARTS_BI_PATH = 'src/portal/renderers/screens/PartsBI.tsx'
const REGISTRY_PATH = 'src/portal/renderers/registry.ts'
const PORTAL_API_PATH = 'src/portal/lib/portalApi.ts'
const AGENTS_API_PATH = 'src/portal/lib/agentsApi.ts'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// AC1: A tela existe e e registrada — PartsBI.tsx exporta um componente default.
test('AC1: PartsBI.tsx existe e tem export default da funcao PartsBI', () => {
  assert.ok(
    existsSync(resolve(ROOT, PARTS_BI_PATH)),
    `${PARTS_BI_PATH} deve existir`,
  )
  const src = read(PARTS_BI_PATH)
  assert.match(
    src,
    /export\s+default\s+function\s+PartsBI\s*\(/,
    'PartsBI.tsx deve ter "export default function PartsBI(...)"',
  )
})

// AC1: registry.ts mapeia o componentKey 'dia-parts-bi' para a tela via lazy import.
test("AC1: registry.ts registra 'dia-parts-bi' com lazy(() => import PartsBI)", () => {
  const src = read(REGISTRY_PATH)
  // A chave deve existir e apontar para um lazy import do modulo PartsBI.
  assert.match(
    src,
    /['"]dia-parts-bi['"]\s*:\s*lazy\(\s*\(\)\s*=>\s*import\([^)]*PartsBI[^)]*\)\s*\)/,
    "registry.ts deve mapear 'dia-parts-bi' -> lazy(() => import('.../PartsBI'))",
  )
})

// AC2: o item de menu "Pecas" aparece sob a secao Fast BI / Insights.
test("AC2: portalApi.ts tem item 'Pecas' -> componentKey 'dia-parts-bi' na secao Fast BI", () => {
  const src = read(PORTAL_API_PATH)
  // A secao Insights deve estar rotulada como 'Fast BI'.
  assert.match(
    src,
    /id:\s*['"]insights['"][\s\S]*?text:\s*['"]Fast BI['"]/,
    "a secao 'insights' do MOCK_MENU deve ter text 'Fast BI'",
  )
  // Deve existir um item de menu com texto 'Pecas' (com cedilha) ...
  assert.match(
    src,
    /text:\s*['"]Peças['"]/,
    "MOCK_MENU deve conter um item com text 'Peças'",
  )
  // ... cujo spec referencia o componentKey 'dia-parts-bi' como kind 'component'.
  const itemRe =
    /text:\s*['"]Peças['"][\s\S]{0,300}?componentKey:\s*['"]dia-parts-bi['"]/
  assert.match(
    src,
    itemRe,
    "o item 'Peças' deve referenciar componentKey 'dia-parts-bi'",
  )
  assert.match(
    src,
    /text:\s*['"]Peças['"][\s\S]{0,300}?kind:\s*['"]component['"]/,
    "o item 'Peças' deve ter kind 'component'",
  )
  // E deve estar DENTRO da secao Fast BI (entre o inicio da secao insights e a
  // proxima secao 'dealership'), nao em outro lugar do menu.
  const insightsStart = src.indexOf("id: 'insights'")
  const dealershipStart = src.indexOf("id: 'dealership'")
  assert.ok(
    insightsStart !== -1 && dealershipStart !== -1 && insightsStart < dealershipStart,
    'as secoes insights e dealership devem existir nessa ordem',
  )
  const insightsBlock = src.slice(insightsStart, dealershipStart)
  assert.match(
    insightsBlock,
    /componentKey:\s*['"]dia-parts-bi['"]/,
    "o item 'dia-parts-bi' deve estar dentro da secao Fast BI/Insights",
  )
})

// AC3: a tela renderiza os KPIs exigidos via KpiCard.
test('AC3: a tela renderiza KpiCard com valor de estoque, criticas/zeradas e vendas do mes', () => {
  const src = read(PARTS_BI_PATH)
  assert.ok(src.includes('KpiCard'), 'PartsBI deve usar o componente KpiCard')
  // KPI: valor de estoque via formatBRL(kpis.parts_inventory_value).
  assert.match(
    src,
    /formatBRL\(\s*kpis\??\.?parts_inventory_value/,
    'deve exibir o valor de estoque a partir de parts_inventory_value via formatBRL',
  )
  // KPI: contagem de pecas criticas/zeradas.
  assert.match(
    src,
    /kpis\??\.?parts_critical_count/,
    'deve exibir a contagem de pecas criticas/zeradas (parts_critical_count)',
  )
  // KPI: vendas do mes — unidades e receita (R$).
  assert.match(
    src,
    /monthSales\.units/,
    'deve exibir as unidades vendidas no mes (monthSales.units)',
  )
  assert.match(
    src,
    /formatBRL\(\s*monthSales\.revenue/,
    'deve exibir a receita do mes em R$ via formatBRL(monthSales.revenue)',
  )
})

// AC4: a tela renderiza os graficos exigidos via ChartCard.
test('AC4: usa ChartCard bar/pie keyed em stock_status e line para vendas (period_month)', () => {
  const src = read(PARTS_BI_PATH)
  assert.match(
    src,
    /import\s*\{[^}]*\bChartCard\b[^}]*\}\s*from\s*['"]\.\/ChartCard['"]/,
    'PartsBI deve importar ChartCard de ./ChartCard',
  )
  // Grafico de inventario por estado de estoque: tipo bar (ou pie) com xKey stock_status.
  const inventoryChartRe =
    /<ChartCard[\s\S]*?type=["'](?:bar|pie)["'][\s\S]*?xKey=["']stock_status["']/
  const inventoryChartReAlt =
    /<ChartCard[\s\S]*?xKey=["']stock_status["'][\s\S]*?type=["'](?:bar|pie)["']/
  assert.ok(
    inventoryChartRe.test(src) || inventoryChartReAlt.test(src),
    "deve haver um ChartCard type='bar'|'pie' com xKey='stock_status'",
  )
  // Grafico de vendas ao longo do tempo: tipo line com xKey period_month.
  const salesChartRe =
    /<ChartCard[\s\S]*?type=["']line["'][\s\S]*?xKey=["']period_month["']/
  const salesChartReAlt =
    /<ChartCard[\s\S]*?xKey=["']period_month["'][\s\S]*?type=["']line["']/
  assert.ok(
    salesChartRe.test(src) || salesChartReAlt.test(src),
    "deve haver um ChartCard type='line' com xKey='period_month'",
  )
})

// AC5: a tela lista as pecas criticas para reposicao (getCriticalParts + linhas).
test('AC5: chama getCriticalParts e renderiza uma lista de pecas criticas por linha', () => {
  const src = read(PARTS_BI_PATH)
  assert.match(
    src,
    /import\s*\{[^}]*\bgetCriticalParts\b/,
    'PartsBI deve importar getCriticalParts de agentsApi',
  )
  assert.match(
    src,
    /getCriticalParts\s*\(/,
    'PartsBI deve invocar getCriticalParts()',
  )
  // Deve mapear cada peca critica para uma linha (com Badge do estado de estoque).
  assert.match(
    src,
    /critical\.map\(/,
    'deve iterar a lista critical para renderizar uma linha por peca',
  )
  assert.ok(
    src.includes('Badge'),
    'cada linha critica deve exibir o estado de estoque via Badge',
  )
  // Deve referenciar campos identificadores da peca (numero/descricao).
  assert.match(
    src,
    /part_number|description/,
    'a lista critica deve exibir identificador/descricao da peca',
  )
})

// AC6: estado vazio gracioso — cada ChartCard recebe emptyMessage.
test('AC6: cada ChartCard recebe emptyMessage (estado vazio gracioso, >= 2)', () => {
  const src = read(PARTS_BI_PATH)
  const emptyMatches = src.match(/emptyMessage=/g) ?? []
  assert.ok(
    emptyMatches.length >= 2,
    `cada ChartCard deve receber emptyMessage; encontrados ${emptyMatches.length} (esperado >= 2)`,
  )
  // Cada ChartCard renderizado deve ter um emptyMessage associado.
  const chartCount = (src.match(/<ChartCard\b/g) ?? []).length
  assert.ok(chartCount >= 2, `esperado >= 2 ChartCard; encontrados ${chartCount}`)
  assert.ok(
    emptyMatches.length >= chartCount,
    `cada ChartCard (${chartCount}) deve ter emptyMessage; encontrados ${emptyMatches.length}`,
  )
})

// AC6: KPIs caem para 0/— quando os dados analiticos estao vazios.
test('AC6: KPIs caem para 0/formatBRL(nullish) quando os dados estao vazios', () => {
  const src = read(PARTS_BI_PATH)
  // Valor de estoque: formatBRL com fallback nullish (?? 0 ou optional chaining).
  assert.match(
    src,
    /formatBRL\(\s*kpis\?\.parts_inventory_value\s*\?\?\s*0\s*\)/,
    'o KPI de valor de estoque deve usar fallback ?? 0',
  )
  // Contagem critica: fallback ?? 0 quando ausente.
  assert.match(
    src,
    /kpis\?\.parts_critical_count\s*\?\?\s*0/,
    'o KPI de pecas criticas deve usar fallback ?? 0',
  )
  // A lista critica vazia deve ter um fallback legivel (sem chart/tabela quebrada).
  assert.ok(
    src.includes('Nenhuma peça crítica.'),
    'deve haver um fallback de tabela vazia ("Nenhuma peça crítica.")',
  )
})

// AC (data layer): agentsApi expoe getPartsSummary (v_dia_parts_summary) e
// getDiaOwnerKpis (v_dia_owner_kpis) com as interfaces correspondentes.
test('AC: agentsApi expoe getPartsSummary (v_dia_parts_summary) e getDiaOwnerKpis (v_dia_owner_kpis)', () => {
  const src = read(AGENTS_API_PATH)
  // getPartsSummary le v_dia_parts_summary.
  assert.match(
    src,
    /export\s+async\s+function\s+getPartsSummary\s*\(/,
    'agentsApi deve exportar getPartsSummary',
  )
  assert.match(
    src,
    /getPartsSummary[\s\S]*?\.from\(\s*['"]v_dia_parts_summary['"]\s*\)/,
    "getPartsSummary deve ler a view 'v_dia_parts_summary'",
  )
  assert.match(
    src,
    /export\s+interface\s+PartsSummaryRow/,
    'agentsApi deve declarar a interface PartsSummaryRow',
  )
  // getDiaOwnerKpis le v_dia_owner_kpis.
  assert.match(
    src,
    /export\s+async\s+function\s+getDiaOwnerKpis\s*\(/,
    'agentsApi deve exportar getDiaOwnerKpis',
  )
  assert.match(
    src,
    /getDiaOwnerKpis[\s\S]*?\.from\(\s*['"]v_dia_owner_kpis['"]\s*\)/,
    "getDiaOwnerKpis deve ler a view 'v_dia_owner_kpis'",
  )
  assert.match(
    src,
    /export\s+interface\s+DiaOwnerKpis/,
    'agentsApi deve declarar a interface DiaOwnerKpis',
  )
  // A interface DiaOwnerKpis deve cobrir os campos consumidos pelo dashboard.
  assert.match(
    src,
    /interface\s+DiaOwnerKpis[\s\S]*?parts_inventory_value[\s\S]*?parts_critical_count/,
    'DiaOwnerKpis deve declarar parts_inventory_value e parts_critical_count',
  )
})
