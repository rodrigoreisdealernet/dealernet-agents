// Verificacao dependency-free do widget ChartCard (Issue #13).
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest, sem node_modules
// no worktree): usamos apenas os modulos nativos do Node (node:test, node:assert,
// node:fs) para assertar — lendo os arquivos-fonte como texto — que o widget
// ChartCard.tsx satisfaz os criterios de aceite da spec
// docs/specs/13-feat-frontend-widget-chartcard-recharts.md.
//
// Roda com: node --test scripts/verify-chartcard.mjs
//
// Este e o padrao estabelecido do repo (ver verify-vehicle-wiring.mjs): testes
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

const CHART_CARD_PATH = 'src/portal/renderers/screens/ChartCard.tsx'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// AC: Componente existe — ChartCard.tsx exporta um componente React ChartCard.
test('AC: ChartCard.tsx existe e exporta o componente ChartCard', () => {
  assert.ok(
    existsSync(resolve(ROOT, CHART_CARD_PATH)),
    `${CHART_CARD_PATH} deve existir`,
  )
  const src = read(CHART_CARD_PATH)
  assert.match(
    src,
    /export\s+function\s+ChartCard\s*\(/,
    'ChartCard.tsx deve exportar uma funcao de componente chamada ChartCard',
  )
})

// AC: Componente existe — contrato de props declarado e exportado.
test('AC: contrato de props (ChartCardProps) declara title/type/data/xKey/series/valueFormat', () => {
  const src = read(CHART_CARD_PATH)
  assert.match(
    src,
    /export\s+interface\s+ChartCardProps/,
    'ChartCardProps deve ser declarada e exportada',
  )
  for (const prop of ['title', 'type', 'data', 'xKey', 'series', 'valueFormat']) {
    assert.match(
      src,
      new RegExp(`\\b${prop}\\b\\??\\s*:`),
      `ChartCardProps deve declarar a prop "${prop}"`,
    )
  }
  // O tipo da prop `type` deve cobrir os tres tipos de grafico.
  assert.match(
    src,
    /export\s+type\s+ChartType\s*=\s*'line'\s*\|\s*'bar'\s*\|\s*'pie'/,
    "ChartType deve ser 'line' | 'bar' | 'pie'",
  )
})

// AC: Responsivo — gráfico envolvido por ResponsiveContainer com largura 100%.
test('AC: usa recharts via ResponsiveContainer com width 100%', () => {
  const src = read(CHART_CARD_PATH)
  assert.match(
    src,
    /from\s+['"]recharts['"]/,
    'ChartCard.tsx deve importar de recharts',
  )
  assert.match(
    src,
    /ResponsiveContainer/,
    'ChartCard.tsx deve envolver o grafico em ResponsiveContainer',
  )
  assert.match(
    src,
    /<ResponsiveContainer[^>]*width\s*=\s*["{]?["']?100%/,
    'ResponsiveContainer deve usar width 100% (sem largura fixa em px)',
  )
})

// AC: Três tipos de gráfico — line/bar/pie usam LineChart/BarChart/PieChart.
test('AC: suporta os tres tipos de grafico (LineChart/BarChart/PieChart)', () => {
  const src = read(CHART_CARD_PATH)
  for (const chart of ['LineChart', 'BarChart', 'PieChart']) {
    assert.ok(
      src.includes(chart),
      `ChartCard.tsx deve renderizar ${chart} do recharts`,
    )
  }
  // Deve ramificar no valor da prop `type`. A implementacao testa explicitamente
  // 'pie' e 'bar' e usa 'line' como ramo default (else) — entao exigimos os dois
  // checks explicitos e que LineChart seja o fallback renderizado apos eles.
  for (const t of ['pie', 'bar']) {
    assert.match(
      src,
      new RegExp(`type\\s*===\\s*['"]${t}['"]`),
      `ChartCard.tsx deve ramificar para type === '${t}'`,
    )
  }
  // 'line' e o tipo default: LineChart deve aparecer apos as ramificacoes de
  // pie/bar (ramo else), garantindo que type='line' cai nele.
  const pieIdx = src.indexOf("type === 'pie'")
  const barIdx = src.indexOf("type === 'bar'")
  const lineChartIdx = src.indexOf('<LineChart')
  assert.ok(pieIdx !== -1 && barIdx !== -1, 'deve haver ramos para pie e bar')
  assert.ok(
    lineChartIdx > pieIdx && lineChartIdx > barIdx,
    "LineChart deve ser o ramo default (renderizado quando type nao e 'pie' nem 'bar', i.e. 'line')",
  )
  // E 'line' deve constar como valor valido do tipo da prop.
  assert.ok(
    src.includes("'line'"),
    "ChartCard.tsx deve declarar 'line' como tipo de grafico valido",
  )
})

// AC: Três tipos de gráfico — xKey como eixo e uma série por item de `series`.
test('AC: usa xKey como eixo de categorias e desenha uma serie por item', () => {
  const src = read(CHART_CARD_PATH)
  assert.match(
    src,
    /dataKey=\{xKey\}|nameKey=\{xKey\}/,
    'xKey deve ser usado como chave de categoria (XAxis.dataKey ou Pie.nameKey)',
  )
  assert.match(
    src,
    /series\.map\(/,
    'deve iterar `series` para desenhar uma serie por item',
  )
})

// AC: Formatação de valores — reaproveita formatBRL/formatPct.
test('AC: reaproveita formatBRL/formatPct e trata currency/percent/number', () => {
  const src = read(CHART_CARD_PATH)
  assert.match(
    src,
    /import\s*\{[^}]*\bformatBRL\b[^}]*\bformatPct\b[^}]*\}\s*from\s*['"]\.\/format['"]/,
    'ChartCard.tsx deve importar formatBRL e formatPct de ./format',
  )
  // currency -> formatBRL, percent -> formatPct.
  assert.match(
    src,
    /fmt\s*===\s*['"]currency['"][\s\S]*?formatBRL/,
    "valueFormat 'currency' deve usar formatBRL",
  )
  assert.match(
    src,
    /fmt\s*===\s*['"]percent['"][\s\S]*?formatPct/,
    "valueFormat 'percent' deve usar formatPct",
  )
  // number (sem valueFormat) -> numero pt-BR cru.
  assert.match(
    src,
    /toLocaleString\(\s*['"]pt-BR['"]/,
    "valueFormat 'number' deve formatar como numero pt-BR cru",
  )
  // ValueFormat deve cobrir os tres formatos.
  assert.match(
    src,
    /export\s+type\s+ValueFormat\s*=\s*'currency'\s*\|\s*'percent'\s*\|\s*'number'/,
    "ValueFormat deve ser 'currency' | 'percent' | 'number'",
  )
})

// AC: Estado vazio — mensagem legível em text-muted-foreground quando data vazio.
test('AC: tem um ramo de estado vazio com emptyMessage em text-muted-foreground', () => {
  const src = read(CHART_CARD_PATH)
  assert.ok(
    src.includes('emptyMessage'),
    'ChartCard.tsx deve aceitar/usar a prop emptyMessage',
  )
  // Deve detectar data vazio/ausente.
  assert.match(
    src,
    /isEmpty|data\.length\s*===\s*0|!data/,
    'ChartCard.tsx deve detectar o estado vazio (data ausente ou length 0)',
  )
  // E renderizar a mensagem em text-muted-foreground (em vez de grafico em branco).
  assert.match(
    src,
    /text-muted-foreground[\s\S]*\{emptyMessage\}/,
    'o estado vazio deve renderizar emptyMessage em text-muted-foreground',
  )
})

// AC: Tema e moldura — card consistente com os primitivos existentes.
test('AC: renderiza dentro da moldura de card do DS (rounded-lg border border-border bg-card)', () => {
  const src = read(CHART_CARD_PATH)
  assert.ok(
    src.includes('rounded-lg') &&
      src.includes('border-border') &&
      src.includes('bg-card'),
    'a moldura do card deve usar rounded-lg border border-border bg-card',
  )
})

// AC: Dependência registrada — recharts em package.json dependencies.
test('AC: recharts esta em dependencies de package.json', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(
    pkg.dependencies && typeof pkg.dependencies.recharts === 'string',
    'recharts deve estar listado em dependencies de package.json',
  )
  assert.match(
    pkg.dependencies.recharts,
    /\d+\.\d+/,
    'a versao de recharts deve ser um range valido (ex.: ^2.13.0)',
  )
})

// Non-Goal: ChartCard NAO deve estar registrado no registry (e widget, nao tela).
test('Non-Goal: ChartCard NAO esta registrado no registry.ts (widget, nao tela)', () => {
  const registry = read('src/portal/renderers/registry.ts')
  assert.ok(
    !registry.includes('ChartCard'),
    'ChartCard nao deve ser registrado no registry.ts (e um widget presentacional, nao uma tela) — Non-Goal da spec',
  )
})
