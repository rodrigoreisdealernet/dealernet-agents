// Verificacao dependency-free do dashboard Oficina / Fast BI (Issue #17).
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest, sem node_modules
// no worktree): usamos apenas os modulos nativos do Node (node:test, node:assert,
// node:fs) para assertar — lendo os arquivos-fonte como texto — que a tela
// ServiceDashboard.tsx satisfaz os criterios de aceite da spec
// docs/specs/17-feat-frontend-dashboard-oficina-fast.md.
//
// Roda com: node --test scripts/verify-service-dashboard.mjs
//
// Este e o padrao estabelecido do repo (ver verify-vehicle-wiring.mjs e
// verify-chartcard.mjs): testes estruturais sobre o texto-fonte, sem introduzir
// um framework de testes novo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SCREEN_PATH = 'src/portal/renderers/screens/ServiceDashboard.tsx'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// AC: Tela existe e e um componente default.
test('AC: ServiceDashboard.tsx existe e exporta default a funcao ServiceDashboard', () => {
  assert.ok(existsSync(resolve(ROOT, SCREEN_PATH)), `${SCREEN_PATH} deve existir`)
  const src = read(SCREEN_PATH)
  assert.match(
    src,
    /export\s+default\s+function\s+ServiceDashboard\s*\(/,
    'ServiceDashboard.tsx deve ter `export default function ServiceDashboard(...)`',
  )
})

// AC: KPIs/graficos derivam de getServiceOrders() — fonte de dados real, nao mock fixo.
test('AC: le os dados de getServiceOrders (data wiring, nao mock hardcoded)', () => {
  const src = read(SCREEN_PATH)
  // Deve importar getServiceOrders do agentsApi.
  assert.match(
    src,
    /import\s*\{[^}]*\bgetServiceOrders\b[^}]*\}\s*from\s*['"]@\/portal\/lib\/agentsApi['"]/,
    'ServiceDashboard.tsx deve importar getServiceOrders de @/portal/lib/agentsApi',
  )
  // E deve efetivamente chamar getServiceOrders() (carregamento dos dados), nao
  // apenas importar. Casa `getServiceOrders(` num call site (alem do import).
  assert.match(
    src,
    /getServiceOrders\s*\(\s*\)/,
    'ServiceDashboard.tsx deve chamar getServiceOrders() para carregar os dados',
  )
  // Guard anti-mock: a tela nao deve declarar um array de OS embutido no lugar
  // do fetch. (a fonte e a view via getServiceOrders).
  assert.ok(
    !/const\s+MOCK_\w*ORDERS?/i.test(src) && !/const\s+\w*orders?\s*=\s*\[\s*\{/i.test(src),
    'ServiceDashboard.tsx nao deve embutir uma lista mock de OS (deve derivar de getServiceOrders)',
  )
})

// AC: KPIs (5) com KpiCard — os cinco rotulos pt-BR aparecem.
test('AC: renderiza os 5 KPIs com seus rotulos pt-BR', () => {
  const src = read(SCREEN_PATH)
  const labels = [
    'OS abertas',
    'Em andamento',
    'Concluídas no mês',
    'Faturamento do mês',
    'Turnaround médio (h)',
  ]
  for (const label of labels) {
    assert.ok(
      src.includes(label),
      `o rotulo de KPI "${label}" deve aparecer na tela`,
    )
  }
  // Os KPIs devem ser renderizados via o primitivo KpiCard (reuso, nao card custom).
  assert.match(src, /<KpiCard\b/, 'os indicadores devem usar o primitivo KpiCard')
  // Binding label->valor: dentro do MESMO <KpiCard ... /> que tem
  // label="Faturamento do mês", o valor deve passar por formatBRL. Janela temperada
  // que nao cruza para o proximo <KpiCard isola este cartao (impede que um formatBRL
  // de outro cartao satisfaca a asercao).
  const fatCard = src.match(
    /<KpiCard\b(?:(?!<KpiCard)[\s\S])*?label="Faturamento do mês"(?:(?!<KpiCard)[\s\S])*?\/>/,
  )
  assert.ok(fatCard, 'deve existir um <KpiCard label="Faturamento do mês" .../>')
  assert.match(
    fatCard[0],
    /formatBRL\(/,
    'o KpiCard "Faturamento do mês" deve formatar seu valor com formatBRL',
  )
})

// AC (guard de campos): as derivacoes leem os campos-fonte corretos da view.
test('AC: ServiceDashboard.tsx referencia os campos-fonte turnaround_hours e closed_at', () => {
  const src = read(SCREEN_PATH)
  assert.match(
    src,
    /\bturnaround_hours\b/,
    'a derivacao de turnaround deve ler o campo turnaround_hours',
  )
  assert.match(
    src,
    /\bclosed_at\b/,
    'as derivacoes de mes/faturamento devem ler o campo closed_at',
  )
})

// AC: Grafico 1 — OS por status (ChartCard pie, xKey="status").
test('AC: grafico de OS por status e um ChartCard type="pie" com xKey="status"', () => {
  const src = read(SCREEN_PATH)
  // Bloco do ChartCard de status: padrao temperado que NAO cruza para o proximo
  // <ChartCard, garantindo que a janela cubra um unico cartao (evita falso-positivo
  // num swap status<->faturamento).
  const pieCard = src.match(/<ChartCard\b(?:(?!<ChartCard)[\s\S])*?xKey="status"(?:(?!<ChartCard)[\s\S])*?\/>/)
  assert.ok(pieCard, 'deve existir um <ChartCard ... xKey="status" .../>')
  assert.match(
    pieCard[0],
    /type="pie"/,
    'o ChartCard de quebra por status deve ser do tipo "pie"',
  )
  // A serie do grafico de status deve ser a contagem (key 'count').
  assert.match(
    pieCard[0],
    /key:\s*'count'/,
    "o grafico de status deve plotar a serie 'count' (volume por status)",
  )
})

// AC: Grafico 2 — Faturamento no tempo (ChartCard line, xKey="period", currency).
test('AC: grafico de faturamento e um ChartCard type="line" period/currency', () => {
  const src = read(SCREEN_PATH)
  // Padrao temperado: a janela do cartao de faturamento nao pode atravessar para o
  // proximo <ChartCard, isolando este cartao (um swap line<->pie nao passa).
  const lineCard = src.match(/<ChartCard\b(?:(?!<ChartCard)[\s\S])*?xKey="period"(?:(?!<ChartCard)[\s\S])*?\/>/)
  assert.ok(lineCard, 'deve existir um <ChartCard ... xKey="period" .../>')
  assert.match(
    lineCard[0],
    /type="line"/,
    'o ChartCard de faturamento no tempo deve ser do tipo "line"',
  )
  assert.match(
    lineCard[0],
    /valueFormat="currency"/,
    "o grafico de faturamento deve usar valueFormat='currency'",
  )
  assert.match(
    lineCard[0],
    /key:\s*'revenue'/,
    "o grafico de faturamento deve plotar a serie 'revenue'",
  )
})

// AC: Lista de OS abertas mais antigas — filtra status === 'aberta', ordena por opened_at.
test('AC: lista de OS abertas mais antigas (filtra aberta, ordena por opened_at)', () => {
  const src = read(SCREEN_PATH)
  // Titulo da secao.
  assert.ok(
    src.includes('OS abertas mais antigas'),
    'a secao deve ter o titulo "OS abertas mais antigas"',
  )
  // Filtra apenas as OS abertas (contrato significativo, refactor-safe: nao prende
  // o formato do arrow nem o nome do parametro).
  assert.match(
    src,
    /status\s*===\s*'aberta'/,
    "a lista deve filtrar status === 'aberta'",
  )
  // Ordena referenciando opened_at (mais antiga primeiro).
  assert.match(
    src,
    /\.sort\([\s\S]*?opened_at[\s\S]*?\)/,
    'a lista deve ordenar referenciando opened_at',
  )
})

// AC: Registro no registry — componentKey dia-service-dashboard -> lazy(ServiceDashboard).
test('AC: registry.ts mapeia dia-service-dashboard -> import lazy de ServiceDashboard', () => {
  const registry = read('src/portal/renderers/registry.ts')
  assert.match(
    registry,
    /['"]dia-service-dashboard['"]\s*:\s*lazy\([\s\S]*?ServiceDashboard/,
    "registry.ts deve mapear 'dia-service-dashboard' -> import lazy de ServiceDashboard",
  )
  // Distinto do CRUD ja existente: nao deve apontar 'dia-service-dashboard' para ServiceOrders.
  assert.ok(
    !/['"]dia-service-dashboard['"]\s*:\s*lazy\([\s\S]*?ServiceOrders['")]/.test(registry),
    "'dia-service-dashboard' nao deve apontar para a tela CRUD ServiceOrders",
  )
})

// AC: Item de menu "Oficina" dentro do grupo 'fast-bi' apontando para dia-service-dashboard.
test('AC: portalApi.ts tem item "Oficina" -> dia-service-dashboard dentro do grupo fast-bi', () => {
  const portalApi = read('src/portal/lib/portalApi.ts')
  // Existe um item de menu de texto "Oficina" com o componentKey do dashboard.
  assert.match(
    portalApi,
    /text:\s*'Oficina'/,
    "portalApi.ts deve ter um item de menu com text: 'Oficina'",
  )
  assert.match(
    portalApi,
    /componentKey:\s*'dia-service-dashboard'/,
    "o item deve apontar componentKey: 'dia-service-dashboard' (liga menu -> registry -> tela)",
  )
  // Proximidade/ordenacao: o item vive dentro do grupo 'fast-bi'. O grupo abre
  // com id: 'fast-bi' antes do item 'fast-bi-service', e o componentKey do
  // dashboard aparece logo depois desse id de item.
  const biGroupIdx = portalApi.indexOf("id: 'fast-bi'")
  const itemIdx = portalApi.indexOf("id: 'fast-bi-service'")
  const keyIdx = portalApi.indexOf("componentKey: 'dia-service-dashboard'")
  assert.ok(biGroupIdx !== -1, "deve existir o grupo id: 'fast-bi'")
  assert.ok(itemIdx !== -1, "deve existir o item id: 'fast-bi-service'")
  assert.ok(
    biGroupIdx < itemIdx && itemIdx < keyIdx,
    "o item 'Oficina' deve estar dentro do grupo 'fast-bi' (grupo precede o item, que precede seu componentKey)",
  )
})

// Non-regression / frontend-only: a tela e read-only e compoe (nao duplica) ChartCard/KpiCard.
test('Non-regression: tela e frontend-only e compoe ChartCard/KpiCard (sem escrita nem chart proprio)', () => {
  const src = read(SCREEN_PATH)
  // Dashboard de leitura: nao deve disparar nenhuma escrita via supabase.rpc.
  assert.ok(
    !/\.rpc\s*\(/.test(src),
    'ServiceDashboard.tsx e read-only: nao deve chamar supabase.rpc',
  )
  // Composicao, nao duplicacao: reusa ChartCard e KpiCard dos primitivos.
  assert.match(
    src,
    /import\s*\{[^}]*\bChartCard\b[^}]*\}\s*from\s*['"]\.\/ChartCard['"]/,
    'deve reusar o widget ChartCard (import de ./ChartCard), nao redefinir um grafico',
  )
  assert.match(
    src,
    /import\s*\{[^}]*\bKpiCard\b[^}]*\}\s*from\s*['"]\.\/ui['"]/,
    'deve reusar o primitivo KpiCard (import de ./ui)',
  )
  // Garante que nao importa recharts diretamente (a abstracao e o ChartCard).
  assert.ok(
    !/from\s+['"]recharts['"]/.test(src),
    'ServiceDashboard.tsx nao deve importar recharts direto (deve usar ChartCard)',
  )
})
