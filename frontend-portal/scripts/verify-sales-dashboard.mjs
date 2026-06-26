// Verificacao dependency-free do dashboard de Vendas VN/VU (Issue #16).
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest, sem node_modules
// no worktree): usamos apenas os modulos nativos do Node (node:test, node:assert,
// node:fs) para assertar — lendo os arquivos-fonte como texto — que a tela
// SalesDashboard.tsx, o agentsApi, o registry e o menu satisfazem os criterios de
// aceite da spec do Fast BI de Vendas (issue #16).
//
// Roda com: node --test scripts/verify-sales-dashboard.mjs
//
// Este e o padrao estabelecido do repo (ver verify-vehicle-wiring.mjs e
// verify-chartcard.mjs): testes estruturais sobre o texto-fonte, sem introduzir
// um framework de testes novo nem e2e/playwright (Non-Goal do POC offline).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SCREEN_PATH = 'src/portal/renderers/screens/SalesDashboard.tsx'
const API_PATH = 'src/portal/lib/agentsApi.ts'
const REGISTRY_PATH = 'src/portal/renderers/registry.ts'
const PORTAL_API_PATH = 'src/portal/lib/portalApi.ts'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// ── AC1: Menu "Vendas" no grupo Fast BI apontando para chave registrada ───────
test('AC1: portalApi.ts tem item de menu fast-bi-sales -> componentKey dia-sales', () => {
  const src = read(PORTAL_API_PATH)
  assert.ok(
    src.includes("id: 'fast-bi-sales'"),
    "portalApi.ts deve ter um item de menu com id 'fast-bi-sales'",
  )
  assert.match(
    src,
    /componentKey:\s*['"]dia-sales['"]/,
    "o item de Vendas deve apontar componentKey: 'dia-sales' (liga menu -> registry -> tela)",
  )
  assert.ok(
    src.includes("text: 'Vendas (VN/VU)'"),
    "o item de menu deve ter o texto 'Vendas (VN/VU)'",
  )
})

test('AC1: o item fast-bi-sales fica DENTRO do grupo Fast BI', () => {
  const src = read(PORTAL_API_PATH)
  const biGroupIdx = src.indexOf("id: 'fast-bi'")
  const salesItemIdx = src.indexOf("id: 'fast-bi-sales'")
  // O proximo grupo top-level apos Fast BI e 'dealership' (Concessionaria).
  const nextGroupIdx = src.indexOf("id: 'dealership'")
  assert.ok(biGroupIdx !== -1, "deve existir a declaracao do grupo id: 'fast-bi'")
  assert.ok(salesItemIdx !== -1, "deve existir o item id: 'fast-bi-sales'")
  assert.ok(nextGroupIdx !== -1, "deve existir o proximo grupo top-level id: 'dealership'")
  assert.ok(
    salesItemIdx > biGroupIdx && salesItemIdx < nextGroupIdx,
    "'fast-bi-sales' deve aparecer apos o grupo 'fast-bi' e antes do proximo grupo 'dealership' (i.e. dentro de Fast BI)",
  )
})

// ── AC2: Le SOMENTE as views de vendas; nenhuma escrita de vendas ────────────
test('AC2: agentsApi.ts le da view v_dia_sales_summary com helper getSalesSummary', () => {
  const src = read(API_PATH)
  assert.match(
    src,
    /export\s+async\s+function\s+getSalesSummary\s*\(/,
    'agentsApi.ts deve exportar getSalesSummary',
  )
  // getSalesSummary deve consultar a view v_dia_sales_summary via .from(...)
  assert.match(
    src,
    /getSalesSummary[\s\S]*?\.from\(\s*['"]v_dia_sales_summary['"]\s*\)/,
    "getSalesSummary deve selecionar de .from('v_dia_sales_summary')",
  )
})

test('AC2: agentsApi.ts le da view v_dia_sales_trend com helper getSalesTrend', () => {
  const src = read(API_PATH)
  assert.match(
    src,
    /export\s+async\s+function\s+getSalesTrend\s*\(/,
    'agentsApi.ts deve exportar getSalesTrend',
  )
  assert.match(
    src,
    /getSalesTrend[\s\S]*?\.from\(\s*['"]v_dia_sales_trend['"]\s*\)/,
    "getSalesTrend deve selecionar de .from('v_dia_sales_trend')",
  )
})

test('AC2: a secao de Vendas do agentsApi NAO faz escrita (rpc/insert/update/delete)', () => {
  const src = read(API_PATH)
  // Escopo: do header "Vendas / Fast BI" ate o proximo header de secao.
  const start = src.indexOf('Vendas / Fast BI')
  assert.ok(start !== -1, 'deve existir a secao "Vendas / Fast BI" no agentsApi.ts')
  // Proximo header de secao apos vendas (decisao via ops-api).
  const end = src.indexOf('Decisão (escrita) via ops-api', start)
  assert.ok(end !== -1, 'deve haver uma proxima secao apos Vendas / Fast BI')
  const salesSection = src.slice(start, end)
  for (const writeOp of ['.rpc(', '.insert(', '.update(', '.delete(']) {
    assert.ok(
      !salesSection.includes(writeOp),
      `a secao de Vendas e read-only: nao deve conter ${writeOp} (canal de escrita)`,
    )
  }
  // Tambem nao deve existir nenhum helper de escrita de vendas em todo o arquivo.
  for (const token of ['create_sale', 'update_sale', 'delete_sale']) {
    assert.ok(
      !src.includes(token),
      `agentsApi.ts nao deve referenciar ${token} (dashboard de vendas e somente leitura)`,
    )
  }
})

// ── AC: a tela existe e esta conectada aos helpers/widgets corretos ───────────
test('SalesDashboard.tsx existe e exporta default function SalesDashboard', () => {
  assert.ok(existsSync(resolve(ROOT, SCREEN_PATH)), `${SCREEN_PATH} deve existir`)
  const src = read(SCREEN_PATH)
  assert.match(
    src,
    /export\s+default\s+function\s+SalesDashboard\s*\(/,
    'SalesDashboard.tsx deve ter `export default function SalesDashboard`',
  )
})

test('SalesDashboard.tsx importa getSalesSummary/getSalesTrend do agentsApi e os widgets', () => {
  const src = read(SCREEN_PATH)
  for (const fn of ['getSalesSummary', 'getSalesTrend']) {
    assert.ok(
      src.includes(fn),
      `SalesDashboard.tsx deve importar/usar ${fn} do agentsApi`,
    )
  }
  assert.match(
    src,
    /from\s+['"]@\/portal\/lib\/agentsApi['"]/,
    'os helpers de vendas devem vir de @/portal/lib/agentsApi',
  )
  // Widgets de apresentacao reusados.
  assert.ok(src.includes('ChartCard'), 'deve importar/usar ChartCard')
  assert.ok(src.includes('KpiCard'), 'deve importar/usar KpiCard')
  assert.ok(src.includes('ScreenShell'), 'deve importar/usar ScreenShell')
  // Issue #54: os KPI cards passaram a usar formatBRLKpi (sem R$/decimais).
  assert.match(
    src,
    /import\s*\{[^}]*\bformatBRLKpi\b[^}]*\}\s*from\s*['"]\.\/format['"]/,
    'deve importar formatBRLKpi de ./format (KPI cards, issue #54)',
  )
})

// ── AC: registry mapeia dia-sales -> import lazy de SalesDashboard ────────────
test('registry.ts mapeia dia-sales -> import lazy de SalesDashboard', () => {
  const src = read(REGISTRY_PATH)
  assert.match(
    src,
    /['"]dia-sales['"]\s*:\s*lazy\([\s\S]*?SalesDashboard/,
    "registry.ts deve mapear 'dia-sales' -> import lazy de SalesDashboard",
  )
})

// ── AC3: KPI cards do mes (unidades/receita/margem/dias; moeda via formatBRL) ─
test('AC3: KPI cards de unidades VN/VU/total + dias para vender', () => {
  const src = read(SCREEN_PATH)
  for (const label of ['Unidades VN', 'Unidades VU', 'Unidades total', 'Dias p/ vender']) {
    assert.ok(
      src.includes(label),
      `deve haver um KpiCard com label "${label}"`,
    )
  }
  // As unidades vem dos KPIs calculados (nao texto fixo).
  for (const value of ['kpis.vnUnits', 'kpis.vuUnits', 'kpis.totalUnits', 'kpis.avgDaysToSell']) {
    assert.ok(
      src.includes(value),
      `o KPI deve usar o valor calculado ${value}`,
    )
  }
})

test('AC3: KPI cards de receita VN/VU/total e margem formatados via formatBRLKpi', () => {
  const src = read(SCREEN_PATH)
  for (const label of ['Receita VN', 'Receita VU', 'Receita total', 'Margem média']) {
    assert.ok(
      src.includes(label),
      `deve haver um KpiCard com label "${label}"`,
    )
  }
  // Issue #54: cada valor monetario/margem de KPI card passa por formatBRLKpi(...)
  // (sem R$/decimais). Tabelas/tooltips agora tambem usam formatBRLKpi.
  for (const expr of [
    'formatBRLKpi(kpis.vnRevenue)',
    'formatBRLKpi(kpis.vuRevenue)',
    'formatBRLKpi(kpis.totalRevenue)',
    'formatBRLKpi(kpis.avgMargin)',
  ]) {
    assert.ok(
      src.includes(expr),
      `receita/margem deve ser formatada via ${expr}`,
    )
  }
})

test('AC3: os KPIs sao escopados ao mes selecionado (selectedMonth), nao all-time', () => {
  const src = read(SCREEN_PATH)
  // Deve existir o seletor de mes (selectedMonth, default no mes mais recente).
  assert.ok(
    src.includes('selectedMonth'),
    'SalesDashboard.tsx deve usar o mes selecionado (token selectedMonth)',
  )
  // E a memo de KPIs deve filtrar pelo mes selecionado — remover esse filtro
  // (KPIs all-time) deve quebrar este teste.
  assert.match(
    src,
    /const kpis[\s\S]*?r\.period_month\s*===\s*selectedMonth/,
    'a memo kpis deve filtrar por r.period_month === selectedMonth (KPIs do mes, nao all-time)',
  )
})

// ── AC4: linha VN×VU agregada do summary por period_month × condition ─────────
test('AC4: a linha VN×VU e derivada do summary (agrega por period_month x condition), nao da trend', () => {
  const src = read(SCREEN_PATH)
  // O ChartCard de linha existe e usa o eixo period.
  assert.ok(src.includes('type="line"'), 'deve existir um ChartCard type="line"')
  assert.ok(src.includes('xKey="period"'), 'o grafico de linha deve usar xKey="period"')
  // As duas series VN/VU.
  assert.match(
    src,
    /series=\{\[[\s\S]*?key:\s*['"]novo['"][\s\S]*?key:\s*['"]usado['"][\s\S]*?\]\}/,
    "o grafico de linha deve ter as series 'novo' e 'usado'",
  )
  // A memo da linha agrega por mes (byMonth) e ramifica por condicao (isVN/condition),
  // produzindo trendData — provando agregacao do summary, nao bind direto da trend.
  assert.ok(
    src.includes('const trendData'),
    'deve haver uma memo trendData que monta a serie da linha',
  )
  assert.ok(
    src.includes('byMonth'),
    'trendData deve agrupar por mes (mapa byMonth) — agregacao do summary',
  )
  assert.match(
    src,
    /trendData[\s\S]*?period_month/,
    'a agregacao deve usar period_month do summary',
  )
  assert.ok(
    src.includes('isVN(r.condition)'),
    'a agregacao deve ramificar pela coluna condition via isVN(r.condition) — prova o split VN/VU',
  )
  // E o data do grafico de linha deve ser o array agregado trendData, nao a trend crua.
  assert.match(
    src,
    /type="line"[\s\S]*?data=\{trendData\}/,
    'o grafico de linha deve ser alimentado por trendData (array agregado), nao pelas linhas cruas da view trend',
  )
})

// ── AC5: barras por marca + pizza do mix novos x usados ───────────────────────
test('AC5: ChartCard de barras de vendas por marca', () => {
  const src = read(SCREEN_PATH)
  assert.ok(src.includes('type="bar"'), 'deve existir um ChartCard type="bar"')
  assert.ok(src.includes('xKey="brand"'), 'o grafico de barras deve usar xKey="brand"')
  assert.match(
    src,
    /type="bar"[\s\S]*?data=\{byBrandData\}/,
    'o grafico de barras deve ser alimentado por byBrandData (unidades por marca)',
  )
  // Edge case: linhas com brand nulo devem cair num rotulo de fallback.
  assert.ok(
    src.includes("'Sem marca'"),
    "a agregacao por marca deve ter fallback 'Sem marca' quando r.brand e null",
  )
})

test('AC5: ChartCard de pizza com o mix Novos x Usados', () => {
  const src = read(SCREEN_PATH)
  assert.ok(src.includes('type="pie"'), 'deve existir um ChartCard type="pie"')
  assert.ok(src.includes('xKey="label"'), 'o grafico de pizza deve usar xKey="label"')
  assert.match(
    src,
    /type="pie"[\s\S]*?data=\{mixData\}/,
    'o grafico de pizza deve ser alimentado por mixData (mix novos x usados)',
  )
  // mixData deve conter as duas fatias Novos/Usados.
  assert.ok(
    src.includes('Novos (VN)') && src.includes('Usados (VU)'),
    'mixData deve ter as fatias "Novos (VN)" e "Usados (VU)"',
  )
})

// ── AC6: drill-down por marca e loja via estado, com opcao "todas" ────────────
test('AC6: drill-down por marca e loja via dois <select> com sentinela ALL e setters de estado', () => {
  const src = read(SCREEN_PATH)
  // Dois seletores na UI.
  const selectMatches = src.match(/<select\b/g) ?? []
  assert.ok(
    selectMatches.length >= 2,
    `devem existir ao menos 2 <select> (marca e loja); encontrados ${selectMatches.length}`,
  )
  // Sentinela "todas".
  assert.ok(
    src.includes("'__all__'"),
    "deve haver a sentinela ALL = '__all__' para a opcao 'todas'",
  )
  // Setters de estado React.
  for (const setter of ['setBrand', 'setStore']) {
    assert.ok(
      src.includes(setter),
      `deve haver o setter de estado ${setter} (drill-down controlado por estado)`,
    )
  }
  // O recorte filtrado deve respeitar a sentinela ALL (nao filtra quando "todas").
  assert.match(
    src,
    /brand\s*===\s*ALL\s*\|\|\s*r\.brand\s*===\s*brand/,
    'o filtro de marca deve ignorar o recorte quando brand === ALL',
  )
  assert.match(
    src,
    /store\s*===\s*ALL\s*\|\|\s*r\.store\s*===\s*store/,
    'o filtro de loja deve ignorar o recorte quando store === ALL',
  )
})

test('AC6: KPIs e graficos derivam do recorte filtrado (filtros afetam tudo)', () => {
  const src = read(SCREEN_PATH)
  // O array `filtered` alimenta KPIs e as tres memos de grafico — prova que os
  // seletores filtram tanto cartoes quanto graficos.
  assert.ok(src.includes('const filtered'), 'deve existir o recorte filtrado `filtered`')
  for (const memo of ['kpis', 'trendData', 'byBrandData', 'mixData']) {
    assert.match(
      src,
      new RegExp(`const ${memo}[\\s\\S]*?filtered`),
      `${memo} deve ser calculado a partir de \`filtered\` (afetado pelos seletores)`,
    )
  }
})
