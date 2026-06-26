// Verificacao dependency-free do "Dar vida ao Painel Executivo" — Issue #78,
// spec docs/specs/78-dar-vida-ao-painel-executivo.md.
//
// Ambiente OFFLINE sem runner instalavel (sem vitest/testing-library): seguimos
// o padrao estabelecido do repo (ver verify-owner-overview.mjs, verify-kpi-format.mjs,
// verify-i18n-parity.mjs): assercoes ESTRUTURAIS sobre o texto-fonte para
// wiring/contratos, parsing real dos JSONs i18n para paridade. Onde a logica e
// pura e exportada, importamos e EXECUTAMOS o modulo TS (via --experimental-strip-types).
//
// Roda com: node --test --experimental-strip-types scripts/verify-executive-pack.mjs
//
// Rastreabilidade dos criterios de aceite:
//  AC1/AC-primitivos -> exports + contratos de TrendBadge/Sparkline/ProgressBar/KpiCard
//  AC2 (retrocompat)  -> props novas opcionais em KpiCard
//  AC3 (interacoes)   -> wiring de ExecutivePack (helpers, ChartCards, drills, risco)
//  AC4 (currency)     -> formatBRLKpi + legend "Valores em R$"
//  AC5 (i18n)         -> paridade das chaves novas em ambas as locales

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SCREENS = 'src/portal/renderers/screens'

const UI_PATH = `${SCREENS}/ui.tsx`
const PACK_PATH = `${SCREENS}/ExecutivePack.tsx`
const PT_PATH = 'src/i18n/messages/pt-BR.json'
const EN_PATH = 'src/i18n/messages/en-US.json'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// Recorta a fonte de uma funcao/componente exportado por nome ate o proximo
// `export function`/`export const` no nivel de modulo. Permite assertar sobre o
// corpo de UM primitivo sem que matches de outro vazem o resultado.
function sliceExport(src, name) {
  const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`)
  const m = re.exec(src)
  assert.ok(m, `nao encontrei o export de ${name}`)
  const start = m.index
  const rest = src.slice(start + m[0].length)
  const next = /\n\s*export\s+(?:async\s+)?(?:function|const)\s+\w/.exec(rest)
  return rest.slice(0, next ? next.index : rest.length)
}

// ── AC1: Primitivos exportados ──────────────────────────────────────────────

test('AC1: ui.tsx exporta TrendBadge, Sparkline, ProgressBar e mantem KpiCard', () => {
  const src = read(UI_PATH)
  for (const name of ['TrendBadge', 'Sparkline', 'ProgressBar', 'KpiCard']) {
    assert.match(
      src,
      new RegExp(`export\\s+function\\s+${name}\\s*\\(`),
      `ui.tsx deve ter "export function ${name}("`,
    )
  }
})

// ── AC2: KpiCard retrocompativel (props novas OPCIONAIS) ─────────────────────

test('AC2: KpiCard adiciona accent/trend/sparkline como props OPCIONAIS', () => {
  const body = sliceExport(read(UI_PATH), 'KpiCard')
  // As tres props novas devem aparecer com o marcador de opcional `?:` no tipo
  // do parametro do KpiCard — garante retrocompat (chamadas legadas sem elas
  // continuam type-checking). Um `:` sem `?` quebraria os ~6 dashboards.
  for (const prop of ['accent', 'trend', 'sparkline']) {
    assert.match(
      body,
      new RegExp(`\\b${prop}\\?\\s*:`),
      `KpiCard deve declarar '${prop}' como prop opcional (${prop}?:)`,
    )
  }
  // label/value continuam OBRIGATORIOS (sem `?`) — pega regressao que os afrouxe.
  assert.match(body, /\blabel\s*:/, 'KpiCard deve manter label obrigatorio')
  assert.match(body, /\bvalue\s*:/, 'KpiCard deve manter value obrigatorio')
  // E `accent` deve ter default 'neutral' para preservar a aparencia legada.
  assert.match(body, /accent\s*=\s*['"]neutral['"]/, "accent deve ter default 'neutral'")
})

test('AC2: chamadas legadas de KpiCard (sem props novas) seguem validas', () => {
  // Prova concreta de retrocompat: uma tela legada (DiaOverview) usa <KpiCard
  // label= value= hint= /> SEM accent/trend/sparkline. Se as props novas fossem
  // obrigatorias, essa chamada nao compilaria. Asserta que a chamada existe
  // assim como esta (props opcionais => continua valida).
  const src = read(`${SCREENS}/DiaOverview.tsx`)
  assert.match(src, /<KpiCard\b/, 'DiaOverview deve continuar usando <KpiCard>')
  // Pelo menos uma instancia sem nenhuma das props novas (legada).
  const calls = src.match(/<KpiCard[\s\S]*?\/>/g) ?? []
  assert.ok(calls.length > 0, 'DiaOverview deve ter ao menos uma chamada de KpiCard')
  const legacy = calls.some(
    (c) => !/\baccent=/.test(c) && !/\btrend=/.test(c) && !/\bsparkline=/.test(c),
  )
  assert.ok(legacy, 'deve existir ao menos uma chamada legada de KpiCard sem accent/trend/sparkline')
})

// ── AC1: Contratos estruturais dos primitivos ───────────────────────────────

test('AC1: Sparkline renderiza <polyline> SVG e NAO importa recharts', () => {
  const src = read(UI_PATH)
  // Sem import de recharts em ui.tsx (sparkline e SVG puro, por design da spec).
  // Casa apenas o import real, nao mencoes em comentarios.
  assert.ok(
    !/from\s*['"]recharts['"]/.test(src),
    "ui.tsx NAO deve importar de 'recharts' (Sparkline e SVG puro)",
  )
  const body = sliceExport(src, 'Sparkline')
  assert.match(body, /<svg\b/, 'Sparkline deve renderizar um <svg>')
  assert.match(body, /<polyline\b/, 'Sparkline deve renderizar um <polyline>')
  // Constroi os pontos a partir do array de numeros (normalizacao min/max).
  assert.match(body, /points=/, 'Sparkline deve passar `points` ao polyline')
  // Guarda contra < 2 pontos (nao renderiza linha degenerada).
  assert.match(body, /length\s*<\s*2/, 'Sparkline deve retornar nada com < 2 pontos')
})

test('AC1: ProgressBar auto-tona por limiares (<60 success, 60-85 warning, >85 danger)', () => {
  const body = sliceExport(read(UI_PATH), 'ProgressBar')
  // Os tres limiares devem estar presentes na logica de auto-tom.
  assert.match(body, /\b85\b/, 'ProgressBar deve usar o limiar 85 (>85 danger)')
  assert.match(body, /\b60\b/, 'ProgressBar deve usar o limiar 60 (60-85 warning)')
  // Mapeia para os tres tons semanticos.
  for (const tone of ['success', 'warning', 'danger']) {
    assert.ok(body.includes(tone), `ProgressBar deve referenciar o tom '${tone}'`)
  }
  // A largura do preenchimento deve ser dirigida pelo valor (0..100), nao fixa.
  assert.match(body, /width:\s*`\$\{[^}]*\}%`/, 'ProgressBar deve dirigir a largura pelo valor (width: `${v}%`)')
  // Permite override explicito de tom (tone ?? autoTone).
  assert.match(body, /tone\s*\?\?/, 'ProgressBar deve permitir override de tom (tone ?? autoTone)')
})

test('AC1: TrendBadge colore por sinal do delta (ganho=success, perda=destructive)', () => {
  const body = sliceExport(read(UI_PATH), 'TrendBadge')
  // Ramo de ganho -> text-success ; ramo de perda -> text-destructive.
  assert.match(body, /delta\s*>\s*0/, 'TrendBadge deve detectar ganho (delta > 0)')
  assert.match(body, /delta\s*<\s*0/, 'TrendBadge deve detectar perda (delta < 0)')
  assert.match(body, /text-success/, 'ganho deve usar text-success')
  assert.match(body, /text-destructive/, 'perda deve usar text-destructive (danger)')
  // Neutro/nulo cai num placeholder, nao colorido por sinal.
  assert.match(body, /text-muted-foreground/, 'neutro/nulo deve usar tom neutro (muted)')
  // Icone direcional ▲/▼ por sinal (TrendingUp/TrendingDown da lucide).
  assert.match(body, /TrendingDown/, 'TrendBadge deve usar TrendingDown na perda')
  assert.match(body, /TrendingUp/, 'TrendBadge deve usar TrendingUp no ganho/neutro')
})

// ── AC3: Wiring de ExecutivePack ─────────────────────────────────────────────

test('AC3: ExecutivePack consome os helpers existentes do agentsApi', () => {
  const src = read(PACK_PATH)
  assert.match(src, /from\s*['"]@\/portal\/lib\/agentsApi['"]/, 'deve importar de @/portal/lib/agentsApi')
  for (const fn of ['getSalesTrend', 'getFindings', 'getOwnerBriefByBrand', 'getOwnerKpis', 'getAgentStatus']) {
    // Importado E chamado (não basta importar): cada helper aparece numa chamada `fn(`.
    assert.ok(
      new RegExp(`\\b${fn}\\b`).test(src),
      `ExecutivePack deve referenciar ${fn}`,
    )
    assert.match(
      src,
      new RegExp(`${fn}\\s*\\(`),
      `ExecutivePack deve CHAMAR ${fn}(...)`,
    )
  }
  // findings limitado a 6 (top 6 por delta, por spec).
  assert.match(src, /getFindings\(\s*\{\s*limit:\s*6\s*\}\s*\)/, "getFindings deve ser chamado com { limit: 6 }")
})

test('AC3: importa os primitivos novos de ./ui', () => {
  const src = read(PACK_PATH)
  for (const name of ['TrendBadge', 'Sparkline', 'ProgressBar', 'KpiCard']) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(src),
      `ExecutivePack deve importar/usar ${name} de ./ui`,
    )
  }
})

test('AC3: ChartCards — receita 90d (line/sale_date) + resultado por marca (bar/brand_name)', () => {
  const src = read(PACK_PATH)
  const usages = src.match(/<ChartCard\b/g) ?? []
  assert.ok(usages.length >= 2, `deve renderizar >=2 <ChartCard>, encontrou ${usages.length}`)
  // Linha de receita: type="line" com xKey="sale_date" (serie de getSalesTrend).
  assert.match(
    src,
    /<ChartCard\b[\s\S]*?type="line"[\s\S]*?xKey="sale_date"|<ChartCard\b[\s\S]*?xKey="sale_date"[\s\S]*?type="line"/,
    'deve haver ChartCard type="line" com xKey="sale_date" (receita 90d)',
  )
  // Barra de resultado por marca: type="bar" com xKey="brand_name".
  assert.match(
    src,
    /<ChartCard\b[\s\S]*?type="bar"[\s\S]*?xKey="brand_name"|<ChartCard\b[\s\S]*?xKey="brand_name"[\s\S]*?type="bar"/,
    'deve haver ChartCard type="bar" com xKey="brand_name" (resultado por marca)',
  )
  // As series devem apontar para colunas reais consumidas (pega renome quebrado).
  assert.match(src, /key:\s*['"]revenue['"]/, "series de receita deve usar key: 'revenue'")
  assert.match(src, /key:\s*['"]resultado['"]/, "series de marca deve usar key: 'resultado'")
})

test("AC3: linhas de findings dao drill para 'finding-detail' com params.findingId", () => {
  const src = read(PACK_PATH)
  assert.match(src, /componentKey:\s*['"]finding-detail['"]/, "deve abrir componentKey 'finding-detail'")
  // O openWindow do finding deve passar findingId no params (ligado ao id da linha).
  assert.match(
    src,
    /componentKey:\s*['"]finding-detail['"][\s\S]*?params:\s*\{[\s\S]*?findingId/,
    "o openWindow de finding-detail deve passar params.findingId",
  )
  // O clique da linha esta ligado a uma chamada de openWindow (drill real, nao decorativo).
  assert.match(src, /onClick=\{\s*\(\)\s*=>\s*openFinding\(/, 'a linha de finding deve disparar openFinding no clique')
  assert.match(src, /openWindow\(/, 'deve usar openWindow do portalStore')
})

test("AC3: linhas de agente dao drill para 'findings-queue' com params.agentKey", () => {
  const src = read(PACK_PATH)
  assert.match(src, /componentKey:\s*['"]findings-queue['"]/, "deve abrir componentKey 'findings-queue'")
  assert.match(
    src,
    /componentKey:\s*['"]findings-queue['"][\s\S]*?params:\s*\{[\s\S]*?agentKey/,
    "o openWindow de findings-queue deve passar params.agentKey",
  )
  // A linha do agente dispara o drill no clique.
  assert.match(src, /onClick=\{\s*\(\)\s*=>\s*openAgentQueue\(/, 'a linha de agente deve disparar openAgentQueue no clique')
})

test('AC3: faixa de risco soma fp_*_at_risk e le parts_critical_count (NAO soma group-wide)', () => {
  const src = read(PACK_PATH)
  // Soma somavel por marca: fp_units_at_risk e fp_value_at_risk.
  assert.match(src, /fp_units_at_risk/, 'risco deve somar fp_units_at_risk')
  assert.match(src, /fp_value_at_risk/, 'risco deve somar fp_value_at_risk')
  assert.match(
    src,
    /\.reduce\([\s\S]*?fp_value_at_risk/,
    'fp_value_at_risk deve ser somado via reduce sobre as marcas',
  )
  // Pecas criticas vem de getOwnerKpis (campo unico, nao somado).
  assert.match(src, /parts_critical_count/, 'risco deve ler parts_critical_count de ownerKpis')
  // GOTCHA da spec: NAO somar campos group-wide repetidos por marca.
  assert.ok(!/reduce\([^)]*pecas_value/.test(src), 'NAO deve somar pecas_value group-wide')
  assert.ok(!/reduce\([^)]*\bat_value\b/.test(src), 'NAO deve somar at_value group-wide')
  // A faixa so aparece quando ha risco (render condicional).
  assert.match(src, /hasRisk\s*&&/, 'a faixa de risco deve renderizar so quando hasRisk')
})

// ── AC4: Currency limpa + legenda preservadas ────────────────────────────────

test('AC4: KPIs de dinheiro usam formatBRLKpi e a legenda "Valores em R$" vai ao ScreenShell', () => {
  const src = read(PACK_PATH)
  assert.match(
    src,
    /import\s*\{[^}]*\bformatBRLKpi\b[^}]*\}\s*from\s*['"]\.\/format['"]/,
    "deve importar formatBRLKpi de './format'",
  )
  assert.match(src, /formatBRLKpi\(/, 'os KPI de dinheiro devem usar formatBRLKpi(...)')
  // Percentuais via formatPct (nao reimplementa).
  assert.match(src, /formatPct\(/, 'percentuais devem usar formatPct(...)')
  // A legenda de denominacao e passada ao ScreenShell (prop legend), vinda do i18n.
  assert.match(
    src,
    /<ScreenShell\b[\s\S]*?legend=\{[\s\S]*?\}/,
    'ScreenShell deve receber a prop legend',
  )
  assert.match(src, /legend=\{common\('valuesInBRL'\)\}/, "legend deve vir de common('valuesInBRL')")
})

test('AC4: valor monetario NAO usa simbolo R$ hard-coded no JSX (so via formatadores)', () => {
  const src = read(PACK_PATH)
  // O literal "Valores em R$" so existe na constante de referencia (linha de doc),
  // nao como string de UI hard-coded — a legenda real vem do i18n. Garante que
  // nao ha valores monetarios escritos com "R$ " no JSX.
  assert.ok(
    !/>\s*R\$\s*\{/.test(src),
    'nao deve haver "R$ {...}" hard-coded no JSX (use formatBRLKpi/formatBRL)',
  )
})

// ── AC5: Paridade i18n das chaves novas ──────────────────────────────────────

const NEW_KEYS = [
  'revenueTrendTitle',
  'revenue',
  'units',
  'resultByBrandTitle',
  'result',
  'aiFoundTitle',
  'aiFoundSubtitle',
  'noFindings',
  'atRiskTitle',
  'floorPlanAtRisk',
  'criticalParts',
  'byAgentTitle',
  'pending',
  'identified',
  'runHealth',
]

function execPack(locale) {
  const json = JSON.parse(read(locale === 'pt' ? PT_PATH : EN_PATH))
  const node = json?.screens?.executivePack
  assert.ok(node && typeof node === 'object', `screens.executivePack deve existir em ${locale}`)
  return node
}

test('AC5: as chaves novas de screens.executivePack existem em pt-BR E en-US, nao vazias', () => {
  const pt = execPack('pt')
  const en = execPack('en')
  for (const key of NEW_KEYS) {
    for (const [loc, node] of [['pt-BR', pt], ['en-US', en]]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(node, key),
        `${loc}: screens.executivePack.${key} ausente`,
      )
      assert.equal(typeof node[key], 'string', `${loc}: screens.executivePack.${key} deve ser string`)
      assert.ok(node[key].trim().length > 0, `${loc}: screens.executivePack.${key} nao pode ser vazia`)
    }
  }
})

test('AC5: pt-BR e en-US tem exatamente o mesmo conjunto de chaves em screens.executivePack', () => {
  const pt = Object.keys(execPack('pt')).sort()
  const en = Object.keys(execPack('en')).sort()
  assert.deepEqual(pt, en, 'os conjuntos de chaves de screens.executivePack devem ser identicos entre locales')
})

test('AC5: traducoes pt/en divergem (nao foram coladas iguais) nas chaves de texto', () => {
  const pt = execPack('pt')
  const en = execPack('en')
  // Pelo menos os titulos de secao devem diferir entre as locales (pega
  // copy-paste que deixaria o ingles em portugues ou vice-versa).
  for (const key of ['revenueTrendTitle', 'aiFoundTitle', 'atRiskTitle', 'byAgentTitle']) {
    assert.notEqual(pt[key], en[key], `screens.executivePack.${key} deveria diferir entre pt-BR e en-US`)
  }
})
