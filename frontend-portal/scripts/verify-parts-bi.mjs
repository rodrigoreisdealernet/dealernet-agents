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
    /id:\s*['"]fast-bi['"][\s\S]*?text:\s*['"]Fast BI['"]/,
    "a secao 'fast-bi' do MOCK_MENU deve ter text 'Fast BI'",
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
  // E deve estar DENTRO da secao Fast BI (entre o inicio da secao fast-bi e a
  // proxima secao 'dealership'), nao em outro lugar do menu.
  const biStart = src.indexOf("id: 'fast-bi'")
  const dealershipStart = src.indexOf("id: 'dealership'")
  assert.ok(
    biStart !== -1 && dealershipStart !== -1 && biStart < dealershipStart,
    'as secoes fast-bi e dealership devem existir nessa ordem',
  )
  const biBlock = src.slice(biStart, dealershipStart)
  assert.match(
    biBlock,
    /componentKey:\s*['"]dia-parts-bi['"]/,
    "o item 'dia-parts-bi' deve estar dentro da secao Fast BI",
  )
})

// AC3: a tela renderiza os KPIs exigidos via KpiCard.
test('AC3: a tela renderiza KpiCard com valor de estoque, criticas/zeradas e vendas do mes', () => {
  const src = read(PARTS_BI_PATH)
  assert.ok(src.includes('KpiCard'), 'PartsBI deve usar o componente KpiCard')
  // KPI: valor de estoque via formatBRLKpi(kpis.parts_inventory_value) — issue
  // #54: KPI cards sem R$/decimais.
  assert.match(
    src,
    /formatBRLKpi\(\s*kpis\??\.?parts_inventory_value/,
    'deve exibir o valor de estoque a partir de parts_inventory_value via formatBRLKpi (issue #54)',
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
    /formatBRLKpi\(\s*monthSales\.revenue/,
    'deve exibir a receita do mes via formatBRLKpi(monthSales.revenue) (KPI card, issue #54)',
  )
  // O KPI de vendas do mes deve ser ESCOPADO ao mes corrente — nao um total
  // de todo o periodo. A useMemo monthSales (PartsBI.tsx l.72-79) deriva o
  // prefixo ano-mes de hoje com new Date()/getFullYear()/getMonth() e filtra
  // salesRows por period_month.slice(0, 7) === prefixo. Assertamos essa
  // matematica de data para que o teste FALHE se alguem trocar o filtro por
  // uma soma all-time.
  assert.match(
    src,
    /new Date\(\)/,
    'monthSales deve derivar a data corrente via new Date() (PartsBI.tsx l.73)',
  )
  assert.match(
    src,
    /getFullYear\(\)/,
    'monthSales deve usar getFullYear() para o prefixo ano-mes (l.74)',
  )
  assert.match(
    src,
    /getMonth\(\)/,
    'monthSales deve usar getMonth() para o prefixo ano-mes (l.74)',
  )
  // O filtro deve comparar o prefixo YYYY-MM de period_month (.slice(0, 7))
  // contra o prefixo corrente — isto e o que escopa o KPI ao mes atual (l.75).
  assert.match(
    src,
    /period_month[\s\S]{0,40}?\)\s*\.slice\(\s*0\s*,\s*7\s*\)\s*===\s*prefix/,
    "monthSales deve filtrar salesRows por period_month.slice(0, 7) === prefix (l.75)",
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
  // Deve referenciar AMBOS os campos identificadores da peca — a tela renderiza
  // o part_number (l.157) E a description (l.158) em cada linha critica.
  assert.match(
    src,
    /r\.part_number/,
    'cada linha critica deve exibir r.part_number (PartsBI.tsx l.157)',
  )
  assert.match(
    src,
    /r\.description/,
    'cada linha critica deve exibir r.description (PartsBI.tsx l.158)',
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
test('AC6: KPIs caem para 0/formatBRLKpi(nullish) quando os dados estao vazios', () => {
  const src = read(PARTS_BI_PATH)
  // Valor de estoque: formatBRLKpi com fallback nullish (?? 0). Issue #54.
  assert.match(
    src,
    /formatBRLKpi\(\s*kpis\?\.parts_inventory_value\s*\?\?\s*0\s*\)/,
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
  // PartsSummaryRow deve declarar os campos de VENDA que o KPI de vendas do mes
  // e o grafico de linha consomem (period_month, units_sold, revenue), alem dos
  // campos de inventario. Ancoramos no bloco da interface (agentsApi.ts l.636-642).
  const partsRowBlock =
    src.match(/export\s+interface\s+PartsSummaryRow\s*\{[\s\S]*?\}/)?.[0] ?? ''
  assert.ok(partsRowBlock, 'nao foi possivel localizar o corpo da interface PartsSummaryRow')
  for (const field of ['period_month', 'units_sold', 'revenue']) {
    assert.match(
      partsRowBlock,
      new RegExp(`\\b${field}\\b`),
      `PartsSummaryRow deve declarar o campo de venda '${field}'`,
    )
  }
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
