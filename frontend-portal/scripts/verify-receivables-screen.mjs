// Verificacao dependency-free da tela Contas a Receber / Fast BI (agente
// collections-prioritizer).
//
// Ambiente OFFLINE sem runner instalavel: usamos apenas modulos nativos do Node
// (node:test, node:assert, node:fs) para assertar — lendo os arquivos-fonte como
// texto — que ReceivablesBI.tsx, o agentsApi, o registry, o menu e os dois
// bundles i18n satisfazem o contrato da tela. Segue o padrao do repo
// (ver verify-service-dashboard.mjs / verify-parts-bi.mjs).
//
// Roda com: node --test scripts/verify-receivables-screen.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SCREEN_PATH = 'src/portal/renderers/screens/ReceivablesBI.tsx'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

function readJson(relPath) {
  return JSON.parse(read(relPath))
}

// AC: Tela existe e e um componente default.
test('AC: ReceivablesBI.tsx existe e exporta default a funcao ReceivablesBI', () => {
  const src = read(SCREEN_PATH)
  assert.match(
    src,
    /export\s+default\s+function\s+ReceivablesBI\s*\(/,
    'ReceivablesBI.tsx deve ter `export default function ReceivablesBI(...)`',
  )
})

// AC: dados vem de getReceivables() — fonte real (view), nao mock embutido.
test('AC: le os dados de getReceivables (data wiring, nao mock hardcoded)', () => {
  const src = read(SCREEN_PATH)
  assert.match(
    src,
    /import\s*\{[^}]*\bgetReceivables\b[^}]*\}\s*from\s*['"]@\/portal\/lib\/agentsApi['"]/,
    'ReceivablesBI.tsx deve importar getReceivables de @/portal/lib/agentsApi',
  )
  assert.match(
    src,
    /getReceivables\s*\(\s*\)/,
    'ReceivablesBI.tsx deve chamar getReceivables() para carregar os dados',
  )
  assert.ok(
    !/const\s+MOCK_\w*/i.test(src) && !/const\s+\w*receivables?\s*=\s*\[\s*\{/i.test(src),
    'ReceivablesBI.tsx nao deve embutir uma lista mock de titulos',
  )
})

// AC: agentsApi expoe getReceivables lendo a view v_dia_receivable_current.
test('AC: agentsApi.getReceivables le v_dia_receivable_current (mesma fonte do agente)', () => {
  const api = read('src/portal/lib/agentsApi.ts')
  assert.match(
    api,
    /export\s+async\s+function\s+getReceivables\s*\(/,
    'agentsApi.ts deve exportar getReceivables',
  )
  assert.match(
    api,
    /from\(\s*['"]v_dia_receivable_current['"]\s*\)/,
    'getReceivables deve ler a view v_dia_receivable_current',
  )
  // So titulos em aberto sao priorizados/exibidos.
  assert.match(
    api,
    /\.eq\(\s*['"]status['"]\s*,\s*['"]aberto['"]\s*\)/,
    "getReceivables deve filtrar status='aberto'",
  )
})

// AC: KPIs via i18n + KpiCard; total vencido formatado com formatBRLKpi.
test('AC: KPIs usam o namespace i18n screens.receivablesBI e o primitivo KpiCard', () => {
  const src = read(SCREEN_PATH)
  assert.match(
    src,
    /useTranslations\(\s*['"]screens\.receivablesBI['"]\s*\)/,
    "deve usar useTranslations('screens.receivablesBI')",
  )
  for (const key of ['openTotal', 'overdueTotal', 'customers', 'titles', 'maxDaysOverdue']) {
    assert.ok(src.includes(`t('${key}')`), `o KPI t('${key}') deve ser renderizado`)
  }
  assert.match(src, /<KpiCard\b/, 'os indicadores devem usar o primitivo KpiCard')
  const overdueCard = src.match(
    /<KpiCard\b(?:(?!<KpiCard)[\s\S])*?label=\{t\('overdueTotal'\)\}(?:(?!<KpiCard)[\s\S])*?\/>/,
  )
  assert.ok(overdueCard, "deve existir um <KpiCard label={t('overdueTotal')} .../>")
  assert.match(
    overdueCard[0],
    /formatBRLKpi\(/,
    'o KpiCard "Total vencido" deve formatar seu valor com formatBRLKpi',
  )
})

// AC: Grafico 1 — exposicao por faixa de atraso (ChartCard bar, xKey="bucket", currency).
test('AC: grafico de aging e um ChartCard type="bar" xKey="bucket" currency', () => {
  const src = read(SCREEN_PATH)
  const agingCard = src.match(/<ChartCard\b(?:(?!<ChartCard)[\s\S])*?xKey="bucket"(?:(?!<ChartCard)[\s\S])*?\/>/)
  assert.ok(agingCard, 'deve existir um <ChartCard ... xKey="bucket" .../>')
  assert.match(agingCard[0], /type="bar"/, 'o grafico de aging deve ser do tipo "bar"')
  assert.match(agingCard[0], /valueFormat="currency"/, "aging deve usar valueFormat='currency'")
  assert.match(agingCard[0], /key:\s*'exposure'/, "aging deve plotar a serie 'exposure'")
})

// AC: Grafico 2 — top clientes por exposicao vencida (ChartCard bar, xKey="customer").
test('AC: grafico de top clientes e um ChartCard type="bar" xKey="customer"', () => {
  const src = read(SCREEN_PATH)
  const custCard = src.match(/<ChartCard\b(?:(?!<ChartCard)[\s\S])*?xKey="customer"(?:(?!<ChartCard)[\s\S])*?\/>/)
  assert.ok(custCard, 'deve existir um <ChartCard ... xKey="customer" .../>')
  assert.match(custCard[0], /type="bar"/, 'o grafico de clientes deve ser do tipo "bar"')
})

// AC: derivacoes leem os campos-fonte corretos da view.
test('AC: ReceivablesBI.tsx referencia os campos days_overdue e balance', () => {
  const src = read(SCREEN_PATH)
  assert.match(src, /\bdays_overdue\b/, 'as derivacoes de aging/atraso devem ler days_overdue')
  assert.match(src, /\bbalance\b/, 'as derivacoes de exposicao devem ler balance')
})

// AC: Registro no registry — componentKey dia-receivables -> lazy(ReceivablesBI).
test('AC: registry.ts mapeia dia-receivables -> import lazy de ReceivablesBI', () => {
  const registry = read('src/portal/renderers/registry.ts')
  assert.match(
    registry,
    /['"]dia-receivables['"]\s*:\s*lazy\([\s\S]*?ReceivablesBI/,
    "registry.ts deve mapear 'dia-receivables' -> import lazy de ReceivablesBI",
  )
})

// AC: Item de menu "Contas a Receber" -> dia-receivables dentro do grupo fast-bi.
test('AC: portalApi.ts tem item "Contas a Receber" -> dia-receivables no grupo fast-bi', () => {
  const portalApi = read('src/portal/lib/portalApi.ts')
  assert.match(portalApi, /text:\s*'Contas a Receber'/, "deve haver item text: 'Contas a Receber'")
  assert.match(
    portalApi,
    /componentKey:\s*'dia-receivables'/,
    "o item deve apontar componentKey: 'dia-receivables'",
  )
  const biGroupIdx = portalApi.indexOf("id: 'fast-bi'")
  const itemIdx = portalApi.indexOf("id: 'fast-bi-receivables'")
  const keyIdx = portalApi.indexOf("componentKey: 'dia-receivables'")
  assert.ok(biGroupIdx !== -1, "deve existir o grupo id: 'fast-bi'")
  assert.ok(itemIdx !== -1, "deve existir o item id: 'fast-bi-receivables'")
  assert.ok(
    biGroupIdx < itemIdx && itemIdx < keyIdx,
    "o item deve estar dentro do grupo 'fast-bi' (grupo precede item, que precede seu componentKey)",
  )
})

// AC: i18n — bloco screens.receivablesBI presente e em paridade pt-BR/en-US.
test('AC: i18n screens.receivablesBI existe em pt-BR e en-US com as mesmas chaves', () => {
  const pt = readJson('src/i18n/messages/pt-BR.json')
  const en = readJson('src/i18n/messages/en-US.json')
  const ptBlock = pt?.screens?.receivablesBI
  const enBlock = en?.screens?.receivablesBI
  assert.ok(ptBlock, 'pt-BR deve ter screens.receivablesBI')
  assert.ok(enBlock, 'en-US deve ter screens.receivablesBI')
  assert.deepEqual(
    Object.keys(ptBlock).sort(),
    Object.keys(enBlock).sort(),
    'screens.receivablesBI deve ter as mesmas chaves em pt-BR e en-US',
  )
  // O item de menu tambem precisa de rotulo nos dois bundles.
  assert.ok(pt?.menu?.['fast-bi-receivables'], "pt-BR deve rotular menu 'fast-bi-receivables'")
  assert.ok(en?.menu?.['fast-bi-receivables'], "en-US deve rotular menu 'fast-bi-receivables'")
})

// Non-regression: tela read-only, compoe ChartCard/KpiCard, sem recharts direto.
test('Non-regression: tela e read-only e compoe ChartCard/KpiCard', () => {
  const src = read(SCREEN_PATH)
  assert.ok(!/\.rpc\s*\(/.test(src), 'ReceivablesBI.tsx e read-only: nao deve chamar supabase.rpc')
  assert.match(
    src,
    /import\s*\{[^}]*\bChartCard\b[^}]*\}\s*from\s*['"]\.\/ChartCard['"]/,
    'deve reusar o widget ChartCard',
  )
  assert.match(
    src,
    /import\s*\{[^}]*\bKpiCard\b[^}]*\}\s*from\s*['"]\.\/ui['"]/,
    'deve reusar o primitivo KpiCard',
  )
  assert.ok(!/from\s+['"]recharts['"]/.test(src), 'nao deve importar recharts direto (usa ChartCard)')
})
